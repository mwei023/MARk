/**
 * Agent Base Class: All specialized agents inherit from this.
 * Provides common interface for tool execution, approval handling, event publishing.
 */

import { Event } from './events';
import { IncidentAction } from './incident';
import { PolicyContext, policyEngine } from './policies';
import type { CapabilityRegistry } from '../runtime/capabilities/registry';

export interface ToolDefinition {
  name: string;
  description: string;
  func: (args: any) => Promise<string>;
}

export abstract class Agent {
  protected name: string;
  protected tools: Map<string, ToolDefinition> = new Map();

  constructor(name: string) {
    this.name = name;
  }

  /**
   * Register a tool that this agent can use
   */
  protected registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Execute a tool with policy checks
   */
  protected async executeTool(
    toolName: string,
    args: any,
    context: Omit<PolicyContext, 'agentName' | 'action' | 'risk'>
  ): Promise<{ success: boolean; result: string; action: IncidentAction }> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        result: `Tool not found: ${toolName}`,
        action: {
          timestamp: new Date(),
          agent: this.name,
          action: `execute_${toolName}`,
          tool: toolName,
          args,
          result: 'failure',
          details: `Tool '${toolName}' not found`,
        },
      };
    }

    // Check policies
    const policyContext: PolicyContext = {
      agentName: this.name,
      action: toolName,
      risk: 'medium', // Default; override in subclass
      ...context,
    };

    const decision = policyEngine.evaluate(policyContext);
    const reason = policyEngine.getReason(policyContext);

    if (decision === 'block') {
      return {
        success: false,
        result: `Action blocked by policy: ${reason}`,
        action: {
          timestamp: new Date(),
          agent: this.name,
          action: `execute_${toolName}`,
          tool: toolName,
          args,
          result: 'failure',
          details: `Blocked: ${reason}`,
        },
      };
    }

    if (decision === 'confirm' || decision === 'alert') {
      // This should be handled by AgentRuntime
      return {
        success: false,
        result: `Action requires approval: ${reason}`,
        action: {
          timestamp: new Date(),
          agent: this.name,
          action: `execute_${toolName}`,
          tool: toolName,
          args,
          result: 'failure',
          details: `Requires approval: ${reason}`,
        },
      };
    }

    // Execute tool
    try {
      const result = await tool.func(args);
      return {
        success: true,
        result,
        action: {
          timestamp: new Date(),
          agent: this.name,
          action: `execute_${toolName}`,
          tool: toolName,
          args,
          result: 'success',
          details: result,
        },
      };
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        result: `Tool execution failed: ${details}`,
        action: {
          timestamp: new Date(),
          agent: this.name,
          action: `execute_${toolName}`,
          tool: toolName,
          args,
          result: 'failure',
          details,
        },
      };
    }
  }

  /**
   * Main handler: agents implement this to respond to events
   */
  abstract canHandle(event: Event): boolean;
  abstract handle(event: Event): Promise<void>;

  /** Optional synchronous command surface for a specialist agent. */
  handleCommand?(_event: Event, _capabilities: CapabilityRegistry): Promise<string>;

  getName(): string {
    return this.name;
  }
}

/**
 * AgentRuntime: Orchestrates agent execution, approval flows, and incident tracking.
 */
import { eventBus } from './event-bus';
import { incidentStore, Incident } from './incident';

export type ApprovalHandler = (approved: boolean) => void;

export class AgentRuntime {
  private agents: Agent[] = [];
  private pendingApprovals: Map<string, ApprovalHandler> = new Map();

  registerAgent(agent: Agent): void {
    this.agents.push(agent);
    console.log(`[AgentRuntime] Registered agent: ${agent.getName()}`);
  }

  getAgentCount(): number {
    return this.agents.length;
  }

  /**
   * Route an event to the appropriate agent
   */
  async handleEvent(event: Event): Promise<void> {
    const handler = this.agents.find(a => a.canHandle(event));
    if (!handler) {
      console.warn(`[AgentRuntime] No agent found for event type: ${event.type}`);
      return;
    }

    console.log(`[AgentRuntime] Routing ${event.type} to ${handler.getName()}`);
    try {
      await handler.handle(event);
    } catch (error) {
      console.error(`[AgentRuntime] Error in agent ${handler.getName()}:`, error);
    }
  }

  /** Route a user command to a specialist and return its user-facing result. */
  async handleCommand(event: Event, capabilities: CapabilityRegistry): Promise<string | null> {
    const handler = this.agents.find(agent => agent.canHandle(event));
    if (!handler || !handler.handleCommand) return null;
    return handler.handleCommand(event, capabilities);
  }

  /**
   * Request user approval for an action
   */
  async requestApproval(
    incidentId: string,
    action: string,
    reason: string
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(incidentId);
        resolve(false);
      }, 5 * 60 * 1000);

      this.pendingApprovals.set(incidentId, (approved: boolean) => {
        clearTimeout(timeout);
        this.pendingApprovals.delete(incidentId);
        resolve(approved);
      });

      eventBus.emit({
        id: `APR-${Date.now()}`,
        timestamp: new Date(),
        source: 'system',
        type: 'user.approval.requested',
        severity: 'warning',
        data: {
          incidentId,
          action,
          reason,
        },
      } as any);
    });
  }

  /**
   * User grants approval
   */
  async grantApproval(incidentId: string): Promise<void> {
    const handler = this.pendingApprovals.get(incidentId);
    if (handler) {
      handler(true);
    }
  }

  /**
   * User denies approval
   */
  async denyApproval(incidentId: string): Promise<void> {
    const handler = this.pendingApprovals.get(incidentId);
    if (handler) {
      handler(false);
    }
  }
}

export const agentRuntime = new AgentRuntime();
