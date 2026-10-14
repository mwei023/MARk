/**
 * Task classifier: which TASK CLASS does a goal belong to?
 *
 * Separate from Jev routing (which picks a HANDLER). The class drives
 * STRATEGY selection (solo vs which team topology), so it lives beside
 * jev.ts and shares its contract: Jev decides the fuzzy cases with
 * calibrated confidence; whole-word keyword rules cover the clear cases
 * and all offline runs; no key/network/failure ever throws or logs.
 * Versioned (tc-v1): trials record the classifier version so class
 * drift never silently rewrites history.
 */
import { JEV_MIN_CONFIDENCE } from './jev';

export const TASK_CLASSIFIER_VERSION = 'tc-v1';
/** Below this confidence the keyword fallback (or solo default) stands. */
export const TASK_CLASS_MIN_CONFIDENCE = JEV_MIN_CONFIDENCE;

export type TaskClass =
  | 'repo_bugfix'
  | 'large_refactor'
  | 'repo_analysis'
  | 'system_diagnosis'
  | 'incident_triage'
  | 'incident_recovery'
  | 'research'
  | 'shell_task';

export interface TaskClassDecision {
  taskClass: TaskClass;
  confidence: number;
  source: 'jev' | 'keyword';
}

const CLASSES: TaskClass[] = [
  'repo_bugfix',
  'large_refactor',
  'repo_analysis',
  'system_diagnosis',
  'incident_triage',
  'incident_recovery',
  'research',
  'shell_task',
];

/**
 * Whole-word keyword rules. Deliberately coarse: they only need to beat
 * the solo default for clear cases. Jev owns the fuzzy middle.
 */
export function keywordTaskClass(goal: string): TaskClassDecision | undefined {
  const g = goal.toLowerCase();
  const has = (re: RegExp): boolean => re.test(g);
  // Incident recovery first: restore/rollback verbs outrank triage nouns.
  if (has(/\b(rollback|restore|recover|failover|roll back)\b/)) {
    return { taskClass: 'incident_recovery', confidence: 0.8, source: 'keyword' };
  }
  // Triage: investigate a failure someone else must fix.
  if (has(/\b(triage|investigate|outage|incident|postmortem|why\s+(is|are|did|does).*(down|failing|failing|broken|slow))\b/)) {
    return { taskClass: 'incident_triage', confidence: 0.8, source: 'keyword' };
  }
  // Large refactor before bugfix: restructuring verbs own the goal.
  if (has(/\b(refactor|restructure|reorganize|re-architect|migrate\b.{0,20}(code|repo|module))\b/)) {
    return { taskClass: 'large_refactor', confidence: 0.8, source: 'keyword' };
  }
  // Bugfix: repair verbs on code.
  if (has(/\b(fix|fixes|fixed|repair|bug|bugs|broken|patch|regression)\b/) && has(/\b(code|repo|file|files|tests?|lint|type|build|commit|branch|src)\b/)) {
    return { taskClass: 'repo_bugfix', confidence: 0.8, source: 'keyword' };
  }
  // Analysis: survey/map/audit the tree, no mutation implied.
  if (has(/\b(analy[sz]e|analysis|survey|map|audit|inventory|dependency graph)\b/) && has(/\b(repo|code|codebase|files?|tree|project|src|app|directory|directories|folder|workspace)\b/)) {
    return { taskClass: 'repo_analysis', confidence: 0.8, source: 'keyword' };
  }
  // Research before system: deep/external inquiry owns it.
  if (has(/\b(deep research|deep dive|literature review|state of the art|survey the field|thoroughly research)\b/)) {
    return { taskClass: 'research', confidence: 0.8, source: 'keyword' };
  }
  // System diagnosis: machine-inspection verbs.
  if (has(/\b(diagnose|inspect (the )?system|check (my )?system|why is .*(slow|full|hot)|disk|memory leak)\b/)) {
    return { taskClass: 'system_diagnosis', confidence: 0.8, source: 'keyword' };
  }
  // Shell: run/list/move files and commands.
  if (has(/\b(run|execute|list files|move|copy|find in files)\b/)) {
    return { taskClass: 'shell_task', confidence: 0.7, source: 'keyword' };
  }
  return undefined;
}

/**
 * Classify a goal. Jev first when available (fuzzy middle, calibrated);
 * keywords cover clear + offline cases. Returns undefined only when
 * neither fires — callers fall back to solo.
 */
export async function decideTaskClass(
  goal: string,
  deps: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<TaskClassDecision | undefined> {
  if (!goal?.trim()) return undefined;
  const viaJev = await askJevTaskClass(goal, deps);
  if (viaJev) return viaJev;
  return keywordTaskClass(goal);
}

const TASK_CLASS_CRITERIA: Record<string, string> = {
  repo_bugfix: 'fixing a bug, error, or failing check in source code',
  large_refactor: 'restructuring or migrating a codebase across many files',
  repo_analysis: 'surveying, mapping, or auditing code without changing it',
  system_diagnosis: 'diagnosing machine state: cpu, memory, disk, processes, services',
  incident_triage: 'investigating a failure, outage, or incident to understand it',
  incident_recovery: 'restoring service: rollback, failover, restart to recover',
  research: 'deep research across many sources with citations',
  shell_task: 'running commands and file operations on this machine',
};

const DEFAULT_ENDPOINT = 'https://jevtypesafeai.com/api/v1/decide';
const TIMEOUT_MS = 8000;

function endpoint(): string {
  return process.env.JEV_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
}

function apiKey(): string | undefined {
  return process.env.JEV_API_KEY?.trim() || undefined;
}

/** Jev choice over task classes. Undefined without key, on any failure. Never throws. */
async function askJevTaskClass(
  goal: string,
  deps: { fetchFn?: typeof fetch; timeoutMs?: number },
): Promise<TaskClassDecision | undefined> {
  const key = apiKey();
  if (!key) return undefined;
  const timeoutMs = deps.timeoutMs ?? Number(process.env.JEV_TIMEOUT_MS ?? TIMEOUT_MS);
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const response = await withTimeout(
      fetchFn(endpoint(), {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: goal.slice(0, 1000),
          questions: {
            taskClass: {
              type: 'choice',
              instructions: 'Which task class best describes this user goal?',
              criteria: TASK_CLASS_CRITERIA,
            },
          },
        }),
      }),
      timeoutMs,
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      answers?: { taskClass?: { choice?: string; confidence?: number } };
    };
    const answer = body.answers?.taskClass;
    if (!answer || typeof answer.choice !== 'string') return undefined;
    if (!(answer.choice in TASK_CLASS_CRITERIA)) return undefined;
    const confidence = typeof answer.confidence === 'number' ? answer.confidence : 0;
    if (!(confidence >= TASK_CLASS_MIN_CONFIDENCE)) return undefined;
    return { taskClass: answer.choice as TaskClass, confidence, source: 'jev' };
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`task-class timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function taskClasses(): TaskClass[] {
  return [...CLASSES];
}
