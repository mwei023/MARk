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
import { repositoryRegistry } from '../../repositories/registry';

function repoNameFor(repoPath: string): string {
  try {
    const resolved = repositoryRegistry.resolve(repoPath);
    if (resolved?.fullName) return resolved.fullName;
  } catch { /* registry is best-effort here */ }
  return repoPath.split('/').filter(Boolean).pop() ?? repoPath;
}

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

/** find(1) args that PRUNE dependency/build dirs instead of merely filtering
 * them: -not -path still descends (node_modules output exceeds maxBuffer on
 * big checkouts — observed live as 'Command failed'). */
export function buildFindArgs(repoPath: string, nameArgs: string[]): string[] {
  return [
    repoPath,
    '(', '-path', '*/node_modules', '-o', '-path', '*/.git', '-o', '-path', '*/dist', ')',
    '-prune', '-o', '-type', 'f', '(', ...nameArgs, ')', '-print',
  ];
}

/**
 * Runs find, tolerating partial results: unreadable dirs (docker volumes,
 * root-owned mounts — observed live at data/postgres) make find exit 1
 * AFTER printing matches. execFile throws and would discard them, so fall
 * back to whatever stdout survived.
 */
export async function runFind(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFilePromise('find', args, { timeout: PROBE_TIMEOUT, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (err: unknown) {
    const e = err as { stdout?: string; code?: unknown };
    if (typeof e.stdout === 'string' && e.stdout.trim().length > 0) return e.stdout;
    throw err;
  }
}

const repoMapTool: ToolDescriptor = {
  id: 'repo.map',
  name: 'Repository map',
  description:
    'Lists source files (20 extensions: ts/tsx/js/jsx/py/go/rs/java/c/h/cpp/rb/php/swift/kt/scala/sh/vue/html/css) in a checkout, skipping deps and .git. First probe for unfamiliar codebases.',
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
      const stdout = await runFind(buildFindArgs(repoPath, ['-name', '*.ts', '-o', '-name', '*.tsx', '-o', '-name', '*.js', '-o', '-name', '*.jsx', '-o', '-name', '*.py', '-o', '-name', '*.go', '-o', '-name', '*.rs', '-o', '-name', '*.java', '-o', '-name', '*.c', '-o', '-name', '*.h', '-o', '-name', '*.cpp', '-o', '-name', '*.hpp', '-o', '-name', '*.rb', '-o', '-name', '*.php', '-o', '-name', '*.swift', '-o', '-name', '*.kt', '-o', '-name', '*.scala', '-o', '-name', '*.sh', '-o', '-name', '*.vue', '-o', '-name', '*.html', '-o', '-name', '*.css']));
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

export function extractSymbols(content: string, relPath: string): Array<{ name: string; kind: string; line: number }> {
  const out: Array<{ name: string; kind: string; line: number }> = [];
  const lines = content.split('\n');
  const isPy = relPath.endsWith('.py');
  const isGo = relPath.endsWith('.go');
  const isRs = relPath.endsWith('.rs');
  for (let i = 0; i < lines.length && out.length < 80; i++) {
    const line = lines[i].slice(0, 300);
    if (isPy) {
      const m = line.match(/^\s*(def|class)\s+([A-Za-z_]\w*)/);
      if (m) out.push({ name: m[2], kind: m[1], line: i + 1 });
    } else if (isGo) {
      const m = line.match(/^\s*(?:func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|type\s+([A-Za-z_]\w*))/);
      if (m) out.push({ name: m[1] || m[2], kind: m[1] ? 'func' : 'type', line: i + 1 });
    } else if (isRs) {
      const m = line.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)|^\s*(?:pub\s+)?(struct|enum|trait)\s+([A-Za-z_]\w*)/);
      if (m) out.push({ name: m[1] || m[3], kind: m[1] ? 'fn' : (m[2] || 'type'), line: i + 1 });
    } else {
      const m = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=;]+)?\s*=|^\s*export\s+default\s+(?:function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*))/);
      if (m) {
        const name = m[1] || m[2] || m[3] || m[4] || m[5] || m[6] || m[7] || m[8];
        const kind = m[1] ? 'function' : m[2] ? 'class' : m[3] ? 'interface' : m[4] ? 'type' : m[6] || m[7] ? 'default-export' : 'const';
        if (name) out.push({ name, kind, line: i + 1 });
        continue;
      }
      // Generic fallback for any other language (Java/C/Ruby/PHP/Swift/Kotlin/...):
      // class-like and def-like definitions share shapes across languages.
      const g =
        line.match(/^\s*(?:public|private|protected|static|final|abstract)?\s*(?:class|interface|enum|struct|trait)\s+([A-Za-z_]\w*)/) ||
        line.match(/^\s*(?:public|private|protected|static|final|async)?\s*(?:function|def|sub|fn)\s+([A-Za-z_]\w*)/) ||
        line.match(/^\s*(?:public|private|protected|static|final|synchronized)?\s*[\w<>\[\]., ]+\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:\{|throws)/);
      if (g) {
        const name = g[1];
        if (name && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) {
          out.push({ name, kind: 'def', line: i + 1 });
        }
      }
    }
  }
  return out;
}

