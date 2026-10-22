import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectLspDiagnostics, repairOneError } from './code-repair.js';
import type { RepairRunContext } from './code-repair.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MARK code repair self-test', () => {
  it('detects, repairs, verifies, and keeps a TypeScript fix', async () => {
    // Keep the fixture below app/ so its existing TypeScript installation is
    // available to the repair loop's bounded `npx --no-install tsc` gate.
    const root = mkdtempSync(join(process.cwd(), '.mark-repair-self-test-'));
    roots.push(root);
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'CommonJS' },
      include: ['broken.ts'],
    }));
    writeFileSync(join(root, 'broken.ts'), 'export const answer: number = "not a number";\n');

    const before = await collectLspDiagnostics(root);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ file: 'broken.ts', ruleId: 'TS2322' });

    const live = process.env.MARK_LIVE_REPAIR === 'true';
    const originalFetch = globalThis.fetch;
    if (!live) {
      globalThis.fetch = async () => new Response(JSON.stringify({
        message: { content: '1|export const answer: number = 42;' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    try {
      const ctx: RepairRunContext = { cloudCalls: 0, maxCloudCalls: 0 };
      const outcome = await repairOneError(root, {
        file: 'broken.ts',
        line: 1,
        column: 14,
        ruleId: 'TS2322',
        message: 'Type string is not assignable to type number',
      }, { ctx, llmTimeoutMs: live ? 60000 : 2000 });

      if (live && !outcome.fixed) console.error('[live repair outcome]', outcome);
      expect(outcome).toMatchObject({ fixed: true, via: 'local' });
      const repaired = readFileSync(join(root, 'broken.ts'), 'utf8');
      expect(repaired).not.toContain('not a number');
      expect(repaired).toMatch(/answer: number = \d+;/);
      expect(await collectLspDiagnostics(root)).toHaveLength(0);
      expect(existsSync(join(root, 'broken.ts'))).toBe(true);
    } finally {
      if (!live) globalThis.fetch = originalFetch;
    }
  }, process.env.MARK_LIVE_REPAIR === 'true' ? 180000 : 30000);
});
