/**
 * Investigation tools (ops.investigate): the read-only evidence gatherers
 * behind incident triage, exposed as kernel tools so the planner can compose
 * them into investigation plans instead of agents hardcoding probe order.
 *
 * All tools are risk 'read': they never mutate. Failures return
 * { ok: false } output instead of throwing, so one unavailable probe does
 * not fail the whole plan.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { DiscoveryProvider } from '../tool-discovery';
import type { ToolDescriptor, ToolImplementation } from '../index';
import { classifyFailure } from '../../core/failure-classifier';

const execFilePromise = promisify(execFile);
const PROBE_TIMEOUT = 15000;

function okOutput(extra: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, capturedAt: new Date().toISOString(), ...extra };
}

function failOutput(reason: string): Record<string, unknown> {
  return { ok: false, reason: reason.slice(0, 300), capturedAt: new Date().toISOString() };
}

async function run(bin: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFilePromise(bin, args, { cwd, timeout: PROBE_TIMEOUT });
  return stdout.trim().slice(0, 2000);
}

function requireRepoPath(input: Record<string, unknown>): string | null {
  const p = typeof input.repoPath === 'string' ? input.repoPath.trim() : '';
  return p && existsSync(p) ? p : null;
}

const gitLogTool: ToolDescriptor = {
  id: 'investigate.git_log',
  name: 'Recent commits',
  description: 'Returns recent commit history (oneline) for a local repository checkout. First probe: what changed before the failure.',
  version: '1.0.0',
  domain: 'investigation',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
      n: { type: 'number', description: 'How many commits (default 5, max 10).' },
    },
    required: ['repoPath'],
  },
  capabilities: ['local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'ops.investigate',
};

const gitLogImplementation: ToolImplementation = {
  toolId: gitLogTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    const n = Math.min(Math.max(typeof action.input.n === 'number' ? Math.floor(action.input.n) : 5, 1), 10);
    try {
      const commits = await run('git', ['-C', repoPath, 'log', `--oneline`, `-${n}`], repoPath);
      return { output: okOutput({ commits: commits || '(no commits)' }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

const gitStatusTool: ToolDescriptor = {
  id: 'investigate.git_status',
  name: 'Working tree status',
  description: 'Returns uncommitted changes for a local checkout. A dirty tree is a prime suspect: it never went through CI.',
  version: '1.0.0',
  domain: 'investigation',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
    },
    required: ['repoPath'],
  },
  capabilities: ['local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'ops.investigate',
};

const gitStatusImplementation: ToolImplementation = {
  toolId: gitStatusTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    try {
      const status = await run('git', ['-C', repoPath, 'status', '--porcelain'], repoPath);
      return { output: okOutput({ dirty: status.length > 0, status: status.split('\n').slice(0, 10).join('\n') || '(clean)' }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

const packageScriptsTool: ToolDescriptor = {
  id: 'investigate.package_scripts',
  name: 'Declared scripts',
  description: 'Lists package.json scripts and whether automated checks (lint, test, typecheck) exist. A repo with no checks cannot fail code checks.',
  version: '1.0.0',
  domain: 'investigation',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
    },
    required: ['repoPath'],
  },
  capabilities: ['local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'ops.investigate',
};

const packageScriptsImplementation: ToolImplementation = {
  toolId: packageScriptsTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    try {
      const pkg = JSON.parse(readFileSync(`${repoPath}/package.json`, 'utf8'));
      const scripts = Object.keys(pkg?.scripts ?? {});
      const hasChecks = Boolean(pkg?.scripts?.lint ?? pkg?.scripts?.test ?? pkg?.scripts?.typecheck);
      return { output: okOutput({ scripts: scripts.join(', ') || '(no scripts)', hasChecks }) };
    } catch {
      return { output: failOutput('no readable package.json') };
    }
  },
};

const toolchainTool: ToolDescriptor = {
  id: 'investigate.toolchain',
  name: 'Toolchain versions',
  description: 'Reports node version and installed eslint/typescript/vite versions. Anchors dependency-mismatch diagnoses.',
  version: '1.0.0',
  domain: 'investigation',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
    },
    required: ['repoPath'],
  },
  capabilities: ['local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'ops.investigate',
};

const toolchainImplementation: ToolImplementation = {
  toolId: toolchainTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    let node = '';
    try {
      node = await run('node', ['-e', 'console.log(process.version)'], repoPath);
    } catch { /* node may be absent; npm ls below still helps */ }
    let deps = '';
    try {
      deps = await run('npm', ['ls', 'eslint', 'typescript', 'vite', '--depth=0'], repoPath);
    } catch (err) {
      // npm ls exits non-zero on problems while still printing the tree.
      deps = String((err as { stdout?: unknown }).stdout ?? '').trim().slice(0, 2000);
      if (!deps) return { output: okOutput({ node: node || '(unknown)', deps: '(npm ls unavailable)' }) };
    }
    return { output: okOutput({ node: node || '(unknown)', deps }) };
  },
};

const classifyTool: ToolDescriptor = {
  id: 'investigate.classify_failure',
  name: 'Classify failure text',
  description: 'Deterministically classifies failure text with confidence scores. Pure function: no checkout needed.',
  version: '1.0.0',
  domain: 'investigation',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Log or failure text to classify.' },
    },
    required: ['text'],
  },
  capabilities: [],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'ops.investigate',
};

const classifyImplementation: ToolImplementation = {
  toolId: classifyTool.id,
  async execute({ action }) {
    const text = typeof action.input.text === 'string' ? action.input.text : '';
    const result = classifyFailure(text);
    return { output: okOutput({ type: result.type, confidence: result.confidence, signals: result.signals }) };
  },
};

const diffStatTool: ToolDescriptor = {
  id: 'investigate.diff_stat',
  name: 'Commit diff stat',
  description: 'Returns the file-change summary for a commit. Shows the blast radius of the suspect change.',
  version: '1.0.0',
  domain: 'investigation',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
      commit: { type: 'string', description: 'Commit SHA.' },
    },
    required: ['repoPath', 'commit'],
  },
  capabilities: ['local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'ops.investigate',
};

const diffStatImplementation: ToolImplementation = {
  toolId: diffStatTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    const commit = typeof action.input.commit === 'string' ? action.input.commit.trim() : '';
    if (!repoPath || !commit) return { output: failOutput('repoPath and commit are required') };
    try {
      const stat = await run('git', ['-C', repoPath, 'show', '--stat', '--oneline', commit], repoPath);
      return { output: okOutput({ stat }) };
    } catch (err) {
      return { output: failOutput(err instanceof Error ? err.message : String(err)) };
    }
  },
};

export const investigateTools: ToolDescriptor[] = [
  gitLogTool,
  gitStatusTool,
  packageScriptsTool,
  toolchainTool,
  classifyTool,
  diffStatTool,
];

export const investigateImplementations: ToolImplementation[] = [
  gitLogImplementation,
  gitStatusImplementation,
  packageScriptsImplementation,
  toolchainImplementation,
  classifyImplementation,
  diffStatImplementation,
];

export const investigateDiscoveryProvider: DiscoveryProvider = {
  id: 'ops.investigate',
  name: 'Investigation tools',
  description: 'Read-only evidence gatherers for incident triage.',
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async discoverResources(): Promise<[]> {
    return [];
  },
  async discoverTools(): Promise<ToolDescriptor[]> {
    return investigateTools;
  },
};
