import { ActionRequest, KernelId } from './types';
import { createKernelId } from './execution-context';
import { getPool } from '../db/postgres';
import { TrustStore, trustStore } from './trust';

export type ConfirmationStatus = 'pending' | 'approved' | 'denied';

export interface ConfirmationRecord {
  id: KernelId;
  toolId: KernelId;
  /** The blocked action this confirmation gates (stable across sessions in logs). */
  actionId: KernelId;
  input: Record<string, unknown>;
  requestedBy: string;
  reason: string;
  status: ConfirmationStatus;
  createdAt: string;
  decidedAt?: string;
  /** Execution working directory at request time — enables root-scoped grants. */
  scopePath?: string;
}

/**
 * Tracks explicit human grants for actions the authority profile marked
 * `require_confirmation`. Denied risk levels never produce a record —
 * there is nothing to confirm.
 *
 * Approval is bound to the exact tool + input snapshot so a grant cannot
 * be replayed against a different action. Records persist best-effort to
 * Postgres (`kernel_confirmations`) so approvals survive restarts.
 */
export class ConfirmationManager {
  private readonly records = new Map<KernelId, ConfirmationRecord>();
  private loadedFromDb = false;

  constructor(private readonly trust: TrustStore = trustStore) {}

  request(action: ActionRequest, reason: string, scopePath?: string): ConfirmationRecord {
    const record: ConfirmationRecord = {
      id: createKernelId('confirm'),
      toolId: action.toolId,
      actionId: action.id,
      input: { ...action.input },
      requestedBy: action.requestedBy,
      reason,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    if (scopePath) record.scopePath = scopePath;
    this.records.set(record.id, record);
    void this.persistRecord(record);
    return record;
  }

  resolve(confirmationId: KernelId, approved: boolean): ConfirmationRecord | undefined {
    const record = this.records.get(confirmationId);
    if (!record || record.status !== 'pending') return undefined;
    record.status = approved ? 'approved' : 'denied';
    record.decidedAt = new Date().toISOString();
    if (!approved) this.trust.recordApprovalResolved(record.toolId, false);
    void this.persistDecision(record);
    return record;
  }

  get(confirmationId: KernelId): ConfirmationRecord | undefined {
    return this.records.get(confirmationId);
  }

  /** True only for an approved record matching this exact action. */
  isApprovedFor(confirmationId: KernelId, action: ActionRequest): boolean {
    const record = this.records.get(confirmationId);
    if (!record || record.status !== 'approved') return false;
    if (record.toolId !== action.toolId) return false;
    return JSON.stringify(record.input) === JSON.stringify(action.input ?? {});
  }

  listPending(): ConfirmationRecord[] {
    return Array.from(this.records.values()).filter(r => r.status === 'pending');
  }

  /** Finds a confirmation by the blocked action id (users paste those). */
  findByAction(actionId: string): ConfirmationRecord | undefined {
    const needle = actionId.trim().toLowerCase();
    if (!needle) return undefined;
    for (const record of this.records.values()) {
      if (record.actionId.toLowerCase() === needle || record.id.toLowerCase() === needle) {
        return record;
      }
    }
    // Forgiving prefix match: "confirm_mu4n" is enough when unambiguous.
    const prefixed = Array.from(this.records.values()).filter(
      record =>
        record.id.toLowerCase().startsWith(needle) || record.actionId.toLowerCase().startsWith(needle),
    );
    return prefixed.length === 1 ? prefixed[0] : undefined;
  }

  /** Pending confirmations whose tool id or name contains the given text. */
  searchPending(text: string): ConfirmationRecord[] {
    const needle = text.toLowerCase().trim();
    if (!needle) return [];
    return this.listPending().filter(record => record.toolId.toLowerCase().includes(needle));
  }

  /** Best-effort load of pending confirmations (never throws). */
  async loadFromDatabase(limit = 100): Promise<number> {
    if (this.loadedFromDb) return this.listPending().length;
    try {
      /* getPool via static import */
      const result = await getPool().query(
        `SELECT id, tool_id, action_id, input, requested_by, reason, status, created_at, decided_at
         FROM kernel_confirmations WHERE status = 'pending' ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      for (const row of result.rows) {
        if (this.records.has(row.id)) continue;
        this.records.set(row.id, {
          id: row.id,
          toolId: row.tool_id,
          actionId: row.action_id,
          input: row.input ?? {},
          requestedBy: row.requested_by ?? 'unknown',
          reason: row.reason ?? '',
          status: row.status,
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
          decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : undefined,
        });
      }
      this.loadedFromDb = true;
      return this.listPending().length;
    } catch {
      return this.listPending().length;
    }
  }

  private async persistRecord(record: ConfirmationRecord): Promise<void> {
    try {
      /* getPool via static import */
      await getPool().query(
        `INSERT INTO kernel_confirmations (id, tool_id, action_id, input, requested_by, reason, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [record.id, record.toolId, record.actionId, JSON.stringify(record.input),
         record.requestedBy, record.reason, record.status, record.createdAt],
      );
    } catch {
      // Offline/tests: memory remains the source of truth.
    }
  }

  private async persistDecision(record: ConfirmationRecord): Promise<void> {
    try {
      /* getPool via static import */
      await getPool().query(
        `UPDATE kernel_confirmations SET status = $2, decided_at = $3 WHERE id = $1`,
        [record.id, record.status, record.decidedAt ?? new Date().toISOString()],
      );
    } catch {
      // Best-effort only.
    }
  }
}

export const confirmationManager = new ConfirmationManager();
