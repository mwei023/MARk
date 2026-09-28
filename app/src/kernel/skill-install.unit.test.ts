import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityResolver } from './capability-resolver.js';
import { TaskBinder } from './task-binder.js';
import { ToolRegistry } from './tool-registry.js';
import { screenTools } from './providers/screen.js';
import {
  skillInstallTool,
  skillInstallImplementation,
  skillListImplementation,
  skillTools,
} from './providers/skill-install.js';

function resolverWithSkills() {
  const registry = new ToolRegistry();
  registry.registerMany([...skillTools, ...screenTools]);
  return new CapabilityResolver({ toolRegistry: registry });
}

const ctx = (workingDirectory: string) =>
  ({ workingDirectory, userId: 'test', source: 'system' }) as any;
const act = (toolId: string, input: Record<string, unknown>) =>
  ({ id: 'ACT-test', toolId, input, requestedBy: 'test', createdAt: new Date().toISOString() }) as any;

describe('skill.install descriptor', () => {
  it('declares repo+skill required and gates on confirmation, never deny', () => {
    expect(skillInstallTool.id).toBe('skill.install');
    expect(skillInstallTool.inputSchema.required).toEqual(['repo', 'skill']);
    expect(skillInstallTool.risk).toBe('reversible');
  });

  it('outranks screen.type on install-skill goals (the observed live miss)', () => {
    const r = resolverWithSkills();
    for (const goal of [
      'install the typesafe skill',
      'install skill with repo: typesafe-ai/skills skill: typesafe-ai',
      'add the typesafe-ai skill from typesafe-ai/skills',
      'install the typesafe-ai plugin',
    ]) {
      expect(r.resolve(goal).tool?.id).toBe('skill.install');
    }
  });

  it('leaves non-skill installs and typing alone', () => {
    const r = resolverWithSkills();
    // Mini-registry idf differs from the full catalog, so assert the
    // property that matters: skill tools never claim these goals. The
    // full-catalog winners (toolchain, screen.type) are covered by the
    // resolution golden run.
    for (const goal of ['install dependencies with npm', 'type hello world']) {
      const got = r.resolve(goal).tool?.id;
      expect(got).not.toBe('skill.install');
      expect(got).not.toBe('skill.list');
    }
  });

  it('ranks above screen.type on install goals', () => {
    const r = resolverWithSkills();
    const ranked = r.resolveAll('install the typesafe skill').map(c => c.tool.id);
    expect(ranked).toContain('skill.install');
    expect(ranked.indexOf('skill.install')).toBeLessThan(
      ranked.includes('screen.type') ? ranked.indexOf('screen.type') : ranked.length,
    );
  });

  it('binds explicit repo:/skill: values, stays incomplete on bare names', () => {
    const binder = new TaskBinder();
    const full = binder.bind('install skill with repo: typesafe-ai/skills skill: typesafe-ai', skillInstallTool);
    expect(full.complete).toBe(true);
    expect(full.input.repo).toBe('typesafe-ai/skills');
    expect(full.input.skill).toBe('typesafe-ai');
    const bare = binder.bind('install the typesafe skill', skillInstallTool);
    expect(bare.complete).toBe(false);
    expect(bare.missingRequired).toEqual(expect.arrayContaining(['repo', 'skill']));
  });
});

describe('skill.install validation (offline)', () => {
  const work = join(tmpdir(), `mark-skill-test-${Date.now()}`);
  const run = (input: Record<string, unknown>) =>
    skillInstallImplementation.execute({ action: act('skill.install', input), context: ctx(work) } as any);

  it('refuses malformed repo, skill, and jail escapes without network', async () => {
    for (const input of [
      { repo: 'not-a-repo', skill: 'x' },
      { repo: 'a/b/c', skill: 'x' },
      { repo: 'typesafe-ai/skills', skill: '../evil' },
      { repo: 'typesafe-ai/skills', skill: 'x', dest: '../../evil' },
    ]) {
      const { output } = await run(input) as any;
      expect(output.ok).toBe(false);
    }
  });
});

describe('skill.list routing + behavior', () => {
  it('gates skill.list out of install orders (reliability-proof: absent beats any tiebreak)', () => {
    const r = resolverWithSkills();
    for (const goal of ['install the typesafe skill', 'install the typesafe-ai plugin']) {
      const ids = r.resolveAll(goal).map(c => c.tool.id);
      expect(ids[0]).toBe('skill.install');
      expect(ids).not.toContain('skill.list');
    }
  });

  it('keeps skill.list a live candidate on list-questions (arbitration fallback executes it)', () => {
    // Full-catalog idf ranks skill.list first here (verified in the live
    // resolution golden run); the mini-registry asserts the structural
    // part: skill.list gates in with 2+ matches, so the candidate loop
    // can fall back to it when the installer cannot bind.
    const r = resolverWithSkills();
    for (const goal of ['what skills do you have installed', 'list my installed skills']) {
      const found = r.resolveAll(goal).find(c => c.tool.id === 'skill.list');
      expect(found).toBeDefined();
      expect(found!.matchedTerms.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('lists skills from a scratch working dir (offline)', async () => {
    const work = join(tmpdir(), `mark-skill-list-${Date.now()}`);
    mkdirSync(join(work, '.agents', 'skills', 'demo-skill'), { recursive: true });
    writeFileSync(
      join(work, '.agents', 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: >\n  A demo skill for tests.\n---\n\n# Demo\n',
    );
    try {
      const { output } = await skillListImplementation.execute({
        action: act('skill.list', {}), context: ctx(work),
      } as any) as any;
      expect(output.skills.map((s: any) => s.name)).toContain('demo-skill');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('reports empty when no skills directory exists', async () => {
    const work = join(tmpdir(), `mark-skill-empty-${Date.now()}-no-such`);
    const { output } = await skillListImplementation.execute({
      action: act('skill.list', {}), context: ctx(work),
    } as any) as any;
    expect(output.skills).toEqual([]);
  });
});

