/**
 * LLM-assisted planning with the existing contract validator as guardrail.
 *
 * The model proposes steps over the DISCOVERED catalog; every proposal is
 * validated by the kernel's own plan validator. Unknown tools, missing
 * inputs, and broken references are dropped — if nothing valid remains,
 * this returns undefined and the caller falls back to metadata planning.
 * The LLM suggests; contracts decide. Never throws.
 */
import { getLLMProviderCached, LLMProvider, Message } from '../llm';
import { ToolDescriptor } from './types';
import { ExecutionPlan, PlanValidationResult } from './planner';
import { createKernelId } from './execution-context';

export interface LLMPlanResult {
  plan: ExecutionPlan;
  validation: PlanValidationResult;
  droppedSteps: number;
}

export interface LLMPlannerDeps {
  provider?: LLMProvider;
  validate?: (plan: ExecutionPlan) => PlanValidationResult;
  timeoutMs?: number;
  maxCatalogTools?: number;
  /** Proposal rounds with validator feedback (default 3). */
  maxAttempts?: number;
}

interface ProposedStep {
  toolId?: string;
  input?: Record<string, unknown>;
  dependsOn?: unknown[];
}

function catalogLine(tool: ToolDescriptor): string {
  const required = tool.inputSchema?.required ?? [];
  const inputs = Object.keys(tool.inputSchema?.properties ?? {}).join(',');
  return `- ${tool.id} (${tool.domain}, ${tool.risk}): ${tool.description.slice(0, 150)} [inputs: ${inputs || 'none'}; required: ${required.join(',') || 'none'}]`;
}

function buildCatalog(tools: ToolDescriptor[], max: number): string {
  // Per-instance families (every desktop app, every container) would drown
  // the prompt; the generic tools teach the pattern and instances resolve
  // by id when goals name them.
  const generic = tools.filter(
    tool => tool.available && !/^(desktop\.(open|close)\.|container\.restart\.)/.test(tool.id),
  );
  return generic.slice(0, max).map(catalogLine).join('\n');
}

const PLANNER_SYSTEM = `You compose execution plans for MARK from its tool catalog. Reply with EXACTLY one JSON object, no other text:
{"steps": [{"toolId": "exact id from catalog", "input": {"field": "value"}, "dependsOn": []}], "successCriteria": ["observable outcome"]}

Rules:
- Use ONLY tool ids from the catalog, spelled exactly. Invent nothing.
- Give every required input a concrete value. Prefer values stated in the goal; use "name: value" pairs from the goal text.
- Write values plainly with NO surrounding quotes. Never emit "\"value\"" — emit value.
- dependsOn lists EARLIER step indexes (0-based) whose outputs a step needs. Use [] for independent steps.
- Keep plans short (1-4 steps). If the goal needs nothing or no tool fits, return {"steps": [], "successCriteria": []}. Prefer the single most direct tool: an explicit open/read/write goal needs that tool only, never a search step first.`;

