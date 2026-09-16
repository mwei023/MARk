import { ActionRequest, KernelId } from './types';
import { createKernelId } from './execution-context';

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
}

/**
 * Tracks explicit human grants for actions the authority profile marked
 * `require_confirmation`. Denied risk levels never produce a record —
 * there is nothing to confirm.
 *
 * Approval is bound to the exact tool + input snapshot so a grant cannot
 * be replayed against a different action.
 */
export class ConfirmationManager {
  private readonly records = new Map<KernelId, ConfirmationRecord>();

  request(action: ActionRequest, reason: string): ConfirmationRecord {
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
    this.records.set(record.id, record);
    return record;
  }

  resolve(confirmationId: KernelId, approved: boolean): ConfirmationRecord | undefined {
    const record = this.records.get(confirmationId);
    if (!record || record.status !== 'pending') return undefined;
    record.status = approved ? 'approved' : 'denied';
    record.decidedAt = new Date().toISOString();
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
}

export const confirmationManager = new ConfirmationManager();
