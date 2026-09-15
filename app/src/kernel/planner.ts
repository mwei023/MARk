import {
  ActionRequest,
  ActionResult,
  ActionStatus,
  KernelId,
  Observation,
  ToolDescriptor,
} from './types';
import { ToolRegistry } from './tool-registry';
import { CapabilityResolver } from './capability-resolver';
import { TaskBinder } from './task-binder';
import { createKernelId } from './execution-context';

export interface PlanStep {
  id: KernelId;
  toolId: KernelId;
  input: Record<string, unknown>;
  dependsOn?: KernelId[];
  expectedOutcome?: string;
}

export interface ExecutionPlan {
  id: KernelId;
  goal: string;
  steps: PlanStep[];
  successCriteria: string[];
}

export type PlanValidationErrorCode =
  | 'NONEXISTENT_TOOL'
  | 'UNAVAILABLE_TOOL'
  | 'DUPLICATE_STEP_ID'
  | 'MISSING_DEPENDENCY'
  | 'DEPENDENCY_CYCLE'
  | 'MISSING_REQUIRED_INPUT'
  | 'INVALID_INPUT';

export interface PlanValidationError {
  stepId?: KernelId;
  code: PlanValidationErrorCode;
  message: string;
}

export interface PlanValidationResult {
  valid: boolean;
  errors: PlanValidationError[];
  warnings?: string[];
  reason?: string;
}

export interface PlanExecutionResult {
  planId: KernelId;
  goal: string;
  status: ActionStatus;
  validation: PlanValidationResult;
  stepResults: Array<{
    stepId: KernelId;
    toolId: KernelId;
    action?: ActionRequest;
    result?: ActionResult;
  }>;
  observations: Observation[];
  error?: string;
}

export interface PlannerDependencies {
  toolRegistry?: ToolRegistry;
  capabilityResolver?: CapabilityResolver;
  taskBinder?: TaskBinder;
  tools?: ToolDescriptor[];
}

/**
 * Validates a structured ExecutionPlan against known tools and topological constraints.
 * Returns structured validation information rather than throwing for ordinary validation failures.
 */
