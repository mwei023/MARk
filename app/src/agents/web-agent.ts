/**
 * WebAgent: Mark's fast web-browsing agent. Searches, reads, synthesizes.
 *
 * Agentic loop (bounded, read-only): expand the query → fan-out searches in
 * parallel → dedup by URL → read the most credible unseen sources in
 * parallel → one refinement round when evidence is thin → synthesize an
 * answer with citations + confidence → `web.search.completed`.
 *
 * Division of labour with ResearchAgent: this agent answers quickly
 * (≤4 searches, ≤3 reads, no critique pass). Anything needing exhaustion,
 * contradiction-hunting, or self-improvement belongs to `research.requested`.
 */
import { Agent } from '../core/agent-runtime';
import { Event } from '../core/events';
import { incidentStore } from '../core/incident';
import { eventBus } from '../core/event-bus';
import { config } from '../config.js';
import { normalizeUrl, credibilityOf, domainOf } from './research-agent.js';

interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

interface ReadEvidence {
  item: SearchResultItem;
  text: string;
}

const MAX_SEARCHES = 4;
const MAX_READS = 3;

async function runTool(toolId: string, input: Record<string, unknown>): Promise<unknown> {
  const { markKernelBridge } = await import('../kernel/bridge.js');
  await markKernelBridge.initialize();
  const context = markKernelBridge.createContext({ userId: config.defaultUser, source: 'api' } as never);
  return markKernelBridge.execute(
    {
      id: `ACT-${Date.now()}-${toolId.replace('.', '')}`,
      toolId, input, requestedBy: config.defaultUser, createdAt: new Date().toISOString(),
    } as never,
    context,
  );
}

async function searchWeb(query: string, limit: number): Promise<SearchResultItem[]> {
  const result = await runTool('browser.search', { query: query.slice(0, 300), limit });
  if ((result as { status?: string }).status !== 'succeeded') return [];
  return (((result as { output?: { results?: SearchResultItem[] } }).output?.results ?? []) as SearchResultItem[])
    .map(r => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: String(r.snippet ?? '') }))
    .filter(r => r.url);
}

async function readPage(url: string): Promise<string> {
  try {
    const result = await Promise.race([
      runTool('browser.read', { url, maxChars: 4000 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('read timeout')), 20000)),
    ]);
    if ((result as { status?: string }).status !== 'succeeded') return '';
    return String(((result as { output?: { text?: unknown } }).output?.text ?? ''));
  } catch {
    return '';
  }
}

/** Query variants: the raw query plus one angle-shifted refinement. */
export function expandQuery(query: string): string[] {
  const q = query.trim().slice(0, 250);
  if (/\b(review|vs|compare|best|how to|what is|guide)\b/i.test(q)) return [q];
  return [q, `${q} review guide`];
}

