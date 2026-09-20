import {
  ActionRequest,
  ActionResult,
  ExecutionContext,
  ToolDescriptor,
} from './types';

import {
  CapabilityResolution,
  RankedCapability,
} from './capability-resolver';
import { getLLMProviderCached, Message } from '../llm';

import {
  TaskBinder,
  TaskBinding,
} from './task-binder';

import {
  ExecutionPlan,
  PlanValidationResult,
} from './planner';

export interface GoalExecutionOptions {
  usePlanner?: boolean;
  /** Max steps for a multi-step plan (default 4). Caps autonomy per goal. */
  maxPlanSteps?: number;
}

export interface GoalExecutionResult {
  goal: string;
  resolution: CapabilityResolution;
  binding?: TaskBinding;
  plan?: ExecutionPlan;
  validation?: PlanValidationResult;
  action?: ActionRequest;
  result?: ActionResult;
  /** Full multi-step report when usePlanner executes a DAG. */
  planReport?: import('./planner').PlanExecutionReport;
  /** How the goal was executed: single tool vs multi-step plan. */
  executionMode?: 'single' | 'plan';
}

export interface GoalExecutionDependencies {
  resolveCapability: (goal: string) => CapabilityResolution;
  resolveAll?: (goal: string) => RankedCapability[];
  /** Ungated floor-passing candidates for LLM arbitration. */
  resolveCandidates?: (goal: string) => RankedCapability[];
  bindTask: (
    goal: string,
    tool: ToolDescriptor,
  ) => TaskBinding;
  bindTaskSmart?: (
    goal: string,
    tool: ToolDescriptor,
  ) => Promise<TaskBinding>;
  arbitrate?: (
    goal: string,
    tools: ToolDescriptor[],
  ) => Promise<ToolDescriptor | null>;
  execute: (
    action: ActionRequest,
    context: ExecutionContext,
  ) => Promise<ActionResult>;
  planGoal?: (goal: string) => ExecutionPlan;
  validatePlan?: (plan: ExecutionPlan) => PlanValidationResult;
  /** Multi-step composer (metadata compatibility chains). Absent = single-step only. */
  planComposedGoal?: (goal: string) => ExecutionPlan;
  /** Structured DAG executor. Absent = single-step only even with usePlanner. */
  executePlanReport?: (
    plan: ExecutionPlan,
    context: ExecutionContext,
  ) => Promise<import('./planner').PlanExecutionReport>;
}

export class GoalExecutor {
  constructor(
    private readonly dependencies: GoalExecutionDependencies,
  ) {}

