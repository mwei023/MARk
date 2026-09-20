/**
 * WebAgent unit tests — stubbed search/read, no network, no DB.
 *
 * Covers: query expansion, cited synthesis with confidence, the bounded
 * browse loop (dedup, read caps), and routing (deep research belongs to
 * the research agent, not the web agent).
 */
import { describe, it, expect } from 'vitest';
import { WebAgent, expandQuery, synthesizeAnswer } from './web-agent.js';

describe('expandQuery', () => {
  it('adds an angle to a plain query', () => {
    const variants = expandQuery('vector databases');
    expect(variants[0]).toBe('vector databases');
    expect(variants.length).toBe(2);
  });

  it('leaves an already-angled query alone', () => {
    expect(expandQuery('postgres vs mysql review')).toHaveLength(1);
  });
});

describe('synthesizeAnswer', () => {
  it('admits empty evidence with zero confidence', () => {
    const { answer, confidence } = synthesizeAnswer('x', [], []);
    expect(answer).toContain('nothing usable');
    expect(confidence).toBe(0);
  });

  it('cites sources and scales confidence with evidence', () => {
    const strong = synthesizeAnswer('vector databases', [
      { item: { title: 'Paper', url: 'https://arxiv.org/abs/1', snippet: 's' }, text: 'Measured throughput result. It scales linearly with shards.' },
      { item: { title: 'Docs', url: 'https://docs.example/vdb', snippet: 's' }, text: 'Official indexing options include HNSW and IVF for recall tuning.' },
    ], []);
    expect(strong.answer).toContain('arxiv.org');
    expect(strong.confidence).toBeGreaterThan(0.3);

    const weak = synthesizeAnswer('vector databases', [], [
      { title: 'Blog', url: 'http://blog.example/p', snippet: 'opinion piece' },
    ]);
    expect(weak.confidence).toBeLessThan(strong.confidence);
  });
});

describe('WebAgent.browse (stubbed)', () => {
  const pages: Record<string, string> = {
    'https://arxiv.org/abs/1': 'Measured throughput result. It scales linearly with shards and keeps recall high.',
    'https://blog.example/guide': 'Opinionated setup guide for vector databases.',
  };

  it('dedups across query variants and caps reads', async () => {
    let reads = 0;
    const agent = new WebAgent();
    const out = await agent.browse('vector databases', 5, true, {
      search: async () => [
        { title: 'Paper', url: 'https://arxiv.org/abs/1', snippet: 's1' },
        { title: 'Guide', url: 'https://blog.example/guide', snippet: 's2' },
      ],
      read: async (url: string) => {
        reads++;
        return pages[url] ?? '';
      },
    });
    expect(new Set(out.urls).size).toBe(out.urls.length);
    expect(out.urls).toHaveLength(2);
    expect(reads).toBeLessThanOrEqual(3);
    expect(out.answer).toContain('arxiv.org');
  });

  it('skips reads when readTop is false', async () => {
    let reads = 0;
    const agent = new WebAgent();
    const out = await agent.browse('vector databases', 5, false, {
      search: async () => [{ title: 'Paper', url: 'https://arxiv.org/abs/1', snippet: 'snippet text' }],
      read: async () => { reads++; return 'text'; },
    });
    expect(reads).toBe(0);
    expect(out.urls).toHaveLength(1);
  });
});

describe('WebAgent.canHandle', () => {
  const agent = new WebAgent();

  it('claims web searches', () => {
    expect(agent.canHandle({
      type: 'web.search.requested', data: {},
    } as any)).toBe(true);
    expect(agent.canHandle({
      type: 'user.command.received', data: { command: 'search the web for vector db benchmarks' },
    } as any)).toBe(true);
  });

  it('yields deep research to the research agent', () => {
    expect(agent.canHandle({
      type: 'user.command.received', data: { command: 'deep research vector db benchmarks' },
    } as any)).toBe(false);
    expect(agent.canHandle({
      type: 'user.command.received', data: { command: 'state of the art in retrieval' },
    } as any)).toBe(false);
  });
});
