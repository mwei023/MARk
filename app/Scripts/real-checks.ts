/**
 * MARK real-check daemon: hourly REAL observations of the machine it lives
 * on, feeding gold-labeled failure data — only from real failures.
 *
 * Honesty contract:
 * - Every check is genuinely read-only (docker inspect, df, free, TCP ping,
 *   HTTP health endpoints). No restarts, no kills, no "repairs".
 * - Healthy checks log NOTHING. A daemon that manufactures incidents for
 *   green systems would poison the failure dataset green-vs-real.
 * - A check that cannot run (docker not installed, permissions) is
 *   reported as UNCHECKABLE — missing evidence is not a failure.
 * - Incidents are created only on ok→fail TRANSITIONS (state kept in
 *   data/monitor/state.json). A persistent failure is one incident, not
 *   one per hour.
 * - Each real failure creates a REAL incident (incidentStore) and runs the
 *   same failure classifier live traffic uses, auto-logging a failure row
 *   joined to the incidentId — gold material for classifier distillation.
 *
 * Usage:
 *   npm run training:checks              # one pass, print results
 *   npm run training:checks -- --loop 60 # daemon pass every 60 min
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const LOOP_MINUTES = (() => {
  const i = process.argv.indexOf('--loop');
  if (i === -1) return 0;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v >= 5 ? v : 60;
})();

const ROOT = process.env.MARK_TRAINING_DIR
  ? path.resolve(process.env.MARK_TRAINING_DIR, '..')
  : '/home/mwei/jarvis-core';
const STATE_FILE = process.env.MARK_MONITOR_STATE
  ?? path.join(ROOT, 'data', 'monitor', 'state.json');

// The API sits behind global token auth (x-api-token) — same loader as
// self-exercise. An unauthenticated health check would misreport genuine
// service health as HTTP 401 failures (observed live on the first pass).
function loadApiToken(): string {
  const direct = process.env.API_TOKEN?.trim();
  if (direct) return direct;
  // npm doesn't export .env — read it from the repo root ourselves.
  for (const p of [path.join(process.cwd(), '.env'), path.join(process.cwd(), '..', '.env')]) {
    if (!fsSync.existsSync(p)) continue;
    for (const line of fsSync.readFileSync(p, 'utf8').split('\n')) {
      const m = /^API_TOKEN=(.+)$/.exec(line.trim());
      if (m) return m[1].trim();
    }
  }
  return '';
}
const API_TOKEN = loadApiToken();

type CheckId = string;
type CheckStatus = 'ok' | 'fail' | 'unchecked';
type CheckResult = { id: CheckId; status: CheckStatus; evidence: string };

// ── state (dedupes recurring failures into one incident) ────────────────────
type CheckState = { status: CheckStatus; since?: string; incidentId?: string };
const loadState = (): Record<string, CheckState> => {
  try {
    return JSON.parse(fsSync.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
};
const saveState = (state: Record<string, CheckState>): void => {
  try {
    fsSync.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fsSync.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* state loss only re-opens an incident later; never fatal */ }
};

// ── real, read-only probes ──────────────────────────────────────────────────
async function checkDisk(): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync('df', ['-h', '-P', '/'], { timeout: 15000 });
    const line = stdout.trim().split('\n').pop() ?? '';
    const cols = line.split(/\s+/);
    const usePct = Number((cols[4] ?? '0%').replace('%', ''));
    const evidence = `Filesystem ${cols[5] ?? '/'} at ${cols[4]} used (${cols[2]} used / ${cols[1]} total).`;
    if (usePct >= 95) return { id: 'disk', status: 'fail', evidence: `CRITICAL ${evidence}` };
    if (usePct >= 90) return { id: 'disk', status: 'fail', evidence: `Warning: ${evidence}` };
    return { id: 'disk', status: 'ok', evidence };
  } catch (e) {
    return { id: 'disk', status: 'unchecked', evidence: `df unavailable: ${(e as Error).message}` };
  }
}

