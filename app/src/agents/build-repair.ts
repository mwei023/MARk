import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve, relative } from 'node:path';

const execFilePromise = promisify(execFile);

export interface BuildRepairResult {
  fixed: boolean;
  detail: string;
  file?: string;
}

/**
 * Repairs one deliberately narrow, reversible Vite/Rollup failure:
 * an unused import whose local target does not exist. The build is the
 * authority; a text edit is never reported as a fix by itself.
 */
export async function repairMissingUnusedImport(repoPath: string, logs: string): Promise<BuildRepairResult> {
  const match = logs.match(/Could not resolve ["']([^"']+)["'] from ["']([^"']+)["']/i);
  if (!match) return { fixed: false, detail: 'Unsupported build diagnostic; no missing-import pattern found.' };

  const [, specifier, sourceName] = match;
  if (!specifier.startsWith('.')) return { fixed: false, detail: `Missing import is package-based (${specifier}); no source edit attempted.` };
  const sourcePath = resolve(repoPath, sourceName);
  if (!sourcePath.startsWith(resolve(repoPath) + '/') || !sourcePath.endsWith('.jsx') && !sourcePath.endsWith('.js')) {
    return { fixed: false, detail: 'Build diagnostic points outside a supported JavaScript source file.' };
  }

  const original = readFileSync(sourcePath, 'utf8');
  const importPattern = new RegExp(`^\\s*import\\s+([^;\\n]+?)\\s+from\\s+["']${escapeRegExp(specifier)}["']\\s*;?\\s*$`, 'm');
  const importMatch = original.match(importPattern);
  if (!importMatch) return { fixed: false, detail: `No matching import declaration found for ${specifier}.` };

  const binding = importMatch[1].trim().replace(/^type\\s+/, '').split(',')[0].trim();
  const withoutImport = original.replace(importMatch[0], '');
  const bindingUses = withoutImport.match(new RegExp(`\\b${escapeRegExp(binding)}\\b`, 'g'))?.length ?? 0;
  if (bindingUses > 0) return { fixed: false, detail: `Import ${binding} is used in ${relative(repoPath, sourcePath)}; removal is unsafe.` };

  writeFileSync(sourcePath, withoutImport);
  try {
    await execFilePromise('npm', ['run', 'build'], { cwd: repoPath, timeout: 180000 });
    return { fixed: true, file: relative(repoPath, sourcePath), detail: `Removed unused missing import ${specifier}; npm run build passed.` };
  } catch (error) {
    writeFileSync(sourcePath, original);
    return { fixed: false, file: relative(repoPath, sourcePath), detail: `Build still fails after the proposed edit; reverted it. ${error instanceof Error ? error.message.slice(0, 180) : String(error)}` };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
