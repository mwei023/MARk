import assert from 'node:assert/strict';

import {
  MARKKernel,
  ToolDescriptor,
  validateOutput,
} from '../index';
import { registerNativeSystemProvider } from '../providers/register-native';

async function main(): Promise<void> {
  // 1. Missing schema = skip (backward compatible).
  assert.deepEqual(validateOutput({ anything: 1 }, undefined), {
    valid: true,
    errors: [],
  });

  // 2. Valid machine_info output passes its contract.
  const kernel = new MARKKernel();
  registerNativeSystemProvider(kernel);
  await kernel.discover();

  const machineInfo = kernel.listTools().find(t => t.id === 'system.machine_info');
  assert.ok(machineInfo?.outputSchema, 'machine_info should declare outputSchema');

  const context = kernel.createContext({
    userId: 'output-contract-test',
    authorityProfile: 'default',
    source: 'system',
    metadata: {},
  });

  const good = await kernel.execute(
    {
      id: 'output-contract-good',
      toolId: 'system.machine_info',
      input: {},
      requestedBy: context.userId,
      reason: 'Valid output should pass contract validation.',
      createdAt: new Date().toISOString(),
    },
    context,
  );
  assert.equal(good.status, 'succeeded');

  // 3. New native tools execute and satisfy their contracts.
  for (const toolId of ['system.process_summary', 'fs.directory_list']) {
    const result = await kernel.execute(
      {
        id: `output-contract-${toolId}`,
        toolId,
        input: {},
        requestedBy: context.userId,
        reason: `New tool ${toolId} should execute cleanly.`,
        createdAt: new Date().toISOString(),
      },
      context,
    );
    assert.equal(result.status, 'succeeded', `${toolId} should succeed`);
  }

  // 4. Contract violation fails loudly instead of passing bad data along.
  const badTool: ToolDescriptor = {
    id: 'test.contract_violation',
    name: 'Contract violation probe',
    description: 'Returns output that deliberately breaks its schema.',
    version: '1.0.0',
    domain: 'testing',
    risk: 'read',
    available: true,
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    capabilities: ['testing'],
    supportedResourceKinds: ['unknown'],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'output-contract-test',
  } as ToolDescriptor;
  kernel.registerTool(badTool);
  kernel.registerImplementation({
    toolId: badTool.id,
    async execute() {
      return { output: { name: 42 }, observations: [] };
    },
  });

  const bad = await kernel.execute(
    {
      id: 'output-contract-bad',
      toolId: badTool.id,
      input: {},
      requestedBy: context.userId,
      reason: 'Invalid output should be rejected.',
      createdAt: new Date().toISOString(),
    },
    context,
  );
  assert.notEqual(bad.status, 'succeeded');
  assert.match(String(bad.error ?? ''), /contract validation/i);

  console.log('PASS: output contracts (valid, new tools, violation rejected)');
}

main().catch(error => {
  console.error('FAIL: output contracts');
  console.error(error);
  process.exitCode = 1;
});
