/**
 * Repo-semantic tools (repo.*): read-only semantic reasoning over unfamiliar
 * codebases so the planner can investigate before repairing.
 *
 * No embeddings, no LLM, no network. Deterministic filesystem + grep probes
 * with hard caps. Failures return { ok: false } output instead of throwing,
 * so one unavailable probe does not fail the whole plan.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import type { DiscoveryProvider } from '../tool-discovery';
import type { ToolDescriptor, ToolImplementation } from '../index';

const execFilePromise = promisify(execFile);
const PROBE_TIMEOUT = 15000;
const MAX_FILES = 50;
const MAX_MATCHES = 20;

function okOutput(extra: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, capturedAt: new Date().toISOString(), ...extra };
}

function failOutput(reason: string): Record<string, unknown> {
  return { ok: false, reason: reason.slice(0, 300), capturedAt: new Date().toISOString() };
}

function requireRepoPath(input: Record<string, unknown>): string | null {
  const p = typeof input.repoPath === 'string' ? input.repoPath.trim() : '';
  if (!p) return null;
  try {
    return existsSync(p) && statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

const repoMapTool: ToolDescriptor = {
  id: 'repo.map',
  name: 'Repository map',
  description:
    'Lists source files (ts/js/py/go/rs) in a local checkout, skipping node_modules and .git. First probe for unfamiliar codebases: what exists.',
  version: '1.0.0',
  domain: 'investigation',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
      limit: { type: 'number', description: 'Max files (default 50, max 50).' },
    },
    required: ['repoPath'],
  },
  capabilities: ['code-search', 'local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'repo.semantic',
};

const repoMapImplementation: ToolImplementation = {
  toolId: repoMapTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    const limit = Math.min(
      Math.max(typeof action.input.limit === 'number' ? Math.floor(action.input.limit) : MAX_FILES, 1),
      MAX_FILES,
    );
    try {
      const { stdout } = await execFilePromise(
        'find',
        [repoPath, '-type', 'f', '(', '-name', '*.ts', '-o', '-name', '*.js', '-o', '-name', '*.py', '-o', '-name', '*.go', '-o', '-name', '*.rs', ')', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*'],
        { timeout: PROBE_TIMEOUT, maxBuffer: 4 * 1024 * 1024 },
      );
      const files = stdout.split('\n').map(l => l.trim()).filter(Boolean).slice(0, limit + 1);
      const truncated = files.length > limit;
      const sliced = files.slice(0, limit).map(f => f.startsWith(repoPath) ? f.slice(repoPath.length + 1) : f);
      return { output: okOutput({ count: sliced.length, truncated, files: sliced }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

const repoSearchTool: ToolDescriptor = {
  id: 'repo.search_symbol',
  name: 'Symbol search',
  description:
    'Searches for a symbol or error text in source files under a checkout. Fixed-text grep, skips node_modules/.git. Names callers and definitions.',
  version: '1.0.0',
  domain: 'investigation',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
      symbol: { type: 'string', description: 'Fixed text to search for (not a regex).' },
      limit: { type: 'number', description: 'Max matches (default 20, max 20).' },
    },
    required: ['repoPath', 'symbol'],
  },
  capabilities: ['code-search', 'local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'repo.semantic',
};

const repoSearchImplementation: ToolImplementation = {
  toolId: repoSearchTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    const symbol = typeof action.input.symbol === 'string' ? action.input.symbol.slice(0, 200) : '';
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    if (!symbol) return { output: failOutput('symbol is required') };
    const limit = Math.min(
      Math.max(typeof action.input.limit === 'number' ? Math.floor(action.input.limit) : MAX_MATCHES, 1),
      MAX_MATCHES,
    );
    try {
      let stdout = '';
      try {
        ({ stdout } = await execFilePromise(
          'grep',
          ['-r', '-n', '-I', '--exclude-dir=node_modules', '--exclude-dir=.git', '--', symbol, repoPath],
          { timeout: PROBE_TIMEOUT, maxBuffer: 4 * 1024 * 1024 },
        ));
      } catch (err: unknown) {
        if (Number((err as { code?: unknown }).code) === 1) stdout = '';
        else return { output: failOutput(err instanceof Error ? err.message : String(err)) };
      }
      const matches = stdout.split('\n').map(l => l.trim()).filter(Boolean).slice(0, limit + 1);
      const truncated = matches.length > limit;
      const sliced = matches.slice(0, limit).map(line => {
        const rel = line.startsWith(repoPath) ? line.slice(repoPath.length + 1) : line;
        return rel.slice(0, 300);
      });
      return { output: okOutput({ symbol, count: sliced.length, truncated, matches: sliced }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

const repoReadWindowTool: ToolDescriptor = {
  id: 'repo.read_window',
  name: 'Read code window',
  description:
    'Reads a line window around a location in a repo file. Capped to 80 lines: context for a repair, never a full dump.',
  version: '1.0.0',
  domain: 'investigation',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
      file: { type: 'string', description: 'Repo-relative file path.' },
      line: { type: 'number', description: 'Center line (1-based).' },
      radius: { type: 'number', description: 'Lines around center (default 25, max 40).' },
    },
    required: ['repoPath', 'file', 'line'],
  },
  capabilities: ['filesystem-reading', 'local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'repo.semantic',
};

const repoReadWindowImplementation: ToolImplementation = {
  toolId: repoReadWindowTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    const file = typeof action.input.file === 'string' ? action.input.file.replace(/^\//, '') : '';
    const line = typeof action.input.line === 'number' ? Math.floor(action.input.line) : NaN;
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    if (!file || !Number.isFinite(line) || line < 1) return { output: failOutput('file and line are required') };
    if (file.includes('..')) return { output: failOutput('refused: path escapes the checkout') };
    const radius = Math.min(
      Math.max(typeof action.input.radius === 'number' ? Math.floor(action.input.radius) : 25, 1),
      40,
    );
    try {
      const abs = `${repoPath}/${file}`;
      if (!existsSync(abs)) return { output: failOutput(`no such file: ${file}`) };
      const content = readFileSync(abs, 'utf8');
      const lines = content.split('\n');
      if (line > lines.length) return { output: failOutput(`line ${line} beyond ${lines.length} lines`) };
      const lo = Math.max(0, line - 1 - radius);
      const hi = Math.min(lines.length, line + radius);
      const window = lines.slice(lo, hi).map((text, i) => `${lo + i + 1}|${text}`.slice(0, 500)).join('\n');
      return { output: okOutput({ file, line, totalLines: lines.length, window }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const repoSemanticTools: ToolDescriptor[] = [repoMapTool, repoSearchTool, repoReadWindowTool];

export const repoSemanticImplementations: ToolImplementation[] = [
  repoMapImplementation,
  repoSearchImplementation,
  repoReadWindowImplementation,
];

export const repoSemanticDiscoveryProvider: DiscoveryProvider = {
  id: 'repo.semantic',
  name: 'Repo semantic tools',
  description: 'Read-only semantic probes for unfamiliar codebases.',
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async discoverResources(): Promise<[]> {
    return [];
  },
  async discoverTools(): Promise<ToolDescriptor[]> {
    return repoSemanticTools;
  },
};
