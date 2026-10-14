import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MARKKernel } from '../index';
import { registerNativeSystemProvider } from '../providers/register-native';

async function main(): Promise<void> {
  const kernel = new MARKKernel();
  registerNativeSystemProvider(kernel);
  await kernel.discover();

  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'mark-search-'));
  await fs.writeFile(path.join(workdir, 'alpha.ts'), 'export const needle = 1;\n// nothing else\n');
  await fs.writeFile(path.join(workdir, 'beta.md'), 'haystack text\nneedle in docs\n');
  await fs.mkdir(path.join(workdir, 'node_modules'));
  await fs.writeFile(path.join(workdir, 'node_modules', 'dep.js'), 'needle in deps\n');

  const context = () =>
    kernel.createContext({ userId: 'search-test', authorityProfile: 'default', source: 'system', workingDirectory: workdir });

  // A. Finds matches, skips node_modules.
  const found = await kernel.execute(
    { id: 'search-1', toolId: 'fs.file_search', input: { pattern: 'needle' }, requestedBy: 'search-test', createdAt: new Date().toISOString() },
    context(),
  );
  assert.equal(found.status, 'succeeded');
  const files = ((found.output as any).matches as Array<{ file: string }>).map(m => m.file);
  assert.ok(files.some(f => f.endsWith('alpha.ts')));
  assert.ok(files.some(f => f.endsWith('beta.md')));
  assert.ok(!files.some(f => f.includes('node_modules')), 'must skip node_modules');
  console.log('PASS (A): finds matches across files, skips node_modules');

  // B. No matches is an empty success, not a failure.
  const empty = await kernel.execute(
    { id: 'search-2', toolId: 'fs.file_search', input: { pattern: 'xyzzy-no-such-string' }, requestedBy: 'search-test', createdAt: new Date().toISOString() },
    context(),
  );
  assert.equal(empty.status, 'succeeded');
  assert.equal((empty.output as any).count, 0);
  console.log('PASS (B): no matches returns empty success');

  // C. Include glob filters filenames; patterns are operands (spaces safe).
  await fs.writeFile(path.join(workdir, 'spaced note.txt'), 'hello brave world\n');
  const filtered = await kernel.execute(
    { id: 'search-3', toolId: 'fs.file_search', input: { pattern: 'hello brave world', include: '*.txt' }, requestedBy: 'search-test', createdAt: new Date().toISOString() },
    context(),
  );
  assert.equal(filtered.status, 'succeeded');
  assert.equal((filtered.output as any).count, 1);
  console.log('PASS (C): include glob filters; multi-word patterns safe');

  // D. Missing pattern is rejected, not executed.
  const bad = await kernel.execute(
    { id: 'search-4', toolId: 'fs.file_search', input: {}, requestedBy: 'search-test', createdAt: new Date().toISOString() },
    context(),
  );
  assert.equal(bad.status, 'failed');
  console.log('PASS (D): missing pattern rejected');

  await fs.rm(workdir, { recursive: true, force: true });
  console.log('PASS: search tests complete');
}

main().catch(error => {
  console.error('FAIL: search test');
  console.error(error);
  process.exitCode = 1;
});
