/**
 * TypeScript language-intelligence provider (lsp.*): diagnostics,
 * definitions, references, hover, and document symbols.
 *
 * In-process compiler LanguageService (no subprocess, no JSON-RPC
 * server): the typescript package is already a dependency. Reads only —
 * diagnostic risk for the diagnostics gate, read for navigation. Roots
 * must be real directories without `..` escapes (repo tools precedent;
 * checkouts live outside the working-dir jail).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import {
  DiscoveryProvider,
  ToolDescriptor,
  ToolImplementation,
  ToolParameterSchema,
} from '../index';

const MAX_FILES = 100;
const MAX_DIAGNOSTICS = 200;
const MAX_LOCATIONS = 50;
const SERVICE_TTL_MS = 60000;

function failOutput(reason: string): Record<string, unknown> {
  return { ok: false, reason: reason.slice(0, 300), capturedAt: new Date().toISOString() };
}

export function checkRepoRoot(repoPath: unknown): string {
  const raw = String(repoPath ?? '').trim();
  if (!raw || raw.includes('..')) throw new Error('Refused: repoPath must be a plain absolute directory.');
  const root = path.resolve(raw);
  try {
    if (!fs.statSync(root).isDirectory()) throw new Error();
  } catch {
    throw new Error(`Refused: no directory at ${raw.slice(0, 120)}.`);
  }
  return root;
}

function checkRelFile(file: unknown): string {
  const f = String(file ?? '').trim().replace(/^\//, '');
  if (!f || f.includes('..') || f.length > 300) throw new Error('Refused: invalid repo-relative file.');
  return f;
}

function checkPosition(line: unknown, character: unknown): { line: number; character: number } {
  const l = typeof line === 'number' ? line : Number(String(line ?? '').trim());
  const c = typeof character === 'number' ? character : Number(String(character ?? '').trim());
  if (!Number.isInteger(l) || l < 1 || !Number.isInteger(c) || c < 1) {
    throw new Error('Refused: line/character must be 1-based positive integers.');
  }
  return { line: l, character: c };
}

interface CachedService {
  service: ts.LanguageService;
  atMs: number;
  files: string[];
}

const serviceCache = new Map<string, CachedService>();

function loadProgramFiles(root: string): { fileNames: string[]; options: ts.CompilerOptions } {
  const configs = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.mark.json'];
  for (const name of configs) {
    const candidate = path.join(root, name);
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = ts.readConfigFile(candidate, p => fs.readFileSync(p, 'utf8'));
      if (raw.error) continue;
      const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, root, undefined, candidate);
      if (parsed.errors.length === 0 && parsed.fileNames.length > 0) {
        return { fileNames: parsed.fileNames.slice(0, 2000), options: parsed.options };
      }
    } catch {
      // Unparseable config — try the next candidate.
    }
  }
  // No usable tsconfig: all TS sources under root, default options.
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (found.length >= 2000) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) found.push(full);
    }
  };
  walk(root);
  return {
    fileNames: found,
    options: { strict: true, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.NodeJs, skipLibCheck: true },
  };
}

function getService(root: string): { service: ts.LanguageService; files: string[] } {
  const hit = serviceCache.get(root);
  if (hit && Date.now() - hit.atMs < SERVICE_TTL_MS) return { service: hit.service, files: hit.files };
  const { fileNames, options } = loadProgramFiles(root);
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => fileNames,
    // Version tracks file mtime: without this the service serves stale
    // snapshots and verification recounts never see fixes (always-revert).
    getScriptVersion: fileName => {
      try {
        return String(fs.statSync(fileName).mtimeMs);
      } catch {
        return '0';
      }
    },
    getScriptSnapshot: fileName => {
      try {
        const text = fs.readFileSync(fileName, 'utf8');
        return ts.ScriptSnapshot.fromString(text);
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: opts => ts.getDefaultLibFilePath(opts),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  serviceCache.set(root, { service, atMs: Date.now(), files: fileNames });
  return { service, files: fileNames };
}

export function absFile(root: string, rel: string): string {
  const abs = path.resolve(root, checkRelFile(rel));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Refused: file escapes the repository.');
  return abs;
}

export interface LspDiagnostic {
  file: string;
  line: number;
  character: number;
  severity: 'error' | 'warning' | 'suggestion';
  code: number;
  message: string;
}

function toDiagnostic(root: string, d: ts.Diagnostic): LspDiagnostic | undefined {
  if (!d.file || d.start === undefined) return undefined;
  const pos = d.file.getLineAndCharacterOfPosition(d.start);
  return {
    file: path.relative(root, d.file.fileName) || d.file.fileName,
    line: pos.line + 1,
    character: pos.character + 1,
    severity: d.category === ts.DiagnosticCategory.Error ? 'error'
      : d.category === ts.DiagnosticCategory.Warning ? 'warning' : 'suggestion',
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 500),
  };
}

export function collectDiagnostics(root: string, relFile?: string): LspDiagnostic[] {
  const { service, files } = getService(root);
  const targets = relFile
    ? [absFile(root, relFile)]
    : files.filter(f => !f.includes('node_modules')).slice(0, MAX_FILES);
  const out: LspDiagnostic[] = [];
  for (const file of targets) {
    for (const d of [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)]) {
      const mapped = toDiagnostic(root, d);
      if (mapped && mapped.severity === 'error') {
        out.push(mapped);
        if (out.length >= MAX_DIAGNOSTICS) return out;
      }
    }
  }
  return out;
}

interface LspLocation {
  file: string;
  line: number;
  character: number;
}

function toLocation(root: string, def: ts.DefinitionInfo | ts.ReferenceEntry | ts.DocumentSpan): LspLocation {
  const abs = (def as ts.DefinitionInfo).fileName ?? (def as ts.ReferenceEntry).fileName ?? (def as ts.DocumentSpan).fileName;
  const span = (def as ts.DefinitionInfo).textSpan ?? (def as ts.ReferenceEntry).textSpan ?? (def as ts.DocumentSpan).textSpan;
  const { service } = getService(root);
  const program = service.getProgram();
  const source = program?.getSourceFile(abs);
  if (!source) return { file: path.relative(root, abs), line: 1, character: 1 };
  const pos = ts.getLineAndCharacterOfPosition(source, span.start);
  return { file: path.relative(root, abs) || abs, line: pos.line + 1, character: pos.character + 1 };
}

function offsetAt(root: string, abs: string, line: number, character: number): number {
  const { service } = getService(root);
  const program = service.getProgram();
  const source = program?.getSourceFile(abs);
  if (!source) throw new Error(`Refused: ${abs.slice(0, 120)} is not part of the program.`);
  return ts.getPositionOfLineAndCharacter(source, line - 1, character - 1);
}

const repoProp: ToolParameterSchema = { type: 'string', description: 'Repository root directory (absolute path).' };
const fileProp: ToolParameterSchema = { type: 'string', description: 'Repo-relative TypeScript file.' };
const lineProp: ToolParameterSchema = { type: 'number', description: '1-based line number.' };
const charProp: ToolParameterSchema = { type: 'number', description: '1-based character offset.' };

function readLspTool(id: string, name: string, description: string, properties: Record<string, ToolParameterSchema>, required: string[]): ToolDescriptor {
  return {
    id, name, description, version: '1.0.0', domain: 'code-intelligence', risk: 'read',
    available: true,
    inputSchema: { type: 'object', properties, required },
    capabilities: ['code-intelligence', 'typescript'],
    supportedResourceKinds: [],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'lsp.native',
  };
}

export const lspDiagnosticsTool = readLspTool(
  'lsp.diagnostics', 'TypeScript diagnostics',
  'Reports TypeScript compiler errors with codes, messages, and positions. Use to find type errors eslint cannot see.',
  { repoPath: repoProp, file: { type: 'string', description: 'Optional repo-relative file; omit for program-wide errors (capped).' } },
  ['repoPath'],
);
lspDiagnosticsTool.risk = 'diagnostic';

export const lspDefinitionTool = readLspTool(
  'lsp.definition', 'Go to definition',
  'Finds where a symbol at a position is defined, across files. Use to trace calls to their declarations.',
  { repoPath: repoProp, file: fileProp, line: lineProp, character: charProp },
  ['repoPath', 'file', 'line', 'character'],
);

export const lspReferencesTool = readLspTool(
  'lsp.references', 'Find references',
  'Finds all references to the symbol at a position. Use to assess impact before changing shared code.',
  { repoPath: repoProp, file: fileProp, line: lineProp, character: charProp },
  ['repoPath', 'file', 'line', 'character'],
);

export const lspHoverTool = readLspTool(
  'lsp.hover', 'Hover type info',
  'Shows the type of a variable and documentation for the symbol at a position. Use to understand unfamiliar code.',
  { repoPath: repoProp, file: fileProp, line: lineProp, character: charProp },
  ['repoPath', 'file', 'line', 'character'],
);

export const lspSymbolsTool = readLspTool(
  'lsp.symbols', 'Document symbols',
  'Lists functions, classes, interfaces, and variables in a file with positions. Use to map unfamiliar files.',
  { repoPath: repoProp, file: fileProp },
  ['repoPath', 'file'],
);

export const lspDiagnosticsImplementation: ToolImplementation = {
  toolId: lspDiagnosticsTool.id,
  async execute({ action }) {
    try {
      const input = action.input as Record<string, unknown>;
      const root = checkRepoRoot(input.repoPath);
      const file = typeof input.file === 'string' && input.file.trim() ? checkRelFile(input.file) : undefined;
      const diagnostics = collectDiagnostics(root, file);
      const output = { ok: true, root, file: file ?? null, count: diagnostics.length, diagnostics, capturedAt: new Date().toISOString() };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'lsp.native',
          subject: file ?? root,
          summary: `${diagnostics.length} TypeScript error(s)${file ? ` in ${file}` : ''}.`,
          data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const lspDefinitionImplementation: ToolImplementation = {
  toolId: lspDefinitionTool.id,
  async execute({ action }) {
    try {
      const input = action.input as Record<string, unknown>;
      const root = checkRepoRoot(input.repoPath);
      const abs = absFile(root, String(input.file ?? ''));
      const { line, character } = checkPosition(input.line, input.character);
      const { service } = getService(root);
      const defs = (service.getDefinitionAtPosition(abs, offsetAt(root, abs, line, character)) ?? []).slice(0, MAX_LOCATIONS);
      const locations = defs.map(d => toLocation(root, d));
      const output = { ok: true, definitions: locations, capturedAt: new Date().toISOString() };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'lsp.native', subject: abs,
          summary: `${locations.length} definition(s) found.`,
          data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const lspReferencesImplementation: ToolImplementation = {
  toolId: lspReferencesTool.id,
  async execute({ action }) {
    try {
      const input = action.input as Record<string, unknown>;
      const root = checkRepoRoot(input.repoPath);
      const abs = absFile(root, String(input.file ?? ''));
      const { line, character } = checkPosition(input.line, input.character);
      const { service } = getService(root);
      const refs = (service.getReferencesAtPosition(abs, offsetAt(root, abs, line, character)) ?? []).slice(0, MAX_LOCATIONS);
      const locations = refs.map(r => toLocation(root, r));
      const output = { ok: true, count: locations.length, references: locations, capturedAt: new Date().toISOString() };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'lsp.native', subject: abs,
          summary: `${locations.length} reference(s) found.`,
          data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const lspHoverImplementation: ToolImplementation = {
  toolId: lspHoverTool.id,
  async execute({ action }) {
    try {
      const input = action.input as Record<string, unknown>;
      const root = checkRepoRoot(input.repoPath);
      const abs = absFile(root, String(input.file ?? ''));
      const { line, character } = checkPosition(input.line, input.character);
      const { service } = getService(root);
      const info = service.getQuickInfoAtPosition(abs, offsetAt(root, abs, line, character));
      if (!info) return { output: failOutput('No type information at that position.') };
      const display = ts.displayPartsToString(info.displayParts);
      const docs = ts.displayPartsToString(info.documentation);
      const output = { ok: true, display: display.slice(0, 1000), documentation: docs.slice(0, 1000), capturedAt: new Date().toISOString() };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'lsp.native', subject: abs,
          summary: `Hover: ${display.slice(0, 160)}`,
          data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const lspSymbolsImplementation: ToolImplementation = {
  toolId: lspSymbolsTool.id,
  async execute({ action }) {
    try {
      const input = action.input as Record<string, unknown>;
      const root = checkRepoRoot(input.repoPath);
      const abs = absFile(root, String(input.file ?? ''));
      const { service } = getService(root);
      const tree = service.getNavigationTree(abs);
      const symbols: Array<{ name: string; kind: string; line: number; character: number }> = [];
      const program = service.getProgram();
      const source = program?.getSourceFile(abs);
      const walk = (items: ts.NavigationTree[]): void => {
        for (const item of items) {
          if (symbols.length >= 200) return;
          if (item.spans.length > 0 && source) {
            const pos = ts.getLineAndCharacterOfPosition(source, item.spans[0].start);
            symbols.push({ name: item.text, kind: item.kind, line: pos.line + 1, character: pos.character + 1 });
          }
          if (item.childItems) walk(item.childItems);
        }
      };
      walk([tree]);
      const output = { ok: true, file: path.relative(root, abs), count: symbols.length, symbols, capturedAt: new Date().toISOString() };
      return {
        output,
        observations: [{
          id: `observation-${Date.now()}`, kind: 'output' as const, source: 'lsp.native', subject: abs,
          summary: `${symbols.length} symbol(s) in ${path.relative(root, abs)}.`,
          data: output, confidence: 1, observedAt: output.capturedAt, relatedResourceIds: [],
        }],
      };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const lspTools: ToolDescriptor[] = [
  lspDiagnosticsTool, lspDefinitionTool, lspReferencesTool, lspHoverTool, lspSymbolsTool,
];
export const lspImplementations: ToolImplementation[] = [
  lspDiagnosticsImplementation, lspDefinitionImplementation, lspReferencesImplementation,
  lspHoverImplementation, lspSymbolsImplementation,
];

export const lspDiscoveryProvider: DiscoveryProvider = {
  id: 'lsp.native',
  name: 'TypeScript language provider',
  description: 'TypeScript diagnostics, definitions, references, hover types, and symbols from the compiler.',
  priority: 80,
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async discoverResources(): Promise<never[]> {
    return [];
  },
  async discoverTools(): Promise<ToolDescriptor[]> {
    return lspTools;
  },
};
