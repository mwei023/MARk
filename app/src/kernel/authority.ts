import {
  ActionRequest,
  ToolDescriptor,
  ToolRisk,
} from './types';

export type AuthorityDecision =
  | 'allow'
  | 'deny'
  | 'require_confirmation';

export interface AuthorityRule {
  risk: ToolRisk;
  decision: AuthorityDecision;
}

export interface AuthorityProfile {
  id: string;
  name: string;
  description: string;
  rules: AuthorityRule[];
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowedProviders?: string[];
  metadata?: Record<string, unknown>;
}

export interface AuthorityEvaluation {
  decision: AuthorityDecision;
  profileId: string;
  reason: string;
  evaluatedAt: string;
}

const RISK_ORDER: ToolRisk[] = [
  'read',
  'diagnostic',
  'reversible',
  'mutating',
  'privileged',
  'financial',
];

export class AuthorityManager {
  private readonly profiles = new Map<string, AuthorityProfile>();

  registerProfile(profile: AuthorityProfile): void {
    this.profiles.set(profile.id, profile);
  }

  unregisterProfile(profileId: string): boolean {
    return this.profiles.delete(profileId);
  }

  getProfile(profileId: string): AuthorityProfile | undefined {
    return this.profiles.get(profileId);
  }

  listProfiles(): AuthorityProfile[] {
    return Array.from(this.profiles.values());
  }

  evaluate(
    profileId: string,
    action: ActionRequest,
    tool: ToolDescriptor,
  ): AuthorityEvaluation {
    const evaluatedAt = new Date().toISOString();
    const profile = this.profiles.get(profileId);

    if (!profile) {
      return {
        decision: 'deny',
        profileId,
        reason: `Authority profile "${profileId}" does not exist.`,
        evaluatedAt,
      };
    }

    if (
      profile.allowedDomains &&
      !profile.allowedDomains.includes(tool.domain)
    ) {
      return {
        decision: 'deny',
        profileId,
        reason: `Tool domain "${tool.domain}" is not allowed by profile "${profileId}".`,
        evaluatedAt,
      };
    }

    if (profile.deniedDomains?.includes(tool.domain)) {
      return {
        decision: 'deny',
        profileId,
        reason: `Tool domain "${tool.domain}" is explicitly denied.`,
        evaluatedAt,
      };
    }

    if (
      profile.allowedProviders &&
      !profile.allowedProviders.includes(tool.provider)
    ) {
      return {
        decision: 'deny',
        profileId,
        reason: `Tool provider "${tool.provider}" is not allowed.`,
        evaluatedAt,
      };
    }

    const rule = this.findRule(profile, tool.risk);

    if (!rule) {
      return {
        decision: 'deny',
        profileId,
        reason: `No authority rule exists for risk level "${tool.risk}".`,
        evaluatedAt,
      };
    }

    return {
      decision: rule.decision,
      profileId,
      reason: `Action "${action.id}" evaluated as "${tool.risk}" risk.`,
      evaluatedAt,
    };
  }

  private findRule(
    profile: AuthorityProfile,
    risk: ToolRisk,
  ): AuthorityRule | undefined {
    const exactRule = profile.rules.find(rule => rule.risk === risk);

    if (exactRule) {
      return exactRule;
    }

    const riskIndex = RISK_ORDER.indexOf(risk);

    return profile.rules
      .filter(rule => RISK_ORDER.indexOf(rule.risk) <= riskIndex)
      .sort(
        (left, right) =>
          RISK_ORDER.indexOf(right.risk) - RISK_ORDER.indexOf(left.risk),
      )[0];
  }
}

/**
 * Conservative default profile.
 *
 * Read-only and diagnostic operations are allowed.
 * Reversible operations require confirmation.
 * Mutating, privileged, and financial operations are denied until an
 * explicit authority profile is configured.
 */
export const defaultAuthorityProfile: AuthorityProfile = {
  id: 'default',
  name: 'Default MARK Authority',
  description: 'Conservative authority for initial kernel operation.',
  rules: [
    { risk: 'read', decision: 'allow' },
    { risk: 'diagnostic', decision: 'allow' },
    { risk: 'reversible', decision: 'require_confirmation' },
    { risk: 'mutating', decision: 'deny' },
    { risk: 'privileged', decision: 'deny' },
    { risk: 'financial', decision: 'deny' },
  ],
};

export const authorityManager = new AuthorityManager();

authorityManager.registerProfile(defaultAuthorityProfile);
