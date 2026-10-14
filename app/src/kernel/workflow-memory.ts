import { ExecutionPlan, PlanStep } from './planner';
import { createKernelId } from './execution-context';
import { isStepReference, parseStepReference, STEP_REFERENCE_PREFIX } from './step-references';
import { KernelId } from './types';
import { getPool } from '../db/postgres';

export interface LearnedWorkflow {
  id: KernelId;
  goal: string;
  steps: PlanStep[];
  successCriteria: string[];
  explanation?: string;
  useCount: number;
  successCount: number;
  createdAt: string;
  lastUsedAt?: string;
}

export interface ReusedPlan {
  workflowId: KernelId;
  plan: ExecutionPlan;
}

/**
 * Workflow memory: successful plans become reusable procedures.
 *
 * Save stores the validated step structure. Recall matches a new goal
 * against stored goals by metadata term overlap — no hardcoded app
 * knowledge. Reuse remaps step IDs and rewrites every $steps.* reference
 * so the recalled plan executes fresh without colliding with the original.
 * Persisted best-effort to Postgres (`learned_workflows`); memory is the
 * source of truth when the database is unavailable (tests, offline).
 */
export class WorkflowMemory {
  private readonly workflows = new Map<KernelId, LearnedWorkflow>();
  private loadedFromDb = false;

  save(plan: ExecutionPlan, maxWorkflows = 100): LearnedWorkflow {
    const workflow: LearnedWorkflow = {
      id: createKernelId('workflow'),
      goal: plan.goal,
      steps: plan.steps.map(step => ({
        ...step,
        input: structuredCloneInput(step.input),
        dependsOn: [...(step.dependsOn ?? [])],
      })),
      successCriteria: [...plan.successCriteria],
      explanation: plan.explanation,
      useCount: 0,
      successCount: 0,
      createdAt: new Date().toISOString(),
    };
    this.workflows.set(workflow.id, workflow);
    void this.persistWorkflow(workflow);
    while (this.workflows.size > maxWorkflows) {
      // Evict the least recently used workflow first.
      let oldest: LearnedWorkflow | undefined;
      for (const candidate of this.workflows.values()) {
        if (!oldest || (candidate.lastUsedAt ?? candidate.createdAt) < (oldest.lastUsedAt ?? oldest.createdAt)) {
          oldest = candidate;
        }
      }
      if (!oldest) break;
      this.workflows.delete(oldest.id);
    }
    return workflow;
  }

