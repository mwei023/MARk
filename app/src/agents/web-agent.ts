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
import { interactionStream } from '../core/interaction';
import { repositoryRegistry } from '../repositories/registry';
import { rankedProjectDirs } from '../core/project-index';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

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
const MAX_LINK_CHECK = 10;
/** Harvest wider than we check: hint filtering happens after collection. */
const MAX_LINK_COLLECT = 30;
const LINK_FILE_EXTS = new Set(['.html', '.htm', '.md', '.markdown', '.json', '.js', '.jsx', '.ts', '.tsx', '.txt', '.xml']);
const LINK_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor']);
/** Lockfiles are URL soup, never the user's links. Markup/docs first. */
const LINK_SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'package.json', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'eslint.config.js', 'vite.config.ts']);
const LINK_PRIORITY_EXTS = new Set(['.html', '.htm', '.md', '.markdown']);

/**
 * Link-check intent. Kept in sync with the gateway's LINK_CHECK_RE
 * deliberately — the classifier promises web-agent, so web-agent must
 * claim it, or routing lies (observed live).
 */
const LINK_CHECK_RE = /\b(check|checks|verify|verifying|test|testing|is|are)\b.{0,50}\b(links?|urls?)\b/i;
const LINK_STATUS_RE = /\b(links?|urls?)\b.{0,30}\b(work(ing|s)?|broken|valid|alive|dead|up|down)\b/i;

export function isLinkCheck(command: string): boolean {
  return LINK_CHECK_RE.test(command) || LINK_STATUS_RE.test(command);
}

/** Extract http(s) URLs from free text, deduped, capped. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of String(text ?? '').matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    const url = m[0].replace(/[.,;!?]+$/, '');
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      const key = parsed.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
      if (out.length >= MAX_LINK_CHECK) break;
    } catch {
      // Not a URL — skip.
    }
  }
  return out;
}

export interface ProjectLink {
  url: string;
  file: string;
}

/**
 * Harvest external links from a project checkout (docs + markup +
 * manifests, never dependencies or build output). Bounded: 40 files,
 * 200KB total.
 */
/** Infrastructure URLs no user ever means by "the link". */
const LINK_SKIP_URLS = [/^https?:\/\/(www\.)?w3\.org\//i, /^https?:\/\/fonts\.g/i, /^https?:\/\/schema\.org\//i];

function isSkippableUrl(url: string): boolean {
  return LINK_SKIP_URLS.some(re => re.test(url));
}

export function findProjectLinks(localPath: string): ProjectLink[] {
  const found: ProjectLink[] = [];
  const seenFiles: string[] = [];
  const collect = (dir: string): void => {
    if (seenFiles.length >= 40) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seenFiles.length >= 40) return;
      if (e.name.startsWith('.') || LINK_SKIP_DIRS.has(e.name) || LINK_SKIP_FILES.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        collect(full);
        continue;
      }
      if (LINK_FILE_EXTS.has(extname(e.name).toLowerCase())) seenFiles.push(full);
    }
  };
  collect(localPath);
  // Markup and docs first: the user's own links live there, not in configs.
  seenFiles.sort((a, b) => Number(LINK_PRIORITY_EXTS.has(extname(b).toLowerCase())) - Number(LINK_PRIORITY_EXTS.has(extname(a).toLowerCase())));
  const seen = new Set<string>();
  let budgetBytes = 200 * 1024;
  for (const full of seenFiles) {
    if (found.length >= MAX_LINK_COLLECT || budgetBytes <= 0) break;
    let text = '';
    try {
      const stats = statSync(full);
      if (stats.size > 100 * 1024) continue;
      budgetBytes -= stats.size;
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const url of extractUrls(text)) {
      if (seen.has(url) || isSkippableUrl(url)) continue;
      seen.add(url);
      found.push({ url, file: full });
      if (found.length >= MAX_LINK_COLLECT) break;
    }
  }
  return found;
}

export interface LinkStatus {
  url: string;
  alive: boolean;
  status: number;
  ms: number;
  file?: string;
}

/** Check links through browser.check; checker injectable for tests. */
export async function checkLinks(
  urls: string[],
  checker?: (url: string) => Promise<{ alive: boolean; status: number; ms: number }>,
): Promise<LinkStatus[]> {
  const check = checker ?? (async (url: string) => {
    const result = await runTool('browser.check', { url });
    const output = (result as { output?: Record<string, unknown> }).output ?? {};
    return {
      alive: output.alive === true,
      status: typeof output.status === 'number' ? output.status : 0,
      ms: typeof output.ms === 'number' ? output.ms : 0,
    };
  });
  const capped = urls.slice(0, MAX_LINK_CHECK);
  return Promise.all(capped.map(async (url): Promise<LinkStatus> => {
    try {
      const r = await check(url);
      return { url, alive: r.alive, status: r.status, ms: r.ms };
    } catch {
      return { url, alive: false, status: 0, ms: 0 };
    }
  }));
}

