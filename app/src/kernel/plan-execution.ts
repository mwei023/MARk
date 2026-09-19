import {
  ActionRequest,
  ActionResult,
  ActionStatus,
  ExecutionContext,
  Observation,
  ToolDescriptor,
} from './types';

import {
  createKernelId,
} from './execution-context';

import {
  ExecutionPlan,
  PlanExecutionReport,
  PlanExecutionResult,
  PlanExecutionStatus,
  PlanStep,
  PlanStepResult,
  PlanStepStatus,
  PlanValidationResult,
  sortPlanSteps,
  validatePlan,
} from './planner';

import {
  resolveInputReferences,
  StepReferenceError,
  StepResultSnapshot,
  collectStepReferences,
  parseStepReference,
} from './step-references';

import { validateOutput } from './output-contracts';

import {
  listSchemaLeafPaths,
  resolveSchemaPath,
  scoreCompatibility,
} from './compatibility';

import { reliabilityTracker } from './reliability';

export interface ExecuteStructuredPlanInput {
  plan: ExecutionPlan;
  context: ExecutionContext;
  validation?: PlanValidationResult;

  /**
   * Executes one validated step through the kernel's established execution
   * path. The kernel passes its executor-backed callback here so plan
   * execution never bypasses authority checks.
   */
  executeStep: (
    action: ActionRequest,
    context: ExecutionContext,
  ) => Promise<ActionResult>;

  /**
   * Optional recovery catalog. When a step fails (never when it is blocked
   * awaiting a human), the executor tries compatible sibling tools before
   * giving up on the step. Absent = fail fast, legacy behavior.
   */
  recovery?: PlanRecoveryOptions;
}

export interface PlanRecoveryOptions {
  tools: ToolDescriptor[];
  maxAlternativesPerStep?: number;
  /**
   * Optional episodic recall: similar past outcomes for "toolId error".
   * Used to prefer siblings that delivered before and demote ones that
   * failed in similar situations. Absent or throwing = no memory.
   */
  recall?: (text: string) => Promise<Array<{ toolId: string; status: string }>>;
}

interface StepExecutionState {
  step: PlanStep;
  status: PlanStepStatus;
  result?: PlanStepResult;
}

/**
 * Executes a validated plan with structured data flow between steps.
 *
 * Steps run in dependency order. Immediately before a step executes, its
 * input references (`$steps.<stepId>...`) are resolved against the stored
 * results of previously executed steps. Each step's result is stored by step
 * ID so later steps can consume it. A failed step marks its dependents as
 * `skipped`; steps on independent branches still execute. Every tool
 * invocation goes through the provided executeStep callback, which must be
 * the kernel's existing authority-checked execution path.
 *
 * The function always returns a structured PlanExecutionReport rather than
 * throwing for ordinary execution failures.
 */
