import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  DiscoveryProvider,
  ToolDescriptor,
  ToolImplementation,
  Observation,
} from '../index';
import { parseDuckResults } from './browser';

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

  // Term-overlap scoring: fragmented queries ("4 your eyez only immortal
  // j cole") match when most significant terms appear anywhere in the name,
  // not just as one contiguous substring. Stop-words excluded; all-events
  // with zero overlap score nothing.
  const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'to', 'in', 'on', 'my']);
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1 && !STOP.has(t));
  if (terms.length === 0) return found.slice(0, limit);
  const scored = found.map(track => {
    const name = track.name.toLowerCase();
    let hits = 0;
    for (const term of terms) {
      if (name.includes(term)) hits++;
    }
    return { track, score: hits / terms.length };
  }).filter(s => s.score >= 0.5);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.track);
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
// Streams need longer: extraction (yt-dlp) takes seconds, and a 1.5s check
// verified mpv mid-retry before it died. Slow sources get a second look.
const STREAM_STARTUP_WAIT_MS = 6000;
const activePlayers = new Map<number, ReturnType<typeof spawn>>();

/**
 * Strip command verbs and filler nouns from a bound music goal:
 * "play donda album" -> "donda". Domain words live with the tool that
 * owns the domain, not scattered across callers. Also detects album-like
 * requests, which need a user pick (no single stream IS an album).
 */