  async executeGoal(
    goal: string,
    context: ExecutionContext,
    options: GoalExecutionOptions = {},
  ): Promise<GoalExecutionResult> {
    const plan = this.dependencies.planGoal
      ? this.dependencies.planGoal(goal)
      : undefined;

    const validation =
      plan && this.dependencies.validatePlan
        ? this.dependencies.validatePlan(plan)
        : undefined;

    // Real planner path: stops linear single-tool execution. When the caller
    // opts in (usePlanner), try a composed multi-step DAG first. The composed
    // plan is validated by contracts; only a valid 2+ step plan executes as
    // a DAG. Anything else falls through to the single-tool path below, so
    // this never breaks existing callers.
    if (options.usePlanner && this.dependencies.planComposedGoal && this.dependencies.executePlanReport) {
      try {
        const composed = this.dependencies.planComposedGoal(goal);
        const maxSteps = Math.max(options.maxPlanSteps ?? 4, 1);
        const trimmed: ExecutionPlan = composed.steps.length > maxSteps
          ? { ...composed, steps: composed.steps.slice(0, maxSteps) }
          : composed;
        const composedValidation = this.dependencies.validatePlan
          ? this.dependencies.validatePlan(trimmed)
          : undefined;
        if (composedValidation?.valid && trimmed.steps.length > 1) {
          const planReport = await this.dependencies.executePlanReport(trimmed, context);
          const resolution = this.dependencies.resolveCapability(goal);
          return {
            goal,
            resolution,
            plan: trimmed,
            validation: composedValidation,
            planReport,
            executionMode: 'plan',
          };
        }
      } catch (err) {
        // Planner path is best-effort: fall through to single-tool execution.
        console.debug('[goal-execution] composed plan path failed:', err instanceof Error ? err.message : String(err));
      }
    }

    const resolution = this.dependencies.resolveCapability(goal);

    if (!resolution.tool) {
      return {
        goal,
        resolution,
        plan,
        validation,
      };
    }

    // Candidate loop: the top-ranked tool is not always the right one (a
    // music search can outrank a code search on one shared verb). Prefer
    // the first candidate whose inputs bind with real evidence from the
    // goal; fall back to smart binding, then to the honest top-pick report.
    const ranked = this.dependencies.resolveAll
      ? this.dependencies.resolveAll(goal).slice(0, 4)
      : [];
    const candidates: ToolDescriptor[] = [];
    for (const candidate of ranked) {
      if (!candidates.some(known => known.id === candidate.tool.id)) candidates.push(candidate.tool);
    }
    if (!candidates.some(known => known.id === resolution.tool!.id)) candidates.unshift(resolution.tool!);

    let fallback: { tool: ToolDescriptor; binding: TaskBinding } | undefined;
    const guessed: Array<{ tool: ToolDescriptor; binding: TaskBinding }> = [];
    for (const tool of candidates) {
      const attempt = this.dependencies.bindTask(goal, tool);
      if (!fallback && attempt.complete) fallback = { tool, binding: attempt };
      if (attempt.complete && attempt.matchedFields.length > 0 && !attempt.freeText) {
        return this.executeBound(goal, context, plan, validation, { ...resolution, tool, score: resolution.score, matchedTerms: resolution.matchedTerms }, attempt);
      }
      // Whole-goal guesses wait their turn in rank order: a guessed binding
      // must not jump ahead of an evidenced one (observed live: play_track's
      // guessed query beating now_playing), but among guesses rank still wins.
      // Genuine completions (including zero-match ones like status tools)
      // are decided after the smart section below, not here.
      if (attempt.complete && attempt.freeText) guessed.push({ tool, binding: attempt });
    }
    const smartGuessed: Array<{ tool: ToolDescriptor; binding: TaskBinding }> = [];

    if (this.dependencies.bindTaskSmart) {
      // Free-text fallback across candidates in rank order: one LLM
      // extraction round each for tools the goal actually names values for.
      // Arbitration first when nothing bound with evidence: the rank leader
      // can be the wrong tool (music search outranking code search on one
      // shared verb), so the model picks among floor-passing candidates.
      const smartGuessed: Array<{ tool: ToolDescriptor; binding: TaskBinding }> = [];
      if (process.env.MARK_SMART !== 'off' && this.dependencies.resolveCandidates) {
        // Arbitrate across the ungated floor-passers (gated ones included):
        // when nothing bound with evidence, rank order is already suspect.
        const pool = this.dependencies.resolveCandidates(goal).slice(0, 5);
        if (pool.length > 0) {
          const offered = pool.map(candidate => candidate.tool);
          const pick = this.dependencies.arbitrate
            ? await this.dependencies.arbitrate(goal, offered).catch(() => null)
            : await arbitrateTool(goal, offered);
          // Membership enforced even for injected arbitrators: only pooled
          // tools may run. Unknown picks fall through to the fallback below.
          if (pick && offered.some(tool => tool.id === pick.id)) {
            // An LLM pick still needs binding evidence: sync match wins
            // immediately, otherwise one smart round must find real values.
            // A pick with nothing bindable falls through to the loop below.
            // Guessed bindings (whole-goal text) wait like their sync kin.
            const arbitrated = this.dependencies.bindTask(goal, pick);
            if (arbitrated.complete && arbitrated.matchedFields.length > 0 && !arbitrated.freeText) {
              return this.executeBound(goal, context, plan, validation, { ...resolution, tool: pick }, arbitrated);
            }
            const smartArbitrated = await this.dependencies.bindTaskSmart(goal, pick);
            if (smartArbitrated.complete && smartArbitrated.matchedFields.length > 0 && !smartArbitrated.freeText) {
              return this.executeBound(goal, context, plan, validation, { ...resolution, tool: pick }, smartArbitrated);
            }
            if (smartArbitrated.complete && smartArbitrated.freeText) smartGuessed.push({ tool: pick, binding: smartArbitrated });
          }
        }
      }
      for (const tool of candidates) {
        const smart = await this.dependencies.bindTaskSmart(goal, tool);
        if (smart.complete && smart.matchedFields.length > 0 && !smart.freeText) {
          return this.executeBound(goal, context, plan, validation, { ...resolution, tool }, smart);
        }
        if (smart.complete && smart.freeText) smartGuessed.push({ tool, binding: smart });
        if (!fallback && smart.complete) fallback = { tool, binding: smart };
        if (!fallback) fallback = { tool, binding: smart };
      }
    }

    // Decision table (rank preserved within each class): genuine completions
    // first (a zero-match status tool answers status questions), then sync
    // guesses, then smart guesses, then the legacy tail below. One exception:
    // an action goal is never satisfied by a zero-match read completion —
    // that is the hollow shape, so it yields to guesses and the tail.
    const actionGoal = /\b(play|launch|start|restart|stop|send|delete|remove|create|write)\b/i.test(goal);
    const fallbackHollow = !!fallback && fallback.binding.complete
      && fallback.binding.matchedFields.length === 0
      && actionGoal
      && (fallback.tool.risk === 'read' || fallback.tool.risk === 'diagnostic');
    if (fallback && fallback.binding.complete && !fallback.binding.freeText && !fallbackHollow) {
      const { tool, binding } = fallback;
      return this.executeBound(goal, context, plan, validation, { ...resolution, tool }, binding);
    }
    const allGuessed = [...guessed, ...smartGuessed];
    // A guessed read never satisfies an action goal either (same hollow
    // shape one level down): skip to genuinely actionable guesses.
    const actionableGuessed = actionGoal
      ? allGuessed.filter(g => g.tool.risk !== 'read' && g.tool.risk !== 'diagnostic')
      : allGuessed;
    const winner = actionableGuessed[0] as { tool: ToolDescriptor; binding: TaskBinding } | undefined;
    if (winner) {
      return this.executeBound(goal, context, plan, validation, { ...resolution, tool: winner.tool, score: resolution.score, matchedTerms: resolution.matchedTerms }, winner.binding);
    }

    if (fallback) {
      const { tool, binding } = fallback;
      if (binding.complete) {
        return this.executeBound(goal, context, plan, validation, { ...resolution, tool }, binding);
      }
      return { goal, resolution: { ...resolution, tool }, binding, plan, validation };
    }

    const binding = this.dependencies.bindTask(goal, resolution.tool);
    return { goal, resolution, binding, plan, validation };
  }

