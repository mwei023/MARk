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
import { getPool } from '../db/postgres';

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

export interface ProposalDatabase {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, any>> }>;
}

/**
 * Process-local proposal cache backed by a durable Postgres table. Proposals
 * are also written as actions to the incident record for full auditability.
 *
 * The cache keeps the existing synchronous agent API, while the serialized
 * write queue makes create → approve/deny ordering durable. Startup/API
 * callers explicitly hydrate pending records before serving approvals.
 */
export class ProposalStore {
  private readonly proposals = new Map<string, ActionProposal>();
  private loadedFromDb = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly databaseClient?: ProposalDatabase) {}

  private database(): ProposalDatabase | null {
    if (this.databaseClient) return this.databaseClient;
    if (!config.databaseUrl) return null;
    return getPool();
  }

  private enqueue(task: () => Promise<void>): void {
    this.writeQueue = this.writeQueue.then(task, task);
  }

  /** Wait until all queued durable writes have settled. */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

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
    this.enqueue(() => this.persistProposal(proposal));
    return proposal;
  }

  /** Restore proposals before API reads or approval decisions. */
  async loadFromDatabase(limit = 500): Promise<number> {
    await this.flush();
    if (this.loadedFromDb) return this.listPending().length;
    const database = this.database();
    if (!database) return this.listPending().length;
    try {
      const result = await database.query(
        `SELECT id, incident_id, action, tool, input, rationale, risk_level,
                status, created_at, decided_at, decided_by, execution_result
           FROM action_proposals
          WHERE status = 'pending'
          ORDER BY created_at DESC
          LIMIT $1`,
        [limit],
      );
      for (const row of result.rows) {
        if (this.proposals.has(row.id)) continue;
        this.proposals.set(row.id, {
          id: row.id,
          incidentId: row.incident_id,
          action: row.action,
          tool: row.tool,
          input: row.input ?? {},
          rationale: row.rationale,
          riskLevel: row.risk_level,
          status: row.status,
          createdAt: new Date(row.created_at).toISOString(),
          decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : undefined,
          decidedBy: row.decided_by ?? undefined,
          executionResult: row.execution_result ?? undefined,
        });
      }
      this.loadedFromDb = true;
    } catch (error) {
      // Migrations may not have run in local/offline mode. Keep the cache
      // usable, but do not mark it loaded so a later boot can retry.
      console.debug('[ProposalStore] database restore skipped:', error instanceof Error ? error.message : String(error));
    }
    return this.listPending().length;
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
    this.enqueue(() => this.persistDecision(proposal));
    return proposal;
  }

  /** Deny a proposal. */
  deny(proposalId: string, decidedBy: 'api'): ActionProposal | undefined {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return undefined;
    proposal.status = 'denied';
    proposal.decidedAt = new Date().toISOString();
    proposal.decidedBy = decidedBy;
    this.enqueue(() => this.persistDecision(proposal));
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
    this.enqueue(() => this.persistDecision(proposal));
    return proposal;
  }

  /** Record the result of an executed proposal. */
  recordExecution(proposalId: string, result: string): ActionProposal | undefined {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return undefined;
    proposal.status = 'executed';
    proposal.executionResult = result;
    this.enqueue(() => this.persistDecision(proposal));
    return proposal;
  }

  private async persistProposal(proposal: ActionProposal): Promise<void> {
    const database = this.database();
    if (!database) return;
    try {
      await database.query(
        `INSERT INTO action_proposals
          (id, incident_id, action, tool, input, rationale, risk_level, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO NOTHING`,
        [proposal.id, proposal.incidentId, proposal.action, proposal.tool,
          JSON.stringify(proposal.input), proposal.rationale, proposal.riskLevel,
          proposal.status, proposal.createdAt],
      );
    } catch (error) {
      console.debug('[ProposalStore] proposal persistence skipped:', error instanceof Error ? error.message : String(error));
    }
  }

  private async persistDecision(proposal: ActionProposal): Promise<void> {
    const database = this.database();
    if (!database) return;
    try {
      await database.query(
        `UPDATE action_proposals
            SET status = $2, decided_at = $3, decided_by = $4, execution_result = $5
          WHERE id = $1`,
        [proposal.id, proposal.status, proposal.decidedAt ?? null, proposal.decidedBy ?? null, proposal.executionResult ?? null],
      );
    } catch (error) {
      console.debug('[ProposalStore] proposal decision persistence skipped:', error instanceof Error ? error.message : String(error));
    }
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
