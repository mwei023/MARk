import assert from 'node:assert/strict';

import { EventBus } from './event-bus';
import { Gateway } from './gateway';
import { MarkRuntime, Reasoner } from './mark-runtime';
import { AgentRuntime } from './agent-runtime';
import { CapabilityRegistry } from '../runtime/capabilities/registry';
import { LocalHostCapability } from '../runtime/capabilities/shell';
import { MarkStatusCapability } from '../runtime/capabilities/mark-status';

/**
 * Kernel-first command routing: actionable goals must resolve to executed
 * capabilities with honest outcomes — never to a chat model roleplaying
 * actions it did not perform.
 */
async function main(): Promise<void> {
  // Deterministic routing under test: the LLM classifier stays out of it.
  process.env.MARK_SMART = 'off';
  const capabilities = new CapabilityRegistry();
  capabilities.register(new LocalHostCapability());
  capabilities.register(new MarkStatusCapability());
  const reasoner: Reasoner = {
    respond: async input => `reasoned: ${input}`,
  };
  const runtime = new MarkRuntime({
    eventBus: new EventBus(),
    gateway: new Gateway(),
    agents: new AgentRuntime(),
    capabilities,
    reasoner,
  });

  // 1. Fast local path untouched.
  const disk = await runtime.executeCommand('check disk space', 'test-user', 'cli');
  assert.equal(disk.route, 'capability');

  // 2. "open vlc" acts: reversible launch pauses for approval, with an id.
  const open = await runtime.executeCommand('open vlc', 'test-user', 'cli');
  assert.equal(open.route, 'kernel', `expected kernel route, got [${open.route}] ${open.response}`);
  assert.match(open.response, /approval|confirmation/i);
  assert.ok(open.trace?.some(line => line.includes('desktop.open.vlc')), 'trace must name the resolved tool');
  assert.ok(open.trace?.some(line => line.includes('confirmation required')), 'trace must show the authority decision');

  // 3. Hog question measures the disk root instead of dumping df.
  const hogs = await runtime.executeCommand('whats eating my disk', 'test-user', 'cli');
  assert.equal(hogs.route, 'kernel', `expected kernel route, got [${hogs.route}] ${hogs.response}`);
  assert.match(hogs.response, /largest|Measured/i);
  assert.ok(!hogs.trace?.some(line => line.includes('reasoning → LLM')), 'must not fall through to chat');

  // 4. Music search reports real tracks, never "playing".
  const music = await runtime.executeCommand('play some music', 'test-user', 'cli');
  assert.equal(music.route, 'kernel', `expected kernel route, got [${music.route}] ${music.response}`);
  assert.ok(!/playing music/i.test(music.response), 'must not claim playback it did not perform');

  // 5. True unknowns still reach reasoning.
  const unknown = await runtime.executeCommand('help me understand neural networks', 'test-user', 'cli');
  assert.equal(unknown.route, 'reasoning');

  // 6. Experience loop: a repeated read-only success reuses memory.
  const firstList = await runtime.executeCommand('list desktop apps', 'test-user', 'cli');
  assert.equal(firstList.route, 'kernel');
  const secondList = await runtime.executeCommand('list desktop apps', 'test-user', 'cli');
  assert.equal(secondList.route, 'kernel');
  assert.ok(
    secondList.trace?.some(line => line.includes('reused workflow')),
    `second run should reuse memory, trace was: ${(secondList.trace ?? []).join(' | ')}`,
  );

  console.log('PASS: kernel-first commands (act honestly, chat only unknowns)');
}

main().catch(error => {
  console.error('FAIL: kernel-first commands');
  console.error(error);
  process.exitCode = 1;
});
