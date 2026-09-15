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
  ExecutionPlan,
  PlanExecutionResult,
  PlanValidationResult,
} from './planner';


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
  ): Promise<GoalExecutionResult> {
    const context = this.createContext(contextInput);

    return this.kernel.executeGoal(goal, context);
  }

  planGoal(goal: string): ExecutionPlan {
    return this.kernel.planGoal(goal);
  }

  validatePlan(plan: ExecutionPlan): PlanValidationResult {
    return this.kernel.validatePlan(plan);
  }

  async executePlan(
    plan: ExecutionPlan,
    contextInput: Parameters<MARKKernel['createContext']>[0],
  ): Promise<PlanExecutionResult> {
    const context = this.createContext(contextInput);

    return this.kernel.executePlan(plan, context);
  }
}

export const markKernelBridge = new MARKKernelBridge();
