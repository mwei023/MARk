import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MARKKernel,
  ToolDescriptor,
  ToolImplementation,
} from '../index';
import { fsFileWriteImplementation } from '../providers/system-tools';
import { registerNativeSystemProvider } from '../providers/register-native';

async function main(): Promise<void> {
  const kernel = new MARKKernel();
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'mark-verify-'));

  const context = kernel.createContext({
    userId: 'verify-test',
    authorityProfile: 'default',
    source: 'system',
    workingDirectory: workdir,
  });

  // A. Claimed success with failing verify becomes failure.
  const lyingTool: ToolDescriptor = {
    id: 'test.liar',
    name: 'Liar tool',
    description: 'Claims success but fails verification.',
    version: '1.0.0',
    domain: 'testing',
    risk: 'read',
    available: true,
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    capabilities: ['testing'],
    supportedResourceKinds: ['system'],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'kernel-verify-test',
  };
  const lyingImpl: ToolImplementation = {
    toolId: lyingTool.id,
    async execute() {
      return { output: { ok: true }, observations: [] };
    },
    async verify() {
      return { ok: false, detail: 'world does not match the claim' };
    },
  };
  kernel.registerTool(lyingTool);
  kernel.registerImplementation(lyingImpl);

  const lie = await kernel.execute(
    { id: 'verify-lie-1', toolId: lyingTool.id, input: {}, requestedBy: 'verify-test', createdAt: new Date().toISOString() },
    context,
  );
  assert.equal(lie.status, 'failed');
  assert.match(lie.error ?? '', /verification failed/);
  console.log('PASS (A): failed verification turns success into failure');

  // B. Passing verify keeps success and records a verification observation.
  const honestTool: ToolDescriptor = { ...lyingTool, id: `${lyingTool.id}.honest` };
  const honestImpl: ToolImplementation = {
    toolId: honestTool.id,
    async execute() {
      return { output: { ok: true }, observations: [] };
    },
    async verify() {
      return { ok: true, detail: 'world matches the claim' };
    },
  };
  kernel.registerTool(honestTool);
  kernel.registerImplementation(honestImpl);
  const truth = await kernel.execute(
    { id: 'verify-truth-1', toolId: honestTool.id, input: {}, requestedBy: 'verify-test', createdAt: new Date().toISOString() },
    context,
  );
  assert.equal(truth.status, 'succeeded');
  assert.ok(truth.observations.some(o => o.source === 'kernel.verification'));
  console.log('PASS (B): passing verification records a kernel.verification observation');

  // C. Real file write verifies against the filesystem (confirmation-gated, then verified).
  registerNativeSystemProvider(kernel);
  await kernel.discover();
  const writeContext = () =>
    kernel.createContext({ userId: 'verify-test', authorityProfile: 'workspace', source: 'system', workingDirectory: workdir });
  const writeAction = (id: string) => ({
    id,
    toolId: 'fs.file_write',
    input: { path: 'proof.txt', content: 'verify me' },
    requestedBy: 'verify-test',
    createdAt: new Date().toISOString(),
  });
  const blocked = await kernel.execute(writeAction('verify-write-1'), writeContext());
  assert.equal(blocked.status, 'blocked');
  const confirmationId = String((blocked.metadata as any)?.confirmationId ?? '');
  assert.ok(confirmationId, 'expected a confirmation id for the write');
  kernel.resolveConfirmation(confirmationId, true);
  const done = await kernel.executeConfirmed(writeAction('verify-write-2'), writeContext(), confirmationId);
  assert.equal(done.status, 'succeeded');
  assert.ok(done.observations.some(o => o.source === 'kernel.verification'));
  assert.equal(await fs.readFile(path.join(workdir, 'proof.txt'), 'utf8'), 'verify me');
  console.log('PASS (C): real fs.file_write verifies against the filesystem');

  // D. Tamper is caught: verify flags a size mismatch on a modified file.
  await fs.writeFile(path.join(workdir, 'proof.txt'), 'tampered content here!!');
  const tamperCheck = await fsFileWriteImplementation.verify!({
    action: writeAction('verify-tamper'),
    tool: honestTool,
    context: writeContext(),
    output: { path: path.join(workdir, 'proof.txt'), bytesWritten: 9 },
  });
  assert.equal(tamperCheck.ok, false);
  assert.match(tamperCheck.detail, /expected 9/);
  console.log('PASS (D): tampered file fails verification (size mismatch)');

  await fs.rm(workdir, { recursive: true, force: true });
  console.log('PASS: verification tests complete');
}

main().catch(error => {
  console.error('FAIL: verification test');
  console.error(error);
  process.exitCode = 1;
});
