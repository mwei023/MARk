import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { collectLspDiagnostics, repairOneError } from '../agents/code-repair.js';
import type { RepairRunContext } from '../agents/code-repair.js';
import { CICDAgent } from '../agents/cicd-agent.js';
import { GitAgent } from '../agents/git-agent.js';

const execFilePromise = promisify(execFile);
const roots: string[] = [];

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise('git', ['-C', root, ...args], { timeout: 30000 });
  return stdout.trim();
}

async function gitDir(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise('git', ['--git-dir', dir, ...args], { timeout: 30000 });
  return stdout.trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MARK build and ship self-test', () => {
  it('repairs multiple errors, verifies the build, and ships a clean commit', async () => {
    const root = mkdtempSync(join(process.cwd(), '.mark-build-ship-self-test-'));
    const remote = `${root}-remote.git`;
    roots.push(root, remote);

    await execFilePromise('git', ['init', '--bare', remote], { timeout: 30000 });
    await execFilePromise('git', ['init', '-qb', 'main', root], { timeout: 30000 });
    await git(root, ['config', 'user.email', 'mark-test@example.com']);
    await git(root, ['config', 'user.name', 'mark-test']);
    await git(root, ['remote', 'add', 'origin', remote]);
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'mark-build-ship-fixture',
      private: true,
      scripts: { typecheck: 'tsc --noEmit -p tsconfig.json' },
    }));
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'CommonJS' },
      include: ['broken.ts'],
    }));
    writeFileSync(join(root, 'broken.ts'), [
      'export const answer: number = "not a number";',
      '',
      'export const count: number = "also not a number";',
      '',
    ].join('\n'));
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'seed broken fixture']);
    await git(root, ['push', '-qu', 'origin', 'HEAD:main']);

    const before = await collectLspDiagnostics(root);
    expect(before.filter(d => d.ruleId === 'TS2322')).toHaveLength(2);

    const live = process.env.MARK_LIVE_REPAIR === 'true';
    const originalFetch = globalThis.fetch;
    if (!live) {
      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> };
        const prompt = body.messages?.at(-1)?.content ?? '';
        const content = prompt.includes('error at line 1')
          ? '1|export const answer: number = 42;'
          : '3|export const count: number = 7;';
        return new Response(JSON.stringify({ message: { content } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
    }

    try {
      const ctx: RepairRunContext = { cloudCalls: 0, maxCloudCalls: 0 };
      for (const target of before.filter(d => d.ruleId === 'TS2322')) {
        const outcome = await repairOneError(root, target, { ctx, llmTimeoutMs: live ? 60000 : 2000 });
        expect(outcome).toMatchObject({ fixed: true, via: 'local' });
      }
    } finally {
      if (!live) globalThis.fetch = originalFetch;
    }

    expect(await collectLspDiagnostics(root)).toHaveLength(0);
    const repaired = readFileSync(join(root, 'broken.ts'), 'utf8');
    expect(repaired).toMatch(/answer: number = \d+;/);
    expect(repaired).toMatch(/count: number = \d+;/);

    const verify = await new CICDAgent().handleCommand({
      id: 'self-test',
      timestamp: new Date(),
      source: 'user_command',
      type: 'user.command.received',
      severity: 'info',
      data: { command: `verify the build in ${root}` },
    } as any, {} as any);
    expect(verify).toMatch(/PASS npm run typecheck/);
    expect(verify).toMatch(/All checks passed/);

    const shipped = await new GitAgent().handleCommand({
      id: 'self-test-ship',
      timestamp: new Date(),
      source: 'user_command',
      type: 'user.command.received',
      severity: 'info',
      data: { command: `commit and push ${root} with -m "mark verified repair"` },
    } as any, {} as any);
    expect(shipped).toMatch(/Committed .* and pushed .* to origin/);
    expect(await git(root, ['status', '--porcelain'])).toBe('');
    expect(await gitDir(remote, ['log', 'main', '--oneline', '-1'])).toMatch(/mark verified repair/);
  }, process.env.MARK_LIVE_REPAIR === 'true' ? 180000 : 60000);
});
