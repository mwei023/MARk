/**
 * Git-deploy tools (git.*): give MARK its own deploy actuators so shipping
 * does not need human hands. Prior to this provider MARK could prepare files
 * but never push bytes off the machine (observed live: a deploy order died
 * in git-agent with "Which repository?").
 *
 * All four tools are mutating: the kernel confirmation gate applies, and
 * MARK_TEST_MODE auto-approves in testing. No force-push exists anywhere:
 * push moves the current branch to the named remote only. Every repo path
 * is jailed to the kernel working directory, same as fs.* tools.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { DiscoveryProvider } from '../tool-discovery';
import type { ToolDescriptor, ToolImplementation } from '../index';
import { repositoryRegistry } from '../../repositories/registry';

const execFilePromise = promisify(execFile);
const GIT_TIMEOUT = 120000;
const MAX_MESSAGE = 500;

function okOutput(extra: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, capturedAt: new Date().toISOString(), ...extra };
}

function jail(repoPath: unknown, workingDirectory: string | undefined): string {
  const raw = typeof repoPath === 'string' ? repoPath.trim() : '';
  if (!raw) throw new Error('repoPath is required.');
  const base = path.resolve(workingDirectory ?? process.cwd());
  const resolved = path.resolve(base, raw);
  if (resolved === base || resolved.startsWith(base + path.sep)) return resolved;
  // Registered repositories are addressable even above the working dir:
  // MARK tracks its own checkouts (e.g. jarvis-core itself), and committing
  // there must not require dropping the jail. Anything else stays refused.
  // Observed live: MARK could ship a site folder but not its own codebase.
  try {
    const known = repositoryRegistry.resolve(resolved);
    if (known?.localPath && path.resolve(known.localPath) === resolved) return resolved;
  } catch { /* registry is best-effort; fall through to refusal */ }
  throw new Error(`Refused: "${raw}" escapes the working directory.`);
}

