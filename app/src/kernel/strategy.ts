/**
 * Strategy selection: MARK's memory of architectural decisions.
 *
 * MARK doesn't select agents — it selects STRATEGIES (solo vs team
 * topologies) per task class, and learns which wins from trials. Each
 * trial records the richer execution record; operator-set weights turn
 * it into a scalar utility; the utility threshold turns it into a binary
 * outcome; Beta-Bernoulli posteriors track P(strategy works | class).
 * Dispatch Thompson-samples the posteriors (uncertainty earns trials);
 * promotion is P(U_a > U_b + margin) >= 0.95 by Monte Carlo, never a
 * fixed win count. Small-n posteriors correctly refuse to promote.
 *
 * Storage: strategy_trials (migration 010). Same promotion mechanic as
 * ops-memory fix-type trust, one level up (topologies, not fixes).
 */
import { getPool } from '../db/postgres';

export type StrategyTopology =
  | 'solo'
  | 'parallel-team'
  | 'supervised-team'
  | 'sequential-team'
  | 'worktree-team';

export interface Strategy {
  id: string;
  version: string;
  taskClasses: string[];
  topology: StrategyTopology;
  constraints: string[];
  budgetPolicy: string;
  verificationPolicy: string;
}

export interface UtilityWeights {
  version: string;
  wSuccess: number;
  wVerified: number;
  wRegression: number;
  wLatency: number;
  wTokens: number;
  /** Binary outcome threshold on utility. */
  threshold: number;
  /** Normalizers: wall ms and tokens mapping to [0,1] cost units. */
  latencyScaleMs: number;
  tokenScale: number;
}

/**
 * Default weights, calibrated so a verified success at modest cost is a
 * clean win (U > 0), a regression drags below zero, and pure latency or
 * token excess alone cannot sink an otherwise clean run. Operators change
 * what "better" means by changing these — the machinery is untouched.
 */
export const DEFAULT_WEIGHTS: UtilityWeights = {
  version: 'u-v1',
  wSuccess: 1.0,
  wVerified: 0.6,
  wRegression: -1.6,
  wLatency: 0.3,
  wTokens: 0.3,
  threshold: 0,
  latencyScaleMs: 300000,
  tokenScale: 100000,
};

export interface TrialRecord {
  success: boolean;
  verified: boolean;
  regression: boolean;
  tokens: number;
  durationMs: number;
}

export function computeUtility(t: TrialRecord, w: UtilityWeights = DEFAULT_WEIGHTS): number {
  return (
    (t.success ? w.wSuccess : 0) +
    (t.verified ? w.wVerified : 0) +
    (t.regression ? w.wRegression : 0) -
    w.wLatency * Math.min(t.durationMs / w.latencyScaleMs, 1) -
    w.wTokens * Math.min(t.tokens / w.tokenScale, 1)
  );
}

/** Binary outcome for the Beta-Bernoulli posterior. */
export function binaryOutcome(utility: number, w: UtilityWeights = DEFAULT_WEIGHTS): 0 | 1 {
  return utility > w.threshold ? 1 : 0;
}

export interface Posterior {
  alpha: number;
  beta: number;
}

export function posteriorFor(binaries: Array<0 | 1>): Posterior {
  let wins = 0;
  for (const b of binaries) wins += b;
  return { alpha: 1 + wins, beta: 1 + binaries.length - wins };
}

export function posteriorMean(p: Posterior): number {
  return p.alpha / (p.alpha + p.beta);
}

// ─── Beta sampling (Thompson) ─────────────────────────────────────────────
// Marsaglia-Tsang gamma sampler with an injectable uniform source so tests
// are deterministic. No math dependency for two distributions.

export type Rand = () => number;