function dedup(hits: SearchResultItem[], seen: Set<string>): SearchResultItem[] {
  const out: SearchResultItem[] = [];
  for (const hit of hits) {
    const key = normalizeUrl(hit.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

function rank(hits: SearchResultItem[]): SearchResultItem[] {
  return [...hits].sort((a, b) => credibilityOf(b.url) - credibilityOf(a.url));
}

function firstSentences(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const match = cleaned.match(/^(.{80,600}?[.!?])\s/);
  return (match?.[1] ?? cleaned.slice(0, maxChars)).slice(0, maxChars);
}

/**
 * Synthesizes evidence into a cited answer with confidence.
 * Confidence = source count × mean credibility, capped — few or sketchy
 * sources answer weakly, and say so.
 */
export function synthesizeAnswer(query: string, evidence: ReadEvidence[], snippets: SearchResultItem[]): { answer: string; confidence: number } {
  const withText = evidence.filter(e => e.text.trim().length > 100);
  const pool = withText.length > 0 ? withText : evidence;
  if (pool.length === 0 && snippets.length === 0) {
    return { answer: `Web search for "${query}" returned nothing usable.`, confidence: 0 };
  }
  const lines = pool.slice(0, 3).map(e => {
    const body = e.text.trim().length > 100 ? firstSentences(e.text, 350) : e.item.snippet.slice(0, 200);
    return `- ${body} [${domainOf(e.item.url)}](${e.item.url})`;
  });
  for (const s of snippets.slice(0, Math.max(0, 3 - lines.length))) {
    lines.push(`- ${s.snippet.slice(0, 200)} [${domainOf(s.url)}](${s.url})`);
  }
  const meanCred = pool.length > 0
    ? pool.reduce((sum, e) => sum + credibilityOf(e.item.url), 0) / pool.length
    : 0.4;
  const confidence = Math.min(0.95, Math.max(0.1, (pool.length / 3) * meanCred + (withText.length > 0 ? 0.15 : 0)));
  const lead = withText.length > 0
    ? firstSentences(withText[0].text, 300)
    : `Top result: ${snippets[0]?.title ?? 'see sources'}.`;
  return {
    answer: `${lead}\n${lines.join('\n')}\n(confidence ${(confidence * 100).toFixed(0)}%, ${pool.length} source(s))`,
    confidence,
  };
}

export class WebAgent extends Agent {
  constructor() {
    super('web-agent');
  }

  canHandle(event: Event): boolean {
    if (event.type === 'web.search.requested') return true;
    if (event.type === 'user.command.received') {
      const command = String((event.data as Record<string, any>).command || '');
      if (/\b(deep research|deep dive|literature review|state of the art|\bsota\b)\b/i.test(command)) return false;
      return /\b(search( the web)?|google|look\s?up|browse|research|find\s+online|what\s+does\s+the\s+web\s+say)\b/i.test(command);
    }
    return false;
  }

  async handleCommand(event: Event): Promise<string> {
    const command = String((event.data as Record<string, any>).command || '');
    const query = command
      .replace(/\b(search( the web)?|google|look\s?up|browse|research|find\s+online|what\s+does\s+the\s+web\s+say|for|about)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    if (!query) return '';
    try {
      const { answer } = await this.browse(query, 5, true);
      return `Web: ${answer}`.slice(0, 1200);
    } catch {
      return '';
    }
  }

  async handle(event: Event): Promise<void> {
    const data = event.data as Record<string, any>;
    const query = String(data.query ?? '').trim().slice(0, 300);
    const incidentId = typeof data.incidentId === 'string' ? data.incidentId : undefined;
    const limit = Math.min(Math.max(typeof data.limit === 'number' ? Math.floor(data.limit) : 5, 1), 10);
    const readTop = data.readTop !== false;

    const find = async (text: string): Promise<void> => {
      if (incidentId) {
        try { await incidentStore.addFinding(incidentId, text); } catch { /* best-effort */ }
      }
    };
    const act = async (action: string, tool: string, result: string, details: string): Promise<void> => {
      if (!incidentId) return;
      try {
        await incidentStore.addAction(incidentId, { timestamp: new Date(), agent: this.name, action, tool, result: result as 'success' | 'failure', details });
      } catch { /* trail best-effort */ }
    };
    console.log(`[WebAgent] Searching: ${query || '(empty)'}`);

    if (!query) {
      await find('Web search skipped: empty query. Remedy: re-fire with a query.');
      await this.complete(event, incidentId, false, 'empty query', [], 0);
      return;
    }

    try {
      const { answer, confidence, urls, searches, reads } = await this.browse(query, limit, readTop);
      await act('web_search', 'browser.search', urls.length > 0 ? 'success' : 'failure', `${searches} search(es), ${reads} read(s) for "${query.slice(0, 120)}".`);
      await find(`Web answer (confidence ${(confidence * 100).toFixed(0)}%): ${answer.slice(0, 600)}`);

      if (incidentId) {
        if (urls.length > 0) {
          await incidentStore.resolveIncident(incidentId, {
            action: 'Answered web research',
            success: true,
            details: `${urls.length} source(s) for "${query.slice(0, 120)}" at ${(confidence * 100).toFixed(0)}% confidence`,
          });
        } else {
          await incidentStore.updateStatus(incidentId, 'open');
        }
      }
      await this.complete(event, incidentId, urls.length > 0, answer.slice(0, 1500), urls, confidence);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[WebAgent] Search failed:', msg);
      await find(`Web research failed safely: ${msg.slice(0, 200)}`);
      if (incidentId) {
        try { await incidentStore.updateStatus(incidentId, 'escalated'); } catch { /* offline */ }
      }
      await this.complete(event, incidentId, false, `failed: ${msg.slice(0, 120)}`, [], 0);
    } finally {
      console.log(`[WebAgent] Completed search for "${query.slice(0, 60)}"`);
    }
  }

  /** The browsing loop. Pure orchestration over searchWeb/readPage — stub-friendly. */
  async browse(
    query: string, limit: number, readTop: boolean,
    deps: { search?: typeof searchWeb; read?: typeof readPage } = {},
  ): Promise<{ answer: string; confidence: number; urls: string[]; searches: number; reads: number }> {
    const search = deps.search ?? searchWeb;
    const read = deps.read ?? readPage;
    const seen = new Set<string>();
    let hits: SearchResultItem[] = [];
    let searches = 0;

    for (const variant of expandQuery(query)) {
      if (searches >= MAX_SEARCHES) break;
      let batch: SearchResultItem[] = [];
      try { batch = await search(variant, limit); } catch { batch = []; }
      searches++;
      hits.push(...dedup(batch, seen));
      // Refinement round only when evidence is thin.
      if (hits.length >= 3) break;
    }

    const ranked = rank(hits);
    const evidence: ReadEvidence[] = [];
    let reads = 0;
    if (readTop) {
      for (const item of ranked.slice(0, MAX_READS)) {
        if (reads >= MAX_READS) break;
        let text = '';
        try { text = await read(item.url); } catch { text = ''; }
        reads++;
        evidence.push({ item, text: text.slice(0, 4000) });
      }
    }

    const { answer, confidence } = synthesizeAnswer(query, evidence, ranked);
    return { answer, confidence, urls: ranked.map(h => h.url).slice(0, 10), searches, reads };
  }

  private async complete(
    event: Event, incidentId: string | undefined, done: boolean, summary: string, urls: string[], confidence: number,
  ): Promise<void> {
    await eventBus.emit({
      id: `EVT-${Date.now()}`,
      timestamp: new Date(),
      source: 'web-agent',
      type: 'web.search.completed',
      severity: done ? 'info' : 'warning',
      correlationId: event.correlationId || 'web',
      data: { incidentId, done, summary, urls: urls.slice(0, 10), confidence },
    } as any);
  }
}
