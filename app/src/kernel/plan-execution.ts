import {
  ActionRequest,
  ActionResult,
  ActionStatus,
  ExecutionContext,
  Observation,
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
} from './step-references';

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
  const { plan, context, executeStep } = input;

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

  for (const step of orderedSteps) {
    const state = states.get(step.id)!;

    if (state.status !== 'pending') {
      continue;
    }

    // 3. Execute only when all dependencies are satisfied.
    const dependencyCheck = checkDependencies(step, states, stepMap);

    if (!dependencyCheck.satisfied) {
      state.status = 'skipped';
      state.result = buildSkippedResult(
        step,
        dependencyCheck.unsatisfiedBy!,
      );
      continue;
    }

    // 4. Resolve input references immediately before execution.
    const dependencySnapshots =
      buildDependencySnapshots(states);

    let resolvedInput: Record<string, unknown>;

    try {
      resolvedInput = resolveInputReferences(
        step.input,
        dependencySnapshots,
      );
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

    // 5. Execute through the established, authority-checked path.
    const stepStartedAt = new Date().toISOString();
    state.status = 'running';
    const result = await executeStep(action, context);
    const stepCompletedAt = new Date().toISOString();

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

      // 6. Dependents of a failed step never run.
      markUnexecutedDependentsSkipped(step.id);
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
