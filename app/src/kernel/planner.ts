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

import {
  collectStepReferences,
  isStepReference,
  parseStepReference,
} from './step-references';

import { resolveSchemaPath, scoreCompatibility, listSchemaLeafPaths } from './compatibility';

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
  explanation?: string;
}

export type PlanValidationErrorCode =
  | 'NONEXISTENT_TOOL'
  | 'UNAVAILABLE_TOOL'
  | 'DUPLICATE_STEP_ID'
  | 'MISSING_DEPENDENCY'
  | 'DEPENDENCY_CYCLE'
  | 'MISSING_REQUIRED_INPUT'
  | 'INVALID_INPUT'
  | 'UNDECLARED_OUTPUT_PATH';

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

/**
 * Execution status of an individual plan step.
 *
 * `skipped` marks steps that never ran because a required dependency did not
 * succeed. All statuses are plan-level concepts, distinct from ActionStatus,
 * which describes a single action execution.
 */
export type PlanStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped';

/**
 * Stored result of one plan step.
 *
 * `resolvedInput` is the input after step-output references were resolved
 * immediately before execution. `output` carries the successful tool output;
 * `result` preserves the full ActionResult from the executor for tools that
 * produce no dedicated output.
 */
export interface PlanStepResult {
  stepId: KernelId;
  toolId: KernelId;
  status: PlanStepStatus;
  input: Record<string, unknown>;
  resolvedInput?: Record<string, unknown>;
  action?: ActionRequest;
  output?: unknown;
  result?: ActionResult;
  observations: Observation[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

/** Overall status of a plan execution. */
export type PlanExecutionStatus = 'succeeded' | 'failed' | 'partial';

/**
 * Structured report for a complete plan execution.
 *
 * `steps` preserves the plan's declared step order so callers can read the
 * report back in the order the plan author wrote, including steps that were
 * skipped; `stepResults` remains in execution order for compatibility.
 */
export interface PlanExecutionReport {
  planId: KernelId;
  goal: string;
  status: PlanExecutionStatus;
  startedAt?: string;
  completedAt?: string;
  steps: PlanStepResult[];
  finalOutputs: Record<string, unknown>;
  observations: Observation[];
  validation?: PlanValidationResult;
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
          // Inputs that are step-output references are computed at execution
          // time, so they cannot be checked against the tool schema here.
          const providesReference = (
            field: string,
          ): boolean =>
            isStepReference(step.input[field]) ||
            collectStepReferences(step.input[field]).length > 0;

          const unresolved = missing.filter(
            field => !providesReference(field),
          );

          if (unresolved.length > 0) {
            errors.push({
              stepId: step.id,
              code: 'MISSING_REQUIRED_INPUT',
              message: `Step "${step.id}" for tool "${tool.id}" is missing required input(s): ${unresolved.join(', ')}.`,
            });
          }
        }

        // A required input that is provided by a step-output reference is
        // unknown at validation time, so type checks only apply to static
        // values.
        const properties = tool.inputSchema?.properties ?? {};
        for (const [field, value] of Object.entries(step.input)) {
          if (isStepReference(value) || collectStepReferences(value).length > 0) {
            continue;
          }
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

    // 5. Validate step-output references against producer output contracts.
    // Refs are resolved at execution time, but the referenced path should be
    // declared in the producer's outputSchema when one exists. Tools without
    // a schema get a warning, not an error, for backward compatibility.
    for (const step of plan.steps) {
      const references = collectStepReferences(step.input);
      for (const reference of references) {
        const target = parseStepReference(reference);
        if (!target) {
          errors.push({
            stepId: step.id,
            code: 'INVALID_INPUT',
            message: `Step "${step.id}" contains malformed step reference "${reference}".`,
          });
          continue;
        }

        if (target.stepId === step.id) {
          errors.push({
            stepId: step.id,
            code: 'DEPENDENCY_CYCLE',
            message: `Step "${step.id}" references its own output ("${reference}").`,
          });
          continue;
        }

        const producerStep = stepMap.get(target.stepId);
        if (!producerStep) {
          errors.push({
            stepId: step.id,
            code: 'MISSING_DEPENDENCY',
            message: `Step "${step.id}" references unknown step "${target.stepId}" ("${reference}").`,
          });
          continue;
        }

        if (!(step.dependsOn ?? []).includes(target.stepId)) {
          warnings.push(
            `Step "${step.id}" references "${target.stepId}" but does not list it in dependsOn.`,
          );
        }

        const producerTool = toolRegistry.get(producerStep.toolId);
        if (!producerTool) continue; // NONEXISTENT_TOOL already reported

        const head = target.path[0];
        if (target.path.length === 0) continue; // whole-output ref: always allowed
        if (head === 'result' || head === 'resolvedInput') continue; // runtime-only roots

        const effectivePath =
          head === 'output' ? target.path.slice(1) : target.path;
        if (effectivePath.length === 0) continue;

        if (!producerTool.outputSchema) {
          warnings.push(
            `Step "${step.id}" references "${reference}" but tool "${producerTool.id}" declares no outputSchema; path cannot be verified.`,
          );
          continue;
        }

        if (!resolveSchemaPath(producerTool.outputSchema, effectivePath)) {
          errors.push({
            stepId: step.id,
            code: 'UNDECLARED_OUTPUT_PATH',
            message: `Step "${step.id}" references "${reference}" but tool "${producerTool.id}" does not declare output path "${effectivePath.join('.')}".`,
          });
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

  /**
   * Assisted workflow composition: proposes a 2-step plan where the
   * consumer's input is fed by the producer's declared output.
   *
   * Connections are derived only from declared input/output schemas and
   * type compatibility — never from hardcoded knowledge of individual
   * tools. Returns a single-step plan (via plan()) when no compatible
   * chain scores highly enough, so callers always get something usable.
   */
  planComposed(
    goal: string,
    availableTools?: ToolDescriptor[],
  ): ExecutionPlan {
    const normalizedGoal = goal.trim();
    if (!normalizedGoal) {
      return { id: createKernelId('plan'), goal, steps: [], successCriteria: [] };
    }

    let registry = this.toolRegistry;
    if (availableTools) {
      const reg = new ToolRegistry();
      reg.registerMany(availableTools);
      registry = reg;
    }
    if (!registry) return this.plan(goal, availableTools);

    const resolver = new CapabilityResolver({ toolRegistry: registry });
    const ranked = resolver.resolveAll(normalizedGoal).slice(0, 4);
    if (ranked.length < 2) return this.plan(goal, availableTools);

    let best: {
      producer: ToolDescriptor;
      consumer: ToolDescriptor;
      field: string;
      producerPath: string[];
      compatScore: number;
      total: number;
    } | null = null;

    for (const consumer of ranked) {
      const consumerProps = consumer.tool.inputSchema?.properties ?? {};
      const consumerFields = Object.keys(consumerProps);
      if (consumerFields.length === 0) continue;

      for (const producer of ranked) {
        if (producer.tool.id === consumer.tool.id) continue;
        const leaves = listSchemaLeafPaths(producer.tool.outputSchema);
        if (leaves.length === 0) continue;

        for (const field of consumerFields) {
          const consumerFieldSchema = consumerProps[field];
          for (const leaf of leaves) {
            const compat = scoreCompatibility(leaf.schema, consumerFieldSchema);
            if (!compat.compatible || compat.score < 0.5) continue;
            const total = consumer.score + producer.score + compat.score;
            if (!best || total > best.total) {
              best = {
                producer: producer.tool,
                consumer: consumer.tool,
                field,
                producerPath: leaf.path,
                compatScore: compat.score,
                total,
              };
            }
          }
        }
      }
    }

    if (!best) return this.plan(goal, availableTools);

    const producerBinding = this.taskBinder.bind(normalizedGoal, best.producer);
    const consumerBinding = this.taskBinder.bind(normalizedGoal, best.consumer);

    // Producer must be executable on its own (our native tools take no
    // required inputs, so this holds; the check keeps the method honest
    // as new tools with required inputs arrive).
    if (producerBinding.missingRequired.length > 0) return this.plan(goal, availableTools);

    // Goal-bound values beat composed references: when the goal already
    // states the consumer's required inputs (e.g. an explicit url), chaining
    // a producer in front only adds failure modes. Observed live: "open
    // browser with url: http://localhost:..." composed search→open and fed
    // open the search QUERY string as its url (string→string is compatible
    // but semantically wrong). Fully-bound consumers run single-step.
    if (consumerBinding.missingRequired.length === 0 && consumerBinding.matchedFields.length > 0) {
      const direct: ExecutionPlan = {
        id: createKernelId('plan'),
        goal,
        steps: [
          {
            id: createKernelId('step'),
            toolId: best.consumer.id,
            input: consumerBinding.input,
            dependsOn: [],
            expectedOutcome: best.consumer.description || `Execute "${best.consumer.id}"`,
          },
        ],
        successCriteria: [`Capability "${best.consumer.id}" executes successfully to satisfy "${goal}".`],
      };
      if (validatePlan(direct, registry).valid) return direct;
      // Fell through: direct plan invalid, try reference composition below.
    }

    const producerStepId = createKernelId('step');
    const consumerStepId = createKernelId('step');
    const reference = `$steps.${producerStepId}.output.${best.producerPath.join('.')}`;

    // References only fill fields the goal left empty — never overwrite
    // values bound from the goal itself (see above).
    const consumerInput: Record<string, unknown> = {
      ...consumerBinding.input,
    };
    if (!consumerBinding.matchedFields.includes(best.field)) {
      consumerInput[best.field] = reference;
    }

    const candidate: ExecutionPlan = {
      id: createKernelId('plan'),
      goal,
      steps: [
        {
          id: producerStepId,
          toolId: best.producer.id,
          input: producerBinding.input,
          dependsOn: [],
          expectedOutcome: best.producer.description || `Execute "${best.producer.id}"`,
        },
        {
          id: consumerStepId,
          toolId: best.consumer.id,
          input: consumerInput,
          dependsOn: [producerStepId],
          expectedOutcome: best.consumer.description || `Execute "${best.consumer.id}"`,
        },
      ],
      successCriteria: [
        `Capability "${best.producer.id}" executes successfully.`,
        `Capability "${best.consumer.id}" executes successfully using the producer output to satisfy "${goal}".`,
      ],
      explanation:
        `Producer "${best.producer.id}" outputs "${best.producerPath.join('.')}" ` +
        `which is type-compatible with consumer "${best.consumer.id}" input "${best.field}" ` +
        `(compatibility ${best.compatScore}). Connected as ${reference}.`,
    };

    const validation = validatePlan(candidate, registry);
    if (!validation.valid) return this.plan(goal, availableTools);

    return candidate;
  }

  validate(
    plan: ExecutionPlan,
    toolRegistry?: ToolRegistry,
  ): PlanValidationResult {
    return validatePlan(plan, toolRegistry ?? this.toolRegistry);
  }
}

export { KernelPlanner as Planner };
