import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpsSnapshot } from './ops-snapshot.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('GET /api/status/ops', () => {
  it('is registered exactly once (two handlers crashed per request)', () => {
    const source = readFileSync(join(here, 'server-v2.ts'), 'utf8');
    const registrations = source.match(/app\.get\('\/api\/status\/ops'/g) ?? [];
    expect(registrations).toHaveLength(1);
  });

  it('snapshot keeps the phase-3 shape with degraded sections nulled', async () => {
    const snap = await buildOpsSnapshot();
    // Phase-3 contract keys always present, even with stores down.
    expect(Array.isArray(snap.repoHealth)).toBe(true);
    expect(Array.isArray(snap.anomalies)).toBe(true);
    expect(Array.isArray(snap.degraded)).toBe(true);
    expect(typeof snap.selfKnowledge.totalMemoryRecords).toBe('number');
    expect(Array.isArray(snap.selfKnowledge.trustedFixTypes)).toBe(true);
    expect(typeof snap.timestamp).toBe('string');
    expect(snap.objective).toBeDefined();
    // openIncidents is either the breakdown or null (never throws).
    if (snap.openIncidents !== null) {
      expect(typeof snap.openIncidents.total).toBe('number');
      expect(typeof snap.openIncidents.bySeverity).toBe('object');
    }
    if (snap.autoFix !== null) {
      expect(snap.autoFix.rate).toBeGreaterThanOrEqual(0);
      expect(snap.autoFix.rate).toBeLessThanOrEqual(100);
    }
  });
});
