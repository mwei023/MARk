import {
  ActionRequest,
  ActionResult,
  ExecutionContext,
  KernelId,
  WorkflowDefinition,
  WorkflowResult,
  WorkflowStep,
} from './types';

import { KernelExecutor } from './executor';
import { createKernelId } from './execution-context';

export interface WorkflowExecutionInput {
  workflow: WorkflowDefinition;
  context: ExecutionContext;
}

export interface WorkflowStepResult {
  step: WorkflowStep;
  action: ActionRequest;
  result: ActionResult;
}

export class WorkflowEngine {
  constructor(
    private readonly executor: KernelExecutor,
  ) {}

  async execute(
    input: WorkflowExecutionInput,
  ): Promise<WorkflowResult> {
    const startedAt = new Date().toISOString();
    const startedTime = Date.now();
    const stepResults: WorkflowStepResult[] = [];

    for (const step of input.workflow.steps) {
      const action: ActionRequest = {
        id: createKernelId('action'),
        toolId: step.toolId,
        input: step.input,
        requestedBy: input.context.sessionId,
        reason: step.description,
        createdAt: new Date().toISOString(),
        metadata: {
          workflowId: input.workflow.id,
          stepId: step.id,
        },
      };

      const result = await this.executor.execute(
        action,
        input.context,
      );

      stepResults.push({
        step,
        action,
        result,
      });

      if (
        result.status !== 'succeeded' &&
        step.continueOnFailure !== true
      ) {
        return {
          workflowId: input.workflow.id,
          status: result.status,
          stepResults,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startedTime,
          error: `Workflow stopped at step "${step.id}": ${
            result.error ?? result.status
          }`,
        };
      }
    }

    const failedStep = stepResults.find(
      stepResult => stepResult.result.status !== 'succeeded',
    );

    return {
      workflowId: input.workflow.id,
      status: failedStep ? failedStep.result.status : 'succeeded',
      stepResults,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedTime,
      error: failedStep
        ? `Workflow completed with a non-successful step: ${
            failedStep.step.id
          }`
        : undefined,
    };
  }
}
