/**
 * Blender capability contract tests: the generated script carries the
 * bounded scene; the adapter refuses unsafe names and never overwrites
 * silently. The live Blender run is verified separately (real machine).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
// execution shape mirrors kernel executor input { action }
import { generateSceneScript, blenderImplementations, BLENDER_OUTPUT_ROOT } from './providers/blender';
import type { ActionRequest } from './types';

const spec = { outputName: 'crystal-night', preview: true };

function call(toolId: string, input: Record<string, unknown>): { action: ActionRequest } {
  return { action: { toolId, input } } as unknown as { action: ActionRequest };
}

interface ExecutorLike { execute(args: { action: ActionRequest }): Promise<Record<string, unknown>>; }
const asExecutor = (i: unknown): ExecutorLike => i as ExecutorLike;

describe('generateSceneScript', () => {
  it('produces the bounded crystal scene with artifacts on disk', () => {
    const script = generateSceneScript(spec);
    expect(script).toContain('bpy.ops.wm.read_factory_settings');
    expect(script).toContain('mark_crystal');
    expect(script).toContain('save_as_mainfile');
    expect(script).toContain('write_still=True');
  });
  it('refuses unsupported presets', () => {
    expect(() => generateSceneScript({ ...spec, preset: 'spaceship' as never })).toThrow(/preset/i);
  });
});

describe('blender.create_scene implementation guards', () => {
  beforeEach(() => {
    if (!existsSync(BLENDER_OUTPUT_ROOT)) mkdirSync(BLENDER_OUTPUT_ROOT, { recursive: true });
  });
  afterAll(() => {
    // Keep the root; remove only this test's artifacts.
    for (const f of ['crystal-night.blend', 'crystal-night.png']) {
      try { rmSync(join(BLENDER_OUTPUT_ROOT, f)); } catch {}
    }
  });

  it('refuses path tricks in outputName', async () => {
    const impl = asExecutor(blenderImplementations.find(i => i.toolId === 'blender.create_scene'));
    await expect(impl.execute(call('blender.create_scene', { outputName: '../evil' })))
      .rejects.toThrow(/Unsafe output name/);
  });

  it('refuses to overwrite an existing project without the overwrite tool', async () => {
    // Prepare an existing artifact like a previously shipped scene left on disk.
    const existing = join(BLENDER_OUTPUT_ROOT, 'crystal-night.blend');
    writeFileSync(existing, 'previous project bytes');
    const impl = asExecutor(blenderImplementations.find(i => i.toolId === 'blender.create_scene'));
    await expect(impl.execute(call('blender.create_scene', spec)))
      .rejects.toThrow(/Already exists/);
  });
});
