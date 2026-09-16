import {
  ActionRequest,
  ActionResult,
  ActionStatus,
  ExecutionContext,
  Observation,
  ToolDescriptor,
} from './types';

import { ToolRegistry } from './tool-registry';
import {
  AuthorityManager,
  AuthorityEvaluation,
} from './authority';

import {
  ObservationStore,
  observationFromActionResult,
} from './observations';

import { validateOutput } from './output-contracts';

export interface ToolExecutionInput {
  action: ActionRequest;
  tool: ToolDescriptor;
  context: ExecutionContext;
}

export interface ToolExecutionOutput {
  output?: unknown;
  observations?: Observation[];
  metadata?: Record<string, unknown>;
}

export interface ToolImplementation {
  toolId: string;
  execute(input: ToolExecutionInput): Promise<ToolExecutionOutput>;
}

export interface ExecutorDependencies {
  toolRegistry: ToolRegistry;
  authorityManager: AuthorityManager;
  observationStore: ObservationStore;
}

export class KernelExecutor {
  private readonly implementations = new Map<
    string,
    ToolImplementation
  >();

  constructor(
    private readonly dependencies: ExecutorDependencies,
  ) {}

  registerImplementation(implementation: ToolImplementation): void {
    this.implementations.set(
      implementation.toolId,
      implementation,
    );
  }

  unregisterImplementation(toolId: string): boolean {
    return this.implementations.delete(toolId);
  }

  hasImplementation(toolId: string): boolean {
    return this.implementations.has(toolId);
  }

  async execute(
    action: ActionRequest,
    context: ExecutionContext,
  ): Promise<ActionResult> {
    const startedAt = new Date().toISOString();
    const startedTime = Date.now();

    const tool = this.dependencies.toolRegistry.get(action.toolId);

    if (!tool) {
      return this.finishFailure(
        action,
        'Tool does not exist in the registry.',
        startedAt,
        startedTime,
      );
    }

    if (!tool.available) {
      return this.finishFailure(
        action,
        `Tool "${tool.id}" is currently unavailable.`,
        startedAt,
        startedTime,
      );
    }

    const authority = this.dependencies.authorityManager.evaluate(
      context.authorityProfile,
      action,
      tool,
    );

    if (authority.decision !== 'allow') {
      return this.finishFailure(
        action,
        this.describeAuthorityFailure(authority),
        startedAt,
        startedTime,
        authority.decision === 'require_confirmation'
          ? 'blocked'
          : 'blocked',
      );
    }

    const implementation = this.implementations.get(action.toolId);

    if (!implementation) {
      return this.finishFailure(
        action,
        `No implementation is registered for tool "${action.toolId}".`,
        startedAt,
        startedTime,
      );
    }

    try {
      const execution = await implementation.execute({
        action,
        tool,
        context,
      });

      if (tool.outputSchema) {
        const contract = validateOutput(execution.output, tool.outputSchema);
        if (!contract.valid) {
          return this.finishFailure(
            action,
            `Tool "${tool.id}" output failed contract validation: ${contract.errors.join(' ')}`,
            startedAt,
            startedTime,
          );
        }
      }

      const result: ActionResult = {
        actionId: action.id,
        status: 'succeeded',
        output: execution.output,
        observations: execution.observations ?? [],
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedTime,
        metadata: execution.metadata,
      };

      for (const observation of result.observations) {
        this.dependencies.observationStore.record({
          kind: observation.kind,
          source: observation.source,
          subject: observation.subject,
          summary: observation.summary,
          data: observation.data,
          confidence: observation.confidence,
          relatedActionId: observation.relatedActionId ?? action.id,
          relatedResourceIds: observation.relatedResourceIds,
          metadata: observation.metadata,
        });
      }

      return result;
    } catch (error) {
      return this.finishFailure(
        action,
        this.describeError(error),
        startedAt,
        startedTime,
      );
    }
  }

  private finishFailure(
    action: ActionRequest,
    error: string,
    startedAt: string,
    startedTime: number,
    status: ActionStatus = 'failed',
  ): ActionResult {
    const result: ActionResult = {
      actionId: action.id,
      status,
      error,
      observations: [],
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedTime,
    };

    const observation = observationFromActionResult(result);

    this.dependencies.observationStore.record({
      kind: observation.kind,
      source: observation.source,
      subject: observation.subject,
      summary: observation.summary,
      data: observation.data,
      confidence: observation.confidence,
      relatedActionId: observation.relatedActionId,
      relatedResourceIds: observation.relatedResourceIds,
      metadata: observation.metadata,
    });

    return {
      ...result,
      observations: [observation],
    };
  }

  private describeAuthorityFailure(
    evaluation: AuthorityEvaluation,
  ): string {
    if (evaluation.decision === 'require_confirmation') {
      return `Confirmation required: ${evaluation.reason}`;
    }

    return `Action denied: ${evaluation.reason}`;
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
