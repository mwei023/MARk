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

  assert.equal(runtime.kernelStatus().initialized, false);
  assert.deepEqual(runtime.listKernelTools(), []);

  const initialized = await runtime.initializeKernel();

  assert.equal(initialized.initialized, true);
  assert.equal(runtime.kernelStatus().initialized, true);
  assert.ok(runtime.listKernelTools().some(tool => tool.id === 'system.machine_info'));

  console.log('PASS: MARK runtime exposes and initializes the execution kernel bridge');
  console.log(`Kernel initialized: ${runtime.kernelStatus().initialized}`);
  console.log(`Kernel tools: ${runtime.listKernelTools().map(tool => tool.id).join(', ')}`);
};

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
