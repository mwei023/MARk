/**
 * Policies: Define what agents are allowed to do automatically.
 * Controls blast radius and safety for autonomous actions.
 */

export type DecisionPolicy = 'auto' | 'confirm' | 'alert' | 'block';

export interface PolicyRule {
  condition: (context: PolicyContext) => boolean; // Condition that triggers this rule
  decision: DecisionPolicy; // What to do: auto-execute, ask for confirmation, alert, or block
  reason: string; // Why this rule applies
}

export interface PolicyContext {
  agentName: string;
  action: string; // 'restart', 'rollback', 'revert', 'patch', etc
  risk: 'low' | 'medium' | 'high'; // Assessed risk level
  target?: string; // What's being acted on ('container', 'deployment', 'branch', etc)
  environment?: 'development' | 'staging' | 'production';
  isFirst?: boolean; // Is this the first attempt at fixing?
  previousAttempts?: number; // How many times has this been tried?
  affectedUsers?: number; // Rough estimate of impact
}

/**
 * Default Policy Engine: Conservative, suitable for learning phase.
 * Can be overridden per environment or through user config.
 */
export class PolicyEngine {
  private rules: PolicyRule[] = [];

  constructor() {
    this.initializeDefaultPolicies();
  }

  private initializeDefaultPolicies(): void {
    // ✅ Low-risk automatic actions
    this.addRule({
      condition: (ctx) => ctx.action === 'health_check' && ctx.risk === 'low',
      decision: 'auto',
      reason: 'Health checks are non-destructive',
    });

    this.addRule({
      condition: (ctx) => ctx.action === 'gather_logs' && ctx.risk === 'low',
      decision: 'auto',
      reason: 'Log gathering is non-destructive',
    });

    this.addRule({
      condition: (ctx) => ctx.action === 'restart' && ctx.risk === 'low' && ctx.environment === 'development',
      decision: 'auto',
      reason: 'Restart in dev is low impact',
    });

    this.addRule({
      condition: (ctx) => ctx.action === 'install_dependency' && Boolean(ctx.isFirst) && ctx.risk === 'low',
      decision: 'auto',
      reason: 'First attempt at required dependency install is reasonable',
    });

    // ⚠️ Medium-risk: ask for confirmation
    this.addRule({
      condition: (ctx) => ctx.action === 'restart' && ctx.environment === 'production',
      decision: 'confirm',
      reason: 'Production restart needs approval',
    });

    this.addRule({
      condition: (ctx) => ctx.action === 'rollback' && ctx.environment === 'production',
      decision: 'confirm',
      reason: 'Production rollback always needs approval',
    });

    this.addRule({
      condition: (ctx) => ctx.action === 'revert_commit' && ctx.environment === 'production',
      decision: 'confirm',
      reason: 'Reverting production commits needs approval',
    });

    this.addRule({
      condition: (ctx) => ctx.action === 'patch_code' && Boolean(ctx.previousAttempts) && ctx.previousAttempts! > 2,
      decision: 'confirm',
      reason: 'Multiple failed auto-fix attempts should be reviewed',
    });

    this.addRule({
      condition: (ctx) => ctx.action === 'delete' || ctx.action === 'drop_database',
      decision: 'confirm',
      reason: 'Destructive operations always need approval',
    });

    // 🚨 High-risk: alert, don\'t auto-execute
    this.addRule({
      condition: (ctx) => ctx.action === 'restart' && Boolean(ctx.affectedUsers) && (ctx.affectedUsers ?? 0) > 100,
      decision: 'alert',
      reason: 'Restart affecting many users should be alerted',
    });

    this.addRule({
      condition: (ctx) => ctx.risk === 'high',
      decision: 'alert',
      reason: 'High-risk actions always trigger alert',
    });

    // 🔒 Blocked actions
    this.addRule({
      condition: (ctx) => ctx.action === 'sudo' || ctx.action === 'elevated',
      decision: 'block',
      reason: 'Elevated commands are blocked',
    });

    this.addRule({
      condition: (ctx) => ctx.action === 'access_secrets' || ctx.action === 'export_secrets',
      decision: 'block',
      reason: 'Secret access is blocked',
    });
  }

  private addRule(rule: PolicyRule): void {
    this.rules.push(rule);
  }

  /**
   * Evaluate what decision to make for a proposed action
   */
  evaluate(context: PolicyContext): DecisionPolicy {
    // Most specific rule wins (rules are checked in order they were added)
    for (let i = this.rules.length - 1; i >= 0; i--) {
      if (this.rules[i].condition(context)) {
        return this.rules[i].decision;
      }
    }

    // Default: ask for confirmation if no rule matches
    return 'confirm';
  }

  /**
   * Check if action is allowed at all
   */
  isAllowed(context: PolicyContext): boolean {
    return this.evaluate(context) !== 'block';
  }

  /**
   * Check if action can execute without approval
   */
  isAutomatic(context: PolicyContext): boolean {
    return this.evaluate(context) === 'auto';
  }

  /**
   * Check if action needs user approval
   */
  needsApproval(context: PolicyContext): boolean {
    const decision = this.evaluate(context);
    return decision === 'confirm' || decision === 'alert';
  }

  /**
   * Get human-readable reason for decision
   */
  getReason(context: PolicyContext): string {
    for (let i = this.rules.length - 1; i >= 0; i--) {
      if (this.rules[i].condition(context)) {
        return this.rules[i].reason;
      }
    }
    return 'No specific rule matched';
  }
}

// Singleton
export const policyEngine = new PolicyEngine();
