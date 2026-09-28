/**
 * Knowledge-base provider (kb.*): Markdown vault notes.
 *
 * The vault root is operator configuration (MARK_VAULT_PATH), never
 * goal-supplied: goals name notes, the operator places the vault. Reads
 * are risk-read; writing a note is risk-mutating like any file write.
 * Note names are slugs (no separators, no escapes); all IO is capped.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DiscoveryProvider,
  ToolDescriptor,
  ToolImplementation,
  ToolParameterSchema,
} from '../index';

const NOTE_RE = /^[A-Za-z0-9_.-]+$/;
const MAX_NAME = 128;
const MAX_BYTES = 50 * 1024;
const MAX_NOTES_SCAN = 500;
const MAX_FILE_SCAN_BYTES = 200 * 1024;

/** Vault root: explicit env, else <working>/.vault. Goal input never places it. */
export function vaultRoot(workingDirectory: string | undefined): string {
  const configured = (process.env.MARK_VAULT_PATH ?? '').trim();
  if (configured) return path.resolve(configured);
  return path.resolve(workingDirectory ?? process.cwd(), '.vault');
}

function checkName(name: unknown): string {
  const n = String(name ?? '').trim().replace(/\.md$/i, '');
  if (!NOTE_RE.test(n) || n.length === 0 || n.length > MAX_NAME) {
    throw new Error(`Refused: invalid note name ${JSON.stringify(String(name ?? '')).slice(0, 80)}.`);
  }
  return `${n}.md`;
}

/** Quick-capture default: today's date plus a slug of the content's first words. */
export function defaultNoteName(content: string, now = new Date()): string {
  const slug = content.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 0).slice(0, 6).join('-').slice(0, 60) || 'note';
  return `${now.toISOString().slice(0, 10)}-${slug}.md`;
}

function checkLimit(l: unknown, def = 10, max = 50): number {
  if (l === undefined || l === null || String(l).trim() === '') return def;
  const v = typeof l === 'number' ? l : Number(String(l).trim());
  if (!Number.isFinite(v)) return def;
  return Math.min(Math.max(Math.floor(v), 1), max);
}

async function listNotes(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map(e => e.name)
    .sort()
    .slice(0, MAX_NOTES_SCAN);
}

