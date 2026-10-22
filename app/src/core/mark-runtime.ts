/**
 * MARK's canonical Phase 1 runtime.
 *
 * Interfaces (HTTP, CLI, and eventually voice) submit commands here. The
 * runtime emits a canonical event, applies deterministic routing, delegates
 * concrete work to capabilities or domain interpretation to agents, and uses
 * legacy Jarvis only as the current reasoning adapter.
 */
import { MarkStatusCapability } from '../runtime/capabilities/mark-status';
import { FieldProbeCapability } from '../runtime/capabilities/field-node';
import { HostDiscoveryCapability } from '../runtime/capabilities/host-discovery';
import {
  FieldCamshotCapability,
  FieldClickCapability,
  FieldScreenshotCapability,
  FieldTypeCapability,
} from '../runtime/capabilities/field-actions';
import { AgentRuntime, agentRuntime } from './agent-runtime';
import { EventBus, eventBus } from './event-bus';
import { Event } from './events';
import { Gateway, gateway, isContentRequest, isExplicitToolCall } from './gateway';
import { CapabilityRegistry, capabilityRegistry } from '../runtime/capabilities/registry';
import { LocalHostCapability } from '../runtime/capabilities/shell';
import { GitAgent } from '../agents/git-agent';
import { SystemAgent } from '../agents/system-agent';
import { DevOpsAgent } from '../agents/devops-agent';
import { CICDAgent } from '../agents/cicd-agent';
import { CodeAgent } from '../agents/code-agent';
import { ScreenAgent } from '../agents/screen-agent';
import { WebAgent } from '../agents/web-agent';
import { ResearchAgent } from '../agents/research-agent';
import { currentInteractionSession, interactionStream, runInInteractionSession } from './interaction';
import {
  MARKKernelBridge,
  markKernelBridge,
} from '../kernel/bridge';
import {
  extractGoalTerms,
} from '../kernel/workflow-memory';
import { config } from '../config.js';
import { respondWithLLM, respondWithLLMStream } from '../llm/reasoner';
import { classifyWithLLM } from './classifier';
import { decideRoute } from '../llm/jev';
import { TaskBinder } from '../kernel/task-binder';
import { createLogger } from './logger';
import { logRoutingDecision } from './training-log';
import type { ToolDescriptor } from '../kernel/types';

const taskBinder = new TaskBinder();
const log = createLogger('mark-runtime');

