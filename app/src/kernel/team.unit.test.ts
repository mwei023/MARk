import { describe, it, expect } from 'vitest';
import { executeTeam, evidenceFromOutput, type TeamDeps, type TeamSubtask, type WorkerResult } from './team.js';
import { attestAcceptance } from './attestation.js';
import type { Strategy } from './strategy.js';
import type { Posterior } from './strategy.js';

const okWorker = (task: string, summary = 'done'): WorkerResult => ({
  subtask: { task, kind: 'read', acceptance: [] },
  status: 'succeeded', summary, observations: [],
  tokens: { inputTokens: 10, outputTokens: 5 }, durationMs: 100,
});

const recorded: Array<{ strategyId: string; trial: any }> = [];

function deps(over: Partial<TeamDeps> = {}): TeamDeps {
  return {
    classify: async () => ({ taskClass: 'repo_analysis' as const }),
    posteriors: async (_cls: string, strategies: Strategy[]) =>
      strategies.map((): Posterior => ({ alpha: 1, beta: 1 })),
    record: (async (input: any) => {
      recorded.push({ strategyId: input.strategyId, trial: input.trial });
      return { id: 'st_test' };
    }) as any,
    runWorker: async (subtask: TeamSubtask) => okWorker(subtask.task, `result for ${subtask.task.slice(0, 30)}`),
    verify: async () => [],
    ...over,
  };
}

describe('team.execute', () => {
  it('runs solo as a topology with trial recorded', async () => {
    recorded.length = 0;
    const r = await executeTeam({ goal: 'map the repo', topology: 'solo' }, deps());
    expect(r.strategyId).toBe('solo');
    expect(r.decision).toBe('ACCEPT');
    expect(r.workers).toHaveLength(1);
    expect(r.tokens.inputTokens).toBe(10);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].trial.success).toBe(true);
  });

  it('dispatches reads in parallel and stops writes on failure', async () => {
    recorded.length = 0;
    const order: string[] = [];
    const d = deps({
      runWorker: async (subtask: TeamSubtask) => {
        order.push(subtask.task);
        if (subtask.task === 'write-one') {
          return { ...okWorker(subtask.task), status: 'failed' as const, summary: 'write failed' };
        }
        return okWorker(subtask.task);
      },
      decompose: async () => ({
        subtasks: [
          { task: 'read-a', kind: 'read', acceptance: [] },
          { task: 'read-b', kind: 'read', acceptance: [] },
          { task: 'write-one', kind: 'write', acceptance: [] },
          { task: 'write-two', kind: 'write', acceptance: [] },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const r = await executeTeam({ goal: 'do the thing', topology: 'parallel-team' }, d);
    expect(r.workers).toHaveLength(3); // 2 reads + write-one; write-two never runs
    expect(order).toContain('read-a');
    expect(order).toContain('read-b');
    expect(order).toContain('write-one');
    expect(order).not.toContain('write-two');
    expect(r.decision).toBe('REJECT'); // a worker failed
  });

  it('falls back to solo when decomposition fails, noting the downgrade', async () => {
    const r = await executeTeam(
      { goal: 'do the thing', topology: 'parallel-team' },
      deps({ decompose: async () => undefined }),
    );
    expect(r.strategyId).toBe('solo');
    expect(r.downgradedFrom).toBe('parallel-team');
    expect(r.workers).toHaveLength(1);
  });

  it('REJECTs on unattested acceptance, ACCEPTs on attested', async () => {
    const d = deps({
      decompose: async () => ({
        subtasks: [{ task: 'check login', kind: 'read', acceptance: ['OAuth callback persists session'] }],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
      runWorker: async (subtask: TeamSubtask) => ({
        ...okWorker(subtask.task),
        observations: [{
          id: 'o', kind: 'output', source: 'test', subject: 't',
          summary: 'OAuth callback persists the authenticated session, verified end to end',
          data: {}, observedAt: new Date().toISOString(),
        }],
      }),
    });
    const r = await executeTeam({ goal: 'verify login', topology: 'parallel-team' }, d);
    expect(r.decision).toBe('ACCEPT');
    expect(r.verdict.allPass).toBe(true);

    const d2 = deps({
      decompose: async () => ({
        subtasks: [{ task: 'check login', kind: 'read', acceptance: ['quantum latency under 3ms'] }],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const r2 = await executeTeam({ goal: 'verify login', topology: 'parallel-team' }, d2);
    expect(r2.decision).toBe('REJECT');
    expect(r2.verdict.unresolvedCount).toBe(1);
  });

  it('marks unimplemented write topologies as downgraded, transparently', async () => {
    const r = await executeTeam({ goal: 'refactor auth', topology: 'worktree-team' }, deps({
      classify: async () => ({ taskClass: 'large_refactor' as const }),
      decompose: async () => ({
        subtasks: [{ task: 'survey auth', kind: 'read', acceptance: [] }],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    }));
    expect(r.strategyId).toBe('supervised-team');
    expect(r.downgradedFrom).toBe('worktree-team');
  });

  it('Thompson-samples when no topology is forced', async () => {
    const seen = new Set<string>();
    const d = deps({
      classify: async () => ({ taskClass: 'research' as const }),
      posteriors: async (_c: string, ss: Strategy[]) => ss.map(() => ({ alpha: 5, beta: 1 })),
      decompose: async () => ({
        subtasks: [{ task: 'survey sources', kind: 'read', acceptance: [] }],
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    for (let i = 0; i < 5; i++) {
      const r = await executeTeam({ goal: 'research vector clocks' }, d);
      seen.add(r.strategyId);
    }
    // research class offers parallel-team + solo; sampling must stay inside the class
    for (const id of seen) expect(['parallel-team', 'solo']).toContain(id);
  });

  it('evidenceFromOutput gives attestation something to match', () => {
    const obs = evidenceFromOutput('repo.map', { ok: true, count: 2, files: ['src/auth.ts', 'src/db.ts'] });
    const v = attestAcceptance(['output names auth.ts', 'output names db.ts'], [obs]);
    expect(v.allPass).toBe(true);
  });

  it('evidence summaries stay structural, never raw content', () => {
    const big = 'x'.repeat(5000);
    const obs = evidenceFromOutput('fs.file_read', { content: big, path: 'a/b' });
    expect(obs.summary.length).toBeLessThanOrEqual(450);
    expect(obs.summary).toContain('a/b');
    expect(obs.summary).not.toContain(big.slice(0, 200));
  });
});
