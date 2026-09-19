/**
 * Like-Me Loop (Phase 1): OpenCode-style permission gate + plan/build split.
 *
 * Wraps the existing MARK kernel bridge + PolicyEngine + AuthorityManager:
 * - plan mode: read-only, never executes mutating tools (authority `default`)
 * - build mode: executes via `workspace` profile, mutating steps pause for
 *   explicit confirmation and are auditable/undoable via confirmation records.
 */
import {
  MARKKernelBridge,
  markKernelBridge,
} from '../kernel/bridge';
import { config } from '../config.js';
import {
  AuthorityManager,
  authorityManager,
} from '../kernel/authority';
import {
  ConfirmationManager,
  confirmationManager,
} from '../kernel/confirmations';
import {
  ExecutionPlan,
  PlanValidationResult,
} from '../kernel/planner';
import {
  PolicyEngine,
  policyEngine,
  PolicyContext,
} from './policies';
import { ToolRisk } from '../kernel/types';

export type LikeMeMode = 'plan' | 'build';
export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface PermissionGateConfig {
  defaultAction: PermissionAction;
  rules: Array<{ pattern: string; action: PermissionAction }>;
}

/** Minimal glob: `*` matches anything, otherwise substring match. */
export function matchGlob(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value.includes(pattern);
  const escaped = pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`).test(value);
}

export class PermissionGate {
  constructor(private readonly config: PermissionGateConfig) {}

  evaluate(toolId: string, input: Record<string, unknown> = {}): PermissionAction {
    const haystack = `${toolId} ${JSON.stringify(input)}`;
    let decision = this.config.defaultAction;
    for (const rule of this.config.rules) {
      if (matchGlob(rule.pattern, toolId) || matchGlob(rule.pattern, haystack)) {
        decision = rule.action;
      }
    }
    return decision;
  }
}

export const defaultPermissionGate = new PermissionGate({
  defaultAction: 'ask',
  rules: [
    { pattern: 'system.machine_info', action: 'allow' },
    { pattern: 'system.file_read', action: 'allow' },
    { pattern: 'system.process_list', action: 'allow' },
    { pattern: 'system.disk_usage', action: 'allow' },
    { pattern: 'system.network_interfaces', action: 'allow' },
    { pattern: 'git status*', action: 'allow' },
    { pattern: 'git log*', action: 'allow' },
    { pattern: 'git diff*', action: 'allow' },
    { pattern: 'rm -rf*', action: 'deny' },
    { pattern: '*sudo*', action: 'deny' },
    { pattern: '*secret*', action: 'deny' },
  ],
});

export interface LikeMeStepPreview {
  stepId: string;
  toolId: string;
  risk: ToolRisk | 'unknown';
  authority: 'allow' | 'deny' | 'require_confirmation';
  policy: 'auto' | 'confirm' | 'alert' | 'block';
  needsConfirm: boolean;
  blocked: boolean;
}

export interface LikeMePlanPreview {
  goal: string;
  mode: LikeMeMode;
  plan: ExecutionPlan;
  validation: PlanValidationResult;
  steps: LikeMeStepPreview[];
  canExecuteWithoutConfirm: boolean;
}

export interface LikeMeLoopDependencies {
  bridge?: MARKKernelBridge;
  policies?: PolicyEngine;
  authority?: AuthorityManager;
  confirmations?: ConfirmationManager;
  gate?: PermissionGate;
}

function riskToPolicyAction(risk: ToolRisk): PolicyContext {
  if (risk === 'read' || risk === 'diagnostic') {
    return { agentName: 'like-me', action: 'gather_logs', risk: 'low' };
  }
  if (risk === 'reversible') {
    return { agentName: 'like-me', action: 'patch_code', risk: 'medium' as never };
  }
  return { agentName: 'like-me', action: 'patch_code', risk: 'high' };
}

export class LikeMeLoop {
  private readonly bridge: MARKKernelBridge;
  private readonly policies: PolicyEngine;
  private readonly authority: AuthorityManager;
  private readonly confirmations: ConfirmationManager;
  private readonly gate: PermissionGate;
  private readonly history: Array<{ goal: string; mode: LikeMeMode; at: string }> = [];

  constructor(deps: LikeMeLoopDependencies = {}) {
    this.bridge = deps.bridge ?? markKernelBridge;
    this.policies = deps.policies ?? policyEngine;
    this.authority = deps.authority ?? authorityManager;
    this.confirmations = deps.confirmations ?? confirmationManager;
    this.gate = deps.gate ?? defaultPermissionGate;
  }

  async ensureInit(): Promise<void> {
    await this.bridge.initialize();
  }

  preview(goal: string, mode: LikeMeMode = 'plan'): LikeMePlanPreview {
    // No goal-sniffing here by design: the kernel resolver picks the tool
    // from discovered metadata (per-app and per-container descriptors carry
    // their own names), and inputs bind from explicit values. Whatever the
    // plan cannot bind is reported honestly as a validation error.
    const plan = this.bridge.planGoal(goal);
    return this.describePlan(goal, mode, plan);
  }

  /**
   * Smart preview: metadata planning first, LLM proposal (validator-guarded)
   * when metadata yields nothing. Async — needs the model round trip.
   */
  async previewSmart(goal: string, mode: LikeMeMode = 'plan'): Promise<LikeMePlanPreview & { planSource: 'metadata' | 'llm' }> {
    const smart = await this.bridge.planGoalSmart(goal);
    if (!smart) {
      const fallback = this.describePlan(goal, mode, this.bridge.planGoal(goal));
      return { ...fallback, planSource: 'metadata' };
    }
    const described = this.describePlan(goal, mode, smart.plan);
    return { ...described, planSource: smart.source };
  }

  private describePlan(goal: string, mode: LikeMeMode, plan: ExecutionPlan): LikeMePlanPreview {
    const validation = this.bridge.validatePlan(plan);
    const tools = new Map(this.bridge.listTools().map(tool => [tool.id, tool]));
    const profileId = mode === 'plan' ? 'default' : 'workspace';

    const steps: LikeMeStepPreview[] = plan.steps.map(step => {
      const tool = tools.get(step.toolId as string);
      const risk = tool?.risk ?? 'unknown';
      const gateDecision = this.gate.evaluate(step.toolId as string, step.input);

      if (mode === 'plan' && (risk === 'mutating' || risk === 'privileged' || risk === 'financial' || risk === 'reversible')) {
        return {
          stepId: step.id,
          toolId: step.toolId as string,
          risk,
          authority: 'deny',
          policy: 'block',
          needsConfirm: false,
          blocked: true,
        };
      }

      if (gateDecision === 'deny') {
        return {
          stepId: step.id,
          toolId: step.toolId as string,
          risk,
          authority: 'deny',
          policy: 'block',
          needsConfirm: false,
          blocked: true,
        };
      }

      if (!tool) {
        return {
          stepId: step.id,
          toolId: step.toolId as string,
          risk,
          authority: 'deny',
          policy: 'block',
          needsConfirm: false,
          blocked: true,
        };
      }

      const action = {
        id: step.id,
        toolId: step.toolId,
        input: step.input,
        requestedBy: 'like-me',
        createdAt: new Date().toISOString(),
      };
      const authority = this.authority.evaluate(profileId, action as never, tool);
      const policy = this.policies.evaluate(riskToPolicyAction(tool.risk));
      const needsConfirm =
        gateDecision === 'ask' ||
        authority.decision === 'require_confirmation' ||
        policy === 'confirm' ||
        policy === 'alert';

      return {
        stepId: step.id,
        toolId: step.toolId as string,
        risk: tool.risk,
        authority: authority.decision,
        policy,
        needsConfirm,
        blocked: authority.decision === 'deny' || policy === 'block',
      };
    });

    return {
      goal,
      mode,
      plan,
      validation,
      steps,
      canExecuteWithoutConfirm: steps.every(step => !step.needsConfirm && !step.blocked),
    };
  }

  async execute(
    goal: string,
    opts: { mode?: LikeMeMode; userId?: string; source?: 'api' | 'cli' | 'voice'; smart?: boolean } = {},
  ) {
    const mode = opts.mode ?? 'build';
    await this.ensureInit();
    const preview = opts.smart
      ? await this.previewSmart(goal, mode)
      : this.preview(goal, mode);

    if (mode === 'plan') {
      this.history.push({ goal, mode, at: new Date().toISOString() });
      return { preview, executed: false as const, report: null };
    }

    const report = await this.bridge.executePlanWithReport(preview.plan, {
      userId: opts.userId ?? config.defaultUser,
      source: opts.source ?? 'api',
    } as never);
    this.history.push({ goal, mode, at: new Date().toISOString() });
    return {
      preview,
      executed: true as const,
      report,
      pendingConfirmations: this.confirmations.listPending(),
    };
  }

  listPending() {
    return this.confirmations.listPending();
  }

  approve(confirmationId: string, approved: boolean, opts: { trust?: 'tool' | 'root' } = {}) {
    const record = this.confirmations.resolve(confirmationId as never, approved);
    // One-click standing grants: approving also records "allow always"
    // (tool) or "allow in this project root" (tool + request directory).
    if (record && approved && opts.trust) {
      const scope = opts.trust === 'root' ? record.scopePath : undefined;
      try {
        this.bridge.trustTool(record.toolId as string, config.defaultUser, scope);
      } catch { /* approval stands even if the grant fails to persist */ }
    }
    return record;
  }

  /**
   * Approve AND resume: resolves the confirmation, applies any one-click
   * trust grant, then re-executes the blocked action and returns its
   * outcome. This is what interactive approve commands should call —
   * bare approve() leaves the action blocked and the user in a retry loop.
   */
  async approveAndResume(
    confirmationId: string,
    userId: string = config.defaultUser,
    opts: { trust?: 'tool' | 'root' } = {},
  ): Promise<{ record: unknown; result: unknown } | undefined> {
    const pending = this.confirmations.listPending();
    const target = pending.find(r => (r.id as string) === confirmationId)
      ?? this.confirmations.findByAction(confirmationId);
    if (!target) return undefined;
    if (opts.trust) {
      const scope = opts.trust === 'root' ? target.scopePath : undefined;
      try {
        this.bridge.trustTool(target.toolId as string, userId, scope);
      } catch { /* approval stands even if the grant fails to persist */ }
    }
    return this.bridge.approveAndResume(target.id as never, userId);
  }

  trust(pattern: string) {
    return this.bridge.trustTool(pattern, config.defaultUser);
  }

  untrust(pattern: string) {
    return this.bridge.untrustTool(pattern);
  }

  listTrusted() {
    return this.bridge.listTrustedTools();
  }

  suggestTrust() {
    return this.bridge.suggestTrust();
  }

  /**
   * Forgiving approval lookup: exact confirmation id, blocked action id,
   * id prefix, tool-name substring, or — when exactly one confirmation is
   * pending — that one. Users paste whatever the transcript showed them.
   */
  resolveApproval(text: string):
    | { kind: 'record'; record: NonNullable<ReturnType<ConfirmationManager['get']>> }
    | { kind: 'ambiguous'; candidates: ReturnType<ConfirmationManager['listPending']> }
    | { kind: 'none'; pending: ReturnType<ConfirmationManager['listPending']> } {
    const pending = this.confirmations.listPending();
    const needle = (text ?? '').trim();
    if (!needle) return { kind: 'none', pending };

    const exact = this.confirmations.get(needle as never);
    if (exact) return { kind: 'record', record: exact };

    const byAction = this.confirmations.findByAction(needle);
    if (byAction) return { kind: 'record', record: byAction };

    const searched = this.confirmations.searchPending(needle);
    if (searched.length === 1) return { kind: 'record', record: searched[0] };
    if (searched.length > 1) return { kind: 'ambiguous', candidates: searched };

    if (pending.length === 1) return { kind: 'record', record: pending[0] };
    return { kind: 'none', pending };
  }

  recentHistory() {
    return [...this.history];
  }
}

export const likeMeLoop = new LikeMeLoop();
