import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { MARKKernel } from '../index';
import { registerNativeSystemProvider } from '../providers/register-native';
import { findTracks } from '../providers/media';

async function main(): Promise<void> {
  const kernel = new MARKKernel();
  registerNativeSystemProvider(kernel);
  await kernel.discover();

  const tools = kernel.listTools();
  const ids = new Set(tools.map(t => t.id));

  // 1. Discovery finds real apps with zero per-app code.
  const openTools = tools.filter(t => t.id.startsWith('desktop.open.'));
  assert.ok(openTools.length > 5, `expected many discovered apps, got ${openTools.length}`);
  assert.ok(ids.has('desktop.open.vlc'), 'vlc must be discovered');
  assert.ok(ids.has('desktop.open.mpv'), 'mpv must be discovered');
  assert.ok(ids.has('desktop.close.vlc'), 'vlc close must be discovered');
  assert.ok(ids.has('desktop.list_apps'), 'list_apps must exist');
  assert.ok(ids.has('media.find_tracks'), 'find_tracks must exist');
  assert.ok(ids.has('media.extract_track'), 'extract_track must exist');

  // 2. The resolver routes plain goals to discovered tools — no hints needed.
  const resolve = (goal: string) => kernel.resolveCapability(goal);
  assert.equal(resolve('open vlc').tool?.id, 'desktop.open.vlc');
  assert.equal(resolve('close vlc').tool?.id, 'desktop.close.vlc');
  assert.equal(resolve('open mpv').tool?.id, 'desktop.open.mpv');

  const containersResult = await kernel.execute(
    {
      id: 'recovery-containers',
      toolId: 'system.container_list',
      input: {},
      requestedBy: 'recovery-test',
      reason: 'Recovery test.',
      createdAt: new Date().toISOString(),
    },
    kernel.createContext({ userId: 'recovery-test', authorityProfile: 'default', source: 'system', metadata: {} }),
  );
  assert.equal(containersResult.status, 'succeeded', `container_list failed: ${containersResult.error ?? ''}`);
  const containers = (containersResult.output as { containers: Array<{ name: string }> }).containers;
  assert.ok(containers.some(c => c.name === 'jarvis-db'), 'jarvis-db should be running');
  assert.ok(ids.has('container.restart.jarvis-db'), 'per-container restart must be discovered');
  assert.equal(resolve('restart jarvis-db container').tool?.id, 'container.restart.jarvis-db');

  // 3. Launch pauses for confirmation and spawns nothing until approved.
  const context = kernel.createContext({
    userId: 'recovery-test',
    authorityProfile: 'default',
    source: 'system',
    metadata: {},
  });
  const launchAction = {
    id: 'recovery-launch',
    toolId: 'desktop.open.vlc',
    input: {},
    requestedBy: context.userId,
    reason: 'Recovery test.',
    createdAt: new Date().toISOString(),
  };
  const blocked = await kernel.execute(launchAction, context);
  assert.equal(blocked.status, 'blocked');
  const confirmationId = String((blocked.metadata as Record<string, unknown>)?.confirmationId ?? '');
  assert.ok(confirmationId, 'launch must pause with a confirmationId');
  kernel.resolveConfirmation(confirmationId, false);
  const denied = await kernel.executeConfirmed(launchAction, context, confirmationId);
  assert.equal(denied.status, 'blocked', 'denied launch must never spawn');

  // 4. Media discovery finds the zipped library; extraction is explicit.
  const findResult = await kernel.execute(
    {
      id: 'recovery-find',
      toolId: 'media.find_tracks',
      input: { query: '', limit: 5 },
      requestedBy: context.userId,
      reason: 'Recovery test.',
      createdAt: new Date().toISOString(),
    },
    context,
  );
  assert.equal(findResult.status, 'succeeded');
  const tracks = (findResult.output as { tracks: unknown[] }).tracks;
  assert.ok(tracks.length > 0, 'music library should yield tracks');

  // 5. No goal-phrase stuffing anywhere in the new descriptors.
  for (const tool of tools.filter(t => t.provider === 'desktop.native' || t.provider === 'media.native' || t.domain === 'containers')) {
    for (const text of [tool.description, ...(tool.capabilities ?? [])]) {
      assert.ok(
        !/goals like|for goals|use for/i.test(text),
        `phrase stuffing in ${tool.id}: "${text}"`,
      );
    }
  }

  // 6. Extraction is explicit and verified: list, pick an archive entry,
  // extract it through the confirmation gate, and confirm the file lands.
  const candidates = await findTracks(`${process.env.HOME || '/home/mwei'}/Music`, '', 50);
  const archived = candidates.find(t => t.kind === 'archive-entry');
  assert.ok(archived?.archive && archived.entry, 'expected at least one zipped track');
  const extractAction = {
    id: 'recovery-extract',
    toolId: 'media.extract_track',
    input: { archive: archived.archive!.split('/').pop()!, entry: archived.entry! },
    requestedBy: context.userId,
    reason: 'Recovery test.',
    createdAt: new Date().toISOString(),
  };
  const extractBlocked = await kernel.execute(extractAction, context);
  assert.equal(extractBlocked.status, 'blocked', 'extraction writes, so it must confirm first');
  const extractId = String((extractBlocked.metadata as Record<string, unknown>)?.confirmationId ?? '');
  kernel.resolveConfirmation(extractId, true);
  const extracted = await kernel.executeConfirmed(extractAction, context, extractId);
  assert.equal(extracted.status, 'succeeded', `extract failed: ${extracted.error ?? ''}`);
  const dest = (extracted.output as { path: string }).path;
  assert.ok((await fs.stat(dest)).isFile(), 'extracted track must exist on disk');

  console.log('PASS: desktop recovery (discovery, routing, confirmation gate, media, no stuffing)');
  console.log(`Discovered ${openTools.length} open tools, ${containers.length} containers, ${tracks.length} sample tracks`);
}

main().catch(error => {
  console.error('FAIL: desktop recovery');
  console.error(error);
  process.exitCode = 1;
});