export async function executeStructuredPlan(
  input: ExecuteStructuredPlanInput,
): Promise<PlanExecutionReport> {
  const { plan, context, executeStep, recovery } = input;

  const startedAt = new Date().toISOString();

  const validation = input.validation ?? validatePlan(plan);

  if (!validation.valid) {
    return buildReport({
      plan,
      status: 'failed',
      states: plan.steps.map(step => ({
        step,
        status: 'skipped' as PlanStepStatus,
      })),
      observations: [],
      validation,
      error: `Plan validation failed: ${validation.errors
        .map(error => error.message)
        .join('; ')}`,
      startedAt,
    });
  }

  // 1. Canonical dependency order.
  const orderedSteps = sortPlanSteps(plan.steps);
  const stepMap = new Map<string, PlanStep>(
    plan.steps.map(step => [step.id, step]),
  );

  // 2. Initialize every step as pending.
  const states = new Map<string, StepExecutionState>();
  for (const step of orderedSteps) {
    states.set(step.id, { step, status: 'pending' });
  }

  const observations: Observation[] = [];

  const markUnexecutedDependentsSkipped = (
    failedStepId: string,
  ): void => {
    for (const state of states.values()) {
      if (state.status !== 'pending') {
        continue;
      }

      const dependsOnFailed = collectTransitiveDependencies(
        state.step,
        stepMap,
      ).has(failedStepId);

      if (dependsOnFailed) {
        state.status = 'skipped';
        state.result = buildSkippedResult(
          state.step,
          failedStepId,
        );
      }
    }
  };

  for (const level of groupStepsByLevel(orderedSteps, stepMap)) {
    // Dependency checks first (all synchronous): deps live in earlier
    // levels and are already final, so skips are decided before anything
    // in this level runs.
    const runnable: Array<{ step: PlanStep; state: StepExecutionState; resolvedInput: Record<string, unknown> }> = [];
    for (const step of level) {
      const state = states.get(step.id)!;
      if (state.status !== 'pending') continue;

      const dependencyCheck = checkDependencies(step, states, stepMap);
      if (!dependencyCheck.satisfied) {
        state.status = 'skipped';
        state.result = buildSkippedResult(step, dependencyCheck.unsatisfiedBy!);
        continue;
      }

      // Resolve input references against finalized earlier levels.
      const dependencySnapshots = buildDependencySnapshots(states);
      let resolvedInput: Record<string, unknown>;
      try {
        resolvedInput = resolveInputReferences(step.input, dependencySnapshots);
      } catch (error) {
        const message =
          error instanceof StepReferenceError
            ? error.message
            : `Failed to resolve input references for step "${step.id}": ${describeError(error)}`;
        state.status = 'failed';
        state.result = buildFailedResult(step, step.input, message);
        markUnexecutedDependentsSkipped(step.id);
        continue;
      }
      runnable.push({ step, state, resolvedInput });
    }

    // Independent steps in one level run concurrently. Results are folded
    // back in plan order so reports and observations stay deterministic.
    const settled = await Promise.all(runnable.map(async ({ step, state, resolvedInput }) => {
      const action: ActionRequest = {
        id: createKernelId('action'),
        toolId: step.toolId,
        input: resolvedInput,
        requestedBy: context.userId,
        createdAt: new Date().toISOString(),
        metadata: {
          source: 'plan-execution',
          planId: plan.id,
          stepId: step.id,
        },
      };
      const stepStartedAt = new Date().toISOString();
      const result = await executeStep(action, context);
      return { step, state, action, resolvedInput, result, stepStartedAt, stepCompletedAt: new Date().toISOString() };
    }));

    for (const { step, state, action, resolvedInput, result, stepStartedAt, stepCompletedAt } of settled) {
      observations.push(...result.observations);

      if (result.status === 'succeeded') {
        state.status = 'succeeded';
        state.result = {
          stepId: step.id,
          toolId: step.toolId,
          status: 'succeeded',
          input: step.input,
          resolvedInput,
          action,
          output: result.output,
          result,
          observations: result.observations,
          startedAt: stepStartedAt,
          completedAt: stepCompletedAt,
        };
      } else if (result.status === 'failed' && recovery) {
        // Recovery: try compatible siblings before failing the step.
        // Blocked steps (awaiting human confirmation) never recover here.
        const recovered = await attemptStepRecovery({
          step,
          resolvedInput,
          originalError: result.error ?? `Step "${step.id}" finished with status "${result.status}".`,
          recovery,
          context,
          executeStep,
          observations,
        });
        if (recovered) {
          state.status = 'succeeded';
          state.result = recovered;
        } else {
          state.status = 'failed';
          state.result = {
            stepId: step.id,
            toolId: step.toolId,
            status: 'failed',
            input: step.input,
            resolvedInput,
            action,
            result,
            observations: result.observations,
            startedAt: stepStartedAt,
            completedAt: stepCompletedAt,
            error:
              result.error ??
              `Step "${step.id}" finished with status "${result.status}".`,
          };
          markUnexecutedDependentsSkipped(step.id);
        }
      } else {
        state.status = 'failed';
        state.result = {
          stepId: step.id,
          toolId: step.toolId,
          status: 'failed',
          input: step.input,
          resolvedInput,
          action,
          result,
          observations: result.observations,
          startedAt: stepStartedAt,
          completedAt: stepCompletedAt,
          error:
            result.error ??
            `Step "${step.id}" finished with status "${result.status}".`,
        };

        // Dependents of a failed step never run.
        markUnexecutedDependentsSkipped(step.id);
      }
    }
  }

  // 7. Assemble the report in the plan's declared step order.
  const orderedStates = plan.steps.map(
    step => states.get(step.id)!,
  );

  const anyFailed = orderedStates.some(
    state => state.status === 'failed',
  );
  const anySucceeded = orderedStates.some(
    state => state.status === 'succeeded',
  );

  const status: PlanExecutionStatus = anyFailed
    ? anySucceeded
      ? 'partial'
      : 'failed'
    : 'succeeded';

  const error = anyFailed
    ? orderedStates
        .filter(state => state.status === 'failed')
        .map(state => state.result?.error)
        .filter((message): message is string => Boolean(message))
        .join('; ')
    : undefined;

  return buildReport({
    plan,
    status,
    states: orderedStates,
    observations,
    validation,
    error,
    startedAt,
  });
}

