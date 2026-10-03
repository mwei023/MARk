/**
 * Interaction core: one conversation stream every transport renders.
 *
 * Five event kinds — message, approval, trace, receipt, thinking — appended
 * by producers (runtime, agents, planner) and rendered by transports (TUI,
 * REPL, CLI, API, voice). Transports stop owning interaction logic; they
 * read the stream.
 *
 * Thinking is optional and collapsed by default: compact one-liners always
 * available, full detail on toggle. A redaction pass runs BEFORE any
 * thinking text enters the stream — no toggle bypasses it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type InteractionEventKind = 'message' | 'approval' | 'trace' | 'receipt' | 'thinking';

export interface ThinkingPayload {
  source: 'classifier' | 'planner' | 'llm' | 'probe' | 'trust' | 'other';
  /** One line: decision + key evidence. Always rendered when thinking is on. */
  compact: string;
  /** Full detail: signals, dropped steps, reasoning excerpts. On expand only. */
  detail?: string;
}

export interface ApprovalPayload {
  confirmationId: string;
  toolId: string;
  reason: string;
  /** One-click options from the stream: once, always, or scoped to root. */
  options: Array<'once' | 'always' | 'root'>;
}

export interface InteractionEvent {
  id: string;
  sessionId: string;
  at: string;
  kind: InteractionEventKind;
  /** Who produced it: user id, agent name, or subsystem. */
  from: string;
  text: string;
  thinking?: ThinkingPayload;
  approval?: ApprovalPayload;
}

let seq = 0;

/**
 * Redact secret-shaped content. Runs on every thinking payload and on any
 * text containing key-like patterns. Conservative on purpose: over-redact,
 * never leak. Returns the redacted string plus whether anything was cut.
 */
export function redactSecrets(text: string): { text: string; redacted: boolean } {
  const patterns: RegExp[] = [
    /sk-or-v1-[A-Za-z0-9_-]+/g, // OpenRouter
    /gsk_[A-Za-z0-9]+/g, // Groq
    /gh[op]_[A-Za-z0-9_]+/g, // GitHub tokens
    /xox[bpas]-[A-Za-z0-9-]+/g, // Slack
    /AIza[A-Za-z0-9_-]{20,}/g, // Google
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /['"]?(api[_-]?key|api[_-]?token|secret|password|passwd)['"]?\s*[:=]\s*['"]?[^'"\s,}]+['"]?/gi,
  ];
  let out = text;
  let redacted = false;
  for (const re of patterns) {
    re.lastIndex = 0;
    if (re.test(out)) {
      redacted = true;
      re.lastIndex = 0;
      out = out.replace(re, '[REDACTED]');
    }
  }
  return { text: out, redacted };
}

export interface InteractionStreamOptions {
  /** Maximum retained events (oldest dropped). Default 500. */
  maxEvents?: number;
  /** Thinking visible without toggle. Default false. */
  thinkingOn?: boolean;
}

interface SessionState {
  events: InteractionEvent[];
  thinkingOn: boolean;
  context: Record<string, unknown>;
}

const DEFAULT_SESSION_ID = 'default';
const interactionSession = new AsyncLocalStorage<string>();

export function currentInteractionSession(): string {
  return interactionSession.getStore() ?? DEFAULT_SESSION_ID;
}

export function runInInteractionSession<T>(sessionId: string, fn: () => T): T {
  const normalized = sessionId.trim() || DEFAULT_SESSION_ID;
  return interactionSession.run(normalized, fn);
}

export class InteractionStream {
  private sessions = new Map<string, SessionState>();

  constructor(private readonly opts: InteractionStreamOptions = {}) {}

  private state(sessionId?: string): SessionState {
    const id = sessionId?.trim() || currentInteractionSession();
    let state = this.sessions.get(id);
    if (!state) {
      state = {
        events: [],
        thinkingOn: this.opts.thinkingOn ?? false,
        context: {},
      };
      this.sessions.set(id, state);
    }
    return state;
  }

  setThinking(on: boolean, sessionId?: string): void {
    this.state(sessionId).thinkingOn = on;
  }

  isThinkingOn(sessionId?: string): boolean {
    return this.state(sessionId).thinkingOn;
  }

  /** Remember a session fact (e.g. last repo). Never throws, never persists secrets. */
  setContext(key: string, value: unknown, sessionId?: string): void {
    if (/key|token|secret|password/i.test(key)) return;
    this.state(sessionId).context[key] = value;
  }

  getContext<T = unknown>(key: string, sessionId?: string): T | undefined {
    return this.state(sessionId).context[key] as T | undefined;
  }

  append(kind: InteractionEventKind, from: string, text: string, extra?: { thinking?: ThinkingPayload; approval?: ApprovalPayload }, sessionId?: string): InteractionEvent {
    const id = sessionId?.trim() || currentInteractionSession();
    const state = this.state(id);
    let thinking = extra?.thinking;
    if (thinking) {
      const compact = redactSecrets(thinking.compact);
      const detail = thinking.detail ? redactSecrets(thinking.detail) : undefined;
      thinking = { source: thinking.source, compact: compact.text, detail: detail?.text };
    }
    const safe = redactSecrets(text);
    const event: InteractionEvent = {
      id: `ix-${Date.now()}-${(seq += 1)}`,
      sessionId: id,
      at: new Date().toISOString(),
      kind,
      from,
      text: safe.text,
      ...(thinking ? { thinking } : {}),
      ...(extra?.approval ? { approval: extra.approval } : {}),
    };
    state.events.push(event);
    const max = this.opts.maxEvents ?? 500;
    if (state.events.length > max) state.events = state.events.slice(-max);
    return event;
  }

  /** All events, oldest first. Transports filter by kind as needed. */
  list(sessionId?: string): InteractionEvent[] {
    return [...this.state(sessionId).events];
  }

  pendingApprovals(sessionId?: string): InteractionEvent[] {
    return this.state(sessionId).events.filter(e => e.kind === 'approval');
  }

  /**
   * Plain-text render for REPL/CLI/logs. Thinking appears only when toggled
   * on (compact), with detail on explicit expand. Approvals render their
   * one-click options inline.
   */
  renderText(opts: { expandThinking?: boolean } = {}, sessionId?: string): string[] {
    const lines: string[] = [];
    const state = this.state(sessionId);
    for (const e of state.events) {
      if (e.kind === 'thinking' && !state.thinkingOn) continue;
      if (e.kind === 'message' || e.kind === 'receipt') {
        lines.push(`[${e.from}] ${e.text}`);
      } else if (e.kind === 'trace') {
        lines.push(`  ⎿ ${e.text}`);
      } else if (e.kind === 'approval' && e.approval) {
        lines.push(`[approval needed] ${e.approval.toolId}: ${e.approval.reason}`);
        lines.push(`  reply: approve ${e.approval.confirmationId} [once] | always | root`);
      } else if (e.kind === 'thinking' && e.thinking) {
        lines.push(`  ~ ${e.from}/${e.thinking.source}: ${e.thinking.compact}`);
        if (opts.expandThinking && e.thinking.detail) lines.push(`    ${e.thinking.detail.slice(0, 500)}`);
      }
    }
    return lines;
  }

  clear(sessionId?: string): void {
    this.state(sessionId).events = [];
  }
}

/** Process-wide stream: interfaces share one conversation by default. */
export const interactionStream = new InteractionStream();
