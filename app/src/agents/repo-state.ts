/**
 * Explicit world-state assessment: what is true about the repo BEFORE acting.
 *
 * Planning without state is guessing. This module answers "what state am I
 * in?" as structured data so plans, diagnoses, and repairs can condition on
 * it: investigation skips probes whose preconditions fail, diagnosis prefers
 * state-consistent causes, and auto-fix ensures readiness (dependencies
 * installed) instead of failing mid-repair.
 */
import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { promisify } from 'util';

const execFilePromise = promisify(execFile);

export interface WorldState {
  repoPath: string;
  hasCheckout: boolean;
  cleanTree: boolean | null;
  recentCommit: string | null;
  hasPackageJson: boolean;
  scripts: string[];
  hasChecks: boolean;
  hasNodeModules: boolean;
  nodeVersion: string | null;
  /** True when every repair precondition holds. */
  repairReady: boolean;
  /** Human-readable blockers when repairReady is false. */
  blockers: string[];
}

async function sh(bin: string, args: string[], cwd: string, timeout = 15000): Promise<string | null> {
  try {
    const { stdout } = await execFilePromise(bin, args, { cwd, timeout });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Assess the world. Read-only, bounded (~4 fast commands), never throws —
 * unknown fields stay null and callers treat null as "cannot assume".
 */
export async function assessWorldState(repoPath: string): Promise<WorldState> {
  const state: WorldState = {
    repoPath,
    hasCheckout: false,
    cleanTree: null,
    recentCommit: null,
    hasPackageJson: false,
    scripts: [],
    hasChecks: false,
    hasNodeModules: false,
    nodeVersion: null,
    repairReady: false,
    blockers: [],
  };

  if (!repoPath || !existsSync(`${repoPath}/.git`)) {
    state.blockers.push('no git checkout at repoPath');
    return state;
  }
  state.hasCheckout = true;

  const [status, log, node] = await Promise.all([
    sh('git', ['-C', repoPath, 'status', '--porcelain'], repoPath),
    sh('git', ['-C', repoPath, 'log', '--oneline', '-1'], repoPath),
    sh('node', ['-e', 'console.log(process.version)'], repoPath),
  ]);
  state.cleanTree = status === '' ? true : status === null ? null : false;
  state.recentCommit = log && log.length > 0 ? log : null;
  state.nodeVersion = node && node.length > 0 ? node : null;

  try {
    const pkg = JSON.parse(readFileSync(`${repoPath}/package.json`, 'utf8'));
    state.hasPackageJson = true;
    state.scripts = Object.keys(pkg?.scripts ?? {});
    state.hasChecks = Boolean(pkg?.scripts?.lint ?? pkg?.scripts?.test ?? pkg?.scripts?.typecheck);
  } catch {
    state.blockers.push('no readable package.json');
  }

  state.hasNodeModules = existsSync(`${repoPath}/node_modules`);

  // Repair preconditions: checkout + package + installed deps + node.
  // Each missing piece is a named blocker, not a mid-repair surprise.
  if (!state.hasPackageJson) state.blockers.push('no package.json: cannot run repo commands');
  else {
    if (!state.hasNodeModules) state.blockers.push('node_modules missing: install dependencies first');
    if (!state.nodeVersion) state.blockers.push('node runtime unavailable');
  }
  state.repairReady = state.blockers.length === 0;
  return state;
}

/** One-paragraph rendering for incident findings. */
export function formatWorldState(state: WorldState): string {
  const parts = [
    `checkout: ${state.hasCheckout ? 'yes' : 'NO'}`,
    `tree: ${state.cleanTree === null ? 'unknown' : state.cleanTree ? 'clean' : 'dirty'}`,
    `HEAD: ${state.recentCommit ?? 'unknown'}`,
    `node: ${state.nodeVersion ?? 'missing'}`,
    `deps: ${state.hasNodeModules ? 'installed' : 'MISSING'}`,
    `checks: ${state.hasChecks ? state.scripts.filter(s => ['lint', 'test', 'typecheck'].includes(s)).join(',') : 'none'}`,
    `repair-ready: ${state.repairReady ? 'yes' : 'NO (' + state.blockers.join('; ') + ')'}`,
  ];
  return `State assessment: ${parts.join(' | ')}.`;
}