interface DependencyCheckResult {
  satisfied: boolean;
  /** ID of the dependency that blocked execution, if any. */
  unsatisfiedBy?: string;
}

/**
 * Groups steps into execution levels: steps in one level share no
 * dependency edges (declared `dependsOn` or `$steps.*` input references)
 * and may run concurrently. Levels follow dependency order, and steps keep
 * plan order within a level so reports stay deterministic.
 */
function groupStepsByLevel(
  orderedSteps: PlanStep[],
  stepMap: Map<string, PlanStep>,
): PlanStep[][] {
  const edges = new Map<string, Set<string>>();
  for (const step of orderedSteps) {
    const deps = new Set<string>();
    for (const dependencyId of step.dependsOn ?? []) {
      if (stepMap.has(dependencyId)) deps.add(dependencyId);
    }
    for (const reference of collectStepReferences(step.input)) {
      const target = parseStepReference(reference);
      if (target && stepMap.has(target.stepId) && target.stepId !== step.id) {
        deps.add(target.stepId);
      }
    }
    edges.set(step.id, deps);
  }

  const levelOf = new Map<string, number>();
  const computeLevel = (stepId: string, visiting: Set<string>): number => {
    const known = levelOf.get(stepId);
    if (known !== undefined) return known;
    if (visiting.has(stepId)) return 0;
    visiting.add(stepId);
    let level = 0;
    for (const depId of edges.get(stepId) ?? []) {
      level = Math.max(level, computeLevel(depId, visiting) + 1);
    }
    visiting.delete(stepId);
    levelOf.set(stepId, level);
    return level;
  };

  const levels: PlanStep[][] = [];
  for (const step of orderedSteps) {
    const level = computeLevel(step.id, new Set());
    while (levels.length <= level) levels.push([]);
    levels[level].push(step);
  }
  return levels;
}

function checkDependencies(
  step: PlanStep,
  states: Map<string, StepExecutionState>,
  stepMap: Map<string, PlanStep>,
): DependencyCheckResult {
  for (const dependencyId of step.dependsOn ?? []) {
    const dependencyState = states.get(dependencyId);

    if (!dependencyState || dependencyState.status === 'pending') {
      return {
        satisfied: false,
        unsatisfiedBy: dependencyId,
      };
    }

    if (dependencyState.status !== 'succeeded') {
      return {
        satisfied: false,
        unsatisfiedBy: dependencyId,
      };
    }
  }

  // Dependencies declared transitively through reference usage.
  const transitiveDependencies = collectTransitiveDependencies(
    step,
    stepMap,
  );

  for (const dependencyId of transitiveDependencies) {
    const dependencyState = states.get(dependencyId);

    if (!dependencyState || dependencyState.status !== 'succeeded') {
      return {
        satisfied: false,
        unsatisfiedBy: dependencyId,
      };
    }
  }

  return { satisfied: true };
}

function collectTransitiveDependencies(
  step: PlanStep,
  stepMap: Map<string, PlanStep>,
  visited = new Set<string>(),
): Set<string> {
  const dependencies = new Set<string>();

  for (const dependencyId of step.dependsOn ?? []) {
    if (visited.has(dependencyId)) {
      continue;
    }
    visited.add(dependencyId);
    dependencies.add(dependencyId);

    const dependencyStep = stepMap.get(dependencyId);
    if (dependencyStep) {
      for (const transitiveId of collectTransitiveDependencies(
        dependencyStep,
        stepMap,
        visited,
      )) {
        dependencies.add(transitiveId);
      }
    }
  }

  return dependencies;
}

/**
 * Builds reference-resolvable snapshots from previously executed steps.
 *
 * Only executed steps are included, and only their succeeded results can be
 * referenced; the resolver enforces the rest.
 */
function buildDependencySnapshots(
  states: Map<string, StepExecutionState>,
): Map<string, StepResultSnapshot> {
  const snapshots = new Map<string, StepResultSnapshot>();

  for (const [stepId, state] of states) {
    if (!state.result) {
      continue;
    }

    snapshots.set(stepId, {
      stepId,
      status: state.result.status,
      output: state.result.output,
      result: state.result.result,
      resolvedInput: state.result.resolvedInput,
      error: state.result.error,
    });
  }

  return snapshots;
}

