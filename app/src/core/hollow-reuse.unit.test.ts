/**
 * Hollow-reuse regression tests (vitest-enforced): action goals must never
 * replay read-only procedures. A find_tracks replay "succeeding" a play
 * request is the live incident behind this file.
 */
import { describe, it, expect } from 'vitest';
import { isHollowReuse } from './mark-runtime.js';
import { TaskBinder } from '../kernel/task-binder.js';
import type { ToolDescriptor, ToolParameterSchema } from '../kernel/types.js';

const binder = new TaskBinder();

function tool(id: string, risk: ToolDescriptor['risk'], properties: Record<string, ToolParameterSchema> = {}): ToolDescriptor {
  return {
    id,
    name: id,
    description: `Test tool ${id}.`,
    version: '1.0.0',
    domain: 'test',
    risk,
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

const bind = (command: string, selected: ToolDescriptor) => binder.bind(command, selected);

describe('isHollowReuse action goals', () => {
  const finder = tool('test.find', 'read', { query: { type: 'string', description: 'What to find.' } });
  const player = tool('test.play', 'reversible', { query: { type: 'string', description: 'What to play.' } });
  const tools = [finder, player];

  it('read-only replay of a play goal is hollow even with strong consensus', () => {
    expect(
      isHollowReuse(
        { steps: [{ toolId: 'test.find', input: {} }] },
        'play some music',
        tools,
        bind,
        { tool: { id: 'test.find' }, matchedTerms: ['play', 'music'] },
      ),
    ).toBe(true);
  });

  it('action-tool replay of a play goal is not hollow', () => {
    expect(
      isHollowReuse(
        { steps: [{ toolId: 'test.play', input: { query: 'music' } }] },
        'play some music',
        tools,
        bind,
        { tool: { id: 'test.play' }, matchedTerms: ['play', 'music'] },
      ),
    ).toBe(false);
  });

  it('read goals still replay read tools', () => {
    expect(
      isHollowReuse(
        { steps: [{ toolId: 'test.find', input: {} }] },
        'find some music',
        tools,
        bind,
        { tool: { id: 'test.find' }, matchedTerms: ['find', 'music'] },
      ),
    ).toBe(false);
  });

  it('action-tool replay of a question goal is hollow', () => {
    expect(
      isHollowReuse(
        { steps: [{ toolId: 'test.play', input: {} }] },
        'confirm if any music is playing',
        tools,
        bind,
        { tool: { id: 'test.play' }, matchedTerms: ['music', 'playing'] },
      ),
    ).toBe(true);
  });

  it('read-tool replay of a question goal is not hollow', () => {
    expect(
      isHollowReuse(
        { steps: [{ toolId: 'test.find', input: {} }] },
        'what music tracks are available',
        tools,
        bind,
        { tool: { id: 'test.find' }, matchedTerms: ['music', 'tracks'] },
      ),
    ).toBe(false);
  });
});
