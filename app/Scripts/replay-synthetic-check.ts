/**
 * Replay the quarantined synthetic corpus through the LIVE Gateway.
 *
 * This is the legitimate reuse of the synthetic data: the templated texts
 * become PROBES. Their labels are hypotheses (derived from the gateway by
 * reading code — circular as training truth), but every disagreement between
 * (a) the synthetic label and (b) what the real gateway does today is a
 * routing triage item: either the gateway is wrong or the template was.
 *
 * Read-only for training: nothing here appends to routing.jsonl (probes are
 * not usage). Output: data/training/reports/replay-disagreements.json
 *
 * Usage: npm run training:replay
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Gateway } from '../src/core/gateway';

const cwd = process.cwd();
const trainingDir = existsSync(join(cwd, 'data', 'training'))
  ? join(cwd, 'data', 'training')
  : join(cwd, '..', 'data', 'training');
const reportDir = join(trainingDir, 'reports');
mkdirSync(reportDir, { recursive: true });

const syntheticPath = join(trainingDir, 'synthetic', 'routing-synthetic.jsonl');
const probes: Array<{ text: string; label: string }> = [];
for (const line of readFileSync(syntheticPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const r = JSON.parse(line);
    if (typeof r.text === 'string' && typeof r.label === 'string') probes.push({ text: r.text, label: r.label });
  } catch { /* skip */ }
}

const gw = new Gateway();
const expectedFingerprint = (label: string) => label; // e.g. agent:git-agent / deterministic / reasoning

const disagreements: Array<{ text: string; claimed: string; live: string; livePath: string; liveAgent?: string }> = [];
const agreements: Record<string, number> = {};
const liveDist: Record<string, number> = {};
const t0 = Date.now();

for (const p of probes) {
  const d: any = gw.classify({
    id: 'probe', timestamp: new Date(), source: 'user_command',
    type: 'user.command.received', severity: 'info', data: { command: p.text },
  } as any);
  const liveLabel = d.agent ? `agent:${d.agent}` : d.path;
  liveDist[liveLabel] = (liveDist[liveLabel] ?? 0) + 1;
  if (liveLabel === expectedFingerprint(p.label)) {
    agreements[p.label] = (agreements[p.label] ?? 0) + 1;
  } else {
    disagreements.push({ text: p.text, claimed: p.label, live: liveLabel, livePath: d.path, ...(d.agent ? { liveAgent: d.agent } : {}) });
  }
}

const ms = Date.now() - t0;
// Deduplicate disagreement texts (templates repeat).
const seen = new Set<string>();
const unique = disagreements.filter((d) => {
  const key = `${d.text}→${d.live}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

writeFileSync(join(reportDir, 'replay-disagreements.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  probed: probes.length,
  agreement: probes.length - disagreements.length,
  disagreements: disagreements.length,
  uniqueDisagreements: unique,
}, null, 2));

console.log(`probed ${probes.length} synthetic texts through the live gateway in ${ms}ms`);
console.log(`label agrees with live behavior : ${probes.length - disagreements.length} (${((probes.length - disagreements.length) / probes.length * 100).toFixed(1)}%)`);
console.log(`disagreements                   : ${disagreements.length} rows, ${unique.length} unique text→live pairs`);
console.log('live routing distribution:');
for (const [label, n] of Object.entries(liveDist).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${label}: ${n}`);
}
console.log(`wrote ${join(reportDir, 'replay-disagreements.json')}`);
