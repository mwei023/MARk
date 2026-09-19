/**
 * Ops verification tools (ops.verify_*): richer verification before resolve.
 *
 * Ladder: lint count → type errors → scoped tests. Each tool is read-only
 * (never mutates source) and returns structured { ok, counts } output so
 * plans can gate on verification instead of assuming success.
 *
 * Timeouts are hard; toolchain breakage returns ok:false with a reason,
 * never masquerades as "zero errors".
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import type { DiscoveryProvider } from '../tool-discovery';
import type { ToolDescriptor, ToolImplementation } from '../index';

const execFilePromise = promisify(execFile);
const LINT_TIMEOUT = 120000;
const TSC_TIMEOUT = 180000;
const TEST_TIMEOUT = 180000;

function okOutput(extra: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, capturedAt: new Date().toISOString(), ...extra };
}

function failOutput(reason: string): Record<string, unknown> {
  return { ok: false, reason: reason.slice(0, 300), capturedAt: new Date().toISOString() };
}

function requireRepoPath(input: Record<string, unknown>): string | null {
  const p = typeof input.repoPath === 'string' ? input.repoPath.trim() : '';
  if (!p) return null;
  try {
    return existsSync(p) && statSync(p).isDirectory() ? p : null;
  } catch {
    return null;
  }
}

const verifyLintTool: ToolDescriptor = {
  id: 'ops.verify_lint',
  name: 'Verify lint',
  description:
    'Counts ESLint errors in a checkout (or single file). Verification gate: fixed counts as improved only when this drops.',
  version: '1.0.0',
  domain: 'verification',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
      file: { type: 'string', description: 'Optional repo-relative file to check.' },
    },
    required: ['repoPath'],
  },
  capabilities: ['verification', 'local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'ops.verify',
};

const verifyLintImplementation: ToolImplementation = {
  toolId: verifyLintTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    const file = typeof action.input.file === 'string' ? action.input.file.trim() : '';
    if (file.includes('..')) return { output: failOutput('refused: path escapes the checkout') };
    const target = file ? file.replace(/^\//, '') : '.';
    try {
      await execFilePromise('npx', ['--no-install', 'eslint', target, '--format', 'json'], {
        cwd: repoPath,
        timeout: LINT_TIMEOUT,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { output: okOutput({ errors: 0, target }) };
    } catch (err: unknown) {
      const raw = String((err as { stdout?: unknown }).stdout ?? '');
      if (!raw.trim()) {
        const errText = String((err as { stderr?: unknown }).stderr ?? '').split('\n').find(l => /error/i.test(l))?.trim().slice(0, 120);
        const hint = errText ? ` — ${errText}` : '';
        return { output: failOutput(`eslint produced no output (exit ${(err as { code?: unknown }).code})${hint}; toolchain may be missing`) };
      }
      try {
        const files = JSON.parse(raw) as Array<{ messages: Array<{ severity: number }> }>;
        let errors = 0;
        for (const f of files) for (const m of f.messages) if (m.severity === 2) errors += 1;
        return { output: okOutput({ errors, target }) };
      } catch {
        return { output: failOutput('eslint output unparseable') };
      }
    }
  },
};

const verifyTypesTool: ToolDescriptor = {
  id: 'ops.verify_types',
  name: 'Verify types',
  description:
    'Counts TypeScript errors via the repo config. Null-safe: returns available:false when no tsconfig or broken toolchain.',
  version: '1.0.0',
  domain: 'verification',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
    },
    required: ['repoPath'],
  },
  capabilities: ['verification', 'local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'ops.verify',
};

const verifyTypesImplementation: ToolImplementation = {
  toolId: verifyTypesTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    const cfg = existsSync(`${repoPath}/tsconfig.app.json`)
      ? 'tsconfig.app.json'
      : existsSync(`${repoPath}/tsconfig.json`)
        ? 'tsconfig.json'
        : null;
    if (!cfg) return { output: { ...okOutput({}), available: false, errors: null, reason: 'no tsconfig' } };
    try {
      await execFilePromise('npx', ['--no-install', 'tsc', '--noEmit', '-p', cfg], {
        cwd: repoPath,
        timeout: TSC_TIMEOUT,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { output: okOutput({ available: true, errors: 0, config: cfg }) };
    } catch (err: unknown) {
      const out =
        String((err as { stdout?: unknown }).stdout ?? '') +
        String((err as { stderr?: unknown }).stderr ?? '');
      const matches = out.match(/error TS\d+/g);
      if (matches) return { output: okOutput({ available: true, errors: matches.length, config: cfg }) };
      return { output: { ...failOutput('tsc toolchain broken or no diagnostics'), available: false } };
    }
  },
};

const verifyTestsTool: ToolDescriptor = {
  id: 'ops.verify_tests',
  name: 'Verify tests',
  description:
    'Runs scoped vitest in a checkout (npx vitest run, optional filter). Read-mostly verification: reports pass/fail, never mutates source.',
  version: '1.0.0',
  domain: 'verification',
  risk: 'read',
  available: true,
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: { type: 'string', description: 'Local repository path.' },
      filter: { type: 'string', description: 'Optional vitest file filter (no flags, max 120 chars).' },
    },
    required: ['repoPath'],
  },
  capabilities: ['verification', 'local-environment'],
  supportedResourceKinds: [],
  requiredPermissions: [],
  reversible: true,
  metadata: {},
  provider: 'ops.verify',
};

const verifyTestsImplementation: ToolImplementation = {
  toolId: verifyTestsTool.id,
  async execute({ action }) {
    const repoPath = requireRepoPath(action.input);
    if (!repoPath) return { output: failOutput('no local checkout at repoPath') };
    const rawFilter = typeof action.input.filter === 'string' ? action.input.filter.trim().slice(0, 120) : '';
    if (rawFilter.startsWith('-')) return { output: failOutput('refused: filter must not be a flag') };
    const args = ['--no-install', 'vitest', 'run'];
    if (rawFilter) args.push(rawFilter);
    try {
      const { stdout } = await execFilePromise('npx', args, {
        cwd: repoPath,
        timeout: TEST_TIMEOUT,
        maxBuffer: 8 * 1024 * 1024,
      });
      const tail = stdout.slice(-1500);
      const passed = /Test Files.*passed|Tests.*passed/i.test(stdout);
      return { output: okOutput({ passed, tail, filter: rawFilter || null }) };
    } catch (err: unknown) {
      const out =
        String((err as { stdout?: unknown }).stdout ?? '') +
        String((err as { stderr?: unknown }).stderr ?? '');
      const tail = out.slice(-1500);
      return { output: okOutput({ passed: false, tail, filter: rawFilter || null }) };
    }
  },
};

export const opsVerifyTools: ToolDescriptor[] = [verifyLintTool, verifyTypesTool, verifyTestsTool];

export const opsVerifyImplementations: ToolImplementation[] = [
  verifyLintImplementation,
  verifyTypesImplementation,
  verifyTestsImplementation,
];

export const opsVerifyDiscoveryProvider: DiscoveryProvider = {
  id: 'ops.verify',
  name: 'Ops verification tools',
  description: 'Richer verification gates: lint, types, scoped tests.',
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async discoverResources(): Promise<[]> {
    return [];
  },
  async discoverTools(): Promise<ToolDescriptor[]> {
    return opsVerifyTools;
  },
};
