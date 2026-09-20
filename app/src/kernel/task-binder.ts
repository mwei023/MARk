import { ToolDescriptor } from './types';
import { getLLMProviderCached, LLMProvider, Message } from '../llm';

export interface TaskBinding {
  input: Record<string, unknown>;
  missingRequired: string[];
  matchedFields: string[];
  complete: boolean;
  reason: string;
  /**
   * True when the match is a whole-goal guess into a query-shaped field
   * (free-text fallback), not explicit evidence. Callers prefer evidenced
   * bindings first and spend guessed ones only when nothing better binds —
   * otherwise a guess on a lower-ranked tool jumps the queue ahead of the
   * resolver's top pick (observed live: play_track's guessed query beating
   * now_playing for "confirm if any music is playing").
   */
  freeText?: boolean;
}

export interface TaskBinderDependencies {}

export class TaskBinder {
  constructor(
    private readonly dependencies: TaskBinderDependencies = {},
  ) {}

  bind(
    goal: string,
    tool: ToolDescriptor,
  ): TaskBinding {
    const schema = tool.inputSchema as {
      type?: string;
      properties?: Record<string, {
        type?: string;
        description?: string;
      }>;
      required?: string[];
    };

    const properties = schema.properties ?? {};
    const required = schema.required ?? [];

    if (Object.keys(properties).length === 0) {
      return {
        input: {},
        missingRequired: [],
        matchedFields: [],
        complete: true,
        reason: `Tool "${tool.id}" does not declare any input fields.`,
      };
    }

    const normalizedGoal = goal.toLowerCase();

    const input: Record<string, unknown> = {};
    const matchedFields: string[] = [];

    for (const [field, definition] of Object.entries(properties)) {
      const fieldName = field.toLowerCase();
      const description = definition.description?.toLowerCase() ?? '';
      const siblings = Object.keys(properties).filter(name => name !== field);

      if (
        normalizedGoal.includes(fieldName) ||
        (description &&
          this.matchesDescription(normalizedGoal, description))
      ) {
        const value = this.extractFieldValue(
          goal,
          field,
          definition,
          siblings,
        );

        if (value !== undefined) {
          input[field] = value;
          matchedFields.push(field);
        }
      }
    }

    // Free-text fallback: when nothing matched but the tool has exactly one
    // string field shaped like a query box (search/play/ask tools), the
    // whole goal is the value. "play donda album" binds query wholesale;
    // the tool itself normalizes ("play", "album" are its domain words).
    // Never fires when any field already matched — no silent overrides.
    if (matchedFields.length === 0) {
      const singles = Object.entries(properties).filter(
        ([name, def]) => def.type === 'string' && /^(query|q|text|question|keywords|prompt)$/i.test(name),
      );
      if (singles.length === 1) {
        const [name] = singles[0];
        const value = goal.trim().slice(0, 300);
        if (value) {
          input[name] = value;
          matchedFields.push(name);
          return {
            input,
            missingRequired: required.filter(field => input[field] === undefined),
            matchedFields,
            complete: required.every(field => input[field] !== undefined),
            reason: `Free-text fallback: whole goal bound to "${name}" (guess, not evidence).`,
            freeText: true,
          };
        }
      }
    }

    const stillMissing = required.filter(field => input[field] === undefined);

    return {
      input,
      missingRequired: stillMissing,
      matchedFields,
      complete: stillMissing.length === 0,
      reason: this.buildReason(
        tool,
        stillMissing,
        matchedFields,
      ),
    };
  }

  private matchesDescription(
    goal: string,
    description: string,
  ): boolean {
    const terms = description
      .split(/[^a-z0-9]+/)
      .filter(term => term.length >= 4);

    return terms.some(term => goal.includes(term));
  }

  private extractFieldValue(
    goal: string,
    field: string,
    definition: {
      type?: string;
      description?: string;
    },
    siblingFields: string[] = [],
  ): unknown {
    // Value stops at the next `otherField:` boundary so
    // "path: app/src include: *.ts" binds path="app/src", not the remainder.
    const boundary = siblingFields.length > 0
      ? `(?=\\s+(?:${siblingFields.map(sibling => this.escapeRegExp(sibling)).join('|')})\\s*[:=]|$)`
      : '$';
    const fieldPattern = new RegExp(
      `${this.escapeRegExp(field)}\\s*[:=]\\s*["']?(.+?)["']?${boundary}`,
      'i',
    );

    const explicitMatch = goal.match(fieldPattern);

    if (explicitMatch?.[1]) {
      return this.coerceValue(
        explicitMatch[1].trim(),
        definition.type,
      );
    }

    return undefined;
  }

