import assert from 'node:assert/strict';

import { isHollowReuse } from './mark-runtime';
import { TaskBinder } from '../kernel/task-binder';
import { ToolDescriptor, ToolParameterSchema } from '../kernel/types';

const binder = new TaskBinder();

function tool(id: string, properties: Record<string, ToolParameterSchema> = {}): ToolDescriptor {
  return {
    id,
    name: id,
    description: `Test tool ${id}.`,
    version: '1.0.0',
    domain: 'test',
    risk: 'read',
    available: true,
    inputSchema: { type: 'object', properties, required: [] },
    capabilities: [],
    supportedResourceKinds: ['unknown'],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'test',
  };
}

async function main(): Promise<void> {
  const music = tool('test.music', {
    query: { type: 'string', description: 'Track name to search for.' },
  });
  const info = tool('test.info');
  const tools = [music, info];
  const bind = (command: string, selected: ToolDescriptor) => binder.bind(command, selected);

  // A. Input-taking tool with zero goal evidence AND weak fresh
  // resolution is hollow.
  assert.equal(
    isHollowReuse(
      { steps: [{ toolId: 'test.music', input: {} }] },
      'find TODO comments in src',
      tools,
      bind,
      { tool: { id: 'test.music' }, matchedTerms: ['find'] },
    ),
    true,
  );
  console.log('PASS (A): unevidenced replay with weak resolution is hollow');

  // A2. Same replay with strong fresh consensus still replays.
  assert.equal(
    isHollowReuse(
      { steps: [{ toolId: 'test.music', input: {} }] },
      'find music tracks',
      tools,
      bind,
      { tool: { id: 'test.music' }, matchedTerms: ['find', 'music', 'tracks'] },
    ),
    false,
  );
  console.log('PASS (A2): strong fresh consensus replays');

  // B. Explicit goal values fill the replay.
  assert.equal(
    isHollowReuse(
      { steps: [{ toolId: 'test.music', input: {} }] },
      'find music query: j cole',
      tools,
      bind,
    ),
    false,
  );
  console.log('PASS (B): evidenced replay proceeds');

  // C. Input-less tools always replay; missing tools never do.
  // No fresh resolution means memory covers the gap.
  assert.equal(isHollowReuse({ steps: [{ toolId: 'test.info' }] }, 'whatever', tools, bind), false);
  assert.equal(isHollowReuse({ steps: [{ toolId: 'test.gone' }] }, 'whatever', tools, bind), true);
  assert.equal(isHollowReuse({ steps: [] }, 'whatever', tools, bind), true);
  assert.equal(
    isHollowReuse({ steps: [{ toolId: 'test.music', input: {} }] }, 'whatever', tools, bind),
    false,
  );
  console.log('PASS (C): input-less replays, missing tools, empty plans, no-resolution handled');

  console.log('PASS: hollow reuse tests complete');
}

main().catch(error => {
  console.error('FAIL: hollow reuse test');
  console.error(error);
  process.exitCode = 1;
});