function normalizeMusicQuery(query: string): { terms: string; wantsAlbum: boolean } {
  const wantsAlbum = /\b(album|playlist|discography|full\s+album|complete\s+album)\b/i.test(query);
  const cleaned = query
    .replace(/\b(play|search|find|look\s?up|google|listen\s?to|put\s?on|start)\b/gi, ' ')
    .replace(/\b(album|song|track|music|video|playlist|discography|full\s+album|complete\s+album|on\s+youtube|from\s+youtube)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { terms: cleaned || query.trim(), wantsAlbum };
}

/**
 * Junk markers: titles carrying these are almost never the requested music
 * (type beats, podcasts, covers). Filtered before candidacy — playing a
 * "Donda Type Beat" and calling it Donda would be theater, not fulfillment.
 */
const JUNK_TITLE_MARKERS = /type beat|podcast|cover|instrumental|karaoke|tribute|reaction|review|interview|sped up|slowed|8d audio|bass boosted/i;

function isGenuineCandidate(title: string, uploader: string): boolean {
  return !JUNK_TITLE_MARKERS.test(`${title} ${uploader}`);
}
/**
 * Ordered stream candidates for a query: YouTube watch URL first (best
 * match when playable), then up to 2 Audius streams (independent catalog,
 * no key, no bot-wall observed). Junk-labeled tracks (type beats, podcasts,
 * covers) are filtered before candidacy. Callers try each in order until
 * one verifies running. Streaming only — nothing is downloaded.
 */
interface StreamCandidate {
  url: string;
  source: string;
}

async function searchStreamCandidates(query: string): Promise<StreamCandidate[]> {
  const candidates: StreamCandidate[] = [];
  try {
    const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${query} youtube`)}`;
    const response = await fetch(endpoint, {
      headers: { 'User-Agent': 'MARK/1.0 (local research tool)', Accept: 'text/html' },
      signal: AbortSignal.timeout(20000),
    });
    if (response.ok) {
      const html = Buffer.from(await response.arrayBuffer()).subarray(0, 200 * 1024).toString('utf8');
      const results = parseDuckResults(html, 10);
      const watch = results.find(r =>
        /youtube\.com\/watch\?v=|youtu\.be\//i.test(r.url) && isGenuineCandidate(r.title, r.snippet),
      );
      if (watch) candidates.push({ url: watch.url, source: `youtube (${watch.title.slice(0, 80)})` });
    }
  } catch { /* YouTube search failure just yields no candidate */ }
  try {
    const res = await fetch(
      `https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(query)}&limit=6`,
      { signal: AbortSignal.timeout(20000) },
    );
    if (res.ok) {
      const body = (await res.json()) as { data?: Array<{ id?: string; title?: string; user?: { name?: string } }> };
      for (const track of body.data ?? []) {
        if (typeof track.id !== 'string' || !track.id) continue;
        if (!isGenuineCandidate(track.title ?? '', track.user?.name ?? '')) continue;
        candidates.push({
          url: `https://discoveryprovider.audius.co/v1/tracks/${track.id}/stream`,
          source: `audius (${track.title ?? track.id})`,
        });
        if (candidates.length >= 3) break;
      }
    }
  } catch { /* Audius failure just yields no candidate */ }
  return candidates;
}

/** Top-level library entries for "what can I play" answers. Never throws. */
async function listLibraryTop(): Promise<string> {
  try {
    const entries = await fs.readdir(MUSIC_LIBRARY);
    const shown = entries.filter(e => !e.startsWith('.')).slice(0, 8);
    return shown.length > 0 ? shown.join(', ') : '(empty library)';
  } catch {
    return '(library unreadable)';
  }
}

function resolvePlayableFile(rawPath: string): string {  if (!rawPath) throw new Error('A file path is required to play.');
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
  description: 'Finds and plays music by name. Local library (files and zip archives) first; otherwise searches the web and streams the top video result. Verifies the player is running.',
  version: '1.1.0',
  domain: 'media',
  risk: 'reversible',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Audio file inside the music library or track cache.' },
      archive: { type: 'string', description: 'Zip archive file name inside the music library (with entry).' },
      entry: { type: 'string', description: 'Track path inside the archive, as listed by find_tracks.' },
      query: { type: 'string', description: 'Music name to find and play (library first, web stream fallback).' },
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

/**
 * Launch each candidate in order; keep the first still alive after the
 * stream verification window. Dead candidates are killed and named in the
 * trail. Returns the full action output for the winner.
 */
async function playFirstAlive(
  candidates: StreamCandidate[],
): Promise<{ output: Record<string, unknown>; observations: Observation[] } | null> {
  const player = await pickPlayer();
  for (const candidate of candidates) {
    const child = spawn(player.command, [...player.args, candidate.url], { detached: true, stdio: 'ignore' });
    await new Promise<void>(resolve => {
      child.on('error', () => resolve());
      child.on('spawn', () => resolve());
    });
    if (child.pid === undefined) continue;
    activePlayers.set(child.pid, child);
    child.unref();
    await new Promise(resolve => setTimeout(resolve, STREAM_STARTUP_WAIT_MS));
    let running = true;
    try {
      process.kill(child.pid, 0);
    } catch {
      running = false;
      activePlayers.delete(child.pid);
    }
    if (!running) continue;
    const output = {
      file: candidate.url, player: player.name, pid: child.pid, running,
      source: candidate.source, capturedAt: new Date().toISOString(),
    };
    return {
      output,
      observations: [{
        id: `observation-${Date.now()}`,
        kind: 'output',
        source: 'media.native',
        subject: candidate.url,
        summary: `Playing via ${candidate.source} on ${player.name} (pid ${child.pid}, verified running; confirmation granted).`,
        data: output,
        confidence: 1,
        observedAt: output.capturedAt,
        relatedResourceIds: [],
      }],
    };
  }
  return null;
}

export const mediaPlayTrackImplementation: ToolImplementation = {
  toolId: mediaPlayTrackTool.id,

  async execute({ action }) {
    let file: string;
    let source = 'library';
    const rawPath = String(action.input.path ?? '');
    const rawArchive = String(action.input.archive ?? '');
    const query = String(action.input.query ?? '').trim().slice(0, 200);
    if (!rawPath && !rawArchive && !query) {
      // No target at all: say what's actually playable instead of dying on
      // an empty archive check. This is the common "play <album>" dead end.
      throw new Error(`Nothing to play: no file specified. Library holds: ${await listLibraryTop()}. Use media.find_tracks to browse.`);
    }
    if (rawPath) {
      file = resolvePlayableFile(rawPath);
      await fs.stat(file);
    } else if (rawArchive) {
      const archive = resolveLibraryArchive(rawArchive);
      const entry = String(action.input.entry ?? '');
      assertListedEntry(entry);
      file = await extractListedTrack(archive, entry);
    } else {
      // Find-and-play: local library first, then ordered web candidates
      // (YouTube, then Audius). Each candidate is launched and verified;
      // the first one still alive wins. Failures name every tried source.
      const { terms: musicQuery, wantsAlbum } = normalizeMusicQuery(query);
      const local = await findTracks(MUSIC_LIBRARY, musicQuery, 5);
      if (local.length > 0) {
        const hit = local[0];
        if (hit.kind === 'file' && hit.path) {
          file = hit.path;
        } else {
          file = await extractListedTrack(
            resolveLibraryArchive(hit.archive!.split('/').pop()!),
            hit.entry!,
          );
        }
      } else {
        const candidates = await searchStreamCandidates(musicQuery);
        if (candidates.length === 0) {
          throw new Error(`Could not find "${musicQuery}" in the library or on the web. Library holds: ${await listLibraryTop()}.`);
        }
        if (wantsAlbum) {
          // No single stream IS an album. Playing a tribute and calling it
          // the album would be theater — hand the verified pick list back.
          const picks = candidates.slice(0, 5).map((c, i) => `${i + 1}) ${c.source}`).join('\n');
          throw new Error(
            `"${musicQuery}" asked as an album: no single stream fulfills that honestly. ` +
            (candidates.length > 0
              ? `Closest verified streams:\n${picks}\nReply with a number/title to play one, or drop the album in ~/Music.`
              : `Nothing found anywhere. Library holds: ${await listLibraryTop()}.`),
          );
        }
        const played = await playFirstAlive(candidates);
        if (!played) {
          throw new Error(
            `Found ${candidates.length} stream candidate(s) for "${musicQuery}" but none stayed playing ` +
            `(${candidates.map(c => c.source.slice(0, 80)).join(' | ')}). Likely causes: source bot-wall/rate-limit on this network.`,
          );
        }
        return played;
      }
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

    const output = { file, player: player.name, pid: child.pid, running, source, capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'output',
          source: 'media.native',
          subject: file,
          summary: `Playing "${source === 'library' ? path.basename(file) : file}" via ${player.name} (pid ${child.pid}, verified running; confirmation granted).`,
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
