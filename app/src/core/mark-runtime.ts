/**
 * MARK's canonical Phase 1 runtime.
 *
 * Interfaces (HTTP, CLI, and eventually voice) submit commands here. The
 * runtime emits a canonical event, applies deterministic routing, delegates
 * concrete work to capabilities or domain interpretation to agents, and uses
 * legacy Jarvis only as the current reasoning adapter.
 */
import { MarkStatusCapability } from '../runtime/capabilities/mark-status';
import { AgentRuntime, agentRuntime } from './agent-runtime';
import { EventBus, eventBus } from './event-bus';
import { Event } from './events';
import { Gateway, gateway } from './gateway';
import { CapabilityRegistry, capabilityRegistry } from '../runtime/capabilities/registry';
import { LocalHostCapability } from '../runtime/capabilities/shell';
import { GitAgent } from '../agents/git-agent';
import {
  MARKKernelBridge,
  markKernelBridge,
} from '../kernel/bridge';

export interface Reasoner {
  respond(input: string, userId: string): Promise<string>;
}

export interface MarkRuntimeDependencies {
  eventBus?: EventBus;
  gateway?: Gateway;
  agents?: AgentRuntime;
  capabilities?: CapabilityRegistry;
  reasoner?: Reasoner;
  kernelBridge?: MARKKernelBridge;
}

export interface CommandResult {
  response: string;
  route: 'capability' | 'agent' | 'reasoning' | 'kernel' | 'unavailable';
  eventId: string;
}

/** Preserves the existing LangGraph assistant behind MARK's reasoning boundary. */
const legacyJarvisReasoner: Reasoner = {
  async respond(input, userId) {
    // Dynamic loading keeps the legacy graph an adapter, not a dependency of
    // MARK's core startup path. It also lets deterministic commands work when
    // an LLM/database is unavailable.
    // `import('../agent')` resolves to the sibling directory under ts-node's
    // ESM loader. CommonJS resolution deliberately selects `agent.ts`, the
    // legacy public entry point retained as MARK's reasoning adapter.
    const legacy = require('../agent') as { runAgent: (text: string, id: string) => Promise<string> };
    return legacy.runAgent(input, userId);
  },
};

export class MarkRuntime {
  private readonly bus: EventBus;
  private readonly router: Gateway;
  private readonly agents: AgentRuntime;
  private readonly capabilities: CapabilityRegistry;
  private readonly reasoner: Reasoner;
  private readonly kernelBridge: MARKKernelBridge;

  constructor(dependencies: MarkRuntimeDependencies = {}) {
    this.bus = dependencies.eventBus ?? eventBus;
    this.router = dependencies.gateway ?? gateway;
    this.agents = dependencies.agents ?? agentRuntime;
    this.capabilities = dependencies.capabilities ?? capabilityRegistry;
    this.reasoner = dependencies.reasoner ?? legacyJarvisReasoner;
    this.kernelBridge = dependencies.kernelBridge ?? markKernelBridge;

    if (!this.capabilities.list().some(capability => capability.id === 'host.local')) {
      this.capabilities.register(new LocalHostCapability());
    }

    if (!this.capabilities.list().some(capability => capability.id === 'mark.status')) {
      this.capabilities.register(new MarkStatusCapability());
    }
    if (this.agents.getAgentCount() === 0) {
      this.agents.registerAgent(new GitAgent());
    }

    // Operational inputs (webhooks now; other perceptions later) share this
    // event bus. User commands are handled synchronously by executeCommand.
    this.bus.subscribeAll(event => this.handleEvent(event));
  }

