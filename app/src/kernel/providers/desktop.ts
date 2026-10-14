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

const DESKTOP_SCAN_DIRS = ['/usr/share/applications', `${os.homedir()}/.local/share/applications`];

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
      ...entries.flatMap(entry => [desktopOpenTool(entry), desktopCloseTool(entry)]),
    ];
  },
};
