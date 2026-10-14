/**
 * ResearchAgent — Mark's exhaustive deep-research agent.
 *
 * Why this beats a single search+read: it runs the loop the best research
 * agents run — plan queries → fan-out searches → read sources in parallel →
 * gap analysis → follow-up queries (recursive deepening) → synthesize →
 * adversarial critique → patch round → final report — and then asks the one
 * question that makes Mark dangerous: "what did this research prove I can't
 * do?" Those gaps become problem-statement incidents Mark improves against.
 *
 * Exhaustion ("have I really exhausted all available knowledge?") is a
 * first-class verdict, not a vibe: unique domains, unseen-URL rate,
 * query-diversity spent, and round-over-round novelty are measured, and the
 * loop stops on diminishing returns or budget — whichever comes first.
 *
 * Safety: this agent only ever runs read-only kernel tools
 * (browser.search / browser.read). The "dangerous" part — self-improvement —
 * travels the normal incident → approval → CodeAgent path. Research proposes;
 * it never self-edits.
 *
 * Flow: `research.requested` { topic|query, depth?, fileGaps?, incidentId? }
 *   → exhaustive loop → `research.completed` { summary, sources, filed }.
 *
 * The pure `ResearchEngine` takes injected search/read/llm functions so unit
 * tests run it with stubs (no network, no LLM, no DB).
 */

import { Agent } from '../core/agent-runtime';
import { Event } from '../core/events';
import { incidentStore } from '../core/incident';
import { eventBus } from '../core/event-bus';
import { config } from '../config.js';
import {
  ProblemStatement,
  assessUsefulness,
  fileProblemStatements,
} from '../ops/self-improve.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ResearchDepth = 'standard' | 'deep' | 'exhaustive';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface ResearchSource extends SearchHit {
  domain: string;
  credibility: number;
  text: string;
  charsRead: number;
  round: number;
}

export interface ResearchReport {
  topic: string;
  summary: string;
  keyFindings: string[];
  sources: ResearchSource[];
  rounds: number;
  searches: number;
  reads: number;
  /** 0–1: unique-domain breadth + read depth + round effort. */
  coverage: number;
  exhausted: boolean;
  exhaustionReason: string;
  contradictions: string[];
  problemStatements: ProblemStatement[];
  filed: Array<{ title: string; incidentId: string | null; correlated: boolean }>;
  durationMs: number;
  /** LLM calls actually made (capped by budget). */
  llmCalls: number;
  /** True when the cap, not the evidence, stopped LLM use. */
  llmCapped: boolean;
}

export type SearchFn = (query: string, limit: number) => Promise<SearchHit[]>;
export type ReadFn = (url: string) => Promise<{ title: string; text: string } | null>;
export type LlmFn = (system: string, user: string) => Promise<string | null>;

export interface EngineBudgets {
  maxRounds: number;
  maxSearches: number;
  maxReads: number;
  /** Max LLM calls per run (free-tier guard). Env MARK_RESEARCH_MAX_LLM_CALLS caps further. */
  maxLlmCalls: number;
  queriesPerRound: number;
  readsPerRound: number;
  searchLimit: number;
}

const BUDGETS: Record<ResearchDepth, EngineBudgets> = {
  standard: { maxRounds: 2, maxSearches: 6, maxReads: 4, maxLlmCalls: 8, queriesPerRound: 3, readsPerRound: 2, searchLimit: 5 },
  deep: { maxRounds: 4, maxSearches: 16, maxReads: 10, maxLlmCalls: 16, queriesPerRound: 4, readsPerRound: 3, searchLimit: 5 },
  exhaustive: { maxRounds: 6, maxSearches: 30, maxReads: 20, maxLlmCalls: 24, queriesPerRound: 6, readsPerRound: 4, searchLimit: 5 },
};

