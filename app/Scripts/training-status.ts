/**
 * Training oversight scoreboard: one command to see where we stand.
 *
 * The gate: >= 500 LIVE rows (only real usage counts) before any model
 * training. Synthetic probes never count.
 *
 * Reports:
 * - live row counts (routing + failure) and % of gate
 * - recent live prediction sanity (labels vs predicted — the router is the
 *   oracle so agree should be 1.0; 0 live rows means logging is broken)
 * - synthetic inventory (quarantined, never counted)
 *
 * Usage: npm run training:status
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIVE_GATE = 500;
const cwd = process.cwd();
const trainingDir = existsSync(join(cwd, 'data', 'training'))
  ? join(cwd, 'data', 'training')
  : join(cwd, '..', 'data', 'training');

function readJsonl(file: string) {
  const path = join(trainingDir, file);
  if (!existsSync(path)) return [];
  const rows: any[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return rows;
}

const liveCount = (file: string) => readJsonl(file).filter((r) => r.source === 'live').length;
const routingLive = liveCount('routing.jsonl');
const routingProbe = readJsonl('routing.jsonl').filter((r) => r.source === 'probe').length;
const failureLive = readJsonl('failure.jsonl').filter((r) => r.source === 'pseudo' || r.source === 'unverified').length;

const synthRouting = liveCount(join('synthetic', 'routing-synthetic.jsonl')) || readJsonl(join('synthetic', 'routing-synthetic.jsonl')).length;
const synthFailure = readJsonl(join('synthetic', 'failure-synthetic.jsonl')).length;

const routingRows = readJsonl('routing.jsonl').filter((r) => r.source === 'live');
const recent = routingRows.slice(-50);
const recentAgree = recent.length ? recent.filter((r) => r.agree === true).length / recent.length : NaN;

const progress = Math.min(1, routingLive / LIVE_GATE);
const bar = '█'.repeat(Math.round(progress * 24)).padEnd(24, '░');

console.log('===== MARK TRAINING STATUS =====');
console.log(`live routing rows : ${routingLive}/${LIVE_GATE} toward model gate`);
console.log(`                    [${bar}] ${(progress * 100).toFixed(1)}%`);
console.log(`probe routing rows: ${routingProbe} (self-exercise coverage — labeled separately by phrasing)`);
console.log(`failure rows      : ${failureLive} (pseudo+unverified; verified-join comes later)`);
console.log(`synthetic (quar.) : routing ${synthRouting}, failure ${synthFailure} — NOT counted toward the gate`);
if (routingRows.length === 0) {
  console.log('live sanity       : NO LIVE ROWS — auto-logging may be broken; fire a command at the server');
} else {
  console.log(`live sanity       : last ${recent.length} live rows, agree ${(recentAgree * 100).toFixed(0)}% (router-is-oracle: expect 100%)`);
  const last = recent[recent.length - 1];
  console.log(`last live row     : ${last.ts} "${String(last.text).slice(0, 60)}" → ${last.label}`);
}
console.log('next actions      : use Mark daily (rows auto-log) → npm run training:status → at 500+ run npm run training:retrain');
