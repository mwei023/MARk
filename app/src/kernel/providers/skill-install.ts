/**
 * Agent-skill installer (skill.install): fetch + write in one tool.
 *
 * Installing a skill is read (fetch SKILL.md over https) plus write (mkdir,
 * write file) with data flowing between the steps. The kernel resolves and
 * binds one tool per goal and has no cross-step dataflow, so a three-tool
 * plan (browser.read → fs.directory_create → fs.file_write) can never be
 * composed from "install the X skill" — resolution fell through to
 * screen.type on thin overlap instead. This tool owns the whole procedure
 * behind one descriptor, following the media.extract_track precedent
 * (fetch bytes, write to a local cache dir).
 *
 * Risk is reversible (creates files, removes nothing): confirmation-gated
 * under both authority profiles, never denied. Jail and validation mirror
 * fs.file_write: owner/name repos only, skill names without separators,
 * destinations inside the working directory, credential paths refused.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DiscoveryProvider,
  ToolDescriptor,
  ToolImplementation,
} from '../index';

const FETCH_TIMEOUT_MS = 20000;
const MAX_FILE_BYTES = 100 * 1024;
const BRANCHES = ['main', 'master'];
/** Companion files copied alongside SKILL.md when present. */
const EXTRA_FILES = ['LICENSE'];

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SKILL_RE = /^[A-Za-z0-9_.-]+$/;
const SENSITIVE_DEST = ['shadow', 'gshadow', '.ssh', 'id_rsa', 'id_ed25519', '.pem', '.env'];

function failOutput(reason: string): Record<string, unknown> {
  return { ok: false, reason: reason.slice(0, 300), capturedAt: new Date().toISOString() };
}

function jail(dest: string, workingDirectory: string | undefined): { base: string; resolved: string } {
  if (!dest) throw new Error('A destination directory is required.');
  const base = path.resolve(workingDirectory ?? process.cwd());
  const resolved = path.resolve(base, dest);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Refused: "${dest}" escapes the working directory.`);
  }
  const lowered = resolved.toLowerCase();
  if (SENSITIVE_DEST.some(pattern => lowered.includes(pattern))) {
    throw new Error(`Refused: "${dest}" looks like a sensitive path.`);
  }
  return { base, resolved };
}

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'MARK/1.0 (skill installer)', Accept: 'text/plain,text/markdown,*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = response.ok ? await response.text() : '';
  return { status: response.status, text };
}

export const skillInstallTool: ToolDescriptor = {
  id: 'skill.install',
  name: 'Install agent skill',
  description:
    'Installs an agent skill (SKILL.md) from a GitHub skills repository into the local agent skills directory. Use to install, add, or set up a skill or plugin from a repo.',
  version: '1.0.0',
  domain: 'skills',
  risk: 'reversible',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'GitHub skills repository in owner/name form, e.g. typesafe-ai/skills.' },
      skill: { type: 'string', description: 'Skill directory name inside the repository skills folder, e.g. typesafe-ai.' },
      dest: { type: 'string', description: 'Destination directory for the installed skill, relative to the working directory. Defaults to .agents/skills/<skill>.' },
      overwrite: { type: 'boolean', description: 'Allow overwriting an already installed skill (default false).' },
    },
    required: ['repo', 'skill'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      skill: { type: 'string' },
      repo: { type: 'string' },
      path: { type: 'string' },
      files: { type: 'array' },
      bytesWritten: { type: 'number' },
      overwritten: { type: 'boolean' },
      capturedAt: { type: 'string' },
    },
    required: ['skill', 'repo', 'path', 'files', 'bytesWritten', 'capturedAt'],
  },
  capabilities: ['skill-installation', 'local-environment'],
  supportedResourceKinds: ['directory'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'skill.native',
};

export const skillInstallImplementation: ToolImplementation = {
  toolId: skillInstallTool.id,

  async execute({ action, context }) {
    const repo = String(action.input.repo ?? '').trim();
    const skill = String(action.input.skill ?? '').trim();
    if (!REPO_RE.test(repo)) {
      return { output: failOutput(`Refused: repo must be owner/name, got ${JSON.stringify(repo).slice(0, 80)}.`) };
    }
    if (!SKILL_RE.test(skill)) {
      return { output: failOutput(`Refused: skill must be a plain directory name, got ${JSON.stringify(skill).slice(0, 80)}.`) };
    }
    const dest = String(action.input.dest ?? `.agents/skills/${skill}`).trim();
    let dir: string;
    try {
      ({ resolved: dir } = jail(dest, context.workingDirectory));
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }

    // Fetch SKILL.md first: a missing skill fails before anything is written.
    let skillText = '';
    let hitBranch = '';
    for (const branch of BRANCHES) {
      const url = `https://raw.githubusercontent.com/${repo}/${branch}/skills/${skill}/SKILL.md`;
      try {
        const { status, text } = await fetchText(url);
        if (status === 200 && text.trim().length > 0) {
          skillText = text;
          hitBranch = branch;
          break;
        }
        if (status !== 404) {
          return { output: failOutput(`Fetch failed for ${repo} skill ${skill}: HTTP ${status}.`) };
        }
      } catch (err) {
        return { output: failOutput(`Fetch failed for ${repo} skill ${skill}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}.`) };
      }
    }
    if (!skillText) {
      return { output: failOutput(`Skill "${skill}" not found in ${repo} (checked branches ${BRANCHES.join(', ')}).`) };
    }
    // A skill file carries frontmatter with a name field; anything else is
    // the wrong bytes (error page, redirect stub) and must not be installed.
    if (!/^---[\s\S]{0,2000}?\bname\s*:/m.test(skillText.slice(0, 4000))) {
      return { output: failOutput(`Refused: fetched SKILL.md for "${skill}" has no skill frontmatter (not a skill file).`) };
    }
    if (Buffer.byteLength(skillText, 'utf8') > MAX_FILE_BYTES) {
      return { output: failOutput(`Refused: SKILL.md for "${skill}" exceeds the ${MAX_FILE_BYTES} byte cap.`) };
    }

    const files: Record<string, string> = { 'SKILL.md': skillText };
    for (const extra of EXTRA_FILES) {
      try {
        const { status, text } = await fetchText(
          `https://raw.githubusercontent.com/${repo}/${hitBranch}/skills/${skill}/${extra}`,
        );
        if (status === 200 && text.trim().length > 0 && Buffer.byteLength(text, 'utf8') <= MAX_FILE_BYTES) {
          files[extra] = text;
        }
      } catch {
        // Companion files are best-effort; SKILL.md is the install.
      }
    }

    const overwrite = action.input.overwrite === true;
    try {
      const stats = await fs.stat(path.join(dir, 'SKILL.md'));
      if (stats.isFile() && !overwrite) {
        return { output: failOutput(`"${skill}" is already installed at ${dir}; pass overwrite: true to replace it.`) };
      }
    } catch {
      // Not installed yet — proceed.
    }

    await fs.mkdir(dir, { recursive: true });
    let bytesWritten = 0;
    const written: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content, 'utf8');
      bytesWritten += Buffer.byteLength(content, 'utf8');
      written.push(name);
    }
    const output = {
      ok: true,
      skill,
      repo,
      path: dir,
      files: written,
      bytesWritten,
      overwritten: overwrite,
      capturedAt: new Date().toISOString(),
    };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'file',
          source: 'skill.native',
          subject: dir,
          summary: `Installed skill "${skill}" from ${repo} to ${dir} (${written.join(', ')}, confirmation granted).`,
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const skillInstallTools: ToolDescriptor[] = [skillInstallTool];
export const skillInstallImplementations: ToolImplementation[] = [skillInstallImplementation];

