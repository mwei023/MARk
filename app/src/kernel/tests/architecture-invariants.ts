import assert from 'node:assert/strict';

import { MARKKernel } from '../index';
import { registerNativeSystemProvider } from '../providers/register-native';

/**
 * Standing architecture invariants: the rules MARK itself works by,
 * checked mechanically on every run. A violation here means someone
 * (human or agent) reintroduced a hardcoded shortcut.
 */
async function main(): Promise<void> {
  const kernel = new MARKKernel();
  registerNativeSystemProvider(kernel);
  await kernel.discover();

  const tools = kernel.listTools();
  const real = tools.filter(tool => !tool.id.startsWith('test.'));
  assert.ok(real.length > 10, 'a real discovery run should yield dozens of tools');

  // 1. Every tool declares an output contract (or it cannot be verified).
  const schemaless = real.filter(tool => !tool.outputSchema);
  assert.deepEqual(
    schemaless.map(tool => tool.id),
    [],
    `tools without outputSchema: ${schemaless.map(tool => tool.id).join(', ')}`,
  );

  // 2. No goal-phrase stuffing in any descriptor text.
  for (const tool of real) {
    for (const text of [tool.name, tool.description, ...(tool.capabilities ?? [])]) {
      assert.ok(
        !/goals like|for goals|use for goals|when the user (says|asks|wants)/i.test(text),
        `phrase stuffing in ${tool.id}: "${text}"`,
      );
    }
  }

  // 3. Descriptor ids are unique (per-instance generators must not collide).
  const ids = real.map(tool => tool.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate tool ids discovered');

  // 4. Every discovered tool id resolves to an implementation, exactly or
  // through a registered family prefix (no dead catalog entries).
  const dead = real.filter(tool => !kernel.executor.hasImplementation(tool.id));
  assert.deepEqual(
    dead.map(tool => tool.id),
    [],
    `tools without implementations: ${dead.map(tool => tool.id).join(', ')}`,
  );

  // 5. Writes are never auto-savable: file_write must stay mutating so the
  // runtime's read-only memory guard keeps excluding it.
  const fileWrite = real.find(tool => tool.id === 'fs.file_write');
  assert.ok(fileWrite, 'fs.file_write must exist');
  assert.equal(fileWrite.risk, 'mutating');

  console.log(`PASS: architecture invariants (${real.length} tools checked)`);
}

main().catch(error => {
  console.error('FAIL: architecture invariants');
  console.error(error);
  process.exitCode = 1;
});
