/**
 * Team replay suite: solo vs team on identical analysis tasks, same
 * scoreboard. Scratch repo under /tmp, read-only goals, attestation as
 * judge, trials recorded to strategy_trials like production runs.
 *
 * Opt-in only (`npm run eval team-replay`): arms need an LLM for
 * decomposition (SMART off → SKIPPED) and take minutes, not milliseconds.
 * The suite measures; it never declares a winner — posteriors do that.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { markKernelBridge } from '../../kernel/bridge';

interface SuiteResult {
  suite: string;
  passed: number;
  total: number;
  skipped?: string;
  ms: number;
  notes: string[];
}

const SCRATCH = '/tmp/mark-team-replay';

function buildScratch(): void {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(`${SCRATCH}/src`, { recursive: true });
  writeFileSync(`${SCRATCH}/README.md`, '# Replay fixture\nA tiny repo for team replay.\n');
  writeFileSync(`${SCRATCH}/src/auth.ts`, 'export function login(user: string) {\n  return `token-${user}`;\n}\n');
  writeFileSync(
    `${SCRATCH}/src/store.ts`,
    'export function connect(url: string) {\n  const pool = { url };\n  const retry = true;\n  return { pool, retry };\n}\n',
  );
  writeFileSync(`${SCRATCH}/package.json`, '{"name":"replay-fixture","scripts":{}}');
}

export async function runTeamReplaySuite(): Promise<SuiteResult> {
  const started = Date.now();
  if (process.env.MARK_SMART === 'off') {
    return { suite: 'team-replay', passed: 0, total: 0, skipped: 'SMART off — decomposition needs an LLM', ms: 0, notes: [] };
  }
  await markKernelBridge.initialize();
  const ctx = { userId: 'eval', source: 'cli', authorityProfile: 'workspace' } as any;
  const notes: string[] = [];
  let arms = 0;
  let completed = 0;

  // NOTE: goals carry tool vocabulary on purpose ("list", "read the
  // file"). This suite measures solo-vs-team EXECUTION given resolvable
  // goals; vocabulary discovery is a resolver concern tested elsewhere.
  // Acceptance likewise names entities ("pool in store.ts"), not
  // meta-verbs ("output mentions") absent from evidence.
  const tasks = [
    {
      goal: `list every source file in ${SCRATCH}/src with one line each`,
      acceptance: ['auth.ts listed', 'store.ts listed'],
    },
    {
      goal: `read the file ${SCRATCH}/src/store.ts`,
      acceptance: ['pool in store.ts', 'retry in store.ts'],
    },
  ];

  try {
    buildScratch();
    for (const task of tasks) {
      for (const topology of ['solo', 'parallel-team'] as const) {
        arms++;
        try {
          const r = await markKernelBridge.executeTeam(
            { goal: task.goal, topology, acceptance: task.acceptance, maxWorkers: 3, workerTimeoutMs: 90000 }, ctx);
          completed++;
          notes.push(
            `${topology} | ${task.goal.slice(0, 44)}… → ${r.decision} ` +
            `(${(r.durationMs / 1000).toFixed(0)}s, ${(r.tokens.inputTokens + r.tokens.outputTokens)} tok, ` +
            `trial ${r.trialRecorded ? 'recorded' : 'NOT recorded'})`,
          );
        } catch (err) {
          notes.push(`${topology} | ${task.goal.slice(0, 44)}… → ERROR ${(err as Error).message.slice(0, 120)}`);
        }
      }
    }
  } finally {
    try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* scratch */ }
  }
  return { suite: 'team-replay', passed: completed, total: arms, ms: Date.now() - started, notes };
}
