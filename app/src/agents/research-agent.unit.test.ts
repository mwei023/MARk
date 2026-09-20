/**
 * ResearchAgent + self-improvement unit tests — no network, no LLM, no DB.
 *
 * Covers the pure core of the exhaustive loop:
 *  - URL normalization / dedup
 *  - credibility scoring
 *  - fallback query planning + gap analysis
 *  - coverage math
 *  - fallback synthesis + problem statements
 *  - engine run on stub search/read/llm (budgets, dedup, exhaustion)
 *  - usefulness gate for self-improvement filing
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  domainOf,
  credibilityOf,
  planQueriesFallback,
  gapsFallback,
  coverageOf,
  synthesizeFallback,
  problemStatementsFallback,
  ResearchEngine,
  ResearchSource,
} from './research-agent.js';
import { assessUsefulness } from '../ops/self-improve.js';

// ─── URL normalization ───────────────────────────────────────────────────────

describe('normalizeUrl', () => {
  it('strips UTM params, fragments, trailing slashes, and case', () => {
    expect(normalizeUrl('https://Example.com/Guide/?utm_source=x#sec')).toBe(
      normalizeUrl('https://example.com/Guide'),
    );
  });

  it('keeps meaningful query params', () => {
    expect(normalizeUrl('https://example.com/search?q=vector+db')).toContain('q=vector');
  });

  it('never throws on garbage', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});

describe('domainOf', () => {
  it('strips www and lowercases', () => {
    expect(domainOf('https://WWW.Arxiv.ORG/abs/123')).toBe('arxiv.org');
  });

  it('returns unknown for garbage', () => {
    expect(domainOf('garbage')).toBe('unknown');
  });
});

// ─── Credibility ─────────────────────────────────────────────────────────────

describe('credibilityOf', () => {
  it('ranks a trusted research domain above a random blog', () => {
    expect(credibilityOf('https://arxiv.org/abs/2401.00001')).toBeGreaterThan(
      credibilityOf('http://random-blog-xyz.example/top10-secrets'),
    );
  });

  it('stays within bounds', () => {
    for (const url of ['https://arxiv.org/x', 'http://a.b.c.d.evil.example/y', 'garbage']) {
      const score = credibilityOf(url);
      expect(score).toBeGreaterThanOrEqual(0.05);
      expect(score).toBeLessThanOrEqual(0.95);
    }
  });
});

// ─── Fallback planning ───────────────────────────────────────────────────────

describe('planQueriesFallback', () => {
  it('round 0 fans out angles around the topic', () => {
    const queries = planQueriesFallback('vector databases', 0, [], 4);
    expect(queries).toHaveLength(4);
    expect(queries[0]).toBe('vector databases');
    expect(new Set(queries).size).toBe(4);
  });

  it('later rounds chase gaps', () => {
    const queries = planQueriesFallback('vector databases', 2, ['benchmarks'], 3);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('benchmarks');
  });
});

describe('gapsFallback', () => {
  it('flags thin diversity and stagnation', () => {
    const sources: ResearchSource[] = [
      { title: 'a', url: 'https://blog.example/a', snippet: 's', domain: 'blog.example', credibility: 0.5, text: 'x', charsRead: 10, round: 1 },
    ];
    const gaps = gapsFallback(sources, 0, 2);
    expect(gaps).toContain('source diversity');
    expect(gaps).toContain('primary-source depth');
  });
});

// ─── Coverage ────────────────────────────────────────────────────────────────

describe('coverageOf', () => {
  const source = (domain: string, chars: number): ResearchSource => ({
    title: 't', url: `https://${domain}/p`, snippet: 's', domain,
    credibility: 0.7, text: 'x'.repeat(chars), charsRead: chars, round: 1,
  });

  it('grows with domains, deep reads, and rounds', () => {
    const thin = coverageOf([source('a.example', 100)], 1, 6);
    const rich = coverageOf(
      ['a.example', 'b.example', 'c.example', 'd.example', 'e.example', 'f.example', 'g.example', 'h.example']
        .map(d => source(d, 2000)),
      4, 6,
    );
    expect(rich).toBeGreaterThan(thin);
    expect(rich).toBeLessThanOrEqual(1);
  });
});

// ─── Fallback synthesis ──────────────────────────────────────────────────────

describe('synthesizeFallback', () => {
  it('admits empty evidence honestly', () => {
    const { summary, keyFindings } = synthesizeFallback('vector databases', []);
    expect(summary).toContain('No usable sources');
    expect(keyFindings).toEqual([]);
  });

  it('cites the strongest source', () => {
    const { summary, keyFindings } = synthesizeFallback('vector databases', [
      { title: 'Blog', url: 'http://blog.example/p', snippet: 'opinion', domain: 'blog.example', credibility: 0.4, text: '', charsRead: 0, round: 1 },
      { title: 'Paper', url: 'https://arxiv.org/abs/1', snippet: 'result', domain: 'arxiv.org', credibility: 0.75, text: 'measured throughput result', charsRead: 2000, round: 1 },
    ]);
    expect(summary).toContain('arxiv.org');
    expect(keyFindings.length).toBeGreaterThan(0);
    expect(keyFindings[0]).toContain('arxiv.org');
  });
});

describe('problemStatementsFallback', () => {
  const source = (url: string): ResearchSource => ({
    title: 't', url, snippet: 's', domain: domainOf(url),
    credibility: 0.5, text: 'body', charsRead: 500, round: 1,
  });

  it('files a synthesis gap when sources contradict', () => {
    const out = problemStatementsFallback('x', [source('https://a.example/1')], ['A says X but B says Y'], 0.8);
    expect(out.some(s => s.area === 'research-synthesis')).toBe(true);
  });

  it('files a coverage gap when coverage is thin', () => {
    const out = problemStatementsFallback('x', [source('https://a.example/1')], [], 0.2);
    expect(out.some(s => s.area === 'web-research')).toBe(true);
  });

  it('stays silent on clean, well-covered research', () => {
    const sources = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(d => source(`https://${d}.example/p`));
    expect(problemStatementsFallback('x', sources, [], 0.9)).toEqual([]);
  });
});

// ─── Engine on stubs ─────────────────────────────────────────────────────────

function stubWorld() {
  const pages: Record<string, string> = {
    'https://arxiv.org/abs/1': 'Measured benchmark result for vector databases with throughput numbers and recall analysis.',
    'https://blog.example/guide': 'Opinionated guide to vector databases with setup steps.',
    'https://docs.example/vdb': 'Official documentation for vector database indexing options.',
  };
  let searchCalls = 0;
  const search = async (query: string, _limit: number) => {
    searchCalls++;
    const keys = Object.keys(pages);
    // Deliberate overlap across queries: dedup must collapse these.
    const pick = query.includes('benchmark') ? [keys[0], keys[1]] : [keys[0], keys[1], keys[2]];
    return pick.map(url => ({ title: `Title ${url}`, url, snippet: `Snippet ${url}` }));
  };
  let readCalls = 0;
  const read = async (url: string) => {
    readCalls++;
    return pages[url] ? { title: `Title ${url}`, text: pages[url] } : null;
  };
  const llm = async () => null; // offline: every phase uses its fallback
  return { search, read, llm, calls: () => ({ searchCalls, readCalls }) };
}

describe('ResearchEngine (stubbed)', () => {
  it('dedups overlapping hits and synthesizes with citations', async () => {
    const world = stubWorld();
    const engine = new ResearchEngine(world.search, world.read, world.llm, 'standard');
    const report = await engine.run('vector databases', { fileGaps: false });
    const urls = report.sources.map(s => s.url);
    expect(new Set(urls).size).toBe(urls.length); // no duplicates
    expect(report.sources.length).toBeLessThanOrEqual(3);
    expect(report.summary).toContain('vector databases');
    expect(report.coverage).toBeGreaterThan(0);
    expect(report.rounds).toBeGreaterThanOrEqual(1);
  });

  it('respects the search budget', async () => {
    const world = stubWorld();
    const engine = new ResearchEngine(world.search, world.read, world.llm, 'standard');
    const report = await engine.run('vector databases', { fileGaps: false });
    expect(world.calls().searchCalls).toBeLessThanOrEqual(6);
    expect(report.searches).toBeLessThanOrEqual(6);
    expect(report.reads).toBeLessThanOrEqual(4);
  });

  it('handles a total miss honestly', async () => {
    const engine = new ResearchEngine(
      async () => [],
      async () => null,
      async () => null,
      'standard',
    );
    const report = await engine.run('obscure topic xyz', { fileGaps: false });
    expect(report.sources).toEqual([]);
    expect(report.summary).toContain('No usable sources');
  });

  it('stops on stagnation (exhaustion verdict)', async () => {
    const world = stubWorld();
    const engine = new ResearchEngine(world.search, world.read, world.llm, 'exhaustive');
    const report = await engine.run('vector databases', { fileGaps: false });
    // Same 3 URLs every query → unseen hits dry up → must stop before round cap.
    expect(report.rounds).toBeLessThanOrEqual(6);
    expect(report.exhaustionReason.length).toBeGreaterThan(0);
  });
});

// ─── Usefulness gate ─────────────────────────────────────────────────────────

describe('assessUsefulness', () => {
  it('rejects empty input', () => {
    expect(assessUsefulness([]).useful).toBe(false);
  });

  it('accepts evidenced gaps and reports areas', () => {
    const verdict = assessUsefulness([
      { title: 'Gap', area: 'web-research', gap: 'Cannot render JS pages.', evidenceUrls: ['https://a.example'], suggestedFix: 'Add headless rendering.', confidence: 0.7 },
      { title: 'Weak', area: 'x', gap: 'vague', evidenceUrls: [], suggestedFix: '', confidence: 0.9 },
    ]);
    expect(verdict.useful).toBe(true);
    expect(verdict.gapAreas).toEqual(['web-research']);
  });

  it('rejects low-confidence statements', () => {
    const verdict = assessUsefulness([
      { title: 'Hunch', area: 'x', gap: 'maybe slow', evidenceUrls: [], suggestedFix: 'go faster', confidence: 0.2 },
    ]);
    expect(verdict.useful).toBe(false);
  });
});
