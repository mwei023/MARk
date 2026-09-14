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

export interface GoalExecutionResult {
  goal: string;
  resolution: CapabilityResolution;
  binding?: TaskBinding;
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
}

export class GoalExecutor {
  constructor(
    private readonly dependencies: GoalExecutionDependencies,
  ) {}

  async executeGoal(
    goal: string,
    context: ExecutionContext,
  ): Promise<GoalExecutionResult> {
    const resolution = this.dependencies.resolveCapability(goal);

    if (!resolution.tool) {
      return {
        goal,
        resolution,
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
      action,
      result,
    };
  }
}