import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  kbNoteWriteImplementation,
  kbNoteReadImplementation,
  kbNoteListImplementation,
  kbNoteSearchImplementation,
  kbTools,
} from './providers/kb.js';

const OLD_VAULT = process.env.MARK_VAULT_PATH;
let work = '';

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'mark-kb-'));
  process.env.MARK_VAULT_PATH = join(work, 'vault');
});

afterEach(() => {
  if (OLD_VAULT === undefined) delete process.env.MARK_VAULT_PATH;
  else process.env.MARK_VAULT_PATH = OLD_VAULT;
  rmSync(work, { recursive: true, force: true });
});

const ctx = { workingDirectory: '/tmp', userId: 'test', source: 'system' } as any;
const act = (toolId: string, input: Record<string, unknown>) =>
  ({ id: 'ACT-test', toolId, input, requestedBy: 'test', createdAt: new Date().toISOString() }) as any;
const run = (impl: any, input: Record<string, unknown>) =>
  impl.execute({ action: act(impl.toolId, input), context: ctx }) as Promise<any>;

describe('kb vault provider', () => {
  it('exposes write/read/list/search with mutating writes', () => {
    expect(kbTools.map(t => t.id)).toEqual(['kb.note_write', 'kb.note_read', 'kb.note_list', 'kb.note_search']);
    expect(kbTools.find(t => t.id === 'kb.note_write')?.risk).toBe('mutating');
    expect(kbTools.filter(t => t.risk === 'read')).toHaveLength(3);
  });

  it('round-trips write/read/list/search end to end', async () => {
    await run(kbNoteWriteImplementation, { name: 'runbook', content: '# Deploy runbook\nRestart jarvis-db on failure.\n' });
    await run(kbNoteWriteImplementation, { name: 'groceries', content: 'oats, honey\n' });
    const read: any = await run(kbNoteReadImplementation, { name: 'runbook' });
    expect(read.output.content).toContain('Restart jarvis-db');
    const list: any = await run(kbNoteListImplementation, {});
    expect(list.output.notes).toEqual(['groceries.md', 'runbook.md']);
    const search: any = await run(kbNoteSearchImplementation, { query: 'restart deploy failure' });
    expect(search.output.hits[0].note).toBe('runbook.md');
    expect(search.output.hits[0].snippet).toContain('Restart');
  });

  it('files unnamed notes under date + slug', async () => {
    const { output }: any = await run(kbNoteWriteImplementation, { content: 'Db password rotates monthly' });
    expect(output.name).toMatch(/^\d{4}-\d{2}-\d{2}-db-password-rotates-monthly\.md$/);
    const read: any = await run(kbNoteReadImplementation, { name: output.name });
    expect(read.output.content).toContain('Db password');
  });

  it('refuses escapes, empties, and silent overwrites', async () => {
    await expect(run(kbNoteWriteImplementation, { name: '../evil', content: 'x' })).rejects.toThrow(/invalid note name/);
    await expect(run(kbNoteWriteImplementation, { name: 'ok', content: '   ' })).rejects.toThrow(/empty/);
    await run(kbNoteWriteImplementation, { name: 'once', content: 'v1' });
    await expect(run(kbNoteWriteImplementation, { name: 'once', content: 'v2' })).rejects.toThrow(/overwrite/);
    await run(kbNoteWriteImplementation, { name: 'once', content: 'v2', overwrite: true });
    await expect(run(kbNoteReadImplementation, { name: 'missing' })).rejects.toThrow(/not found/);
    await expect(run(kbNoteSearchImplementation, { query: '' })).rejects.toThrow(/empty/);
  });
});