async function checkMemory(): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync('free', ['-m'], { timeout: 15000 });
    const memLine = stdout.split('\n').find(l => l.startsWith('Mem:'));
    if (!memLine) return { id: 'memory', status: 'unchecked', evidence: 'free output unreadable' };
    const cols = memLine.split(/\s+/); // Mem: total used free shared buf cache available
    const total = Number(cols[1]);
    const available = Number(cols[6] ?? cols[3]);
    if (!Number.isFinite(total) || total <= 0) {
      return { id: 'memory', status: 'unchecked', evidence: 'free values unreadable' };
    }
    const availablePct = Math.round((available / total) * 100);
    const evidence = `${available}MB of ${total}MB memory available (${availablePct}%).`;
    return availablePct < 10
      ? { id: 'memory', status: 'fail', evidence: `CRITICAL low memory: ${evidence}` }
      : { id: 'memory', status: 'ok', evidence };
  } catch (e) {
    return { id: 'memory', status: 'unchecked', evidence: `free unavailable: ${(e as Error).message}` };
  }
}

async function checkDockerContainers(): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'ps', '--all', '--format',
      '{{.Names}}\t{{.State}}\t{{.Status}}',
    ], { timeout: 20000 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return { id: 'docker', status: 'unchecked', evidence: 'no docker containers found (docker may be empty or unavailable)' };
    }
    const unhealthy = lines.filter(l => /unhealthy|restarting|dead/i.test(l));
    const evidence = unhealthy.length > 0
      ? `Unhealthy containers:\n${unhealthy.map(l => `  ${l}`).join('\n')}`
      : `${lines.length} container(s) inspected, none unhealthy: ${lines.slice(0, 5).map(l => l.split('\t')[0]).join(', ')}`;
    return {
      id: 'docker',
      status: unhealthy.length > 0 ? 'fail' : 'ok',
      evidence,
    };
  } catch (e) {
    // Cannot run docker ≠ the machine is failing. Missing evidence is not failure.
    return { id: 'docker', status: 'unchecked', evidence: `docker unavailable: ${(e as Error).message}` };
  }
}

function tcpProbe(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function checkPostgres(): Promise<CheckResult> {
  const ok = await tcpProbe('localhost', 5433);
  return ok
    ? { id: 'postgres', status: 'ok', evidence: 'PostgreSQL accepted a TCP connection on localhost:5433.' }
    : { id: 'postgres', status: 'fail', evidence: 'PostgreSQL did not accept a TCP connection on localhost:5433.' };
}

async function checkMarkApi(): Promise<CheckResult> {
  try {
    const resp = await fetch('http://localhost:3001/api/health', {
      headers: API_TOKEN ? { 'x-api-token': API_TOKEN } : {},
      signal: AbortSignal.timeout(6000),
    });
    const body = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      // Auth mismatch is a CHECKER error, not a service failure — never
      // report it as the machine being down.
      return { id: 'mark-api', status: 'unchecked', evidence: `MARK API health check misconfigured: HTTP ${resp.status} (auth) — not counted as a failure.` };
    }
    return resp.ok
      ? { id: 'mark-api', status: 'ok', evidence: `MARK API /api/health responded ${resp.status}.` }
      : { id: 'mark-api', status: 'fail', evidence: `MARK API /api/health returned HTTP ${resp.status}: ${body.slice(0, 200)}` };
  } catch (e) {
    return { id: 'mark-api', status: 'fail', evidence: `MARK API unreachable: ${(e as Error).message}` };
  }
}

async function checkOllama(): Promise<CheckResult> {
  try {
    const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(8000) });
    return resp.ok
      ? { id: 'ollama', status: 'ok', evidence: `Ollama responded ${resp.status} on localhost:11434.` }
      : { id: 'ollama', status: 'fail', evidence: `Ollama returned HTTP ${resp.status} on localhost:11434.` };
  } catch (e) {
    return { id: 'ollama', status: 'fail', evidence: `Ollama unreachable: ${(e as Error).message}` };
  }
}

const CHECKS: Array<() => Promise<CheckResult>> = [
  checkDisk, checkMemory, checkDockerContainers, checkPostgres, checkMarkApi, checkOllama,
];

