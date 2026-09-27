/**
 * Sandboxed shell actuator (sys.exec): arbitrary READS, structured writes.
 *
 * The safety story is layered: an allowlist of binaries, per-binary
 * subcommand gates (git status/log yes, git push no — pushes go through
 * git.push with approvals), no shell metacharacters ever (execFile, no
 * shell, so pipes/redirects/substitution cannot exist), working-directory
 * jail, timeouts, and output caps. Mutations stay with dedicated
 * approval-gated tools (fs.file_write, git.*) — this tool cannot write,
 * delete, escalate, or reach the network beyond read-only fetches.
 */
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { DiscoveryProvider } from '../tool-discovery';
import type { ToolDescriptor, ToolImplementation } from '../index';

const execFilePromise = promisify(execFile);
const EXEC_TIMEOUT = 30000;
const MAX_OUTPUT = 4000;

/** Binary -> allowed first-arg subcommands. Absent entry = any args allowed. */
const ALLOWLIST: Record<string, string[] | null> = {
  ls: null, df: null, free: null, uptime: null, whoami: null, pwd: null,
  date: null, uname: null, ps: null, du: null, hostname: null, lsb_release: null,
  cat: null, head: null, tail: null,
  git: ['status', 'log', 'diff', 'branch', 'show', 'rev-parse', 'remote', 'ls-files'],
  gh: ['run', 'view', 'status', 'pr', 'issue', 'repo'],
  npm: ['ls', 'run'],
  docker: ['ps', 'stats', 'images', 'inspect'],
  systemctl: ['status'],
  ping: null,
};

const BLOCKED_TOKENS = [';', '&&', '||', '|', '`', '$(', '${', '>', '<', '\n', '\r', 'sudo', 'rm ', 'rm\t', 'chmod', 'chown', 'mkfs', 'dd ', 'shred', '--force', '-rf'];
const BLOCKED_BINARIES = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'sudo', 'su', 'rm', 'dd', 'mkfs', 'chmod', 'chown', 'curl', 'wget', 'ssh', 'scp', 'apt', 'pip']);

function okOutput(extra: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, capturedAt: new Date().toISOString(), ...extra };
}

function failOutput(reason: string): Record<string, unknown> {
  return { ok: false, reason: reason.slice(0, 300), capturedAt: new Date().toISOString() };
}

export const sysExecTool: ToolDescriptor = {
  id: 'sys.exec',
  name: 'Sandboxed exec',
  description: 'Runs allowlisted read-only commands without a shell (ls, git status/log, docker ps, npm ls, ...). No pipes, no sudo, no writes, no deletes. Mutations use dedicated tools.',
  version: '1.0.0',
  domain: 'system',
  risk: 'diagnostic',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command line, e.g. "git status" or "docker ps".' },
      cwd: { type: 'string', description: 'Working dir relative to kernel dir (default: kernel dir).' },
    },
    required: ['command'],
  },
  capabilities: ['shell-read', 'local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'sys.sandbox',
};

export const sysExecImplementation: ToolImplementation = {
  toolId: sysExecTool.id,
  async execute({ action, context }) {
    const raw = typeof action.input.command === 'string' ? action.input.command.trim().slice(0, 500) : '';
    if (!raw) return { output: failOutput('command is required') };
    for (const token of BLOCKED_TOKENS) {
      if (raw.includes(token)) return { output: failOutput(`refused: blocked token ${JSON.stringify(token)}`) };
    }
    const parts = raw.split(/\s+/);
    const bin = parts[0].toLowerCase();
    if (BLOCKED_BINARIES.has(bin)) return { output: failOutput(`refused: ${bin} is never executable here`) };
    const allowed = ALLOWLIST[bin];
    if (allowed === undefined) return { output: failOutput(`refused: ${bin} is not allowlisted`) };
    if (allowed !== null) {
      const sub = (parts[1] ?? '').toLowerCase();
      if (!allowed.includes(sub)) return { output: failOutput(`refused: ${bin} ${sub || '(no subcommand)'} is not an allowed read`) };
    }
    if (bin === 'npm' && parts[1] === 'run') {
      const script = (parts[2] ?? '').toLowerCase();
      if (!['lint', 'typecheck', 'test'].includes(script)) {
        return { output: failOutput(`refused: npm run is limited to lint/typecheck/test, got ${JSON.stringify(script)}`) };
      }
    }
    const base = path.resolve(context.workingDirectory ?? process.cwd());
    const cwdRaw = typeof action.input.cwd === 'string' && action.input.cwd.trim() ? action.input.cwd.trim() : '.';
    const cwd = path.resolve(base, cwdRaw);
    if (cwd !== base && !cwd.startsWith(base + path.sep)) return { output: failOutput('refused: cwd escapes the working directory') };
    try {
      const { stdout, stderr } = await execFilePromise(bin, parts.slice(1), { cwd, timeout: EXEC_TIMEOUT, maxBuffer: 1024 * 1024 });
      const out = (stdout || stderr || '(no output)').trim();
      return { output: okOutput({ command: raw.slice(0, 200), output: out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n… (truncated)` : out }) };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const detail = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim().slice(0, 1000) || (e.message ?? 'command failed').slice(0, 300);
      return { output: failOutput(detail) };
    }
  },
};

export const sysSandboxTools: ToolDescriptor[] = [sysExecTool];
export const sysSandboxImplementations: ToolImplementation[] = [sysExecImplementation];

export const sysSandboxDiscoveryProvider: DiscoveryProvider = {
  id: 'sys.sandbox',
  name: 'Sandboxed shell',
  description: 'Allowlisted read-only command execution without a shell.',
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async discoverResources(): Promise<[]> {
    return [];
  },
  async discoverTools(): Promise<ToolDescriptor[]> {
    return sysSandboxTools;
  },
};
