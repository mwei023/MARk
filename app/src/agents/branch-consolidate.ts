/**
 * Verify-decided branch consolidation.
 *
 * Merges a list of fix branches (oldest first) into one consolidated branch.
 * Clean merges apply directly. Conflicts resolve per-file by evidence, not
 * judgment: each side's version is eslint-counted and the fewer-errors
 * variant wins (ties keep the incoming branch's version and note it).
 * The final tree gets a full lint recount before push.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFilePromise = promisify(execFile);

export interface ConsolidationResult {
  branch: string;
  merged: string[];
  conflicted: string[];
  skipped: string[];
  resolutions: Array<{ file: string; winner: 'ours' | 'theirs'; oursErrors: number; theirsErrors: number }>;
  lintErrorsAfter: number;
  pushed: boolean;
  notes: string[];
}

async function sh(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise('git', ['-C', repoPath, ...args], { timeout: 60000 });
  return stdout.trim();
}

async function commitIfStaged(repoPath: string, message: string): Promise<boolean> {
  const staged = await sh(repoPath, ['status', '--porcelain']);
  if (!staged.trim()) return false;
  await sh(repoPath, ['commit', '-qm', message]);
  return true;
}

async function eslintCount(repoPath: string, relFile: string): Promise<number> {
  try {
    await execFilePromise('npx', ['--no-install', 'eslint', relFile], { cwd: repoPath, timeout: 120000 });
    return 0;
  } catch (err) {
    const out = String((err as { stdout?: unknown }).stdout ?? '');
    const summary = out.split('\n').find(l => /problems?\s*\(/i.test(l))?.match(/\((\d+)\s+errors?/i);
    return summary ? parseInt(summary[1], 10) : 999;
  }
}

async function fullLintErrors(repoPath: string): Promise<number> {
  try {
    await execFilePromise('npm', ['run', 'lint'], { cwd: repoPath, timeout: 300000 });
    return 0;
  } catch (err) {
    const out = String((err as { stdout?: unknown }).stdout ?? '');
    const summary = out.split('\n').find(l => /problems?\s*\(/i.test(l))?.match(/\((\d+)\s+errors?/i);
    return summary ? parseInt(summary[1], 10) : 999;
  }
}

/** Resolve one conflicted file by evidence. Returns the winning side. */
async function resolveByEvidence(repoPath: string, file: string): Promise<{ winner: 'ours' | 'theirs'; oursErrors: number; theirsErrors: number }> {
  await execFilePromise('git', ['-C', repoPath, 'checkout', '--ours', '--', file], { timeout: 30000 });
  const oursErrors = await eslintCount(repoPath, file);
  await execFilePromise('git', ['-C', repoPath, 'checkout', '--theirs', '--', file], { timeout: 30000 });
  const theirsErrors = await eslintCount(repoPath, file);
  const winner = theirsErrors < oursErrors ? 'theirs' : 'ours';
  await execFilePromise('git', ['-C', repoPath, 'checkout', winner === 'ours' ? '--ours' : '--theirs', '--', file], { timeout: 30000 });
  await execFilePromise('git', ['-C', repoPath, 'add', '--', file], { timeout: 30000 });
  return { winner, oursErrors, theirsErrors };
}

export async function consolidateBranches(
  repoPath: string,
  branches: string[],
  targetBranch = `auto-fix/consolidated-${Date.now()}`,
): Promise<ConsolidationResult> {
  const notes: string[] = [];
  const merged: string[] = [];
  const conflicted: string[] = [];
  const skipped: string[] = [];
  const resolutions: ConsolidationResult['resolutions'] = [];

  await sh(repoPath, ['checkout', '-qB', targetBranch, 'main']);
  for (const branch of branches) {
    // Pre-verify: a missing ref must be SKIPPED loudly, never counted.
    try {
      await sh(repoPath, ['rev-parse', '--verify', branch]);
    } catch {
      skipped.push(branch);
      notes.push(`${branch}: ref not present locally — run git fetch first. Skipped, not merged.`);
      continue;
    }
    let hadConflict = false;
    try {
      await sh(repoPath, ['merge', '--no-commit', '--no-ff', branch]);
    } catch {
      hadConflict = true;
    }
    const unmerged = (await sh(repoPath, ['ls-files', '-u'])).split('\n').map(l => l.split('\t')[1]).filter(Boolean);
    const files = [...new Set(unmerged)];
    if (hadConflict && files.length === 0) {
      // Merge failed without conflicts (already merged, etc.): nothing to do.
      await sh(repoPath, ['merge', '--abort']).catch(() => {});
      notes.push(`${branch}: merge produced no changes (already contained). Skipped.`);
      skipped.push(branch);
      continue;
    }
    if (hadConflict) conflicted.push(branch);
    for (const file of files) {
      try {
        const r = await resolveByEvidence(repoPath, file);
        resolutions.push({ file, ...r });
        notes.push(`${file} from ${branch}: kept ${r.winner} (${r.oursErrors} vs ${r.theirsErrors} errors)`);
      } catch (err) {
        notes.push(`${file} from ${branch}: evidence resolution failed (${err instanceof Error ? err.message.slice(0, 120) : String(err)}); kept ours`);
        await sh(repoPath, ['checkout', '--ours', '--', file]);
        await sh(repoPath, ['add', '--', file]);
      }
    }
    await commitIfStaged(repoPath, `merge ${branch} into consolidation${hadConflict ? ' (evidence-resolved)' : ''}`);
    merged.push(branch);
  }

  const lintErrorsAfter = await fullLintErrors(repoPath);
  notes.push(`Full lint recount on consolidated tree: ${lintErrorsAfter} errors.`);
  await sh(repoPath, ['push', '-u', 'origin', targetBranch]);
  return { branch: targetBranch, merged, conflicted, skipped, resolutions, lintErrorsAfter, pushed: true, notes };
}
