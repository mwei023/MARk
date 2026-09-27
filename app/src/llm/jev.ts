/**
 * Jev routing brain: TypeSafe AI's System One decision model as MARK's
 * classifier for uncertain routes.
 *
 * Keywords decide the clear cases; Jev decides the fuzzy middle (choice over
 * MARK's real routes, calibrated confidence); the frontier LLM remains the
 * final fallback. Order is cost- and latency-aware: regex (free) → Jev
 * (70–500ms, ~$0.00003) → LLM (seconds, ~$0.01+).
 *
 * Graceful by contract: no key, no network, 402/429/5xx, or a malformed
 * answer all resolve to undefined and the caller keeps its keyword decision.
 * This function NEVER throws and NEVER logs the key.
 */
export type JevRoute =
  | 'deterministic'
  | 'agent:git-agent'
  | 'agent:devops-agent'
  | 'agent:cicd-agent'
  | 'agent:code-agent'
  | 'agent:web-agent'
  | 'agent:research-agent'
  | 'kernel'
  | 'reasoning'
  | 'escalate';

export interface JevDecision {
  route: JevRoute;
  confidence: number;
  probabilities: Record<string, number>;
}

const ROUTE_CRITERIA: Record<string, string> = {
  deterministic: 'answerable on this machine right now: time, date, files, disk, memory, CPU, MARK own status',
  'agent:git-agent': 'git operations, branches, commits, repo status, build failure investigation',
  'agent:devops-agent': 'deployments, rollbacks, restarts, docker containers, service health',
  'agent:cicd-agent': 'pipelines, builds, tests, lint runs',
  'agent:code-agent': 'repairing code errors in source files',
  'agent:web-agent': 'looking something up on the public web',
  'agent:research-agent': 'deep research across many sources with citations',
  kernel: 'acting on files, repos, or services via named tools with explicit values',
  reasoning: 'explaining, drafting, composing, or open conversation',
  escalate: 'unknown, dangerous, or needs a human decision',
};

const DEFAULT_ENDPOINT = 'https://jevtypesafeai.com/api/v1/decide';
const TIMEOUT_MS = 8000;
/** Below this confidence the keyword decision stands and the LLM may still weigh in. */
export const JEV_MIN_CONFIDENCE = 0.55;

export interface JevDeps {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

function endpoint(): string {
  return process.env.JEV_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
}

function apiKey(): string | undefined {
  return process.env.JEV_API_KEY?.trim() || undefined;
}

export function jevAvailable(): boolean {
  return apiKey() !== undefined;
}

export async function decideRoute(command: string, deps: JevDeps = {}): Promise<JevDecision | undefined> {
  const key = apiKey();
  if (!key || !command?.trim()) return undefined;
  const timeoutMs = deps.timeoutMs ?? Number(process.env.JEV_TIMEOUT_MS ?? TIMEOUT_MS);
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const response = await withTimeout(
      fetchFn(endpoint(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: command.slice(0, 1000),
          questions: {
            route: {
              type: 'choice',
              instructions: 'Which MARK handler should own this user command?',
              criteria: ROUTE_CRITERIA,
            },
          },
        }),
      }),
      timeoutMs,
    );
    if (!response.ok) return undefined;
    const body = await response.json() as {
      answers?: { route?: { choice?: string; confidence?: number; probabilities?: Record<string, number> } };
    };
    const answer = body.answers?.route;
    if (!answer || typeof answer.choice !== 'string') return undefined;
    if (!(answer.choice in ROUTE_CRITERIA)) return undefined;
    const confidence = typeof answer.confidence === 'number' ? answer.confidence : 0;
    if (!(confidence >= JEV_MIN_CONFIDENCE)) return undefined;
    const probabilities: Record<string, number> = {};
    for (const [k, v] of Object.entries(answer.probabilities ?? {})) {
      if (typeof v === 'number') probabilities[k] = v;
    }
    return { route: answer.choice as JevRoute, confidence, probabilities };
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`jev timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
