import {
  ActionRequest,
  ActionResult,
  ExecutionContext,
  ToolDescriptor,
} from './types';

import {
  CapabilityResolution,
} from './capability-resolver';

import {
  TaskBinder,
  TaskBinding,
} from './task-binder';

import {
  ExecutionPlan,
  PlanValidationResult,
} from './planner';

export interface GoalExecutionOptions {
  usePlanner?: boolean;
}

export interface GoalExecutionResult {
  goal: string;
  resolution: CapabilityResolution;
  binding?: TaskBinding;
  plan?: ExecutionPlan;
  validation?: PlanValidationResult;
  action?: ActionRequest;
  result?: ActionResult;
}

export interface GoalExecutionDependencies {
  resolveCapability: (goal: string) => CapabilityResolution;
  bindTask: (
    goal: string,
    tool: ToolDescriptor,
  ) => TaskBinding;
  execute: (
    action: ActionRequest,
    context: ExecutionContext,
  ) => Promise<ActionResult>;
  planGoal?: (goal: string) => ExecutionPlan;
  validatePlan?: (plan: ExecutionPlan) => PlanValidationResult;
}

export class GoalExecutor {
  constructor(
    private readonly dependencies: GoalExecutionDependencies,
  ) {}

  async executeGoal(
    goal: string,
    context: ExecutionContext,
    options: GoalExecutionOptions = {},
  ): Promise<GoalExecutionResult> {
    const plan = this.dependencies.planGoal
      ? this.dependencies.planGoal(goal)
      : undefined;

    const validation =
      plan && this.dependencies.validatePlan
        ? this.dependencies.validatePlan(plan)
        : undefined;

    const resolution = this.dependencies.resolveCapability(goal);

    if (!resolution.tool) {
      return {
        goal,
        resolution,
        plan,
        validation,
      };
    }

    const binding = this.dependencies.bindTask(
      goal,
      resolution.tool,
    );

    if (!binding.complete) {
      return {
        goal,
        resolution,
        binding,
        plan,
        validation,
      };
    }

    const action: ActionRequest = {
      id: `ACT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      toolId: resolution.tool.id,
      input: binding.input,
      requestedBy: context.userId,
      createdAt: new Date().toISOString(),
      metadata: {
        source: 'goal-execution',
        goal,
        resolutionScore: resolution.score,
        matchedTerms: resolution.matchedTerms,
        matchedInputFields: binding.matchedFields,
        ...(plan ? { planId: plan.id } : {}),
      },
    };

    const result = await this.dependencies.execute(
      action,
      context,
    );

    return {
      goal,
      resolution,
      binding,
      plan,
      validation,
      action,
      result,
    };
  }
}