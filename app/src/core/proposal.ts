/**
 * ActionProposal — structured intent record written to an incident before
 * any mutating action executes.
 *
 * Design contract:
 * - Every mutating agent action MUST write a proposal first.
 * - Low-risk proposals can auto-execute when MARK_ENABLE_AUTOFIX=true.
 * - Medium/high-risk proposals always require explicit approval via
 *   POST /api/approve { incidentId, proposalId, approved: true }.
 * - In MARK_DRY_RUN mode, all proposals are recorded but never executed.
 * - A proposal is immutable after creation; its status is updated separately.
 */

import { appendFile } from 'fs/promises';
import { join } from 'path';
import { config } from '../config.js';

export type ProposalRisk = 'low' | 'medium' | 'high';
export type ProposalStatus = 'pending' | 'approved' | 'denied' | 'executed' | 'dry_run';

export interface ActionProposal {
  id: string;
  incidentId: string;
  /** Human-readable description of what will happen. */
  action: string;
  /** The tool or operation that will be called. */
  tool: string;
  /** Inputs the tool will receive — serialisable. */
  input: Record<string, unknown>;
  /** Why this action is being proposed. */
  rationale: string;
  riskLevel: ProposalRisk;
  status: ProposalStatus;
  createdAt: string;
  decidedAt?: string;
  /** Who or what approved/denied: 'auto' | 'api' | 'dry_run'. */
  decidedBy?: string;
  /** Result summary written back after execution. */
  executionResult?: string;
}

const AUDIT_LOG_PATH = join(__dirname, '../../audit.log');

/**
 * In-memory proposal store — proposals also written as actions to the
 * incident record in Postgres for full auditability.
 *
 * We keep proposals in memory (not a separate DB table) because:
 * 1. Their lifetime is bounded to an incident's active window.
 * 2. The incident's action log is the durable record.
 * A future phase can promote this to a DB table if needed.
 */
export class ProposalStore {
  private readonly proposals = new Map<string, ActionProposal>();

  /** Generate a short stable id. */
  private makeId(): string {
    return `PROP-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  /**
   * Create a new proposal. Returns the proposal immediately.
   * Callers must separately write it to the incident via incidentStore.addAction.
   */
  create(input: Omit<ActionProposal, 'id' | 'status' | 'createdAt'>): ActionProposal {
    const proposal: ActionProposal = {
      ...input,
      id: this.makeId(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  get(proposalId: string): ActionProposal | undefined {
    return this.proposals.get(proposalId);
  }

  listByIncident(incidentId: string): ActionProposal[] {
    return Array.from(this.proposals.values())
      .filter(p => p.incidentId === incidentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  listPending(): ActionProposal[] {
    return Array.from(this.proposals.values()).filter(p => p.status === 'pending');
  }

  /** Approve a proposal. Returns the updated proposal or undefined if not found/already decided. */
  approve(proposalId: string, decidedBy: 'auto' | 'api'): ActionProposal | undefined {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return undefined;
    proposal.status = 'approved';
    proposal.decidedAt = new Date().toISOString();
    proposal.decidedBy = decidedBy;
    return proposal;
  }

  /** Deny a proposal. */
  deny(proposalId: string, decidedBy: 'api'): ActionProposal | undefined {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return undefined;
    proposal.status = 'denied';
    proposal.decidedAt = new Date().toISOString();
    proposal.decidedBy = decidedBy;
    return proposal;
  }

  /** Mark a proposal as dry-run (would have executed, did not). */
  markDryRun(proposalId: string, wouldHave: string): ActionProposal | undefined {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return undefined;
    proposal.status = 'dry_run';
    proposal.decidedAt = new Date().toISOString();
    proposal.decidedBy = 'dry_run';
    proposal.executionResult = `WOULD HAVE: ${wouldHave}`;
    return proposal;
  }

  /** Record the result of an executed proposal. */
  recordExecution(proposalId: string, result: string): ActionProposal | undefined {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return undefined;
    proposal.status = 'executed';
    proposal.executionResult = result;
    return proposal;
  }

  /** Write a proposal decision to the audit log (best-effort). */
  async auditDecision(proposal: ActionProposal): Promise<void> {
    try {
      const entry = {
        ts: new Date().toISOString(),
        level: 'PROPOSAL_DECISION',
        proposalId: proposal.id,
        incidentId: proposal.incidentId,
        action: proposal.action,
        tool: proposal.tool,
        riskLevel: proposal.riskLevel,
        status: proposal.status,
        decidedBy: proposal.decidedBy,
        executionResult: proposal.executionResult,
      };
      await appendFile(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // Never propagate — audit log write is best-effort.
    }
  }
}

export const proposalStore = new ProposalStore();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Determine if a proposal should auto-execute without human approval.
 * Rules:
 * - MARK_DRY_RUN=true → never auto-execute (always dry_run)
 * - riskLevel = 'low' AND MARK_ENABLE_AUTOFIX=true → auto
 * - riskLevel = 'medium' | 'high' → always requires human approval
 */
export function shouldAutoExecute(riskLevel: ProposalRisk): boolean {
  if (config.markEnableAutofix && !isDryRun()) return riskLevel === 'low';
  return false;
}

/** True when MARK_DRY_RUN env flag is active. */
export function isDryRun(): boolean {
  return process.env.MARK_DRY_RUN === 'true' || process.env.MARK_DRY_RUN === '1';
}

/**
 * Format a proposal as a human-readable action detail string for the
 * incident action log.
 */
export function formatProposalAction(proposal: ActionProposal): string {
  return (
    `[PROPOSAL ${proposal.id}] ${proposal.action} ` +
    `(tool: ${proposal.tool}, risk: ${proposal.riskLevel}, status: ${proposal.status}) — ` +
    `${proposal.rationale}`
  );
}
