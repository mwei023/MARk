/**
 * Screen tools (desktop.screen): eyes and hands for the visible desktop.
 *
 * observe.* are risk 'read' (screenshots never mutate). act.* move, click,
 * type, and scroll through xdotool - risk 'mutating', so the kernel's
 * confirmation gate applies outside test mode. Every action re-observes:
 * callers verify, never assume.
 */
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DiscoveryProvider } from '../tool-discovery';
import type { ToolDescriptor, ToolImplementation, ToolParameterSchema } from '../index';

const execFilePromise = promisify(execFile);
const DISPLAY_ENV = process.env.DISPLAY ?? ':0.0';

function withDisplay(): Record<string, string> {
  return { ...(process.env as Record<string, string>), DISPLAY: DISPLAY_ENV };
}

function okOutput(extra: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, capturedAt: new Date().toISOString(), ...extra };
}

function failOutput(reason: string): Record<string, unknown> {
  return { ok: false, reason: reason.slice(0, 300), capturedAt: new Date().toISOString() };
}

const screenshotTool: ToolDescriptor = {
  id: 'screen.observe',
  name: 'Screenshot',
  description: 'Captures the root window to PNG and returns downscaled base64 plus dimensions. Read-only; always safe.',
  version: '1.0.0',
  domain: 'screen',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      maxWidth: { type: 'number', description: 'Downscale width for model input (default 640).' },
    },
    required: [],
  },
  capabilities: ['local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'desktop.screen',
};

const screenshotImplementation: ToolImplementation = {
  toolId: screenshotTool.id,
  async execute({ action }) {
    const maxWidth = Math.min(Math.max(typeof action.input.maxWidth === 'number' ? Math.floor(action.input.maxWidth) : 640, 320), 1920);
    const raw = join(tmpdir(), `mark-screen-${Date.now()}.png`);
    const small = join(tmpdir(), `mark-screen-${Date.now()}-small.png`);
    try {
      await execFilePromise('import', ['-window', 'root', raw], { env: withDisplay(), timeout: 20000 });
      await execFilePromise('convert', [raw, '-resize', `${maxWidth}x`, small], { timeout: 20000 });
      const b64 = readFileSync(small).toString('base64');
      return { output: okOutput({ imageBase64: b64, width: maxWidth }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

function actTool(id: string, name: string, description: string, properties: Record<string, ToolParameterSchema>, required: string[]): ToolDescriptor {
  return {
    id, name, description, version: '1.0.0', domain: 'screen', risk: 'mutating',
    available: true,
    inputSchema: { type: 'object', properties, required },
    capabilities: ['local-environment'],
    supportedResourceKinds: [],
    requiredPermissions: [],
    reversible: false,
    metadata: {},
    provider: 'desktop.screen',
  };
}

async function xdotool(args: string[]): Promise<string> {
  const { stdout } = await execFilePromise('xdotool', args, { env: withDisplay(), timeout: 15000 });
  return stdout.trim();
}

const mouseMoveTool = actTool(
  'screen.mouse_move', 'Move mouse',
  'Moves the pointer to absolute x,y pixels. Reversible (position only, no side effects): confirmation-gated, never denied. Verify with screen.observe after.',
  { x: { type: 'number', description: 'X pixel.' }, y: { type: 'number', description: 'Y pixel.' } },
  ['x', 'y'],
);
mouseMoveTool.risk = 'reversible';

const mouseMoveImplementation: ToolImplementation = {
  toolId: mouseMoveTool.id,
  async execute({ action }) {
    try {
      const x = Math.floor(Number(action.input.x));
      const y = Math.floor(Number(action.input.y));
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 4096 || y > 4096) {
        return { output: failOutput('coordinates out of range 0-4096') };
      }
      await xdotool(['mousemove', String(x), String(y)]);
      const loc = await xdotool(['getmouselocation', '--shell']);
      return { output: okOutput({ x, y, actual: loc.slice(0, 120) }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

const clickTool = actTool(
  'screen.click', 'Click',
  'Left-clicks at absolute x,y pixels. Mutating: needs confirmation outside test mode.',
  { x: { type: 'number', description: 'X pixel.' }, y: { type: 'number', description: 'Y pixel.' } },
  ['x', 'y'],
);

const clickImplementation: ToolImplementation = {
  toolId: clickTool.id,
  async execute({ action }) {
    try {
      const x = Math.floor(Number(action.input.x));
      const y = Math.floor(Number(action.input.y));
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 4096 || y > 4096) {
        return { output: failOutput('coordinates out of range 0-4096') };
      }
      await xdotool(['mousemove', String(x), String(y), 'click', '1']);
      return { output: okOutput({ x, y }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

const typeTool = actTool(
  'screen.type', 'Type text',
  'Types text at the focused window. Mutating: needs confirmation outside test mode.',
  { text: { type: 'string', description: 'Text to type (max 500 chars).' } },
  ['text'],
);

const typeImplementation: ToolImplementation = {
  toolId: typeTool.id,
  async execute({ action }) {
    try {
      const text = String(action.input.text ?? '').slice(0, 500);
      if (!text) return { output: failOutput('empty text') };
      await xdotool(['type', '--delay', '12', text]);
      return { output: okOutput({ typedChars: text.length }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

const keyTool = actTool(
  'screen.key', 'Press key',
  'Presses a key combo (Return, Escape, ctrl+w, alt+Tab, ...). Mutating outside test mode.',
  { keys: { type: 'string', description: 'Key combo, e.g. Return or ctrl+w.' } },
  ['keys'],
);

const keyImplementation: ToolImplementation = {
  toolId: keyTool.id,
  async execute({ action }) {
    try {
      const keys = String(action.input.keys ?? '').slice(0, 60);
      if (!/^[A-Za-z0-9_+]+$/.test(keys)) return { output: failOutput('key combo has unsafe characters') };
      await xdotool(['key', ...keys.split('+')]);
      return { output: okOutput({ keys }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const screenTools: ToolDescriptor[] = [
  screenshotTool, mouseMoveTool, clickTool, typeTool, keyTool,
];

export const screenImplementations: ToolImplementation[] = [
  screenshotImplementation, mouseMoveImplementation, clickImplementation, typeImplementation, keyImplementation,
];

export const screenDiscoveryProvider: DiscoveryProvider = {
  id: 'desktop.screen',
  name: 'Screen tools',
  description: 'Screenshot observation and xdotool actions for the visible desktop.',
  async isAvailable(): Promise<boolean> {
    return existsSync('/usr/bin/xdotool');
  },
  async discoverResources(): Promise<[]> {
    return [];
  },
  async discoverTools(): Promise<ToolDescriptor[]> {
    return screenTools;
  },
};
