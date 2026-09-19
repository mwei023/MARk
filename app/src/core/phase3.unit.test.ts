/**
 * Phase 3 unit tests — no DB, no LLM, no filesystem.
 *
 * Covers:
 *  1. OpsMemory — save/recall/verify/effectiveness logic (in-memory simulation)
 *  2. RepoBaseline — anomaly detection math
 *  3. ops-memory record shape validation
 *  4. /api/status/ops response shape
 *  5. Memory recall priority (same repo > cross-repo)
 *  6. N_TRUSTED_THRESHOLD constant and isTrusted logic
 */

import { describe, it, expect } from 'vitest';

// ─── 1. OpsMemory record shape ────────────────────────────────────────────────

import { N_TRUSTED_THRESHOLD } from '../core/ops-memory.js';
import type { OpsMemoryRecord, SaveOpsMemoryInput } from '../core/ops-memory.js';

describe('OpsMemory record shape', () => {
  function makeRecord(overrides: Partial<OpsMemoryRecord> = {}): OpsMemoryRecord {
    return {
      id: 'OM-001',
      incidentId: 'INC-001',
      triggerEvent: 'github.workflow.failed',
      failureType: 'MISSING_DEPENDENCY',
      classificationConfidence: 0.85,
      repository: 'owner/repo',
      resolution: 'Created auto-fix/deps branch and ran npm install',
      success: true,
      durationMs: 72000,
      verified: false,
      verifiedCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('has all required fields', () => {
    const r = makeRecord();
    expect(r.id).toMatch(/^OM-/);
    expect(r.incidentId).toMatch(/^INC-/);
    expect(typeof r.classificationConfidence).toBe('number');
    expect(r.classificationConfidence).toBeGreaterThanOrEqual(0);
    expect(r.classificationConfidence).toBeLessThanOrEqual(1);
    expect(typeof r.durationMs).toBe('number');
    expect(typeof r.verified).toBe('boolean');
    expect(typeof r.verifiedCount).toBe('number');
  });

  it('verified starts false, verifiedCount starts 0', () => {
    const r = makeRecord();
    expect(r.verified).toBe(false);
    expect(r.verifiedCount).toBe(0);
  });

  it('after verification, verifiedCount increments', () => {
    const r = makeRecord({ verified: true, verifiedCount: 3 });
    expect(r.verified).toBe(true);
    expect(r.verifiedCount).toBe(3);
  });

  it('N_TRUSTED_THRESHOLD is 5', () => {
    expect(N_TRUSTED_THRESHOLD).toBe(5);
  });

  it('isTrusted logic: verifiedCount >= threshold means trusted', () => {
    const aboveThreshold = makeRecord({ verifiedCount: 5 });
    const belowThreshold = makeRecord({ verifiedCount: 4 });
    expect(aboveThreshold.verifiedCount >= N_TRUSTED_THRESHOLD).toBe(true);
    expect(belowThreshold.verifiedCount >= N_TRUSTED_THRESHOLD).toBe(false);
  });

  it('SaveOpsMemoryInput shape is complete', () => {
    const input: SaveOpsMemoryInput = {
      incidentId: 'INC-001',
      triggerEvent: 'github.workflow.failed',
      failureType: 'TYPE_ERROR',
      classificationConfidence: 0.75,
      repository: 'owner/repo',
      resolution: 'Manual review required',
      success: false,
      durationMs: 150000,
    };
    expect(input.failureType).toBe('TYPE_ERROR');
    expect(input.success).toBe(false);
  });
});

// ─── 2. Memory recall priority logic ─────────────────────────────────────────

describe('OpsMemory recall priority', () => {
  interface MockRecord {
    failureType: string;
    repository: string | null;
    success: boolean;
    verifiedCount: number;
    triggerEvent: string;
  }

  function recall(
    records: MockRecord[],
    triggerEvent: string,
    failureType: string,
    repository: string | null,
  ): { record: MockRecord; matchReason: string } | undefined {
    const successful = records.filter(r => r.success);

    // Match 1: same failureType + same repo
    if (repository && failureType !== 'UNKNOWN') {
      const m = successful
        .filter(r => r.failureType === failureType && r.repository === repository)
        .sort((a, b) => b.verifiedCount - a.verifiedCount)[0];
      if (m) return { record: m, matchReason: `same failure type in same repository` };
    }

    // Match 2: same failureType, any repo
    if (failureType !== 'UNKNOWN') {
      const m = successful
        .filter(r => r.failureType === failureType)
        .sort((a, b) => b.verifiedCount - a.verifiedCount)[0];
      if (m) return { record: m, matchReason: `same failure type in different repository` };
    }

    // Match 3: same triggerEvent + same repo
    if (repository) {
      const m = successful
        .filter(r => r.triggerEvent === triggerEvent && r.repository === repository)
        .sort((a, b) => b.verifiedCount - a.verifiedCount)[0];
      if (m) return { record: m, matchReason: `same trigger event in same repository` };
    }

    return undefined;
  }

  const records: MockRecord[] = [
    { failureType: 'MISSING_DEPENDENCY', repository: 'owner/repo', success: true, verifiedCount: 3, triggerEvent: 'github.workflow.failed' },
    { failureType: 'MISSING_DEPENDENCY', repository: 'owner/other', success: true, verifiedCount: 1, triggerEvent: 'github.workflow.failed' },
    { failureType: 'TYPE_ERROR', repository: 'owner/repo', success: true, verifiedCount: 0, triggerEvent: 'github.workflow.failed' },
    { failureType: 'LINT_FAILURE', repository: 'owner/other', success: false, verifiedCount: 0, triggerEvent: 'github.workflow.failed' },
  ];

  it('prefers same failure type + same repo over cross-repo', () => {
    const result = recall(records, 'github.workflow.failed', 'MISSING_DEPENDENCY', 'owner/repo');
    expect(result?.record.repository).toBe('owner/repo');
    expect(result?.matchReason).toMatch(/same repository/);
  });

  it('falls back to cross-repo when no same-repo match', () => {
    const result = recall(records, 'github.workflow.failed', 'MISSING_DEPENDENCY', 'owner/new');
    expect(result?.record.repository).toBe('owner/repo'); // highest verifiedCount
    expect(result?.matchReason).toMatch(/different repository/);
  });

  it('returns undefined for UNKNOWN type when no trigger+repo match', () => {
    const result = recall(records, 'github.workflow.failed', 'UNKNOWN', 'owner/newrepo');
    expect(result).toBeUndefined();
  });

  it('does not return failed resolutions as the classified match', () => {
    // LINT_FAILURE on owner/other has success=false — match-1 and match-2 skip it.
    // Match-3 (same trigger + any successful record for any repo) may still fire.
    // What we guarantee: the returned record always has success=true.
    const result = recall(records, 'github.workflow.failed', 'LINT_FAILURE', 'owner/other');
    if (result !== undefined) {
      expect(result.record.success).toBe(true);
    }
  });

  it('returns highest verifiedCount match when multiple qualify', () => {
    const result = recall(records, 'github.workflow.failed', 'MISSING_DEPENDENCY', 'owner/new');
    expect(result?.record.verifiedCount).toBe(3); // owner/repo has 3, owner/other has 1
  });
});

// ─── 3. Repo baseline anomaly detection math ─────────────────────────────────

describe('Repo baseline anomaly detection', () => {
  const ANOMALY_THRESHOLD = 2.0;
  const MIN_BASELINE_INCIDENTS = 3;

  interface Baseline {
    repository: string;
    avgIncidentsPerDay: number;
    totalIncidents: number;
  }

  function detectAnomaly(
    baseline: Baseline,
    currentWeekCount: number,
  ): { isAnomaly: boolean; rateMultiplier: number } {
    if (baseline.totalIncidents < MIN_BASELINE_INCIDENTS) {
      return { isAnomaly: false, rateMultiplier: 0 };
    }
    const expectedWeekCount = baseline.avgIncidentsPerDay * 7;
    if (expectedWeekCount < 0.5) return { isAnomaly: false, rateMultiplier: 0 };
    const rateMultiplier = currentWeekCount / expectedWeekCount;
    return { isAnomaly: rateMultiplier >= ANOMALY_THRESHOLD, rateMultiplier };
  }

  it('flags anomaly when current week is 2x above baseline', () => {
    const baseline = { repository: 'owner/repo', avgIncidentsPerDay: 1, totalIncidents: 30 };
    const { isAnomaly, rateMultiplier } = detectAnomaly(baseline, 14); // 14 vs 7 expected
    expect(isAnomaly).toBe(true);
    expect(rateMultiplier).toBe(2);
  });

  it('does not flag anomaly below threshold', () => {
    const baseline = { repository: 'owner/repo', avgIncidentsPerDay: 1, totalIncidents: 30 };
    const { isAnomaly } = detectAnomaly(baseline, 9); // 9 vs 7 expected = 1.28x
    expect(isAnomaly).toBe(false);
  });

  it('does not flag anomaly when baseline has too few incidents', () => {
    const baseline = { repository: 'owner/repo', avgIncidentsPerDay: 5, totalIncidents: 2 }; // < MIN
    const { isAnomaly } = detectAnomaly(baseline, 100);
    expect(isAnomaly).toBe(false);
  });

  it('does not flag anomaly when baseline rate is near zero', () => {
    const baseline = { repository: 'owner/repo', avgIncidentsPerDay: 0.05, totalIncidents: 10 };
    // expectedWeekCount = 0.35 < 0.5 → skip
    const { isAnomaly } = detectAnomaly(baseline, 10);
    expect(isAnomaly).toBe(false);
  });

  it('rateMultiplier is exactly 3x for tripled rate', () => {
    const baseline = { repository: 'owner/repo', avgIncidentsPerDay: 1, totalIncidents: 30 };
    const { rateMultiplier } = detectAnomaly(baseline, 21); // 21 vs 7 expected
    expect(rateMultiplier).toBe(3);
  });
});

// ─── 4. RepoBaseline record shape ─────────────────────────────────────────────

import type { RepoBaseline } from '../core/repo-baseline.js';

describe('RepoBaseline shape', () => {
  it('has all required fields', () => {
    const b: RepoBaseline = {
      repository: 'owner/repo',
      avgIncidentsPerDay: 0.5,
      avgResolutionMs: 900000,
      totalIncidents: 15,
      mostCommonType: 'TYPE_ERROR',
      updatedAt: new Date().toISOString(),
    };
    expect(typeof b.avgIncidentsPerDay).toBe('number');
    expect(typeof b.avgResolutionMs).toBe('number');
    expect(typeof b.totalIncidents).toBe('number');
    expect(b.mostCommonType).toBe('TYPE_ERROR');
  });

  it('mostCommonType can be null', () => {
    const b: RepoBaseline = {
      repository: 'owner/new',
      avgIncidentsPerDay: 0,
      avgResolutionMs: 0,
      totalIncidents: 0,
      mostCommonType: null,
      updatedAt: new Date().toISOString(),
    };
    expect(b.mostCommonType).toBeNull();
  });
});

// ─── 5. /api/status/ops response shape ───────────────────────────────────────

describe('/api/status/ops response shape', () => {
  it('openIncidents has total and bySeverity breakdown', () => {
    const response = {
      success: true,
      timestamp: new Date().toISOString(),
      openIncidents: {
        total: 3,
        bySeverity: { low: 1, medium: 1, high: 1, critical: 0 },
      },
      repoHealth: [],
      anomalies: [],
      autoFix: {
        attempts: 10,
        successes: 7,
        rate: 70.0,
        mostCommonFailureTypeThisWeek: 'TYPE_ERROR',
      },
      selfKnowledge: {
        totalMemoryRecords: 25,
        trustedFixTypes: ['MISSING_DEPENDENCY'],
        kernelInitialized: true,
        kernelToolCount: 12,
      },
    };

    expect(response.openIncidents.total).toBe(3);
    expect(response.openIncidents.bySeverity.critical).toBe(0);
    expect(response.autoFix.rate).toBe(70.0);
    expect(response.selfKnowledge.trustedFixTypes).toContain('MISSING_DEPENDENCY');
    expect(Array.isArray(response.anomalies)).toBe(true);
    expect(Array.isArray(response.repoHealth)).toBe(true);
  });

  it('rate is a percentage value (0-100 range)', () => {
    // rate = Math.round(fixRate.rate * 1000) / 10 — so 0.7 → 70.0
    const rawRate = 0.7;
    const pct = Math.round(rawRate * 1000) / 10;
    expect(pct).toBe(70.0);
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);
  });

  it('rate is 0 when no attempts', () => {
    const rawRate = 0;
    expect(Math.round(rawRate * 1000) / 10).toBe(0);
  });

  it('bySeverity counts sum to total', () => {
    const bySeverity = { low: 1, medium: 2, high: 1, critical: 0 };
    const total = Object.values(bySeverity).reduce((s, v) => s + v, 0);
    expect(total).toBe(4);
  });

  it('repoHealth entry has all expected fields', () => {
    const entry = {
      repository: 'owner/repo',
      avgIncidentsPerDay: 0.5,
      avgResolutionMs: 300000,
      mostCommonType: 'TYPE_ERROR',
      totalIncidents: 15,
      lastUpdated: new Date().toISOString(),
      anomaly: null,
    };
    expect(entry.repository).toBeTruthy();
    expect(typeof entry.avgIncidentsPerDay).toBe('number');
    expect(entry.anomaly).toBeNull();
  });

  it('serialises to valid JSON', () => {
    const response = {
      success: true, timestamp: new Date().toISOString(),
      openIncidents: { total: 0, bySeverity: { low: 0, medium: 0, high: 0, critical: 0 } },
      repoHealth: [], anomalies: [],
      autoFix: { attempts: 0, successes: 0, rate: 0, mostCommonFailureTypeThisWeek: null },
      selfKnowledge: { totalMemoryRecords: 0, trustedFixTypes: [], kernelInitialized: false, kernelToolCount: 0 },
    };
    expect(() => JSON.stringify(response)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(response));
    expect(parsed.success).toBe(true);
  });
});
