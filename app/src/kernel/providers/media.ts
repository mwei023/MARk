import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DiscoveryProvider,
  ToolDescriptor,
  ToolImplementation,
} from '../index';

const execFileAsync = promisify(execFile);

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.ogg', '.oga', '.wav', '.m4a', '.opus', '.aac']);
const MUSIC_LIBRARY = `${os.homedir()}/Music`;
const TRACK_CACHE = `${os.homedir()}/.cache/mark-music`;
const EXTRACT_MAX_BYTES = 200 * 1024 * 1024;

export interface FoundTrack {
  kind: 'file' | 'archive-entry';
  name: string;
  path?: string;
  archive?: string;
  entry?: string;
}

async function walkAudioFiles(root: string, depth: number, out: FoundTrack[]): Promise<void> {
  if (depth < 0) return;
  let dirents;
  try {
    dirents = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  dirents.sort((a, b) => a.name.localeCompare(b.name));
  for (const dirent of dirents) {
    const full = path.join(root, dirent.name);
    if (dirent.isFile() && AUDIO_EXTENSIONS.has(path.extname(dirent.name).toLowerCase())) {
      out.push({ kind: 'file', name: dirent.name, path: full });
    } else if (dirent.isDirectory()) {
      await walkAudioFiles(full, depth - 1, out);
    }
  }
}

async function listArchiveEntries(archive: string): Promise<string[]> {
  // Fixed arguments only: -Z1 lists names without extracting anything.
  const { stdout } = await execFileAsync('unzip', ['-Z1', archive], { timeout: 15000 });
  return String(stdout)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && AUDIO_EXTENSIONS.has(path.extname(line).toLowerCase()))
    .sort();
}

export async function findTracks(root: string, query: string, limit: number): Promise<FoundTrack[]> {
  const found: FoundTrack[] = [];
  await walkAudioFiles(root, 2, found);

  let archives: string[] = [];
  try {
    archives = (await fs.readdir(root))
      .filter(name => /\.zip$/i.test(name))
      .sort()
      .map(name => path.join(root, name));
  } catch {
    archives = [];
  }
  for (const archive of archives) {
    let entries: string[];
    try {
      entries = await listArchiveEntries(archive);
    } catch {
      continue;
    }
    for (const entry of entries) {
      found.push({ kind: 'archive-entry', name: path.basename(entry), archive, entry });
    }
  }

  const terms = query.toLowerCase().trim();
  const matched = !terms
    ? found
    : found.filter(track => track.name.toLowerCase().includes(terms));
  return matched.slice(0, limit);
}

function resolveLibraryArchive(rawArchive: string): string {
  const resolved = path.resolve(MUSIC_LIBRARY, rawArchive);
  if (resolved !== MUSIC_LIBRARY && !resolved.startsWith(MUSIC_LIBRARY + path.sep)) {
    throw new Error(`Refused: "${rawArchive}" is outside the music library.`);
  }
  if (!/\.zip$/i.test(resolved)) throw new Error(`Refused: "${rawArchive}" is not a zip archive.`);
  return resolved;
}

export const mediaFindTracksTool: ToolDescriptor = {
  id: 'media.find_tracks',
  name: 'Find music tracks',
  description: 'Finds music tracks to play from the local music library, including tracks inside zip archives.',
  version: '1.0.0',
  domain: 'media',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional substring matched against track file names.' },
      limit: { type: 'number', description: 'Maximum tracks to return (1-50, default 20).' },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      count: { type: 'number' },
      tracks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            name: { type: 'string' },
            path: { type: 'string' },
            archive: { type: 'string' },
            entry: { type: 'string' },
          },
          required: ['kind', 'name'],
        },
      },
      capturedAt: { type: 'string' },
    },
    required: ['count', 'tracks', 'capturedAt'],
  },
  capabilities: ['music-discovery', 'media'],
  supportedResourceKinds: ['unknown'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'media.native',
};

