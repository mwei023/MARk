/**
 * Regression tests for the extendability plan step 1-2: a creative goal
 * ("Open Blender and make a simple beautiful scene") must never be claimed
 * by a desktop app the user did not name. Observed live: the composed plan
 * closed+opened Simple Screen Recorder because the goal contained the word
 * "simple" (app NAME) and the generic verb "open".
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from './tool-registry';
import { CapabilityResolver } from './capability-resolver';
import { ToolDescriptor } from './types';

const clip = (id: string, name: string, description: string): ToolDescriptor => ({
  id,
  name,
  description,
  version: '1.0.0',
  domain: id.startsWith('desktop') ? 'desktop' : 'creative',
  risk: 'reversible',
  available: true,
  inputSchema: { type: 'object', properties: {} },
  outputSchema: { type: 'object', properties: {} },
  capabilities: [],
  supportedResourceKinds: ['unknown'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'test.native',
});

function registryWith(tools: ToolDescriptor[]): CapabilityResolver {
  const reg = new ToolRegistry();
  reg.registerMany(tools);
  return new CapabilityResolver({ toolRegistry: reg });
}

const SCENE_GOAL =
  'Open Blender and make a simple beautiful scene — a glowing crystal on a dark reflective floor with soft lighting';
const APPS = [
  clip('desktop.open.blender', 'Blender', 'Open the Blender 3D application.'),
  clip('desktop.open.simplescreenrecorder', 'Simple Screen Recorder', 'A screen recording application.'),
  clip('desktop.close.simplescreenrecorder', 'Simple Screen Recorder', 'A screen recording application.'),
  clip('desktop.open.vmpk', 'VMPK', 'Virtual MIDI piano keyboard application.'),
];

describe('named-app rule (creative goals cannot be claimed by unnamed apps)', () => {
  it('ranks only the named app when the goal names Blender', () => {
    const resolver = registryWith(APPS);
    const ranked = resolver.resolveAll(SCENE_GOAL, { gate: false });
    const bad = ranked.filter(c => c.tool.id.includes('simplescreenrecorder') || c.tool.id.includes('vmpk'));
    expect(bad).toHaveLength(0);
    if (ranked.length > 0) {
      expect(ranked[0].tool.id).toBe('desktop.open.blender');
    }
  });

  it('leaves no desktop claim at all when no app is named (words-only goal)', () => {
    const resolver = registryWith(APPS.filter(t => !t.id.includes('blender')));
    const ranked = resolver.resolveAll(SCENE_GOAL, { gate: false });
    expect(ranked.filter(c => /^(desktop\.)/.test(c.tool.id))).toHaveLength(0);
  });

  it('still opens an app the user explicitly names', () => {
    const resolver = registryWith(APPS.filter(t => t.id.includes('vmpk')));
    const ranked = resolver.resolveAll('open vmpk, please', { gate: false });
    expect(ranked[0]?.tool.id).toBe('desktop.open.vmpk');
  });

  it('keeps close-app actions when the goal names the app', () => {
    const resolver = registryWith(APPS);
    const ranked = resolver.resolveAll('stop the screen recorder and close it', { gate: false });
    const set = new Set(ranked.map(c => c.tool.id));
    expect(set.has('desktop.close.simplescreenrecorder')).toBe(true);
  });
});
