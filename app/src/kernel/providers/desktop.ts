import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  DiscoveryProvider,
  ResourceDescriptor,
  ToolDescriptor,
  ToolImplementation,
} from '../index';

const execFileAsync = promisify(execFile);

export const DESKTOP_OPEN_PREFIX = 'desktop.open.';
export const DESKTOP_CLOSE_PREFIX = 'desktop.close.';

export interface DesktopEntry {
  appId: string;
  name: string;
  argv: string[];
  binary: string;
  categories: string[];
  sourceFile: string;
}

/**
 * POLICY (not a catalog): binaries MARK will never launch even when a
 * .desktop entry advertises them. The catalog itself is discovered — every
 * installed GUI app appears as open/close tools without per-app code.
 * Terminal apps are skipped at scan time: MARK has no terminal UI in which
 * to present them.
 */
const DESKTOP_LAUNCH_DENY_BINARIES = new Set([
  'sh', 'bash', 'dash', 'zsh', 'fish',
  'rm', 'dd', 'mkfs', 'chmod', 'chown',
  'sudo', 'su', 'pkexec', 'gksudo',
  'apt', 'apt-get', 'dpkg', 'snap', 'flatpak', 'pip', 'pip3', 'npm',
  'python', 'python3', 'perl', 'ruby', 'node',
]);

const DESKTOP_SCAN_DIRS = [
  '/usr/share/applications',
  `${os.homedir()}/.local/share/applications`,
  // Snap packages install their launchers here, NOT in /usr/share/applications.
  // Observed live: Blender (snap) was invisible to the app catalog — "open
  // blender" resolved to noise because the tool never existed to resolve.
  '/var/lib/snapd/desktop/applications',
  '/var/lib/flatpak/exports/share/applications',
  `${os.homedir()}/.local/share/flatpak/exports/share/applications`,
];

/** Parses installed .desktop files into launchable app entries. */
export async function scanDesktopEntries(): Promise<DesktopEntry[]> {
  const entries: DesktopEntry[] = [];

  for (const dir of DESKTOP_SCAN_DIRS) {
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.desktop')) continue;
      const appId = file.slice(0, -'.desktop'.length).toLowerCase();
      try {
        const entry = await parseDesktopFile(path.join(dir, file), appId);
        if (entry) entries.push(entry);
      } catch {
        continue;
      }
    }
  }

  entries.sort((left, right) => left.appId.localeCompare(right.appId));
  return entries;
}

