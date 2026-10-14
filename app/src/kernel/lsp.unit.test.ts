import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lspDiagnosticsImplementation,
  lspDefinitionImplementation,
  lspReferencesImplementation,
  lspHoverImplementation,
  lspSymbolsImplementation,
  lspTools,
} from './providers/lsp.js';
import { CapabilityResolver } from './capability-resolver.js';
import { ToolRegistry } from './tool-registry.js';
import { screenTools } from './providers/screen.js';

const ROOT = join(tmpdir(), `mark-lsp-test-${Date.now()}`);

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"target":"ES2022"}}');
  writeFileSync(
    join(ROOT, 'a.ts'),
    'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n\nexport const answer: number = "not a number";\n\nexport function main() {\n  console.log(greet("world"));\n}\n',
  );
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const ctx = { workingDirectory: '/tmp', userId: 'test', source: 'system' } as any;
const act = (toolId: string, input: Record<string, unknown>) =>
  ({ id: 'ACT-test', toolId, input, requestedBy: 'test', createdAt: new Date().toISOString() }) as any;
const run = (impl: any, input: Record<string, unknown>) =>
  impl.execute({ action: act(impl.toolId, input), context: ctx }) as Promise<any>;

describe('lsp provider', () => {
  it('exposes 5 tools with diagnostic/read split', () => {
    expect(lspTools.map(t => t.id)).toEqual([
      'lsp.diagnostics', 'lsp.definition', 'lsp.references', 'lsp.hover', 'lsp.symbols',
    ]);
    expect(lspTools.find(t => t.id === 'lsp.diagnostics')?.risk).toBe('diagnostic');
  });

  it('finds the type error eslint cannot see', async () => {
    const { output }: any = await run(lspDiagnosticsImplementation, { repoPath: ROOT });
    expect(output.count).toBe(1);
    expect(output.diagnostics[0]).toMatchObject({ file: 'a.ts', line: 5, code: 2322 });
  });

  it('navigates definitions, references, hover, symbols', async () => {
    const def: any = await run(lspDefinitionImplementation, { repoPath: ROOT, file: 'a.ts', line: 8, character: 16 });
    expect(def.output.definitions).toContainEqual({ file: 'a.ts', line: 1, character: 17 });
    const refs: any = await run(lspReferencesImplementation, { repoPath: ROOT, file: 'a.ts', line: 1, character: 17 });
    expect(refs.output.count).toBe(2);
    const hover: any = await run(lspHoverImplementation, { repoPath: ROOT, file: 'a.ts', line: 8, character: 16 });
    expect(hover.output.display).toContain('greet(name: string): string');
    const syms: any = await run(lspSymbolsImplementation, { repoPath: ROOT, file: 'a.ts' });
    expect(syms.output.symbols.map((s: any) => s.name)).toContain('greet');
  });

  it('refuses escapes and bad positions without a compiler', async () => {    for (const [impl, input] of [
      [lspDiagnosticsImplementation, { repoPath: '/tmp/../evil' }],
      [lspDiagnosticsImplementation, { repoPath: '/no-such-dir-xyz' }],
      [lspHoverImplementation, { repoPath: ROOT, file: 'a.ts', line: 0, character: 1 }],
      [lspDefinitionImplementation, { repoPath: ROOT, file: '../../evil.ts', line: 1, character: 1 }],
    ] as const) {
      const { output } = await run(impl, input) as any;
      expect(output.ok).toBe(false);
    }
  });

  it('routes language goals to lsp tools (mini-registry)', () => {
    const registry = new ToolRegistry();
    registry.registerMany([...lspTools, ...screenTools]);
    const r = new CapabilityResolver({ toolRegistry: registry });
    const cases: Array<[string, string]> = [
      ['find type errors in the repo', 'lsp.diagnostics'],
      ['go to the definition of login', 'lsp.definition'],
      ['show all references to connect', 'lsp.references'],
      ['what type is this variable', 'lsp.hover'],
      ['list the symbols in gateway', 'lsp.symbols'],
    ];
    for (const [goal, want] of cases) {
      expect(r.resolve(goal).tool?.id).toBe(want);
    }
  });
});
