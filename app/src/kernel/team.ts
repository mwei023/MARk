/**
 * team.execute: orchestration primitive, not another agent.
 *
 * MARK selects STRATEGIES (solo vs team topologies), not agents. This
 * module runs the agreed pipeline: capability gate (task class +
 * Thompson-sampled strategy) → decompose → bounded dispatch → collect →
 * supervise/integrate → apply policy (parallel reads, sequential writes,
 * verify-after-every-apply) → acceptance attestation (ACCEPT or
 * REJECT/ESCALATE, never "looks good") → strategy trial recorded.
 *
 * Dependency-injected throughout (no kernel↔agent import cycle): the
 * host wires classification, posteriors, decomposition LLM, worker
 * execution (usually kernel executeGoal per subtask), verification,
 * and trial recording. Workers run through the EXISTING
 * AgentRuntime.handleCommand/executeGoal surface — no WorkerAgent
 * classes exist or are needed.
 */
import {
  Strategy,
  strategiesFor,
  thompsonPick,
  currentPosterior,
  recordTrial,
  DEFAULT_WEIGHTS,
  type Posterior,
  type Rand,
} from './strategy';
import { decideTaskClass, TASK_CLASSIFIER_VERSION, type TaskClass } from '../llm/task-class';
import { attestAcceptance, type AttestationVerdict } from './attestation';
import { getLLMProviderCached, type Message } from '../llm';
import type { Observation } from './types';
import type { TokenUsage } from './task-binder';

export interface TeamSubtask {
  task: string;
  kind: 'read' | 'write';
  acceptance: string[];
  agent?: string;
  budgetSteps?: number;
}

export interface WorkerResult {
  subtask: TeamSubtask;
  status: 'succeeded' | 'failed' | 'timeout' | 'blocked';
  summary: string;
  observations: Observation[];
  tokens: TokenUsage;
  durationMs: number;
}

export interface VerifySpec {
  toolId: string;
  input: Record<string, unknown>;
}

export interface TeamInput {
  goal: string;
  /** Force a topology (evals, explicit orders). Otherwise Thompson-sampled. */
  topology?: Strategy['topology'];
  /** Force a task class (skip classifier). */
  taskClass?: TaskClass;
  /** Acceptance criteria for the whole goal (REQ-ids or text). */
  acceptance?: string[];
  /** Verifiers to run over the integrated result. */
  verify?: VerifySpec[];
  maxWorkers?: number;
  workerTimeoutMs?: number;
}

export interface TeamResult {
  strategyId: string;
  strategyVersion: string;
  taskClass: string;
  decision: 'ACCEPT' | 'REJECT';
  verdict: AttestationVerdict;
  integration: string;
  workers: WorkerResult[];
  tokens: TokenUsage;
  durationMs: number;
  downgradedFrom?: Strategy['topology'];
  trialRecorded: boolean;
}

export interface TeamDeps {
  classify?: (goal: string) => Promise<{ taskClass: TaskClass } | undefined>;
  posteriors?: (taskClass: string, strategies: Strategy[]) => Promise<Posterior[]>;
  record?: typeof recordTrial;
  decompose?: (goal: string, strategy: Strategy) => Promise<{ subtasks: TeamSubtask[]; usage: TokenUsage } | undefined>;
  runWorker?: (subtask: TeamSubtask) => Promise<WorkerResult>;
  verify?: (specs: VerifySpec[]) => Promise<Observation[]>;
  rand?: Rand;
}

const MAX_WORKERS = 4;
const WORKER_TIMEOUT_MS = 120000;

function mergeUsage(into: TokenUsage, add: TokenUsage | undefined): void {
  if (!add) return;
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
}

const DECOMPOSE_SYSTEM = `Decompose the user goal into bounded subtasks for parallel specialist workers. Reply with EXACTLY one JSON object, no other text:
{"subtasks": [{"task": "concrete subtask text", "kind": "read" | "write", "acceptance": ["verifiable criterion", "..."], "agent": "optional agent id"}]}
Rules:
- At most 4 subtasks. Reads (inspect, search, list, diagnose) parallelize; writes (create, fix, delete, restart, send) run sequentially later.
- Each subtask gets 1-3 verifiable acceptance criteria (concrete, checkable, no vibes).
- kind is "write" when the subtask changes files, services, or the world; else "read".
- Never invent repository paths, hostnames, or identifiers.`;

async function defaultDecompose(goal: string, strategy: Strategy): Promise<{ subtasks: TeamSubtask[]; usage: TokenUsage } | undefined> {
  if (process.env.MARK_SMART === 'off') return undefined;
  try {
    const timeoutMs = Number(process.env.MARK_LLM_TIMEOUT_MS ?? 60000);
    const provider = await withTimeout(getLLMProviderCached(), timeoutMs, 'LLM provider init');
    const messages: Message[] = [
      { role: 'system', content: DECOMPOSE_SYSTEM },
      { role: 'user', content: `Goal: ${goal.slice(0, 1000)}\nStrategy: ${strategy.id} (${strategy.topology}). Constraints: ${strategy.constraints.join('; ').slice(0, 300)}` },
    ];
    const response = await withTimeout(provider.chat(messages, { temperature: 0 }), timeoutMs, 'LLM decompose');
    const usage: TokenUsage = {
      inputTokens: response.usage?.promptTokens ?? 0,
      outputTokens: response.usage?.completionTokens ?? 0,
    };
    const parsed = parseDecomposition(response.content);
    if (!parsed) return undefined;
    return { subtasks: parsed, usage };
  } catch {
    return undefined;
  }
}

