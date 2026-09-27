import { describe, it, expect } from 'vitest';
import {
  repoSemanticTools,
  repoSemanticImplementations,
} from '../kernel/providers/repo-semantic.js';

const REPO = '/home/mwei/jarvis-core/app';

function impl(id: string) {
  const found = repoSemanticImplementations.find(i => i.toolId === id);
  if (!found) throw new Error(`missing impl ${id}`);
  return found;
}

describe('repo deep-understanding tools', () => {
  it('discovers symbols, impact, context_pack', () => {
    const ids = repoSemanticTools.map(t => t.id);
    expect(ids).toContain('repo.symbols');
    expect(ids).toContain('repo.impact');
    expect(ids).toContain('repo.context_pack');
  });

  it('repo.symbols extracts definitions from this file', async () => {
    const out: any = (await impl('repo.symbols').execute({
      action: { input: { repoPath: REPO, file: 'src/kernel/providers/repo-semantic.ts', limit: 20 } },
    } as any)).output;
    expect(out.ok).toBe(true);
    expect(out.count).toBeGreaterThan(3);
    expect(JSON.stringify(out.symbols)).toMatch(/repoMapTool|repoSearchTool/);
  });

  it('repo.symbols refuses path escape', async () => {
    const out: any = (await impl('repo.symbols').execute({
      action: { input: { repoPath: REPO, file: '../secret.ts' } },
    } as any)).output;
    expect(out.ok).toBe(false);
  });

  it('repo.impact finds callers of a known symbol', async () => {
    const out: any = (await impl('repo.impact').execute({
      action: { input: { repoPath: REPO, symbol: 'repoSemanticTools' } },
    } as any)).output;
    expect(out.ok).toBe(true);
    expect(out.fileCount).toBeGreaterThan(0);
    expect(JSON.stringify(out.files)).toMatch(/repo-semantic/);
  });

  it('repo.context_pack builds a budgeted pack', async () => {
    const out: any = (await impl('repo.context_pack').execute({
      action: { input: { repoPath: REPO, query: 'how does gateway classify github workflow failed', budgetChars: 8000 } },
    } as any)).output;
    expect(out.ok).toBe(true);
    expect(out.chars).toBeGreaterThan(200);
    expect(out.chars).toBeLessThanOrEqual(8000);
    expect(out.pack).toMatch(/Files|Hit:/);
  });

  it('all new tools fail closed on missing checkout', async () => {
    for (const id of ['repo.symbols', 'repo.impact', 'repo.context_pack']) {
      const out: any = (await impl(id).execute({
        action: { input: { repoPath: '/no/such/dir', query: 'x', symbol: 'x' } },
      } as any)).output;
      expect(out.ok).toBe(false);
    }
  });

  it('repo.semantic_search ranks files for a query', async () => {
    const out: any = (await impl('repo.semantic_search').execute({
      action: { input: { repoPath: REPO, query: 'gateway classify github workflow failed', limit: 5 } },
    } as any)).output;
    expect(out.ok).toBe(true);
    expect(out.mode).toBe('keyword');
    expect(out.count).toBeGreaterThan(0);
    expect(JSON.stringify(out.results)).toMatch(/github|git-agent|cicd/i);
  });

  it('repo.verify_patch reports a gate result', async () => {
    const out: any = (await impl('repo.verify_patch').execute({
      action: { input: { repoPath: REPO } },
    } as any)).output;
    expect(out.ok).toBe(true);
    expect(typeof out.passed).toBe('boolean');
    expect(typeof out.check).toBe('string');
  }, 180000);
});
