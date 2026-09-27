import { spawn } from 'node:child_process';

import {
  DiscoveryProvider,
  ToolDescriptor,
  ToolImplementation,
} from '../index';

const READ_MAX_BYTES = 200 * 1024;
const FETCH_TIMEOUT_MS = 20000;

function requireHttpUrl(raw: string): URL {
  // Planned values sometimes arrive quoted (LLM copies "url: \"http://x\"").
  // Strip one layer of surrounding quotes before parsing; the planner also
  // sanitizes, this is the last line of defense. Observed live: Invalid URL.
  let text = String(raw ?? '').trim().replace(/^["'`]|["'`]$/g, '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  const url = new URL(text);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Refused: only http(s) URLs are allowed, got "${url.protocol}".`);
  }
  return url;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export const browserSearchTool: ToolDescriptor = {
  id: 'browser.search',
  name: 'Search the web',
  description: 'Searches the web (keyless DuckDuckGo) and returns titles, URLs, and snippets. Feeds browser.open/browser.read.',
  version: '1.0.0',
  domain: 'browser',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      limit: { type: 'number', description: 'Maximum results to return (1-10, default 5).' },
    },
    required: ['query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      count: { type: 'number' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            snippet: { type: 'string' },
          },
          required: ['title', 'url', 'snippet'],
        },
      },
      capturedAt: { type: 'string' },
    },
    required: ['query', 'count', 'results', 'capturedAt'],
  },
  capabilities: ['web-search', 'research'],
  supportedResourceKinds: ['web'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'browser.native',
};

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Parses DuckDuckGo html endpoint markup. Exported for fixture tests —
 * the live markup drifts, the parser contract should not.
 */
export function parseDuckResults(html: string, limit: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blocks = html.split(/<div[^>]*class="[^"]*result__body[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    if (results.length >= limit) break;
    const link = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = (block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1]
      ?? block.match(/<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]
      ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    results.push({
      title: link[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
      url: decodeDuckHref(link[1]),
      snippet,
    });
  }
  return results.filter(result => result.title && result.url);
}

/** DuckDuckGo wraps outbound links as /l/?uddg=<encoded-target>. */
export function decodeDuckHref(href: string): string {
  try {
    const unescaped = href.replace(/&amp;/g, '&');
    if (unescaped.startsWith('/l/') || unescaped.startsWith('//duckduckgo.com/l/')) {
      const query = unescaped.split('?')[1] ?? '';
      for (const pair of query.split('&')) {
        const [key, value] = pair.split('=');
        if (key === 'uddg' && value) return decodeURIComponent(value);
      }
    }
    return unescaped;
  } catch {
    return href;
  }
}

export const browserSearchImplementation: ToolImplementation = {
  toolId: browserSearchTool.id,

  async execute({ action }) {
    const query = String(action.input.query ?? '').trim();
    if (!query) throw new Error('Search query is required.');
    if (query.length > 300) throw new Error('Search query too long (max 300 chars).');
    const requested = typeof action.input.limit === 'number' ? Math.floor(action.input.limit) : 5;
    const limit = Math.min(Math.max(requested, 1), 10);

    const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(endpoint, {
      headers: { 'User-Agent': 'MARK/1.0 (local research tool)', Accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Search failed: ${response.status}`);
    const html = Buffer.from(await response.arrayBuffer()).subarray(0, READ_MAX_BYTES).toString('utf8');
    const results = parseDuckResults(html, limit);
    const output = { query, count: results.length, results, capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'web',
          source: 'browser.native',
          subject: query,
          summary: `Web search for "${query}": ${results.length} result(s).`,
          data: { query, count: results.length },
          confidence: 0.9,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const browserReadTool: ToolDescriptor = {
  id: 'browser.read',
  name: 'Read web page',
  description: 'Fetches an http(s) page and returns its readable text. No scripts run; file and custom schemes refused.',
  version: '1.0.0',
  domain: 'browser',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL to read.' },
      maxChars: { type: 'number', description: 'Maximum text characters to return (default 8000, max 20000).' },
    },
    required: ['url'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      title: { type: 'string' },
      text: { type: 'string' },
      truncated: { type: 'boolean' },
      capturedAt: { type: 'string' },
    },
    required: ['url', 'title', 'text', 'truncated', 'capturedAt'],
  },
  capabilities: ['web-reading', 'research'],
  supportedResourceKinds: ['web'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'browser.native',
};

export const browserReadImplementation: ToolImplementation = {
  toolId: browserReadTool.id,

  async execute({ action }) {
    const url = requireHttpUrl(String(action.input.url ?? ''));
    const requested = typeof action.input.maxChars === 'number' ? Math.floor(action.input.maxChars) : 8000;
    const maxChars = Math.min(Math.max(requested, 100), 20000);

    const response = await fetch(url, {
      headers: { 'User-Agent': 'MARK/1.0 (local research tool)', Accept: 'text/html,text/plain' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${response.statusText || ''}`.trim());
    const contentType = response.headers.get('content-type') || '';
    if (!/text\/(html|plain)|application\/xhtml/i.test(contentType)) {
      throw new Error(`Refused: unsupported content type "${contentType}".`);
    }
    const buffer = Buffer.from(await response.arrayBuffer()).subarray(0, READ_MAX_BYTES);
    const html = buffer.toString('utf8');
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim().slice(0, 200);
    const text = htmlToText(html);
    const output = {
      url: url.toString(),
      title,
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
      capturedAt: new Date().toISOString(),
    };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'web',
          source: 'browser.native',
          subject: url.toString(),
          summary: `Read ${output.text.length} chars from ${url.host}${title ? ` ("${title}")` : ''}.`,
          data: { url: url.toString(), chars: output.text.length },
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const browserOpenTool: ToolDescriptor = {
  id: 'browser.open',
  name: 'Open URL in browser',
  description: 'Opens an http(s) URL in the default desktop browser. Launch only — visibility is not verified.',
  version: '1.0.0',
  domain: 'browser',
  risk: 'reversible',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL to open.' },
    },
    required: ['url'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      launched: { type: 'boolean' },
      detail: { type: 'string' },
      capturedAt: { type: 'string' },
    },
    required: ['url', 'launched', 'detail', 'capturedAt'],
  },
  capabilities: ['browser-launch'],
  supportedResourceKinds: ['web', 'application'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'browser.native',
};

export const browserOpenImplementation: ToolImplementation = {
  toolId: browserOpenTool.id,

  async execute({ action }) {
    const url = requireHttpUrl(String(action.input.url ?? ''));
    // Detached spawn, no shell: the launcher returns immediately and the
    // browser outlives the kernel. Deliberately unverified — reported, not proven.
    await new Promise<void>((resolve, reject) => {
      const child = spawn('xdg-open', [url.toString()], { detached: true, stdio: 'ignore' });
      child.on('error', reject);
      child.on('spawn', () => {
        child.unref();
        resolve();
      });
    });
    const output = {
      url: url.toString(),
      launched: true,
      detail: 'Browser launch requested via xdg-open; on-screen visibility was not verified.',
      capturedAt: new Date().toISOString(),
    };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'web',
          source: 'browser.native',
          subject: url.toString(),
          summary: `Requested browser launch for ${url.toString()} (confirmation granted; visibility unverified).`,
          data: output,
          confidence: 0.7,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const browserNativeTools: ToolDescriptor[] = [browserSearchTool, browserReadTool, browserOpenTool];

export const browserNativeImplementations: ToolImplementation[] = [
  browserSearchImplementation,
  browserReadImplementation,
  browserOpenImplementation,
];

export const browserDiscoveryProvider: DiscoveryProvider = {
  id: 'browser.native',
  name: 'Browser provider',
  description: 'Reads web pages as text and opens URLs in the desktop browser.',
  priority: 80,

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async discoverResources(): Promise<never[]> {
    return [];
  },

  async discoverTools(): Promise<ToolDescriptor[]> {
    return browserNativeTools;
  },
};
