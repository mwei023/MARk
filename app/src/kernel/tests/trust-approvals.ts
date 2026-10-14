import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MARKKernel, TrustStore } from '../index';
import { registerNativeSystemProvider } from '../providers/register-native';

/**
 * Standing trust + forgiving approval: gated tools run without asking once
 * trusted (persisted across restarts), denials are never trustable, and
 * approvals resolve action ids, prefixes, and tool words — not just exact
 * confirmation ids.
 */
async function main(): Promise<void> {
  const trustFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'mark-trust-')), 'trust.json');
  const kernel = new MARKKernel({ trustStore: new TrustStore(trustFile) });
  registerNativeSystemProvider(kernel);
  await kernel.discover();

  const jail = await fs.mkdtemp(path.join(os.tmpdir(), 'mark-trust-jail-'));
  const context = kernel.createContext({
    userId: 'trust-test',
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
    reason: 'Trust test.',
    createdAt: new Date().toISOString(),
  });

  try {
    // 1. Untrusted reversible tool pauses.
    const first = await kernel.execute(makeAction('fs.directory_create', { path: 'a' }, 'trust-mkdir-1'), context);
    assert.equal(first.status, 'blocked');
    const firstId = String((first.metadata as Record<string, unknown>)?.confirmationId ?? '');
    assert.ok(firstId);

    // 2. Trust by exact id: next identical action auto-runs.
    kernel.trustTool('fs.directory_create', 'trust-test');
    const trusted = await kernel.execute(makeAction('fs.directory_create', { path: 'b' }, 'trust-mkdir-2'), context);
    assert.equal(trusted.status, 'succeeded', `trusted run failed: ${trusted.error ?? ''}`);
    assert.ok(
      trusted.observations.some(o => o.summary.includes('Auto-approved')),
      'trusted runs must announce themselves in observations',
    );
    assert.ok((await fs.stat(path.join(jail, 'b'))).isDirectory());

    // 3. Trust persists across store instances (simulated restart).
    const reloaded = new TrustStore(trustFile);
    assert.ok(reloaded.isTrusted('fs.directory_create'), 'grant must survive reload');

    // 4. Prefix trusts families; untrust revokes.
    kernel.trustTool('fs.', 'trust-test');
    assert.ok(kernel.executor.listTrustedTools().length >= 1);
    assert.equal(kernel.untrustTool('fs.'), true);
    assert.equal(kernel.untrustTool('fs.directory_create'), true);
    const asking = await kernel.execute(makeAction('fs.directory_create', { path: 'c' }, 'trust-mkdir-3'), context);
    assert.equal(asking.status, 'blocked', 'revoked trust must ask again');

    // 5. Denied risk levels are never trustable.
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
      provider: 'trust-test',
    } as never);
    kernel.registerImplementation({
      toolId: 'test.privileged_probe',
      async execute() {
        return { output: {}, observations: [] };
      },
    });
    kernel.trustTool('test.privileged_probe', 'trust-test');
    const denied = await kernel.execute(makeAction('test.privileged_probe', {}, 'trust-priv'), context);
    assert.equal(denied.status, 'blocked');
    assert.equal((denied.metadata as Record<string, unknown> | undefined)?.confirmationId, undefined);

    // 6. Forgiving lookup: action id, id prefix, tool words.
    const pending = kernel.listPendingConfirmations();
    assert.ok(pending.length >= 1);
    const target = pending.find(p => p.toolId === 'fs.directory_create') ?? pending[0];
    assert.ok(kernel.findConfirmation(target.actionId), 'must resolve by action id');
    assert.ok(
      kernel.findConfirmation(target.id.slice(0, target.id.length - 2)),
      'must resolve by id prefix when unambiguous',
    );
    assert.ok(
      kernel.searchPendingConfirmations('directory_create').some(p => p.id === target.id),
      'must resolve by tool words',
    );

    console.log('PASS: trust (auto-approve, persist, revoke, deny-proof, forgiving lookup)');
  } finally {
    await fs.rm(jail, { recursive: true, force: true });
    await fs.rm(path.dirname(trustFile), { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('FAIL: trust');
  console.error(error);
  process.exitCode = 1;
});