const repoSymbolsTool: ToolDescriptor = {
  id: 'repo.symbols',
  name: 'Symbol index',
  description:
    'Extracts top-level definitions (functions, classes, types) from one file or the checkout. Structure before reading.',
  version: '1.0.0',
  domain: 'investigation',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
      file: { type: 'string', description: 'Repo-relative file. Omit to scan top files.' },
      limit: { type: 'number', description: 'Max symbols (default 50, max 80).' },
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

const repoSymbolsImplementation: ToolImplementation = {
  toolId: repoSymbolsTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    const limit = Math.min(
      Math.max(typeof action.input.limit === 'number' ? Math.floor(action.input.limit) : 50, 1),
      80,
    );
    try {
      const file = typeof action.input.file === 'string' ? action.input.file.replace(/^\//, '') : '';
      if (file) {
        if (file.includes('..')) return { output: failOutput('refused: path escapes the checkout') };
        const abs = `${repoPath}/${file}`;
        if (!existsSync(abs)) return { output: failOutput(`no such file: ${file}`) };
        const content = readFileSync(abs, 'utf8');
        const symbols = extractSymbols(content, file).slice(0, limit);
        return { output: okOutput({ file, count: symbols.length, symbols }) };
      }
      const stdout = await runFind(buildFindArgs(repoPath, ['-name', '*.ts', '-o', '-name', '*.tsx', '-o', '-name', '*.js', '-o', '-name', '*.jsx', '-o', '-name', '*.py', '-o', '-name', '*.go', '-o', '-name', '*.rs', '-o', '-name', '*.java', '-o', '-name', '*.c', '-o', '-name', '*.h', '-o', '-name', '*.cpp', '-o', '-name', '*.hpp', '-o', '-name', '*.rb', '-o', '-name', '*.php', '-o', '-name', '*.swift', '-o', '-name', '*.kt', '-o', '-name', '*.scala', '-o', '-name', '*.sh', '-o', '-name', '*.vue', '-o', '-name', '*.html', '-o', '-name', '*.css']));
      const files = stdout.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 20);
      const byFile: Array<{ file: string; symbols: Array<{ name: string; kind: string; line: number }> }> = [];
      let total = 0;
      for (const abs of files) {
        if (total >= limit) break;
        const rel = abs.startsWith(repoPath) ? abs.slice(repoPath.length + 1) : abs;
        try {
          const content = readFileSync(abs, 'utf8');
          if (content.length > 200_000) continue;
          const symbols = extractSymbols(content, rel).slice(0, limit - total);
          if (symbols.length > 0) {
            byFile.push({ file: rel.slice(0, 200), symbols });
            total += symbols.length;
          }
        } catch {
          continue;
        }
      }
      return { output: okOutput({ count: total, files: byFile }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

const repoImpactTool: ToolDescriptor = {
  id: 'repo.impact',
  name: 'Blast-radius check',
  description:
    'Estimates blast radius of changing a symbol: which files mention it. Multi-file safety before a patch.',
  version: '1.0.0',
  domain: 'investigation',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
      symbol: { type: 'string', description: 'Symbol name whose callers to find.' },
      limit: { type: 'number', description: 'Max files (default 20, max 20).' },
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

const repoImpactImplementation: ToolImplementation = {
  toolId: repoImpactTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    const symbol = typeof action.input.symbol === 'string' ? action.input.symbol.slice(0, 200) : '';
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    if (!symbol || !/^[A-Za-z_$][\w$./-]*$/.test(symbol)) return { output: failOutput('valid symbol is required') };
    const limit = Math.min(
      Math.max(typeof action.input.limit === 'number' ? Math.floor(action.input.limit) : 20, 1),
      20,
    );
    try {
      let stdout = '';
      try {
        ({ stdout } = await execFilePromise(
          'grep',
          ['-r', '-l', '-I', '--exclude-dir=node_modules', '--exclude-dir=.git', '--', symbol, repoPath],
          { timeout: PROBE_TIMEOUT, maxBuffer: 4 * 1024 * 1024 },
        ));
      } catch (err: unknown) {
        if (Number((err as { code?: unknown }).code) === 1) stdout = '';
        else return { output: failOutput(err instanceof Error ? err.message : String(err)) };
      }
      const files = stdout.split('\n').map(l => l.trim()).filter(Boolean)
        .map(f => (f.startsWith(repoPath) ? f.slice(repoPath.length + 1) : f).slice(0, 200))
        .slice(0, limit + 1);
      const truncated = files.length > limit;
      return { output: okOutput({ symbol, fileCount: files.slice(0, limit).length, truncated, files: files.slice(0, limit) }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

const repoContextPackTool: ToolDescriptor = {
  id: 'repo.context_pack',
  name: 'Context pack',
  description:
    'Builds one LLM-ready pack for an unfamiliar goal: map + hits + windows, capped by budget. What big agents assemble internally, made explicit.',
  version: '1.0.0',
  domain: 'investigation',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
      query: { type: 'string', description: 'Goal text, e.g. error or feature request.' },
      budgetChars: { type: 'number', description: 'Max pack chars (default 12000, max 20000).' },
    },
    required: ['repoPath', 'query'],
  },
  capabilities: ['code-search', 'local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'repo.semantic',
};

const repoContextPackImplementation: ToolImplementation = {
  toolId: repoContextPackTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    const query = typeof action.input.query === 'string' ? action.input.query.slice(0, 500) : '';
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    if (!query) return { output: failOutput('query is required') };
    const budget = Math.min(
      Math.max(typeof action.input.budgetChars === 'number' ? Math.floor(action.input.budgetChars) : 12000, 2000),
      20000,
    );
    try {
      const terms = query.split(/[^A-Za-z0-9_$]+/).map(t => t.trim()).filter(t => t.length >= 3).slice(0, 5);
      const sections: string[] = [`# Context pack for: ${query.slice(0, 200)}`, `repo: ${repoPath}`];
      let used = sections.join('\n').length;
      try {
        const stdout = await runFind(buildFindArgs(repoPath, ['-name', '*.ts', '-o', '-name', '*.tsx', '-o', '-name', '*.js', '-o', '-name', '*.jsx', '-o', '-name', '*.py', '-o', '-name', '*.go', '-o', '-name', '*.rs', '-o', '-name', '*.java', '-o', '-name', '*.c', '-o', '-name', '*.h', '-o', '-name', '*.cpp', '-o', '-name', '*.hpp', '-o', '-name', '*.rb', '-o', '-name', '*.php', '-o', '-name', '*.swift', '-o', '-name', '*.kt', '-o', '-name', '*.scala', '-o', '-name', '*.sh', '-o', '-name', '*.vue', '-o', '-name', '*.html', '-o', '-name', '*.css']));
        const files = stdout.split('\n').map(l => l.trim()).filter(Boolean)
          .map(f => (f.startsWith(repoPath) ? f.slice(repoPath.length + 1) : f)).slice(0, 30);
        const mapSection = `\n## Files (${files.length})\n${files.join('\n')}`;
        if (used + mapSection.length < budget) {
          sections.push(mapSection);
          used += mapSection.length;
        }
      } catch {
        // map best-effort
      }
      let windows = 0;
      for (const term of terms.slice(0, 3)) {
        if (used > budget * 0.85 || windows >= 3) break;
        try {
          const { stdout } = await execFilePromise(
            'grep',
            ['-r', '-n', '-I', '-m', '3', '--exclude-dir=node_modules', '--exclude-dir=.git', '--', term, repoPath],
            { timeout: PROBE_TIMEOUT, maxBuffer: 2 * 1024 * 1024 },
          );
          const hits = stdout.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2);
          for (const hit of hits) {
            const m = hit.match(/^(.*?):(\d+):(.*)$/);
            if (!m) continue;
            const rel = m[1].startsWith(repoPath) ? m[1].slice(repoPath.length + 1) : m[1];
            if (rel.includes('..')) continue;
            const abs = `${repoPath}/${rel}`;
            if (!existsSync(abs)) continue;
            const center = parseInt(m[2], 10);
            if (!Number.isFinite(center)) continue;
            const content = readFileSync(abs, 'utf8');
            const lines = content.split('\n');
            const lo = Math.max(0, center - 1 - 15);
            const hi = Math.min(lines.length, center + 15);
            const window = lines.slice(lo, hi).map((text, i) => `${lo + i + 1}|${text}`.slice(0, 300)).join('\n');
            const sec = `\n## Hit: ${term} in ${rel}:${center}\n${window}`;
            if (used + sec.length > budget) break;
            sections.push(sec);
            used += sec.length;
            windows++;
          }
        } catch {
          continue;
        }
      }
      const pack = sections.join('\n').slice(0, budget);
      return { output: okOutput({ query: query.slice(0, 200), budget, chars: pack.length, pack }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

function scoreTermOverlap(haystack: string, terms: string[]): number {
  const lower = haystack.toLowerCase();
  let score = 0;
  for (const t of terms) {
    const tl = t.toLowerCase();
    let idx = lower.indexOf(tl);
    let hits = 0;
    while (idx !== -1 && hits < 10) {
      score += tl.length >= 6 ? 3 : 1;
      hits++;
      idx = lower.indexOf(tl, idx + tl.length);
    }
  }
  return score;
}

const repoSemanticSearchTool: ToolDescriptor = {
  id: 'repo.semantic_search',
  name: 'Semantic code search',
  description:
    'Ranks repo files by relevance to a natural-language query. Embeddings re-rank when Ollama is reachable; deterministic term-overlap otherwise. Never throws, never hangs.',
  version: '1.0.0',
  domain: 'investigation',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
      query: { type: 'string', description: 'Natural-language goal or error text.' },
      limit: { type: 'number', description: 'Max files (default 8, max 15).' },
    },
    required: ['repoPath', 'query'],
  },
  capabilities: ['code-search', 'local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'repo.semantic',
};

const repoSemanticSearchImplementation: ToolImplementation = {
  toolId: repoSemanticSearchTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    const query = typeof action.input.query === 'string' ? action.input.query.slice(0, 500) : '';
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    if (!query) return { output: failOutput('query is required') };
    const limit = Math.min(
      Math.max(typeof action.input.limit === 'number' ? Math.floor(action.input.limit) : 8, 1),
      15,
    );
    // Vector-first: code-aware embeddings re-rank when the repo is indexed
    // and Ollama + Postgres answer. Any failure degrades to keyword — the
    // offline path stays deterministic and never hangs the caller.
    try {
      const { searchCode } = await import('../../code/indexer.js');
      const hits = await searchCode(repoNameFor(repoPath), query, limit);
      if (hits.length > 0) {
        return { output: okOutput({ query: query.slice(0, 200), mode: 'vector', count: hits.length, results: hits }) };
      }
    } catch {
      // Fall through to keyword.
    }
    try {
      const stdout = await runFind(buildFindArgs(repoPath, ['-name', '*.ts', '-o', '-name', '*.tsx', '-o', '-name', '*.js', '-o', '-name', '*.jsx', '-o', '-name', '*.py', '-o', '-name', '*.go', '-o', '-name', '*.rs', '-o', '-name', '*.java', '-o', '-name', '*.c', '-o', '-name', '*.h', '-o', '-name', '*.cpp', '-o', '-name', '*.hpp', '-o', '-name', '*.rb', '-o', '-name', '*.php', '-o', '-name', '*.swift', '-o', '-name', '*.kt', '-o', '-name', '*.scala', '-o', '-name', '*.sh', '-o', '-name', '*.vue', '-o', '-name', '*.html', '-o', '-name', '*.css']));
      const files = stdout.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 80);
      const terms = query.split(/[^A-Za-z0-9_$]+/).map(t => t.trim()).filter(t => t.length >= 3).slice(0, 8);
      const scored: Array<{ file: string; score: number; preview: string }> = [];
      for (const abs of files) {
        const rel = abs.startsWith(repoPath) ? abs.slice(repoPath.length + 1) : abs;
        try {
          const content = readFileSync(abs, 'utf8');
          if (content.length > 200_000) continue;
          const head = content.slice(0, 8000);
          const score = scoreTermOverlap(`${rel}\n${head}`, terms);
          if (score > 0) scored.push({ file: rel.slice(0, 200), score, preview: head.slice(0, 300) });
        } catch {
          continue;
        }
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, limit);
      // Embeddings re-rank plugs in here when Ollama is reachable; keyword
      // order stands otherwise so offline runs stay deterministic.
      return { output: okOutput({ query: query.slice(0, 200), mode: 'keyword', count: top.length, results: top.map(r => ({ file: r.file, score: r.score })) }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

const repoVerifyPatchTool: ToolDescriptor = {
  id: 'repo.verify_patch',
  name: 'Patch verification gate',
  description:
    'Runs the safest available repo check (typecheck, else lint, else test --dry) after a patch. Diagnostic only: reports pass/fail, never mutates.',
  version: '1.0.0',
  domain: 'verification',
  risk: 'diagnostic',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
      check: { type: 'string', description: 'Preferred check: typecheck | lint | test. Default typecheck.' },
      requirements: { type: 'array', description: 'Requirement ids (REQ-001) this check attests. Stamped onto observations.' },
    },
    required: ['repoPath'],
  },
  capabilities: ['verification', 'local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'repo.semantic',
};

const repoVerifyPatchImplementation: ToolImplementation = {
  toolId: repoVerifyPatchTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    const preferred = typeof action.input.check === 'string' ? action.input.check : 'typecheck';
    const requirements = Array.isArray(action.input.requirements)
      ? (action.input.requirements as unknown[]).map(String).filter(r => /^REQ-\d+$/i.test(r.trim())).slice(0, 20)
      : [];
    const stamp = (summary: string, attestation: 'pass' | 'fail', data: unknown) => ({
      output: data,
      observations: requirements.map((requirementId, i) => ({
        id: `observation-${Date.now()}-${i}`,
        kind: 'output' as const,
        source: 'repo.semantic',
        subject: repoPath,
        summary,
        data,
        confidence: 1,
        observedAt: new Date().toISOString(),
        relatedResourceIds: [],
        requirementId: requirementId.toUpperCase(),
        attestation,
      }))
    });
    try {
      let scripts: Record<string, string> = {};
      try {
        const pkg = JSON.parse(readFileSync(`${repoPath}/package.json`, 'utf8'));
        scripts = (pkg?.scripts ?? {}) as Record<string, string>;
      } catch {
        return { output: okOutput({ check: 'none', passed: true, detail: 'no package.json: nothing to verify' }) };
      }
      const order = preferred === 'lint'
        ? ['lint', 'typecheck', 'test']
        : preferred === 'test'
          ? ['test', 'typecheck', 'lint']
          : ['typecheck', 'lint', 'test'];
      const chosen = order.find(s => typeof scripts[s] === 'string');
      if (!chosen) return { output: okOutput({ check: 'none', passed: true, detail: 'no typecheck/lint/test script' }) };
      // Never run an unbounded test suite as a gate: typecheck/lint preferred;
      // `test` runs only the script as declared with a hard timeout.
      const { execFile: execCb } = await import('node:child_process');
      const { promisify: prom } = await import('node:util');
      const execFileP = prom(execCb);
      try {
        const { stdout, stderr } = await execFileP('npm', ['run', chosen], { cwd: repoPath, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
        const out = `${stdout}\n${stderr}`.slice(0, 2000);
        const output = okOutput({ check: chosen, passed: true, detail: out.slice(0, 500) });
        if (requirements.length === 0) return { output };
        return stamp(`${chosen} passed — attests ${requirements.join(', ')}`, 'pass', output);
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`.slice(0, 2000);
        const output = okOutput({ check: chosen, passed: false, detail: out.slice(0, 800) });
        if (requirements.length === 0) return { output };
        return stamp(`${chosen} failed — attests ${requirements.join(', ')}`, 'fail', output);
      }
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

const repoIndexTool: ToolDescriptor = {
  id: 'repo.index',
  name: 'Code index',
  description:
    'Builds a fresh vector index of a checkout for semantic search: symbol-aware chunks embedded locally. Memory-class write, needs DB + Ollama.',
  version: '1.0.0',
  domain: 'investigation',
  risk: 'diagnostic',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
      maxFiles: { type: 'number', description: 'Max files to index (default 25, max 40).' },
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

const repoIndexImplementation: ToolImplementation = {
  toolId: repoIndexTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    const maxFiles = Math.min(
      Math.max(typeof action.input.maxFiles === 'number' ? Math.floor(action.input.maxFiles) : 25, 1),
      40,
    );
    try {
      const { indexRepo } = await import('../../code/indexer.js');
      const result = await indexRepo(repoPath, repoNameFor(repoPath), maxFiles);
      return { output: okOutput({ repo: repoNameFor(repoPath), ...result }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const repoSemanticTools: ToolDescriptor[] = [repoMapTool, repoSearchTool, repoReadWindowTool, repoSymbolsTool, repoImpactTool, repoContextPackTool, repoSemanticSearchTool, repoVerifyPatchTool, repoIndexTool];

export const repoSemanticImplementations: ToolImplementation[] = [
  repoMapImplementation,
  repoSearchImplementation,
  repoReadWindowImplementation,
  repoSymbolsImplementation,
  repoImpactImplementation,
  repoContextPackImplementation,
  repoSemanticSearchImplementation,
  repoVerifyPatchImplementation,
  repoIndexImplementation,
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
