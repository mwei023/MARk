/**
 * Ops autonomy unit tests — no DB, no LLM, no filesystem.
 *
 * Covers:
 *  1. Persistent ops objective record/snapshot/describe
 *  2. GoalExecutor usePlanner executes a validated composed DAG (stops linear execution)
 *  3. New providers expose repo.semantic + ops.verify tools
 */
import { describe, it, expect } from 'vitest';
import { opsObjective } from './objective.js';
import { GoalExecutor } from '../kernel/goal-execution.js';
import { repoSemanticTools } from '../kernel/providers/repo-semantic.js';
import { opsVerifyTools } from '../kernel/providers/ops-verify.js';

// ─── 1. Persistent objective ────────────────────────────────────────────────
describe('opsObjective', () => {
  it('records events and snapshots counts', () => {
    opsObjective.reset();
    opsObjective.record('incident.seen');
    opsObjective.record('incident.investigated');
    opsObjective.record('incident.fix_proposed');
    opsObjective.record('incident.fix_verified');
    opsObjective.record('incident.resolved');
    const s = opsObjective.snapshot();
    expect(s.incidentsSeen).toBe(1);
    expect(s.investigated).toBe(1);
    expect(s.fixesProposed).toBe(1);
    expect(s.fixesVerified).toBe(1);
    expect(s.resolved).toBe(1);
    expect(s.verificationRate).toBe(1);
    expect(s.objective.length).toBeGreaterThan(10);
  });

  it('describe() is a one-liner for findings', () => {
    opsObjective.reset();
    opsObjective.record('incident.seen');
    expect(opsObjective.describe()).toContain('Objective:');
  });
});

// ─── 2. Real planner path ───────────────────────────────────────────────────
describe('GoalExecutor usePlanner', () => {
  const toolA = {
    id: 'investigate.git_log',
    description: 'recent commits',
    domain: 'investigation',
    risk: 'read',
    available: true,
    inputSchema: { type: 'object', properties: { repoPath: { type: 'string' } }, required: ['repoPath'] },
    outputSchema: { type: 'object', properties: { commits: { type: 'string' } }, required: ['commits'] },
  } as any;
  const toolB = {
    id: 'ops.verify_lint',
    description: 'lint gate',
    domain: 'verification',
    risk: 'read',
    available: true,
    inputSchema: { type: 'object', properties: { repoPath: { type: 'string' } }, required: ['repoPath'] },
    outputSchema: { type: 'object', properties: { errors: { type: 'number' } }, required: ['errors'] },
  } as any;

  it('executes a composed 2-step DAG and returns a planReport', async () => {
    const plan: any = {
      id: 'plan-1',
      goal: 'investigate repo',
      steps: [
        { id: 's1', toolId: toolA.id, input: { repoPath: '/tmp/repo' }, dependsOn: [] },
        { id: 's2', toolId: toolB.id, input: { repoPath: '/tmp/repo' }, dependsOn: ['s1'] },
      ],
      successCriteria: ['done'],
    };
    const executor = new GoalExecutor({
      resolveCapability: () => ({ tool: toolA, score: 1, matchedTerms: [] }) as any,
      bindTask: () => ({ complete: true, matchedFields: ['repoPath'], input: { repoPath: '/tmp/repo' }, missingRequired: [] }) as any,
      execute: async () => ({ status: 'succeeded', observations: [] }) as any,
      planGoal: () => ({ id: 'p', goal: 'g', steps: [], successCriteria: [] }) as any,
      validatePlan: () => ({ valid: true, errors: [] }) as any,
      planComposedGoal: () => plan,
      executePlanReport: async (p: any) => ({
        planId: p.id,
        goal: p.goal,
        status: 'succeeded',
        steps: p.steps.map((s: any) => ({ stepId: s.id, toolId: s.toolId, status: 'succeeded', input: s.input, observations: [] })),
        finalOutputs: {},
        observations: [],
      }) as any,
    });
    const context: any = { userId: 'u', workingDirectory: '/tmp' };
    const out = await executor.executeGoal('investigate repo thoroughly now', context, { usePlanner: true });
    expect(out.executionMode).toBe('plan');
    expect(out.planReport?.status).toBe('succeeded');
    expect(out.planReport?.steps.length).toBe(2);
  });

  it('falls back to single-step when no composed plan validates', async () => {
    const executor = new GoalExecutor({
      resolveCapability: () => ({ tool: toolA, score: 1, matchedTerms: ['repoPath'] }) as any,
      resolveAll: () => [{ tool: toolA, score: 1 }] as any,
      bindTask: () => ({ complete: true, matchedFields: ['repoPath'], input: { repoPath: '/tmp/repo' }, missingRequired: [] }) as any,
      execute: async () => ({ status: 'succeeded', observations: [] }) as any,
      planGoal: () => ({ id: 'p', goal: 'g', steps: [], successCriteria: [] }) as any,
      validatePlan: () => ({ valid: false, errors: [{ code: 'MISSING_DEPENDENCY', message: 'no' }] }) as any,
      planComposedGoal: () => ({ id: 'p2', goal: 'g', steps: [{ id: 's1', toolId: 'x', input: {} }], successCriteria: [] }) as any,
      executePlanReport: async () => { throw new Error('should not run'); },
    });
    const out = await executor.executeGoal('check repoPath /tmp/repo status', { userId: 'u' } as any, { usePlanner: true });
    expect(out.executionMode).toBe('single');
    expect(out.action?.toolId).toBe(toolA.id);
  });
});

// ─── 3. Provider surface ────────────────────────────────────────────────────
describe('ops tool providers', () => {
  it('exposes repo.semantic read tools', () => {
    const ids = repoSemanticTools.map(t => t.id);
    expect(ids).toContain('repo.map');
    expect(ids).toContain('repo.search_symbol');
    expect(ids).toContain('repo.read_window');
    for (const t of repoSemanticTools) {
      if (t.id === 'repo.verify_patch' || t.id === 'repo.index') expect(t.risk).toBe('diagnostic');
      else expect(t.risk).toBe('read');
    }
  });

  it('exposes ops.verify gates', () => {
    const ids = opsVerifyTools.map(t => t.id);
    expect(ids).toContain('ops.verify_lint');
    expect(ids).toContain('ops.verify_types');
    expect(ids).toContain('ops.verify_tests');
    for (const t of opsVerifyTools) expect(t.risk).toBe('read');
  });
});
