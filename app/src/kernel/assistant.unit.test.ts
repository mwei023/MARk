import { describe, it, expect } from 'vitest';
import { parseWhen, assistantTools } from './providers/assistant.js';

describe('parseWhen (offline, deterministic)', () => {
  const now = new Date(2026, 8, 28, 9, 0, 0); // Mon Sep 28 2026 09:00 local
  const iso = (d: Date | undefined) => d?.toISOString() ?? '(undef)';

  it('parses ISO and date forms', () => {
    expect(iso(parseWhen('2026-10-01T10:30:00', now))).toContain('2026-10-01');
    expect(parseWhen('2026-10-01', now)?.getHours()).toBe(9);
  });

  it('parses relative forms', () => {
    expect(parseWhen('tomorrow 10:00', now)?.getDate()).toBe(29);
    expect(parseWhen('tomorrow 10:00', now)?.getHours()).toBe(10);
    expect(parseWhen('in 2 hours', now)?.getHours()).toBe(11);
    expect(parseWhen('friday 14:00', now)?.getDay()).toBe(5);
    expect(parseWhen('friday 14:00', now)?.getDate()).toBe(2);
    expect(parseWhen('18:00', now)?.getHours()).toBe(18);
    expect(parseWhen('07:00', now)?.getDate()).toBe(29); // past today -> tomorrow
  });

  it('fails closed on garbage', () => {
    expect(parseWhen('', now)).toBeUndefined();
    expect(parseWhen('sometime-ish', now)).toBeUndefined();
    expect(parseWhen('next blue moon', now)).toBeUndefined();
  });

  it('exposes 7 assistant tools with read/reversible split', () => {
    expect(assistantTools.map(t => t.id)).toEqual([
      'task.create', 'task.list', 'task.complete', 'task.cancel',
      'schedule.create', 'schedule.list', 'schedule.cancel',
    ]);
    expect(assistantTools.filter(t => t.risk === 'read')).toHaveLength(2);
    expect(assistantTools.filter(t => t.risk === 'reversible')).toHaveLength(5);
  });
});
