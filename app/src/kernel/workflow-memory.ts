import { ExecutionPlan, PlanStep } from './planner';
import { createKernelId } from './execution-context';
import { isStepReference, parseStepReference, STEP_REFERENCE_PREFIX } from './step-references';
import { KernelId } from './types';

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
 * In-memory for now; a persistent store can replace it later.
 */
export class WorkflowMemory {
  private readonly workflows = new Map<KernelId, LearnedWorkflow>();

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
  }

  get(workflowId: KernelId): LearnedWorkflow | undefined {
    return this.workflows.get(workflowId);
  }

  list(): LearnedWorkflow[] {
    return Array.from(this.workflows.values());
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

function scoreOverlap(queryTerms: string[], storedTerms: string[]): number {
  const stored = new Set(storedTerms);
  let matches = 0;
  for (const term of queryTerms) {
    if (stored.has(term)) matches += 1;
  }
  return matches / Math.max(queryTerms.length, 1);
}
