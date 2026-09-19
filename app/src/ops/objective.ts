/**
 * Persistent ops objective — the long-lived goal behind the operations agent.
 *
 * Webhooks are episodic; the objective is not. Every incident investigation,
 * fix proposal, verification, and escalation is recorded here so the agent
 * can answer "what am I trying to do, and how am I doing?" without an LLM.
 *
 * Backed by in-memory counters (always available, deterministic, testable).
 * DB-backed learning (ops-memory, repo baselines) stays where it is; this
 * module aggregates the live picture and formats it for findings and
 * GET /api/status/ops.
 */

export type OpsObjectiveEvent =
  | 'incident.seen'
  | 'incident.investigated'
  | 'incident.fix_proposed'
  | 'incident.fix_verified'
  | 'incident.fix_failed'
  | 'incident.escalated'
  | 'incident.resolved';

export interface OpsObjectiveSnapshot {
  objective: string;
  incidentsSeen: number;
  investigated: number;
  fixesProposed: number;
  fixesVerified: number;
  fixesFailed: number;
  escalations: number;
  resolved: number;
  lastEventAt: string | null;
  verificationRate: number;
}

const OBJECTIVE_TEXT =
  'Keep monitored repos green: investigate every failure with real evidence, ' +
  'propose minimal verified fixes, escalate openly when verification fails.';

class OpsObjective {
  private counts: Record<OpsObjectiveEvent, number> = {
    'incident.seen': 0,
    'incident.investigated': 0,
    'incident.fix_proposed': 0,
    'incident.fix_verified': 0,
    'incident.fix_failed': 0,
    'incident.escalated': 0,
    'incident.resolved': 0,
  };
  private lastEventAt: string | null = null;

  record(event: OpsObjectiveEvent): void {
    this.counts[event] += 1;
    try {
      this.lastEventAt = new Date().toISOString();
    } catch {
      this.lastEventAt = null;
    }
  }

  snapshot(): OpsObjectiveSnapshot {
    const proposed = this.counts['incident.fix_proposed'];
    const verified = this.counts['incident.fix_verified'];
    return {
      objective: OBJECTIVE_TEXT,
      incidentsSeen: this.counts['incident.seen'],
      investigated: this.counts['incident.investigated'],
      fixesProposed: proposed,
      fixesVerified: verified,
      fixesFailed: this.counts['incident.fix_failed'],
      escalations: this.counts['incident.escalated'],
      resolved: this.counts['incident.resolved'],
      lastEventAt: this.lastEventAt,
      verificationRate: proposed === 0 ? 0 : verified / proposed,
    };
  }

  /** One-line status for incident findings and CLI. */
  describe(): string {
    const s = this.snapshot();
    return (
      `Objective: ${s.objective} ` +
      `(seen ${s.incidentsSeen}, investigated ${s.investigated}, ` +
      `fixes ${s.fixesVerified}/${s.fixesProposed} verified, ` +
      `resolved ${s.resolved}, escalated ${s.escalations})`
    );
  }

  /** Test-only reset. */
  reset(): void {
    for (const key of Object.keys(this.counts) as OpsObjectiveEvent[]) {
      this.counts[key] = 0;
    }
    this.lastEventAt = null;
  }
}

export const opsObjective = new OpsObjective();
