/**
 * Self-improvement bridge unit tests — no DB, no LLM.
 *
 * Covers: usefulness gating (accept / reject / confidence floor) and the
 * offline guarantee — filing without a database returns null incident ids
 * instead of throwing, so research findings are never lost silently.
 */
import { describe, it, expect, vi } from 'vitest';
import { assessUsefulness, fileProblemStatements } from './self-improve.js';
import { incidentStore } from '../core/incident.js';

describe('assessUsefulness', () => {
  it('rejects empty input with a reason', () => {
    const verdict = assessUsefulness([]);
    expect(verdict.useful).toBe(false);
    expect(verdict.reason.length).toBeGreaterThan(0);
    expect(verdict.gapAreas).toEqual([]);
  });

  it('requires gap + fix + confidence', () => {
    expect(assessUsefulness([
      { title: 'T', area: 'a', gap: '', evidenceUrls: [], suggestedFix: 'do X', confidence: 0.9 },
    ]).useful).toBe(false);
    expect(assessUsefulness([
      { title: 'T', area: 'a', gap: 'missing X', evidenceUrls: [], suggestedFix: '', confidence: 0.9 },
    ]).useful).toBe(false);
    expect(assessUsefulness([
      { title: 'T', area: 'a', gap: 'missing X', evidenceUrls: [], suggestedFix: 'do X', confidence: 0.1 },
    ]).useful).toBe(false);
  });

  it('dedups gap areas', () => {
    const verdict = assessUsefulness([
      { title: 'A', area: 'Web Research', gap: 'g1', evidenceUrls: [], suggestedFix: 'f1', confidence: 0.6 },
      { title: 'B', area: 'web-research', gap: 'g2', evidenceUrls: [], suggestedFix: 'f2', confidence: 0.7 },
    ]);
    expect(verdict.useful).toBe(true);
    expect(verdict.gapAreas).toEqual(['web-research']);
  });
});

describe('fileProblemStatements (no DB)', () => {
  it('never throws offline — returns null incident ids', async () => {
    // Dotenv may provide DATABASE_URL in the test process. Simulate the
    // actual offline boundary directly instead of depending on ambient env.
    const findOrCreate = vi.spyOn(incidentStore, 'findOrCreateIncident')
      .mockRejectedValueOnce(new Error('DATABASE_URL not set'));
    const receipts = await fileProblemStatements('vector databases', 'summary', [
      { title: 'Gap', area: 'web-research', gap: 'Cannot render JS.', evidenceUrls: [], suggestedFix: 'Add headless read.', confidence: 0.7 },
    ]);
    findOrCreate.mockRestore();
    expect(receipts).toHaveLength(1);
    // DATABASE_URL is unset in unit tests → store unreachable → null, no throw.
    expect(receipts[0].incidentId).toBeNull();
    expect(receipts[0].statement.title).toBe('Gap');
  });

  it('drops below-bar statements without touching the store', async () => {
    const receipts = await fileProblemStatements('x', 's', [
      { title: '', area: 'a', gap: '', evidenceUrls: [], suggestedFix: '', confidence: 0 },
    ]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].incidentId).toBeNull();
  });
});