function buildSkippedResult(
  step: PlanStep,
  blockedBy: string,
): PlanStepResult {
  return {
    stepId: step.id,
    toolId: step.toolId,
    status: 'skipped',
    input: step.input,
    observations: [],
    error: `Step "${step.id}" was skipped because required dependency "${blockedBy}" did not succeed.`,
  };
}

function buildFailedResult(
  step: PlanStep,
  input: Record<string, unknown>,
  error: string,
): PlanStepResult {
  return {
    stepId: step.id,
    toolId: step.toolId,
    status: 'failed',
    input,
    observations: [],
    error,
  };
}

function buildReport(args: {
  plan: ExecutionPlan;
  status: PlanExecutionStatus;
  states: Array<StepExecutionState>;
  observations: Observation[];
  validation: PlanValidationResult;
  error?: string;
  startedAt: string;
}): PlanExecutionReport {
  const steps = args.states.map(state => {
    const result: PlanStepResult =
      state.result ??
      {
        stepId: state.step.id,
        toolId: state.step.toolId,
        status: state.status,
        input: state.step.input,
        observations: [],
      };

    return result;
  });

  const finalOutputs: Record<string, unknown> = {};

  for (const step of steps) {
    if (step.status === 'succeeded') {
      finalOutputs[step.stepId] = step.output;
    }
  }

  return {
    planId: args.plan.id,
    goal: args.plan.goal,
    status: args.status,
    startedAt: args.startedAt,
    completedAt: new Date().toISOString(),
    steps,
    finalOutputs,
    observations: args.observations,
    validation: args.validation,
    error: args.error,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Recovery: substitute a compatible sibling tool for a failed step.
 *
 * A sibling qualifies only when:
 * - it is available and is not the failed tool;
 * - every input it requires is already present in the resolved input;
 * - the failed tool declares an output contract, and every required leaf
 *   of that contract exists in the sibling's output with a compatible type
 *   (so downstream `$steps.*` references keep working);
 * - its own run succeeds AND its output validates against the failed
 *   tool's contract.
 *
 * Each attempt goes through executeStep, so authority checks apply to
 * siblings too. A sibling that comes back `blocked` (needs a human) stops
 * recovery immediately — automation never routes around confirmation.
 * Returns a succeeded PlanStepResult, or undefined when nothing recovered.
 */
async function attemptStepRecovery(args: {
  step: PlanStep;
  resolvedInput: Record<string, unknown>;
  originalError: string;
  recovery: PlanRecoveryOptions;
  context: ExecutionContext;
  executeStep: (action: ActionRequest, context: ExecutionContext) => Promise<ActionResult>;
  observations: Observation[];
}): Promise<PlanStepResult | undefined> {
  const { step, resolvedInput, originalError, recovery, context, executeStep, observations } = args;
  const failedTool = recovery.tools.find(tool => tool.id === step.toolId);
  if (!failedTool?.outputSchema) return undefined;

  const requiredLeaves = listSchemaLeafPaths(failedTool.outputSchema)
    .filter(leaf => (failedTool.outputSchema?.required ?? []).includes(leaf.path[0]));
  if (requiredLeaves.length === 0) return undefined;

  const candidates = recovery.tools
    .filter(tool => tool.id !== step.toolId && tool.available && tool.outputSchema)
    .filter(tool => {
      const required = tool.inputSchema?.required ?? [];
      if (!required.every(key => key in resolvedInput)) return false;
      return requiredLeaves.every(leaf => {
        const siblingNode = resolveSchemaPath(tool.outputSchema, leaf.path);
        return siblingNode !== null && scoreCompatibility(siblingNode, leaf.schema).compatible;
      });
    });

  // Memory: what happened last time in similar situations?
  let memory: Array<{ toolId: string; status: string }> = [];
  if (recovery.recall && candidates.length > 0) {
    try {
      memory = await recovery.recall(`${step.toolId} ${originalError}`.slice(0, 500));
    } catch (err) {
      // Memory recall failed — continue with empty memory, no recovery ranking.
      memory = [];
      console.debug('[plan-execution] recovery.recall failed:', err instanceof Error ? err.message : String(err));
    }
  }
  const memoryScore = (toolId: string): number => {
    let score = 0;
    for (const episode of memory) {
      if (episode.toolId !== toolId) continue;
      score += episode.status === 'succeeded' ? 1 : -1;
    }
    return score;
  };

  const ranked = candidates
    .sort((a, b) =>
      (b.domain === failedTool.domain ? 1 : 0) - (a.domain === failedTool.domain ? 1 : 0) ||
      memoryScore(b.id) - memoryScore(a.id) ||
      reliabilityTracker.score(b.id) - reliabilityTracker.score(a.id) ||
      a.id.localeCompare(b.id),
    )
    .slice(0, Math.max(recovery.maxAlternativesPerStep ?? 2, 0));
  if (ranked.length === 0) return undefined;

  if (memory.length > 0) {
    const relevant = ranked
      .map(tool => `${tool.id}(${memoryScore(tool.id) >= 0 ? '+' : ''}${memoryScore(tool.id)})`)
      .join(', ');
    observations.push(recoveryObservation(step, `memory: ${memory.length} similar past outcome(s); sibling history ${relevant}`));
  }

  for (const sibling of ranked) {
    const siblingAction: ActionRequest = {
      id: createKernelId('action'),
      toolId: sibling.id,
      input: resolvedInput,
      requestedBy: context.userId,
      createdAt: new Date().toISOString(),
      metadata: { source: 'plan-recovery', planId: '', stepId: step.id, recoveryFor: step.toolId },
    };
    const siblingResult = await executeStep(siblingAction, context);
    observations.push(...siblingResult.observations);

    if (siblingResult.status === 'blocked') {
      observations.push(recoveryObservation(step, `sibling "${sibling.id}" needs human confirmation; recovery stops`));
      return undefined;
    }
    if (siblingResult.status !== 'succeeded') continue;

    const contract = validateOutput(siblingResult.output, failedTool.outputSchema);
    if (!contract.valid) continue;

    const summary = `Recovered step "${step.id}" via sibling "${sibling.id}" after "${failedTool.id}" failed: ${originalError}`;
    observations.push(recoveryObservation(step, summary));
    return {
      stepId: step.id,
      toolId: sibling.id,
      status: 'succeeded',
      input: step.input,
      resolvedInput,
      action: siblingAction,
      output: siblingResult.output,
      result: {
        ...siblingResult,
        metadata: { ...(siblingResult.metadata ?? {}), recoveredVia: sibling.id, recoveryFor: step.toolId },
      },
      observations: siblingResult.observations,
      startedAt: siblingResult.startedAt,
      completedAt: siblingResult.completedAt,
      error: undefined,
    };
  }

  observations.push(recoveryObservation(
    step,
    `Recovery exhausted for step "${step.id}": tried ${ranked.map(c => c.id).join(', ')}; original error stands: ${originalError}`,
  ));
  return undefined;
}

function recoveryObservation(step: PlanStep, summary: string): Observation {
  return {
    id: `observation-${Date.now()}`,
    kind: 'output',
    source: 'kernel.recovery',
    subject: step.id,
    summary,
    data: { stepId: step.id, toolId: step.toolId },
    confidence: 1,
    observedAt: new Date().toISOString(),
    relatedResourceIds: [],
  };
}

/**
 * Adapts a structured PlanExecutionReport to the pre-existing
 * PlanExecutionResult shape so established callers keep working.
 *
 * Only steps that actually executed appear in `stepResults`, matching the
 * historical stop-at-first-failure behavior; the full ordered picture,
 * including skipped steps, is available on the report itself.
 */
export function toPlanExecutionResult(
  report: PlanExecutionReport,
): PlanExecutionResult {
  const executedSteps = report.steps.filter(
    step => step.action && step.result,
  );

  const firstFailedStep = report.steps.find(
    step => step.status === 'failed',
  );

  const status: ActionStatus =
    report.status === 'succeeded'
      ? 'succeeded'
      : firstFailedStep?.result?.status ?? 'failed';

  const error =
    report.validation && !report.validation.valid
      ? report.error
      : firstFailedStep
        ? `Plan execution failed at step "${firstFailedStep.stepId}": ${firstFailedStep.result?.error ?? firstFailedStep.result?.status ?? 'failed'}`
        : report.error;

  return {
    planId: report.planId,
    goal: report.goal,
    status,
    validation: report.validation ?? {
      valid: true,
      errors: [],
      reason: 'Plan validation succeeded.',
    },
    stepResults: executedSteps.map(step => ({
      stepId: step.stepId,
      toolId: step.toolId,
      action: step.action!,
      result: step.result!,
    })),
    observations: report.observations,
    error,
  };
}