function gammaSample(shape: number, rand: Rand): number {
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1) * U^(1/a).
    return gammaSample(shape + 1, rand) * Math.pow(Math.max(rand(), 1e-12), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    for (;;) {
      x = gaussian(rand);
      v = 1 + c * x;
      if (v > 0) break;
    }
    v = v * v * v;
    const u = Math.max(rand(), 1e-12);
    if (u < 1 - 0.331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function gaussian(rand: Rand): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function betaSample(p: Posterior, rand: Rand = Math.random): number {
  const a = gammaSample(p.alpha, rand);
  const b = gammaSample(p.beta, rand);
  const total = a + b;
  if (!(total > 0)) return 0.5;
  return a / total;
}

/** Thompson pick: highest posterior sample wins. Uncertainty earns trials. */
export function thompsonPick(posteriors: Posterior[], rand: Rand = Math.random): number {
  let best = 0;
  let bestSample = -1;
  for (let i = 0; i < posteriors.length; i++) {
    const s = betaSample(posteriors[i], rand);
    if (s > bestSample) {
      bestSample = s;
      best = i;
    }
  }
  return best;
}

/**
 * Promotion evidence: Monte Carlo P(U_a > U_b + margin). Never a fixed
 * win count — small-n posteriors are wide and correctly refuse.
 */
export function probSuperior(
  a: Posterior, b: Posterior, margin = 0, samples = 2000, rand: Rand = Math.random,
): number {
  let wins = 0;
  for (let i = 0; i < samples; i++) {
    if (betaSample(a, rand) > betaSample(b, rand) + margin) wins++;
  }
  return wins / samples;
}

// ─── Strategy registry ────────────────────────────────────────────────────

export const STRATEGY_REGISTRY: Strategy[] = [
  {
    id: 'solo', version: 'v1',
    // Solo serves every class: it is the universal fallback and the
    // control arm every team topology must beat.
    taskClasses: ['repo_bugfix', 'large_refactor', 'repo_analysis', 'system_diagnosis', 'incident_triage', 'incident_recovery', 'research', 'shell_task'],
    topology: 'solo',
    constraints: ['single agent owns the goal end to end'],
    budgetPolicy: 'one execution budget, no fan-out cost',
    verificationPolicy: 'domain verifier attests acceptance',
  },
  {
    id: 'parallel-team', version: 'v1',
    taskClasses: ['repo_analysis', 'system_diagnosis', 'research', 'incident_triage'],
    topology: 'parallel-team',
    constraints: ['read-only workers; max 4 concurrent; shared incident blackboard'],
    budgetPolicy: 'per-worker step budget, shared token ceiling',
    verificationPolicy: 'integrator composes; domain verifier attests acceptance',
  },
  {
    id: 'supervised-team', version: 'v1',
    taskClasses: ['repo_bugfix', 'large_refactor', 'incident_recovery'],
    topology: 'supervised-team',
    constraints: ['supervisor assigns disjoint scopes; writes sequential or worktree-isolated'],
    budgetPolicy: 'per-worker step budget, verify-after-every-apply',
    verificationPolicy: 'attestation per requirement id; unresolved findings reject',
  },
  {
    id: 'sequential-team', version: 'v1',
    taskClasses: ['large_refactor', 'incident_recovery'],
    topology: 'sequential-team',
    constraints: ['specialists run in order; each verifies before handoff'],
    budgetPolicy: 'per-stage budget; stop on first rejection',
    verificationPolicy: 'stage-gate attestation at every handoff',
  },
  {
    id: 'worktree-team', version: 'v1',
    taskClasses: ['large_refactor', 'repo_bugfix'],
    topology: 'worktree-team',
    constraints: ['one git worktree per worker; merge through integration branch'],
    budgetPolicy: 'per-worktree budgets; integration owns conflict resolution',
    verificationPolicy: 'verify_patch per worktree, then whole-tree verification',
  },
];

export function strategiesFor(taskClass: string): Strategy[] {
  return STRATEGY_REGISTRY.filter(s => s.taskClasses.includes(taskClass));
}

/**
 * Maps historical incident failure types to task classes for prior
 * seeding. Unknown types return undefined and are SKIPPED, never
 * shoehorned — a fabricated class poisons the posterior it feeds.
 */
export function failureTypeToTaskClass(failureType: string): string | undefined {
  const t = String(failureType ?? '').toUpperCase().trim();
  if ([
    'MISSING_DEPENDENCY', 'TYPE_ERROR', 'LINT_FAILURE', 'TEST_FAILURE',
    'BUILD_FAILURE', 'OOM_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'PERMISSION_ERROR',
  ].includes(t)) return 'repo_bugfix';
  if (t === 'UNKNOWN') return 'incident_triage';
  return undefined;
}

// ─── Trial store ──────────────────────────────────────────────────────────

export interface StrategyTrial extends TrialRecord {
  id: string;
  taskClass: string;
  classifierVersion: string;
  strategyId: string;
  strategyVersion: string;
  utility: number;
  weightsVersion: string;
  binary: 0 | 1;
  alpha: number;
  beta: number;
  createdAt: string;
}

function newTrialId(): string {
  return `st_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function recordTrial(input: {
  taskClass: string;
  classifierVersion?: string;
  strategyId: string;
  strategyVersion?: string;
  trial: TrialRecord;
  weights?: UtilityWeights;
}): Promise<StrategyTrial | undefined> {
  const weights = input.weights ?? DEFAULT_WEIGHTS;
  const utility = computeUtility(input.trial, weights);
  const binary = binaryOutcome(utility, weights);
  try {
    const pool = getPool();
    const prior = await pool.query(
      `SELECT binary_outcome FROM strategy_trials WHERE task_class = $1 AND strategy_id = $2 ORDER BY created_at ASC`,
      [input.taskClass, input.strategyId],
    );
    const binaries = [...prior.rows.map(r => (r.binary_outcome ? 1 : 0) as 0 | 1), binary];
    const post = posteriorFor(binaries);
    const id = newTrialId();
    await pool.query(
      `INSERT INTO strategy_trials
        (id, task_class, classifier_version, strategy_id, strategy_version,
         success, verified, regression, tokens, duration_ms,
         utility, weights_version, binary_outcome, posterior_alpha, posterior_beta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, input.taskClass, input.classifierVersion ?? 'tc-v1', input.strategyId,
        input.strategyVersion ?? 'v1', input.trial.success, input.trial.verified,
        input.trial.regression, input.trial.tokens, input.trial.durationMs,
        utility, weights.version, binary, post.alpha, post.beta],
    );
    return {
      id, taskClass: input.taskClass, classifierVersion: input.classifierVersion ?? 'tc-v1',
      strategyId: input.strategyId, strategyVersion: input.strategyVersion ?? 'v1',
      ...input.trial, utility, weightsVersion: weights.version, binary,
      alpha: post.alpha, beta: post.beta, createdAt: new Date().toISOString(),
    };
  } catch (err) {
    console.debug('[strategy] recordTrial failed:', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

export async function currentPosterior(taskClass: string, strategyId: string): Promise<Posterior> {
  try {
    const pool = getPool();
    const rows = await pool.query(
      `SELECT binary_outcome FROM strategy_trials WHERE task_class = $1 AND strategy_id = $2 ORDER BY created_at ASC`,
      [taskClass, strategyId],
    );
    return posteriorFor(rows.rows.map(r => (r.binary_outcome ? 1 : 0) as 0 | 1));
  } catch {
    return { alpha: 1, beta: 1 };
  }
}

/** Display preference: highest posterior mean. Dispatch uses Thompson sampling. */
export async function preferredStrategy(taskClass: string): Promise<{ strategy: Strategy; mean: number } | undefined> {
  const candidates = strategiesFor(taskClass);
  if (candidates.length === 0) return undefined;
  let best: Strategy | undefined;
  let bestMean = -1;
  for (const s of candidates) {
    const mean = posteriorMean(await currentPosterior(taskClass, s.id));
    if (mean > bestMean) {
      bestMean = mean;
      best = s;
    }
  }
  return best ? { strategy: best, mean: bestMean } : undefined;
}