export async function proposePlanWithLLM(
  goal: string,
  tools: ToolDescriptor[],
  validate: (plan: ExecutionPlan) => PlanValidationResult,
  deps: LLMPlannerDeps = {},
): Promise<LLMPlanResult | undefined> {
  try {
    if (!goal?.trim() || tools.length === 0) return undefined;
    const timeoutMs = deps.timeoutMs ?? Number(process.env.MARK_LLM_TIMEOUT_MS ?? 60000);
    const provider = deps.provider ?? await withTimeout(getLLMProviderCached(), timeoutMs, 'LLM provider init');
    const catalog = buildCatalog(tools, deps.maxCatalogTools ?? 60);
    if (!catalog) return undefined;
    const known = new Map<string, ToolDescriptor>(
      tools.filter(tool => tool.available).map(tool => [tool.id, tool] as [string, ToolDescriptor]),
    );

    const messages: Message[] = [
      { role: 'system', content: PLANNER_SYSTEM },
      { role: 'user', content: `Goal: ${goal.slice(0, 500)}\n\nCatalog:\n${catalog}` },
    ];
    const maxAttempts = Math.max(deps.maxAttempts ?? 3, 1);
    let droppedSteps = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await withTimeout(provider.chat(messages, { temperature: 0 }), timeoutMs, 'LLM plan');
      const built = buildPlan(goal, response.content, known);
      droppedSteps += built.droppedSteps;
      if (built.plan) {
        const validation = validate(built.plan);
        if (validation.valid && built.plan.steps.length > 0) {
          return { plan: built.plan, validation, droppedSteps };
        }
        messages.push(
          { role: 'assistant', content: response.content.slice(0, 2000) },
          {
            role: 'user',
            content: `That proposal failed validation:\n${validation.errors.map(e => `- ${e.message}`).join('\n').slice(0, 1500)}\nPropose a corrected plan using only catalog tool ids with all required inputs.`,
          },
        );
      } else {
        messages.push(
          { role: 'assistant', content: response.content.slice(0, 2000) },
          { role: 'user', content: 'That was not parseable as {"steps": [...]}. Reply with exactly that JSON object.' },
        );
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Models quote values they copy ("url: \"http://x\""). The validator checks
 * presence, not shape — so a quoted URL passes validation and dies at
 * runtime (`new URL('"http://x"')` throws Invalid URL). Strip one layer of
 * matching surrounding quotes here so planned inputs execute as proposed.
 * Observed live: browser.open starved by its own plan's quoted url.
 */
export function sanitizeInputValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  let out = value.trim();
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
      out = out.slice(1, -1).trim();
    }
  }
  return out;
}

function sanitizeStepInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    clean[key] = sanitizeInputValue(value);
  }
  return clean;
}

function buildPlan(
  goal: string,
  content: string,
  known: Map<string, ToolDescriptor>,
): { plan?: ExecutionPlan; droppedSteps: number } {
  const proposed = parseProposal(content);
  if (!proposed) return { droppedSteps: 0 };
  const steps: ExecutionPlan['steps'] = [];
  let droppedSteps = 0;
  const indexToId = new Map<number, string>();
  proposed.steps.forEach((step, index) => {
    const tool = typeof step.toolId === 'string' ? known.get(step.toolId) : undefined;
    if (!tool) {
      droppedSteps += 1;
      return;
    }
    const id = createKernelId('step');
    indexToId.set(index, id);
    steps.push({
      id,
      toolId: tool.id,
      input: sanitizeStepInput(step.input),
      dependsOn: [],
      expectedOutcome: undefined,
    });
  });
  // Remap numeric dependsOn to step ids, dropping dangling edges.
  proposed.steps.forEach((step, index) => {
    const id = indexToId.get(index);
    if (!id) return;
    const target = steps.find(s => s.id === id)!;
    const deps = Array.isArray(step.dependsOn) ? step.dependsOn : [];
    target.dependsOn = deps
      .filter((dep): dep is number => typeof dep === 'number' && indexToId.has(dep) && dep < index)
      .map(dep => indexToId.get(dep) as string);
  });

  if (steps.length === 0) return { droppedSteps };
  const plan: ExecutionPlan = {
    id: createKernelId('plan'),
    goal,
    steps,
    successCriteria: Array.isArray(proposed.successCriteria)
      ? proposed.successCriteria.filter((c): c is string => typeof c === 'string').slice(0, 5)
      : [`${goal} accomplished`],
    explanation: `LLM-composed over the discovered catalog (${droppedSteps} proposed step(s) dropped by validation).`,
  };
  return { plan, droppedSteps };
}

function parseProposal(content: string): { steps: ProposedStep[]; successCriteria?: unknown } | null {
  try {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const raw = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
    if (!Array.isArray(raw.steps)) return null;
    return { steps: raw.steps as ProposedStep[], successCriteria: raw.successCriteria };
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