export function validatePlan(
  plan: ExecutionPlan,
  toolRegistry?: ToolRegistry,
): PlanValidationResult {
  const errors: PlanValidationError[] = [];
  const warnings: string[] = [];

  // 1. Check for duplicate step IDs
  const seenStepIds = new Set<string>();
  for (const step of plan.steps) {
    if (seenStepIds.has(step.id)) {
      errors.push({
        stepId: step.id,
        code: 'DUPLICATE_STEP_ID',
        message: `Duplicate step ID "${step.id}" found in plan.`,
      });
    }
    seenStepIds.add(step.id);
  }

  // 2. Check for missing dependencies
  const planStepIds = new Set(plan.steps.map(s => s.id));
  for (const step of plan.steps) {
    for (const depId of step.dependsOn ?? []) {
      if (!planStepIds.has(depId)) {
        errors.push({
          stepId: step.id,
          code: 'MISSING_DEPENDENCY',
          message: `Step "${step.id}" depends on missing step "${depId}".`,
        });
      }
    }
  }

  // 3. Check for dependency cycles using 3-color DFS
  const stepMap = new Map<string, PlanStep>(plan.steps.map(s => [s.id, s]));
  const visitState = new Map<string, 0 | 1 | 2>(); // 0: unvisited, 1: visiting, 2: visited
  for (const step of plan.steps) {
    visitState.set(step.id, 0);
  }

  const cycleStepIds = new Set<string>();

  function checkCycle(stepId: string, path: string[]) {
    visitState.set(stepId, 1);
    const step = stepMap.get(stepId);
    for (const depId of step?.dependsOn ?? []) {
      if (!stepMap.has(depId)) {
        continue; // missing dependency reported separately
      }
      const st = visitState.get(depId) ?? 0;
      if (st === 1) {
        cycleStepIds.add(stepId);
        cycleStepIds.add(depId);
        const cycleStartIndex = path.indexOf(depId);
        if (cycleStartIndex >= 0) {
          for (let i = cycleStartIndex; i < path.length; i++) {
            cycleStepIds.add(path[i]);
          }
        }
      } else if (st === 0) {
        checkCycle(depId, [...path, depId]);
      }
    }
    visitState.set(stepId, 2);
  }

  for (const step of plan.steps) {
    if ((visitState.get(step.id) ?? 0) === 0) {
      checkCycle(step.id, [step.id]);
    }
  }

  for (const stepId of cycleStepIds) {
    errors.push({
      stepId,
      code: 'DEPENDENCY_CYCLE',
      message: `Dependency cycle detected involving step "${stepId}".`,
    });
  }

  // 4. Validate tools and inputs against registry
  if (toolRegistry) {
    for (const step of plan.steps) {
      const tool = toolRegistry.get(step.toolId);
      if (!tool) {
        errors.push({
          stepId: step.id,
          code: 'NONEXISTENT_TOOL',
          message: `Tool "${step.toolId}" does not exist in the tool registry.`,
        });
        continue;
      }

      if (!tool.available) {
        errors.push({
          stepId: step.id,
          code: 'UNAVAILABLE_TOOL',
          message: `Tool "${step.toolId}" is currently marked as unavailable.`,
        });
      }

      if (
        typeof step.input !== 'object' ||
        step.input === null ||
        Array.isArray(step.input)
      ) {
        errors.push({
          stepId: step.id,
          code: 'INVALID_INPUT',
          message: `Step "${step.id}" input must be an object.`,
        });
      } else {
        const requiredFields = tool.inputSchema?.required ?? [];
        const missing = requiredFields.filter(
          field =>
            step.input[field] === undefined ||
            step.input[field] === null ||
            step.input[field] === '',
        );

        if (missing.length > 0) {
          errors.push({
            stepId: step.id,
            code: 'MISSING_REQUIRED_INPUT',
            message: `Step "${step.id}" for tool "${tool.id}" is missing required input(s): ${missing.join(', ')}.`,
          });
        }

        const properties = tool.inputSchema?.properties ?? {};
        for (const [field, value] of Object.entries(step.input)) {
          const propDef = properties[field];
          if (propDef?.type && value !== undefined && value !== null) {
            if (propDef.type === 'number' && typeof value !== 'number') {
              errors.push({
                stepId: step.id,
                code: 'INVALID_INPUT',
                message: `Field "${field}" on step "${step.id}" expected number, got ${typeof value}.`,
              });
            } else if (
              propDef.type === 'boolean' &&
              typeof value !== 'boolean'
            ) {
              errors.push({
                stepId: step.id,
                code: 'INVALID_INPUT',
                message: `Field "${field}" on step "${step.id}" expected boolean, got ${typeof value}.`,
              });
            } else if (
              propDef.type === 'string' &&
              typeof value !== 'string'
            ) {
              errors.push({
                stepId: step.id,
                code: 'INVALID_INPUT',
                message: `Field "${field}" on step "${step.id}" expected string, got ${typeof value}.`,
              });
            }
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    reason:
      errors.length === 0
        ? 'Plan validation succeeded.'
        : `Plan validation failed with ${errors.length} error(s).`,
  };
}

/**
 * Sorts plan steps in topological order respecting dependencies.
 */
export function sortPlanSteps(steps: PlanStep[]): PlanStep[] {
  const stepMap = new Map<string, PlanStep>(steps.map(s => [s.id, s]));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const step of steps) {
    inDegree.set(step.id, 0);
    adj.set(step.id, []);
  }

  for (const step of steps) {
    for (const depId of step.dependsOn ?? []) {
      if (stepMap.has(depId)) {
        adj.get(depId)!.push(step.id);
        inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const step of steps) {
    if (inDegree.get(step.id) === 0) {
      queue.push(step.id);
    }
  }

  const sorted: PlanStep[] = [];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    sorted.push(stepMap.get(currentId)!);

    for (const nextId of adj.get(currentId) ?? []) {
      const remaining = (inDegree.get(nextId) ?? 1) - 1;
      inDegree.set(nextId, remaining);
      if (remaining === 0) {
        queue.push(nextId);
      }
    }
  }

  if (sorted.length < steps.length) {
    const added = new Set(sorted.map(s => s.id));
    for (const step of steps) {
      if (!added.has(step.id)) {
        sorted.push(step);
      }
    }
  }

  return sorted;
}

/**
 * Deterministic metadata-driven planner.
 *
 * Proposes execution plans without directly executing tools.
 */
export class KernelPlanner {
  private readonly toolRegistry?: ToolRegistry;
  private readonly capabilityResolver?: CapabilityResolver;
  private readonly taskBinder: TaskBinder;

  constructor(
    dependencies: PlannerDependencies | ToolDescriptor[] = {},
  ) {
    if (Array.isArray(dependencies)) {
      const registry = new ToolRegistry();
      registry.registerMany(dependencies);
      this.toolRegistry = registry;
      this.capabilityResolver = new CapabilityResolver({
        toolRegistry: registry,
      });
      this.taskBinder = new TaskBinder();
    } else {
      this.toolRegistry = dependencies.toolRegistry;
      this.capabilityResolver =
        dependencies.capabilityResolver ??
        (dependencies.toolRegistry
          ? new CapabilityResolver({
              toolRegistry: dependencies.toolRegistry,
            })
          : dependencies.tools
            ? new CapabilityResolver({
                toolRegistry: (() => {
                  const reg = new ToolRegistry();
                  reg.registerMany(dependencies.tools!);
                  return reg;
                })(),
              })
            : undefined);
      this.taskBinder =
        dependencies.taskBinder ?? new TaskBinder();
    }
  }

  plan(
    goal: string,
    availableTools?: ToolDescriptor[],
  ): ExecutionPlan {
    const normalizedGoal = goal.trim();
    if (!normalizedGoal) {
      return {
        id: createKernelId('plan'),
        goal,
        steps: [],
        successCriteria: [],
      };
    }

    let resolver = this.capabilityResolver;
    if (availableTools) {
      const reg = new ToolRegistry();
      reg.registerMany(availableTools);
      resolver = new CapabilityResolver({ toolRegistry: reg });
    }

    const resolution = resolver?.resolve(normalizedGoal);

    if (!resolution || !resolution.tool) {
      return {
        id: createKernelId('plan'),
        goal,
        steps: [],
        successCriteria: [],
      };
    }

    const binding = this.taskBinder.bind(
      normalizedGoal,
      resolution.tool,
    );

    const stepId = createKernelId('step');
    const step: PlanStep = {
      id: stepId,
      toolId: resolution.tool.id,
      input: binding.input,
      dependsOn: [],
      expectedOutcome:
        resolution.tool.description ||
        `Execute capability "${resolution.tool.id}"`,
    };

    return {
      id: createKernelId('plan'),
      goal,
      steps: [step],
      successCriteria: [
        `Capability "${resolution.tool.id}" executes successfully to satisfy "${goal}".`,
      ],
    };
  }

  planGoal(
    goal: string,
    availableTools?: ToolDescriptor[],
  ): ExecutionPlan {
    return this.plan(goal, availableTools);
  }

  validate(
    plan: ExecutionPlan,
    toolRegistry?: ToolRegistry,
  ): PlanValidationResult {
    return validatePlan(plan, toolRegistry ?? this.toolRegistry);
  }
}

export { KernelPlanner as Planner };
