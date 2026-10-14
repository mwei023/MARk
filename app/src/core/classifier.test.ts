import assert from 'node:assert/strict';

import { classifyWithLLM } from './classifier';
import { LLMProvider, Message } from '../llm';

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
  // A. Valid JSON decision parses.
  {
    const decision = await classifyWithLLM('restart the database container', {
      provider: fakeProvider(
        '{"path": "agent", "agent": "devops-agent", "priority": "high", "reasoning": "container restart", "confidence": 0.85}',
      ),
    });
    assert.ok(decision);
    assert.equal(decision.path, 'agent');
    assert.equal(decision.agent, 'devops-agent');
    assert.equal(decision.confidence, 0.85);
    console.log('PASS (A): valid classification parses');
  }

  // B. Markdown-wrapped JSON parses; reasoning path keeps needsLLM.
  {
    const decision = await classifyWithLLM('hi', {
      provider: fakeProvider(
        '```json\n{"path": "reasoning", "agent": null, "priority": "low", "reasoning": "greeting", "confidence": 0.95}\n```',
      ),
    });
    assert.ok(decision);
    assert.equal(decision.path, 'reasoning');
    assert.equal(decision.needsLLM, true);
    console.log('PASS (B): fenced JSON parses, reasoning keeps needsLLM');
  }

  // C. Garbage, errors, low confidence, and agent-without-agent all fall back to null.
  {
    assert.equal(await classifyWithLLM('x', { provider: fakeProvider('not json at all') }), null);
    assert.equal(await classifyWithLLM('x', { provider: fakeProvider(new Error('down')) }), null);
    assert.equal(
      await classifyWithLLM('x', {
        provider: fakeProvider('{"path": "agent", "agent": "devops-agent", "priority": "high", "reasoning": "?", "confidence": 0.4}'),
      }),
      null,
    );
    assert.equal(
      await classifyWithLLM('x', {
        provider: fakeProvider('{"path": "agent", "agent": null, "priority": "high", "reasoning": "?", "confidence": 0.9}'),
      }),
      null,
    );
    assert.equal(await classifyWithLLM('   ', { provider: fakeProvider('{}') }), null);
    console.log('PASS (C): garbage/errors/low-confidence/agent-without-agent all return null');
  }

  console.log('PASS: classifier tests complete');
}

main().catch(error => {
  console.error('FAIL: classifier test');
  console.error(error);
  process.exitCode = 1;
});
