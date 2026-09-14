import {
  ActionRequest,
  ActionResult,
  ExecutionContext,
} from './types';
import {
  CapabilityResolution,
} from './capability-resolver';

export interface GoalExecutionResult {
  goal: string;
  resolution: CapabilityResolution;
  action?: ActionRequest;
  result?: ActionResult;
}

export interface GoalExecutionDependencies {
  resolveCapability: (goal: string) => CapabilityResolution;
  execute: (
    action: ActionRequest,
    context: ExecutionContext,
  ) => Promise<ActionResult>;
}

/**
 * Generic goal-to-capability execution.
 *
 * This layer deliberately knows nothing about individual tools.
 * It resolves a goal using discovered capability metadata and,
 * when a viable capability exists, executes it through the kernel.
 */
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

    const action: ActionRequest = {
      id: `ACT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      toolId: resolution.tool.id,
      input: {},
      requestedBy: context.userId,
      createdAt: new Date().toISOString(),
      metadata: {
        source: 'goal-execution',
        goal,
        resolutionScore: resolution.score,
        matchedTerms: resolution.matchedTerms,
      },
    };

    const result = await this.dependencies.execute(action, context);

    return {
      goal,
      resolution,
      action,
      result,
    };
  }
}
