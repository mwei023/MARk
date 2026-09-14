/**
 * MARK Cognitive OS
 *
 * Shared kernel types.
 *
 * These types describe:
 * - resources in the environment;
 * - tools that can act on those resources;
 * - structured actions;
 * - observations;
 * - execution results;
 * - workflows;
 * - authority and risk boundaries.
 *
 * This file must remain domain-general.
 * Do not add YouTube-, VLC-, Bluetooth-, or trading-specific types here.
 */

export type KernelId = string;

export type ResourceKind =
  | 'application'
  | 'window'
  | 'process'
  | 'file'
  | 'directory'
  | 'device'
  | 'network'
  | 'service'
  | 'browser'
  | 'web'
  | 'database'
  | 'account'
  | 'document'
  | 'unknown';

export type ResourceState =
  | 'available'
  | 'active'
  | 'inactive'
  | 'degraded'
  | 'unavailable'
  | 'unknown';

export type ToolRisk =
  | 'read'
  | 'diagnostic'
  | 'reversible'
  | 'mutating'
  | 'privileged'
  | 'financial';

export type ActionStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'blocked';

export type ObservationKind =
  | 'resource'
  | 'process'
  | 'window'
  | 'file'
  | 'network'
  | 'device'
  | 'application'
  | 'system'
  | 'web'
  | 'output'
  | 'error'
  | 'unknown';

export interface ResourceDescriptor {
  id: KernelId;
  kind: ResourceKind;
  name: string;
  state: ResourceState;
  description?: string;
  provider?: string;
  parentId?: KernelId;
  capabilities: string[];
  metadata: Record<string, unknown>;
  discoveredAt: string;
  lastSeenAt?: string;
}

export interface ToolParameterSchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'unknown';
  description?: string;
  required?: boolean;
  enum?: string[];
  properties?: Record<string, ToolParameterSchema>;
  items?: ToolParameterSchema;
}

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, ToolParameterSchema>;
  required?: string[];
}

export interface ToolDescriptor {
  id: KernelId;
  name: string;
  description: string;
  domain: string;
  version?: string;
  provider: string;
  inputSchema: ToolInputSchema;
  risk: ToolRisk;
  requiredPermissions: string[];
  supportedResourceKinds: ResourceKind[];
  reversible: boolean;
  available: boolean;
  metadata: Record<string, unknown>;
}

export interface ActionRequest {
  id: KernelId;
  toolId: KernelId;
  input: Record<string, unknown>;
  requestedBy: string;
  reason?: string;
  targetResourceIds?: KernelId[];
  parentActionId?: KernelId;
  workflowId?: KernelId;
  createdAt: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface ActionResult {
  actionId: KernelId;
  status: ActionStatus;
  output?: unknown;
  error?: string;
  observations: Observation[];
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface Observation {
  id: KernelId;
  kind: ObservationKind;
  source: string;
  subject?: string;
  summary: string;
  data: unknown;
  confidence?: number;
  observedAt: string;
  relatedActionId?: KernelId;
  relatedResourceIds?: KernelId[];
  metadata?: Record<string, unknown>;
}

export interface WorkflowStep {
  id: KernelId;
  name: string;
  action?: ActionRequest;
  dependsOn?: KernelId[];
  condition?: string;
  optional?: boolean;
  retryLimit?: number;
  timeoutMs?: number;
}

export interface WorkflowDefinition {
  id: KernelId;
  name: string;
  goal: string;
  steps: WorkflowStep[];
  requestedBy: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowResult {
  workflowId: KernelId;
  status: ActionStatus;
  completedSteps: KernelId[];
  failedSteps: KernelId[];
  actionResults: ActionResult[];
  observations: Observation[];
  summary?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface ExecutionContext {
  sessionId: KernelId;
  userId: string;
  source: 'api' | 'cli' | 'voice' | 'system' | 'workflow';
  authorityProfile: string;
  workingDirectory?: string;
  environment: Record<string, string>;
  parentActionId?: KernelId;
  workflowId?: KernelId;
  metadata: Record<string, unknown>;
}
