import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { verifyPostShip } from './post-ship-verifier.js';

const execFilePromise = promisify(execFile);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('post-ship verification', () => {
  it('uses local verification for non-GitHub remotes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mark-post-ship-'));
    const remote = `${root}-remote.git`;
    roots.push(root, remote);
    await execFilePromise('git', ['init', '-qb', 'main', root]);
    await execFilePromise('git', ['init', '--bare', remote]);
    await execFilePromise('git', ['-C', root, 'remote', 'add', 'origin', remote]);

    const result = await verifyPostShip(root, 'auto-fix/test', 'main');
    expect(result).toEqual({ status: 'skipped', detail: 'Origin is not GitHub; local verification gate passed.' });
  });

  it('leaves a queued GitHub branch intact when verification times out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mark-post-ship-'));
    const bin = mkdtempSync(join(tmpdir(), 'mark-post-ship-bin-'));
    roots.push(root, bin);
    await execFilePromise('git', ['init', '-qb', 'auto-fix/test', root]);
    await execFilePromise('git', ['-C', root, 'config', 'user.email', 'mark@test.local']);
    await execFilePromise('git', ['-C', root, 'config', 'user.name', 'MARK']);
    writeFileSync(join(root, 'README.md'), 'test\n');
    await execFilePromise('git', ['-C', root, 'add', 'README.md']);
    await execFilePromise('git', ['-C', root, 'commit', '-m', 'test']);
    await execFilePromise('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/example/repo.git']);
    const sha = (await execFilePromise('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
    const gh = join(bin, 'gh');
    writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' '[{"status":"queued","conclusion":null,"databaseId":123,"headSha":"${sha}","url":"https://github.com/example/repo/actions/runs/123"}]'\n`);
    chmodSync(gh, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    let result;
    try {
      result = await verifyPostShip(root, 'auto-fix/test', 'main', 20);
    } finally {
      process.env.PATH = previousPath;
    }

    expect(result.status).toBe('unverified');
    expect(result.detail).toContain('branch auto-fix/test was left intact');
    expect(result.detail).toContain('https://github.com/example/repo/actions/runs/123');
    expect((await execFilePromise('git', ['-C', root, 'branch', '--show-current'])).stdout.trim()).toBe('auto-fix/test');
    expect((await execFilePromise('git', ['-C', root, 'remote', '-v'])).stdout).toContain('github.com/example/repo');
  }, 10_000);
});
