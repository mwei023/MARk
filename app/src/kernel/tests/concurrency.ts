import assert from 'node:assert/strict';

import { MARKKernel } from '../index';
import { ToolDescriptor } from '../types';
import { ToolImplementation } from '../executor';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function slowTool(id: string, delayMs: number, events: Array<{ id: string; at: number; kind: string }>): {
  tool: ToolDescriptor;
  implementation: ToolImplementation;
} {
  const tool: ToolDescriptor = {
    id,
    name: `Slow ${id}`,
    description: 'Slow test tool.',
    version: '1.0.0',
    domain: 'timing',
    risk: 'read',
    available: true,
    inputSchema: { type: 'object', properties: {}, required: [] },
    capabilities: [],
    supportedResourceKinds: ['unknown'],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'kernel-timing-test',
  };
  return {
    tool,
    implementation: {
      toolId: id,
      async execute() {
        events.push({ id, at: Date.now(), kind: 'start' });
        await sleep(delayMs);
        events.push({ id, at: Date.now(), kind: 'end' });
        return { output: { done: id }, observations: [] };
      },
    },
  };
}

async function main(): Promise<void> {
  // A. Independent steps overlap in time instead of running back-to-back.
  {
    const kernel = new MARKKernel();
    const events: Array<{ id: string; at: number; kind: string }> = [];
    const a = slowTool('test.slowA', 400, events);
    const b = slowTool('test.slowB', 400, events);
    kernel.registerTool(a.tool);
    kernel.registerTool(b.tool);
    kernel.registerImplementation(a.implementation);
    kernel.registerImplementation(b.implementation);

    const context = kernel.createContext({ userId: 'timing-test', authorityProfile: 'default', source: 'system', metadata: {} });
    const started = Date.now();
    const report = await kernel.executePlanWithReport(
      {
        id: 'plan-timing-1',
        goal: 'run two slow things',
        steps: [
          { id: 'step_a', toolId: a.tool.id, input: {} },
          { id: 'step_b', toolId: b.tool.id, input: {} },
        ],
        successCriteria: ['both done'],
      } as any,
      context,
    );
    const elapsed = Date.now() - started;
    assert.equal(report.status, 'succeeded');
    const starts = events.filter(e => e.kind === 'start').map(e => e.at);
    const ends = events.filter(e => e.kind === 'end').map(e => e.at);
    assert.ok(Math.max(...starts) < Math.min(...ends), 'both steps started before either finished');
    assert.ok(elapsed < 700, `expected overlap, took ${elapsed}ms`);
    console.log(`PASS (A): independent steps overlap (elapsed ${elapsed}ms for 2x400ms)`);
  }

  // B. Dependent steps still serialize in order with data flow intact.
  {
    const kernel = new MARKKernel();
    const order: string[] = [];
    const first: ToolDescriptor = {
      ...slowTool('test.first', 50, []).tool,
      outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    };
    kernel.registerTool(first);
    kernel.registerImplementation({
      toolId: first.id,
      async execute() {
        order.push('first');
        return { output: { value: 'v1' }, observations: [] };
      },
    });
    const second: ToolDescriptor = {
      ...slowTool('test.second', 50, []).tool,
      inputSchema: { type: 'object', properties: { v: { type: 'string' } }, required: [] },
    };
    kernel.registerTool(second);
    kernel.registerImplementation({
      toolId: second.id,
      async execute({ action }) {
        order.push(`second:${JSON.stringify((action.input as any).v ?? null)}`);
        return { output: { ok: true }, observations: [] };
      },
    });

    const context = kernel.createContext({ userId: 'timing-test', authorityProfile: 'default', source: 'system', metadata: {} });
    const report = await kernel.executePlanWithReport(
      {
        id: 'plan-timing-2',
        goal: 'chained steps',
        steps: [
          { id: 'step_1', toolId: first.id, input: {} },
          { id: 'step_2', toolId: second.id, input: { v: '$steps.step_1.output.value' }, dependsOn: ['step_1'] },
        ],
        successCriteria: ['chained'],
      } as any,
      context,
    );
    assert.equal(report.status, 'succeeded');
    assert.deepEqual(order, ['first', 'second:"v1"']);
    console.log('PASS (B): dependent steps serialize with data flow intact');
  }

  console.log('PASS: concurrency tests complete');
}

main().catch(error => {
  console.error('FAIL: concurrency test');
  console.error(error);
  process.exitCode = 1;
});
