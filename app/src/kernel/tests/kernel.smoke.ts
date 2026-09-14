import assert from 'node:assert/strict';

import {
  MARKKernel,
  ToolDescriptor,
  ToolImplementation,
} from '../index';

async function main(): Promise<void> {
  const kernel = new MARKKernel();

  const tool: ToolDescriptor = {
    id: 'test.echo',
    name: 'Echo test tool',
    description: 'Returns the supplied message without changing anything.',
    version: '1.0.0',
    domain: 'testing',
    risk: 'read',
    available: true,
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Message to return.',
        },
      },
      required: ['message'],
    },
    capabilities: ['testing', 'echo'],
    resourceKinds: ['output'],
    provider: 'kernel-smoke-test',
  };

  const implementation: ToolImplementation = {
    toolId: tool.id,

    async execute({ action }) {
      const input = action.input as {
        message: string;
      };

      return {
        output: {
          echoed: input.message,
        },
        observations: [
          {
            id: `observation-${Date.now()}`,
            kind: 'output',
            source: 'kernel.smoke-test',
            subject: 'test.echo',
            summary: `Echoed message: ${input.message}`,
            data: {
              message: input.message,
            },
            confidence: 1,
            relatedActionId: action.id,
            relatedResourceIds: [],
            observedAt: new Date().toISOString(),
          },
        ],
      };
    },
  };

  kernel.registerTool(tool);
  kernel.registerImplementation(implementation);

  const context = kernel.createContext({
    actorId: 'smoke-test',
    authorityProfile: 'default',
    source: 'kernel.smoke-test',
    metadata: {
      purpose: 'kernel smoke test',
    },
  });

  const result = await kernel.execute(
    {
      id: 'smoke-action-1',
      toolId: tool.id,
      input: {
        message: 'MARK kernel is working',
      },
      requestedBy: context.actorId,
      reason: 'Verify the dynamic execution kernel.',
      createdAt: new Date().toISOString(),
    },
    context,
  );

  assert.equal(result.status, 'succeeded');

  assert.deepEqual(result.output, {
    echoed: 'MARK kernel is working',
  });

  assert.equal(result.observations.length, 1);
  assert.match(
    result.observations[0].summary,
    /MARK kernel is working/,
  );

  assert.equal(
    kernel.observationStore.list().length,
    1,
  );

  console.log('PASS: kernel smoke test');
  console.log(`Action status: ${result.status}`);
  console.log(`Observations recorded: ${result.observations.length}`);
}

main().catch(error => {
  console.error('FAIL: kernel smoke test');
  console.error(error);
  process.exitCode = 1;
});