async function parseDesktopFile(file: string, appId: string): Promise<DesktopEntry | null> {
  const text = await fs.readFile(file, 'utf8');
  let name: string | undefined;
  let exec: string | undefined;
  let terminal = false;
  let hidden = false;
  let noDisplay = false;
  let categories: string[] = [];

  for (const line of text.split('\n')) {
    if (line === '[Desktop Action NewWindow]') break; // ignore action sections
    if (line.startsWith('Name=') && name === undefined) name = line.slice('Name='.length).trim();
    else if (line.startsWith('Exec=') && exec === undefined) exec = line.slice('Exec='.length).trim();
    else if (line === 'Terminal=true') terminal = true;
    else if (line === 'Hidden=true') hidden = true;
    else if (line === 'NoDisplay=true') noDisplay = true;
    else if (line.startsWith('Categories=')) {
      categories = line.slice('Categories='.length).split(';').map(part => part.trim()).filter(Boolean);
    }
  }

  if (!name || !exec || hidden || noDisplay || terminal) return null;

  const argv = tokenizeExec(exec).filter(token => !/^%[a-zA-Z]$/.test(token));
  if (argv.length === 0) return null;
  if (/[;&`|$()]/.test(argv.join(' '))) return null; // cannot spawn safely without a shell

  return {
    appId,
    name,
    argv,
    binary: path.basename(argv[0]),
    categories,
    sourceFile: file,
  };
}

function tokenizeExec(exec: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(exec)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

export function desktopOpenTool(entry: DesktopEntry): ToolDescriptor {
  const isBrowser = entry.categories.includes('WebBrowser');
  return {
    id: `${DESKTOP_OPEN_PREFIX}${entry.appId}`,
    name: `Open ${entry.name}`,
    description: `Launch the ${entry.name} desktop application.`,
    version: '1.0.0',
    domain: 'desktop',
    risk: 'reversible',
    available: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...(isBrowser
          ? { url: { type: 'string', description: 'Optional http(s) URL to open.' } }
          : { file: { type: 'string', description: 'Optional file to open (must be inside the home directory).' } }),
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        target: { type: 'string' },
        pid: { type: 'number' },
        capturedAt: { type: 'string' },
      },
      required: ['app', 'target', 'capturedAt'],
    },
    capabilities: ['app-launch', 'desktop'],
    supportedResourceKinds: ['application'],
    requiredPermissions: [],
    reversible: true,
    metadata: { desktopEntry: entry.appId, binary: entry.binary },
    provider: 'desktop.native',
  };
}

export function desktopCloseTool(entry: DesktopEntry): ToolDescriptor {
  return {
    id: `${DESKTOP_CLOSE_PREFIX}${entry.appId}`,
    name: `Close ${entry.name}`,
    description: `Close the ${entry.name} desktop application (SIGTERM; unsaved work may be lost).`,
    version: '1.0.0',
    domain: 'desktop',
    risk: 'reversible',
    available: true,
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        closed: { type: 'boolean' },
        detail: { type: 'string' },
        capturedAt: { type: 'string' },
      },
      required: ['app', 'closed', 'detail', 'capturedAt'],
    },
    capabilities: ['app-close', 'desktop'],
    supportedResourceKinds: ['application'],
    requiredPermissions: [],
    reversible: true,
    metadata: { desktopEntry: entry.appId, binary: entry.binary },
    provider: 'desktop.native',
  };
}

export const desktopListAppsTool: ToolDescriptor = {
  id: 'desktop.list_apps',
  name: 'List desktop apps',
  description: 'Lists installed desktop applications discovered from the system, without launching anything.',
  version: '1.0.0',
  domain: 'desktop',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional substring filter matched against app id and name.' },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      apps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            binary: { type: 'string' },
          },
          required: ['id', 'name', 'binary'],
        },
      },
      capturedAt: { type: 'string' },
    },
    required: ['count', 'apps', 'capturedAt'],
  },
  capabilities: ['app-discovery', 'desktop'],
  supportedResourceKinds: ['application'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'desktop.native',
};

export const desktopListAppsImplementation: ToolImplementation = {
  toolId: desktopListAppsTool.id,

  async execute({ action }) {
    const query = String(action.input.query ?? '').toLowerCase().trim();
    const entries = await scanDesktopEntries();
    const apps = entries
      .filter(entry => !query || entry.appId.includes(query) || entry.name.toLowerCase().includes(query))
      .map(entry => ({ id: `${DESKTOP_OPEN_PREFIX}${entry.appId}`, name: entry.name, binary: entry.binary }));
    const output = { count: apps.length, apps, capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'application',
          source: 'desktop.native',
          subject: 'desktop-apps',
          summary: `Listed ${apps.length} desktop applications.`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

// ── window control (xdotool + EWMH; no wmctrl on this machine) ───────────────
// The user asked for it: "a command running in a terminal — I choose to open
// it, or tell MARK to maximize/minimize it." Window ops are reversible and
// never kill the process behind a window.

// tsx runs this file as CommonJS (package.json has no "type"), so __dirname
// points at src/kernel/providers → ../../../Scripts = app/Scripts.
const EWMH_SCRIPT = path.resolve(__dirname, '../../../Scripts/ewmh.py');

interface XWindow { id: string; pid: number; title: string }

/** The binder binds whole goals into title fields; normalize to name terms. */
const WINDOW_NAME_STOP = new Set(['the', 'a', 'an', 'window', 'windows', 'open', 'show', 'minimize',
  'minimise', 'maximize', 'maximise', 'restore', 'up', 'down', 'it', 'please', 'my',
  'at', 'looking', 'left', 'right', 'side', 'on', 'to', 'of', 'and', 'in', 'for',
  // generic desktop/goal vocab — a bound filter of only these means "no filter"
  'list', 'apps', 'all', 'me', 'give', 'current', 'visible', 'running', 'then', 'pls']);

function titleTerms(rawTitle: string): string[] {
  return rawTitle.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1 && !WINDOW_NAME_STOP.has(t));
}

/** Score windows against name terms; any-window hit list, best first. */
function scoreWindows(windows: XWindow[], terms: string[]): Array<{ w: XWindow; hits: number }> {
  return windows
    .map(w => {
      const titleTokens = new Set(w.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
      const fullTitle = w.title.toLowerCase();
      const hits = terms.filter(t => titleTokens.has(t) || fullTitle.includes(t)).length;
      return { w, hits };
    })
    .filter(s => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);
}

/**
 * All managed windows on the X display — read from the WM's _NET_CLIENT_LIST
 * (what wmctrl shows), which includes iconified/hidden windows. Falls back to
 * xdotool's visible-window search if xprop is unavailable for some reason.
 */
async function listXWindows(limit = 40): Promise<XWindow[]> {
  let ids: string[] = [];
  try {
    const { stdout } = await execFileAsync('xprop', ['-root', '_NET_CLIENT_LIST'], { timeout: 10000, env: { ...process.env } });
    const hexes = stdout.match(/0x[0-9a-f]+/gi) ?? [];
    if (hexes.length > 0) {
      ids = hexes.map(h => String(parseInt(h, 16))).slice(0, limit);
    }
  } catch { /* fall through to the visible-only path */ }
  if (ids.length === 0) {
    try {
      const { stdout } = await execFileAsync('xdotool', ['search', '--onlyvisible', '--name', '.'], { timeout: 10000 });
      ids = stdout.trim().split('\n').filter(Boolean).slice(0, limit);
    } catch {
      return []; // no X display from this context — honest empty, not an error
    }
  }
  if (ids.length === 0) return [];
  const windows: XWindow[] = [];
  for (let i = 0; i < ids.length; i++) {
    let pid = 0;
    let title = '';
    try {
      const { stdout } = await execFileAsync('xdotool', ['getwindowpid', ids[i]], { timeout: 5000 });
      pid = Number(stdout.trim()) || 0;
    } catch { /* window vanished or no pid — reported as 0 */ }
    try {
      const { stdout } = await execFileAsync('xdotool', ['getwindowname', ids[i]], { timeout: 5000 });
      title = stdout.trim();
    } catch { /* vanished mid-enumeration — skip below */ }
    if (title) windows.push({ id: ids[i], pid, title });
  }
  return windows;
}

function matchXWindow(input: { windowId?: string; pid?: string; title?: string }, windows: XWindow[]): XWindow {
  const id = String(input.windowId ?? '').trim();
  const pid = String(input.pid ?? '').trim();
  const rawTitle = String(input.title ?? '').trim();
  if (id) {
    const hit = windows.find(w => w.id === id);
    if (hit) return hit;
    throw new Error(`No visible window with id ${id}. Run desktop.window_list.`);
  }
  if (pid) {
    const hit = windows.find(w => String(w.pid) === pid);
    if (hit) return hit;
    throw new Error(`No visible window belongs to pid ${pid}. Run desktop.window_list.`);
  }
  if (rawTitle) {
    // The binder binds the whole goal here ("minimize the catfish window");
    // the titles we match are like "VLC media player" — strip operation
    // words, then token-match.
    const terms = titleTerms(rawTitle);
    if (terms.length === 0) {
      throw new Error(`No usable window name in "${rawTitle}". Name the app or window.`);
    }
    const scored = scoreWindows(windows, terms);
    if (scored.length > 0) return scored[0].w;
    throw new Error(`No visible window matches "${terms.join(' ')}". Run desktop.window_list.`);
  }
  throw new Error('Give one of: windowId, pid, or title.');
}

function windowObservation(kindLabel: string, w: XWindow, output: Record<string, unknown>) {
  return {
    output,
    observations: [{
      id: `observation-${Date.now()}`,
      kind: 'application' as const,
      source: 'desktop.native',
      subject: `window:${w.id}`,
      summary: `${kindLabel}: window "${w.title}" (id ${w.id}, pid ${w.pid}).`,
      data: output,
      confidence: 1,
      observedAt: new Date().toISOString(),
      relatedResourceIds: [],
    }],
  };
}

interface WindowSubject { windowId?: string; pid?: string; title?: string }

export const desktopWindowListTool: ToolDescriptor = {
  id: 'desktop.window_list',
  name: 'List windows',
  description: 'Lists all managed windows on the display (including hidden ones) with their ids, owning pids and titles. Read-only companion to the window state tools.',
  version: '1.0.0',
  domain: 'desktop',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Optional substring filter on window title.' },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      windows: { type: 'array' },
      capturedAt: { type: 'string' },
    },
    required: ['count', 'windows', 'capturedAt'],
  },
  capabilities: ['window-management', 'desktop'],
  supportedResourceKinds: ['unknown'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'desktop.native',
};

export const desktopWindowListImplementation: ToolImplementation = {
  toolId: desktopWindowListTool.id,

  async execute({ action }) {
    const filter = String(action.input.title ?? '').toLowerCase().trim();
    const all = await listXWindows();
    // filter may be a whole bound goal ("minimize the catfish window") —
    // normalize to app-name terms the same way window state actions do.
    const terms = filter ? titleTerms(filter) : [];
    const matched = terms.length > 0 ? scoreWindows(all, terms).map(s => s.w) : all;
    const windows = matched
      .map(w => ({ id: w.id, pid: w.pid, title: w.title }));
    const output = { count: windows.length, windows, truncated: all.length >= 25, capturedAt: new Date().toISOString() };
    if (terms.length > 0 && windows.length === 0 && all.length > 0) {
      throw new Error(`No visible window matches "${terms.join(' ')}". ${all.length} visible windows exist.`);
    }
    return {
      output,
      observations: [{
        id: `observation-${Date.now()}`,
        kind: 'application' as const,
        source: 'desktop.native',
        subject: 'x-windows',
        summary: `Listed ${windows.length} visible window(s).`,
        data: output,
        confidence: 1,
        observedAt: output.capturedAt,
        relatedResourceIds: [],
      }],
    };
  },
};

function makeWindowStateTool(id: string, name: string, verb: string): ToolDescriptor {
  return {
    id,
    name,
    description: `${verb[0].toUpperCase()}${verb.slice(1)} an existing window by window id, owning pid, or title substring. Never launches or kills anything. Use desktop.window_list to find ids.`,
    version: '1.0.0',
    domain: 'desktop',
    risk: 'reversible',
    available: true,
    inputSchema: {
      type: 'object',
      properties: {
        windowId: { type: 'string', description: 'X window id (decimal), from desktop.window_list.' },
        pid: { type: 'string', description: 'Owning process id.' },
        title: { type: 'string', description: 'Title substring match (first match wins).' },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string' }, pid: { type: 'number' }, done: { type: 'boolean' }, capturedAt: { type: 'string' },
      },
      required: ['window', 'pid', 'done', 'capturedAt'],
    },
    capabilities: ['window-management', 'desktop'],
    supportedResourceKinds: ['unknown'],
    requiredPermissions: [],
    reversible: true,
    metadata: {},
    provider: 'desktop.native',
  };
}

async function windowStateAction(subject: WindowSubject, verb: 'show' | 'minimize' | 'maximize') {
  const windows = await listXWindows(60);
  const w = matchXWindow(subject, windows);
  if (verb === 'show') {
    await execFileAsync('xdotool', ['windowactivate', '--sync', w.id], { timeout: 10000 });
    return windowObservation('Showed', w, { window: w.id, pid: w.pid, title: w.title, done: true, capturedAt: new Date().toISOString() });
  }
  if (verb === 'minimize') {
    await execFileAsync('xdotool', ['windowminimize', w.id], { timeout: 10000 });
    return windowObservation('Minimized', w, { window: w.id, pid: w.pid, title: w.title, done: true, capturedAt: new Date().toISOString() });
  }
  // Maximize: activate first (un-minimizes + raises — the user asking for a
  // hidden window to be maximized expects to SEE it), then the real EWMH
  // ClientMessage (no wmctrl here).
  await execFileAsync('xdotool', ['windowactivate', '--sync', w.id], { timeout: 10000 });
  await execFileAsync('python3', [EWMH_SCRIPT, 'maximize', w.id], { timeout: 10000 });
  return windowObservation('Maximized', w, { window: w.id, pid: w.pid, title: w.title, done: true, capturedAt: new Date().toISOString() });
}

export const desktopWindowShowTool = makeWindowStateTool('desktop.window_show', 'Show window', 'raise, focus and un-minimize');
export const desktopWindowMinimizeTool = makeWindowStateTool('desktop.window_minimize', 'Minimize window', 'minimize');
export const desktopWindowMaximizeTool = makeWindowStateTool('desktop.window_maximize', 'Maximize window', 'maximize');

export const desktopWindowShowImplementation: ToolImplementation = {
  toolId: 'desktop.window_show',
  async execute({ action }) { return windowStateAction(action.input as WindowSubject, 'show'); },
};
export const desktopWindowMinimizeImplementation: ToolImplementation = {
  toolId: 'desktop.window_minimize',
  async execute({ action }) { return windowStateAction(action.input as WindowSubject, 'minimize'); },
};
export const desktopWindowMaximizeImplementation: ToolImplementation = {
  toolId: 'desktop.window_maximize',
  async execute({ action }) { return windowStateAction(action.input as WindowSubject, 'maximize'); },
};

async function resolveEntry(appId: string): Promise<DesktopEntry> {
  const entries = await scanDesktopEntries();
  const entry = entries.find(candidate => candidate.appId === appId.toLowerCase());
  if (!entry) {
    throw new Error(`App "${appId}" is not installed (no .desktop entry). Re-run discovery to refresh.`);
  }
  if (DESKTOP_LAUNCH_DENY_BINARIES.has(entry.binary)) {
    throw new Error(`Refused by policy: "${entry.binary}" is never launched.`);
  }
  return entry;
}

function resolveHomeJailed(rawFile: string): string {
  if (rawFile.includes('..')) throw new Error(`Refused: "${rawFile}" contains '..'.`);
  const home = os.homedir();
  const resolved = path.resolve(home, rawFile);
  if (resolved !== home && !resolved.startsWith(home + path.sep)) {
    throw new Error(`Refused: "${rawFile}" is outside the home directory.`);
  }
  return resolved;
}

export const desktopOpenFamilyImplementation: ToolImplementation = {
  toolId: DESKTOP_OPEN_PREFIX,

  async execute({ action }) {
    const appId = String(action.toolId).slice(DESKTOP_OPEN_PREFIX.length);
    const entry = await resolveEntry(appId);

    const targets: string[] = [];
    const rawUrl = action.input.url === undefined ? '' : String(action.input.url);
    const rawFile = action.input.file === undefined ? '' : String(action.input.file);
    if (rawUrl) {
      if (!entry.categories.includes('WebBrowser')) {
        throw new Error('Refused: URL opening is only supported for browser applications.');
      }
      if (!/^https?:\/\//i.test(rawUrl)) throw new Error('Refused: URL must start with http(s)://');
      targets.push(rawUrl);
    } else if (rawFile) {
      targets.push(resolveHomeJailed(rawFile));
    }

    const child = spawn(entry.argv[0], [...entry.argv.slice(1), ...targets], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0.0' },
    });
    child.unref();

    const target = rawUrl || rawFile || 'new window';
    const output = { app: appId, target, pid: child.pid ?? 0, capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'application',
          source: 'desktop.native',
          subject: appId,
          summary: `Opened ${entry.name} (${target}) (confirmation granted).`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const desktopCloseFamilyImplementation: ToolImplementation = {
  toolId: DESKTOP_CLOSE_PREFIX,

  async execute({ action }) {
    const appId = String(action.toolId).slice(DESKTOP_CLOSE_PREFIX.length);
    const entry = await resolveEntry(appId);

    let detail: string;
    try {
      await execFileAsync('pkill', ['-x', entry.binary], { timeout: 10000 });
      detail = `Sent SIGTERM to ${entry.binary}.`;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (/status 1|exit code 1|code['":\s]*1\b/i.test(message)) {
        detail = `${entry.name} is not running.`;
      } else {
        throw new Error(`Close failed: ${message}`);
      }
    }

    const output = { app: appId, closed: true, detail, capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'application',
          source: 'desktop.native',
          subject: appId,
          summary: `Closed ${entry.name} (confirmation granted).`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const desktopDiscoveryProvider: DiscoveryProvider = {
  id: 'desktop.native',
  name: 'Desktop applications provider',
  description: 'Discovers installed Linux desktop applications from .desktop files.',
  priority: 90,

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async discoverResources(): Promise<ResourceDescriptor[]> {
    const now = new Date().toISOString();
    return (await scanDesktopEntries()).map(entry => ({
      id: `desktop:${entry.appId}`,
      kind: 'application' as const,
      name: entry.name,
      state: 'available' as const,
      provider: 'desktop.native',
      capabilities: ['desktop-application'],
      discoveredAt: now,
      metadata: { binary: entry.binary, categories: entry.categories },
    }));
  },

  async discoverTools(): Promise<ToolDescriptor[]> {
    const entries = await scanDesktopEntries();
    return [
      desktopListAppsTool,
      desktopWindowListTool,
      desktopWindowShowTool,
      desktopWindowMinimizeTool,
      desktopWindowMaximizeTool,
      ...entries.flatMap(entry => [desktopOpenTool(entry), desktopCloseTool(entry)]),
    ];
  },
};
