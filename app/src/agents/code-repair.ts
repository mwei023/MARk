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
import { getLLMProviderCached } from '../llm/index.js';

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
  /** Which model tier produced the kept proposal: local, cloud, or none. */
  via?: 'local' | 'cloud' | 'none';
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
async function chatWithTimeout<T>(
  chat: () => Promise<T>,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`LLM generation exceeded ${Math.round(ms / 1000)}s budget`)), ms);
    });
    return await Promise.race([chat(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Capped code completion with a local-first, cloud-escalation ladder.
 *
 * Attempt 1 is always the local Ollama model via REST with a hard generation
 * cap (`num_predict`) — free, private, and terminating. The MARK provider
 * abstraction exposes no per-call options, so the cap needs REST.
 *
 * Attempt 2 (only when configured cloud keys exist and the run still has
 * cloud budget) goes through the MARK provider chain (primary → fallbacks
 * per LLM_PROVIDER / LLM_FALLBACK_PROVIDERS) with maxTokens + temperature 0.
 * Every attempt is client-side bounded; a hung generation fails the error,
 * never the run.
 */
export interface RepairRunContext {
  cloudCalls: number;
  maxCloudCalls: number;
}

async function completeRepair(
  prompt: string,
  numPredict: number,
  ctx: RepairRunContext,
  opts: { skipLocal?: boolean } = {},
): Promise<{ content: string; via: 'local' | 'cloud' }> {
  if (!opts.skipLocal) {
    const localError = await tryLocalRepair(prompt, numPredict).catch((err) => err as Error);
    if (typeof localError !== 'object' || localError === null || !('wasLocalFailure' in localError)) {
      return { content: localError as unknown as string, via: 'local' };
    }
    if (ctx.cloudCalls >= ctx.maxCloudCalls) {
      throw new Error(`Local repair failed (${(localError as Error).message.slice(0, 120)}) and cloud budget is spent (${ctx.cloudCalls}/${ctx.maxCloudCalls}).`);
    }
  } else if (ctx.cloudCalls >= ctx.maxCloudCalls) {
    throw new Error(`Cloud budget is spent (${ctx.cloudCalls}/${ctx.maxCloudCalls}).`);
  }
  ctx.cloudCalls += 1;
  const provider = await getLLMProviderCached();
  const { content } = await chatWithTimeout(
    () => provider.chat(
      [
        { role: 'system', content: REPAIR_SYSTEM },
        { role: 'user', content: prompt },
      ],
      { maxTokens: numPredict, temperature: 0 },
    ).then((res) => ({ content: res.content })),
    120000,
  );
  return { content, via: 'cloud' };
}

async function tryLocalRepair(prompt: string, numPredict: number): Promise<string> {
  try {
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
    return body.message?.content ?? '';
  } catch (err) {
    // Marker object so the caller can distinguish local failure (escalate)
    // from a successful empty response (no escalation).
    const marker = err instanceof Error ? err : new Error(String(err));
    (marker as Error & { wasLocalFailure?: boolean }).wasLocalFailure = true;
    throw marker;
  }
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
      // Empty replacement = line deletion: rejected outright. Deletion shifts
      // every later line number and routinely breaks references below (the
      // interface is still used); a real fix replaces, not removes.
      if (!m[2].trim()) {
        rejections.push(`line ${n} deletion rejected`);
        continue;
      }
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

/** First 150 chars of a raw model response, for supervision notes. */
export function rawExcerpt(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 150);
}

/** Repair a single error. Reverts on any verification failure. */
export async function repairOneError(
  repoPath: string,
  target: LintError,
  opts: { maxFileLines?: number; llmTimeoutMs?: number; ctx?: RepairRunContext } = {},
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

  let proposal: string | null = null;
  let via: 'local' | 'cloud' = 'local';
  let lastNote = '';
  const ctx = opts.ctx ?? { cloudCalls: 0, maxCloudCalls: config.markRepairMaxCloudCalls };
  // Up to two tiers with per-tier verification: local first, then cloud
  // escalation when the local proposal is unusable OR verification rejects
  // it. Cloud is spent only on errors the free model demonstrably cannot
  // fix — never speculatively. The file is reverted between tiers.
  for (const tier of ['local', 'cloud'] as const) {
    if (tier === 'cloud' && ctx.cloudCalls >= ctx.maxCloudCalls) {
      lastNote = `cloud budget spent (${ctx.cloudCalls}/${ctx.maxCloudCalls})`;
      break;
    }
    let candidate: string | null = null;
    try {
      const attempt = await proposeEdit(original, target, {
        skipLocal: tier === 'cloud',
        ctx,
        llmTimeoutMs: opts.llmTimeoutMs,
      });
      if (!attempt.proposal) {
        lastNote = `${tier}: ${attempt.note}`;
        continue;
      }
      candidate = attempt.proposal;
      via = attempt.via;
    } catch (err) {
      lastNote = `${tier} call failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
      continue;
    }
    writeFileSync(abs, candidate);
    const mid = await fileErrorCount(repoPath, target.file);
    if (mid.count < before.count) {
      proposal = candidate;
      break; // verified improvement — keep, stop escalating
    }
    writeFileSync(abs, original);
    lastNote = `${tier} proposal did not verify (${before.count} → ${mid.count}); reverted`;
  }
  if (!proposal) {
    return { target, fixed: false, via: 'none', detail: `No verified fix (${lastNote.slice(0, 180)}).` };
  }
  // Final recount guards against verifier flakiness between the tier check
  // and this return: only a recount-confirmed drop counts as fixed.
  const after = await fileErrorCount(repoPath, target.file);
  if (after.count < before.count) {
    return { target, fixed: true, via, detail: `${target.file}: ${before.count} → ${after.count} errors via ${via}.` };
  }
  writeFileSync(abs, original);
  return { target, fixed: false, via: 'none', detail: `${target.file}: final recount did not confirm improvement; reverted.` };
}

/** Single proposal attempt: prompt, generate, splice, integrity-check. */
async function proposeEdit(
  original: string,
  target: LintError,
  opts: { skipLocal?: boolean; ctx: RepairRunContext; llmTimeoutMs?: number },
): Promise<{ proposal: string | null; via: 'local' | 'cloud'; note: string }> {
  // Windowed prompt: file head (imports) + ±25 lines around the error.
  // Small output (~a few lines) keeps inference fast and terminating.
  const allLines = original.split('\n');
  const lo = Math.max(0, target.line - 26);
  const hi = Math.min(allLines.length, target.line + 25);
  const head = allLines.slice(0, Math.min(15, allLines.length));
  const window = allLines.slice(lo, hi);
  const numbered = window.map((l, i) => `${lo + i + 1}|${l}`).join('\n');
  const headBlock = lo <= 15 ? '' : `File head (line|code):\n${head.map((l, i) => `${i + 1}|${l}`).join('\n')}\n\n`;
  const prompt = `File: ${target.file}\nESLint error at line ${target.line}, column ${target.column}: [${target.ruleId}] ${target.message}\n\n${headBlock}Repair window (line|code):\n${numbered}`;
  const budgetMs = opts.llmTimeoutMs ?? 180000;
  const { content, via } = await chatWithTimeout(
    () => completeRepair(prompt, 300, opts.ctx, { skipLocal: opts.skipLocal }),
    budgetMs,
  );
  const { proposal: spliced, rejections } = spliceLines(original, target.line, content);
  if (!spliced) {
    return {
      proposal: null,
      via,
      note: `no usable lines${rejections.length > 0 ? ` (${rejections.slice(0, 2).join('; ')})` : ''}; raw: ${rawExcerpt(content)}`,
    };
  }
  if (/eslint-disable/.test(spliced)) {
    return { proposal: null, via, note: 'eslint-disable suppression instead of a fix' };
  }
  return { proposal: spliced, via, note: 'ok' };
}

/**
 * Repair loop over a repo's eslint errors, bounded by maxErrors.
 * Returns a summary; callers decide commit/push from it.
 */
export async function repairLintErrors(
  repoPath: string,
  opts: { maxErrors?: number; maxFileLines?: number; maxCloudCalls?: number; onOutcome?: (o: RepairOutcome) => void | Promise<void> } = {},
): Promise<RepairSummary> {
  const all = await collectEslintErrors(repoPath);
  const budget = opts.maxErrors ?? 5;
  const queue = all.slice(0, budget);
  // One shared cloud budget for the whole run: escalation is per-incident,
  // not per-error, so a hard file can't burn the budget for easy ones.
  const ctx: RepairRunContext = { cloudCalls: 0, maxCloudCalls: opts.maxCloudCalls ?? config.markRepairMaxCloudCalls };
  const outcomes: RepairOutcome[] = [];
  for (const target of queue) {
    const outcome = await repairOneError(repoPath, target, { maxFileLines: opts.maxFileLines, ctx });
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
