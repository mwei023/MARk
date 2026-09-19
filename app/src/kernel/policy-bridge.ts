import {
  AuthorityManager,
  authorityManager,
} from './authority';
import {
  DecisionPolicy,
  PolicyContext,
  policyEngine,
} from '../core/policies';
import { ToolRisk } from './types';

export interface UnifiedDecision {
  decision: DecisionPolicy;
  reason: string;
}

/**
 * Maps an agent-level action name to kernel risk. This is the single
 * vocabulary both engines share: agents think in actions, the kernel
 * thinks in risk, and this table is the translation.
 */
export function agentActionRisk(action: string): ToolRisk {
  const normalized = (action || '').toLowerCase();
  if (normalized.includes('health_check') || normalized.includes('gather_logs') || normalized.includes('fetch_')) {
    return 'read';
  }
  if (normalized.includes('diagnos') || normalized.includes('check_') || normalized.includes('triage') || normalized.includes('suggest_')) {
    return 'diagnostic';
  }
  if (normalized.includes('restart')) {
    return 'reversible';
  }
  if (normalized.includes('sudo') || normalized.includes('elevated') || normalized.includes('secret') ||
      normalized.includes('delete') || normalized.includes('drop_database')) {
    return 'privileged';
  }
  if (normalized.includes('install_dependency') || normalized.includes('patch_') ||
      normalized.includes('rollback') || normalized.includes('revert_') || normalized.includes('auto_fix')) {
    return 'mutating';
  }
  return 'mutating';
}

/**
 * One authority story: evaluates the agent PolicyEngine AND the kernel
 * AuthorityManager (default profile as the floor) and takes the stricter
 * of the two. Deny anywhere means deny everywhere; confirmation anywhere
 * means confirmation. Automatic only on double-allow.
 */
export function unifiedEvaluate(
  context: PolicyContext,
  authority: AuthorityManager = authorityManager,
  profileId = 'default',
): UnifiedDecision {
  const policyDecision = policyEngine.evaluate(context);
  const policyReason = policyEngine.getReason(context);

  const risk = agentActionRisk(context.action);
  const authorityResult = authority.evaluate(
    profileId,
    {
      id: `policy-${Date.now()}`,
      toolId: `agent.${context.action}`,
      input: {},
      requestedBy: context.agentName,
      createdAt: new Date().toISOString(),
    },
    {
      id: `agent.${context.action}`,
      name: context.action,
      description: `Agent action ${context.action}`,
      domain: 'agent',
      provider: 'agent-runtime',
      inputSchema: { type: 'object', properties: {}, required: [] },
      risk,
      requiredPermissions: [],
      supportedResourceKinds: ['unknown'],
      reversible: risk === 'read' || risk === 'diagnostic' || risk === 'reversible',
      available: true,
      metadata: {},
    },
  );
  const authorityDecision: DecisionPolicy =
    authorityResult.decision === 'allow'
      ? 'auto'
      : authorityResult.decision === 'require_confirmation'
        ? 'confirm'
        : 'block';

  const rank = (decision: DecisionPolicy): number =>
    decision === 'block' ? 3 : decision === 'confirm' || decision === 'alert' ? 2 : 1;
  if (rank(authorityDecision) >= rank(policyDecision)) {
    return {
      decision: authorityDecision,
      reason: `authority(${risk}): ${authorityResult.reason}`,
    };
  }
  return { decision: policyDecision, reason: policyReason };
}
