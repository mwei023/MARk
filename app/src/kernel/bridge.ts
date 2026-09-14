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
      registerNativeSystemProvider();
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

  async executeWorkflow(
    workflow: WorkflowDefinition,
    context: ExecutionContext,
  ): Promise<WorkflowResult> {
    return this.kernel.executeWorkflow(workflow, context);
  }
}

export const markKernelBridge = new MARKKernelBridge();
