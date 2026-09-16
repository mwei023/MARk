import {
  ActionRequest,
  ActionResult,
  ExecutionContext,
  ToolDescriptor,
  WorkflowDefinition,
  WorkflowResult,
} from './types';

import {
  CapabilityResolver,
  CapabilityResolution,
} from './capability-resolver';

import { ToolRegistry, toolRegistry } from './tool-registry';

import {
  ToolDiscovery,
  toolDiscovery,
  DiscoveryResult,
} from './tool-discovery';

import {
  AuthorityManager,
  authorityManager,
} from './authority';

import {
  ObservationStore,
  observationStore,
} from './observations';

import {
  KernelExecutor,
  ToolImplementation,
} from './executor';

import {
  WorkflowEngine,
  WorkflowExecutionInput,
} from './workflow';

import {
  createExecutionContext,
  CreateExecutionContextInput,
} from './execution-context';

import {
  TaskBinder,
  TaskBinding,
} from './task-binder';

import {
  LearnedWorkflow,
  ReusedPlan,
  WorkflowMemory,
  workflowMemory,
} from './workflow-memory';

import {
  TrustStore,
} from './trust';

import {
  GoalExecutionOptions,
  GoalExecutionResult,
  GoalExecutor,
} from './goal-execution';

import {
  ExecutionPlan,
  KernelPlanner,
  PlanExecutionReport,
  PlanExecutionResult,
  PlanValidationResult,
} from './planner';

import {
  executeStructuredPlan,
  toPlanExecutionResult,
} from './plan-execution';

export interface KernelDependencies {
  toolRegistry?: ToolRegistry;
  toolDiscovery?: ToolDiscovery;
  authorityManager?: AuthorityManager;
  observationStore?: ObservationStore;
  trustStore?: TrustStore;
}

export interface KernelDiscoverySummary {
  results: DiscoveryResult[];
  registeredTools: ToolDescriptor[];
}

export class MARKKernel {
  readonly toolRegistry: ToolRegistry;
  readonly toolDiscovery: ToolDiscovery;
  readonly authorityManager: AuthorityManager;
  readonly observationStore: ObservationStore;
  readonly executor: KernelExecutor;
  readonly workflows: WorkflowEngine;
  readonly capabilityResolver: CapabilityResolver;
  readonly taskBinder: TaskBinder;
  readonly planner: KernelPlanner;
  readonly goalExecutor: GoalExecutor;
  readonly workflowMemory: WorkflowMemory;

  constructor(
    dependencies: KernelDependencies = {},
  ) {
    this.toolRegistry =
      dependencies.toolRegistry ?? toolRegistry;

    this.toolDiscovery =
      dependencies.toolDiscovery ?? toolDiscovery;

    this.authorityManager =
      dependencies.authorityManager ?? authorityManager;

    this.observationStore =
      dependencies.observationStore ?? observationStore;

    this.executor = new KernelExecutor({
      toolRegistry: this.toolRegistry,
      authorityManager: this.authorityManager,
      observationStore: this.observationStore,
      ...(dependencies.trustStore ? { trustStore: dependencies.trustStore } : {}),
    });

    this.workflows = new WorkflowEngine(this.executor);

    this.capabilityResolver = new CapabilityResolver({
      toolRegistry: this.toolRegistry,
    });

    this.taskBinder = new TaskBinder();

    this.planner = new KernelPlanner({
      toolRegistry: this.toolRegistry,
      capabilityResolver: this.capabilityResolver,
      taskBinder: this.taskBinder,
    });

    this.goalExecutor = new GoalExecutor({
      resolveCapability: goal =>
        this.capabilityResolver.resolve(goal),

      bindTask: (goal, tool) =>
        this.taskBinder.bind(goal, tool),

      execute: (action, context) =>
        this.executor.execute(action, context),

      planGoal: goal =>
        this.planner.plan(goal),

      validatePlan: plan =>
        this.planner.validate(plan, this.toolRegistry),
    });

    this.workflowMemory = workflowMemory;
  }

  registerTool(tool: ToolDescriptor): void {
    this.toolRegistry.register(tool);
  }

  registerTools(tools: ToolDescriptor[]): void {
    this.toolRegistry.registerMany(tools);
  }

  registerImplementation(
    implementation: ToolImplementation,
  ): void {
    this.executor.registerImplementation(implementation);
  }

  resolveCapability(
    goal: string,
  ): CapabilityResolution {
    return this.capabilityResolver.resolve(goal);
  }