async function run(bin: string, args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFilePromise(bin, args, { cwd, timeout: GIT_TIMEOUT, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const detail = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`.trim().slice(0, 800);
    throw new Error(detail || `${bin} failed`);
  }
}

/** Commits carry an identity even on machines without git config. */
async function identityFlags(cwd: string): Promise<string[]> {
  try {
    const email = await run('git', ['config', 'user.email'], cwd);
    if (email) return [];
  } catch {
    // No identity configured — fall through to flags below.
  }
  return ['-c', 'user.name=MARK', '-c', 'user.email=mark@localhost'];
}

const gitInitTool: ToolDescriptor = {
  id: 'git.init',
  name: 'Git init',
  description: 'Initializes a git repository at repoPath (inside the working directory). Fails when already a repo.',
  version: '1.0.0',
  domain: 'deploy',
  risk: 'mutating',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Directory to initialize, relative to the working directory.' },
      branch: { type: 'string', description: 'Initial branch name (default main).' },
    },
    required: ['repoPath'],
  },
  capabilities: ['vcs', 'local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: false,
  metadata: {},
  provider: 'git.deploy',
};

const gitInitImplementation: ToolImplementation = {
  toolId: gitInitTool.id,
  async execute({ action, context }) {
    const dir = jail(action.input.repoPath, context.workingDirectory);
    const branch = typeof action.input.branch === 'string' && action.input.branch.trim()
      ? action.input.branch.trim().slice(0, 100)
      : 'main';
    if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error('Refused: invalid branch name.');
    if (existsSync(`${dir}/.git`)) throw new Error(`Refused: "${dir}" is already a git repository.`);
    const out = await run('git', ['init', '-b', branch, dir], path.dirname(dir));
    return { output: okOutput({ repoPath: dir, branch, detail: out.slice(0, 300) }) };
  },
};

const gitCommitTool: ToolDescriptor = {
  id: 'git.commit',
  name: 'Git commit',
  description: 'Stages all changes and commits with a message. Message capped at 500 chars; empty commits refused.',
  version: '1.0.0',
  domain: 'deploy',
  risk: 'mutating',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Repository path, relative to the working directory.' },
      message: { type: 'string', description: 'Commit message (required, max 500 chars).' },
    },
    required: ['repoPath', 'message'],
  },
  capabilities: ['vcs', 'local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: false,
  metadata: {},
  provider: 'git.deploy',
};

const gitCommitImplementation: ToolImplementation = {
  toolId: gitCommitTool.id,
  async execute({ action, context }) {
    const dir = jail(action.input.repoPath, context.workingDirectory);
    if (!existsSync(`${dir}/.git`)) throw new Error(`Refused: "${dir}" is not a git repository.`);
    const message = typeof action.input.message === 'string' ? action.input.message.trim().slice(0, MAX_MESSAGE) : '';
    if (!message) throw new Error('Commit message is required.');
    const flags = await identityFlags(dir);
    await run('git', [...flags, 'add', '-A'], dir);
    const status = await run('git', ['status', '--porcelain'], dir);
    if (!status) throw new Error('Nothing to commit: working tree is clean.');
    await run('git', [...flags, 'commit', '-m', message], dir);
    const sha = await run('git', ['rev-parse', '--short', 'HEAD'], dir);
    return { output: okOutput({ repoPath: dir, sha, message: message.slice(0, 200) }) };
  },
};

const gitPushTool: ToolDescriptor = {
  id: 'git.push',
  name: 'Git push',
  description: 'Pushes the current branch to the named remote. Never force-pushes: no force flag exists.',
  version: '1.0.0',
  domain: 'deploy',
  risk: 'mutating',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Repository path, relative to the working directory.' },
      remote: { type: 'string', description: 'Remote name (default origin).' },
      branch: { type: 'string', description: 'Branch to push (default: current branch).' },
    },
    required: ['repoPath'],
  },
  capabilities: ['vcs', 'network-egress'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: false,
  metadata: {},
  provider: 'git.deploy',
};

const gitPushImplementation: ToolImplementation = {
  toolId: gitPushTool.id,
  async execute({ action, context }) {
    const dir = jail(action.input.repoPath, context.workingDirectory);
    if (!existsSync(`${dir}/.git`)) throw new Error(`Refused: "${dir}" is not a git repository.`);
    const remote = typeof action.input.remote === 'string' && action.input.remote.trim()
      ? action.input.remote.trim().slice(0, 100)
      : 'origin';
    if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error('Refused: invalid remote name.');
    let branch = typeof action.input.branch === 'string' ? action.input.branch.trim().slice(0, 100) : '';
    if (branch && !/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error('Refused: invalid branch name.');
    if (!branch) branch = await run('git', ['branch', '--show-current'], dir);
    if (!branch) throw new Error('Cannot determine current branch (detached HEAD?).');
    const out = await run('git', ['push', '-u', remote, branch], dir);
    return { output: okOutput({ repoPath: dir, remote, branch, detail: out.slice(0, 500) }) };
  },
};

const ghRepoCreateTool: ToolDescriptor = {
  id: 'gh.repo_create',
  name: 'GitHub repo create',
  description: 'Creates a GitHub repo via gh and wires it as origin. Private by default. Never deletes or renames.',
  version: '1.0.0',
  domain: 'deploy',
  risk: 'mutating',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository to link as source.' },
      name: { type: 'string', description: 'Repo name, optionally owner/name.' },
      private: { type: 'boolean', description: 'Private repo (default true).' },
      description: { type: 'string', description: 'Repo description (max 300 chars).' },
    },
    required: ['repoPath', 'name'],
  },
  capabilities: ['vcs', 'network-egress'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: false,
  metadata: {},
  provider: 'git.deploy',
};

const ghRepoCreateImplementation: ToolImplementation = {
  toolId: ghRepoCreateTool.id,
  async execute({ action, context }) {
    const dir = jail(action.input.repoPath, context.workingDirectory);
    if (!existsSync(`${dir}/.git`)) throw new Error(`Refused: "${dir}" is not a git repository. Run git.init first.`);
    const name = typeof action.input.name === 'string' ? action.input.name.trim().slice(0, 200) : '';
    if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/.test(name)) throw new Error('Refused: invalid repo name.');
    const isPrivate = action.input.private !== false;
    const description = typeof action.input.description === 'string'
      ? action.input.description.trim().slice(0, 300)
      : '';
    const args = ['repo', 'create', name, isPrivate ? '--private' : '--public', '--source', dir];
    if (description) args.push('--description', description);
    const out = await run('gh', args, dir);
    return { output: okOutput({ repoPath: dir, name, private: isPrivate, detail: out.slice(0, 500) }) };
  },
};

export const gitDeployTools: ToolDescriptor[] = [gitInitTool, gitCommitTool, gitPushTool, ghRepoCreateTool];

export const gitDeployImplementations: ToolImplementation[] = [
  gitInitImplementation,
  gitCommitImplementation,
  gitPushImplementation,
  ghRepoCreateImplementation,
];

export const gitDeployDiscoveryProvider: DiscoveryProvider = {
  id: 'git.deploy',
  name: 'Git deploy tools',
  description: 'MARK-owned deploy actuators: init, commit, push, repo create. Mutating, approval-gated.',
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async discoverResources(): Promise<[]> {
    return [];
  },
  async discoverTools(): Promise<ToolDescriptor[]> {
    return gitDeployTools;
  },
};