export interface Reasoner {
  respond(input: string, userId: string): Promise<string>;
  /** Optional token streaming; absent means emit the full text at once. */
  stream?(input: string, userId: string, onToken: (token: string) => void): Promise<string>;
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

export interface ExecuteCommandOptions {
  onToken?: (token: string) => void;
  /** Conversation/session boundary; never inferred from process-global state. */
  sessionId?: string;
}

/** Canonical reasoning: plain LLM chat with deterministic memory retrieval. */
const markReasoner: Reasoner = {
  async respond(input, userId) {
    return respondWithLLM(input, userId);
  },
  async stream(input, userId, onToken) {
    return respondWithLLMStream(input, userId, onToken);
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

    if (!this.capabilities.list().some(capability => capability.id === 'field.probe')) {
      this.capabilities.register(new FieldProbeCapability());
      // Register host discovery capability so Mark can introspect its environment
      if (!this.capabilities.list().some(cap => cap.id === 'host.discovery')) {
        this.capabilities.register(new HostDiscoveryCapability());
      }
    }

    for (const capability of [
      new FieldScreenshotCapability(),
      new FieldCamshotCapability(),
      new FieldClickCapability(),
      new FieldTypeCapability(),
    ]) {
      if (!this.capabilities.list().some(existing => existing.id === capability.id)) {
        this.capabilities.register(capability);
      }
    }
    if (this.agents.getAgentCount() === 0) {
      // SystemAgent first: AgentRuntime.handleCommand picks the first
      // canHandle match, and "system status"-adjacent words (status,
      // server, services) overlap git/devops. Gateway already routes
      // explicitly, but registration order is the backstop.
      this.agents.registerAgent(new SystemAgent());
      this.agents.registerAgent(new GitAgent());
      this.agents.registerAgent(new DevOpsAgent());
      this.agents.registerAgent(new CICDAgent());
      this.agents.registerAgent(new CodeAgent());
      this.agents.registerAgent(new ScreenAgent());
      this.agents.registerAgent(new WebAgent());
      this.agents.registerAgent(new ResearchAgent());
    }

    // Operational inputs (webhooks now; other perceptions later) share this
    // event bus. User commands are handled synchronously by executeCommand.
    this.bus.subscribeAll(event => this.handleEvent(event));
  }

  /** The single application command path for every MARK interface. */
  async executeCommand(command: string, userId = config.defaultUser, source: 'api' | 'voice' | 'cli' = 'api', opts: ExecuteCommandOptions = {}): Promise<CommandResult> {
    const sessionId = opts.sessionId?.trim() || `user:${userId}`;
    return runInInteractionSession(sessionId, () =>
      this.executeCommandInSession(command, userId, source, opts));
  }

  private async executeCommandInSession(command: string, userId = config.defaultUser, source: 'api' | 'voice' | 'cli' = 'api', opts: ExecuteCommandOptions = {}): Promise<CommandResult> {
    const event: Event = {
      id: `CMD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date(),
      source: source === 'cli' ? 'user_command' : source,
      type: 'user.command.received',
      severity: 'info',
      correlationId: userId,
      data: { userId, command, source, sessionId: currentInteractionSession() },
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

    // Smart routing: when keywords cannot claim the command, Jev (fast,
    // cheap, typed) gets first shot at the fuzzy middle; the frontier LLM
    // remains the final fallback. Deterministic and agent keyword routes
    // never consult either (fast, offline-safe, test-stable). Explicit
    // kernel-tool calls skip both too — the user addressed a tool, and
    // classifiers second-guess them into agents (observed live: deploy
    // orders re-routed to git-agent after the gateway correctly bypassed).
    // Disabled with MARK_SMART=off.
    if (process.env.MARK_SMART !== 'off' && (decision.path === 'reasoning' || decision.path === 'escalate') && !isExplicitToolCall(command) && !isContentRequest(command)) {
      try {
        const jev = await decideRoute(command);
        if (jev) {
          if (jev.route === 'deterministic') {
            decision = { path: 'deterministic', needsLLM: false, priority: decision.priority, reasoning: `jev choice ${jev.route}` };
          } else if (jev.route.startsWith('agent:')) {
            decision = { path: 'agent', agent: jev.route.slice('agent:'.length), needsLLM: false, priority: decision.priority, reasoning: `jev choice ${jev.route}` };
          } else if (jev.route === 'kernel') {
            decision = { path: 'reasoning', needsLLM: true, priority: decision.priority, reasoning: 'jev routes to kernel tools' };
          } else {
            decision = { ...decision, needsLLM: true };
          }
          trace.push(`gateway → ${decision.path}${decision.agent ? ` (${decision.agent})` : ''} (jev, confidence ${jev.confidence.toFixed(2)}): ${jev.route}`.trim());
        }
      } catch {
        // Jev failed — fell through to the LLM classifier below (it never throws, this is belt and braces).
      }
      try {
        if (decision.path === 'reasoning' || decision.path === 'escalate') {
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
        }
      } catch (err) {
        // LLM classifier failed — keyword routing decision stands.
        trace.push(`gateway → llm classifier error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Auto-log: the final routing decision IS the ground-truth label for
    // future classifier distillation (router is the oracle). Best-effort,
    // never throws. Disable with MARK_TRAINING_LOG=false.
    // Sources are kept distinct for model training quality:
    //   'live'  — a human drove this (playground/api/cli as themselves)
    //   'probe' — scripted self-exercise (session 'probe:*', read-only catalog)
    // Retraining prefers 'live' phrasing; 'probe' rows add coverage only.
    const probeSession = (opts.sessionId ?? currentInteractionSession() ?? '').startsWith('probe:');
    logRoutingDecision({
      text: command,
      label: decision.agent ? `agent:${decision.agent}` : decision.path,
      source: probeSession ? 'probe' : 'live',
    });
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
        const response = await this.agents.handleCommand(event, this.capabilities, decision.agent);
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
            // Streaming callers get tokens as they arrive; everyone else the
            // full text. Non-reasoning routes ignore onToken entirely.
            const respond = this.reasoner.stream && opts.onToken
              ? () => this.reasoner.stream!(command, userId, opts.onToken!)
              : () => this.reasoner.respond(command, userId);
            result = { response: await respond(), route: 'reasoning', eventId: event.id };
            trace.push('kernel → no matching capability; reasoning → LLM answered (words only, no tools ran)');
          } catch (error: any) {
            const detail = error instanceof Error ? error.message : String(error);
            // Friendly fallback: the user asked a question and the LLM either
            // returned nothing useful or timed out. Never surface raw error
            // strings — give a short honest reply they can act on.
            const isEmpty = detail.toLowerCase().includes('empty response');
            result = {
              response: isEmpty
                ? "I didn't get a useful reply from my reasoning engine. The reasoning service is currently unavailable. Could you rephrase or try again?"
                : 'The reasoning engine is unavailable right now. Please try again in a moment.',
              route: 'unavailable',
              eventId: event.id,
            };
            trace.push(`kernel → no matching capability; reasoning → unavailable (${detail})`);
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
      // Explicit addressing beats memory: when the goal names a tool id
      // verbatim ("execute repo.index") but the recalled plan runs another
      // tool, the recall is stale for THIS goal no matter its scores.
      // Observed live: index orders replayed a memorized symbols workflow.
      const addressed = /([a-z0-9_.-]+\.[a-z0-9_.-]+)/i.exec(command)?.[1]?.toLowerCase();
      const firstStep = reused?.plan.steps[0]?.toolId.toLowerCase();
      const addressedMismatch = !!addressed && !!firstStep && addressed !== firstStep &&
        this.kernelBridge.listTools().some(t => t.id.toLowerCase() === addressed);
      if (reused && !addressedMismatch && !isHollowReuse(reused.plan, command, this.kernelBridge.listTools(), (cmd, tool) => taskBinder.bind(cmd, tool), fresh)) {
        const report = await this.kernelBridge.executePlanWithReport(reused.plan, { ...contextInput });
        // Step status lies when tools fail closed: an implementation that
        // resolves with {ok:false} output still records step "succeeded".
        // Memory must learn the output truth, not the status label.
        const stepsOk = report.steps.every(step => (step.output as Record<string, unknown> | undefined)?.ok !== false);
        const succeeded = report.status === 'succeeded' && stepsOk;
        this.kernelBridge.recordWorkflowOutcome(reused.workflowId, succeeded);
        const stepSummary = report.steps.map(step => `${step.stepId.slice(0, 18)}…:${step.status}`).join(', ');
        // State what actually ran: "procedure succeeded" alone misleads for
        // action goals (finding tracks is not playing music).
        // Prefer the tool's human-readable observation summary over raw JSON
        // so the response reads naturally (e.g. "Measured 20 entries; largest
        // is /opt" rather than a raw JSON blob). summary lives on
        // step.observations, not step.output. Observed: kernel-command test
        // expected /Measured|largest/ but got raw JSON on reused path.
        const whatRan = report.steps
          .map(step => {
            const obsSummary = (step.observations ?? []).map(o => (o as { summary?: string }).summary).filter(Boolean).pop();
            const out = step.output as Record<string, unknown> | undefined;
            const detail = obsSummary
              ?? (out && typeof out === 'object'
                ? (typeof out.summary === 'string' ? out.summary : JSON.stringify(out).slice(0, 200))
                : String(step.output ?? step.status));
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
      log.debug('Memory reuse failed, proceeding with fresh plan', { error: err instanceof Error ? err.message : String(err) });
    }

    let outcome: Awaited<ReturnType<MARKKernelBridge['executeGoal']>>;
    try {
      // Creative goals (compose/draft/homepage...) belong to the LLM unless
      // the kernel has a strong, evidenced claim: an explicit fs/repo tool
      // with 2+ matched terms and a solid score. Observed live: "compose
      // homepage markup" planned process_summary + list_open — words only
      // tasks must never become tool plans on thin matches.
      if (isCreativeRequest(command)) {
        try {
          const pre = this.kernelBridge.resolveCapability(command);
          const strong =
            (pre.matchedTerms?.length ?? 0) >= 2 &&
            (pre.score ?? 0) >= 1.0 &&
            /^(fs\.|repo\.)/.test(pre.tool?.id ?? '');
          if (!strong) return undefined;
        } catch {
          return undefined;
        }
      }
      // Conversational/social requests ("can you help me learn X", "what do
      // you think of X", "help me learn to code") belong to chat unless the
      // kernel has a strong, evidenced resolve. Observed live: "help me learn
      // data structures" planned desktop.close.exploit-database; "what do you
      // think of MARK" resolved media.now_playing at score 0.00; "help me
      // learn how to code" tried to open VS Code. These are chat intents —
      // the kernel must not act on coincidental word overlap.
      if (isConversationalRequest(command) || isExplanationRequest(command)) {
        try {
          const pre = this.kernelBridge.resolveCapability(command);
          const strong =
            (pre.matchedTerms?.length ?? 0) >= 2 &&
            (pre.score ?? 0) >= 0.8;
          if (!strong) return undefined;
        } catch {
          return undefined;
        }
      }
      // Discovery-question guard: "are there any playable videos", "is there
      // anything in the library", "do you have X" are availability checks —
      // they must resolve to read tools (find, list), never action tools
      // (play, launch, restart). Observed live: "are there any playable
      // videos" scored 2.32 against media.play_track because "playable"
      // stems to "play" and "video" appeared in the description.
      if (isDiscoveryQuestion(command)) {
        try {
          const pre = this.kernelBridge.resolveCapability(command);
          if (pre.tool && pre.tool.risk !== 'read' && pre.tool.risk !== 'diagnostic') {
            return undefined;
          }
        } catch {
          return undefined;
        }
      }
      // Real planner first for multi-word goals: composed DAG (investigate →
      // verify) beats linear single-tool execution when contracts validate.
      // Single-step fallback is automatic inside GoalExecutor.
      const wantsPlan = command.trim().split(/\s+/).length >= 3;
      outcome = await this.kernelBridge.executeGoal(command, contextInput, wantsPlan ? { usePlanner: true, maxPlanSteps: 4 } : undefined);
    } catch (err) {
      // Goal execution threw — kernel path unavailable, caller falls through.
      log.debug('Goal execution failed', { command, error: err instanceof Error ? err.message : String(err) });
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
      // Unbindable resolutions yield to reasoning for content requests: the
      // user wants words, and "say it with name: value" is the wrong answer
      // to a drafting goal. Tool-addressed goals keep the guidance.
      if (isContentRequest(command)) return undefined;
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
      // auto-saved: a stale write input replayed later could harm. And an
      // output carrying ok:false is a failure wearing a success status
      // (tools fail closed with output instead of throwing) — saving it
      // replays the failure forever. Observed live: a failed repo.symbols
      // probe memorized as a "known procedure".
      const outputOk = (result.output as Record<string, unknown> | undefined)?.ok !== false;
      const saveAttempt = outputOk ? this.maybeSaveSuccess(command, outcome.plan, outcome.resolution) : undefined;
      const savedId = saveAttempt?.id;
      if (!outputOk) trace.push('memory → not saved: output reports ok:false');
      if (savedId) trace.push(`memory → saved workflow ${savedId} (read-only success)`);
      if (outputOk && saveAttempt) {
        trace.push(
          savedId
            ? `memory → saved workflow ${savedId} (read-only success)`
            : `memory → not saved: ${saveAttempt.reason}`);
      }
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
      response: result.error ?? `Something went wrong running ${toolId}.`,
      route: 'kernel',
      trace: [...head, `kernel → error: ${result.error ?? 'unknown error'}`],
    };
  }

  /**
   * Saves a succeeded plan to workflow memory when it is safe to replay:
   * every step is read-only, resolution was strong (score ≥ 0.8 AND 2+
   * matched terms), and no near-duplicate goal is already saved.
   *
   * The resolution gate is the critical addition: without it, a coincidental
   * weak match (skill.list scoring against "what is in the library") gets
   * memorized and replays forever on semantically similar goals, poisoning
   * future sessions. Observed live: "show library" replayed skill.list.
   *
   * Never saves read-only successes for action goals ("play ..."): a lookup
   * step succeeding is not the goal succeeding, and the saved row would
   * replay as false success forever (observed live, twice).
   */
  private maybeSaveSuccess(
    command: string,
    plan: Awaited<ReturnType<MARKKernelBridge['executeGoal']>>['plan'],
    resolution?: { score: number; matchedTerms?: string[] },
  ): { id?: string; reason: string } {
    try {
      if (!plan || plan.steps.length === 0) return { reason: 'empty plan' };
      // Single-term goals ("hi", "status") execute fine but are never worth
      // memorizing: they are usually false-positive matches or too vague to
      // replay safely.
      if (extractGoalTerms(command).length < 2) return { reason: 'goal too vague (<2 terms)' };
      // Weak resolution: the tool ran but only because a thin coincidental
      // term overlap matched — not because it was the right tool for this
      // goal. Saving would replay the wrong tool on every similar future
      // command. Require score ≥ 0.8 AND at least 2 matched terms.
      const score = resolution?.score ?? 0;
      const matchedCount = resolution?.matchedTerms?.length ?? 0;
      if (score < 0.8 || matchedCount < 2) {
        return { reason: `weak resolve (${score.toFixed(2)} < 0.8 or <2 terms)` };
      }
      const risks = new Map(this.kernelBridge.listTools().map(tool => [tool.id, tool.risk] as const));
      const allReadOnly = plan.steps.every(step => {
        const risk = risks.get(step.toolId);
        return risk === 'read' || risk === 'diagnostic';
      });
      if (!allReadOnly) return { reason: 'not read-only' };
      if (ACTION_GOAL_RE.test(command)) return { reason: 'action goal (writes are never auto-saved)' };
      if (this.kernelBridge.recallWorkflows(command, 1, 0.9).length > 0) {
        return { reason: 'already memorized' };
      }
      return { id: this.kernelBridge.saveWorkflow(plan).id, reason: 'saved' };
    } catch (err) {
      // Workflow save failed — non-critical, proceed without saving.
      return { reason: `save failed (${err instanceof Error ? err.message : String(err)})` };
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
  return /\b(help me (understand|learn|know)|can you help (me )?(learn|understand|explain)|explain|what (is|are)|define|tell me (about|what|how|why)|how (does|do)|why (is|are|do))\b/i.test(command);
}

/**
 * Discovery / availability questions: the user asks whether something exists
 * or can be found — not to act on it. These must resolve to read tools only.
 * Observed live: "are there any playable videos" resolved media.play_track
 * (score 2.32) because "playable" stems to "play" and "video" appeared in
 * the description. The intent is media.find_tracks (a read tool), not play.
 *
 * Also covers container inspect intents: "access jarvis-db and show me what
 * is inside" resolved container.restart because "jarvis-db" verbatim hit the
 * id-anchor +2.0 bonus. "access", "inspect", "connect to" are read intents.
 */
function isDiscoveryQuestion(command: string): boolean {
  if (/^(are there|is there|do you have|can i find|do i have|are there any|is there any|any (playable|available|existing)|show me if|check if there)\b/i.test(command.trim())) return true;
  // Availability/seeking questions: "where can i get/download/find X",
  // "how can i get X" — asking where to OBTAIN something, not asking to
  // obtain it now (that would be an imperative: "download X to ~/docs").
  // Observed live: "where can i download a batman movie" resolved
  // media.play_video (score 1.80, matched: download, movie) and executed
  // a play attempt against the fully-bound whole-sentence title.
  if (/\b(where|how|what)\s+(can|could|do|do-you)\s+i\s+(get|find|download|obtain|buy|acquire|watch)\b/i.test(command.trim())) return true;
  // Container inspect: "access X", "connect to X", "inspect X", "show me what is inside X"
  if (/\b(access|inspect|connect to|look inside|show (me )?what('?s| is) (in|inside))\b/i.test(command)) return true;
  return false;
}

/**
 * Conversational / social intent: questions or requests that are clearly
 * directed at the assistant as a chat partner, not a tool executor.
 * Examples: "can you help me learn X", "what do you think of X",
 * "can you hack", "help me learn to code", "who is X".
 *
 * These must never trigger kernel plans on weak capability matches.
 * The kernel may still act when it has a strong, evidenced resolve
 * (score ≥ 0.8 AND 2+ matched terms), identical to the creative guard.
 */
function isConversationalRequest(command: string): boolean {
  return /\b(can you (help|explain|tell|show|teach)|help me (learn|understand|know|code|write|do|get|figure)|what do you (think|know|say)|who (is|are|was|were)\b|do you (think|know|remember)|i want to (learn|understand|know)|teach me|how do i learn|can you hack|are you able to)\b/i.test(command);
}

/**
 * Creative framings: the user wants original content, not a tool run.
 * Mechanical file ops ("write file with path:", "create directory") never
 * match — only composition words. Kernel may still claim when it has a
 * strong evidenced resolve (explicit fs/repo tool, 2+ terms, score ≥ 1).
 */
function isCreativeRequest(command: string): boolean {
  return /\b(compose|draft|homepage|landing page|blog( post)?|poem|short story|essay|markup)\b/i.test(command);
}

/**
 * A recalled plan is hollow for the current goal when its first step
 * declares inputs the goal never states AND fresh resolution is weak
 * (one thin match) or disagrees (different top tool): replaying would run
 * a tool the goal never evidenced. Input-less tools, evidenced replays,
 * and recalls no fresh resolution covers always run.
 */
/**
 * Goals that demand the world change (not just be observed). A read-only
 * plan can never satisfy one — shared by the hollow-reuse guard and the
 * workflow saver so both agree on what "doing" means.
 */
export const ACTION_GOAL_RE = /\b(play|launch|start|restart|stop|send|delete|remove|create|write|minimize|minimise|maximize|maximise|raise|open)\b/i;

export function isHollowReuse(  plan: { steps: Array<{ toolId: string; input?: Record<string, unknown> }> },
  command: string,
  tools: ToolDescriptor[],
  bind: (command: string, tool: ToolDescriptor) => { matchedFields: string[]; freeText?: boolean },
  fresh?: { tool?: { id: string }; matchedTerms?: string[] },
): boolean {
  const first = plan.steps[0];
  if (!first) return true;
  const tool = tools.find(candidate => candidate.id === first.toolId);
  if (!tool) return true;
  // Action goals need action tools: a plan of pure reads can never satisfy
  // "play ...", "restart ...", "send ..." no matter the scores. Replay
  // would report success without doing anything (observed live: a find_tracks
  // replay "succeeding" a play-music request). Risk levels decide, not text.
  if (ACTION_GOAL_RE.test(command)) {
    const risks = plan.steps.map(step => tools.find(candidate => candidate.id === step.toolId)?.risk);
    if (risks.length > 0 && risks.every(risk => risk === undefined || risk === 'read' || risk === 'diagnostic')) {
      return true;
    }
  }
  // Mirror image: question goals ("confirm if...", "is ...?", "what ...?")
  // need read tools. Replaying an action procedure for a question would act
  // when the user asked to know (observed live: a play_track replay answering
  // "confirm if any music is playing").
  if (/^(confirm|check|is|are|what|which|how many|how much|list|show|tell me)\b/i.test(command.trim()) || /\?\s*$/.test(command.trim())) {
    const risks = plan.steps.map(step => tools.find(candidate => candidate.id === step.toolId)?.risk);
    if (risks.some(risk => risk !== undefined && risk !== 'read' && risk !== 'diagnostic')) {
      return true;
    }
  }
  if (Object.keys(tool.inputSchema?.properties ?? {}).length === 0) return false;
  const goalLower = command.toLowerCase();
  const binding = (() => {
    try {
      return bind(command, tool);
    } catch (_err) {
      // bind() threw (e.g. malformed tool schema) — treat as not evidenced, allow reuse.
      return null;
    }
  })();
  if (!binding) return false;

  // Binding evidence must cover the plan's ESSENCE, not just its location.
  // The goal's object (what is searched/read/found) is the substance of the
  // task; WHERE (paths) may legitimately carry over from memory. Observed
  // live: the binder bound path="downloads" from a listing ask and replayed
  // a stored mp4-content search — old WHAT, new WHERE, wrong answer. Any
  // stored non-path, non-rebound value the goal never restates
  // → the recall is hollow for this goal; plan fresh instead.
  const rebound = new Set(binding.matchedFields ?? []);
  for (const step of plan.steps) {
    for (const [field, value] of Object.entries(step.input ?? {})) {
      if (typeof value !== 'string' || value.length === 0) continue;
      if (rebound.has(field)) continue;
      if (/^(?:\/|~|[a-z]:\\)/i.test(value)) continue; // file locations persist across goals
      if (goalLower.includes(value.toLowerCase())) continue; // goal restates the value
      return true; // stored essence the new goal never says: stale replay
    }
  }
  // Whole-goal query bindings ("query = the entire command") restate
  // trivially — the goal always contains itself — so they are not evidence.
  // When the stored plan rides on a free-text guess, fresh resolution must
  // agree on the tool anyway (observed live: "find thor in this pc" replayed
  // a music-library search while the resolver picked file search).
  if (binding.freeText && fresh?.tool) {
    return fresh.tool.id !== first.toolId || (fresh.matchedTerms?.length ?? 0) <= 1;
  }
  if (binding.matchedFields.length > 0) return false;
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
