/**
 * Blender capability — the first bounded creative-tool integration.
 *
 * Design rules (from the extendability plan):
 * - Structured scene parameters in, artifacts out. The adapter accepts NO
 *   natural language and never shells user text into a script.
 * - The Blender build is the authority: success is claimed only when the
 *   .blend file (and requested preview image) exist on disk after a real
 *   headless run. A generated script alone is never a claim to success.
 * - Writes are jailed to ~/Blender-MARK. Overwriting an existing project
 *   is a distinct tool with its own confirmation; create_scene refuses to
 *   clobber anything.
 * - Deterministic failure names the real cause (missing Blender, script
 *   error, render failure) — never a "done" without evidence.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  DiscoveryProvider,
} from '../tool-discovery';
import type {
  ToolDescriptor,
  ToolImplementation,
} from '../index';

const execFilePromise = promisify(execFile);

const BLENDER_BIN = process.env.MARK_BLENDER_BIN || 'blender';
/** Output jail: every artifact MARK writes for the user lives here. */
export const BLENDER_OUTPUT_ROOT = path.join(os.homedir(), 'Blender-MARK');
const SCRIPT_NAME = 'mark_scene.py';
const BLENDER_TIMEOUT_MS = 240000; // headless still render stays well inside

export interface SceneSpec {
  /** Bounded first preset; more presets come only with tests. */
  preset?: 'crystal';
  /** File name of the project inside ~/Blender-MARK (no paths, no ext tricks). */
  outputName: string;
  /** Also render a still preview next to the .blend. */
  preview?: boolean;
  width?: number;
  height?: number;
}

/** Pure helper — the exact python script MARK passes to blender -b -P. */
export function generateSceneScript(spec: SceneSpec): string {
  const preset = spec.preset ?? 'crystal';
  if (preset !== 'crystal') {
    throw new Error(`Unsupported scene preset "${preset}". Supported: crystal.`);
  }
  const footer = `import bpy, sys, os
argv = sys.argv[sys.argv.index('--') + 1:]
blend_path = argv[0]
want_preview = argv[1] == '1'
width = int(argv[2])
height = int(argv[3])

bpy.ops.wm.read_factory_settings(use_empty=True)

# Floor: dark, slightly reflective plane.
bpy.ops.mesh.primitive_plane_add(size=14, location=(0, 0, 0))
floor = bpy.context.active_object
floor_material = bpy.data.materials.new('mark_floor')
floor_material.use_nodes = True
floor_nodes = floor_material.node_tree.nodes['Principled BSDF']
for name, value in [('Base Color', (0.02, 0.02, 0.025, 1.0)), ('Roughness', 0.12), ('Metallic', 0.55)]:
    try:
        floor_nodes.inputs[name].default_value = value
    except Exception: pass
floor.data.materials.append(floor_material)

# Crystal: faceted icosahedron stretched tall.
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=1.0, location=(0, 0, 1.5))
crystal = bpy.context.active_object
crystal.scale = (1.1, 1.1, 1.9)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
crystal_material = bpy.data.materials.new('mark_crystal')
crystal_material.use_nodes = True
crystal_nodes = crystal_material.node_tree.nodes['Principled BSDF']
for name, value in [('Base Color', (0.35, 0.85, 0.95, 1.0)), ('Metallic', 0.9), ('Roughness', 0.06), ('Transmission Weight', 0.6)]:
    try:
        crystal_nodes.inputs[name].default_value = value
    except Exception:
        # Older/newer Blender naming for transmission.
        try:
            crystal_nodes.inputs['Transmission'].default_value = 0.6
        except Exception: pass
try:
    for name in ('Specular IOR Level', 'Specular'):
        crystal_nodes.inputs[name].default_value = 0.9
except Exception: pass
crystal.data.materials.append(crystal_material)

# Lighting: soft area key + cool rim.
bpy.ops.object.light_add(type='AREA', location=(3, -3, 4))
key = bpy.context.active_object
key.data.energy = 900
key.data.size = 4
try:
    key.data.color = (1.0, 0.96, 0.9)
except Exception: pass

bpy.ops.object.light_add(type='AREA', location=(-4, -1, 3))
rim = bpy.context.active_object
rim.data.energy = 450
rim.data.size = 3
try:
    rim.data.color = (0.55, 0.75, 1.0)
except Exception: pass

bpy.ops.object.light_add(type='SUN', location=(0, 6, 8))
sun = bpy.context.active_object
sun.data.energy = 1.2
sun.rotation_euler = (0.6, 0.15, 0.9)

# Camera slightly above, looking down at the crystal.
bpy.ops.object.camera_add(location=(0, -6.5, 3.2), rotation=(1.18, 0, 0))
bpy.context.scene.camera = bpy.context.active_object

bpy.ops.wm.save_as_mainfile(filepath=blend_path)

if want_preview:
    scene = bpy.context.scene
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    try:
        scene.render.engine = 'BLENDER_EEVEE_NEXT'
    except Exception:
        scene.render.engine = 'BLENDER_EEVEE'
    try:
        scene.eevee.taa_render_samples = 32
    except Exception: pass
    scene.render.filepath = blend_path.replace('.blend', '.png')
    try:
        scene.render.image_settings.file_format = 'PNG'
    except Exception: pass
    bpy.ops.render.render(write_still=True)

print('MARK_SCENE_OK ' + blend_path)
`;
  return footer;
}

