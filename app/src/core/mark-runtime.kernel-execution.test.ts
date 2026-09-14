import assert from 'node:assert/strict';
import { AgentRuntime } from './agent-runtime';
import { EventBus } from './event-bus';
import { Gateway } from './gateway';
import { MarkRuntime, Reasoner } from './mark-runtime';
import { CapabilityRegistry } from '../runtime/capabilities/registry';
import { MARKKernelBridge } from '../kernel/bridge';
import { MARKKernel } from '../kernel/kernel';

const run = async (): Promise<void> => {
  const kernel = new MARKKernel();
  const bridge = new MARKKernelBridge(kernel);

  const reasoner: Reasoner = {
    respond: async input => `reasoned: ${input}`,
  };

  const runtime = new MarkRuntime({
    eventBus: new EventBus(),
    gateway: new Gateway(),
    agents: new AgentRuntime(),
    capabilities: new CapabilityRegistry(),
    reasoner,
    kernelBridge: bridge,
  });

  await runtime.initializeKernel();

  const result = await runtime.executeKernelTool(
    'system.machine_info',
    {},
    'kernel-test-user',
    'cli',
  );

  assert.equal(result.status, 'succeeded');
  assert.equal(result.actionId.startsWith('ACT-'), true);
  assert.ok(result.output);
  assert.match(result.output ?? '', /platform/i);
  assert.ok(result.observations.length >= 1);
  assert.equal(result.observations[0].kind, 'system');

  console.log('PASS: MARK executes a discovered tool through the structured kernel path');
  console.log(`Action status: ${result.status}`);
  console.log(`Observations returned: ${result.observations.length}`);
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
