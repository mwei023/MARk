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

import {
  ConfirmationManager,
  confirmationManager,
  ConfirmationRecord,
} from './confirmations';

import {
  TrustStore,
  trustStore,
} from './trust';

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
  confirmationManager?: ConfirmationManager;
  trustStore?: TrustStore;
}

export class KernelExecutor {
  private readonly implementations = new Map<
    string,
    ToolImplementation
  >();
  /**
   * Family implementations for descriptor-per-instance tools (e.g.
   * `desktop.open.<app>`). The descriptor catalog is discovered data that
   * can go stale; the family implementation re-resolves the instance at
   * execution time and fails loudly when it is gone.
   */
  private readonly familyImplementations: Array<{
    prefix: string;
    implementation: ToolImplementation;
  }> = [];
  private readonly confirmations: ConfirmationManager;
  private readonly trust: TrustStore;

  constructor(
    private readonly dependencies: ExecutorDependencies,
  ) {
    this.confirmations = dependencies.confirmationManager ?? confirmationManager;
    this.trust = dependencies.trustStore ?? trustStore;
  }

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
    return (
      this.implementations.has(toolId) ||
      this.familyImplementations.some(({ prefix }) => toolId.startsWith(prefix))
    );
  }

  /**
   * Registers one implementation for a whole family of discovered tool IDs.
   * The implementation derives the instance (app, container, ...) from the
   * action's tool ID and must re-resolve it live — never trust that the
   * discovered catalog is still current.
   */
  registerFamilyImplementation(prefix: string, implementation: ToolImplementation): void {
    this.familyImplementations.push({ prefix, implementation });
  }

  private findImplementation(toolId: string): ToolImplementation | undefined {
    const exact = this.implementations.get(toolId);
    if (exact) return exact;
    let best: ToolImplementation | undefined;
    let bestLength = -1;
    for (const { prefix, implementation } of this.familyImplementations) {
      if (toolId.startsWith(prefix) && prefix.length > bestLength) {
        best = implementation;
        bestLength = prefix.length;
      }
    }
    return best;
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
      if (authority.decision === 'require_confirmation') {
        // Persistent trust auto-approves here — deny levels below never do.
        const grant = this.trust.isTrusted(tool.id);
        if (grant) {
          const implementation = this.findImplementation(action.toolId);
          if (!implementation) {
            return this.finishFailure(
              action,
              `No implementation is registered for tool "${action.toolId}".`,
              startedAt,
              startedTime,
            );
          }
          return this.runImplementation(action, tool, implementation, context, startedAt, startedTime, {
            trusted: true,
            trustPattern: grant.pattern,
          });
        }
        const record = this.confirmations.request(
          action,
          `Tool "${tool.id}" (${tool.risk} risk) requires explicit confirmation: ${authority.reason}`,
        );
        return this.finishBlocked(
          action,
          `Confirmation required: ${authority.reason} Confirmation ID: ${record.id}.`,
          startedAt,
          startedTime,
          record,
        );
      }
      return this.finishFailure(
        action,
        this.describeAuthorityFailure(authority),
        startedAt,
        startedTime,
        'blocked',
      );
    }

    const implementation = this.findImplementation(action.toolId);

    if (!implementation) {
      return this.finishFailure(
        action,
        `No implementation is registered for tool "${action.toolId}".`,
        startedAt,
        startedTime,
      );
    }

    return this.runImplementation(action, tool, implementation, context, startedAt, startedTime);
  }

  /**
   * Resumes a blocked action after the caller resolved its confirmation.
   * The grant is bound to the exact tool + input snapshot: mismatched or
   * denied confirmations stay blocked.
   */
  async executeConfirmed(
    action: ActionRequest,
    context: ExecutionContext,
    confirmationId: string,
  ): Promise<ActionResult> {
    const startedAt = new Date().toISOString();
    const startedTime = Date.now();

    const tool = this.dependencies.toolRegistry.get(action.toolId);
    if (!tool) {
      return this.finishFailure(action, 'Tool does not exist in the registry.', startedAt, startedTime);
    }

    if (!this.confirmations.isApprovedFor(confirmationId, action)) {
      return this.finishFailure(
        action,
        `No approved confirmation "${confirmationId}" matches this exact action.`,
        startedAt,
        startedTime,
        'blocked',
      );
    }

    const implementation = this.findImplementation(action.toolId);
    if (!implementation) {
      return this.finishFailure(
        action,
        `No implementation is registered for tool "${action.toolId}".`,
        startedAt,
        startedTime,
      );
    }

    return this.runImplementation(action, tool, implementation, context, startedAt, startedTime, {
      confirmationId,
    });
  }

  /**
   * Shared implementation runner: executes, validates the output contract,
   * and records observations. Trusted auto-approvals are announced in the
   * observation stream so they stay auditable.
   */
  private async runImplementation(
    action: ActionRequest,
    tool: ToolDescriptor,
    implementation: ToolImplementation,
    context: ExecutionContext,
    startedAt: string,
    startedTime: number,
    metadataExtra?: { confirmationId?: string; trusted?: boolean; trustPattern?: string },
  ): Promise<ActionResult> {
    try {
      const execution = await implementation.execute({ action, tool, context });

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

      const observations = [...(execution.observations ?? [])];
      if (metadataExtra?.trusted) {
        observations.push({
          id: `observation-${Date.now()}`,
          kind: 'output',
          source: 'kernel.authority',
          subject: tool.id,
          summary: `Auto-approved by standing trust ("${metadataExtra.trustPattern}"); no confirmation was requested.`,
          data: { trustPattern: metadataExtra.trustPattern },
          confidence: 1,
          observedAt: new Date().toISOString(),
          relatedActionId: action.id,
          relatedResourceIds: [],
        });
      }

      const result: ActionResult = {
        actionId: action.id,
        status: 'succeeded',
        output: execution.output,
        observations,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedTime,
        metadata: { ...(execution.metadata ?? {}), ...(metadataExtra ?? {}) },
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
      return this.finishFailure(action, this.describeError(error), startedAt, startedTime);
    }
  }

  resolveConfirmation(confirmationId: string, approved: boolean): ConfirmationRecord | undefined {
    return this.confirmations.resolve(confirmationId, approved);
  }

  findConfirmation(reference: string): ConfirmationRecord | undefined {
    return this.confirmations.findByAction(reference);
  }

  searchPendingConfirmations(text: string): ConfirmationRecord[] {
    return this.confirmations.searchPending(text);
  }

  trustTool(pattern: string, grantedBy = 'user') {
    return this.trust.trust(pattern, grantedBy);
  }

  untrustTool(pattern: string): boolean {
    return this.trust.untrust(pattern);
  }

  listTrustedTools() {
    return this.trust.list();
  }

  listPendingConfirmations(): ConfirmationRecord[] {
    return this.confirmations.listPending();
  }

  private finishBlocked(
    action: ActionRequest,
    error: string,
    startedAt: string,
    startedTime: number,
    record: ConfirmationRecord,
  ): ActionResult {
    const result: ActionResult = {
      actionId: action.id,
      status: 'blocked',
      error,
      observations: [],
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedTime,
      metadata: { confirmationId: record.id, confirmationRequired: true, toolId: record.toolId },
    };

    const observation = observationFromActionResult(result);

    this.dependencies.observationStore.record({
      kind: observation.kind,
      source: observation.source,
      subject: observation.subject,
      summary: `Confirmation requested for tool "${record.toolId}": ${record.reason}`,
      data: { confirmationId: record.id, toolId: record.toolId },
      confidence: observation.confidence,
      relatedActionId: action.id,
      relatedResourceIds: observation.relatedResourceIds,
      metadata: observation.metadata,
    });

    return { ...result, observations: [observation] };
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