// ── incident path (same pipeline the git-agent webhook flow uses) ───────────
async function openIncident(id: CheckId, evidence: string): Promise<string | undefined> {
  const [{ incidentStore }, { classifyFailure }, { logFailureClassification }] = await Promise.all([
    import('../src/core/incident.js'),
    import('../src/core/failure-classifier.js'),
    import('../src/core/training-log.js'),
  ]);
  const incident = await incidentStore.createIncident({
    title: `Real-check failure: ${id} on ${os.hostname()}`,
    description: `Generated by the real-check daemon from a genuinely failing local observation (NOT synthetic). Transition evidence:\n${evidence}`,
    severity: /CRITICAL/i.test(evidence) ? 'critical' : 'low',
    status: 'investigating',
    triggerEvent: 'mark.realcheck.failed',
    triggerEventId: `EVT-realcheck-${id}-${Date.now()}`,
    correlationId: `realcheck-${id}-${new Date().toISOString().slice(0, 13)}`,
    assignedAgent: 'system-agent',
    tags: ['realcheck', id],
    context: { check: id, host: os.hostname() },
  });
  // The failure text IS the real evidence; classify it like any live failure.
  const classification = classifyFailure(evidence);
  await incidentStore.addFinding(incident.id, `Classification (realcheck): ${classification.type} confidence ${classification.confidence.toFixed(2)} — ${classification.signals.join(', ') || 'no signals'}`);
  logFailureClassification({
    text: evidence,
    predicted: classification.type,
    confidence: classification.confidence,
    incidentId: incident.id,
  });
  console.log(`  ⚠️  incident ${incident.id} opened for check "${id}" (${classification.type})`);
  return incident.id;
}

/** Fail→ok transition: close the loop on the real incident that was opened. */
async function recordRecovery(id: CheckId, evidence: string, incidentId: string | undefined): Promise<void> {
  console.log(`  ℹ️  "${id}" recovered; incident: ${incidentId ?? 'unknown (state was lost)'}`);
  if (!incidentId) return;
  try {
    const { incidentStore } = await import('../src/core/incident.js');
    await incidentStore.addFinding(incidentId, `Recovered (realcheck): ${evidence}`);
    await incidentStore.resolveIncident(incidentId, {
      action: 'realcheck recovery observed',
      success: true,
      details: evidence,
    });
    console.log(`  ✅ incident ${incidentId} resolved with recovery evidence`);
  } catch (e) {
    console.warn(`  ⚠️  could not resolve incident ${incidentId}: ${(e as Error).message}`);
  }
}

let pass = 0;
async function runPass(): Promise<void> {
  pass += 1;
  const state = loadState();
  const results: CheckResult[] = [];
  for (const check of CHECKS) {
    try {
      results.push(await check());
    } catch (e) {
      results.push({ id: 'unknown', status: 'unchecked', evidence: `checker error: ${(e as Error).message}` });
    }
  }

  const now = new Date().toISOString();
  console.log(`── real-check pass ${pass} @ ${now} ──`);
  for (const r of results) {
    const prev = state[r.id] ?? { status: 'unchecked' as CheckStatus };
    state[r.id] = { ...prev, status: r.status };
    const icon = r.status === 'ok' ? '✅' : r.status === 'fail' ? '❌' : '⏭️ ';
    console.log(`${icon} ${r.id.padEnd(8)} ${r.status.padEnd(10)} ${r.evidence.replace(/\n/g, ' | ').slice(0, 160)}`);

    // Ok→fail transition: real failure → one real incident with classification.
    if (r.status === 'fail' && prev.status !== 'fail') {
      state[r.id].since = now;
      const incidentId = await openIncident(r.id, r.evidence);
      state[r.id].incidentId = incidentId;
    }
    // Fail→ok transition: close the loop quietly.
    if (r.status === 'ok' && prev.status === 'fail') {
      await recordRecovery(r.id, r.evidence, prev.incidentId);
      state[r.id].since = now;
    }
  }
  saveState(state);
}

async function main() {
  if (LOOP_MINUTES > 0) {
    console.log(`real-check daemon: hourly real observations every ${LOOP_MINUTES} min (ctrl+c to stop)`);
    await runPass();
    setInterval(() => void runPass(), LOOP_MINUTES * 60 * 1000);
  } else {
    await runPass();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