/** What Mark can/can't do — fed to the LLM so gap-spotting is grounded. */
const MARK_CAPABILITIES = `Mark is a local-first autonomous ops agent. It CAN: triage GitHub/Docker/CI failures into incidents, classify failures with confidence, repair eslint/tsc code errors on branches, run read-only repo probes, search+read the web as text (no JS rendering), screenshot a Linux desktop and act via vision, remember incident outcomes. It CANNOT: render JS-heavy or authenticated/paywalled pages, watch video or listen to audio, stream real-time data, or verify physical-world facts.`;

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** Canonical URL for dedup: lowercase host, no fragment/UTM/trailing slash. */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(String(raw).trim());
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^gclid$|^ref$/i.test(key)) url.searchParams.delete(key);
    }
    let out = url.toString().toLowerCase();
    if (out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch {
    return String(raw).trim().toLowerCase();
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

const TRUSTED_DOMAINS = [
  'arxiv.org', 'github.com', 'wikipedia.org', 'developer.mozilla.org',
  'docs.python.org', 'go.dev', 'rust-lang.org', 'nodejs.org', 'typescriptlang.org',
  'kubernetes.io', 'docker.com', 'nature.com', 'science.org', 'nih.gov', 'edu',
  'gov', 'ietf.org', 'w3.org', 'openai.com', 'anthropic.com', 'deepmind.com',
];
const SKETCHY_HINTS = ['content-farm', 'top10', 'clickbank', 'essay', 'free-download'];

/** Deterministic source credibility 0.05–0.95 (corroboration applied later). */
export function credibilityOf(url: string, httpsBonus = true): number {
  const domain = domainOf(url);
  let score = 0.5;
  if (TRUSTED_DOMAINS.some(t => domain === t || domain.endsWith(`.${t}`) || (t === 'edu' || t === 'gov' ? domain.endsWith(`.${t}`) : false))) score += 0.2;
  if (httpsBonus && url.toLowerCase().startsWith('https://')) score += 0.05;
  if (SKETCHY_HINTS.some(h => domain.includes(h))) score -= 0.25;
  if (domain.split('.').length > 3) score -= 0.05;
  return Math.min(0.95, Math.max(0.05, score));
}

/** Heuristic query plan when the LLM is unreachable. Diversifies angles. */
export function planQueriesFallback(topic: string, round: number, gaps: string[], perRound: number): string[] {
  const t = topic.trim().slice(0, 200);
  if (round === 0) {
    return [
      t,
      `${t} state of the art`,
      `${t} limitations problems`,
      `${t} best practices`,
      `${t} comparison review`,
      `${t} 2026`,
    ].slice(0, perRound);
  }
  const followUps = gaps.slice(0, perRound).map(g => `${g} ${t}`.slice(0, 250));
  while (followUps.length < perRound) followUps.push(`${t} ${['critique', 'evidence', 'alternatives', 'benchmarks'][followUps.length % 4]}`);
  return followUps.slice(0, perRound);
}

/** Heuristic gap extraction: low diversity, stagnation, thin reads. */
export function gapsFallback(sources: ResearchSource[], unseenInLastRound: number, round: number): string[] {
  const gaps: string[] = [];
  const domains = new Set(sources.map(s => s.domain));
  if (domains.size < 4 && round >= 1) gaps.push('source diversity');
  if (unseenInLastRound === 0 && round >= 1) gaps.push('query angle diversity');
  if (sources.filter(s => s.charsRead > 500).length < 3) gaps.push('primary-source depth');
  return gaps;
}

/** Extractive synthesis fallback: top-credibility evidence with citations. */
export function synthesizeFallback(topic: string, sources: ResearchSource[]): { summary: string; keyFindings: string[] } {
  if (sources.length === 0) {
    return { summary: `No usable sources found for "${topic}".`, keyFindings: [] };
  }
  const ranked = [...sources].sort((a, b) => b.credibility - a.credibility);
  const findings = ranked.slice(0, 8).map(s => {
    const evidence = (s.text || s.snippet).slice(0, 220).replace(/\s+/g, ' ').trim();
    return `${evidence} [${s.domain}](${s.url})`;
  });
  const summary =
    `Research on "${topic}" across ${ranked.length} source(s) ` +
    `(${new Set(ranked.map(s => s.domain)).size} domains). ` +
    `Strongest evidence: ${(ranked[0].text || ranked[0].snippet).slice(0, 300).replace(/\s+/g, ' ')} ` +
    `[${ranked[0].domain}](${ranked[0].url})`;
  return { summary, keyFindings: findings };
}

/**
 * Fallback problem statements from observed research weaknesses only.
 * Honest by construction: never invents gaps the evidence doesn't show.
 */
export function problemStatementsFallback(
  topic: string,
  sources: ResearchSource[],
  contradictions: string[],
  coverage: number,
): ProblemStatement[] {
  const out: ProblemStatement[] = [];
  if (contradictions.length > 0) {
    out.push({
      title: `Research synthesis cannot resolve contradictions on "${topic.slice(0, 80)}"`,
      area: 'research-synthesis',
      gap: `Sources disagree (${contradictions.length} contradiction(s)) and Mark has no corroboration-weighing pass to adjudicate them.`,
      evidenceUrls: sources.slice(0, 3).map(s => s.url),
      suggestedFix: 'Add a corroboration pass: cluster claims by source count × credibility and mark low-consensus claims as contested instead of averaging them away.',
      confidence: 0.6,
    });
  }
  if (coverage < 0.5) {
    out.push({
      title: `Thin source coverage on "${topic.slice(0, 80)}" (coverage ${(coverage * 100).toFixed(0)}%)`,
      area: 'web-research',
      gap: 'The loop exhausted its query angles with few credible sources — text-only fetch cannot reach JS-rendered, authenticated, or paywalled knowledge.',
      evidenceUrls: sources.slice(0, 3).map(s => s.url),
      suggestedFix: 'Add a JS-rendering read path (headless browser text dump) and authenticated-source connectors, gated like other reversible tools.',
      confidence: 0.55,
    });
  }
  return out;
}

/** Coverage 0–1 from breadth + depth + effort. */
export function coverageOf(sources: ResearchSource[], rounds: number, maxRounds: number): number {
  const domains = new Set(sources.map(s => s.domain)).size;
  const deepReads = sources.filter(s => s.charsRead > 1000).length;
  return Math.min(1, (domains / 8) * 0.5 + (deepReads / 10) * 0.3 + (rounds / Math.max(maxRounds, 1)) * 0.2);
}

function tryParseJsonArray(text: string): string[] | null {
  try {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) return null;
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(s => s.trim().slice(0, 250));
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export class ResearchEngine {
  private readonly budgets: EngineBudgets;
  private llmCalls = 0;
  private llmCapped = false;

  constructor(
    private readonly search: SearchFn,
    private readonly read: ReadFn,
    private readonly llm: LlmFn,
    depth: ResearchDepth = 'deep',
  ) {
    const base = BUDGETS[depth];
    // Operator override: absolute per-run cap (free-tier guard).
    const envCap = Math.floor(Number(process.env.MARK_RESEARCH_MAX_LLM_CALLS ?? NaN));
    this.budgets = Number.isFinite(envCap) && envCap >= 0
      ? { ...base, maxLlmCalls: envCap }
      : base;
  }

  /**
   * The only LLM door in the engine: counts every call, returns null past
   * budget (all six call sites already degrade to deterministic fallbacks
   * on null — the cap changes cost, never correctness).
   */
  private async callLlm(system: string, user: string): Promise<string | null> {
    if (this.llmCalls >= this.budgets.maxLlmCalls) {
      this.llmCapped = true;
      return null;
    }
    this.llmCalls += 1;
    try {
      return await this.llm(system, user);
    } catch {
      return null;
    }
  }

  async run(topic: string, opts: { fileGaps?: boolean } = {}): Promise<ResearchReport> {
    const started = Date.now();
    const clean = topic.trim().slice(0, 300);
    const sources: ResearchSource[] = [];
    const seen = new Set<string>();
    const contradictions: string[] = [];
    let searches = 0;
    let reads = 0;
    let rounds = 0;
    let exhausted = false;
    let exhaustionReason = 'budget spent';
    let queries = await this.planQueries(clean, [], 0);

    for (let round = 0; round < this.budgets.maxRounds; round++) {
      rounds = round + 1;
      const remaining = this.budgets.maxSearches - searches;
      if (remaining <= 0) { exhaustionReason = `search budget spent (${this.budgets.maxSearches})`; break; }
      const batch = queries.slice(0, Math.min(queries.length, remaining, this.budgets.queriesPerRound));

      const hits = (await mapLimit(batch, 4, async q => {
        try { return await this.search(q, this.budgets.searchLimit); }
        catch { return [] as SearchHit[]; }
      })).flat();
      searches += batch.length;

      let unseenInRound = 0;
      const candidates: SearchHit[] = [];
      for (const hit of hits) {
        const key = normalizeUrl(hit.url);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        unseenInRound++;
        candidates.push(hit);
      }

      // Read the most credible unseen sources first, preferring new domains.
      const knownDomains = new Set(sources.map(s => s.domain));
      candidates.sort((a, b) => {
        const domainBonus = (Number(!knownDomains.has(domainOf(b.url))) - Number(!knownDomains.has(domainOf(a.url)))) * 0.1;
        return credibilityOf(b.url) + domainBonus - credibilityOf(a.url);
      });
      const readBudget = Math.min(this.budgets.readsPerRound, this.budgets.maxReads - reads);
      const toRead = candidates.slice(0, Math.max(readBudget, 0));
      const readResults = await mapLimit(toRead, 3, async hit => {
        try { return await this.read(hit.url); }
        catch { return null; }
      });
      toRead.forEach((hit, i) => {
        const body = readResults[i];
        reads++;
        sources.push({
          ...hit,
          domain: domainOf(hit.url),
          credibility: credibilityOf(hit.url),
          text: (body?.text ?? '').slice(0, 6000),
          charsRead: (body?.text ?? '').length,
          round: rounds,
        });
      });

      // Gap analysis → follow-ups, then the exhaustion verdict.
      const gaps = await this.findGaps(clean, sources, unseenInRound, rounds);
      const novelty = unseenInRound / Math.max(hits.length, 1);
      if (unseenInRound === 0 && rounds >= 2) {
        exhausted = true;
        exhaustionReason = `no unseen URLs in round ${rounds} — query angles exhausted`;
        break;
      }
      if (sources.length >= 8 && novelty < 0.15 && rounds >= 3) {
        exhausted = true;
        exhaustionReason = `novelty collapsed (${(novelty * 100).toFixed(0)}% unseen in round ${rounds}) with ${sources.length} sources banked`;
        break;
      }
      if (reads >= this.budgets.maxReads && searches >= this.budgets.maxSearches) {
        exhaustionReason = 'search + read budgets spent';
        break;
      }
      queries = await this.planQueries(clean, gaps, rounds);
      if (queries.length === 0) {
        exhausted = true;
        exhaustionReason = 'gap analysis returned no further angles';
        break;
      }
    }

    const foundContradictions = await this.findContradictions(clean, sources);
    contradictions.push(...foundContradictions);

    let { summary, keyFindings } = await this.synthesize(clean, sources, contradictions);
    const critique = await this.critique(clean, summary, sources);
    if (critique && searches < this.budgets.maxSearches && reads < this.budgets.maxReads) {
      // One adversarial patch round: chase exactly what the critique attacks.
      const patchQueries = (await this.planQueries(`${clean} ${critique.weakestClaim}`.slice(0, 250), [], rounds)).slice(0, 2);
      for (const q of patchQueries) {
        if (searches >= this.budgets.maxSearches) break;
        let hits: SearchHit[] = [];
        try { hits = await this.search(q, 3); } catch { /* patch best-effort */ }
        searches++;
        for (const hit of hits) {
          if (reads >= this.budgets.maxReads) break;
          const key = normalizeUrl(hit.url);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          let body = null;
          try { body = await this.read(hit.url); } catch { /* skip */ }
          reads++;
          sources.push({
            ...hit, domain: domainOf(hit.url), credibility: credibilityOf(hit.url),
            text: (body?.text ?? '').slice(0, 6000), charsRead: (body?.text ?? '').length, round: rounds + 1,
          });
        }
      }
      const patched = await this.synthesize(clean, sources, contradictions);
      summary = `${patched.summary}\n\nAdversarial note: ${critique.note}`;
      keyFindings = patched.keyFindings;
    }

    const coverage = coverageOf(sources, rounds, this.budgets.maxRounds);
    if (!exhausted && coverage >= 0.7) {
      exhausted = true;
      exhaustionReason = `coverage ${(coverage * 100).toFixed(0)}% across ${new Set(sources.map(s => s.domain)).size} domains — knowledge well exhausted`;
    }

    const problemStatements = await this.extractProblemStatements(clean, sources, contradictions, coverage);
    let filed: ResearchReport['filed'] = [];
    if (opts.fileGaps !== false && assessUsefulness(problemStatements).useful) {
      const receipts = await fileProblemStatements(clean, summary, problemStatements);
      filed = receipts
        .filter(r => r.incidentId)
        .map(r => ({ title: r.statement.title, incidentId: r.incidentId as string, correlated: r.correlated }));
    }

    return {
      topic: clean, summary, keyFindings, sources,
      rounds, searches, reads, coverage, exhausted, exhaustionReason,
      contradictions, problemStatements, filed,
      durationMs: Date.now() - started,
      llmCalls: this.llmCalls,
      llmCapped: this.llmCapped,
    };
  }

  private async planQueries(topic: string, gaps: string[], round: number): Promise<string[]> {
    const perRound = this.budgets.queriesPerRound;
    const gapHint = gaps.length > 0 ? ` Open gaps to chase: ${gaps.join('; ')}.` : '';
    const reply = await this.callLlm(
      'You plan web-search queries for a deep-research agent. Reply with EXACTLY a JSON array of strings, nothing else.',
      `Topic: "${topic}". Round ${round + 1}.${gapHint} Generate ${perRound} diverse, specific search queries (different angles, no near-duplicates).`,
    );
    const parsed = reply ? tryParseJsonArray(reply) : null;
    if (parsed && parsed.length > 0) return parsed.slice(0, perRound);
    return planQueriesFallback(topic, round, gaps, perRound);
  }

  private async findGaps(topic: string, sources: ResearchSource[], unseen: number, round: number): Promise<string[]> {
    if (sources.length === 0) return ['baseline coverage'];
    const digest = sources.slice(-6).map(s => `- [${s.domain}] ${s.title}: ${(s.text || s.snippet).slice(0, 200)}`).join('\n');
    const reply = await this.callLlm(
      'You audit research coverage. Reply with EXACTLY a JSON array of short follow-up angles (strings), nothing else. Empty array [] when coverage is genuinely complete.',
      `Topic: "${topic}". Banked ${sources.length} sources. Latest evidence:\n${digest}\nWhat is still missing, thin, or one-sided?`,
    );
    const parsed = reply ? tryParseJsonArray(reply) : null;
    if (parsed) return parsed.slice(0, this.budgets.queriesPerRound);
    return gapsFallback(sources, unseen, round);
  }

  private async findContradictions(topic: string, sources: ResearchSource[]): Promise<string[]> {
    if (sources.length < 2) return [];
    const digest = sources.slice(0, 10).map(s => `- [${s.domain}] ${s.title}: ${(s.text || s.snippet).slice(0, 250)}`).join('\n');
    const reply = await this.callLlm(
      'You detect contradictions across sources. Reply with EXACTLY a JSON array of contradiction strings (each: "A says X but B says Y"), nothing else. Empty array [] when sources agree.',
      `Topic: "${topic}".\n${digest}`,
    );
    const parsed = reply ? tryParseJsonArray(reply) : null;
    return (parsed ?? []).slice(0, 5);
  }

  private async synthesize(
    topic: string, sources: ResearchSource[], contradictions: string[],
  ): Promise<{ summary: string; keyFindings: string[] }> {
    if (sources.length === 0) return synthesizeFallback(topic, sources);
    const digest = sources.slice(0, 12).map(s => `- [${s.domain}](${s.url}) "${s.title}": ${(s.text || s.snippet).slice(0, 500)}`).join('\n');
    const reply = await this.callLlm(
      'You write research syntheses with inline markdown citations [domain](url). No uncited factual claims. Plain text, no JSON.',
      `Topic: "${topic}". Synthesize ${sources.length} sources into: a 5-8 sentence summary, then "FINDINGS:" followed by one finding per line, each ending with its citation.` +
      (contradictions.length > 0 ? `\nKnown contradictions to adjudicate or mark contested:\n${contradictions.join('\n')}` : '') +
      `\nSources:\n${digest}`,
    );
    if (!reply) return synthesizeFallback(topic, sources);
    const lines = reply.split('\n').map(l => l.trim()).filter(Boolean);
    const splitAt = lines.findIndex(l => /^findings:?$/i.test(l));
    if (splitAt < 0) return { summary: reply.slice(0, 1500), keyFindings: [] };
    return {
      summary: lines.slice(0, splitAt).join(' ').slice(0, 2000),
      keyFindings: lines.slice(splitAt + 1).filter(l => l.length > 10).slice(0, 12),
    };
  }

  private async critique(
    topic: string, summary: string, sources: ResearchSource[],
  ): Promise<{ weakestClaim: string; note: string } | null> {
    if (sources.length === 0) return null;
    const reply = await this.callLlm(
      'You are an adversarial reviewer. Reply in plain text: line 1 "WEAKEST: <the shakiest claim>", line 2+ "NOTE: <what evidence would kill or confirm it>". If the synthesis is solid, reply exactly "SOLID".',
      `Topic: "${topic}". Synthesis:\n${summary.slice(0, 1500)}\nSources: ${sources.length} across ${new Set(sources.map(s => s.domain)).size} domains.`,
    );
    if (!reply || /^solid\b/i.test(reply.trim())) return null;
    const weakest = (reply.match(/WEAKEST:\s*(.+)/i)?.[1] ?? reply.split('\n')[0]).slice(0, 200);
    const note = (reply.match(/NOTE:\s*([\s\S]+)/i)?.[1] ?? 'critique raised questions; patch round ran').slice(0, 300);
    return { weakestClaim: weakest, note };
  }

  private async extractProblemStatements(
    topic: string, sources: ResearchSource[], contradictions: string[], coverage: number,
  ): Promise<ProblemStatement[]> {
    const digest = sources.slice(0, 8).map(s => `- [${s.domain}] ${s.title}`).join('\n');
    const reply = await this.callLlm(
      'You turn research into self-improvement work for an AI agent. Reply with EXACTLY a JSON array of objects {title, area, gap, suggestedFix, confidence (0-1)}, nothing else. Empty array [] when no genuine gap exists — never invent gaps.',
      `Research topic: "${topic}". Coverage ${(coverage * 100).toFixed(0)}%.\n${MARK_CAPABILITIES}\nSources:\n${digest}` +
      (contradictions.length > 0 ? `\nContradictions:\n${contradictions.join('\n')}` : '') +
      `\nWhere did THIS research prove Mark is missing a capability, source, or method? Concrete, evidenced gaps only.`,
    );
    if (reply) {
      try {
        const start = reply.indexOf('[');
        const end = reply.lastIndexOf(']');
        if (start >= 0 && end > start) {
          const parsed = JSON.parse(reply.slice(start, end + 1)) as Array<Partial<ProblemStatement>>;
          const cleaned = (Array.isArray(parsed) ? parsed : [])
            .filter(p => typeof p.title === 'string' && typeof p.gap === 'string' && typeof p.suggestedFix === 'string')
            .map(p => ({
              title: String(p.title).slice(0, 200),
              area: String(p.area ?? 'general').slice(0, 80),
              gap: String(p.gap).slice(0, 800),
              evidenceUrls: sources.slice(0, 5).map(s => s.url),
              suggestedFix: String(p.suggestedFix).slice(0, 800),
              confidence: Math.min(1, Math.max(0, Number(p.confidence ?? 0.5) || 0.5)),
            }));
          if (cleaned.length > 0) return cleaned.slice(0, 5);
        }
      } catch { /* fall through to heuristic */ }
    }
    return problemStatementsFallback(topic, sources, contradictions, coverage);
  }
}

// ─── Kernel-backed functions ─────────────────────────────────────────────────

async function kernelSearch(query: string, limit: number): Promise<SearchHit[]> {
  const { markKernelBridge } = await import('../kernel/bridge.js');
  await markKernelBridge.initialize();
  const context = markKernelBridge.createContext({ userId: config.defaultUser, source: 'api' } as never);
  const result = await markKernelBridge.execute(
    {
      id: `ACT-${Date.now()}-rsearch`,
      toolId: 'browser.search',
      input: { query: query.slice(0, 300), limit },
      requestedBy: config.defaultUser,
      createdAt: new Date().toISOString(),
    } as never,
    context,
  );
  if ((result as { status?: string }).status !== 'succeeded') return [];
  return ((result as { output?: { results?: SearchHit[] } }).output?.results ?? []).map(r => ({
    title: String(r.title ?? '').slice(0, 200),
    url: String(r.url ?? ''),
    snippet: String(r.snippet ?? '').slice(0, 500),
  })).filter(r => r.url);
}

async function kernelRead(url: string): Promise<{ title: string; text: string } | null> {
  try {
    const { markKernelBridge } = await import('../kernel/bridge.js');
    await markKernelBridge.initialize();
    const context = markKernelBridge.createContext({ userId: config.defaultUser, source: 'api' } as never);
    const result = await Promise.race([
      markKernelBridge.execute(
        {
          id: `ACT-${Date.now()}-rread`,
          toolId: 'browser.read',
          input: { url, maxChars: 6000 },
          requestedBy: config.defaultUser,
          createdAt: new Date().toISOString(),
        } as never,
        context,
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('read timeout')), 25000)),
    ]);
    if ((result as { status?: string }).status !== 'succeeded') return null;
    const out = (result as { output?: { title?: unknown; text?: unknown } }).output;
    return { title: String(out?.title ?? ''), text: String(out?.text ?? '') };
  } catch {
    return null;
  }
}

async function llmAsk(system: string, user: string): Promise<string | null> {
  try {
    const { getLLMProviderCached } = await import('../llm/index.js');
    const provider = await getLLMProviderCached();
    const res = await Promise.race([
      provider.chat([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('llm timeout')), 60000)),
    ]);
    const text = (res as { content?: string }).content?.trim() ?? '';
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export class ResearchAgent extends Agent {
  constructor() {
    super('research-agent');
  }

  canHandle(event: Event): boolean {
    if (event.type === 'research.requested') return true;
    if (event.type === 'user.command.received') {
      const command = String((event.data as Record<string, any>).command || '');
      return /\b(deep research|deep dive|thorough(ly)? research|exhaust(ive|ively)|investigate thoroughly|literature review|state of the art|\bsota\b|survey the field|map the field)\b/i.test(command);
    }
    return false;
  }

  async handleCommand(event: Event): Promise<string> {
    const command = String((event.data as Record<string, any>).command || '');
    const topic = command
      .replace(/\b(deep research|deep dive|thoroughly research|thorough research|research exhaustively|exhaustively|investigate thoroughly|literature review|state of the art|sota|survey the field|map the field|research|on|about|for|me|please)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    if (!topic) return '';
    const depth: ResearchDepth = /\b(quick|brief|fast)\b/i.test(command) ? 'standard' : /\b(exhaust|thorough|max)\b/i.test(command) ? 'exhaustive' : 'deep';
    const report = await new ResearchEngine(kernelSearch, kernelRead, llmAsk, depth).run(topic, { fileGaps: true });
    return formatCommandReply(report);
  }

  async handle(event: Event): Promise<void> {
    const data = event.data as Record<string, any>;
    const topic = String(data.topic ?? data.query ?? '').trim().slice(0, 300);
    const incidentId = typeof data.incidentId === 'string' ? data.incidentId : undefined;
    const depth: ResearchDepth = data.depth === 'exhaustive' || data.depth === 'standard' ? data.depth : 'deep';
    const fileGaps = data.fileGaps !== false;

    const find = async (text: string): Promise<void> => {
      if (incidentId) {
        try { await incidentStore.addFinding(incidentId, text); } catch { /* best-effort */ }
      }
    };
    console.log(`[ResearchAgent] Deep research: ${topic || '(empty)'} [${depth}]`);

    if (!topic) {
      await find('Deep research skipped: empty topic. Remedy: re-fire with a topic.');
      await this.complete(event, incidentId, false, 'empty topic', null);
      return;
    }

    try {
      await find(`Deep research started on "${topic.slice(0, 150)}" [${depth}]. Fan-out → read → gaps → critique → problem statements.`);
      const report = await new ResearchEngine(kernelSearch, kernelRead, llmAsk, depth).run(topic, { fileGaps });

      await find(
        `Researched "${topic.slice(0, 120)}" in ${report.rounds} round(s): ` +
        `${report.searches} searches, ${report.reads} reads, ${report.sources.length} sources, ` +
        `coverage ${(report.coverage * 100).toFixed(0)}%. ${report.exhausted ? `Exhausted: ${report.exhaustionReason}.` : `Stopped: ${report.exhaustionReason}.`}`,
      );
      for (const f of report.keyFindings.slice(0, 8)) await find(`Finding: ${f.slice(0, 400)}`);
      for (const c of report.contradictions.slice(0, 3)) await find(`Contradiction: ${c.slice(0, 300)}`);
      const verdict = assessUsefulness(report.problemStatements);
      await find(
        verdict.useful
          ? `Self-improvement: ${verdict.reason} Filed ${report.filed.length} problem-statement incident(s)` +
            (report.filed.length > 0 ? `: ${report.filed.map(f => `${f.title.slice(0, 80)} → ${f.incidentId}`).join('; ')}.` : '.')
          : `Self-improvement: ${verdict.reason}`,
      );

      if (incidentId) {
        try {
          await incidentStore.addAction(incidentId, {
            timestamp: new Date(), agent: this.name, action: 'deep_research', tool: 'browser',
            result: report.sources.length > 0 ? 'success' : 'failure',
            details: `${report.searches} searches, ${report.reads} reads, ${report.sources.length} sources, coverage ${(report.coverage * 100).toFixed(0)}%.`,
          });
          await incidentStore.resolveIncident(incidentId, {
            action: 'Completed deep research',
            success: report.sources.length > 0,
            details: `${report.summary.slice(0, 300)} Filed ${report.filed.length} gap(s).`,
          });
        } catch { /* store offline */ }
      }
      await this.complete(event, incidentId, report.sources.length > 0, formatCommandReply(report), report);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[ResearchAgent] Research failed:', msg);
      await find(`Deep research failed safely: ${msg.slice(0, 200)}`);
      if (incidentId) {
        try { await incidentStore.updateStatus(incidentId, 'escalated'); } catch { /* offline */ }
      }
      await this.complete(event, incidentId, false, `failed: ${msg.slice(0, 120)}`, null);
    } finally {
      console.log('[ResearchAgent] Completed deep research');
    }
  }

  private async complete(
    event: Event, incidentId: string | undefined, done: boolean, summary: string, report: ResearchReport | null,
  ): Promise<void> {
    await eventBus.emit({
      id: `EVT-${Date.now()}`,
      timestamp: new Date(),
      source: 'research-agent',
      type: 'research.completed',
      severity: done ? 'info' : 'warning',
      correlationId: event.correlationId || 'research',
      data: {
        incidentId, done, summary: summary.slice(0, 2000),
        sources: (report?.sources ?? []).slice(0, 10).map(s => s.url),
        coverage: report?.coverage ?? 0,
        exhausted: report?.exhausted ?? false,
        filed: report?.filed ?? [],
      },
    } as any);
  }
}

function formatCommandReply(report: ResearchReport): string {
  const head =
    `Research: "${report.topic}" — ${report.sources.length} sources, ` +
    `coverage ${(report.coverage * 100).toFixed(0)}%${report.exhausted ? ' (exhausted' : ' (stopped'}: ${report.exhaustionReason}).`;
  const findings = report.keyFindings.slice(0, 6).map((f, i) => `${i + 1}. ${f}`.slice(0, 400)).join('\n');
  const gaps = report.filed.length > 0
    ? `\nSelf-improvement filed: ${report.filed.map(f => `${f.title.slice(0, 80)} → ${f.incidentId}`).join('; ')}`
    : report.problemStatements.length > 0
      ? `\nGaps spotted but not filed (usefulness bar or store offline).`
      : '';
  return `${head}\n${report.summary.slice(0, 900)}${findings ? `\n${findings}` : ''}${gaps}`.slice(0, 2500);
}
