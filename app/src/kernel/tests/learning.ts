import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ReliabilityTracker } from '../reliability';
import { TrustStore } from '../trust';
import { MARKKernel, ToolImplementation } from '../index';
import { executeStructuredPlan } from '../plan-execution';
import { episodeMemory } from '../episode-memory';

function readingTool(id: string): import('../types').ToolDescriptor {
  return {
    id,
    name: 'Read temperature',
    description: 'Reads the ambient temperature in Celsius.',
    version: '1.0.0',
    domain: 'sensors',
    risk: 'read',
    available: true,
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: { type: 'object', properties: { celsius: { type: 'number' } }, required: ['celsius'] },
    capabilities: ['temperature'],
    supportedResourceKinds: ['device'],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'kernel-learning-test',
  };
}

async function main(): Promise<void> {
  // A. Reliability: unknown is neutral, history moves the score.
  {
    const tracker = new ReliabilityTracker();
    assert.equal(tracker.score('test.new'), 0.5);
    tracker.record('test.tool', 'success');
    tracker.record('test.tool', 'success');
    tracker.record('test.tool', 'failure');
    assert.equal(tracker.score('test.tool'), (2 + 1) / (3 + 2));
    assert.ok(tracker.score('test.tool') > tracker.score('test.new'));
    console.log('PASS (A): reliability is neutral when unknown, learns from outcomes');
  }

  // B. Trust streaks: 5 approved successes suggest, denial resets, granted excluded.
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mark-trust-'));
    const store = new TrustStore(path.join(dir, 'trust.json'));
    for (let i = 0; i < 4; i++) store.recordApprovedExecution('test.steady', true);
    assert.equal(store.suggestTrust().length, 0);
    store.recordApprovedExecution('test.steady', true);
    const suggestions = store.suggestTrust();
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].toolId, 'test.steady');
    store.recordApprovedExecution('test.steady', false);
    assert.equal(store.suggestTrust().length, 0);
    store.recordApprovalResolved('test.denied', false);
    assert.equal(store.suggestTrust().length, 0);
    store.trust('test.granted', 'user');
    for (let i = 0; i < 6; i++) store.recordApprovedExecution('test.granted', true);
    assert.ok(!store.suggestTrust().some(s => s.toolId === 'test.granted'));
    await fs.rm(dir, { recursive: true, force: true });
    console.log('PASS (B): trust suggests after streak, resets on failure/denial, excludes granted');
  }

  // C. Recovery prefers the sibling with successful similar episodes.
  {
    const kernel = new MARKKernel();
    const primary = readingTool('test.plain');
    const siblingA = readingTool('test.sibA');
    const siblingB = readingTool('test.sibB');
    for (const tool of [primary, siblingA, siblingB]) kernel.registerTool(tool);
    kernel.registerImplementation({
      toolId: primary.id,
      async execute() {
        throw new Error('primary sensor offline');
      },
    });
    const okImpl: ToolImplementation = {
      toolId: 'test.sib',
      async execute() {
        return { output: { celsius: 22 }, observations: [] };
      },
    };
    kernel.registerImplementation({ ...okImpl, toolId: siblingA.id });
    kernel.registerImplementation({ ...okImpl, toolId: siblingB.id });

    const context = kernel.createContext({ userId: 'learning-test', authorityProfile: 'default', source: 'system', metadata: {} });
    const plan = {
      id: 'plan-learn-1',
      goal: 'read temperature',
      steps: [{ id: 'step_a', toolId: primary.id, input: {} }],
      successCriteria: ['temperature known'],
    } as any;
    const recall = async () => [
      { toolId: siblingB.id, status: 'succeeded' },
      { toolId: siblingB.id, status: 'succeeded' },
      { toolId: siblingA.id, status: 'failed' },
    ];
    const report = await executeStructuredPlan({
      plan,
      context,
      validation: kernel.validatePlan(plan),
      executeStep: (action, ctx) => kernel.executor.execute(action, ctx),
      recovery: { tools: kernel.listTools(), maxAlternativesPerStep: 2, recall },
    });
    assert.equal(report.status, 'succeeded');
    assert.equal((report.steps[0].result?.metadata as any)?.recoveredVia, siblingB.id);
    assert.ok(report.observations.some(o => o.source === 'kernel.recovery' && /memory/.test(o.summary)));
    console.log('PASS (C): recovery prefers sibling with successful similar episodes');
  }

  // D. Learning degrades gracefully offline (MARK_LEARNING=off).
  {
    process.env.MARK_LEARNING = 'off';
    try {
      const recorded = await episodeMemory.record({ toolId: 'test.x', status: 'succeeded', summary: 'x' });
      assert.equal(recorded, undefined);
      assert.deepEqual(await episodeMemory.recallSimilar('x'), []);
    } finally {
      delete process.env.MARK_LEARNING;
    }
    console.log('PASS (D): episode memory is a silent no-op when learning is off');
  }

  console.log('PASS: learning tests complete');
}

main().catch(error => {
  console.error('FAIL: learning test');
  console.error(error);
  process.exitCode = 1;
});
