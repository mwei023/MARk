/**
 * Failure Classifier — deterministic log pattern matcher with confidence scores.
 *
 * Each failure type is defined by a set of weighted signals (regex patterns).
 * Confidence = sum(matched signal weights) / sum(all signal weights for that type),
 * clamped to [0, 1]. The type with the highest confidence above MIN_CONFIDENCE wins.
 *
 * Design principle: classification must be honest about uncertainty.
 * A weak match (1 signal) returns low confidence and should escalate, not act.
 */

export type FailureType =
  | 'MISSING_DEPENDENCY'
  | 'TYPE_ERROR'
  | 'LINT_FAILURE'
  | 'TEST_FAILURE'
  | 'BUILD_FAILURE'
  | 'OOM_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'PERMISSION_ERROR'
  | 'UNKNOWN';

export interface ClassificationResult {
  type: FailureType;
  confidence: number; // 0.0 – 1.0
  signals: string[]; // which patterns fired
  raw: string; // first 200 chars of log used
}

/** Minimum confidence to act on a classification (below this → UNKNOWN). */
const MIN_CONFIDENCE = 0.25;

interface Signal {
  pattern: RegExp;
  weight: number;
  label: string;
}

interface FailureDefinition {
  type: FailureType;
  signals: Signal[];
}

