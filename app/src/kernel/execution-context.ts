import {
  ExecutionContext,
  KernelId,
} from './types';

export interface CreateExecutionContextInput {
  userId: string;
  source: ExecutionContext['source'];
  sessionId?: KernelId;
  authorityProfile?: string;
  workingDirectory?: string;
  environment?: Record<string, string>;
  parentActionId?: KernelId;
  workflowId?: KernelId;
  metadata?: Record<string, unknown>;
}

/**
 * Creates a normalized execution context for an action or workflow.
 *
 * The context carries identity, origin, authority, and execution metadata.
 * It does not execute anything and does not decide whether an action is safe.
 */
export function createExecutionContext(
  input: CreateExecutionContextInput,
): ExecutionContext {
  return {
    sessionId: input.sessionId ?? createKernelId('session'),
    userId: input.userId,
    source: input.source,
    authorityProfile: input.authorityProfile ?? 'default',
    workingDirectory: input.workingDirectory,
    environment: {
      ...input.environment,
    },
    parentActionId: input.parentActionId,
    workflowId: input.workflowId,
    metadata: {
      ...input.metadata,
    },
  };
}

/**
 * Creates a lightweight unique identifier for kernel entities.
 *
 * This is intentionally local and dependency-free. A persistent ID provider
 * can replace it later without changing the rest of the kernel contracts.
 */
export function createKernelId(prefix: string): KernelId {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 10);

  return `${prefix}_${timestamp}_${randomPart}`;
}
