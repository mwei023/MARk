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

  const resolution = kernel.resolveCapability(
    'Tell me about this machine',
  );

  assert.ok(
    resolution.tool,
    'Expected the kernel to discover a capability relevant to the goal',
  );

  assert.equal(
    resolution.tool.id,
    systemMachineInfoTool.id,
  );

  assert.ok(
    resolution.score > 0,
    'Expected a positive capability score',
  );

  assert.ok(
    resolution.matchedTerms.length > 0,
    'Expected at least one metadata match',
  );

  console.log('PASS: kernel resolves capability from goal metadata');
  console.log(`Selected capability: ${resolution.tool.id}`);
  console.log(`Score: ${resolution.score}`);
  console.log(
    `Matched terms: ${resolution.matchedTerms.join(', ')}`,
  );
}

run().catch(error => {
  console.error('FAIL: capability resolution test');
  console.error(error);
  process.exit(1);
});
