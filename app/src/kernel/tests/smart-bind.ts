import assert from 'node:assert/strict';

import { TaskBinder, bindTaskSmart } from '../task-binder';
import { ToolDescriptor } from '../types';
import { LLMProvider, Message } from '../../llm';

const tool: ToolDescriptor = {
  id: 'test.lookup',
  name: 'Lookup',
  description: 'Looks things up.',
  version: '1.0.0',
  domain: 'test',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to look up.' },
      limit: { type: 'number', description: 'Max results.' },
    },
    required: ['query'],
  },
  capabilities: [],
  supportedResourceKinds: ['unknown'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'test',
};

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

async function main(): Promise<void> {
  const binder = new TaskBinder();
  const previous = process.env.MARK_SMART;
  process.env.MARK_SMART = 'on';
  try {
    // A. Complete metadata binding never calls the model.
    {
      let calls = 0;
      const counting: LLMProvider = {
        ...fakeProvider('{}'),
        chat: async () => {
          calls += 1;
          return { content: '{}', model: 'fake', provider: 'fake' };
        },
      };
      const result = await bindTaskSmart(binder, 'lookup query: report.pdf', tool, { provider: counting });
      assert.equal(result.complete, true);
      assert.equal(calls, 0);
      console.log('PASS (A): complete metadata binding skips the model');
    }

    // B. LLM fills missing required fields; explicit values win.
    {
      const result = await bindTaskSmart(binder, 'look up flaky service limit: 5', tool, {
        provider: fakeProvider('{"query": "flaky service"}'),
      });
      assert.equal(result.complete, true);
      assert.deepEqual(result.input, { query: 'flaky service', limit: 5 });
      console.log('PASS (B): free-text values extracted, explicit values win');
    }

    // C. Garbage, mistyped values, and unknown fields degrade to base.
    {
      const garbage = await bindTaskSmart(binder, 'look stuff up', tool, {
        provider: fakeProvider('not json'),
      });
      assert.equal(garbage.complete, false);
      assert.deepEqual(garbage.missingRequired, ['query']);

      const wrong = await bindTaskSmart(binder, 'look stuff up', tool, {
        provider: fakeProvider('{"query": {"nested": true}, "bogus": 1, "limit": "many"}'),
      });
      assert.equal(wrong.complete, false);
      console.log('PASS (C): garbage and mistyped values degrade honestly');
    }

    // D. Smart off means metadata only.
    {
      process.env.MARK_SMART = 'off';
      let calls = 0;
      const counting: LLMProvider = {
        ...fakeProvider('{"query": "x"}'),
        chat: async () => {
          calls += 1;
          return { content: '{"query": "x"}', model: 'fake', provider: 'fake' };
        },
      };
      const result = await bindTaskSmart(binder, 'look stuff up', tool, { provider: counting });
      assert.equal(result.complete, false);
      assert.equal(calls, 0);
      console.log('PASS (D): MARK_SMART=off never calls the model');
    }
  } finally {
    if (previous === undefined) delete process.env.MARK_SMART;
    else process.env.MARK_SMART = previous;
  }

  console.log('PASS: smart binding tests complete');
}

main().catch(error => {
  console.error('FAIL: smart binding test');
  console.error(error);
  process.exitCode = 1;
});
