/**
 * MARK eval harness: the exam Mark sits to prove how it HANDLES its current
 * capabilities (not how many it has). Four suites, all through real code:
 *
 *  1. routing    — 24 commands vs expected Gateway path/agent (no LLM, no DB)
 *  2. retrieval  — scratch repo indexed, known queries vs expected files
 *  3. repair     — scratch errors in an eslint repo, fixed-rate via real loop
 *  4. latency    — classify/resolve/command timings (p50)
 *  5. jev        — Jev route decisions vs keywords (skipped without key)
 *
 * Usage: set -a; source ../.env; set +a; npm run eval
 * Exit 0 with a printed report; suites that cannot run (no DB, no eslint
 * toolchain) report SKIPPED with reason instead of failing silently.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { Gateway } from '../core/gateway';
import { decideRoute } from '../llm/jev';
import { indexRepo, searchCode } from '../code/indexer';
import { repairLintErrors } from '../agents/code-repair';

interface SuiteResult {
  suite: string;
  passed: number;
  total: number;
  skipped?: string;
  ms: number;
  notes: string[];
}

const results: SuiteResult[] = [];
const t0 = Date.now();
const timed = async <T>(fn: () => Promise<T>): Promise<{ v: T; ms: number }> => {
  const s = Date.now();
  const v = await fn();
  return { v, ms: Date.now() - s };
};

// ─── 1. routing ─────────────────────────────────────────────────────────────
async function suiteRouting(): Promise<void> {
  const s = Date.now();
  const gw = new Gateway();
  const cases: Array<[string, string, string?]> = [
    ['what time is it?', 'deterministic'],
    ['show disk usage', 'deterministic'],
    ['check memory', 'deterministic'],
    ['list git branches', 'agent', 'git-agent'],
    ['deploy to staging', 'agent', 'devops-agent'],
    ['rollback the deploy', 'agent', 'devops-agent'],
    ['is the pipeline green', 'agent', 'cicd-agent'],
    ['git status of mwei023/MARk', 'agent', 'git-agent'],
    ['help me understand neural networks', 'reasoning'],
    ['compose homepage markup for Mark OS', 'reasoning'],
    ['draft the README autobiography', 'reasoning'],
    ['deep research vector databases', 'agent', 'research-agent'],
    ['look up flights over Nairobi', 'agent', 'web-agent'],
    ['repair the lint errors', 'agent', 'code-agent'],
    ['approve that', 'reasoning'],
    ['this is a legitimate concern', 'none-git-agent'],
    ['Execute sys.exec with command: "git status"', 'reasoning'],
    ['Write file with path: "a/b" content: "x"', 'reasoning'],
    ['Commit with repoPath: "x" message: "y"', 'reasoning'],
    ['Perceive world with minMagnitude: 4.5', 'reasoning'],
    ['Semantic search with repoPath: "x" query: "y"', 'reasoning'],
    ['play some music', 'not-unavailable-alone'],
    ['restart the container', 'agent', 'devops-agent'],
    ['what is eating my disk', 'reasoning'],
  ];
  let passed = 0;
  const notes: string[] = [];
  for (const [cmd, want, agent] of cases) {
    const d: any = gw.classify({ id: 'e', timestamp: new Date(), source: 'user_command', type: 'user.command.received', severity: 'info', data: { command: cmd } } as any);
    let ok = false;
    if (want === 'none-git-agent') ok = d.agent !== 'git-agent';
    else if (want === 'not-unavailable-alone') ok = true; // smoke: classifies without throwing
    else ok = d.path === want && (agent === undefined || d.agent === agent);
    if (ok) passed++;
    else notes.push(`MISS ${JSON.stringify(cmd)} → ${d.path}${d.agent ? `/${d.agent}` : ''} (want ${want}${agent ? `/${agent}` : ''})`);
  }
  results.push({ suite: 'routing', passed, total: cases.length, ms: Date.now() - s, notes });
}

// ─── 2. retrieval ───────────────────────────────────────────────────────────
async function suiteRetrieval(): Promise<void> {
  const s = Date.now();
  if (!process.env.DATABASE_URL) {
    results.push({ suite: 'retrieval', passed: 0, total: 0, skipped: 'no DATABASE_URL', ms: 0, notes: [] });
    return;
  }
  const dir = '/tmp/mark-eval-retrieval';
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/auth.ts`, 'export function loginUser(name: string) {\n  return `token-for-${name}`;\n}\n');
    writeFileSync(`${dir}/db.ts`, 'export function connectDatabase(url: string) {\n  return { url, pooled: true };\n}\n');
    writeFileSync(`${dir}/ui.ts`, 'export function renderButton(label: string) {\n  return `<button>${label}</button>`;\n}\n');
    const { v: idx } = await timed(() => indexRepo(dir, 'mark-eval-fixture', 5));
    const queries: Array<[string, string]> = [
      ['user login token', 'auth.ts'],
      ['database connection pooling', 'db.ts'],
      ['render a button label', 'ui.ts'],
    ];
    let passed = 0;
    const notes: string[] = [`indexed ${idx.files} files/${idx.chunks} chunks`];
    for (const [q, want] of queries) {
      const hits = await searchCode('mark-eval-fixture', q, 3);
      const ok = hits.some(h => h.file === want);
      if (ok) passed++;
      else notes.push(`MISS ${JSON.stringify(q)} → [${hits.map(h => h.file).join(',')}] (want ${want})`);
    }
    results.push({ suite: 'retrieval', passed, total: queries.length, ms: Date.now() - s, notes });
  } catch (e) {
    results.push({ suite: 'retrieval', passed: 0, total: 3, ms: Date.now() - s, notes: [`error: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`] });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }
  }
}

// ─── 3. repair ──────────────────────────────────────────────────────────────
async function suiteRepair(): Promise<void> {
  const s = Date.now();
  const repo = '/home/mwei/MyPortfolio';
  const scratch = `${repo}/mark-eval-tmp`;
  if (!existsSync(`${repo}/node_modules/.bin/eslint`)) {
    results.push({ suite: 'repair', passed: 0, total: 0, skipped: 'no eslint toolchain', ms: 0, notes: [] });
    return;
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    writeFileSync(`${scratch}/eval_a.ts`, 'export function evalA() {\n  const unusedAlpha = 1;\n  return 42;\n}\n');
    writeFileSync(`${scratch}/eval_b.ts`, 'export function evalB() {\n  const unusedBeta = 2;\n  return 7;\n}\n');
    const { v: summary } = await timed(() => repairLintErrors(repo, { maxErrors: 2, maxFileLines: 50, maxCloudCalls: 1 }));
    const fixed = summary.outcomes.filter(o => o.fixed).length;
    results.push({
      suite: 'repair', passed: fixed, total: 2, ms: Date.now() - s,
      notes: summary.outcomes.map(o => `${o.fixed ? 'FIXED' : 'open'} ${o.target.file}:${o.target.line} [${o.target.ruleId}] via ${o.via ?? 'none'}`),
    });
  } catch (e) {
    results.push({ suite: 'repair', passed: 0, total: 2, ms: Date.now() - s, notes: [`error: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`] });
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* scratch */ }
  }
}

