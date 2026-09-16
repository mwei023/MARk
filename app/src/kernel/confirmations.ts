import { ActionRequest, KernelId } from './types';
import { createKernelId } from './execution-context';

export type ConfirmationStatus = 'pending' | 'approved' | 'denied';

export interface ConfirmationRecord {
  id: KernelId;
  toolId: KernelId;
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
}

export const confirmationManager = new ConfirmationManager();
