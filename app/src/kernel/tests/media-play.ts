import assert from 'node:assert/strict';

import { MARKKernel } from '../index';
import { registerNativeSystemProvider } from '../providers/register-native';

async function main(): Promise<void> {
  const kernel = new MARKKernel();
  registerNativeSystemProvider(kernel);
  await kernel.discover();

  assert.ok(kernel.listTools().some(t => t.id === 'media.play_track'), 'media.play_track discovered');

  const context = (profile = 'workspace') =>
    kernel.createContext({ userId: 'media-test', authorityProfile: profile, source: 'system', metadata: {} });
  const action = (id: string, input: Record<string, unknown>) => ({
    id,
    toolId: 'media.play_track',
    input,
    requestedBy: 'media-test',
    createdAt: new Date().toISOString(),
  });

  // Approved runs reach the implementation; refusals below prove approval
  // cannot launder jail escapes, bad types, or missing files.
  async function confirmedRun(id: string, input: Record<string, unknown>) {
    const blocked = await kernel.execute(action(`${id}-ask`, input), context());
    assert.equal(blocked.status, 'blocked');
    const confirmationId = String((blocked.metadata as any)?.confirmationId ?? '');
    assert.ok(confirmationId);
    kernel.resolveConfirmation(confirmationId, true);
    return kernel.executeConfirmed(action(id, input), context(), confirmationId);
  }

  // A. Paths outside the library/cache are refused (no player launched).
  const escape = await confirmedRun('m-1', { path: '/etc/passwd' });
  assert.equal(escape.status, 'failed');
  assert.match(escape.error ?? '', /outside the music library/);
  console.log('PASS (A): paths outside the library are refused');

  // B. Non-audio extensions refused.
  const text = await confirmedRun('m-2', { path: `${process.env.HOME}/Music/notes.txt` });
  assert.equal(text.status, 'failed');
  assert.match(text.error ?? '', /not a supported audio file/);
  console.log('PASS (B): non-audio extensions refused');

  // C. Missing files fail honestly (stat before spawn).
  const ghost = await confirmedRun('m-3', { path: `${process.env.HOME}/Music/no-such-track.mp3` });
  assert.equal(ghost.status, 'failed');
  console.log('PASS (C): missing files fail before any launch');

  // D. Default profile gates playback behind confirmation.
  const gated = await kernel.execute(action('m-4', { path: `${process.env.HOME}/Music/x.mp3` }), kernel.createContext({
    userId: 'media-test',
    authorityProfile: 'default',
    source: 'system',
    metadata: {},
  }));
  assert.equal(gated.status, 'blocked');
  console.log('PASS (D): playback is confirmation-gated on the default profile');

  console.log('PASS: media play tests complete');
}

main().catch(error => {
  console.error('FAIL: media play test');
  console.error(error);
  process.exitCode = 1;
});
