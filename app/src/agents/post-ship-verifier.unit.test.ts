import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
});
