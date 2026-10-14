import assert from 'node:assert/strict';

import { MARKKernel } from '../index';
import { registerNativeSystemProvider } from '../providers/register-native';

async function main(): Promise<void> {
  const kernel = new MARKKernel();
  registerNativeSystemProvider(kernel);
  await kernel.discover();

  const tools = kernel.listTools();
  for (const id of [
    'fs.file_read',
    'system.process_list',
    'system.disk_usage',
    'net.network_interfaces',
  ]) {
    assert.ok(tools.some(t => t.id === id), `${id} should be discovered`);
    assert.ok(
      tools.find(t => t.id === id)?.outputSchema,
      `${id} should declare an outputSchema`,
    );
  }

  const context = kernel.createContext({
    userId: 'eyes-test',
    authorityProfile: 'default',
    source: 'system',
    workingDirectory: process.cwd(),
    metadata: {},
  });
  const run = (toolId: string, input: Record<string, unknown>, id: string) =>
    kernel.execute(
      { id, toolId, input, requestedBy: context.userId, reason: 'Eyes test.', createdAt: new Date().toISOString() },
      context,
    );

  const file = await run('fs.file_read', { path: 'package.json', maxLines: 5 }, 'eyes-file');
  assert.equal(file.status, 'succeeded', `file_read failed: ${file.error ?? ''}`);
  assert.match(String((file.output as { path: string }).path), /package\.json/);

  const refused = await run('fs.file_read', { path: '/etc/shadow' }, 'eyes-file-refused');
  assert.notEqual(refused.status, 'succeeded', 'credential paths must be refused');

  const procs = await run('system.process_list', { limit: 5 }, 'eyes-procs');
  assert.equal(procs.status, 'succeeded', `process_list failed: ${procs.error ?? ''}`);
  assert.ok(((procs.output as { processes: unknown[] }).processes.length) > 0);

  const disks = await run('system.disk_usage', {}, 'eyes-disks');
  assert.equal(disks.status, 'succeeded', `disk_usage failed: ${disks.error ?? ''}`);
  assert.ok(((disks.output as { mounts: unknown[] }).mounts.length) > 0);

  const nets = await run('net.network_interfaces', {}, 'eyes-nets');
  assert.equal(nets.status, 'succeeded', `network_interfaces failed: ${nets.error ?? ''}`);
  assert.ok(((nets.output as { interfaces: unknown[] }).interfaces.length) > 0);

  console.log('PASS: eyes (file_read, process_list, disk_usage, network_interfaces)');
}

main().catch(error => {
  console.error('FAIL: eyes');
  console.error(error);
  process.exitCode = 1;
});
