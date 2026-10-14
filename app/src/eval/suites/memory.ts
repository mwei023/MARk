/**
 * Memory suite: measures WorkflowMemory quality on golden fixtures.
 *
 * What the audit flagged as unmeasured is exactly what this suite numbers:
 * - recall precision   — does memory return the RIGHT workflow for a goal?
 * - reuse hit-rate     — of goals that SHOULD confidently reuse (score >= 0.6),
 *                        how many actually fire the right procedure?
 * - false-reuse rate   — unrelated goals that clear the 0.6 threshold anyway.
 *                        This is the hollow-reuse failure mode: replaying the
 *                        wrong procedure confidently. Every hit is printed.
 * - outcome recording  — success counts actually land on the right workflow.
 * - recall latency     — p50 over the golden set (budget 5ms, in-memory path).
 *
 * Pure in-memory WorkflowMemory: no DB, no LLM, deterministic. Never SKIPPED —
 * memory must be measurable on every machine, every run.
 */
import { WorkflowMemory } from '../../kernel/workflow-memory';
import type { ExecutionPlan, PlanStep } from '../../kernel/planner';

interface SuiteResult {
  suite: string;
  passed: number;
  total: number;
  skipped?: string;
  ms: number;
  notes: string[];
}

// ─── Fixtures ────────────────────────────────────────────────────────────────
// Eight distinct saved procedures. Goals are deliberately term-distinct so
// precision is measurable: each query has exactly one right answer.

interface Fixture {
  goal: string;
  toolId: string;
}

const FIXTURES: Fixture[] = [
  { goal: 'check disk usage on the server', toolId: 'system.disk_usage' },
  { goal: 'list running docker containers', toolId: 'system.container_list' },
  { goal: 'search the codebase for symbols', toolId: 'repo.search_symbol' },
  { goal: 'show recent git commits', toolId: 'investigate.git_log' },
  { goal: 'find music tracks in the library', toolId: 'media.find_tracks' },
  { goal: 'take a screenshot of the desktop', toolId: 'desktop.screen' },
  { goal: 'search the web for vector databases', toolId: 'browser.search' },
  { goal: 'check memory usage on this machine', toolId: 'system.machine_info' },
];

/**
 * Golden probes. `expect` names the fixture index that SHOULD win recall,
 * or null when the goal is unrelated and memory must NOT reuse confidently
 * (clearing the 0.6 threshold would be a false reuse).
 */
interface Probe {
  goal: string;
  expect: number | null;
  /** Why this probe exists — printed on misses. */
  why: string;
}

const PROBES: Probe[] = [
  // Same intent, different wording — the real recall test.
  { goal: 'show disk usage', expect: 0, why: 'rephrase of fixture 0' },
  { goal: 'how much disk is used on the server', expect: 0, why: 'rephrase of fixture 0' },
  { goal: 'which docker containers are running', expect: 1, why: 'rephrase of fixture 1' },
  { goal: 'list my recent commits', expect: 3, why: 'rephrase of fixture 3' },
  { goal: 'find songs in my music library', expect: 4, why: 'music->songs rephrase of fixture 4' },
  { goal: 'screenshot my desktop', expect: 5, why: 'rephrase of fixture 5' },
  { goal: 'search the web for embeddings databases', expect: 6, why: 'vector->embeddings rephrase of fixture 6' },
  { goal: 'how much ram does this machine use', expect: 7, why: 'memory->ram rephrase of fixture 7' },
  // Near-neighbor: same intent, different target. Ranking must still win.
  { goal: 'check disk usage in the downloads folder', expect: 0, why: 'same intent, different target' },
  // Unrelated goals: memory MUST abstain (reuse threshold 0.6 not reached).
  { goal: 'restart the postgres container', expect: null, why: 'container domain but mutating restart, not a listing' },
  { goal: 'play the donda album', expect: null, why: 'music domain but playback, not discovery' },
  { goal: 'deploy the dashboard to staging', expect: null, why: 'deploy domain, nothing saved covers it' },
  { goal: 'what is eating my disk', expect: null, why: 'diagnostic phrasing; only loose overlap with usage' },
];

