import assert from 'node:assert/strict';

import { respondWithLLM, looksLikeMemoryQuestion } from './reasoner';
import { LLMProvider, Message } from './provider';

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
  // A. Plain chat returns text and saves history.
  {
    let saved: Array<[string, string, string]> = [];
    let historyLoaded = false;
    const text = await respondWithLLM('hi', 'u1', {
      provider: fakeProvider('Hello! How can I help?'),
      loadHistory: async () => {
        historyLoaded = true;
        return '';
      },
      retrieve: async () => {
        throw new Error('must not be called');
      },
      saveHistory: async (u, i, r) => {
        saved.push([u, i, r]);
      },
    });
    assert.equal(text, 'Hello! How can I help?');
    assert.ok(historyLoaded);
    assert.deepEqual(saved, [['u1', 'hi', 'Hello! How can I help?']]);
    console.log('PASS (A): plain chat responds and records history');
  }

  // B. Memory questions inject retrieved notes; other questions skip retrieval.
  {
    assert.ok(looksLikeMemoryQuestion("what's my favorite color"));
    assert.ok(!looksLikeMemoryQuestion('what time is it'));
    let seen: Message[] = [];
    const capturing: LLMProvider = {
      chat: async (messages: Message[]) => {
        seen = messages;
        return { content: 'Your favorite color is blue.', model: 'fake', provider: 'fake' };
      },
      getMetadata: () => ({ provider: 'fake', model: 'fake', status: 'available' }),
      isAvailable: async () => true,
    };
    const text = await respondWithLLM("what's my favorite color?", 'u1', {
      provider: capturing,
      retrieve: async () => 'My favourite color is blue',
      loadHistory: async () => '',
      saveHistory: async () => {},
    });
    assert.equal(text, 'Your favorite color is blue.');
    assert.ok(seen.some(m => m.content.includes('My favourite color is blue')));
    console.log('PASS (B): memory questions retrieve notes deterministically (no model tool calls)');
  }

  // C. Empty model output and provider errors propagate (runtime answers unavailable).
  {
    await assert.rejects(
      respondWithLLM('hi', 'u1', { provider: fakeProvider('   '), loadHistory: async () => '', saveHistory: async () => {} }),
      /empty response/,
    );
    await assert.rejects(
      respondWithLLM('hi', 'u1', { provider: fakeProvider(new Error('boom')), loadHistory: async () => '', saveHistory: async () => {} }),
      /boom/,
    );
    console.log('PASS (C): empty output and provider errors propagate honestly');
  }

  // D. Tool-call rejections get one reinforced retry; persistent failure propagates.
  {
    let calls = 0;
    const flaky: LLMProvider = {
      chat: async () => {
        calls += 1;
        if (calls === 1) throw new Error('Groq API error: 400 tool_use_failed, tool_choice is none');
        return { content: 'Playing music is not something I can do from chat.', model: 'fake', provider: 'fake' };
      },
      getMetadata: () => ({ provider: 'fake', model: 'fake', status: 'available' }),
      isAvailable: async () => true,
    };
    const text = await respondWithLLM('play music', 'u1', {
      provider: flaky,
      loadHistory: async () => '',
      saveHistory: async () => {},
    });
    assert.ok(text.includes('Playing music'));
    assert.equal(calls, 2);

    const stubborn: LLMProvider = {
      chat: async () => {
        throw new Error('400 tool_use_failed');
      },
      getMetadata: () => ({ provider: 'fake', model: 'fake', status: 'available' }),
      isAvailable: async () => true,
    };
    await assert.rejects(
      respondWithLLM('play music', 'u1', { provider: stubborn, loadHistory: async () => '', saveHistory: async () => {} }),
      /tool_use_failed/,
    );
    console.log('PASS (D): tool-call rejection retries once, then propagates honestly');
  }

  console.log('PASS: reasoner tests complete');
}

main().catch(error => {
  console.error('FAIL: reasoner test');
  console.error(error);
  process.exitCode = 1;
});
