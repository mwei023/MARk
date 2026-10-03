import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Gateway } from '../core/gateway.js';
import { GitAgent } from './git-agent.js';

const gw = new Gateway();
const mk = (command: string) =>
  ({
    id: 'e',
    timestamp: new Date(),
    source: 'user_command',
    type: 'user.command.received',
    severity: 'info',
    data: { command },
  }) as any;

const git = (args: string[], cwd?: string) =>
  execFileSync('git', args, { cwd, timeout: 30000 }).toString();

/** Scratch repo with a local bare remote as origin. */
function scratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'mark-git-commit-push-'));
  git(['init', '--bare', join(dir, 'remote.git')]);
  git(['clone', join(dir, 'remote.git'), join(dir, 'work')]);
  const work = join(dir, 'work');
  git(['-C', work, 'config', 'user.email', 'mark-test@example.com']);
  git(['-C', work, 'config', 'user.name', 'mark-test']);
  writeFileSync(join(work, 'seed.txt'), 'seed\n');
  git(['-C', work, 'add', '-A']);
  git(['-C', work, 'commit', '-qm', 'seed']);
  git(['-C', work, 'push', '-qu', 'origin', 'HEAD:main']);
  return { dir, work };
}

describe('commit+push order', () => {
  it('routes "commit and push" to git-agent, not the status snapshot', () => {
    const d = gw.classify(mk('commit and push /tmp/some-repo')) as { path: string; agent?: string };
    expect(d.path).toBe('agent');
    expect(d.agent).toBe('git-agent');
  });

  it('extracts -m / message forms, defaults otherwise', () => {
    expect(GitAgent.extractCommitMessage('commit and push with -m "ship it"')).toBe('ship it');
    expect(GitAgent.extractCommitMessage('commit and push message \'wip save\'')).toBe('wip save');
    expect(GitAgent.extractCommitMessage('commit and push everything now')).toBeNull();
  });

  it('commits a dirty tree and pushes the branch to origin', async () => {
    const { work } = scratchRepo();
    writeFileSync(join(work, 'change.txt'), 'new work\n');
    const agent = new GitAgent();
    const res = await agent.handleCommand(mk(`commit and push ${work} with -m "mark test commit"`), {} as any);
    expect(res).toMatch(/Committed .* and pushed .* to origin/);
    expect(git(['-C', work, 'log', '--oneline', '-1'])).toMatch(/mark test commit/);
    expect(git(['-C', work, 'status', '--porcelain'])).toBe('');
    // The bare remote actually received the commit.
    expect(git(['--git-dir', join(work, '../remote.git'), 'log', '--oneline', '-1'])).toMatch(/mark test commit/);
  });

  it('reports a clean tree without committing', async () => {
    const { work } = scratchRepo();
    const agent = new GitAgent();
    const res = await agent.handleCommand(mk(`commit and push ${work}`), {} as any);
    expect(res).toMatch(/nothing to commit/i);
  });

  it('asks which repo when none is named (never guesses)', async () => {
    const agent = new GitAgent();
    const res = await agent.handleCommand(mk('commit and push'), {} as any);
    expect(res).toMatch(/Which repository\?/);
  });
});
