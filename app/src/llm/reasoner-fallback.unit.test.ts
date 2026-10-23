import { describe, expect, it } from 'vitest';
import { respondWithLLM, respondWithLLMStream } from './reasoner.js';
import type { LLMProvider, Message } from './provider.js';

function provider(name: string, chat: LLMProvider['chat'], stream?: LLMProvider['stream']): LLMProvider {
  return {
    chat,
    ...(stream ? { stream } : {}),
    getMetadata: () => ({ provider: name, model: 'test', status: 'available' }),
    isAvailable: async () => true,
  };
}

describe('runtime LLM fallback', () => {
  it('switches providers after a rate-limit response', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = provider('groq', async () => {
      primaryCalls++;
      throw new Error('Groq API error: 429 rate_limit_exceeded');
    });
    const fallback = provider('ollama', async () => {
      fallbackCalls++;
      return { content: 'fallback response', model: 'test', provider: 'ollama' };
    });

    const result = await respondWithLLM('hello', 'test-user', {
      provider: primary,
      getFallbackProvider: async (excluded, reason) => {
        expect(excluded).toEqual(['groq']);
        expect(reason).toContain('429');
        return fallback;
      },
      loadHistory: async () => '',
      saveHistory: async () => {},
    });

    expect(result).toBe('fallback response');
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
  });

  it('fails over a stream before emitting partial output', async () => {
    let fallbackCalls = 0;
    const primary = provider(
      'groq',
      async () => ({ content: 'unused', model: 'test', provider: 'groq' }),
      async () => { throw new Error('stream request failed: 503 service unavailable'); },
    );
    const fallback = provider(
      'ollama',
      async () => ({ content: 'unused', model: 'test', provider: 'ollama' }),
      async (_messages: Message[], _config, onToken) => {
        fallbackCalls++;
        onToken('fallback stream');
        return { content: 'fallback stream', model: 'test', provider: 'ollama' };
      },
    );
    const tokens: string[] = [];

    const result = await respondWithLLMStream('hello', 'test-user', token => tokens.push(token), {
      provider: primary,
      getFallbackProvider: async () => fallback,
      loadHistory: async () => '',
      saveHistory: async () => {},
    });

    expect(result).toBe('fallback stream');
    expect(tokens).toEqual(['fallback stream']);
    expect(fallbackCalls).toBe(1);
  });
});
