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

  const jail = await fs.mkdtemp(path.join(os.tmpdir(), 'mark-hands-'));
  const context = kernel.createContext({
    userId: 'hands-test',
    authorityProfile: 'workspace',
    source: 'system',
    workingDirectory: jail,
    metadata: {},
  });
  const makeAction = (toolId: string, input: Record<string, unknown>, id: string) => ({
    id,
    toolId,
    input,
    requestedBy: context.userId,
    reason: 'Hands test.',
    createdAt: new Date().toISOString(),
  });

  try {
    // 1. directory_create pauses for confirmation, then executes on approval.
    const mkdirAction = makeAction('fs.directory_create', { path: 'notes' }, 'hands-mkdir');
    const mkdirBlocked = await kernel.execute(mkdirAction, context);
    assert.equal(mkdirBlocked.status, 'blocked');
    const mkdirConfirmId = String((mkdirBlocked.metadata as Record<string, unknown>)?.confirmationId ?? '');
    assert.ok(mkdirConfirmId, 'blocked write must carry a confirmationId');

    assert.equal(kernel.listPendingConfirmations().length, 1);
    assert.ok(kernel.resolveConfirmation(mkdirConfirmId, true));

    const mkdirDone = await kernel.executeConfirmed(mkdirAction, context, mkdirConfirmId);
    assert.equal(mkdirDone.status, 'succeeded', `mkdir failed: ${mkdirDone.error ?? ''}`);
    assert.ok((await fs.stat(path.join(jail, 'notes'))).isDirectory());

    // 2. file_write pauses, writes on approval, and is readable back.
    const writeAction = makeAction(
      'fs.file_write',
      { path: 'notes/hello.txt', content: 'MARK hands work.\n' },
      'hands-write',
    );
    const writeBlocked = await kernel.execute(writeAction, context);
    assert.equal(writeBlocked.status, 'blocked');
    const writeConfirmId = String((writeBlocked.metadata as Record<string, unknown>)?.confirmationId ?? '');
    kernel.resolveConfirmation(writeConfirmId, true);
    const writeDone = await kernel.executeConfirmed(writeAction, context, writeConfirmId);
    assert.equal(writeDone.status, 'succeeded', `write failed: ${writeDone.error ?? ''}`);
    assert.match(await fs.readFile(path.join(jail, 'notes/hello.txt'), 'utf8'), /MARK hands work/);

    // 3. Denied confirmation stays blocked.
    const deniedAction = makeAction(
      'fs.file_write',
      { path: 'notes/nope.txt', content: 'should not land' },
      'hands-denied',
    );
    const deniedBlocked = await kernel.execute(deniedAction, context);
    const deniedId = String((deniedBlocked.metadata as Record<string, unknown>)?.confirmationId ?? '');
    kernel.resolveConfirmation(deniedId, false);
    const deniedRetry = await kernel.executeConfirmed(deniedAction, context, deniedId);
    assert.equal(deniedRetry.status, 'blocked');
    await assert.rejects(fs.stat(path.join(jail, 'notes/nope.txt')));

    // 4. Jail escape is refused even with a valid context.
    const escapeAction = makeAction('fs.file_write', { path: '../../escape.txt', content: 'x' }, 'hands-escape');
    const escapeBlocked = await kernel.execute(escapeAction, context);
    assert.equal(escapeBlocked.status, 'blocked');
    const escapeId = String((escapeBlocked.metadata as Record<string, unknown>)?.confirmationId ?? '');
    kernel.resolveConfirmation(escapeId, true);
    const escapeDone = await kernel.executeConfirmed(escapeAction, context, escapeId);
    assert.notEqual(escapeDone.status, 'succeeded', 'jail escape must fail');

    // 5. A denied risk level offers no confirmation at all.
    kernel.registerTool({
      id: 'test.privileged_probe',
      name: 'Privileged probe',
      description: 'Denied risk level.',
      version: '1.0.0',
      domain: 'testing',
      risk: 'privileged',
      available: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      capabilities: ['testing'],
      supportedResourceKinds: ['unknown'],
      requiredPermissions: [],
      reversible: false,
      metadata: {},
      provider: 'hands-test',
    } as never);
    kernel.registerImplementation({
      toolId: 'test.privileged_probe',
      async execute() {
        return { output: {}, observations: [] };
      },
    });
    const deniedRisk = await kernel.execute(
      makeAction('test.privileged_probe', {}, 'hands-priv'),
      context,
    );
    assert.equal(deniedRisk.status, 'blocked');
    assert.equal((deniedRisk.metadata as Record<string, unknown> | undefined)?.confirmationId, undefined);

    console.log('PASS: hands (confirm, write, deny, jail, denied-risk)');
  } finally {
    await fs.rm(jail, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('FAIL: hands');
  console.error(error);
  process.exitCode = 1;
});