function snippet(text: string, queryTerms: string[]): string {
  const lower = text.toLowerCase();
  let idx = -1;
  for (const term of queryTerms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (idx < 0 || at < idx)) idx = at;
  }
  if (idx < 0) return text.slice(0, 200);
  const start = Math.max(0, idx - 80);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + 220)}${start + 220 < text.length ? '…' : ''}`;
}

const noteProp: ToolParameterSchema = { type: 'string', description: 'Note name (slug, .md added automatically).' };

export const kbNoteWriteTool: ToolDescriptor = {
  id: 'kb.note_write',
  name: 'Write knowledge note',
  description:
    'Writes a Markdown note to the knowledge base vault. Use to remember facts, decisions, procedures, and personal knowledge persistently. When no name is given, the note is filed under today\'s date with a short slug.',
  version: '1.1.0', domain: 'knowledge', risk: 'mutating',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Note name (slug, .md added automatically). Defaults to date + slug when omitted.' },
      content: { type: 'string', description: 'Text content to remember (max 50KB).' },
      overwrite: { type: 'boolean', description: 'Allow overwriting an existing note (default false).' },
    },
    required: ['content'],
  },
  capabilities: ['knowledge-writing', 'memory'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: false,
  metadata: {},
  provider: 'kb.native',
};

export const kbNoteWriteImplementation: ToolImplementation = {
  toolId: kbNoteWriteTool.id,
  async execute({ action, context }) {
    const input = action.input as Record<string, unknown>;
    let content = String(input.content ?? '');
    if (!content.trim()) throw new Error('Refused: note content is empty.');
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
      throw new Error(`Refused: note exceeds ${MAX_BYTES} bytes.`);
    }
    const rawName = String(input.name ?? '').trim();
    const file = rawName ? checkName(rawName) : defaultNoteName(content);
    const root = vaultRoot(context.workingDirectory);
    await fs.mkdir(root, { recursive: true });
    const dest = path.join(root, file);
    try {
      const stats = await fs.stat(dest);
      if (stats.isFile() && input.overwrite !== true) {
        throw new Error(`Refused: note "${file}" exists and overwrite was not allowed.`);
      }
    } catch (err) {
      if (err instanceof Error && !/ENOENT/.test(err.message)) throw err;
    }
    await fs.writeFile(dest, content, 'utf8');
    const output = { name: file, path: dest, bytesWritten: Buffer.byteLength(content, 'utf8'), capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [{
        id: `observation-${Date.now()}`, kind: 'file' as const, source: 'kb.native', subject: dest,
        summary: `Wrote knowledge note ${file} (confirmation granted).`,
        data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
      }],
    };
  },
};

export const kbNoteReadTool: ToolDescriptor = {
  id: 'kb.note_read',
  name: 'Read knowledge note',
  description:
    'Reads a Markdown note from the knowledge base vault. Use to recall remembered facts, decisions, and procedures.',
  version: '1.0.0', domain: 'knowledge', risk: 'read',
  available: true,
  inputSchema: { type: 'object', properties: { name: noteProp }, required: ['name'] },
  capabilities: ['knowledge-reading', 'memory'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'kb.native',
};

export const kbNoteReadImplementation: ToolImplementation = {
  toolId: kbNoteReadTool.id,
  async execute({ action, context }) {
    const file = checkName((action.input as Record<string, unknown>).name);
    const dest = path.join(vaultRoot(context.workingDirectory), file);
    try {
      const content = await fs.readFile(dest, 'utf8');
      const output = { name: file, content: content.slice(0, MAX_BYTES), capturedAt: new Date().toISOString() };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'file' as const, source: 'kb.native', subject: dest,
          summary: `Read knowledge note ${file}.`,
          data: { ...output, content: output.content.slice(0, 200) }, confidence: 1,
          observedAt: output.capturedAt, relatedResourceIds: [],
        }],
      };
    } catch {
      throw new Error(`Note "${file}" not found in the vault.`);
    }
  },
};

export const kbNoteListTool: ToolDescriptor = {
  id: 'kb.note_list',
  name: 'List knowledge notes',
  description:
    'Lists note names in the knowledge base vault. Use to survey what is remembered.',
  version: '1.0.0', domain: 'knowledge', risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'number', description: 'Max names (1-50, default 20).' } },
    required: [],
  },
  capabilities: ['knowledge-reading', 'memory'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'kb.native',
};

export const kbNoteListImplementation: ToolImplementation = {
  toolId: kbNoteListTool.id,
  async execute({ action, context }) {
    const notes = await listNotes(vaultRoot(context.workingDirectory));
    const limited = notes.slice(0, checkLimit((action.input as Record<string, unknown>).limit, 20));
    const output = { count: limited.length, notes: limited, capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [{
        id: `observation-${Date.now()}`, kind: 'file' as const, source: 'kb.native', subject: 'vault',
        summary: `Vault holds ${limited.length} note(s).`,
        data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
      }],
    };
  },
};

export const kbNoteSearchTool: ToolDescriptor = {
  id: 'kb.note_search',
  name: 'Search knowledge notes',
  description:
    'Searches knowledge base vault notes by keywords and returns ranked snippets. Use to find what you remember: remembered facts, decisions, and procedures.',
  version: '1.0.0', domain: 'knowledge', risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords to find in notes.' },
      limit: { type: 'number', description: 'Max hits (1-20, default 5).' },
    },
    required: ['query'],
  },
  capabilities: ['knowledge-search', 'memory'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'kb.native',
};

export const kbNoteSearchImplementation: ToolImplementation = {
  toolId: kbNoteSearchTool.id,
  async execute({ action, context }) {
    const query = String((action.input as Record<string, unknown>).query ?? '').trim().slice(0, 200);
    if (!query) throw new Error('Refused: search query is empty.');
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    if (terms.length === 0) throw new Error('Refused: query has no searchable terms.');
    const root = vaultRoot(context.workingDirectory);
    const notes = await listNotes(root);
    const hits: Array<{ note: string; score: number; snippet: string }> = [];
    for (const file of notes) {
      let text: string;
      try {
        const stats = await fs.stat(path.join(root, file));
        if (stats.size > MAX_FILE_SCAN_BYTES) continue;
        text = await fs.readFile(path.join(root, file), 'utf8');
      } catch {
        continue;
      }
      const lower = text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        let at = -1;
        let count = 0;
        while ((at = lower.indexOf(term, at + 1)) >= 0 && count < 20) { count++; score += term.length >= 5 ? 2 : 1; }
      }
      if (score > 0) hits.push({ note: file, score, snippet: snippet(text, terms) });
    }
    hits.sort((a, b) => b.score - a.score);
    const limited = hits.slice(0, checkLimit((action.input as Record<string, unknown>).limit, 5, 20));
    const output = { query, count: limited.length, hits: limited, capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [{
        id: `observation-${Date.now()}`, kind: 'file' as const, source: 'kb.native', subject: 'vault',
        summary: `Vault search for ${JSON.stringify(query)}: ${limited.length} hit(s).`,
        data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
      }],
    };
  },
};

export const kbTools: ToolDescriptor[] = [kbNoteWriteTool, kbNoteReadTool, kbNoteListTool, kbNoteSearchTool];
export const kbImplementations: ToolImplementation[] = [
  kbNoteWriteImplementation, kbNoteReadImplementation, kbNoteListImplementation, kbNoteSearchImplementation,
];

export const kbDiscoveryProvider: DiscoveryProvider = {
  id: 'kb.native',
  name: 'Knowledge base provider',
  description: 'Markdown vault notes: write, read, list, and search remembered knowledge.',
  priority: 80,
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async discoverResources(): Promise<never[]> {
    return [];
  },
  async discoverTools(): Promise<ToolDescriptor[]> {
    return kbTools;
  },
};
