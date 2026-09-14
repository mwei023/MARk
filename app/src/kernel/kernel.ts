import {
  ActionRequest,
  ActionResult,
  ExecutionContext,
  ToolDescriptor,
  WorkflowDefinition,
  WorkflowResult,
} from './types';

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
}

export const markKernel = new MARKKernel();