export const mediaFindTracksImplementation: ToolImplementation = {
  toolId: mediaFindTracksTool.id,

  async execute({ action }) {
    const query = typeof action.input.query === 'string' ? action.input.query : '';
    const requested = typeof action.input.limit === 'number' ? Math.floor(action.input.limit) : 20;
    const limit = Math.min(Math.max(requested, 1), 50);

    const tracks = await findTracks(MUSIC_LIBRARY, query, limit);
    const output = {
      count: tracks.length,
      tracks: tracks.map(track => ({
        kind: track.kind,
        name: track.name,
        ...(track.path ? { path: track.path } : {}),
        ...(track.archive ? { archive: track.archive } : {}),
        ...(track.entry ? { entry: track.entry } : {}),
      })),
      capturedAt: new Date().toISOString(),
    };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'output',
          source: 'media.native',
          subject: 'music-library',
          summary: `Found ${tracks.length} tracks${query ? ` matching "${query}"` : ''}.`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const mediaExtractTrackTool: ToolDescriptor = {
  id: 'media.extract_track',
  name: 'Extract music track',
  description: 'Extracts one audio track from a music library zip archive into the local track cache.',
  version: '1.0.0',
  domain: 'media',
  risk: 'reversible',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      archive: { type: 'string', description: 'Zip archive file name inside the music library.' },
      entry: { type: 'string', description: 'Track path inside the archive, as listed by find_tracks.' },
    },
    required: ['archive', 'entry'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      capturedAt: { type: 'string' },
    },
    required: ['path', 'capturedAt'],
  },
  capabilities: ['music-extraction', 'media'],
  supportedResourceKinds: ['unknown'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'media.native',
};

export const mediaExtractTrackImplementation: ToolImplementation = {
  toolId: mediaExtractTrackTool.id,

  async execute({ action }) {
    const archive = resolveLibraryArchive(String(action.input.archive ?? ''));
    const entry = String(action.input.entry ?? '');
    assertListedEntry(entry);
    const dest = await extractListedTrack(archive, entry);

    const output = { path: dest, capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'file',
          source: 'media.native',
          subject: dest,
          summary: `Extracted "${entry}" to the track cache (confirmation granted).`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

/** Guards shared by extract and play: listed members only, no escapes. */
function assertListedEntry(entry: string): void {
  if (!entry || entry.includes('..') || path.isAbsolute(entry)) {
    throw new Error(`Refused: invalid archive entry "${entry}".`);
  }
}

async function extractListedTrack(archive: string, entry: string): Promise<string> {
  // Verify membership against a fresh listing: only listed tracks extract.
  const listed = await listArchiveEntries(archive);
  if (!listed.includes(entry)) {
    throw new Error(`Refused: "${entry}" is not a listed track in "${path.basename(archive)}".`);
  }

  await fs.mkdir(TRACK_CACHE, { recursive: true });
  const dest = path.join(TRACK_CACHE, path.basename(entry));

  try {
    await fs.stat(dest);
    return dest;
  } catch {
    // Stream bytes straight from unzip to disk: fixed argv, no shell.
    const chunks: Buffer[] = [];
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      const child = spawn('unzip', ['-p', archive, entry], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', reject);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > EXTRACT_MAX_BYTES) {
          child.kill();
          reject(new Error('Refused: track exceeds the extraction size cap.'));
          return;
        }
        chunks.push(chunk);
      });
      child.on('close', code => {
        if (code !== 0) {
          reject(new Error(`Extraction failed for "${entry}".`));
          return;
        }
        fs.writeFile(dest, Buffer.concat(chunks)).then(() => resolve(), reject);
      });
    });
    return dest;
  }
}

const PLAY_STARTUP_WAIT_MS = 1500;
const activePlayers = new Map<number, ReturnType<typeof spawn>>();

function resolvePlayableFile(rawPath: string): string {
  if (!rawPath) throw new Error('A file path is required to play.');
  const jails = [path.resolve(MUSIC_LIBRARY), path.resolve(TRACK_CACHE)];
  const resolved = path.resolve(rawPath);
  if (!jails.some(jail => resolved === jail || resolved.startsWith(jail + path.sep))) {
    throw new Error(`Refused: "${rawPath}" is outside the music library and track cache.`);
  }
  if (!AUDIO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    throw new Error(`Refused: "${resolved}" is not a supported audio file.`);
  }
  return resolved;
}

