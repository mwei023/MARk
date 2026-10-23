/**
 * Confirmation dedupe: repeated failed plans must reuse the same pending
 * ask for an identical unchanged action instead of minting a fresh one
 * every attempt (observed live: the failed Blender plan minted new
 * confirmation records on each retry, flooding the approvals panel).
 */
import { describe, it, expect } from 'vitest';
import { ConfirmationManager } from './confirmations';
import { ActionRequest } from './types';

const mkAction = (input: Record<string, unknown>): ActionRequest => ({
  id: `action_${JSON.stringify(input).slice(5, 20)}` as ActionRequest['id'],
  toolId: 'desktop.open.simplescreenrecorder',
  input,
  requestedBy: 'test',
} as ActionRequest);

describe('ConfirmationManager request dedupe', () => {
  it('reuses an identical pending ask', () => {
    const manager = new ConfirmationManager();
    const a1 = manager.request(mkAction({ appId: 'x' }), 'gate 1');
    const a2 = manager.request(mkAction({ appId: 'x' }), 'gate 2');
    expect(a2.id).toBe(a1.id);
    expect(manager.listPending()).toHaveLength(1);
  });

  it('mints a new record when the input differs', () => {
    const manager = new ConfirmationManager();
    manager.request(mkAction({ appId: 'x' }), 'gate 1');
    const b = manager.request(mkAction({ appId: 'y' }), 'gate 2');
    expect(manager.listPending()).toHaveLength(2);
  });

  it('mints a new record after the previous one was resolved', () => {
    const manager = new ConfirmationManager();
    const a = manager.request(mkAction({ appId: 'x' }), 'gate 1');
    manager.resolve(a.id, true);
    const next = manager.request(mkAction({ appId: 'x' }), 'gate 2');
    expect(next.id).not.toBe(a.id);
  });
});