export function formatLinkReport(results: LinkStatus[]): string {
  const lines = results.map(r =>
    `${r.alive ? '✓' : '✗'} ${r.url} → ${r.status > 0 ? r.status : 'dead'} (${r.ms}ms)`);
  const dead = results.filter(r => !r.alive).length;
  const head = dead === 0
    ? `Link check (${results.length}): all alive.`
    : `Link check (${results.length}): ${dead} dead.`;
  return `${head}\n${lines.join('\n')}`;
}

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
      if (isLinkCheck(command)) return true;
      return /\b(search( the web)?|google|look\s?up|browse|research|find\s+online|what\s+does\s+the\s+web\s+say)\b/i.test(command);
    }
    return false;
  }

  /**
   * Link checking: URLs from the command win; otherwise resolve project
   * context (session lastRepo, then named checkout) and harvest its links.
   * A name hint ("linkedin") filters; singular "the link" with many
   * candidates asks instead of spraying checks.
   */
  private async handleLinkCheck(command: string): Promise<string> {
    const direct = extractUrls(command);
    // A site word beside the URL narrows it ("the linkedin link .../x").
    const hint = (command.toLowerCase().match(/\b(linkedin|github|twitter|x\.com|facebook|instagram|youtube|blog|docs|homepage|portfolio|site)\b/) ?? [])[1];
    if (direct.length > 0) {
      const targets = hint ? direct.filter(u => u.toLowerCase().includes(hint)) : direct;
      const results = await checkLinks(targets.length > 0 ? targets : direct);
      return `Web: ${formatLinkReport(results)}`.slice(0, 1200);
    }
    const localPaths = this.resolveLinkDirs(command);
    if (localPaths.length === 0) {
      return 'Web: paste the URL or name the project holding the link (e.g. "check the linkedin link in MyPortfolio").';
    }
    const found: Array<{ url: string; file: string }> = [];
    const seen = new Set<string>();
    // Merge wide (collect cap), narrow by hint, check capped: filtering
    // AFTER collection, or template-README soup starves real links.
    for (const dir of localPaths.slice(0, 3)) {
      for (const l of findProjectLinks(dir)) {
        if (seen.has(l.url)) continue;
        seen.add(l.url);
        found.push(l);
        if (found.length >= MAX_LINK_COLLECT) break;
      }
      if (found.length >= MAX_LINK_COLLECT) break;
    }
    if (found.length === 0) {
      return `Web: no links found in ${localPaths[0]}. Paste the URL to check it directly.`;
    }
    const narrowed = hint ? found.filter(l => l.url.toLowerCase().includes(hint)) : found;
    if (hint && narrowed.length === 0) {
      return `Web: no "${hint}" link found. Tried: ${found.slice(0, 8).map(l => l.url).join(', ')}.`;
    }
    const plural = /\blinks\b/i.test(command);
    if (!hint && !plural && narrowed.length > 1) {
      // Conversation memory: a bare "the link" right after a narrowed
      // check re-checks those URLs instead of asking again.
      try {
        const lastLinks = interactionStream.getContext<string[]>('lastLinks') ?? [];
        const stillThere = lastLinks.filter(u => narrowed.some(l => l.url === u));
        if (stillThere.length > 0) {
          const results = await checkLinks(stillThere.slice(0, MAX_LINK_CHECK));
          return `Web: ${formatLinkReport(results)}`.slice(0, 1200);
        }
      } catch {
        // Session memory is best-effort.
      }
      return `Web: which link? Found ${narrowed.length}: ${narrowed.slice(0, 8).map(l => l.url).join(', ')}.`;
    }
    const results = await checkLinks(narrowed.map(l => l.url));
    try {
      if (hint && results.length > 0 && results.length <= 5) {
        interactionStream.setContext('lastLinks', results.map(r => r.url));
      }
    } catch {
      // Session memory is best-effort.
    }
    return `Web: ${formatLinkReport(results)}`.slice(0, 1200);
  }

  /** Project directory for link context: session memory, then named checkout. */
  private resolveLinkContext(command: string): string | null {
    const dirs = this.resolveLinkDirs(command);
    return dirs.length > 0 ? dirs[0] : null;
  }

  /**
   * Candidate project directories, best first: the remembered repo
   * (resolved through the registry AND the directory index — session
   * memory stores bare dir names like "MyPortfolio" that no registry
   * lookup can find), then ranked mentions (weak word-tier included so
   * "the portfolio" keeps flowing).
   */
  private resolveLinkDirs(command: string): string[] {
    const out: string[] = [];
    const push = (p: string | null | undefined): void => {
      if (p && !out.includes(p)) out.push(p);
    };
    try {
      const remembered = interactionStream.getContext<string>('lastRepo');
      if (remembered) {
        try {
          const repo = repositoryRegistry.resolve(remembered);
          push(repo?.localPath);
        } catch {
          // Registry lookup is best-effort.
        }
        if (out.length === 0) {
          const redirs = rankedProjectDirs(remembered);
          if (redirs.length > 0) push(redirs[0].localPath);
        }
      }
    } catch {
      // Session memory is best-effort.
    }
    try {
      for (const d of rankedProjectDirs(command)) push(d.localPath);
    } catch {
      // Directory scan is best-effort.
    }
    return out;
  }

  async handleCommand(event: Event): Promise<string> {
    const command = String((event.data as Record<string, any>).command || '');
    if (isLinkCheck(command)) {
      return this.handleLinkCheck(command);
    }    const query = command
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
