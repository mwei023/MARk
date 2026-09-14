import assert from 'node:assert/strict';

import {
  markKernel,
  registerNativeSystemProvider,
} from '../index';

async function main(): Promise<void> {
  registerNativeSystemProvider();

  const discovery = await markKernel.discover();

  assert.ok(
    discovery.registeredTools.some(
      tool => tool.id === 'system.machine_info',
    ),
  );

  const context = markKernel.createContext({
    actorId: 'native-system-integration-test',
    authorityProfile: 'default',
    source: 'kernel.integration-test',
  });

  const result = await markKernel.execute(
    {
      id: 'native-system-action-1',
      toolId: 'system.machine_info',
      input: {},
      requestedBy: context.actorId,
      reason: 'Verify native system tool execution.',
      createdAt: new Date().toISOString(),
    },
    context,
  );

  assert.equal(result.status, 'succeeded');

  const output = result.output as {
    hostname: string;
    platform: string;
    architecture: string;
    cpuCount: number;
  };

  assert.equal(typeof output.hostname, 'string');
  assert.equal(typeof output.platform, 'string');
  assert.equal(typeof output.architecture, 'string');
  assert.equal(typeof output.cpuCount, 'number');
  assert.ok(output.cpuCount > 0);

  assert.ok(
    result.observations.some(
      observation => observation.subject === 'local-machine',
    ),
  );

  console.log('PASS: native system integration test');
  console.log(`Discovered tools: ${discovery.registeredTools.length}`);
  console.log(`Hostname: ${output.hostname}`);
  console.log(`Platform: ${output.platform}`);
  console.log(`CPU count: ${output.cpuCount}`);
  console.log(`Action status: ${result.status}`);
}

main().catch(error => {
  console.error('FAIL: native system integration test');
  console.error(error);
  process.exitCode = 1;
});
