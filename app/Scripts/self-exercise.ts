/**
 * MARK self-exercise daemon: Mark generates its own live training traffic.
 *
 * Instead of the human poking the playground one command at a time, this
 * script fires a rotating, DIVERSE, read-only command catalog at the running
 * server. Every command is a REAL execution (real gateway decision, real
 * capability/agent work) and auto-logs one routing row with source:'probe'.
 *
 * Hard honesty contract:
 * - Read-only verbs ONLY (show/list/check/status/find/explain/health/...
 *   for reads). No deploy/restart/rollback/commit/repair/install — those
 *   would mutate the machine. The catalog itself is reviewed by hand.
 * - Probe rows are tagged source:'probe' (session 'probe:*'), kept separate
 *   from human 'live' rows: retraining weights real phrasing higher.
 * - Reasoning/LLM commands are capped so runs stay fast offline.
 *
 * Usage:
 *   npm run training:exercise            # one pass (~40 commands, minutes)
 *   npm run training:exercise -- --loop  # daemon passes every 15 min (cron-friendly)
 */
import { spawnSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.MARK_EXERCISE_BASE ?? 'http://localhost:3001';

function loadApiToken(): string {
  const direct = process.env.API_TOKEN?.trim();
  if (direct) return direct;
  // npm doesn't export .env — read it from the repo root ourselves.
  for (const p of [join(process.cwd(), '.env'), join(process.cwd(), '..', '.env')]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^API_TOKEN=(.+)$/.exec(line.trim());
      if (m) return m[1].trim();
    }
  }
  return '';
}
const TOKEN = loadApiToken();
const LOOP = process.argv.includes('--loop');
const INTERVAL_MS = 15 * 60 * 1000;

/* Realistic, varied, READ-ONLY command catalog. Human phrasing, filler
 * included — that is the point (probe the gateway's real boundaries). */
const CATALOG: string[] = [
  // deterministic / host
  'what time is it',
  'what is the date today',
  'show disk usage',
  'how much disk is free right now',
  'check memory usage',
  'is memory pressure high on this machine',
  'show cpu usage',
  'what is the current system storage',
  'show system configuration',
  'what s the llm provider in use',
  // file / directory finds (the mp4 case)
  'list all mp4 files in this device',
  'find mp4 files in the home directory',
  "what's in the downloads folder",
  'what is in the download directory',
  'list files in my home directory',
  'show me the files in the working directory',
  'what files are in the desktop folder',
  // system agent reads
  'is the operating system healthy',
  'is the machine healthy',
  'check on my system config for this host',
  'what services are running on this host',
  'which ports are listening',
  'how is the uptime',
  // devops reads
  'list running containers',
  'is jarvis-db healthy',
  'how is the repo health',
  'are all services up',
  'status of the docker containers please',
  'is the deployment healthy',
  // cicd reads
  'is the pipeline green',
  'what is the pipeline status',
  'show build status for the project',
  // git reads
  'list git branches',
  'git status of mwei023/MARk',
  'show my recent commits',
  'check on my portfolio',
  'is the portfolio ready',
  'can you check on institution OS and tell me if its ready to pilot',
  // web (light link checks only)
  'is the linkedin link working',
  'check on the link',
  'open the portfolio site in the browser and tell me the title',
  'check whether https://mwei023.github.io responds',
  // system reads (grow the system-agent class — router needs volume there)
  'what ports are listening on my machine',
  'show my cpu load right now',
  'how much memory is free',
  'is the redis container healthy',
  'what is my public ip address',
  // research reads (grow the research-agent class)
  'find open source alternatives to notion',
  'research the latest stable kernel version',
  // reasoning (capped handful — slow by nature)
  'help me understand neural networks',
  'what is eating my disk',
  'good morning mark, what can you do?',
];

function pick(i: number, from: number, to: number): string {
  // deterministic pseudo-rotation so repeats differ pass to pass
  const rot = (i * 7) % Math.max(1, to - from);
  return CATALOG[(from + rot) % CATALOG.length];
}

let pass = 0;
async function runPass(): Promise<{ ok: number; fail: number }> {
  pass += 1;
  let ok = 0, fail = 0;
  // rotate the catalog start each pass so coverage cycles
  const start = (pass * 13) % CATALOG.length;
  for (let n = 0; n < CATALOG.length; n++) {
    const command = CATALOG[(start + n) % CATALOG.length];
    const body = JSON.stringify({ command, sessionId: `probe:${pass}` });
    try {
      const resp = await fetch(`${BASE}/api/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(TOKEN ? { 'x-api-token': TOKEN } : {}),
        },
        body,
        signal: AbortSignal.timeout(90_000),
      });
      if (resp.ok) ok++; else fail++;
    } catch {
      fail++;
    }
    process.stdout.write(`\rprobe pass ${pass}: ${ok} ok / ${fail} failed · ${Math.round((n + 1) / CATALOG.length * 100)}%   `);
  }
  return { ok, fail };
}

async function main() {
  if (LOOP) {
    console.log(`self-exercise daemon: PASS every ${INTERVAL_MS / 1000}s against ${BASE} (ctrl+c to stop)`);
    const tick = async () => {
      const r = await runPass();
      console.log(`\npass complete: ${r.ok} ok, ${r.fail} failed`);
    };
    await tick();
    setInterval(tick, INTERVAL_MS);
  } else {
    const r = await runPass();
    console.log(`\none pass: ${r.ok} ok, ${r.fail} failed (${CATALOG.length} commands)`);
    console.log('check: npm run training:status');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