const FAILURE_DEFINITIONS: FailureDefinition[] = [
  {
    type: 'MISSING_DEPENDENCY',
    signals: [
      { pattern: /cannot find module/i, weight: 3, label: 'cannot_find_module' },
      { pattern: /module not found/i, weight: 3, label: 'module_not_found' },
      { pattern: /npm err(or)?/i, weight: 2, label: 'npm_error' },
      { pattern: /missing peer dep/i, weight: 2, label: 'missing_peer_dep' },
      { pattern: /could not resolve/i, weight: 1, label: 'could_not_resolve' },
      { pattern: /package\.json.*not found/i, weight: 1, label: 'package_json_missing' },
    ],
  },
  {
    type: 'TYPE_ERROR',
    signals: [
      { pattern: /typescript/i, weight: 2, label: 'typescript_mentioned' },
      { pattern: /type error/i, weight: 3, label: 'type_error' },
      { pattern: /ts\(\d+\)/i, weight: 3, label: 'ts_error_code' },
      { pattern: /error TS\d+/i, weight: 3, label: 'ts_diagnostic' },
      { pattern: /property .* does not exist/i, weight: 2, label: 'property_missing' },
      { pattern: /is not assignable to type/i, weight: 2, label: 'type_mismatch' },
      { pattern: /tsc.*--noEmit/i, weight: 1, label: 'tsc_run' },
    ],
  },
  {
    type: 'LINT_FAILURE',
    signals: [
      { pattern: /eslint/i, weight: 3, label: 'eslint_mentioned' },
      { pattern: /lint error/i, weight: 3, label: 'lint_error' },
      { pattern: /prettier/i, weight: 2, label: 'prettier_mentioned' },
      { pattern: /\d+ error(s)?,\s*\d+ warning/i, weight: 2, label: 'lint_summary' },
      { pattern: /unexpected token/i, weight: 1, label: 'unexpected_token' },
    ],
  },
  {
    type: 'TEST_FAILURE',
    signals: [
      { pattern: /\d+ (test(s)?|spec(s)?) failed/i, weight: 3, label: 'test_count_failed' },
      // Bare counts ("2 failed", "Tests 2 failed | 19 passed") — leading
      // non-zero digit so "0 failed" (a passing suite) never matches.
      { pattern: /\b[1-9]\d*\s+failed\b/i, weight: 2, label: 'test_count_bare' },
      { pattern: /assertion.*failed/i, weight: 3, label: 'assertion_failed' },
      // Bare AssertionError with no "failed" nearby (vitest/jest output).
      { pattern: /assertionerror/i, weight: 2, label: 'assertion_error' },
      { pattern: /expect\(.*\)\.to/i, weight: 2, label: 'jest_expect' },
      { pattern: /FAIL\s+src\//i, weight: 2, label: 'jest_fail_line' },
      // FAIL outside src/ ("FAIL specs/runner.test.ts").
      { pattern: /FAIL\s+\S+/i, weight: 2, label: 'fail_generic' },
      { pattern: /vitest.*failed/i, weight: 2, label: 'vitest_failed' },
      { pattern: /test.*failed/i, weight: 1, label: 'test_failed_generic' },
    ],
  },
  {
    type: 'BUILD_FAILURE',
    signals: [
      { pattern: /build failed/i, weight: 3, label: 'build_failed' },
      { pattern: /webpack.*error/i, weight: 2, label: 'webpack_error' },
      { pattern: /compilation failed/i, weight: 3, label: 'compilation_failed' },
      { pattern: /esbuild.*error/i, weight: 2, label: 'esbuild_error' },
      { pattern: /error.*during build/i, weight: 2, label: 'error_during_build' },
      { pattern: /exit code [1-9]/i, weight: 1, label: 'nonzero_exit' },
    ],
  },
  {
    type: 'OOM_ERROR',
    signals: [
      { pattern: /out of memory/i, weight: 3, label: 'oom' },
      { pattern: /javascript heap out of memory/i, weight: 3, label: 'js_heap_oom' },
      { pattern: /killed/i, weight: 1, label: 'process_killed' },
      { pattern: /ENOMEM/i, weight: 2, label: 'enomem' },
    ],
  },
  {
    type: 'NETWORK_ERROR',
    signals: [
      { pattern: /ECONNREFUSED/i, weight: 3, label: 'econnrefused' },
      { pattern: /ENOTFOUND/i, weight: 3, label: 'enotfound' },
      { pattern: /network.*timeout/i, weight: 2, label: 'network_timeout' },
      { pattern: /unable to connect/i, weight: 2, label: 'unable_to_connect' },
      { pattern: /connection refused/i, weight: 2, label: 'connection_refused' },
    ],
  },
  {
    type: 'TIMEOUT',
    signals: [
      { pattern: /timed? out/i, weight: 3, label: 'timed_out' },
      { pattern: /exceeded.*timeout/i, weight: 3, label: 'exceeded_timeout' },
      // Single-word "timeout" ("within the timeout", "timeout of 5000ms").
      // Weak alone by design — real timeouts almost always pair it with a
      // stronger signal above.
      { pattern: /timeout/i, weight: 1, label: 'timeout_word' },
      { pattern: /took too long/i, weight: 2, label: 'took_too_long' },
      { pattern: /deadline exceeded/i, weight: 2, label: 'deadline_exceeded' },
    ],
  },
  {
    type: 'PERMISSION_ERROR',
    signals: [
      { pattern: /EACCES/i, weight: 3, label: 'eacces' },
      { pattern: /EPERM/i, weight: 3, label: 'eperm' },
      { pattern: /permission denied/i, weight: 3, label: 'permission_denied' },
      { pattern: /access denied/i, weight: 2, label: 'access_denied' },
    ],
  },
];

/**
 * Classify a log string and return a result with confidence score.
 * Never throws — worst case returns UNKNOWN with confidence 0.
 */
export function classifyFailure(logs: string): ClassificationResult {
  if (!logs || logs.trim().length === 0) {
    return { type: 'UNKNOWN', confidence: 0, signals: [], raw: '' };
  }

  // CI logs commonly carry ANSI color codes that split up signal phrases
  // ("2<m> failed"). Match against the stripped text; keep the raw excerpt
  // from the original for human context.
  const clean = logs.replace(/\x1b\[[0-9;]*m/g, '');
  const raw = logs.slice(0, 200);
  let best: ClassificationResult = { type: 'UNKNOWN', confidence: 0, signals: [], raw };

  for (const def of FAILURE_DEFINITIONS) {
    const totalWeight = def.signals.reduce((s, sig) => s + sig.weight, 0);
    const firedSignals: string[] = [];
    let matchedWeight = 0;

    for (const sig of def.signals) {
      if (sig.pattern.test(clean)) {
        firedSignals.push(sig.label);
        matchedWeight += sig.weight;
      }
    }

    if (matchedWeight === 0) continue;

    const confidence = Math.min(matchedWeight / totalWeight, 1);
    if (confidence > best.confidence) {
      best = { type: def.type, confidence, signals: firedSignals, raw };
    }
  }

  // Below threshold → caller should treat as UNKNOWN regardless of best guess.
  if (best.confidence < MIN_CONFIDENCE) {
    return { type: 'UNKNOWN', confidence: best.confidence, signals: best.signals, raw };
  }

  return best;
}

/**
 * Format classification result as a human-readable finding string.
 * Used by GitAgent to write findings back to the incident.
 */
export function formatClassificationFinding(result: ClassificationResult, logLength: number): string {
  const pct = (result.confidence * 100).toFixed(0);
  if (result.type === 'UNKNOWN') {
    return `Log analysis: no confident failure pattern detected (${result.signals.length} weak signal(s), confidence ${pct}%). ${logLength} log chars examined. Manual investigation required.`;
  }
  return `Log analysis: classified as ${result.type} (confidence ${pct}%, signals: ${result.signals.join(', ')}). ${logLength} log chars examined.`;
}

/**
 * Whether this failure type is eligible for automatic low-risk remediation.
 * Only types with well-understood, reversible fixes qualify.
 */
export function isAutoFixable(type: FailureType): boolean {
  return type === 'MISSING_DEPENDENCY' || type === 'LINT_FAILURE';
}
