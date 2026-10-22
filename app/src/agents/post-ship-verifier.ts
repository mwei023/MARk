import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFilePromise = promisify(execFile);

export type PostShipStatus = 'passed' | 'skipped' | 'rolled_back' | 'failed';

export interface PostShipResult {
  status: PostShipStatus;
  detail: string;
}

interface WorkflowRun {
  status?: string;
  conclusion?: string | null;
  databaseId?: number;
  headSha?: string;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise('git', ['-C', repoPath, ...args], { timeout: 15000 });
  return stdout.trim();
}

function isGitHubRemote(remote: string): boolean {
  return /github\.com[/:]/i.test(remote);
}

async function rollbackBranch(repoPath: string, branch: string, originalBranch: string): Promise<PostShipResult> {
  try {
    await git(repoPath, ['push', 'origin', '--delete', branch]);
    await git(repoPath, ['checkout', originalBranch]);
    return {
      status: 'rolled_back',
      detail: `Deleted failed auto-fix branch ${branch}; restored local branch ${originalBranch}.`,
    };
  } catch (error) {
    return {
      status: 'failed',
      detail: `CI failed for ${branch}, but rollback could not complete: ${error instanceof Error ? error.message.slice(0, 220) : String(error)}`,
    };
  }
}

/**
 * Verify the remote workflow after an auto-ship. Non-GitHub remotes are
 * already covered by the local verification gate. GitHub branches must have
 * a completed successful Actions run; failed/unknown runs are rolled back.
 */
export async function verifyPostShip(
  repoPath: string,
  branch: string,
  originalBranch: string,
): Promise<PostShipResult> {
  let remote = '';
  try {
    remote = await git(repoPath, ['remote', 'get-url', 'origin']);
  } catch {
    return { status: 'skipped', detail: 'No origin remote; local verification remains the ship gate.' };
  }
  if (!isGitHubRemote(remote)) {
    return { status: 'skipped', detail: 'Origin is not GitHub; local verification gate passed.' };
  }

  const pushedSha = await git(repoPath, ['rev-parse', 'HEAD']);
  const deadline = Date.now() + config.markShipCiTimeoutMs;
  let lastRun: WorkflowRun | undefined;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFilePromise(
        'gh',
        ['run', 'list', '--branch', branch, '--limit', '5', '--json', 'status,conclusion,databaseId,headSha'],
        { cwd: repoPath, timeout: 15000 },
      );
      const runs = JSON.parse(stdout) as WorkflowRun[];
      lastRun = runs.find(run => run.headSha === pushedSha);
      if (lastRun?.status === 'completed') {
        if (lastRun.conclusion === 'success') {
          return { status: 'passed', detail: `GitHub Actions run ${lastRun.databaseId ?? 'unknown'} passed for ${branch}.` };
        }
        return rollbackBranch(repoPath, branch, originalBranch);
      }
    } catch (error) {
      // Authentication/tooling failures are not a clean workflow result. Do
      // not pretend success; continue polling until the bounded deadline.
      lastRun = undefined;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  const rollback = await rollbackBranch(repoPath, branch, originalBranch);
  return {
    status: rollback.status,
    detail: `No completed successful GitHub Actions run before timeout (${config.markShipCiTimeoutMs}ms). ` +
      `${lastRun?.status ? `Last status: ${lastRun.status}. ` : ''}${rollback.detail}`,
  };
}
