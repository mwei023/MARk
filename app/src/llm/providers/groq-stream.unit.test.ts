import { describe, it, expect, afterEach } from 'vitest';
import { GroqProvider } from './groq.js';

const OLD_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = OLD_FETCH;
});

function sseFetch(chunks: string[]) {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
  globalThis.fetch = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
}

describe('groq streaming', () => {
  it('emits tokens as they arrive and accumulates', async () => {
    sseFetch([
      'data: {"model":"m","choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"model":"m","choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]\n\n',
    ]);
    const provider = new GroqProvider({ provider: 'groq', model: 'm', apiKey: 'test' });
    const tokens: string[] = [];
    const res = await provider.stream!([{ role: 'user', content: 'hi' }], undefined, (t) => tokens.push(t));
    expect(tokens).toEqual(['Hello', ' world']);
    expect(res.content).toBe('Hello world');
    expect(res.provider).toBe('groq');
  });

  it('throws on HTTP errors so callers fall back', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch;
    const provider = new GroqProvider({ provider: 'groq', model: 'm', apiKey: 'test' });
    await expect(provider.stream!([{ role: 'user', content: 'hi' }], undefined, () => {})).rejects.toThrow();
  });

  it('refuses without a key', async () => {
    const provider = new GroqProvider({ provider: 'groq', model: 'm', apiKey: '' });
    await expect(provider.stream!([{ role: 'user', content: 'hi' }], undefined, () => {})).rejects.toThrow(/key/i);
  });
});