function assertSafeOutputName(name: string): string {
  const clean = String(name || '').trim();
  if (!clean || clean.includes('/') || clean.includes('..') || /[^\w.-]/.test(clean)) {
    throw new Error(`Unsafe output name: "${name}". Use a plain file name (letters, digits, -, _).`);
  }
  return clean.endsWith('.blend') ? clean : `${clean}.blend`;
}

async function runBlender(scriptPath: string, blendPath: string, wantPreview: boolean, width: number, height: number): Promise<string> {
  const { stdout, stderr } = await execFilePromise(
    BLENDER_BIN,
    ['-b', '-P', scriptPath, '--', blendPath, wantPreview ? '1' : '0', String(width), String(height)],
    { timeout: BLENDER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
  );
  return `${stdout}\n${stderr}`.slice(0, 1500);
}

async function executeScene(spec: SceneSpec, overwrite: boolean): Promise<Record<string, unknown>> {
  const blendName = assertSafeOutputName(spec.outputName);
  if (!existsSync(BLENDER_OUTPUT_ROOT)) {
    mkdirSync(BLENDER_OUTPUT_ROOT, { recursive: true });
  }
  const blendPath = path.join(BLENDER_OUTPUT_ROOT, blendName);
  if (existsSync(blendPath)) {
    if (!overwrite) {
      throw new Error(
        `Already exists: ${blendPath}. Creating a new scene with a different name, or explicitly approve an overwrite — MARK never silently replaces a project.`,
      );
    }
    const stamp = statSync(blendPath);
    writeFileSync(path.join(BLENDER_OUTPUT_ROOT, `${blendName}.last-backup-${stamp.mtimeMs.toFixed(0)}`),
      readFileSync(blendPath));
  }

  const scriptPath = path.join(BLENDER_OUTPUT_ROOT, SCRIPT_NAME);
  writeFileSync(scriptPath, generateSceneScript(spec));
  const wantPreview = spec.preview !== false; // preview is default-on: artifacts are the evidence
  const width = Math.min(Math.max(Number(spec.width ?? 960), 64), 1920);
  const height = Math.min(Math.max(Number(spec.height ?? 540), 64), 1080);

  let blenderLog: string;
  try {
    blenderLog = await runBlender(scriptPath, blendPath, wantPreview, width, height);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/ENOENT|could not be executed/i.test(detail)) {
      throw new Error(`Blender is not available on this machine (${BLENDER_BIN}). Nothing was created.`);
    }
    throw new Error(`Blender run failed: ${detail.slice(0, 400)}`);
  }
  if (!existsSync(blendPath)) {
    throw new Error(`Blender exited but no .blend file appears at ${blendPath}. Log: ${blenderLog.slice(0, 300)}`);
  }
  const previewPath = blendPath.replace(/\.blend$/, '.png');
  const previewReady = wantPreview && existsSync(previewPath);
  if (wantPreview && !previewReady) {
    throw new Error(`Scene saved, but the preview render did not produce ${previewPath}. Log: ${blenderLog.slice(0, 300)}`);
  }
  return {
    file: blendPath,
    preview: previewReady ? previewPath : null,
    script: scriptPath,
    blenderLog,
    capturedAt: new Date().toISOString(),
  };
}

