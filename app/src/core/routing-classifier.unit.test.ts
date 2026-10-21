import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRoutingModel,
  trainRoutingModel,
  saveRoutingModel,
  classifyRoutingIntent,
  MIN_LIVE_TRAINING_EXAMPLES,
} from './routing-classifier.js';

const prevDir = process.env.MARK_TRAINING_DIR;
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mark-nb-'));
  process.env.MARK_TRAINING_DIR = dir;
  process.env.MARK_TRAINED_ROUTER = 'on'; // even with the assist ON, the loader gates on provenance
});

afterEach(() => {
  if (prevDir) process.env.MARK_TRAINING_DIR = prevDir;
  else delete process.env.MARK_TRAINING_DIR;
  delete process.env.MARK_TRAINED_ROUTER;
  rmSync(dir, { recursive: true, force: true });
});

describe('routing classifier provenance gate (guards live traffic from synthetic weights)', () => {
  it('refuses to train below the live-row floor', () => {
    const few = Array.from({ length: MIN_LIVE_TRAINING_EXAMPLES - 1 }, (_, i) => ({ text: `row ${i}`, label: 'reasoning' }));
    expect(() => trainRoutingModel(few)).toThrow(/refusing to train/);
  });

  it('trains when the floor is met and stamps live provenance', () => {
    // pad with a couple of labeled rows per class so the model is meaningful
    const rows = [
      { text: 'show disk usage please', label: 'deterministic' },
      ...Array.from({ length: MIN_LIVE_TRAINING_EXAMPLES }, () => ({ text: 'list git branches now', label: 'agent:git-agent' })),
    ];
    const model = trainRoutingModel(rows);
    expect(model.trainedOn).toBe('live');
    saveRoutingModel(model);
    const loaded = loadRoutingModel();
    expect(loaded).not.toBeNull();
    expect(loaded?.trainedOn).toBe('live');
    expect(classifyRoutingIntent('list git branches now')?.label).toBe('agent:git-agent');
  });

  it('rejects a persisted model without live provenance (the synthetic-model trap)', () => {
    const model = trainRoutingModel([], { allowFallback: true }); // trainedOn: 'defaults'
    saveRoutingModel(model);
    expect(loadRoutingModel()).toBeNull();
    // classify sticks to null instead of resurrecting the untrusted weights
    expect(classifyRoutingIntent('deploy to staging now')).toBeNull();
  });

  it('rejects stale/partial models missing provenance fields entirely', () => {
    const legacy = { version: 1, labels: ['reasoning'], priors: {}, tokenCounts: {}, tokenTotals: {}, vocabSize: 1 };
    writeFileSync(join(dir, 'routing-model.json'), JSON.stringify(legacy));
    expect(loadRoutingModel()).toBeNull();
  });

  it('returns null cleanly when no model exists (no auto-train side effect)', () => {
    expect(loadRoutingModel()).toBeNull();
    expect(classifyRoutingIntent('anything at all')).toBeNull();
    // and it did NOT persist a fallback model as a side effect
    expect(require('node:fs').existsSync(join(dir, 'routing-model.json'))).toBe(false);
  });
});
