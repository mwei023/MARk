/**
 * Project index + project-reference routing. Hermetic: MARK_REPO_ROOTS
 * points at a scratch tree (institution-os-like git dir, portfolio-like
 * dir, Music-like plain dir), so no test depends on the real $HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway, isProjectReference } from './gateway.js';
import { SystemAgent } from '../agents/system-agent.js';
import {
  normalizeProjectName, hasProjectWord, findProjectDirs,
  rankedProjectDirs, spacedMention, clearProjectCache,
} from './project-index.js';

let root = '';

function mk(name: string, markers: string[] = []): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const m of markers) {
    if (m === '.git') mkdirSync(join(dir, '.git'));
    else writeFileSync(join(dir, m), '{}');
  }
  return dir;
}

beforeEach(() => {
  root = join(tmpdir(), `mark-proj-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mk('institution-os', ['.git']);
  mk('MyPortfolio', ['package.json', 'index.html']);
  mk('Music');
  process.env.MARK_REPO_ROOTS = root;
  clearProjectCache();
});

afterEach(() => {
  delete process.env.MARK_REPO_ROOTS;
  clearProjectCache();
  rmSync(root, { recursive: true, force: true });
});

const classify = (command: string) =>
  new Gateway().classify({
    id: 'e', timestamp: new Date(), source: 'user_command',
    type: 'user.command.received', severity: 'info', data: { command },
  } as any) as { path: string; agent?: string };

describe('project-index', () => {
  it('normalizes separators away', () => {
    expect(normalizeProjectName('institution OS')).toBe('institutionos');
    expect(normalizeProjectName('institution-os')).toBe('institutionos');
    expect(normalizeProjectName('My_Portfolio')).toBe('myportfolio');
  });

  it('finds OS-named checkouts while Music stays invisible without project words', () => {
    expect(findProjectDirs('check on institution OS').map(d => d.name)).toContain('institution-os');
    expect(findProjectDirs('play some music')).toEqual([]);
    expect(findProjectDirs('my portfolio').map(d => d.name)).toContain('MyPortfolio');
  });

  it('ranks exact spaced mentions above bare substrings', () => {
    mk('peter-mwei-portfolio', ['package.json']);
    clearProjectCache();
    const ranked = rankedProjectDirs('check on my portfolio');
    expect(ranked[0].name).toBe('MyPortfolio');
    expect(spacedMention('check on my portfolio', 'MyPortfolio')).toBe(true);
    expect(spacedMention('check on my portfolio', 'peter-mwei-portfolio')).toBe(false);
    expect(spacedMention('play some music', 'Music')).toBe(true);
  });

  it('hasProjectWord covers portfolio/project/repo forms', () => {
    expect(hasProjectWord('my portfolio')).toBe(true);
    expect(hasProjectWord('deploy the project')).toBe(true);
    expect(hasProjectWord('check disk usage')).toBe(false);
  });
});

describe('project-reference routing', () => {
  it('OS-named projects reach git-agent, not SystemAgent', () => {
    for (const cmd of [
      'can you check on institution OS and tell me if its ready to pilot',
      'check on my portfolio',
      'is the portfolio ready',
    ]) {
      const d = classify(cmd);
      expect(d.path).toBe('agent');
      expect(d.agent).toBe('git-agent');
    }
  });

  it('specialist verbs keep priority over project words', () => {
    expect(classify('deploy the project to staging').agent).toBe('devops-agent');
    expect(classify('repair the project lint errors').agent).toBe('code-agent');
  });

  it('machine inspection is untouched', () => {
    expect(classify('is postgres running').agent).toBe('system-agent');
    expect(classify('what is running?').agent).toBe('system-agent');
    expect(classify('play some music').agent).not.toBe('git-agent');
  });

  it('isProjectReference mirrors the routing', () => {
    expect(isProjectReference('check on institution OS')).toBe(true);
    expect(isProjectReference('my portfolio')).toBe(true);
    expect(isProjectReference('play some music')).toBe(false);
    expect(isProjectReference('is postgres running')).toBe(false);
  });

  it('SystemAgent refuses project references (AgentRuntime backstop)', () => {
    expect(SystemAgent.isSystemCommand('check on institution OS project')).toBe(false);
    expect(SystemAgent.isSystemCommand('my portfolio status')).toBe(false);
    expect(SystemAgent.isSystemCommand('is postgres running')).toBe(true);
    expect(SystemAgent.isSystemCommand('what is running?')).toBe(true);
  });
});