  private async executeBound(
    goal: string,
    context: ExecutionContext,
    plan: ExecutionPlan | undefined,
    validation: PlanValidationResult | undefined,
    resolution: CapabilityResolution,
    binding: TaskBinding,
  ): Promise<GoalExecutionResult> {
    const action: ActionRequest = {
      id: `ACT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      toolId: resolution.tool!.id,
      input: binding.input,
      requestedBy: context.userId,
      createdAt: new Date().toISOString(),
      metadata: {
        source: 'goal-execution',
        goal,
        resolutionScore: resolution.score,
        matchedTerms: resolution.matchedTerms,
        matchedInputFields: binding.matchedFields,
        ...(plan ? { planId: plan.id } : {}),
      },
    };

    const result = await this.dependencies.execute(
      action,
      context,
    );

    // Memory truth: a single action ran, so the memorisable procedure is
    // that single step — never the aspirational multi-step metadata plan.
    // (Saving unexecuted plans is how wrong mappings freeze into memory.)
    const executedPlan: ExecutionPlan = {
      id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      goal,
      steps: [
        {
          id: action.id,
          toolId: action.toolId,
          input: { ...binding.input },
        },
      ],
      successCriteria: [`${goal} accomplished`],
      explanation: `Executed ${action.toolId} for "${goal}".`,
    };

    return {
      goal,
      resolution,
      binding,
      plan: executedPlan,
      validation,
      action,
      result,
      executionMode: 'single',
    };
  }
}

/**
 * Picks the right tool among floor-passing candidates when ranking and
 * binding evidence disagree. The choice must be one of the candidates;
 * anything else (or any failure) yields null and the caller falls back.
 * Never throws.
 */
async function arbitrateTool(goal: string, tools: ToolDescriptor[]): Promise<ToolDescriptor | null> {
  try {
    if (tools.length === 0) return null;
    const timeoutMs = Number(process.env.MARK_LLM_TIMEOUT_MS ?? 30000);
    const provider = await withTimeout(getLLMProviderCached(), timeoutMs, 'LLM provider init');
    const catalog = tools
      .map(tool => `- ${tool.id}: ${tool.description.slice(0, 160)}`)
      .join('\n');
    const messages: Message[] = [
      {
        role: 'system',
        content: 'Pick the ONE tool that best fulfills the user goal. Reply with EXACTLY one JSON object, no other text: {"toolId": "exact id from the list"}. If none fits, reply {"toolId": null}.',
      },
      { role: 'user', content: `Goal: ${goal.slice(0, 500)}\n\nCandidates:\n${catalog}` },
    ];
    const response = await withTimeout(provider.chat(messages, { temperature: 0 }), timeoutMs, 'LLM arbitrate');
    const start = response.content.indexOf('{');
    const end = response.content.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const raw = JSON.parse(response.content.slice(start, end + 1)) as { toolId?: unknown };
    if (typeof raw.toolId !== 'string') return null;
    return tools.find(tool => tool.id === raw.toolId) ?? null;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}