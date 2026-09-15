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
  GoalExecutionOptions,
  GoalExecutionResult,
  GoalExecutor,
} from './goal-execution';

import {
  ExecutionPlan,
  KernelPlanner,
  PlanExecutionResult,
  PlanValidationResult,
  sortPlanSteps,
} from './planner';

export interface KernelDependencies {
  toolRegistry?: ToolRegistry;
  toolDiscovery?: ToolDiscovery;
  authorityManager?: AuthorityManager;
  observationStore?: ObservationStore;
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

    const orderedSteps = sortPlanSteps(plan.steps);
    const stepResults: PlanExecutionResult['stepResults'] = [];
    const observations = [];

    for (const step of orderedSteps) {
      const action: ActionRequest = {
        id: `ACT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        toolId: step.toolId,
        input: step.input,
        requestedBy: context.userId,
        createdAt: new Date().toISOString(),
        metadata: {
          source: 'plan-execution',
          planId: plan.id,
          stepId: step.id,
        },
      };

      const result = await this.executor.execute(action, context);

      stepResults.push({
        stepId: step.id,
        toolId: step.toolId,
        action,
        result,
      });

      observations.push(...result.observations);

      if (result.status !== 'succeeded') {
        return {
          planId: plan.id,
          goal: plan.goal,
          status: result.status,
          validation,
          stepResults,
          observations,
          error: `Plan execution failed at step "${step.id}": ${result.error ?? result.status}`,
        };
      }
    }

    return {
      planId: plan.id,
      goal: plan.goal,
      status: 'succeeded',
      validation,
      stepResults,
      observations,
    };
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