  /** The single application command path for every MARK interface. */
  async executeCommand(command: string, userId = 'mwei', source: 'api' | 'voice' | 'cli' = 'api'): Promise<CommandResult> {
    const event: Event = {
      id: `CMD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date(),
      source: source === 'cli' ? 'user_command' : source,
      type: 'user.command.received',
      severity: 'info',
      correlationId: userId,
      data: { userId, command, source },
    } as Event;

    // The event is emitted before handling, so observers see every command.
    await this.bus.emit(event);
    const decision = this.router.classify(event);
    let result: CommandResult;

    if (decision.path === 'deterministic') {
      const response = await this.capabilities.execute(command);
      result = response
        ? { response, route: 'capability', eventId: event.id }
        : { response: 'That local capability is unavailable on this host.', route: 'unavailable', eventId: event.id };
    } else {
      // The kernel goes before the LLM: when MARK can resolve a discovered
      // capability it must act (or report the real outcome), never hand an
      // actionable goal to a chat model that can only talk. Specialists keep
      // priority on their own turf — the kernel is the fallback, not a hijack.
      if (decision.path === 'agent' && decision.agent) {
        const response = await this.agents.handleCommand(event, this.capabilities);
        if (response) {
          result = { response, route: 'agent', eventId: event.id };
        } else {
          const kernelResult = await this.tryKernelCommand(command, userId, source);
          result = kernelResult
            ? { ...kernelResult, eventId: event.id }
            : { response: `The ${decision.agent} capability is not available on this host.`, route: 'unavailable', eventId: event.id };
        }
      } else {
        const kernelResult = await this.tryKernelCommand(command, userId, source);
        if (kernelResult) {
          result = { ...kernelResult, eventId: event.id };
        } else if (decision.path === 'reasoning' && decision.needsLLM) {
          try {
            result = { response: await this.reasoner.respond(command, userId), route: 'reasoning', eventId: event.id };
          } catch (error: any) {
            const detail = error instanceof Error ? error.message : String(error);
            result = {
              response: `Reasoning is unavailable right now: ${detail}`,
              route: 'unavailable',
              eventId: event.id,
            };
          }
        } else {
          result = { response: 'MARK cannot safely route that request yet.', route: 'unavailable', eventId: event.id };
        }
      }
    }

    await this.bus.emit({
      id: `RESULT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date(),
      source: 'system',
      type: 'agent.action.taken',
      severity: 'info',
      correlationId: event.correlationId,
      data: { commandEventId: event.id, route: result.route, success: result.route !== 'unavailable' },
    } as Event);
    return result;
  }

  /**
   * Attempts a command through the execution kernel. Returns a result only
   * when the kernel actually resolved and ran a capability; otherwise
   * undefined so the caller falls through to agents or reasoning. The
   * kernel must never break chat: every failure mode degrades to undefined.
   */
  private async tryKernelCommand(
    command: string,
    userId: string,
    source: 'api' | 'voice' | 'cli',
  ): Promise<{ response: string; route: 'kernel' } | undefined> {
    let outcome: Awaited<ReturnType<MARKKernelBridge['executeGoal']>>;
    try {
      await this.kernelBridge.initialize();
      outcome = await this.kernelBridge.executeGoal(command, {
        userId,
        source,
        authorityProfile: source === 'cli' ? 'workspace' : 'default',
      });
    } catch {
      return undefined;
    }

    if (!outcome.action || !outcome.result) return undefined;

    const { result } = outcome;
    const toolId = outcome.action.toolId;

    if (result.status === 'succeeded') {
      const summary =
        result.observations.map(entry => entry.summary).filter(Boolean).pop() ??
        `Executed ${toolId}.`;
      return { response: `⚙️ ${summary}\n${compactKernelOutput(result.output)}`, route: 'kernel' };
    }

    const metadata = (result.metadata ?? {}) as Record<string, unknown>;
    const confirmationId = typeof metadata.confirmationId === 'string' ? metadata.confirmationId : undefined;

    if (result.status === 'blocked' && confirmationId) {
      return {
        response:
          `⏳ "${command}" needs approval (${toolId}): ${result.error} ` +
          `Approve with confirmation ${confirmationId}.`,
        route: 'kernel',
      };
    }
    if (result.status === 'blocked') {
      return { response: `Blocked by policy (${toolId}): ${result.error}`, route: 'kernel' };
    }
    return { response: `Failed (${toolId}): ${result.error ?? 'unknown error'}`, route: 'kernel' };
  }

  /** Handles non-command operational events received through the same bus. */  async handleEvent(event: Event): Promise<void> {
    if (event.type === 'user.command.received') return;
    const decision = this.router.classify(event);
    if (decision.path === 'agent') await this.agents.handleEvent(event);
  }

  async initializeKernel() {
    return this.kernelBridge.initialize();
  }

  listKernelTools() {
    return this.kernelBridge.listTools();
  }

  resolveKernelCapability(goal: string) {
  return this.kernelBridge.resolveCapability(goal);
}

  kernelStatus() {
    return this.kernelBridge.status();
  }

  async executeKernelTool(
    toolId: string,
    input: Record<string, unknown> = {},
    userId = 'mwei',
    source: 'api' | 'voice' | 'cli' = 'api',
  ) {
    return this.kernelBridge.executeTool(toolId, input, {
      userId,
      source,
    });
  }

  async executeKernelGoal(
    goal: string,
    userId = 'mwei',
    source: 'api' | 'voice' | 'cli' = 'api',
  ) {
    return this.kernelBridge.executeGoal(goal, {
      userId,
      source,
    });
  }

  planKernelGoal(goal: string) {
    return this.kernelBridge.planGoal(goal);
  }

  validateKernelPlan(
    plan: Parameters<MARKKernelBridge['validatePlan']>[0],
  ) {
    return this.kernelBridge.validatePlan(plan);
  }
}

export const markRuntime = new MarkRuntime();

function compactKernelOutput(output: unknown): string {
  if (output === undefined) return '(no output)';
  try {
    const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    return text.length > 800 ? `${text.slice(0, 800)}\n… (output truncated)` : text;
  } catch {
    return String(output);
  }
}
