import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(join(here, name), 'utf8');

describe('centralised env loading (config.ts)', () => {
  it('loads .env files before snapshotting process.env', () => {
    const source = read('config.ts');
    const loadAt = source.indexOf('dotenv.config');
    const snapshotAt = source.indexOf('export const config');
    expect(loadAt).toBeGreaterThanOrEqual(0);
    expect(snapshotAt).toBeGreaterThan(loadAt);
    // dotenv must never override real shell exports.
    expect(source).not.toContain('override: true');
  });

  it('no entry point runs its own dotenv loop anymore (one owner)', () => {
    for (const entry of ['api/server-v2.ts', 'repl.ts', 'cli.ts', 'tui.ts']) {
      expect(read(entry)).not.toContain('dotenv.config');
    }
  });
});