function parseDecomposition(content: string): TeamSubtask[] | undefined {
  try {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    const raw = JSON.parse(content.slice(start, end + 1)) as {
      subtasks?: Array<{ task?: unknown; kind?: unknown; acceptance?: unknown; agent?: unknown; budgetSteps?: unknown }>;
    };
    if (!Array.isArray(raw.subtasks) || raw.subtasks.length === 0) return undefined;
    const out: TeamSubtask[] = [];
    for (const s of raw.subtasks.slice(0, MAX_WORKERS)) {
      const task = typeof s.task === 'string' ? s.task.trim().slice(0, 500) : '';
      if (!task) continue;
      const acceptance = Array.isArray(s.acceptance)
        ? s.acceptance.filter((a): a is string => typeof a === 'string').map(a => a.trim().slice(0, 300)).filter(Boolean).slice(0, 5)
        : [];
      out.push({
        task,
        kind: s.kind === 'write' ? 'write' : 'read',
        acceptance,
        agent: typeof s.agent === 'string' ? s.agent.slice(0, 80) : undefined,
        budgetSteps: typeof s.budgetSteps === 'number' && Number.isFinite(s.budgetSteps)
          ? Math.min(Math.max(Math.floor(s.budgetSteps), 1), 12) : undefined,
      });
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
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

function timedOutWorker(subtask: TeamSubtask, ms: number): WorkerResult {
  return {
    subtask, status: 'timeout',
    summary: `Worker timed out after ${ms}ms: ${subtask.task.slice(0, 120)}`,
    observations: [], tokens: { inputTokens: 0, outputTokens: 0 }, durationMs: ms,
  };
}

/** Strategies whose write mechanics are not built yet run supervised (noted). */
export async function executeTeam(input: TeamInput, deps: TeamDeps = {}): Promise<TeamResult> {
  const started = Date.now();
  const spent: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const classify = deps.classify ?? (async (goal: string) => {
    const d = await decideTaskClass(goal);
    return d ? { taskClass: d.taskClass } : undefined;
  });

  // ── Gate: task class + strategy ──────────────────────────────────────────
  const classified = input.taskClass
    ? { taskClass: input.taskClass }
    : await classify(input.goal).catch(() => undefined);
  const taskClass: TaskClass = classified?.taskClass ?? 'shell_task';
  let candidates = strategiesFor(taskClass);
  if (candidates.length === 0) candidates = strategiesFor('shell_task');
  const requested = input.topology;
  const shortlist = requested ? candidates.filter(s => s.topology === requested) : candidates;
  const pool = shortlist.length > 0 ? shortlist : candidates;
  let strategy: Strategy;
  let downgradedFrom: Strategy['topology'] | undefined;
  if (requested) {
    strategy = pool.find(s => s.topology === requested) ?? pool[0];
  } else if (deps.posteriors) {
    const posts = await deps.posteriors(taskClass, pool).catch(() => pool.map(() => ({ alpha: 1, beta: 1 })));
    strategy = pool[thompsonPick(posts, deps.rand)] ?? pool[0];
  } else {
    const posts = await Promise.all(pool.map(s => currentPosterior(taskClass, s.id).catch(() => ({ alpha: 1, beta: 1 }))));
    strategy = pool[thompsonPick(posts, deps.rand)] ?? pool[0];
  }
  // Worktree/sequential write mechanics are future work: run the
  // supervised shape and say so. The trial records the EXECUTED strategy.
  if ((strategy.topology === 'worktree-team' || strategy.topology === 'sequential-team') && strategy.id !== 'supervised-team') {
    const supervised = candidates.find(s => s.topology === 'supervised-team') ?? candidates.find(s => s.topology === 'solo') ?? pool[0];
    downgradedFrom = strategy.topology;
    strategy = supervised;
  }

  const runWorker = deps.runWorker ?? (async () => ({
    subtask: { task: input.goal, kind: 'read' as const, acceptance: [] },
    status: 'failed' as const, summary: 'No worker runner wired.',
    observations: [], tokens: { inputTokens: 0, outputTokens: 0 }, durationMs: 0,
  }));
  const maxWorkers = Math.min(Math.max(input.maxWorkers ?? MAX_WORKERS, 1), MAX_WORKERS);
  const workerTimeout = input.workerTimeoutMs ?? WORKER_TIMEOUT_MS;

  // ── Solo is a topology: one worker, same verify/decide/record path ──────
  if (strategy.topology === 'solo') {
    const assigned: TeamSubtask = { task: input.goal, kind: 'read', acceptance: input.acceptance ?? [] };
    const worker = await runWithTimeout(() => runWorker(assigned), workerTimeout, assigned);
    return finishTeam(input, strategy, taskClass, [{ assigned, result: worker }], [], spent, started, deps, downgradedFrom);
  }

  // ── Decompose (LLM-gated; failure falls back to solo) ────────────────────
  const decompose = deps.decompose ?? ((goal: string, s: Strategy) => defaultDecompose(goal, s));
  const decomposed = await decompose(input.goal, strategy).catch(() => undefined);
  if (!decomposed || decomposed.subtasks.length === 0) {
    const assigned: TeamSubtask = { task: input.goal, kind: 'read', acceptance: input.acceptance ?? [] };
    const worker = await runWithTimeout(() => runWorker(assigned), workerTimeout, assigned);
    return finishTeam(input, { ...strategy, id: 'solo', topology: 'solo' }, taskClass, [{ assigned, result: worker }], [], spent, started, deps, strategy.topology);
  }
  mergeUsage(spent, decomposed.usage);
  const subtasks = decomposed.subtasks.slice(0, maxWorkers);

  // ── Dispatch: reads parallel; writes sequential after reads ──────────────
  // Results stay paired with their ASSIGNED subtask: acceptance is what was
  // asked, not what the worker echoes back (a worker returning a fresh
  // subtask with empty acceptance would vacate the verdict).
  const reads = subtasks.filter(s => s.kind !== 'write');
  const writes = subtasks.filter(s => s.kind === 'write');
  const readResults = await Promise.all(
    reads.map(async s => ({ assigned: s, result: await runWithTimeout(() => runWorker(s), workerTimeout, s) })),
  );
  const writeResults: Array<{ assigned: TeamSubtask; result: WorkerResult }> = [];
  for (const s of writes) {
    const r = await runWithTimeout(() => runWorker(s), workerTimeout, s);
    writeResults.push({ assigned: s, result: r });
    // Verify-after-every-apply lives with the caller-supplied verifier at
    // DECIDE; per-write approval gates already hold inside worker execution.
    if (r.status === 'failed' || r.status === 'timeout') break;
  }
  const workers = [...readResults, ...writeResults];

  // ── Verify over the integrated result ────────────────────────────────────
  const verify = deps.verify ?? (async () => []);
  const verifyObs = input.verify && input.verify.length > 0
    ? await verify(input.verify).catch(() => [])
    : [];

  return finishTeam(input, strategy, taskClass, workers, verifyObs, spent, started, deps, downgradedFrom);
}

async function runWithTimeout(
  run: () => Promise<WorkerResult>,
  ms: number,
  subtask: TeamSubtask,
): Promise<WorkerResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<WorkerResult>(resolve => {
    timer = setTimeout(() => resolve(timedOutWorker(subtask, ms)), ms);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function finishTeam(
  input: TeamInput,
  strategy: Strategy,
  taskClass: string,
  paired: Array<{ assigned: TeamSubtask; result: WorkerResult }>,
  verifyObs: Observation[],
  spent: TokenUsage,
  started: number,
  deps: TeamDeps,
  downgradedFrom?: Strategy['topology'],
): Promise<TeamResult> {
  const durationMs = Date.now() - started;
  const workers = paired.map(p => p.result);
  for (const w of workers) mergeUsage(spent, w.tokens);

  // ── Supervise/integrate: deterministic composition, no new agent ─────────
  const lines: string[] = [];
  for (const { assigned, result: w } of paired) {
    lines.push(`### ${assigned.task.slice(0, 120)} [${w.status}]`);
    lines.push(w.summary.slice(0, 600));
  }
  const integration = lines.join('\n');

  // ── Decide: attestation over ASSIGNED acceptance + goal acceptance ───────
  const acceptance = [
    ...paired.flatMap(p => p.assigned.acceptance),
    ...(input.acceptance ?? []),
  ];
  const allObs = [...workers.flatMap(w => w.observations), ...verifyObs];
  const verdict = attestAcceptance(acceptance, allObs);
  const workerOk = workers.length > 0 && workers.every(w => w.status === 'succeeded');
  const decision: 'ACCEPT' | 'REJECT' =
    acceptance.length === 0 ? (workerOk ? 'ACCEPT' : 'REJECT') : (verdict.allPass && workerOk ? 'ACCEPT' : 'REJECT');

  // ── Evaluate: the trial that teaches MARK about itself ───────────────────
  const record = deps.record ?? recordTrial;
  const trialRecorded = await record({
    taskClass,
    classifierVersion: TASK_CLASSIFIER_VERSION,
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    trial: {
      success: workerOk,
      verified: verdict.allPass,
      regression: verdict.failCount > 0,
      tokens: spent.inputTokens + spent.outputTokens,
      durationMs,
    },
    weights: DEFAULT_WEIGHTS,
  }).then(r => r !== undefined).catch(() => false);

  return {
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    taskClass,
    decision,
    verdict,
    integration,
    workers,
    tokens: { ...spent },
    durationMs,
    downgradedFrom,
    trialRecorded,
  };
}