  bindTask(
    goal: string,
    tool: ToolDescriptor,
  ): TaskBinding {
    return this.taskBinder.bind(goal, tool);
  }

  unregisterImplementation(toolId: string): boolean {
    return this.executor.unregisterImplementation(toolId);
  }

  createContext(
    input: CreateExecutionContextInput,
  ): ExecutionContext {
    return createExecutionContext(input);
  }

  async execute(
    action: ActionRequest,
    context: ExecutionContext,
  ): Promise<ActionResult> {
    return this.executor.execute(action, context);
  }

  resolveConfirmation(confirmationId: string, approved: boolean) {
    return this.executor.resolveConfirmation(confirmationId, approved);
  }

  findConfirmation(reference: string) {
    return this.executor.findConfirmation(reference);
  }

  searchPendingConfirmations(text: string) {
    return this.executor.searchPendingConfirmations(text);
  }

  trustTool(pattern: string, grantedBy = 'user') {
    return this.executor.trustTool(pattern, grantedBy);
  }

  untrustTool(pattern: string) {
    return this.executor.untrustTool(pattern);
  }

  listTrustedTools() {
    return this.executor.listTrustedTools();
  }

  listPendingConfirmations() {
    return this.executor.listPendingConfirmations();
  }

  async executeConfirmed(
    action: ActionRequest,
    context: ExecutionContext,
    confirmationId: string,
  ): Promise<ActionResult> {
    return this.executor.executeConfirmed(action, context, confirmationId);
  }

  async executeWorkflow(
    workflow: WorkflowDefinition,
    context: ExecutionContext,
  ): Promise<WorkflowResult> {
    const input: WorkflowExecutionInput = {
      workflow,
      context,
    };

    return this.workflows.execute(input);
  }

  async discover(): Promise<KernelDiscoverySummary> {
    const results = await this.toolDiscovery.discoverAll();

    const discoveredTools = results.flatMap(
      result => result.tools,
    );

    this.toolRegistry.registerMany(discoveredTools);

    return {
      results,
      registeredTools: discoveredTools,
    };
  }

  listTools(): ToolDescriptor[] {
    return this.toolRegistry.list();
  }

  listAvailableTools(): ToolDescriptor[] {
    return this.toolRegistry.listAvailable();
  }

  planGoal(
    goal: string,
  ): ExecutionPlan {
    return this.planner.plan(goal);
  }

  validatePlan(
    plan: ExecutionPlan,
  ): PlanValidationResult {
    return this.planner.validate(plan, this.toolRegistry);
  }

  saveWorkflow(plan: ExecutionPlan): LearnedWorkflow {
    return this.workflowMemory.save(plan);
  }

  recallWorkflows(goal: string, limit?: number): LearnedWorkflow[] {
    return this.workflowMemory.recall(goal, limit);
  }

  reuseWorkflow(goal: string): ReusedPlan | undefined {
    return this.workflowMemory.reuse(goal);
  }

  recordWorkflowOutcome(workflowId: string, succeeded: boolean): void {
    this.workflowMemory.recordOutcome(workflowId, succeeded);
  }

  async executePlan(
    plan: ExecutionPlan,
    context: ExecutionContext,
  ): Promise<PlanExecutionResult> {
    const validation = this.validatePlan(plan);

    if (!validation.valid) {
      return {
        planId: plan.id,
        goal: plan.goal,
        status: 'failed',
        validation,
        stepResults: [],
        observations: [],
        error: `Plan validation failed: ${validation.errors.map(e => e.message).join('; ')}`,
      };
    }

    const report = await executeStructuredPlan({
      plan,
      context,
      validation,
      executeStep: (action, executionContext) =>
        this.executor.execute(action, executionContext),
    });

    return toPlanExecutionResult(report);
  }

  /**
   * Executes a plan with structured data flow between steps and returns the
   * full structured report, including skipped steps and final outputs.
   */
  async executePlanWithReport(
    plan: ExecutionPlan,
    context: ExecutionContext,
  ): Promise<PlanExecutionReport> {
    return executeStructuredPlan({
      plan,
      context,
      validation: this.validatePlan(plan),
      executeStep: (action, executionContext) =>
        this.executor.execute(action, executionContext),
    });
  }

  async executeGoal(
    goal: string,
    context: ExecutionContext,
    options?: GoalExecutionOptions,
  ): Promise<GoalExecutionResult> {
    return this.goalExecutor.executeGoal(
      goal,
      context,
      options,
    );
  }
}

export const markKernel = new MARKKernel();