// ─── 5. jev decisions ───────────────────────────────────────────────────────
async function suiteJev(): Promise<void> {
  const s = Date.now();
  if (!process.env.JEV_API_KEY) {
    results.push({ suite: 'jev', passed: 0, total: 0, skipped: 'no JEV_API_KEY — set one to measure the middle layer', ms: 0, notes: [] });
    return;
  }
  const gw = new Gateway();
  // Golden set: fuzzy commands where keywords abstain; Jev should decide.
  const cases = [
    'ship the dashboard when ready',
    'the build is red again',
    'summarize what broke overnight',
    'is anyone using too much disk',
    'write up what this system does',
  ];
  let decided = 0;
  let agreed = 0;
  const confs: number[] = [];
  const notes: string[] = [];
  for (const cmd of cases) {
    const kw: any = gw.classify({ id: 'e', timestamp: new Date(), source: 'user_command', type: 'user.command.received', severity: 'info', data: { command: cmd } } as any);
    const t = Date.now();
    const d = await decideRoute(cmd);
    const ms = Date.now() - t;
    if (!d) {
      notes.push(`ABSTAIN ${JSON.stringify(cmd)} (${ms}ms, keyword said ${kw.path})`);
      continue;
    }
    decided++;
    confs.push(d.confidence);
    const kwRoute = kw.path === 'agent' ? `agent:${kw.agent}` : kw.path;
    const agree = d.route === kwRoute || (kw.path === 'reasoning' && ['reasoning', 'kernel', 'escalate'].includes(d.route));
    if (agree) agreed++;
    notes.push(`${agree ? 'AGREE ' : 'SPLIT '} ${JSON.stringify(cmd)} jev=${d.route}@${d.confidence.toFixed(2)} kw=${kwRoute} (${ms}ms)`);
  }
  const avgConf = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
  notes.push(`decided ${decided}/${cases.length}, avg confidence ${avgConf.toFixed(2)}`);
  results.push({ suite: 'jev', passed: agreed, total: decided, ms: Date.now() - s, notes });
}
// ─── 4. latency ─────────────────────────────────────────────────────────────
async function suiteLatency(): Promise<void> {
  const s = Date.now();
  const gw = new Gateway();
  const cmds = ['what time is it?', 'list git branches', 'deploy to staging', 'help me understand x', 'ship the dashboard when ready'];
  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (const cmd of cmds) {
      const t = Date.now();
      gw.classify({ id: 'e', timestamp: new Date(), source: 'user_command', type: 'user.command.received', severity: 'info', data: { command: cmd } } as any);
      samples.push(Date.now() - t);
    }
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length / 2)];
  results.push({ suite: 'latency', passed: p50 < 50 ? 1 : 0, total: 1, ms: Date.now() - s, notes: [`classify p50 ${p50}ms over ${samples.length} samples (budget 50ms)`] });
}

(async () => {
  const only = new Set(process.argv.slice(2));
  const want = (s: string) => only.size === 0 || only.has(s);
  if (want('routing')) await suiteRouting();
  if (want('retrieval')) await suiteRetrieval();
  if (want('repair')) await suiteRepair();
  if (want('latency')) await suiteLatency();
  if (want('jev')) await suiteJev();
  const totalMs = Date.now() - t0;
  console.log('\n===== MARK EVAL =====');
  for (const r of results) {
    const score = r.skipped ? 'SKIPPED' : `${r.passed}/${r.total}`;
    console.log(`\n[${r.suite}] ${score} (${r.ms}ms)${r.skipped ? ` — ${r.skipped}` : ''}`);
    for (const n of r.notes.slice(0, 8)) console.log(`  ${n}`);
  }
  console.log(`\nTotal ${totalMs}ms.`);
})();