  recall(goal: string, limit = 3, minScore = 0): LearnedWorkflow[] {
    const terms = extractTerms(goal);
    if (terms.length === 0) return [];

    return Array.from(this.workflows.values())
      .map(workflow => ({ workflow, score: scoreOverlap(terms, extractTerms(workflow.goal)) }))
      .filter(candidate => candidate.score >= minScore && candidate.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(candidate => candidate.workflow);
  }

  /**
   * Acting on memory needs stronger overlap than browsing it: 0.6 means a
   * clear majority of the goal's terms match the saved goal. Below that,
   * plan fresh — a wrong reused plan is worse than a slow correct one.
   */
  reuse(goal: string, minScore = 0.6): ReusedPlan | undefined {
    const workflow = this.recall(goal, 1, minScore)[0];
    if (!workflow) return undefined;

    const idMap = new Map<string, string>();
    for (const step of workflow.steps) {
      idMap.set(step.id, createKernelId('step'));
    }

    const steps: PlanStep[] = workflow.steps.map(step => ({
      ...step,
      id: idMap.get(step.id)!,
      input: rewriteInputReferences(step.input, idMap) as Record<string, unknown>,
      dependsOn: (step.dependsOn ?? []).map(dep => idMap.get(dep) ?? dep),
    }));

    workflow.useCount += 1;
    workflow.lastUsedAt = new Date().toISOString();

    return {
      workflowId: workflow.id,
      plan: {
        id: createKernelId('plan'),
        goal,
        steps,
        successCriteria: [...workflow.successCriteria],
        explanation: workflow.explanation
          ? `Reused workflow "${workflow.id}" (${workflow.explanation})`
          : `Reused workflow "${workflow.id}".`,
      },
    };
  }

  recordOutcome(workflowId: KernelId, succeeded: boolean): void {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return;
    if (succeeded) workflow.successCount += 1;
    void this.persistOutcome(workflow);
  }

  get(workflowId: KernelId): LearnedWorkflow | undefined {
    return this.workflows.get(workflowId);
  }

  list(): LearnedWorkflow[] {
    return Array.from(this.workflows.values());
  }

  /** Best-effort load of persisted workflows (never throws). */
  async loadFromDatabase(limit = 100): Promise<number> {
    if (this.loadedFromDb) return this.workflows.size;
    try {
      /* getPool via static import */
      const pool = getPool();
      const result = await pool.query(
        `SELECT id, goal, steps, success_criteria, explanation, use_count, success_count, created_at, last_used_at
         FROM learned_workflows ORDER BY last_used_at DESC NULLS LAST, created_at DESC LIMIT $1`,
        [limit],
      );
      for (const row of result.rows) {
        if (this.workflows.has(row.id)) continue;
        this.workflows.set(row.id, {
          id: row.id,
          goal: row.goal,
          steps: row.steps ?? [],
          successCriteria: row.success_criteria ?? [],
          explanation: row.explanation ?? undefined,
          useCount: row.use_count ?? 0,
          successCount: row.success_count ?? 0,
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
          lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : undefined,
        });
      }
      this.loadedFromDb = true;
      return this.workflows.size;
    } catch {
      return this.workflows.size;
    }
  }

  private async persistWorkflow(workflow: LearnedWorkflow): Promise<void> {
    try {
      /* getPool via static import */
      await getPool().query(
        `INSERT INTO learned_workflows (id, goal, steps, success_criteria, explanation, use_count, success_count, created_at, last_used_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET goal = EXCLUDED.goal, steps = EXCLUDED.steps,
           success_criteria = EXCLUDED.success_criteria, explanation = EXCLUDED.explanation,
           use_count = EXCLUDED.use_count, success_count = EXCLUDED.success_count,
           last_used_at = EXCLUDED.last_used_at`,
        [
          workflow.id, workflow.goal, JSON.stringify(workflow.steps),
          JSON.stringify(workflow.successCriteria), workflow.explanation ?? null,
          workflow.useCount, workflow.successCount, workflow.createdAt, workflow.lastUsedAt ?? null,
        ],
      );
    } catch {
      // Offline/tests: memory remains the source of truth.
    }
  }

  private async persistOutcome(workflow: LearnedWorkflow): Promise<void> {
    try {
      /* getPool via static import */
      await getPool().query(
        `UPDATE learned_workflows SET use_count = $2, success_count = $3, last_used_at = NOW() WHERE id = $1`,
        [workflow.id, workflow.useCount, workflow.successCount],
      );
    } catch {
      // Best-effort only.
    }
  }
}

export const workflowMemory = new WorkflowMemory();

function structuredCloneInput(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input ?? {})) as Record<string, unknown>;
}

function rewriteInputReferences(value: unknown, idMap: Map<string, string>): unknown {
  if (isStepReference(value)) {
    const target = parseStepReference(value);
    if (!target) return value;
    const replacement = idMap.get(target.stepId) ?? target.stepId;
    const suffix = target.path.length > 0 ? `.${target.path.join('.')}` : '';
    return `${STEP_REFERENCE_PREFIX}${replacement}${suffix}`;
  }
  if (Array.isArray(value)) {
    return value.map(item => rewriteInputReferences(item, idMap));
  }
  if (typeof value === 'object' && value !== null) {
    const rewritten: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      rewritten[key] = rewriteInputReferences(item, idMap);
    }
    return rewritten;
  }
  return value;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'for', 'from', 'get', 'give', 'how', 'in',
  'is', 'it', 'me', 'my', 'of', 'on', 'please', 'tell', 'that', 'the',
  'this', 'to', 'what', 'with', 'you',
]);

function extractTerms(input: string): string[] {
  return [
    ...new Set(
      input
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, ' ')
        .split(/\s+/)
        .map(term => term.trim())
        .filter(term => term.length >= 2)
        .filter(term => !STOP_WORDS.has(term)),
    ),
  ];
}

/** Meaningful goal terms (stopwords removed). Used to avoid memorizing trivial goals like "hi". */
export function extractGoalTerms(input: string): string[] {
  return extractTerms(input ?? '');
}

function scoreOverlap(queryTerms: string[], storedTerms: string[]): number {
  const stored = new Set(storedTerms);
  let matches = 0;
  for (const term of queryTerms) {
    if (stored.has(term)) matches += 1;
  }
  return matches / Math.max(queryTerms.length, 1);
}
