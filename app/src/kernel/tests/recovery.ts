import assert from 'node:assert/strict';

import {
  MARKKernel,
  ToolDescriptor,
  ToolImplementation,
} from '../index';

function readingTool(id: string, domain = 'sensors'): ToolDescriptor {
  return {
    id,
    name: `Read temperature (${id})`,
    description: 'Reads the ambient temperature in Celsius.',
    version: '1.0.0',
    domain,
    risk: 'read',
    available: true,
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: {
      type: 'object',
      properties: { celsius: { type: 'number' } },
      required: ['celsius'],
    },
    capabilities: ['temperature'],
    supportedResourceKinds: ['device'],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'kernel-recovery-test',
  };
}

async function main(): Promise<void> {
  // A. Failed step recovers via a compatible sibling; dependents proceed.
  {
    const kernel = new MARKKernel();
    const primary = readingTool('test.primary');
    const backup = readingTool('test.backup');
    kernel.registerTool(primary);
    kernel.registerTool(backup);
    kernel.registerImplementation({
      toolId: primary.id,
      async execute() {
        throw new Error('primary sensor offline');
      },
    });
    kernel.registerImplementation({
      toolId: backup.id,
      async execute() {
        return { output: { celsius: 21.5 }, observations: [] };
      },
    });

    const context = kernel.createContext({ userId: 'recovery-test', authorityProfile: 'default', source: 'system', metadata: {} });
    const report = await kernel.executePlanWithReport(
      {
        id: 'plan-recovery-1',
        goal: 'read the temperature',
        steps: [
          { id: 'step_a', toolId: primary.id, input: {} },
          { id: 'step_b', toolId: primary.id, input: {}, dependsOn: ['step_a'] },
        ],
        successCriteria: ['temperature known'],
      } as any,
      context,
    );
    // step_a fails with no sibling covering... backup IS a sibling: same
    // domain, no required inputs, output covers celsius. Both steps recover.
    assert.equal(report.status, 'succeeded');
    const recovered = report.steps.filter(s => (s.result?.metadata as any)?.recoveredVia === backup.id);
    assert.equal(recovered.length, 2);
    assert.ok(report.observations.some(o => o.source === 'kernel.recovery'));
    console.log('PASS (A): failed steps recover via compatible sibling; dependents proceed');
  }

  // B. No compatible sibling: legacy fail + skip behavior preserved.
  {
    const kernel = new MARKKernel();
    const lonely: ToolDescriptor = {
      ...readingTool('test.lonely', 'unique-domain'),
      outputSchema: {
        type: 'object',
        properties: { unobtainium: { type: 'string' } },
        required: ['unobtainium'],
      },
    };
    kernel.registerTool(lonely);
    kernel.registerImplementation({
      toolId: lonely.id,
      async execute() {
        throw new Error('nothing provides unobtainium');
      },
    });
    const context = kernel.createContext({ userId: 'recovery-test', authorityProfile: 'default', source: 'system', metadata: {} });
    const report = await kernel.executePlanWithReport(
      {
        id: 'plan-recovery-2',
        goal: 'fetch unobtainium',
        steps: [
          { id: 'step_a', toolId: lonely.id, input: {} },
          { id: 'step_b', toolId: lonely.id, input: {}, dependsOn: ['step_a'] },
        ],
        successCriteria: ['unobtainium fetched'],
      } as any,
      context,
    );
    assert.equal(report.status, 'failed');
    assert.equal(report.steps[0].status, 'failed');
    assert.equal(report.steps[1].status, 'skipped');
    console.log('PASS (B): no sibling preserves fail + skip behavior');
  }

  // C. Sibling needing confirmation stops recovery (never routes around humans).
  {
    const kernel = new MARKKernel();
    const primary = readingTool('test.primary2');
    const gated: ToolDescriptor = {
      ...readingTool('test.gated'),
      risk: 'reversible',
    };
    kernel.registerTool(primary);
    kernel.registerTool(gated);
    kernel.registerImplementation({
      toolId: primary.id,
      async execute() {
        throw new Error('primary down');
      },
    });
    kernel.registerImplementation({
      toolId: gated.id,
      async execute() {
        return { output: { celsius: 20 }, observations: [] };
      },
    });
    const context = kernel.createContext({ userId: 'recovery-test', authorityProfile: 'default', source: 'system', metadata: {} });
    const report = await kernel.executePlanWithReport(
      {
        id: 'plan-recovery-3',
        goal: 'read temperature with gated backup',
        steps: [{ id: 'step_a', toolId: primary.id, input: {} }],
        successCriteria: ['temperature known'],
      } as any,
      context,
    );
    assert.equal(report.status, 'failed');
    assert.ok(report.observations.some(o => o.source === 'kernel.recovery'));
    console.log('PASS (C): confirmation-gated sibling stops recovery, original failure stands');
  }

  console.log('PASS: recovery tests complete');
}

main().catch(error => {
  console.error('FAIL: recovery test');
  console.error(error);
  process.exitCode = 1;
});
