import { describe, it, expect, afterAll } from 'vitest';
import { rmSync, existsSync, writeFileSync } from 'node:fs';
import {
  gitDeployTools,
  gitDeployImplementations,
} from './providers/git-deploy.js';

const DIR = 'mark-test-deploy-tmp';

function impl(id: string) {
  const found = gitDeployImplementations.find(i => i.toolId === id);
  if (!found) throw new Error(`missing impl ${id}`);
  return found;
}

function ctx() {
  return { workingDirectory: process.cwd() } as any;
}

afterAll(() => {
  try {
    if (existsSync(`${process.cwd()}/${DIR}`)) rmSync(`${process.cwd()}/${DIR}`, { recursive: true, force: true });
  } catch { /* best-effort cleanup */ }
});

describe('git deploy actuators', () => {
  it('discovers init, commit, push, repo_create as mutating', () => {
    const ids = gitDeployTools.map(t => t.id);
    expect(ids).toEqual(['git.init', 'git.commit', 'git.push', 'gh.repo_create']);
    for (const t of gitDeployTools) expect(t.risk).toBe('mutating');
  });

  it('refuses paths escaping the working directory', async () => {
    await expect(impl('git.init').execute({ action: { input: { repoPath: '../escape' } }, context: ctx() } as any))
      .rejects.toThrow(/escapes/);
  });

  it('refuses invalid branch and repo names', async () => {
    await expect(impl('git.init').execute({ action: { input: { repoPath: DIR, branch: 'bad;rm' } }, context: ctx() } as any))
      .rejects.toThrow(/branch/);
    await expect(impl('gh.repo_create').execute({ action: { input: { repoPath: DIR, name: 'bad name!' } }, context: ctx() } as any))
      .rejects.toThrow();
  });

  it('init then commit works in a scratch repo', async () => {
    const init: any = (await impl('git.init').execute({ action: { input: { repoPath: DIR } }, context: ctx() } as any)).output;
    expect(init.ok).toBe(true);
    expect(init.branch).toBe('main');
    writeFileSync(`${process.cwd()}/${DIR}/index.html`, '<h1>hi</h1>');
    const commit: any = (await impl('git.commit').execute(
      { action: { input: { repoPath: DIR, message: 'first commit' } }, context: ctx() } as any,
    )).output;
    expect(commit.ok).toBe(true);
    expect(commit.sha).toBeTruthy();
  });

  it('commit refuses empty message and clean tree', async () => {
    await expect(impl('git.commit').execute({ action: { input: { repoPath: DIR, message: '   ' } }, context: ctx() } as any))
      .rejects.toThrow(/message/i);
    await expect(impl('git.commit').execute({ action: { input: { repoPath: DIR, message: 'nothing new' } }, context: ctx() } as any))
      .rejects.toThrow(/clean/);
  });
});
