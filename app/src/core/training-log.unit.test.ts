import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logRoutingDecision, logFailureClassification } from './training-log.js';

let dir = '';
let prev = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mark-train-'));
  prev = process.env.MARK_TRAINING_DIR ?? '';
  process.env.MARK_TRAINING_DIR = dir;
  delete process.env.MARK_TRAINING_LOG;
});

afterEach(() => {
  if (prev) process.env.MARK_TRAINING_DIR = prev;
  else delete process.env.MARK_TRAINING_DIR;
  delete process.env.MARK_TRAINING_LOG;
});

describe('training log (auto-logging)', () => {
  it('logs routing rows with the decision as label', () => {
    logRoutingDecision({ text: 'show disk usage', label: 'deterministic' });
    const rows = readFileSync(join(dir, 'routing.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('deterministic');
    expect(rows[0].source).toBe('live');
  });

  it('pseudo-labels high-confidence failures, leaves weak ones unlabeled', () => {
    logFailureClassification({ text: "Cannot find module 'pg'", predicted: 'MISSING_DEPENDENCY', confidence: 0.5, incidentId: 'INC-1' });
    logFailureClassification({ text: 'weird noise', predicted: 'UNKNOWN', confidence: 0.1, incidentId: 'INC-2' });
    const rows = readFileSync(join(dir, 'failure.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0].label).toBe('MISSING_DEPENDENCY');
    expect(rows[0].source).toBe('pseudo');
    expect(rows[0].incidentId).toBe('INC-1');
    expect(rows[1].label).toBeNull();
    expect(rows[1].source).toBe('unverified');
  });

  it('never throws and respects the kill switch', () => {
    process.env.MARK_TRAINING_LOG = 'false';
    expect(() => logRoutingDecision({ text: 'x', label: 'y' })).not.toThrow();
    expect(() => logFailureClassification({ text: '', predicted: 'UNKNOWN', confidence: 0 })).not.toThrow();
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
