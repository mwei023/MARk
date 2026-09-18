/**
 * Deterministic dependency-skew repair (no LLM needed).
 *
 * Version arithmetic, not guesswork: detects incompatible eslint /
 * @typescript-eslint pairings that crash the linter before it checks any
 * code, and upgrades the plugin within its declared major range.
 */
import { execFile } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { promisify } from 'util';

const execFilePromise = promisify(execFile);

export interface SkewRepairResult {
  detected: boolean;
  /** e.g. "eslint@9.39.4 with @typescript-eslint/eslint-plugin@8.11.0" */
  detail: string;
  applied: boolean;
  /** Install command that was run, if any. */
  command?: string;
  /** eslint exit code after repair (0 = clean, 1 = real violations, 2 = still crashing). */
  lintExitAfter?: number;
  notes: string[];
}

/** Installed version of a package: node_modules first (sees nested), npm ls fallback. */
async function installedVersion(repoPath: string, pkg: string): Promise<string | null> {
  try {
    const direct = JSON.parse(readFileSync(`${repoPath}/node_modules/${pkg}/package.json`, 'utf8'));
    if (typeof direct?.version === 'string') return direct.version;
  } catch { /* fall through to npm ls */ }
  try {
    const { stdout } = await execFilePromise('npm', ['ls', pkg, '--all', '--json'], { cwd: repoPath, timeout: 60000 });
    const tree = JSON.parse(stdout);
    const stack: unknown[] = [tree?.dependencies];
    while (stack.length > 0) {
      const deps = stack.pop() as Record<string, { version?: string; dependencies?: unknown }> | undefined;
      if (!deps || typeof deps !== 'object') continue;
      if (typeof deps[pkg]?.version === 'string') return deps[pkg].version as string;
      for (const child of Object.values(deps)) {
        if (child?.dependencies) stack.push(child.dependencies);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function major(version: string | null): number | null {
  if (!version) return null;
  const m = version.match(/^(\d+)\./);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Detect + repair the known eslint-9 / old-typescript-eslint-8 crash
 * (`Error while loading rule ... allowShortCircuit of undefined`).
 * Returns detected=false with notes when this skew is not present.
 */
export async function repairEslintTypescriptSkew(repoPath: string): Promise<SkewRepairResult> {
  const notes: string[] = [];
  const eslintVer = await installedVersion(repoPath, 'eslint');
  const pluginVer = await installedVersion(repoPath, '@typescript-eslint/eslint-plugin');
  const detail = `eslint@${eslintVer ?? '?'} with @typescript-eslint/eslint-plugin@${pluginVer ?? '?'}`;

  // Compat rule: typescript-eslint v8 tracks eslint 9 core. Plugin minors
  // below ~8.30 crash against eslint >= 9.30 core rule internals.
  const eslintMajor = major(eslintVer);
  const pluginMajor = major(pluginVer);
  const pluginMinor = pluginVer ? parseInt(pluginVer.split('.')[1] ?? '0', 10) : null;
  const skewed = eslintMajor === 9 && pluginMajor === 8 && pluginMinor !== null && pluginMinor < 30;

  if (!skewed) {
    return { detected: false, detail, applied: false, notes: ['No eslint-9/old-plugin-8 skew detected; crash (if any) has another cause.'] };
  }

  // Apply: latest plugin within major 8 (declared range ^8.0.1 already allows it).
  const command = 'npm install --no-audit --no-fund -D typescript-eslint@8';
  try {
    await execFilePromise('npm', ['install', '--no-audit', '--no-fund', '-D', 'typescript-eslint@8'], {
      cwd: repoPath, timeout: 300000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { detected: true, detail, applied: false, command, notes: [`Install failed: ${msg.slice(0, 300)}`] };
  }

  // Verify: re-run lint, classify the exit (0 clean / 1 violations / 2 crash).
  let lintExitAfter = -1;
  try {
    await execFilePromise('npm', ['run', 'lint'], { cwd: repoPath, timeout: 300000 });
    lintExitAfter = 0;
    notes.push('Post-repair lint exits 0 — crash resolved, no violations.');
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    lintExitAfter = typeof code === 'number' ? code : 1;
    const out = String((err as { stdout?: unknown }).stdout ?? '') + String((err as { stderr?: unknown }).stderr ?? '');
    if (/Error while loading rule/.test(out)) {
      notes.push('Linter still crashes loading a rule — skew persists or a second incompatibility exists.');
    } else {
      notes.push(`Crash resolved: lint now runs and reports real violations (exit ${lintExitAfter}).`);
    }
  }
  return { detected: true, detail, applied: true, command, lintExitAfter, notes };
}

/** Read declared devDependency range for a package, if present. */
export function declaredRange(repoPath: string, pkg: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(`${repoPath}/package.json`, 'utf8'));
    const range = parsed?.devDependencies?.[pkg] ?? parsed?.dependencies?.[pkg] ?? null;
    return typeof range === 'string' ? range : null;
  } catch {
    return null;
  }
}

export interface IgnoresRepairResult {
  applied: boolean;
  configFile: string;
  added: string[];
  /** Remaining "was not found" rule errors after repair (0 = fixed). */
  staleRuleErrorsAfter: number;
  notes: string[];
}

/**
 * Stop linting vendored/bundled output (dev-dist/, dist/): third-party
 * bundles carry disable-comments for rules outside the project's plugin
 * set, which eslint reports as "Definition for rule X was not found".
 * Deterministic text edit on the flat-config ignores block, verified by
 * recount. Reverts on verification failure.
 */
export async function ensureEslintIgnores(repoPath: string, dirs: string[] = ['dev-dist/']): Promise<IgnoresRepairResult> {
  const notes: string[] = [];
  const cfg = `${repoPath}/eslint.config.js`;
  let original: string;
  try {
    original = readFileSync(cfg, 'utf8');
  } catch {
    return { applied: false, configFile: cfg, added: [], staleRuleErrorsAfter: -1, notes: ['No eslint.config.js found.'] };
  }
  const countStale = async (): Promise<number> => {
    try {
      await execFilePromise('npx', ['--no-install', 'eslint', '.'], { cwd: repoPath, timeout: 180000 });
      return 0;
    } catch (err) {
      const out = String((err as { stdout?: unknown }).stdout ?? '');
      return (out.match(/Definition for rule '[^']+' was not found/g) ?? []).length;
    }
  };
  const before = await countStale();
  notes.push(`Stale-rule errors before repair: ${before}.`);
  if (before === 0) {
    return { applied: false, configFile: cfg, added: [], staleRuleErrorsAfter: 0, notes: [...notes, 'Nothing to fix.'] };
  }

  const m = original.match(/ignores:\s*\[([^\]]*)\]/);
  if (!m) {
    return { applied: false, configFile: cfg, added: [], staleRuleErrorsAfter: before, notes: [...notes, 'No ignores block found in config; refusing to guess structure.'] };
  }
  const have = m[1];
  const added = dirs.filter(d => !have.includes(`"${d}"`) && !have.includes(`'${d}'`));
  if (added.length === 0) {
    return { applied: false, configFile: cfg, added: [], staleRuleErrorsAfter: before, notes: [...notes, 'Directories already ignored; stale rules have another source.'] };
  }
  const quote = have.includes('"') ? '"' : "'";
  const updated = original.replace(m[0], `ignores: [${have.trimEnd().replace(/,?\s*$/, '')}, ${added.map(d => `${quote}${d}${quote}`).join(', ')}]`);
  writeFileSync(cfg, updated);
  const after = await countStale();
  notes.push(`Stale-rule errors after repair: ${after}.`);
  if (after >= before) {
    writeFileSync(cfg, original);
    return { applied: false, configFile: cfg, added: [], staleRuleErrorsAfter: before, notes: [...notes, 'No improvement; config reverted.'] };
  }
  return { applied: true, configFile: cfg, added, staleRuleErrorsAfter: after, notes };
}
