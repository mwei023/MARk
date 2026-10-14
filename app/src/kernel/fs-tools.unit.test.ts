import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fsDirectoryCreateImplementation,
  fsFileWriteImplementation,
} from './providers/system-tools.js';

const ctx = (workingDirectory: string) =>
  ({ workingDirectory, userId: 'test', source: 'system' }) as any;
const act = (toolId: string, input: Record<string, unknown>) =>
  ({ id: 'ACT-test', toolId, input, requestedBy: 'test', createdAt: new Date().toISOString() }) as any;

describe('fs.directory_create recursive', () => {
  it('creates nested parents and reports created:false when it exists', async () => {
    const work = mkdtempSync(join(tmpdir(), 'mark-fs-'));
    try {
      const nested = 'a/b/c';
      const first: any = await fsDirectoryCreateImplementation.execute({
        action: act('fs.directory_create', { path: nested }), context: ctx(work),
      });
      expect(first.output.created).toBe(true);
      expect(statSync(join(work, nested)).isDirectory()).toBe(true);
      const second: any = await fsDirectoryCreateImplementation.execute({
        action: act('fs.directory_create', { path: nested }), context: ctx(work),
      });
      expect(second.output.created).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('still refuses jail escapes', async () => {
    const work = mkdtempSync(join(tmpdir(), 'mark-fs-'));
    try {
      await expect(fsDirectoryCreateImplementation.execute({
        action: act('fs.directory_create', { path: '../../evil' }), context: ctx(work),
      } as any)).rejects.toThrow(/escapes/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('fs.file_write append', () => {
  it('appends without overwrite flag and verifies byte math', async () => {
    const work = mkdtempSync(join(tmpdir(), 'mark-fs-'));
    try {
      const run = (input: Record<string, unknown>) =>
        fsFileWriteImplementation.execute({ action: act('fs.file_write', input), context: ctx(work) } as any) as any;
      await run({ path: 'log.txt', content: 'one\n' });
      const appended: any = await run({ path: 'log.txt', content: 'two\n' , append: true });
      expect(appended.output.appended).toBe(true);
      expect(appended.output.overwritten).toBe(false);
      expect(readFileSync(join(work, 'log.txt'), 'utf8')).toBe('one\ntwo\n');
      const impl: any = fsFileWriteImplementation;
      const check = await impl.verify({ output: appended.output });
      expect(check.ok).toBe(true);
      // plain write without overwrite still refused
      await expect(run({ path: 'log.txt', content: 'x' })).rejects.toThrow(/overwrite/);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
