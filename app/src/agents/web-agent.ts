/**
 * WebAgent: Mark's research agent. Searches the web, reads pages, reports.
 *
 * Thin face over the browser kernel tools (search/read are risk-read, so
 * they run ungated; opening a desktop browser stays confirmation-gated).
 * Flow: `web.search.requested` { query, limit?, readTop?, incidentId? } →
 * search findings → optional top-result read → `web.search.completed`.
 * Zero results stays open with a trail; a throw escalates honestly.
 */
import { Agent } from '../core/agent-runtime';
import { Event } from '../core/events';
import { incidentStore } from '../core/incident';
import { eventBus } from '../core/event-bus';
import { config } from '../config.js';

interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export class WebAgent extends Agent {
  constructor() {
    super('web-agent');
  }

  canHandle(event: Event): boolean {
    if (event.type === 'web.search.requested') return true;
    if (event.type === 'user.command.received') {
      const command = String((event.data as Record<string, any>).command || '');
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
    const { markKernelBridge } = await import('../kernel/bridge.js');
    await markKernelBridge.initialize();
    const context = markKernelBridge.createContext({ userId: config.defaultUser, source: 'api' } as never);
    const result = await markKernelBridge.execute(
      {
        id: `ACT-${Date.now()}-webq`,
        toolId: 'browser.search',
        input: { query, limit: 3 },
        requestedBy: config.defaultUser,
        createdAt: new Date().toISOString(),
      } as never,
      context,
    );
    if ((result as { status?: string }).status !== 'succeeded') return '';
    const out = (result as { output?: { results?: SearchResultItem[] } }).output;
    if (!out?.results?.length) return `Web search for "${query}" returned nothing usable.`;
    return `Web: ${out.results.map(r => `${r.title} (${r.url})`).join(' | ').slice(0, 600)}`;
  }

  async handle(event: Event): Promise<void> {
    const data = event.data as Record<string, any>;
    const query = String(data.query ?? '').trim().slice(0, 300);
    const incidentId = typeof data.incidentId === 'string' ? data.incidentId : undefined;
    const limit = Math.min(Math.max(typeof data.limit === 'number' ? Math.floor(data.limit) : 5, 1), 10);
    const readTop = data.readTop !== false;

    const find = async (text: string): Promise<void> => {
      if (incidentId) await incidentStore.addFinding(incidentId, text);
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
      await this.complete(event, incidentId, false, 'empty query', []);
      return;
    }

    try {
      const { markKernelBridge } = await import('../kernel/bridge.js');
      await markKernelBridge.initialize();
      const context = markKernelBridge.createContext({ userId: config.defaultUser, source: 'api' } as never);
      const run = (toolId: string, input: Record<string, unknown>, id: string) =>
        markKernelBridge.execute(
          { id, toolId, input, requestedBy: config.defaultUser, createdAt: new Date().toISOString() } as never,
          context,
        );

      const searched = await run('browser.search', { query, limit }, `ACT-${Date.now()}-search`);
      if ((searched as { status?: string }).status !== 'succeeded') {
        await act('web_search', 'browser.search', 'failure', 'Search tool did not succeed.');
        await find(`Web search failed for "${query}". Remedy: retry, simplify the query, or check network egress.`);
        if (incidentId) await incidentStore.updateStatus(incidentId, 'open');
        await this.complete(event, incidentId, false, 'search failed', []);
        return;
      }
      const results = ((searched as { output?: { results?: SearchResultItem[] } }).output?.results ?? []).slice(0, limit);
      await act('web_search', 'browser.search', 'success', `${results.length} result(s) for "${query.slice(0, 120)}".`);
      for (const r of results.slice(0, 5)) {
        await find(`Found: ${r.title.slice(0, 140)} (${r.url.slice(0, 120)}) — ${r.snippet.slice(0, 200)}`);
      }
      if (results.length === 0) {
        if (incidentId) await incidentStore.updateStatus(incidentId, 'open');
        await this.complete(event, incidentId, false, 'no results', []);
        return;
      }

      if (readTop) {
        const top = results[0];
        const read = await run('browser.read', { url: top.url, maxChars: 4000 }, `ACT-${Date.now()}-read`);
        if ((read as { status?: string }).status === 'succeeded') {
          const text = String(((read as { output?: { text?: unknown } }).output?.text ?? '')).slice(0, 1200);
          await act('web_read', 'browser.read', 'success', `Read ${text.length} chars from ${top.url.slice(0, 120)}.`);
          await find(`Top result content (${top.title.slice(0, 120)}): ${text}`);
        } else {
          await find(`Top result unreadable (${top.url.slice(0, 120)}); search snippets above stand.`);
        }
      }

      if (incidentId) {
        await incidentStore.resolveIncident(incidentId, {
          action: 'Answered web research',
          success: true,
          details: `${results.length} result(s) for "${query.slice(0, 120)}"`,
        });
      }
      await this.complete(event, incidentId, true, `${results.length} result(s)`, results.map(r => r.url));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[WebAgent] Search failed:', msg);
      await find(`Web research failed safely: ${msg.slice(0, 200)}`);
      if (incidentId) await incidentStore.updateStatus(incidentId, 'escalated');
      await this.complete(event, incidentId, false, `failed: ${msg.slice(0, 120)}`, []);
    } finally {
      console.log(`[WebAgent] Completed search for "${query.slice(0, 60)}"`);
    }
  }

  private async complete(
    event: Event, incidentId: string | undefined, done: boolean, summary: string, urls: string[],
  ): Promise<void> {
    await eventBus.emit({
      id: `EVT-${Date.now()}`,
      timestamp: new Date(),
      source: 'web-agent',
      type: 'web.search.completed',
      severity: done ? 'info' : 'warning',
      correlationId: event.correlationId || 'web',
      data: { incidentId, done, summary, urls: urls.slice(0, 10) },
    } as any);
  }
}
