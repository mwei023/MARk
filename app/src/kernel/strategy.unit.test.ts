import { describe, it, expect } from 'vitest';
import {
  computeUtility, binaryOutcome, posteriorFor, posteriorMean,
  betaSample, thompsonPick, probSuperior,
  strategiesFor, failureTypeToTaskClass,
  DEFAULT_WEIGHTS, STRATEGY_REGISTRY,
} from './strategy.js';

/** Deterministic RNG (mulberry32) so distribution tests are stable. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('utility mapping', () => {
  it('clean verified wins stay positive; regressions sink below zero', () => {
    const clean = computeUtility({ success: true, verified: true, regression: false, tokens: 5000, durationMs: 60000 });
    expect(clean).toBeGreaterThan(0);
    expect(binaryOutcome(clean)).toBe(1);
    const regressed = computeUtility({ success: true, verified: true, regression: true, tokens: 5000, durationMs: 60000 });
    expect(regressed).toBeLessThan(0);
    expect(binaryOutcome(regressed)).toBe(0);
    const failed = computeUtility({ success: false, verified: false, regression: false, tokens: 5000, durationMs: 60000 });
    expect(binaryOutcome(failed)).toBe(0);
  });

  it('pure cost excess alone cannot sink a clean run (capped normalizers)', () => {
    const slow = computeUtility({ success: true, verified: true, regression: false, tokens: 10 ** 9, durationMs: 10 ** 9 });
    // capped at wLatency + wTokens drag: 1.6 - 0.6 = 1.0 > 0
    expect(slow).toBeGreaterThan(0);
  });

  it('weights change what better means without touching machinery', () => {
    const trial = { success: true, verified: false, regression: false, tokens: 90000, durationMs: 290000 };
    const cheap = computeUtility(trial, { ...DEFAULT_WEIGHTS, wTokens: 0.1, wLatency: 0.1 });
    const pricey = computeUtility(trial, { ...DEFAULT_WEIGHTS, wTokens: 3.0, wLatency: 3.0 });
    expect(binaryOutcome(cheap)).toBe(1);
    expect(binaryOutcome(pricey)).toBe(0);
  });
});

describe('posterior + Thompson', () => {
  it('starts uniform and concentrates with evidence', () => {
    expect(posteriorMean(posteriorFor([]))).toBe(0.5);
    expect(posteriorMean(posteriorFor([1, 1, 1, 1]))).toBeCloseTo(5 / 6, 5);
  });

  it('beta samples track the mean over many draws', () => {
    const rand = seeded(7);
    const p = { alpha: 43, beta: 17 };
    let sum = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) sum += betaSample(p, rand);
    expect(sum / n).toBeCloseTo(43 / 60, 1);
  });

  it('Thompson favors the better posterior but still explores', () => {
    const rand = seeded(42);
    // Overlapping posteriors: the better one wins most draws, the worse
    // one still earns a substantial minority (exploration is real).
    const good = { alpha: 8, beta: 6 };
    const bad = { alpha: 6, beta: 8 };
    let goodWins = 0;
    for (let i = 0; i < 500; i++) {
      if (thompsonPick([good, bad], rand) === 0) goodWins++;
    }
    expect(goodWins).toBeGreaterThan(250);
    expect(goodWins).toBeLessThan(450);
  });

  it('Thompson nearly always exploits a dominant posterior', () => {
    const rand = seeded(43);
    const good = { alpha: 48, beta: 12 };
    const bad = { alpha: 12, beta: 48 };
    let goodWins = 0;
    for (let i = 0; i < 500; i++) {
      if (thompsonPick([good, bad], rand) === 0) goodWins++;
    }
    expect(goodWins).toBeGreaterThan(480);
  });

  it('promotion evidence: identical posteriors sit near 0.5, dominant near 1', () => {
    const rand = seeded(11);
    expect(probSuperior({ alpha: 10, beta: 10 }, { alpha: 10, beta: 10 }, 0, 2000, rand))
      .toBeGreaterThan(0.35);
    expect(probSuperior({ alpha: 10, beta: 10 }, { alpha: 10, beta: 10 }, 0, 2000, rand))
      .toBeLessThan(0.65);
    expect(probSuperior({ alpha: 80, beta: 20 }, { alpha: 20, beta: 80 }, 0, 2000, rand))
      .toBeGreaterThan(0.95);
  });

  it('small-n posteriors refuse strong claims', () => {
    const rand = seeded(5);
    // 2/2 vs 1/1: wide posteriors, must not clear 0.95.
    expect(probSuperior({ alpha: 3, beta: 1 }, { alpha: 2, beta: 1 }, 0, 2000, rand))
      .toBeLessThan(0.95);
  });
});

describe('strategy registry', () => {
  it('covers the initial five with task classes', () => {
    expect(STRATEGY_REGISTRY.map(s => s.id).sort()).toEqual(
      ['parallel-team', 'sequential-team', 'solo', 'supervised-team', 'worktree-team'].sort(),
    );
    expect(strategiesFor('repo_bugfix').map(s => s.id)).toContain('solo');
    expect(strategiesFor('repo_bugfix').map(s => s.id)).toContain('supervised-team');
    // Solo is the universal fallback/control: it serves every class.
    for (const cls of ['repo_bugfix', 'large_refactor', 'repo_analysis', 'system_diagnosis', 'incident_triage', 'incident_recovery', 'research', 'shell_task']) {
      expect(strategiesFor(cls).map(s => s.id)).toContain('solo');
    }
    expect(strategiesFor('shell_task')).toEqual([expect.objectContaining({ id: 'solo' })]);
  });

  it('maps known failure types, skips the rest (never shoehorns)', () => {
    expect(failureTypeToTaskClass('TYPE_ERROR')).toBe('repo_bugfix');
    expect(failureTypeToTaskClass('lint_failure')).toBe('repo_bugfix');
    expect(failureTypeToTaskClass('UNKNOWN')).toBe('incident_triage');
    expect(failureTypeToTaskClass('SELF_IMPROVEMENT_GAP')).toBeUndefined();
    expect(failureTypeToTaskClass('')).toBeUndefined();
  });
});
