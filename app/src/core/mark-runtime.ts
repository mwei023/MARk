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
import { DevOpsAgent } from '../agents/devops-agent';
import { CICDAgent } from '../agents/cicd-agent';
import { CodeAgent } from '../agents/code-agent';
import { ScreenAgent } from '../agents/screen-agent';
import { WebAgent } from '../agents/web-agent';
import { interactionStream } from './interaction';
import {
  MARKKernelBridge,
  markKernelBridge,
} from '../kernel/bridge';
import {
  extractGoalTerms,
} from '../kernel/workflow-memory';
import { config } from '../config.js';
import { respondWithLLM } from '../llm/reasoner';
import { classifyWithLLM } from './classifier';
import { TaskBinder } from '../kernel/task-binder';
import type { ToolDescriptor } from '../kernel/types';

const taskBinder = new TaskBinder();

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
  /** Step-by-step account of what MARK did with the command. */
  trace?: string[];
}

/** Canonical reasoning: plain LLM chat with deterministic memory retrieval. */
const markReasoner: Reasoner = {
  async respond(input, userId) {
    return respondWithLLM(input, userId);
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
    this.reasoner = dependencies.reasoner ?? markReasoner;
    this.kernelBridge = dependencies.kernelBridge ?? markKernelBridge;

    if (!this.capabilities.list().some(capability => capability.id === 'host.local')) {
      this.capabilities.register(new LocalHostCapability());
    }

    if (!this.capabilities.list().some(capability => capability.id === 'mark.status')) {
      this.capabilities.register(new MarkStatusCapability());
    }
    if (this.agents.getAgentCount() === 0) {
      this.agents.registerAgent(new GitAgent());
      this.agents.registerAgent(new DevOpsAgent());
      this.agents.registerAgent(new CICDAgent());
      this.agents.registerAgent(new CodeAgent());
      this.agents.registerAgent(new ScreenAgent());
      this.agents.registerAgent(new WebAgent());
    }

    // Operational inputs (webhooks now; other perceptions later) share this
    // event bus. User commands are handled synchronously by executeCommand.
    this.bus.subscribeAll(event => this.handleEvent(event));
  }

  /** The single application command path for every MARK interface. */
  async executeCommand(command: string, userId = config.defaultUser, source: 'api' | 'voice' | 'cli' = 'api'): Promise<CommandResult> {
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
    let decision = this.router.classify(event);
    const trace = [
      `gateway → ${decision.path}${decision.agent ? ` (${decision.agent})` : ''}: ${decision.reasoning ?? ''}`.trim(),
    ];
    // Interaction stream: every command is a user message; routing is a
    // thinking event (visible when thinking is toggled on).
    interactionStream.append('message', userId, command);
    interactionStream.append('thinking', 'gateway', '', {
      thinking: {
        source: 'classifier',
        compact: `route=${decision.path}${decision.agent ? ` agent=${decision.agent}` : ''} llm=${decision.needsLLM}`,
        detail: decision.reasoning ?? '',
      },
    });

    // Smart routing: when keywords cannot claim the command, an LLM
    // classifier gets one chance to upgrade to deterministic/agent.
    // Deterministic and agent keyword routes never consult the LLM (fast,
    // offline-safe, test-stable). Disabled with MARK_SMART=off.
    if (process.env.MARK_SMART !== 'off' && (decision.path === 'reasoning' || decision.path === 'escalate')) {
      try {
        const smart = await classifyWithLLM(command);
        if (smart && smart.path === 'deterministic' && this.capabilities.findFor(command)) {
          decision = { ...smart, needsLLM: false };
          trace.push(
            `gateway → deterministic (llm, confidence ${smart.confidence.toFixed(2)}): ${smart.reasoning}`.trim(),
          );
        } else if (smart && smart.path === 'agent') {
          decision = { ...smart, needsLLM: false };
          trace.push(
            `gateway → agent${smart.agent ? ` (${smart.agent})` : ''} (llm, confidence ${smart.confidence.toFixed(2)}): ${smart.reasoning}`.trim(),
          );
        } else if (smart) {
          trace.push(
            `gateway → ${smart.path} (llm confirms, confidence ${smart.confidence.toFixed(2)}): ${smart.reasoning}`.trim(),
          );
        }
      } catch (err) {
        // LLM classifier failed — keyword routing decision stands.
        trace.push(`gateway → llm classifier error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    let result: CommandResult;

    if (decision.path === 'deterministic') {
      const response = await this.capabilities.execute(command);
      result = response
        ? { response, route: 'capability', eventId: event.id }
        : { response: 'That local capability is unavailable on this host.', route: 'unavailable', eventId: event.id };
      trace.push(
        response
          ? 'capability → answered locally, no kernel or LLM involved'
          : 'capability → no local handler matched',
      );
    } else {
      // The kernel goes before the LLM: when MARK can resolve a discovered
      // capability it must act (or report the real outcome), never hand an
      // actionable goal to a chat model that can only talk. Specialists keep
      // priority on their own turf — the kernel is the fallback, not a hijack.
      if (decision.path === 'agent' && decision.agent) {
        const response = await this.agents.handleCommand(event, this.capabilities);
        if (response) {
          result = { response, route: 'agent', eventId: event.id };
          trace.push(`agent → ${decision.agent} handled the command`);
        } else {
          const kernelResult = await this.tryKernelCommand(command, userId, source);
          if (kernelResult) {
            result = { ...kernelResult, eventId: event.id };
            trace.push(...kernelResult.trace);
          } else {
            result = { response: `The ${decision.agent} capability is not available on this host.`, route: 'unavailable', eventId: event.id };
            trace.push('agent → no handler; kernel → no matching capability');
          }
        }
      } else {
        const kernelResult = await this.tryKernelCommand(command, userId, source);
        if (kernelResult) {
          result = { ...kernelResult, eventId: event.id };
          trace.push(...kernelResult.trace);
        } else if (decision.path === 'reasoning' && decision.needsLLM) {
          try {
            result = { response: await this.reasoner.respond(command, userId), route: 'reasoning', eventId: event.id };
            trace.push('kernel → no matching capability; reasoning → LLM answered (words only, no tools ran)');
          } catch (error: any) {
            const detail = error instanceof Error ? error.message : String(error);
            result = {
              response: `Reasoning is unavailable right now: ${detail}`,
              route: 'unavailable',
              eventId: event.id,
            };
            trace.push('kernel → no matching capability; reasoning → unavailable');
          }
        } else {
          result = { response: 'MARK cannot safely route that request yet.', route: 'unavailable', eventId: event.id };
          trace.push('kernel → no matching capability; nothing else claimed it');
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
    result.trace = trace;
    interactionStream.append('receipt', result.route, result.response.slice(0, 500));
    for (const line of trace.slice(0, 10)) {
      interactionStream.append('trace', result.route, line);
    }
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
  ): Promise<{ response: string; route: 'kernel'; trace: string[] } | undefined> {
    try {
      await this.kernelBridge.initialize();
    } catch (err) {
      // Kernel init failed (DB offline, tool discovery error) — skip kernel path.
      return undefined;
    }
    const contextInput = {
      userId,
      source,
      authorityProfile: source === 'cli' ? 'workspace' : 'default',
    } as const;

    // Experience before reasoning: a saved workflow with strong goal overlap
    // runs as-is — unless it is hollow for THIS goal (takes inputs the goal
    // never states AND fresh resolution is weak or disagrees). Hollow
    // replays execute the wrong tool confidently, so they plan fresh
    // instead (arbitration included). Outcomes are recorded so memory
    // learns what keeps working.
    try {
      const reused = this.kernelBridge.reuseWorkflow(command);
      const fresh = this.kernelBridge.resolveCapability(command);
      if (reused && !isHollowReuse(reused.plan, command, this.kernelBridge.listTools(), (cmd, tool) => taskBinder.bind(cmd, tool), fresh)) {
        const report = await this.kernelBridge.executePlanWithReport(reused.plan, { ...contextInput });
        const succeeded = report.status === 'succeeded';
        this.kernelBridge.recordWorkflowOutcome(reused.workflowId, succeeded);
        const stepSummary = report.steps.map(step => `${step.stepId.slice(0, 18)}…:${step.status}`).join(', ');
        // State what actually ran: "procedure succeeded" alone misleads for
        // action goals (finding tracks is not playing music).
        const whatRan = report.steps
          .map(step => {
            const detail = step.output && typeof step.output === 'object'
              ? JSON.stringify(step.output).slice(0, 200)
              : String(step.output ?? step.status);
            return `• ${step.toolId}: ${step.status}${step.status === 'succeeded' ? ` — ${detail}` : ` — ${step.error ?? 'failed'}`}`;
          })
          .join('\n');
        return {
          response: succeeded
            ? `⚙️ Reused a known procedure (${report.steps.length} steps, all succeeded):\n${whatRan}`
            : `Reused procedure ${reused.workflowId} ended ${report.status}: ${stepSummary}`,
          route: 'kernel',
          trace: [
            `memory → reused workflow ${reused.workflowId}`,
            `memory → execution ${report.status}: ${stepSummary}`,
            `memory → outcome recorded (${succeeded ? 'success' : 'not a success'})`,
          ],
        };
      }
    } catch (err) {
      // Memory recall/execution error — proceed with fresh planning.
      console.debug(`[mark-runtime] memory reuse error: ${err instanceof Error ? err.message : String(err)}`);
    }

    let outcome: Awaited<ReturnType<MARKKernelBridge['executeGoal']>>;
    try {
      // Real planner first for multi-word goals: composed DAG (investigate →
      // verify) beats linear single-tool execution when contracts validate.
      // Single-step fallback is automatic inside GoalExecutor.
      const wantsPlan = command.trim().split(/\s+/).length >= 3;
      outcome = await this.kernelBridge.executeGoal(command, contextInput, wantsPlan ? { usePlanner: true, maxPlanSteps: 4 } : undefined);
    } catch (err) {
      // Goal execution threw — kernel path unavailable, caller falls through.
      console.debug(`[mark-runtime] executeGoal error: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }

    // Chat-only unknowns: an explanation request ("help me understand X")
    // with at most one thin tool-term match is answered by chat, never by
    // executing the coincidental tool ("neural networks" must not open
    // network interfaces). Retrieval requests ("summarize recent
    // incidents") are unaffected — they match or miss on their own terms.
    if (isExplanationRequest(command) && (outcome.resolution.matchedTerms?.length ?? 0) <= 1) {
      return undefined;
    }

    // Multi-step plan report: rendered directly, never forced into the
    // single-action shape below. Verification status is explicit.
    if (outcome.executionMode === 'plan' && outcome.planReport) {
      const report = outcome.planReport;
      const succeeded = report.steps.filter(s => s.status === 'succeeded').length;
      const failed = report.steps.filter(s => s.status === 'failed').length;
      const skipped = report.steps.filter(s => s.status === 'skipped').length;
      const lines = report.steps.map(s => `  ${s.status === 'succeeded' ? '✓' : s.status === 'failed' ? '✗' : '○'} ${s.toolId} (${s.stepId})${s.error ? ` — ${s.error.slice(0, 160)}` : ''}`);
      const lastSummary = report.observations.map(o => o.summary).filter(Boolean).pop();
      return {
        response:
          `⚙️ Plan ${report.status} (${succeeded} ok, ${failed} failed, ${skipped} skipped):\n${lines.join('\n')}` +
          (lastSummary ? `\n${lastSummary}` : '') +
          (report.error ? `\nError: ${report.error.slice(0, 300)}` : ''),
        route: 'kernel',
        trace: [
          `kernel → plan: ${outcome.plan?.id} (${outcome.plan?.steps.length} steps, composed)`,
          `kernel → plan execution: ${report.status}`,
        ],
      };
    }

    if (!outcome.action || !outcome.result) {
      if (!outcome.resolution.tool) return undefined;
      return {
        response:
          `Found ${outcome.resolution.tool.id} but could not bind inputs ` +
          `(${(outcome.binding?.missingRequired ?? []).join(', ') || 'no values in request'}). ` +
          `Say it explicitly, e.g. with "name: value".`,
        route: 'kernel',
        trace: [
          'memory → no saved workflow with strong overlap; planning fresh',
          `kernel → resolve: ${outcome.resolution.tool.id} (score ${outcome.resolution.score.toFixed(2)})`,
          `kernel → bind: incomplete, missing ${(outcome.binding?.missingRequired ?? []).join(', ')}`,
        ],
      };
    }

    const { result } = outcome;
    const toolId = outcome.action.toolId;
    const head = [
      `kernel → resolve: ${toolId} (score ${outcome.resolution.score.toFixed(2)}, matched: ${outcome.resolution.matchedTerms.join(', ') || 'none'})`,
      `kernel → execute: ${toolId} → ${result.status}${result.durationMs !== undefined ? ` in ${result.durationMs}ms` : ''}`,
    ];

    if (result.status === 'succeeded') {
      const summary =
        result.observations.map(entry => entry.summary).filter(Boolean).pop() ??
        `Executed ${toolId}.`;
      const trace = [...head];
      // Learn read-only successes for next time. Writes are never
      // auto-saved: a stale write input replayed later could harm.
      const savedId = this.maybeSaveSuccess(command, outcome.plan);
      if (savedId) trace.push(`memory → saved workflow ${savedId} (read-only success)`);
      return { response: `⚙️ ${summary}\n${compactKernelOutput(result.output)}`, route: 'kernel', trace };
    }

    const metadata = (result.metadata ?? {}) as Record<string, unknown>;
    const confirmationId = typeof metadata.confirmationId === 'string' ? metadata.confirmationId : undefined;

    if (result.status === 'blocked' && confirmationId) {
      return {
        response:
          `⏳ "${command}" needs approval (${toolId}): ${result.error} ` +
          `Approve with confirmation ${confirmationId}.`,
        route: 'kernel',
        trace: [...head, `kernel → authority: confirmation required (${confirmationId})`],
      };
    }
    if (result.status === 'blocked') {
      return {
        response: `Blocked by policy (${toolId}): ${result.error}`,
        route: 'kernel',
        trace: [...head, 'kernel → authority: denied, no confirmation possible'],
      };
    }
    return {
      response: `Failed (${toolId}): ${result.error ?? 'unknown error'}`,
      route: 'kernel',
      trace: [...head, `kernel → error: ${result.error ?? 'unknown error'}`],
    };
  }

    /**
   * Saves a succeeded plan to workflow memory when it is safe to replay:
   * every step is read-only and no near-duplicate goal is already saved.
   * Returns the saved workflow id, or undefined when nothing was saved.
   */
  private maybeSaveSuccess(
    command: string,
    plan: Awaited<ReturnType<MARKKernelBridge['executeGoal']>>['plan'],
  ): string | undefined {
    try {
      if (!plan || plan.steps.length === 0) return undefined;
      // Single-term goals ("hi", "status") execute fine but are never worth
      // memorizing: they are usually false-positive matches or too vague to
      // replay safely.
      if (extractGoalTerms(command).length < 2) return undefined;
      const risks = new Map(this.kernelBridge.listTools().map(tool => [tool.id, tool.risk] as const));
      const allReadOnly = plan.steps.every(step => {
        const risk = risks.get(step.toolId);
        return risk === 'read' || risk === 'diagnostic';
      });
      if (!allReadOnly) return undefined;
      if (this.kernelBridge.recallWorkflows(command, 1, 0.9).length > 0) return undefined;
      return this.kernelBridge.saveWorkflow(plan).id;
    } catch (err) {
      // Workflow save failed — non-critical, proceed without saving.
      return undefined;
    }
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
    userId = config.defaultUser,
    source: 'api' | 'voice' | 'cli' = 'api',
  ) {
    return this.kernelBridge.executeTool(toolId, input, {
      userId,
      source,
    });
  }

  async executeKernelGoal(
    goal: string,
    userId = config.defaultUser,
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

/** Explicit explanation framings: chat owns these unless tools match deeply. */
function isExplanationRequest(command: string): boolean {
  return /\b(help me understand|explain|what (is|are)|define|tell me about|how (does|do)|why (is|are|do))\b/i.test(command);
}

/**
 * A recalled plan is hollow for the current goal when its first step
 * declares inputs the goal never states AND fresh resolution is weak
 * (one thin match) or disagrees (different top tool): replaying would run
 * a tool the goal never evidenced. Input-less tools, evidenced replays,
 * and recalls no fresh resolution covers always run.
 */
export function isHollowReuse(
  plan: { steps: Array<{ toolId: string; input?: Record<string, unknown> }> },
  command: string,
  tools: ToolDescriptor[],
  bind: (command: string, tool: ToolDescriptor) => { matchedFields: string[] },
  fresh?: { tool?: { id: string }; matchedTerms?: string[] },
): boolean {
  const first = plan.steps[0];
  if (!first) return true;
  const tool = tools.find(candidate => candidate.id === first.toolId);
  if (!tool) return true;
  if (Object.keys(tool.inputSchema?.properties ?? {}).length === 0) return false;
  let evidenced = false;
  try {
    evidenced = bind(command, tool).matchedFields.length > 0;
  } catch (_err) {
    // bind() threw (e.g. malformed tool schema) — treat as not evidenced, allow reuse.
    return false;
  }
  if (evidenced) return false;
  if (!fresh?.tool) return false;
  return fresh.tool.id !== first.toolId || (fresh.matchedTerms?.length ?? 0) <= 1;
}

function compactKernelOutput(output: unknown): string {
  if (output === undefined) return '(no output)';
  try {
    const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    return text.length > 800 ? `${text.slice(0, 800)}\n… (output truncated)` : text;
  } catch (_err) {
    // Circular reference or other serialization failure.
    return String(output);
  }
}
