import assert from 'node:assert/strict';

import { proposePlanWithLLM } from '../llm-planner';
import { ToolRegistry } from '../tool-registry';
import { KernelPlanner } from '../planner';
import { ToolDescriptor } from '../types';
import { LLMProvider, Message } from '../../llm';

function fakeProvider(content: string | Error): LLMProvider {
  return {
    chat: async (_messages: Message[]) => {
      if (content instanceof Error) throw content;
      return { content, model: 'fake', provider: 'fake' };
    },
    getMetadata: () => ({ provider: 'fake', model: 'fake', status: 'available' }),
    isAvailable: async () => true,
  };
}

const listTool: ToolDescriptor = {
  id: 'test.list',
  name: 'List things',
  description: 'Lists things in a directory.',
  version: '1.0.0',
  domain: 'test',
  risk: 'read',
  available: true,
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
  capabilities: ['listing'],
  supportedResourceKinds: ['directory'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'kernel-llm-plan-test',
};

function setup() {
  const registry = new ToolRegistry();
  registry.register(listTool);
  const planner = new KernelPlanner({});
  return { tools: [listTool], validate: (plan: Parameters<KernelPlanner['validate']>[0]) => planner.validate(plan, registry) };
}

async function main(): Promise<void> {
  // A. Valid proposal over known tools is accepted.
  {
    const { tools, validate } = setup();
    const result = await proposePlanWithLLM(
      'list the working directory',
      tools,
      validate,
      {
        provider: fakeProvider(
          '{"steps": [{"toolId": "test.list", "input": {"path": "/tmp"}, "dependsOn": []}], "successCriteria": ["directory listed"]}',
        ),
      },
    );
    assert.ok(result);
    assert.equal(result.plan.steps.length, 1);
    assert.equal(result.plan.steps[0].toolId, 'test.list');
    assert.ok(result.validation.valid);
    console.log('PASS (A): valid LLM proposal accepted after validation');
  }

  // B. Unknown tools are dropped; all-bogus proposals rejected.
  {
    const { tools, validate } = setup();
    const mixed = await proposePlanWithLLM('do things', tools, validate, {
      provider: fakeProvider(
        '{"steps": [{"toolId": "test.list", "input": {}, "dependsOn": []}, {"toolId": "test.hallucinated", "input": {}, "dependsOn": [0]}], "successCriteria": []}',
      ),
    });
    assert.ok(mixed);
    assert.equal(mixed.plan.steps.length, 1);
    assert.equal(mixed.droppedSteps, 1);

    const bogus = await proposePlanWithLLM('do things', tools, validate, {
      provider: fakeProvider('{"steps": [{"toolId": "nope.missing", "input": {}}], "successCriteria": []}'),
    });
    assert.equal(bogus, undefined);
    console.log('PASS (B): hallucinated tools dropped; all-bogus proposals rejected');
  }

  // C. Provider failures, garbage, and empty catalogs yield undefined (metadata path stands).
  {
    const { tools, validate } = setup();
    assert.equal(
      await proposePlanWithLLM('x', tools, validate, { provider: fakeProvider(new Error('down')) }),
      undefined,
    );
    assert.equal(
      await proposePlanWithLLM('x', tools, validate, { provider: fakeProvider('nope') }),
      undefined,
    );
    assert.equal(await proposePlanWithLLM('x', [], validate), undefined);
    assert.equal(await proposePlanWithLLM('   ', tools, validate), undefined);
    console.log('PASS (C): failures degrade to undefined, never throw');
  }

  // D. Retry: a correctable first proposal is fixed with validator feedback.
  {
    const { tools, validate } = setup();
    const script2 = [
      '{"steps": [{"toolId": "test.nope", "input": {}, "dependsOn": []}]}',
      '{"steps": [{"toolId": "test.list", "input": {"path": "/tmp"}, "dependsOn": []}], "successCriteria": ["listed"]}',
    ];
    let calls2 = 0;
    const scripted2: LLMProvider = {
      chat: async () => {
        const content = script2[Math.min(calls2++, script2.length - 1)];
        return { content, model: 'fake', provider: 'fake' };
      },
      getMetadata: () => ({ provider: 'fake', model: 'fake', status: 'available' }),
      isAvailable: async () => true,
    };
    const result = await proposePlanWithLLM('list things', tools, validate, { provider: scripted2 });
    assert.ok(result);
    assert.equal(result.plan.steps.length, 1);
    assert.equal(calls2, 2);
    console.log('PASS (D): validator feedback repairs the proposal on retry');
  }

  console.log('PASS: llm planner tests complete');
}

main().catch(error => {
  console.error('FAIL: llm planner test');
  console.error(error);
  process.exitCode = 1;
});
