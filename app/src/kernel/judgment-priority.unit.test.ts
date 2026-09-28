import { describe, it, expect } from 'vitest';
import { GoalExecutor } from './goal-execution.js';
import type { ToolDescriptor } from './types.js';

const tool = (id: string, risk: ToolDescriptor['risk'] = 'read'): ToolDescriptor => ({
  id, name: id, description: `${id} tool`, version: '1.0.0', domain: 'test',
  risk, available: true,
  inputSchema: { type: 'object', properties: {}, required: [] },
  capabilities: [], supportedResourceKinds: [], requiredPermissions: [],
  reversible: true, metadata: {}, provider: 'test',
});

const ctx = { userId: 't', source: 'system', authorityProfile: 'default', workingDirectory: '/tmp', metadata: {}, environment: {} } as any;

/**
 * Judgment-over-inertia: the arbitrator's explicit pick (complete binding,
 * zero matched fields) must beat a rank-leader fallback that carries no
 * binding evidence at all. Guesses still wait (play_track lesson).
 */
describe('arbitration judgment over zero-evidence inertia', () => {
  const leader = tool('rank.leader', 'reversible');
  const picked = tool('judged.pick', 'reversible');

  const deps = (pick: ToolDescriptor | null) => ({
    resolveCapability: () => ({ tool: leader, score: 1.5, matchedTerms: ['x'], reason: 'top' }),
    resolveAll: () => [
      { tool: leader, score: 1.5, matchedTerms: [], idAnchor: false },
      { tool: picked ?? leader, score: 0.5, matchedTerms: [], idAnchor: false },
    ],
    resolveCandidates: () => [
      { tool: leader, score: 1.5, matchedTerms: [], idAnchor: false },
      { tool: picked ?? leader, score: 0.5, matchedTerms: [], idAnchor: false },
    ],
    bindTask: (_goal: string, t: ToolDescriptor) => ({
      // Rank leader binds with zero evidence; the pick binds completely
      // (defaults) with zero matched fields.
      input: {}, missingRequired: [], matchedFields: t.id === leader.id ? [] : [],
      complete: true, reason: 'test',
    }),
    bindTaskSmart: async () => ({ input: {}, missingRequired: [], matchedFields: [], complete: true, reason: 'test' }),
    arbitrate: async () => pick,
    execute: async (action: any) => ({ actionId: action.id, status: 'succeeded', output: { ok: true, ran: action.toolId } }),
  });

  it('runs the judged pick over a zero-evidence fallback', async () => {
    const ex = new GoalExecutor(deps(picked) as any);
    const out = await ex.executeGoal('do the thing', ctx);
    expect(out.action?.toolId).toBe('judged.pick');
  });

  it('keeps the fallback when arbitration abstains', async () => {
    const ex = new GoalExecutor(deps(null) as any);
    const out = await ex.executeGoal('do the thing', ctx);
    expect(out.action?.toolId).toBe('rank.leader');
  });

  it('still prefers an evidenced candidate over the judged pick', async () => {
    const evidenced = tool('rank.evidenced', 'read');
    const ex = new GoalExecutor({
      ...deps(picked),
      resolveAll: () => [
        { tool: leader, score: 1.5, matchedTerms: [], idAnchor: false },
        { tool: evidenced, score: 1.0, matchedTerms: ['thing'], idAnchor: false },
      ],
      bindTask: (_goal: string, t: ToolDescriptor) => ({
        input: t.id === evidenced.id ? { q: 'thing' } : {},
        missingRequired: [],
        matchedFields: t.id === evidenced.id ? ['q'] : [],
        complete: true, reason: 'test',
      }),
    } as any);
    const out = await ex.executeGoal('do the thing', ctx);
    expect(out.action?.toolId).toBe('rank.evidenced');
  });
});