async function pickPlayer(): Promise<{ command: string; args: string[]; name: string }> {
  for (const candidate of [
    { command: 'mpv', args: ['--no-video', '--really-quiet'], name: 'mpv' },
    { command: 'cvlc', args: ['--play-and-exit', '--quiet'], name: 'vlc' },
  ]) {
    try {
      await execFileAsync(candidate.command, ['--version'], { timeout: 10000 });
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('No audio player found (looked for mpv, vlc).');
}

export const mediaPlayTrackTool: ToolDescriptor = {
  id: 'media.play_track',
  name: 'Play music track',
  description: 'Plays one audio file from the music library or track cache, or an archive track (extracted first). Verifies the player is running.',
  version: '1.0.0',
  domain: 'media',
  risk: 'reversible',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Audio file inside the music library or track cache.' },
      archive: { type: 'string', description: 'Zip archive file name inside the music library (with entry).' },
      entry: { type: 'string', description: 'Track path inside the archive, as listed by find_tracks.' },
    },
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      player: { type: 'string' },
      pid: { type: 'number' },
      running: { type: 'boolean' },
      capturedAt: { type: 'string' },
    },
    required: ['file', 'player', 'pid', 'running', 'capturedAt'],
  },
  capabilities: ['music-playback', 'media'],
  supportedResourceKinds: ['unknown'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'media.native',
};

export const mediaPlayTrackImplementation: ToolImplementation = {
  toolId: mediaPlayTrackTool.id,

  async execute({ action }) {
    let file: string;
    const rawPath = String(action.input.path ?? '');
    if (rawPath) {
      file = resolvePlayableFile(rawPath);
      await fs.stat(file);
    } else {
      const archive = resolveLibraryArchive(String(action.input.archive ?? ''));
      const entry = String(action.input.entry ?? '');
      assertListedEntry(entry);
      file = await extractListedTrack(archive, entry);
    }

    const player = await pickPlayer();
    const child = spawn(player.command, [...player.args, file], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('spawn', () => resolve());
    });
    if (child.pid === undefined) throw new Error('Player process failed to spawn.');
    activePlayers.set(child.pid, child);
    child.unref();

    await new Promise(resolve => setTimeout(resolve, PLAY_STARTUP_WAIT_MS));
    let running = true;
    try {
      process.kill(child.pid, 0);
    } catch {
      running = false;
      activePlayers.delete(child.pid);
    }
    if (!running) throw new Error(`Player ${player.name} exited within ${PLAY_STARTUP_WAIT_MS}ms — playback did not start.`);

    const output = { file, player: player.name, pid: child.pid, running, capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'output',
          source: 'media.native',
          subject: file,
          summary: `Playing "${path.basename(file)}" via ${player.name} (pid ${child.pid}, verified running; confirmation granted).`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },

  async verify({ output }) {
    const pid = Number((output as any)?.pid ?? NaN);
    const file = String((output as any)?.file ?? '');
    if (!Number.isFinite(pid)) return { ok: false, detail: 'no player pid in output to verify' };
    try {
      process.kill(pid, 0);
      return { ok: true, detail: `player pid ${pid} playing "${path.basename(file)}" is alive` };
    } catch {
      activePlayers.delete(pid);
      return { ok: false, detail: `player pid ${pid} is gone — playback stopped` };
    }
  },
};

export const mediaNativeTools: ToolDescriptor[] = [mediaFindTracksTool, mediaExtractTrackTool, mediaPlayTrackTool];

export const mediaNativeImplementations: ToolImplementation[] = [
  mediaFindTracksImplementation,
  mediaExtractTrackImplementation,
  mediaPlayTrackImplementation,
];

export const mediaDiscoveryProvider: DiscoveryProvider = {
  id: 'media.native',
  name: 'Media library provider',
  description: 'Discovers playable tracks in the local music library.',
  priority: 85,

  async isAvailable(): Promise<boolean> {
    try {
      await fs.stat(MUSIC_LIBRARY);
      return true;
    } catch {
      return false;
    }
  },

  async discoverResources(): Promise<never[]> {
    return [];
  },

  async discoverTools(): Promise<ToolDescriptor[]> {
    return mediaNativeTools;
  },
};