export const skillListTool: ToolDescriptor = {
  id: 'skill.list',
  name: 'List agent skills',
  description:
    'Lists the agent skills present in the local skills directories, with their names and descriptions. Use to answer what skills you have, which are present, or what is available.',
  version: '1.0.0',
  domain: 'skills',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  outputSchema: {
    type: 'object',
    properties: {
      skills: { type: 'array' },
      directories: { type: 'array' },
      capturedAt: { type: 'string' },
    },
    required: ['skills', 'directories', 'capturedAt'],
  },
  capabilities: ['skill-discovery', 'local-environment'],
  supportedResourceKinds: ['directory'],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'skill.native',
};

async function readSkillName(skillFile: string): Promise<{ name: string; description: string } | undefined> {
  try {
    const text = await fs.readFile(skillFile, 'utf8');
    const front = text.match(/^---\n([\s\S]{0,2000}?)\n---/);
    const name = front?.[1].match(/^\s*name\s*:\s*(.+?)\s*$/m)?.[1]?.trim() ?? path.basename(path.dirname(skillFile));
    const description = front?.[1].match(/^\s*description\s*:(\s*>)?\s*\n?((?:[ \t]+.*\n?)+)/m)?.[2]?.replace(/\s+/g, ' ').trim().slice(0, 200) ?? '';
    return { name, description };
  } catch {
    return undefined;
  }
}

export const skillListImplementation: ToolImplementation = {
  toolId: skillListTool.id,

  async execute({ context }) {
    const base = path.resolve(context.workingDirectory ?? process.cwd());
    const home = process.env.HOME ?? os.homedir();
    const candidates = [path.join(base, '.agents', 'skills'), path.join(home, '.agents', 'skills')];
    const skills: Array<{ name: string; description: string; path: string }> = [];
    const scanned: string[] = [];
    for (const dir of candidates) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      scanned.push(dir);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const info = await readSkillName(path.join(dir, entry.name, 'SKILL.md'));
        if (info) skills.push({ ...info, path: path.join(dir, entry.name) });
      }
    }
    const output = { skills, directories: scanned, capturedAt: new Date().toISOString() };
    return {
      output,
      observations: [
        {
          id: `observation-${Date.now()}`,
          kind: 'file',
          source: 'skill.native',
          subject: 'installed-skills',
          summary: skills.length > 0
            ? `Installed skills (${skills.length}): ${skills.map(s => s.name).join(', ')}.`
            : 'No installed skills found in the local skills directories.',
          data: output,
          confidence: 1,
          observedAt: output.capturedAt,
          relatedResourceIds: [],
        },
      ],
    };
  },
};

export const skillTools: ToolDescriptor[] = [skillInstallTool, skillListTool];
export const skillImplementations: ToolImplementation[] = [skillInstallImplementation, skillListImplementation];

export const skillInstallDiscoveryProvider: DiscoveryProvider = {
  id: 'skill.native',
  name: 'Agent skill installer',
  description: 'Installs versioned agent skills from GitHub skills repositories.',
  priority: 80,

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async discoverResources(): Promise<never[]> {
    return [];
  },

  async discoverTools(): Promise<ToolDescriptor[]> {
    return skillTools;
  },
};
