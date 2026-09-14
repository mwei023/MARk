import assert from 'node:assert/strict';

import {
  MARKKernel,
} from '../kernel';

import {
  ToolDescriptor,
} from '../types';

async function run() {
  const kernel = new MARKKernel();

  const tool: ToolDescriptor = {
    id: 'test.lookup',
    name: 'Lookup resource',
    description: 'Looks up a resource by query.',
    version: '1.0.0',
    domain: 'test',
    risk: 'read',
    available: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The resource to look up.',
        },
      },
      required: ['query'],
    },
    capabilities: ['resource-lookup'],
    supportedResourceKinds: ['file'],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'test',
  };

  const binding = kernel.bindTask(
    'lookup query: report.pdf',
    tool,
  );

  assert.equal(
    binding.complete,
    true,
  );

  assert.deepEqual(
    binding.input,
    {
      query: 'report.pdf',
    },
  );

  assert.deepEqual(
    binding.missingRequired,
    [],
  );

  assert.ok(
    binding.matchedFields.includes('query'),
  );

  console.log('PASS: task binder binds goal values to tool schema');
  console.log(`Input: ${JSON.stringify(binding.input)}`);
  console.log(`Matched fields: ${binding.matchedFields.join(', ')}`);
}

run().catch(error => {
  console.error('FAIL: task binding test');
  console.error(error);
  process.exit(1);
});