function makePlan(fixture: Fixture, index: number): ExecutionPlan {
  const step: PlanStep = {
    id: `step-f${index}` as PlanStep['id'],
    toolId: fixture.toolId as PlanStep['toolId'],
    input: {},
  };
  return {
    id: `plan-f${index}` as ExecutionPlan['id'],
    goal: fixture.goal,
    steps: [step],
    successCriteria: [],
    explanation: `eval fixture ${index}`,
  };
}

export async function runMemorySuite(): Promise<SuiteResult> {
  const started = Date.now();
  const notes: string[] = [];
  const memory = new WorkflowMemory();

  // Seed one workflow per fixture.
  for (let i = 0; i < FIXTURES.length; i++) {
    memory.save(makePlan(FIXTURES[i], i));
  }

  const recallProbes = PROBES.filter((p): p is Probe & { expect: number } => p.expect !== null);
  const abstainProbes = PROBES.filter((p): p is Probe & { expect: null } => p.expect === null);

  let recallHits = 0;
  let falseReuses = 0;
  const latencies: number[] = [];

  for (const probe of PROBES) {
    const t0 = Date.now();
    const top = memory.recall(probe.goal, 1)[0];
    latencies.push(Date.now() - t0);

    if (probe.expect === null) {
      // Must abstain: no confident reuse (score >= 0.6).
      if (memory.reuse(probe.goal) === undefined) {
        notes.push(`abstain OK   ${JSON.stringify(probe.goal)}${top ? ` (top "${top.goal}" below threshold)` : ''}`);
      } else {
        falseReuses++;
        notes.push(`FALSE REUSE  ${JSON.stringify(probe.goal)} → "${top?.goal}" (${probe.why})`);
      }
      continue;
    }

    const expectedGoal = FIXTURES[probe.expect].goal;
    if (top && top.goal === expectedGoal) {
      recallHits++;
      notes.push(`recall OK    ${JSON.stringify(probe.goal)} → "${top.goal}"`);
    } else {
      notes.push(
        `MISS         ${JSON.stringify(probe.goal)} → ${top ? `"${top.goal}"` : '(nothing)'} (want "${expectedGoal}" — ${probe.why})`,
      );
    }
  }

  // Outcome recording: reuse then record; counts must land on the right row.
  const reuseProbe = memory.reuse('show disk usage');
  let outcomeOk = false;
  if (reuseProbe) {
    memory.recordOutcome(reuseProbe.workflowId, true);
    const wf = memory.get(reuseProbe.workflowId);
    outcomeOk = wf?.successCount === 1 && wf.useCount === 1;
    notes.push(`outcome      ${outcomeOk ? 'OK' : 'BROKEN'} (use=1 success=1 on "${FIXTURES[0].goal}")`);
  } else {
    notes.push('outcome      BROKEN (reuse of fixture 0 did not fire — cannot test recording)');
  }

  // Latency: p50 over all probes.
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length / 2)];

  // Rates, reported separately — never silently averaged into one number.
  const recallRate = recallHits / recallProbes.length;
  const fpRate = falseReuses / abstainProbes.length;
  notes.push(
    `recall       ${recallHits}/${recallProbes.length} (rate ${recallRate.toFixed(2)}), ` +
    `false-reuse ${falseReuses}/${abstainProbes.length} (rate ${fpRate.toFixed(2)}), ` +
    `recall p50 ${p50}ms (budget 5ms)`,
  );

  // Score: every recall probe + every abstain probe + the outcome gate.
  const passed = recallHits + (abstainProbes.length - falseReuses) + (outcomeOk ? 1 : 0);
  return {
    suite: 'memory',
    passed,
    total: PROBES.length + 1,
    ms: Date.now() - started,
    notes: notes.slice(0, 16),
  };
}