  private coerceValue(
    value: string,
    type?: string,
  ): unknown {
    switch (type) {
      case 'number': {
        const parsed = Number(value);
        return Number.isNaN(parsed) ? value : parsed;
      }

      case 'boolean':
        if (value.toLowerCase() === 'true') {
          return true;
        }

        if (value.toLowerCase() === 'false') {
          return false;
        }

        return value;

      default:
        return value;
    }
  }

  private buildReason(
    tool: ToolDescriptor,
    missingRequired: string[],
    matchedFields: string[],
  ): string {
    if (missingRequired.length > 0) {
      return `Capability "${tool.id}" requires input that could not yet be bound: ${missingRequired.join(', ')}.`;
    }

    if (matchedFields.length > 0) {
      return `Bound goal values to the declared input schema of "${tool.id}".`;
    }

    return `Capability "${tool.id}" declares inputs, but no explicit values were found in the goal.`;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

export interface SmartBindDeps {
  provider?: LLMProvider;
  timeoutMs?: number;
}

const SMART_BIND_SYSTEM = `Extract input values for ONE tool call from a user goal. Reply with EXACTLY one JSON object mapping field names to values, no other text. Only include fields listed below. Use strings for text, numbers for counts, booleans for flags. If the goal states no value for a field, omit it. Never invent paths, names, or identifiers — omit rather than guess.`;

/**
 * Free-text binding: metadata binding first (explicit `field: value`
 * always wins); when required fields remain missing, one LLM extraction
 * round fills them. Every extracted value is type-checked against the
 * schema — unknown fields dropped, mistyped values dropped, complex
 * objects dropped. Jail and policy enforcement still happen at execution,
 * so a wrong-but-typed value can waste a call but never escape the jail.
 * Returns the metadata result untouched when smart mode is off, the goal
 * is empty, or anything fails. Never throws.
 */
export async function bindTaskSmart(
  binder: TaskBinder,
  goal: string,
  tool: ToolDescriptor,
  deps: SmartBindDeps = {},
): Promise<TaskBinding> {
  const base = binder.bind(goal, tool);
  if (base.complete || process.env.MARK_SMART === 'off' || !goal?.trim()) return base;
  try {
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    const properties = schema.properties ?? {};
    // Ask about required fields plus any optional fields the goal may state:
    // optionals only fill unset slots, never override explicit values.
    const wanted = Object.keys(properties).filter(field => base.input[field] === undefined);
    const missing = (schema.required ?? []).filter(field => base.input[field] === undefined);
    if (missing.length === 0 || wanted.length === 0) return base;

    const timeoutMs = deps.timeoutMs ?? Number(process.env.MARK_LLM_TIMEOUT_MS ?? 30000);
    const provider = deps.provider ?? await withTimeout(getLLMProviderCached(), timeoutMs, 'LLM provider init');
    const catalog = wanted
      .map(field => `- ${field} (${properties[field]?.type ?? 'string'}${(schema.required ?? []).includes(field) ? ', required' : ', optional'}): ${properties[field]?.description ?? ''}`.slice(0, 200))
      .join('\n');
    const messages: Message[] = [
      { role: 'system', content: SMART_BIND_SYSTEM },
      { role: 'user', content: `Goal: ${goal.slice(0, 500)}\n\nMissing fields:\n${catalog}` },
    ];
    const response = await withTimeout(provider.chat(messages, { temperature: 0 }), timeoutMs, 'LLM bind');
    const extracted = parseExtraction(response.content);
    if (!extracted) return base;

    const input = { ...base.input };
    const matchedFields = [...base.matchedFields];
    for (const field of wanted) {      if (input[field] !== undefined) continue;
      const raw = (extracted as Record<string, unknown>)[field];
      if (raw === undefined) continue;
      const coerced = coerceScalar(raw, properties[field]?.type ?? 'string');
      if (coerced === undefined) continue;
      input[field] = coerced;
      matchedFields.push(field);
    }
    const stillMissing = (schema.required ?? []).filter(field => input[field] === undefined);
    return {
      input,
      missingRequired: stillMissing,
      matchedFields,
      complete: stillMissing.length === 0,
      reason:
        stillMissing.length === 0
          ? `Bound goal values to "${tool.id}" with LLM assistance (${matchedFields.join(', ')}).`
          : base.reason,
      ...(base.freeText ? { freeText: true as const } : {}),
    };
  } catch {
    return base;
  }
}

/** Scalars only: numbers/booleans coerce, strings pass, anything else drops. */
function coerceScalar(value: unknown, type: string): string | number | boolean | undefined {
  if (type === 'number') {
    const parsed = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const lowered = String(value).trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().slice(0, 500);
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === 'number' && type === 'string') return String(value);
  return undefined;
}

function parseExtraction(content: string): Record<string, unknown> | null {
  try {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const raw = JSON.parse(content.slice(start, end + 1)) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
