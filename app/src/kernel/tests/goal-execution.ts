import assert from 'node:assert/strict';

import {
  MARKKernel,
} from '../kernel';

import {
  systemMachineInfoTool,
  systemMachineInfoImplementation,
} from '../providers/system-tools';

async function run() {
  const kernel = new MARKKernel();

  kernel.registerTool(systemMachineInfoTool);
  kernel.registerImplementation(systemMachineInfoImplementation);

  const context = kernel.createContext({
    userId: 'test-user',
    source: 'cli',
  });

  const execution = await kernel.executeGoal(
    'Tell me about this machine',
    context,
  );

  assert.ok(
    execution.resolution.tool,
    'Expected goal resolution to select a capability',
  );

  assert.equal(
    execution.resolution.tool.id,
    systemMachineInfoTool.id,
  );

  assert.ok(
    execution.action,
    'Expected a structured action to be created',
  );

  assert.equal(
    execution.action.toolId,
    systemMachineInfoTool.id,
  );

  assert.ok(
    execution.result,
    'Expected the resolved capability to execute',
  );

  assert.equal(
    execution.result.status,
    'succeeded',
  );

  assert.ok(
    execution.result.observations.length > 0,
    'Expected execution to produce observations',
  );

  const output = execution.result.output as {
    hostname?: string;
    platform?: string;
  };

  assert.equal(
    typeof output.hostname,
    'string',
  );

  assert.equal(
    typeof output.platform,
    'string',
  );

  console.log('PASS: goal resolves and executes through the kernel');
  console.log(`Goal: ${execution.goal}`);
  console.log(`Selected capability: ${execution.resolution.tool.id}`);
  console.log(`Action status: ${execution.result.status}`);
  console.log(`Observations returned: ${execution.result.observations.length}`);
  console.log(`Observed hostname: ${output.hostname}`);
  console.log(`Observed platform: ${output.platform}`);
}

run().catch(error => {
  console.error('FAIL: goal execution test');
  console.error(error);
  process.exit(1);
});
