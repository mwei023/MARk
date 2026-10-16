/**
 * Training log — auto-logging for Mark's future classifier distillation.
 *
 * Every live routing decision and every incident failure classification is
 * appended as a JSONL row to data/training/*.jsonl (same shape as
 * Scripts/export-training.ts produces). Future training joins failure rows
 * to opsMemory on incidentId: rows whose incident verified successfully
 * promote from pseudo-labels to gold labels.
 *
 * Row shapes:
 *   routing: { text, label, predicted, agree, source, ts }
 *   failure: { text, label|null, predicted, confidence, agree, source, incidentId, ts }
 *
 * Guarantees: gated by MARK_TRAINING_LOG (default ON, 'false' disables),
 * mkdir -p, append-only, sync write (tiny payload, never blocks the loop
 * measurably), NEVER throws — logging must not fail a run.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

function trainingDir(): string | null {
  try {
    if (process.env.MARK_TRAINING_LOG === 'false') return null;
    const override = process.env.MARK_TRAINING_DIR?.trim();
    if (override) {
      mkdirSync(override, { recursive: true });
      return override;
    }
    // Server/tests run with cwd=app → repo-root data/training lives one up.
    // Repo-root runs use ./data/training directly.
    const cwd = process.cwd();
    const dir = basename(cwd) === 'app'
      ? join(cwd, '..', 'data', 'training')
      : join(cwd, 'data', 'training');
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

function appendRow(file: string, row: Record<string, unknown>): void {
  try {
    const dir = trainingDir();
    if (!dir) return;
    appendFileSync(join(dir, file), JSON.stringify(row) + '\n');
  } catch {
    // logging never fails a run
  }
}

const clip = (s: string, n = 500): string =>
  s.length > n ? s.slice(0, n) : s;

export function logRoutingDecision(args: {
  text: string;
  label: string;
  source?: string;
}): void {
  const text = (args.text ?? '').trim();
  if (!text) return;
  appendRow('routing.jsonl', {
    text: clip(text),
    label: args.label,
    predicted: args.label,
    agree: true,
    source: args.source ?? 'live',
    ts: new Date().toISOString(),
  });
}

export function logFailureClassification(args: {
  text: string;
  predicted: string;
  confidence: number;
  incidentId?: string;
  source?: string;
}): void {
  const text = (args.text ?? '').trim();
  if (!text) return;
  // High-confidence verdicts are usable pseudo-labels today; low-confidence
  // rows keep label null for later human/verified labeling (joined on
  // incidentId against opsMemory.verified).
  const pseudo = args.confidence >= 0.5;
  appendRow('failure.jsonl', {
    text: clip(text),
    label: pseudo ? args.predicted : null,
    predicted: args.predicted,
    confidence: Number(args.confidence.toFixed(3)),
    agree: pseudo ? true : null,
    source: args.source ?? (pseudo ? 'pseudo' : 'unverified'),
    ...(args.incidentId ? { incidentId: args.incidentId } : {}),
    ts: new Date().toISOString(),
  });
}
