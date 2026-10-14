import {
  ActionRequest,
  ActionResult,
  ExecutionContext,
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
    const actionResults: ActionResult[] = [];
    const completedSteps: string[] = [];
    const failedSteps: string[] = [];
    const observations = [];

    for (const step of input.workflow.steps) {
      if (!step.action) {
        failedSteps.push(step.id);

        const errorResult: ActionResult = {
          actionId: createKernelId('action'),
          status: 'failed',
          error: `Workflow step "${step.id}" does not contain an action.`,
          observations: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };

        actionResults.push(errorResult);

        const stepResult: WorkflowStepResult = {
          step,
          action: {
            id: errorResult.actionId,
            toolId: 'unknown',
            input: {},
            requestedBy: input.workflow.requestedBy,
            reason: `Invalid workflow step: ${step.id}`,
            createdAt: new Date().toISOString(),
          },
          result: errorResult,
        };

        stepResults.push(stepResult);

        if (!step.optional) {
          return {
            workflowId: input.workflow.id,
            status: 'failed',
            completedSteps,
            failedSteps,
            actionResults,
            observations,
            startedAt,
            completedAt: new Date().toISOString(),
            error: errorResult.error,
          };
        }

        continue;
      }

      const action: ActionRequest = {
        ...step.action,
        id: step.action.id || createKernelId('action'),
        workflowId: input.workflow.id,
        parentActionId:
          step.action.parentActionId ?? input.context.parentActionId,
        requestedBy:
          step.action.requestedBy || input.workflow.requestedBy,
        createdAt:
          step.action.createdAt || new Date().toISOString(),
        timeoutMs:
          step.timeoutMs ?? step.action.timeoutMs,
        metadata: {
          ...step.action.metadata,
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

      actionResults.push(result);
      observations.push(...result.observations);

      if (result.status === 'succeeded') {
        completedSteps.push(step.id);
      } else {
        failedSteps.push(step.id);
      }

      if (
        result.status !== 'succeeded' &&
        !step.optional
      ) {
        return {
          workflowId: input.workflow.id,
          status: result.status,
          completedSteps,
          failedSteps,
          actionResults,
          observations,
          startedAt,
          completedAt: new Date().toISOString(),
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
      status: failedStep
        ? failedStep.result.status
        : 'succeeded',
      completedSteps,
      failedSteps,
      actionResults,
      observations,
      startedAt,
      completedAt: new Date().toISOString(),
      summary: failedStep
        ? 'Workflow completed with one or more non-successful steps.'
        : 'Workflow completed successfully.',
    };
  }
}
