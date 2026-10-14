import assert from 'node:assert/strict';

import { GoalExecutor } from '../goal-execution';
import { ToolDescriptor } from '../types';

function tool(id: string, required: string[] = []): ToolDescriptor {
  return {
    id,
    name: id,
    description: `Test tool ${id}.`,
    version: '1.0.0',
    domain: 'test',
    risk: 'read',
    available: true,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(required.map(field => [field, { type: 'string' }])),
      required,
    },
    capabilities: [],
    supportedResourceKinds: ['unknown'],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'test',
  };
}

async function main(): Promise<void> {
  const music = tool('test.music');
  const code = tool('test.code', ['pattern']);

  const context: any = { userId: 't', source: 'system', authorityProfile: 'default', metadata: {}, environment: {} };
  const baseDeps = {
    resolveCapability: () => ({ tool: music, score: 1.2, matchedTerms: ['find'], reason: 'top' }),
    resolveAll: () => [
      { tool: music, score: 1.2, matchedTerms: ['find'], idAnchor: true },
      { tool: code, score: 0.8, matchedTerms: ['find'], idAnchor: false },
    ],
    resolveCandidates: () => [
      { tool: music, score: 1.2, matchedTerms: ['find'], idAnchor: true },
      { tool: code, score: 0.8, matchedTerms: ['find'], idAnchor: false },
    ],
    bindTask: (_goal: string, _tool: ToolDescriptor) => ({
      input: {}, missingRequired: [], matchedFields: [], complete: true, reason: 'no inputs',
    }),
    execute: async (action: any) => ({
      actionId: action.id, status: 'succeeded' as const, output: { via: action.toolId }, observations: [],
    }),
  };

  // A. Sync-evidenced winner still wins with no model call.
  {
    let smartCalls = 0;
    let arbitrateCalls = 0;
    const executor = new GoalExecutor({
      ...baseDeps,
      bindTask: (goal: string, selected: ToolDescriptor) => ({
        input: selected.id === 'test.code' ? { pattern: 'x' } : {},
        missingRequired: [],
        matchedFields: selected.id === 'test.code' ? ['pattern'] : [],
        complete: true,
        reason: 'test',
      }),
      bindTaskSmart: async () => {
        smartCalls += 1;
        throw new Error('must not be called');
      },
      arbitrate: async () => {
        arbitrateCalls += 1;
        return code;
      },
    });
    const result = await executor.executeGoal('find things', context);
    assert.equal(result.action?.toolId, 'test.code');
    assert.equal(smartCalls, 0);
    assert.equal(arbitrateCalls, 0);
    console.log('PASS (A): evidenced candidate wins with no model call');
  }

  // B. Arbitration rescues the right tool when ranking misleads.
  {
    const gatedOnly = {
      ...baseDeps,
      resolveAll: () => [{ tool: music, score: 1.2, matchedTerms: ['find'], idAnchor: true }],
      resolveCandidates: () => [
        { tool: music, score: 1.2, matchedTerms: ['find'], idAnchor: true },
        { tool: code, score: 0.8, matchedTerms: ['find'], idAnchor: false },
      ],
    };
    const executor = new GoalExecutor({
      ...gatedOnly,
      bindTaskSmart: async (_goal: string, selected: ToolDescriptor) => {
        if (selected.id !== 'test.code') {
          return { input: {}, missingRequired: [], matchedFields: [], complete: true, reason: 'empty' };
        }
        return { input: { pattern: 'TODO' }, missingRequired: [], matchedFields: ['pattern'], complete: true, reason: 'smart' };
      },
      arbitrate: async (_goal: string, tools: ToolDescriptor[]) => {
        assert.ok(tools.some(t => t.id === 'test.code'));
        return code;
      },
    });
    const result = await executor.executeGoal('find things', context);
    assert.equal(result.action?.toolId, 'test.code');
    assert.deepEqual(result.action?.input, { pattern: 'TODO' });
    console.log('PASS (B): arbitration picks the right tool, smart binding fills values');
  }

  // C. Unknown arbitration picks and failures fall back honestly.
  {
    const executor = new GoalExecutor({
      ...baseDeps,
      arbitrate: async () => tool('test.ghost'),
    });
    const result = await executor.executeGoal('find things', context);
    // Ghost is not a known candidate... fallback runs smart over candidates;
    // default bindTaskSmart is absent here so top complete pick executes.
    assert.equal(result.action?.toolId, 'test.music');
    console.log('PASS (C): unknown arbitration pick ignored, fallback executes top pick');
  }

  console.log('PASS: arbitration tests complete');
}

main().catch(error => {
  console.error('FAIL: arbitration test');
  console.error(error);
  process.exitCode = 1;
});
