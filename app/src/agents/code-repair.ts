/**
 * LLM per-error code repair loop (for what deterministic tools cannot fix).
 *
 * One error location at a time: propose → apply → verify → keep or revert.
 * Verification is the guardrail — an edit that does not reduce that file's
 * error count (or introduces new errors) is reverted, never pushed.
 * Anything unverifiable becomes a structured handoff, not a silent skip.
 */
import { execFile } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { promisify } from 'util';
import { config } from '../config.js';

const execFilePromise = promisify(execFile);

export interface LintError {
  file: string; // repo-relative
  line: number;
  column: number;
  ruleId: string;
  message: string;
}

export interface RepairOutcome {
  target: LintError;
  fixed: boolean;
  skipped?: string;
  detail: string;
}

export interface RepairSummary {
  attempted: number;
  fixed: number;
  skipped: number;
  outcomes: RepairOutcome[];
}

/** Parse `eslint --format json` into individual errors (not warnings). */
export async function collectEslintErrors(repoPath: string): Promise<LintError[]> {
  let raw = '';
  let exitCode = 0;
  try {
    await execFilePromise('npx', ['--no-install', 'eslint', '.', '--format', 'json'], { cwd: repoPath, timeout: 180000 });
  } catch (err) {
    exitCode = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
    raw = String((err as { stdout?: unknown }).stdout ?? '');
  }
  if (!raw.trim()) {
    // Exit 0 with no output means genuinely clean. Anything else with no
    // output means the linter itself broke — throwing keeps that visible
    // instead of masquerading as "no errors".
    if (exitCode === 0) return [];
    throw new Error(`eslint produced no parseable output (exit ${exitCode}); the toolchain may be broken.`);
  }
  const targets: LintError[] = [];
  try {
    const files = JSON.parse(raw) as Array<{ filePath: string; messages: Array<{ line: number; column: number; ruleId: string | null; severity: number; message: string }> }>;
    for (const f of files) {
      const rel = f.filePath.startsWith(repoPath + '/') ? f.filePath.slice(repoPath.length + 1) : f.filePath;
      for (const m of f.messages) {
        if (m.severity !== 2 || !m.ruleId) continue; // errors only, must have a rule
        targets.push({ file: rel, line: m.line ?? 1, column: m.column ?? 1, ruleId: m.ruleId, message: m.message });
      }
    }
  } catch {
    // Unparseable despite output: surface, don't silently report zero errors.
    throw new Error('eslint JSON output could not be parsed; refusing to report "no errors".');
  }
  return targets;
}

/** Count errors in one file (used before/after to prove improvement). */
async function fileErrorCount(repoPath: string, relFile: string): Promise<{ count: number; rules: string[] }> {
  const tally = (out: string): { count: number; rules: string[] } => {
    // Read ONLY the summary line ("x problems (N errors, M warnings)") —
    // diagnostic lines contain "<line>:<col> error" which naive regexes mistake for counts.
    const summaryLine = out.split('\n').find(l => /problems?\s*\(/i.test(l));
    const summary = summaryLine?.match(/\((\d+)\s+errors?/i);
    const rules: string[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*\d+:\d+\s+\w+\s+(.+?)\s{2,}([^\s]+)\s*$/);
      if (m) rules.push(m[2]);
    }
    return { count: summary ? parseInt(summary[1], 10) : 0, rules };
  };
  try {
    const { stdout } = await execFilePromise('npx', ['--no-install', 'eslint', relFile], { cwd: repoPath, timeout: 120000 });
    return tally(stdout);
  } catch (err) {
    // Non-zero exit is the normal "errors found" path — parse its output.
    return tally(String((err as { stdout?: unknown }).stdout ?? ''));
  }
}

const REPAIR_SYSTEM = `You fix one ESLint error by replacing individual lines. Output ONLY the corrected lines, one per line, in the exact format N|corrected code where N is the original line number. Output nothing else: no fences, no prose, no unchanged lines. Change the fewest lines that resolve the reported error without breaking types or behavior. FORBIDDEN: eslint-disable comments, deleting exports or functions, changing lines unrelated to the error. If no small local change fixes it, output nothing.`;

/**
 * Client-side chat timeout. The provider interface exposes no timeout and
 * some implementations ignore per-call config, so the loop enforces its own
 * bound — a hung generation fails this error, never the whole run.
 */
async function chatWithTimeout(
  chat: () => Promise<{ content: string }>,
  ms: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`LLM generation exceeded ${Math.round(ms / 1000)}s budget`)), ms);
    });
    return (await Promise.race([chat(), timeout])).content;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Capped code completion via the local Ollama REST API.
 *
 * Why not the MARK provider abstraction: repair needs a hard generation cap
 * (`num_predict`) so small-model rambling terminates, and the provider
 * interface exposes no per-call options. Temperature 0 for determinism;
 * the token cap scales with file size so the model always has room for the
 * full corrected file plus a small margin — and never room to ramble.
 */
async function completeRepair(prompt: string, numPredict: number): Promise<{ content: string }> {
  const res = await fetch(`${config.ollamaHost}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollamaModel,
      stream: false,
      options: { num_predict: numPredict, temperature: 0 },
      messages: [
        { role: 'system', content: REPAIR_SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama chat failed: HTTP ${res.status}`);
  const body = (await res.json()) as { message?: { content?: string }; error?: string };
  if (body.error) throw new Error(`Ollama error: ${body.error}`);
  return { content: body.message?.content ?? '' };
}

