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
    if (!entry || entry.includes('..') || path.isAbsolute(entry)) {
      throw new Error(`Refused: invalid archive entry "${entry}".`);
    }

    // Verify membership against a fresh listing: only listed tracks extract.
    const listed = await listArchiveEntries(archive);
    if (!listed.includes(entry)) {
      throw new Error(`Refused: "${entry}" is not a listed track in "${path.basename(archive)}".`);
    }

    await fs.mkdir(TRACK_CACHE, { recursive: true });
    const dest = path.join(TRACK_CACHE, path.basename(entry));

    try {
      await fs.stat(dest);
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
    }

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

export const mediaNativeTools: ToolDescriptor[] = [mediaFindTracksTool, mediaExtractTrackTool];

export const mediaNativeImplementations: ToolImplementation[] = [
  mediaFindTracksImplementation,
  mediaExtractTrackImplementation,
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
