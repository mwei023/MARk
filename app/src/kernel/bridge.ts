import {
  ActionRequest,
  ActionResult,
  ExecutionContext,
  ToolDescriptor,
  WorkflowDefinition,
  WorkflowResult,
} from './types';

import {
  markKernel,
  MARKKernel,
} from './kernel';

import {
  registerNativeSystemProvider,
} from './providers/register-native';

import {
  CapabilityResolution,
} from './capability-resolver';

import {
  GoalExecutionResult,
} from './goal-execution';

import {
  ConfirmationRecord,
} from './confirmations';

import {
  ExecutionPlan,
  PlanExecutionReport,
  PlanExecutionResult,
  PlanValidationResult,
} from './planner';

import {
  confirmationManager,
} from './confirmations';

import { reliabilityTracker } from './reliability';
import { episodeMemory } from './episode-memory';
import { proposePlanWithLLM } from './llm-planner';


export interface KernelBridgeOptions {
  initializeNativeProviders?: boolean;
}

export interface KernelBridgeStatus {
  initialized: boolean;
  discoveredTools: string[];
  availableTools: string[];
}

export class MARKKernelBridge {
  private initialized = false;

  constructor(
    private readonly kernel: MARKKernel = markKernel,
  ) {}

  async initialize(
    options: KernelBridgeOptions = {},
  ): Promise<KernelBridgeStatus> {
    if (
      !this.initialized &&
      options.initializeNativeProviders !== false
    ) {
      registerNativeSystemProvider(this.kernel);
      await this.kernel.discover();
      this.initialized = true;
    }

    // Best-effort restore of persisted memory + approvals (never breaks startup).
    try {
      await this.kernel.workflowMemory.loadFromDatabase();
    } catch (err) {
      // Offline/tests: memory stays in-memory.
      console.debug('[kernel/bridge] workflowMemory.loadFromDatabase skipped:', err instanceof Error ? err.message : String(err));
    }
    try {
      await confirmationManager.loadFromDatabase();
    } catch (err) {
      // Offline/tests: approvals stay in-memory.
      console.debug('[kernel/bridge] confirmationManager.loadFromDatabase skipped:', err instanceof Error ? err.message : String(err));
    }
    try {
      await reliabilityTracker.loadFromDatabase();
    } catch (err) {
      // Offline/tests: reliability starts neutral.
      console.debug('[kernel/bridge] reliabilityTracker.loadFromDatabase skipped:', err instanceof Error ? err.message : String(err));
    }
    try {
      await episodeMemory.prune();
    } catch (err) {
      // Best effort — prune failure is non-critical.
      console.debug('[kernel/bridge] episodeMemory.prune skipped:', err instanceof Error ? err.message : String(err));
    }

    return this.status();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  status(): KernelBridgeStatus {
    return {
      initialized: this.initialized,
      discoveredTools: this.kernel
        .listTools()
        .map(tool => tool.id),
      availableTools: this.kernel
        .listAvailableTools()
        .map(tool => tool.id),
    };
  }

  resolveCapability(goal: string): CapabilityResolution {
  return this.kernel.resolveCapability(goal);
}

  listTools(): ToolDescriptor[] {
    return this.kernel.listTools();
  }

  createContext(
    input: Parameters<MARKKernel['createContext']>[0],
  ): ExecutionContext {
    return this.kernel.createContext(input);
  }

  async execute(
    action: ActionRequest,
    context: ExecutionContext,
  ): Promise<ActionResult> {
    return this.kernel.execute(action, context);
  }

  resolveConfirmation(confirmationId: string, approved: boolean) {
    return this.kernel.resolveConfirmation(confirmationId, approved);
  }

  findConfirmation(reference: string) {
    return this.kernel.findConfirmation(reference);
  }

  searchPendingConfirmations(text: string) {
    return this.kernel.searchPendingConfirmations(text);
  }

  trustTool(pattern: string, grantedBy = 'user', scopePath?: string) {
    return this.kernel.trustTool(pattern, grantedBy, scopePath);
  }

  untrustTool(pattern: string) {
    return this.kernel.untrustTool(pattern);
  }

  listTrustedTools() {
    return this.kernel.listTrustedTools();
  }

  suggestTrust() {
    return this.kernel.suggestTrust();
  }

  listPendingConfirmations() {
    return this.kernel.listPendingConfirmations();
  }

  async executeConfirmed(
    action: ActionRequest,
    context: ExecutionContext,
    confirmationId: string,
  ): Promise<ActionResult> {
    return this.kernel.executeConfirmed(action, context, confirmationId);
  }

  /**
   * Approve a pending confirmation AND resume the blocked action in one
   * step. Approving alone leaves the action blocked forever (the user
   * retries, gets a new id, approves again...). Returns the record plus
   * the resumed result, or undefined when there is nothing to resume.
   */
  async approveAndResume(
    confirmationId: string,
    userId: string,
  ): Promise<{ record: ConfirmationRecord; result: ActionResult } | undefined> {
    const record = this.kernel.resolveConfirmation(confirmationId, true);
    if (!record) return undefined;
    const action: ActionRequest = {
      id: record.actionId,
      toolId: record.toolId,
      input: { ...record.input },
      requestedBy: record.requestedBy || userId,
      createdAt: record.createdAt,
      metadata: { source: 'approve-and-resume', confirmationId: record.id },
    };
    const context = this.createContext({
      userId,
      source: 'cli',
      ...(record.scopePath ? { workingDirectory: record.scopePath } : {}),
    });
    const result = await this.kernel.executeConfirmed(action, context, record.id);
    return { record, result };
  }

  async executeTool(
    toolId: string,
    input: Record<string, unknown>,
    contextInput: Parameters<MARKKernel['createContext']>[0],
  ): Promise<ActionResult> {
    const context = this.createContext(contextInput);
    const action: ActionRequest = {
      id: `ACT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      toolId,
      input,
      requestedBy: context.userId,
      createdAt: new Date().toISOString(),
      metadata: {
        source: 'mark-runtime',
      },
    };

    return this.execute(action, context);
  }

  async executeWorkflow(
    workflow: WorkflowDefinition,
    context: ExecutionContext,
  ): Promise<WorkflowResult> {
    return this.kernel.executeWorkflow(workflow, context);
  }

  async executeGoal(
    goal: string,
    contextInput: Parameters<MARKKernel['createContext']>[0],
    options?: import('./goal-execution').GoalExecutionOptions,
  ): Promise<GoalExecutionResult> {
    const context = this.createContext(contextInput);

    return this.kernel.executeGoal(goal, context, options);
  }

  planGoal(goal: string): ExecutionPlan {
    return this.kernel.planGoal(goal);
  }

  /**
   * Smart planning: metadata planning first (fast, offline); when it yields
   * nothing usable and smart mode is on, one LLM proposal round guarded by
   * the kernel's own plan validator. Returns the plan with its source, or
   * undefined when neither path produces anything.
   */
  async planGoalSmart(goal: string): Promise<{ plan: ExecutionPlan; source: 'metadata' | 'llm' } | undefined> {
    const meta = this.planGoal(goal);
    const metaValidation = this.validatePlan(meta);
    if (metaValidation.valid && meta.steps.length > 0) {
      return { plan: meta, source: 'metadata' };
    }
    if (process.env.MARK_SMART === 'off') return undefined;
    const proposed = await proposePlanWithLLM(goal, this.listTools(), plan => this.validatePlan(plan));
    if (!proposed) return undefined;
    return { plan: proposed.plan, source: 'llm' };
  }

  validatePlan(plan: ExecutionPlan): PlanValidationResult {
    return this.kernel.validatePlan(plan);
  }

  saveWorkflow(plan: ExecutionPlan) {
    return this.kernel.saveWorkflow(plan);
  }

  recallWorkflows(goal: string, limit?: number, minScore?: number) {
    return this.kernel.recallWorkflows(goal, limit, minScore);
  }

  reuseWorkflow(goal: string) {
    return this.kernel.reuseWorkflow(goal);
  }

  recordWorkflowOutcome(workflowId: string, succeeded: boolean) {
    return this.kernel.recordWorkflowOutcome(workflowId, succeeded);
  }

  async executePlan(
    plan: ExecutionPlan,
    contextInput: Parameters<MARKKernel['createContext']>[0],
  ): Promise<PlanExecutionResult> {
    const context = this.createContext(contextInput);

    return this.kernel.executePlan(plan, context);
  }

  /**
   * Executes a plan with structured data flow between steps and returns the
   * full structured report, including skipped steps and final outputs.
   */
  async executePlanWithReport(
    plan: ExecutionPlan,
    contextInput: Parameters<MARKKernel['createContext']>[0],
  ): Promise<PlanExecutionReport> {
    const context = this.createContext(contextInput);

    return this.kernel.executePlanWithReport(plan, context);
  }
}

export const markKernelBridge = new MARKKernelBridge();