function extractCode(response: string): string | null {
  const fenced = response.match(/```(?:[a-zA-Z]*\n)?([\s\S]*?)```/);
  const code = (fenced ? fenced[1] : response).trim();
  return code.length > 0 ? code : null;
}

/**
 * Splice model-returned `N|code` lines into the original. Preservation holds
 * by construction: only listed lines change, everything else is untouched.
 * Changes outside a ±30-line radius of the reported error are rejected.
 */
function spliceLines(original: string, targetLine: number, response: string): { proposal: string | null; rejections: string[] } {
  const origLines = original.split('\n');
  const rejections: string[] = [];
  const updates = new Map<number, string>();
  for (const raw of response.split('\n')) {
    const line = raw.trim().replace(/^```[a-zA-Z]*|```$/g, '').trim();
    const m = line.match(/^(\d+)\|(.*)$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n < 1 || n > origLines.length) {
      rejections.push(`line ${m[1]} out of range`);
      continue;
    }
    if (Math.abs(n - targetLine) > 30) {
      rejections.push(`line ${n} outside repair radius`);
      continue;
    }
    updates.set(n, m[2]);
  }
  if (updates.size === 0) return { proposal: null, rejections };
  const next = origLines.slice();
  for (const [n, code] of updates) next[n - 1] = code;
  return { proposal: next.join('\n'), rejections };
}

/** Repair a single error. Reverts on any verification failure. */
export async function repairOneError(
  repoPath: string,
  target: LintError,
  opts: { maxFileLines?: number; llmTimeoutMs?: number } = {},
): Promise<RepairOutcome> {
  const abs = `${repoPath}/${target.file}`;
  let original: string;
  try {
    original = readFileSync(abs, 'utf8');
  } catch {
    return { target, fixed: false, skipped: 'unreadable file', detail: `Could not read ${target.file}` };
  }
  const lineCount = original.split('\n').length;
  if (lineCount > (opts.maxFileLines ?? 300)) {
    return { target, fixed: false, skipped: 'file too large', detail: `${target.file} has ${lineCount} lines (budget ${opts.maxFileLines ?? 300}); needs human or windowed repair.` };
  }
  const before = await fileErrorCount(repoPath, target.file);

  let proposal: string;
  try {
    // Windowed prompt: file head (imports) + ±25 lines around the error.
    // Small output (~a few lines) keeps CPU inference fast and terminating.
    const allLines = original.split('\n');
    const lo = Math.max(0, target.line - 26);
    const hi = Math.min(allLines.length, target.line + 25);
    const head = allLines.slice(0, Math.min(15, allLines.length));
    const window = allLines.slice(lo, hi);
    const numbered = window.map((l, i) => `${lo + i + 1}|${l}`).join('\n');
    const headBlock = lo <= 15 ? '' : `File head (line|code):\n${head.map((l, i) => `${i + 1}|${l}`).join('\n')}\n\n`;
    const prompt = `File: ${target.file}\nESLint error at line ${target.line}, column ${target.column}: [${target.ruleId}] ${target.message}\n\n${headBlock}Repair window (line|code):\n${numbered}`;
    const budgetMs = opts.llmTimeoutMs ?? 180000;
    const content = await chatWithTimeout(
      () => completeRepair(prompt, 300),
      budgetMs,
    );
    const { proposal: spliced, rejections } = spliceLines(original, target.line, content);
    if (!spliced) {
      return { target, fixed: false, detail: `LLM proposed no usable lines${rejections.length > 0 ? ` (${rejections.slice(0, 2).join('; ')})` : ''}.` };
    }
    if (/eslint-disable/.test(spliced)) {
      return { target, fixed: false, detail: 'Proposal rejected: eslint-disable suppression instead of a fix.' };
    }
    proposal = spliced;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { target, fixed: false, detail: `LLM call failed: ${msg.slice(0, 200)}` };
  }

  writeFileSync(abs, proposal);
  const after = await fileErrorCount(repoPath, target.file);
  if (after.count < before.count) {
    return { target, fixed: true, detail: `${target.file}: ${before.count} → ${after.count} errors.` };
  }
  // No improvement (or worse): revert, never keep a lateral move.
  writeFileSync(abs, original);
  return { target, fixed: false, detail: `${target.file}: proposal did not reduce errors (${before.count} → ${after.count}); reverted.` };
}

/**
 * Repair loop over a repo's eslint errors, bounded by maxErrors.
 * Returns a summary; callers decide commit/push from it.
 */
export async function repairLintErrors(
  repoPath: string,
  opts: { maxErrors?: number; maxFileLines?: number; onOutcome?: (o: RepairOutcome) => void | Promise<void> } = {},
): Promise<RepairSummary> {
  const all = await collectEslintErrors(repoPath);
  const budget = opts.maxErrors ?? 5;
  const queue = all.slice(0, budget);
  const outcomes: RepairOutcome[] = [];
  for (const target of queue) {
    const outcome = await repairOneError(repoPath, target, { maxFileLines: opts.maxFileLines });
    outcomes.push(outcome);
    if (opts.onOutcome) await opts.onOutcome(outcome);
  }
  const fixed = outcomes.filter(o => o.fixed).length;
  const skipped = outcomes.filter(o => o.skipped).length;
  if (all.length > queue.length) {
    outcomes.push({
      target: { file: '', line: 0, column: 0, ruleId: '', message: '' },
      fixed: false, skipped: 'budget',
      detail: `${all.length - queue.length} further error(s) left for the next run (budget ${budget}).`,
    });
  }
  return { attempted: queue.length, fixed, skipped, outcomes };
}
