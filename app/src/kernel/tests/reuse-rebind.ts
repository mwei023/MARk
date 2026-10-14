import assert from 'node:assert/strict';

import { MARKKernel } from '../index';
import { ToolDescriptor } from '../types';

const searchTool: ToolDescriptor = {
  id: 'test.find',
  name: 'Find things',
  description: 'Finds things by pattern in a path.',
  version: '1.0.0',
  domain: 'test',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text pattern to find.' },
      path: { type: 'string', description: 'Directory to search.' },
    },
    required: ['pattern'],
  },
  capabilities: ['finding'],
  supportedResourceKinds: ['file'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'kernel-rebind-test',
};

async function main(): Promise<void> {
  const kernel = new MARKKernel();
  kernel.registerTool(searchTool);
  kernel.registerImplementation({
    toolId: searchTool.id,
    async execute({ action }) {
      return { output: { echo: action.input }, observations: [] };
    },
  });

  // Teach: a plan with stored explicit inputs.
  const taught = kernel.saveWorkflow({
    id: 'plan-teach-1',
    goal: 'search pattern: TODO path: src',
    steps: [{ id: 'step_teach_1', toolId: searchTool.id, input: { pattern: 'TODO', path: 'src' } }],
    successCriteria: ['found'],
  });

  // A. New goal with new explicit values rebinds; stale values don't replay.
  const rebound = kernel.reuseWorkflow('search pattern: FIXME path: /tmp');
  assert.ok(rebound, 'expected reuse on strong overlap');
  assert.deepEqual(rebound.plan.steps[0].input, { pattern: 'FIXME', path: '/tmp' });
  console.log('PASS (A): explicit new values rebind on reuse');

  // B. New goal without explicit values keeps the stored input.
  const kept = kernel.reuseWorkflow('search pattern: TODO path: src');
  assert.ok(kept);
  assert.deepEqual(kept.plan.steps[0].input, { pattern: 'TODO', path: 'src' });
  console.log('PASS (B): stored input kept when the new goal states nothing new');

  // C. Incomplete binding never wipes stored values.
  const partial = kernel.reuseWorkflow('search for things generally with pattern: TODO');
  assert.ok(partial);
  assert.deepEqual(partial.plan.steps[0].input, { pattern: 'TODO', path: 'src' });
  console.log('PASS (C): incomplete bindings keep stored values');

  void taught;
  console.log('PASS: reuse rebind tests complete');
}

main().catch(error => {
  console.error('FAIL: reuse rebind test');
  console.error(error);
  process.exitCode = 1;
});