export const blenderCreateSceneTool: ToolDescriptor = {
  id: 'blender.create_scene',
  name: 'Create Blender scene',
  description: 'Creates a bounded 3D scene in Blender headlessly (preset: glowing crystal on a dark reflective floor), saves the .blend project in ~/Blender-MARK, and renders a still preview. Requires Blender installed. Fails honestly when Blender or the render fails. Never overwrites an existing project.',
  version: '0.1.0',
  domain: 'creative',
  risk: 'reversible',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      outputName: { type: 'string', description: 'Plain file name for the project, e.g. "crystal-night".' },
      preset: { type: 'string', description: 'Visual preset; only "crystal" is supported.' },
      preview: { type: 'boolean', description: 'Render a still preview (default true).' },
      width: { type: 'number', description: 'Preview width px (64-1920, default 960).' },
      height: { type: 'number', description: 'Preview height px (64-1080, default 540).' },
    },
    required: ['outputName'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      preview: { type: 'string' },
      script: { type: 'string' },
      blenderLog: { type: 'string' },
      capturedAt: { type: 'string' },
    },
    required: ['file', 'preview', 'script', 'blenderLog', 'capturedAt'],
  },
  capabilities: ['3d-render', 'creative'],
  supportedResourceKinds: ['unknown'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'blender.native',
};

export const blenderOverwriteSceneTool: ToolDescriptor = {
  id: 'blender.overwrite_scene',
  name: 'Overwrite Blender scene',
  description: 'Regenerates an EXISTING scene project in ~/Blender-MARK, replacing its .blend (a timestamped backup is kept). Distinct confirmation from creating a new scene; never called implicitly.',
  version: '0.1.0',
  domain: 'creative',
  risk: 'mutating',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      outputName: { type: 'string', description: 'Existing project file name to replace.' },
      preset: { type: 'string', description: 'Visual preset; only "crystal" is supported.' },
    },
    required: ['outputName'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      preview: { type: 'string' },
      script: { type: 'string' },
      blenderLog: { type: 'string' },
      capturedAt: { type: 'string' },
    },
    required: ['file', 'preview', 'script', 'blenderLog', 'capturedAt'],
  },
  capabilities: ['3d-render', 'creative'],
  supportedResourceKinds: ['unknown'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'blender.native',
};

export const blenderTools: ToolDescriptor[] = [blenderCreateSceneTool, blenderOverwriteSceneTool];

export const blenderImplementations: ToolImplementation[] = [
  {
    toolId: blenderCreateSceneTool.id,
    async execute({ action }) {
      return await executeScene(action.input as unknown as SceneSpec, false);
    },
  },
  {
    toolId: blenderOverwriteSceneTool.id,
    async execute({ action }) {
      return await executeScene(action.input as unknown as SceneSpec, true);
    },
  },
];

export const blenderDiscoveryProvider: DiscoveryProvider = {
  id: 'blender.native',
  name: 'Blender creative provider',
  description: 'One bounded 3D scene capability (crystal preset) with honest, file-evidenced success.',
  priority: 50,
  async isAvailable(): Promise<boolean> {
    try {
      await execFilePromise(BLENDER_BIN, ['--version'], { timeout: 15000 });
      return true;
    } catch {
      return false;
    }
  },
  async discoverResources(): Promise<never[]> {
    return [];
  },
  async discoverTools(): Promise<ToolDescriptor[]> {
    return blenderTools;
  },
};
