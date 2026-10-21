/**
 * Failure Classifier — deterministic log pattern matcher with confidence scores.
 *
 * Each failure type is defined by a set of weighted signals (regex patterns).
 * Confidence = matchedWeight / (matchedWeight + CONFIDENCE_SCALE): a saturating
 * curve over the weight of the evidence that actually fired. One decisive
 * signal classifies weakly (~0.3), corroborating signals push it up (~0.5+).
 *
 * Why not matched/total: that formula punishes coverage — every new signal
 * added to a type dilutes all single-line logs of that type, so real one-line
 * failures (e.g. "FAIL src/...", "exit 137") could never reach the threshold
 * no matter how decisive they are. Evidence weight is the right denominator.
 *
 * Design principle: classification must be honest about uncertainty.
 * A weak match (1 weak signal) returns low confidence and should escalate, not act.
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
  | 'DISK_FULL'
  | 'UNKNOWN';

export interface ClassificationResult {
  type: FailureType;
  confidence: number; // 0.0 – 1.0
  signals: string[]; // which patterns fired
  raw: string; // first 200 chars of log used
}

/** Minimum confidence to act on a classification (below this → UNKNOWN). */
const MIN_CONFIDENCE = 0.25;

/**
 * Scale for the saturating confidence curve. Calibrated so:
 * - one weak signal (weight 2) → 0.22 → UNKNOWN (escalate, don't act)
 * - one decisive signal (weight 3) → 0.30 → classified, low confidence
 * - corroborated evidence (weight 5+) → 0.42+ → actionable
 * - strong multi-signal (weight 8+) → 0.53+ → auto-fix eligible (>= 0.5)
 */
const CONFIDENCE_SCALE = 7;

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
      { pattern: /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/i, weight: 3, label: 'module_not_found_code' },
      { pattern: /failed to resolve import/i, weight: 2, label: 'failed_to_resolve_import' },
      { pattern: /can't resolve|could not resolve/i, weight: 2, label: 'could_not_resolve' },
      { pattern: /npm err(or)?/i, weight: 2, label: 'npm_error' },
      { pattern: /missing peer dep/i, weight: 2, label: 'missing_peer_dep' },
      { pattern: /ENOENT.*(module|package|file)/i, weight: 2, label: 'enoent_missing_path' },
      { pattern: /package\.json.*not found/i, weight: 1, label: 'package_json_missing' },
    ],
  },
  {
    type: 'TYPE_ERROR',
    signals: [
      { pattern: /typescript/i, weight: 2, label: 'typescript_mentioned' },
      { pattern: /type error/i, weight: 3, label: 'type_error' },
      { pattern: /\bTypeError\b/, weight: 3, label: 'typeerror_bare' },
      { pattern: /ReferenceError: .* is not defined/i, weight: 2, label: 'reference_error' },
      { pattern: /SyntaxError:/i, weight: 2, label: 'syntax_error' },
      { pattern: /cannot read propert/i, weight: 2, label: 'cannot_read_property' },
      { pattern: /is not a function/i, weight: 2, label: 'not_a_function' },
      { pattern: /ts\(\d+\)/i, weight: 3, label: 'ts_error_code' },
      { pattern: /error TS\d+/i, weight: 3, label: 'ts_diagnostic' },
      { pattern: /Expected \d+ arguments?, but got \d+/i, weight: 3, label: 'arity_mismatch' },
      { pattern: /property .* does not exist/i, weight: 2, label: 'property_missing' },
      { pattern: /is not assignable to type/i, weight: 2, label: 'type_mismatch' },
      { pattern: /tsc.*--noEmit/i, weight: 1, label: 'tsc_run' },
      { pattern: /property '.*' does not exist on type/i, weight: 2, label: 'property_does_not_exist_on_type' },
      { pattern: /Type '.*' is not assignable to type/i, weight: 2, label: 'type_assignability_mismatch' },
      { pattern: /cannot read properties of (null|undefined)/i, weight: 2, label: 'read_of_null_undefined' },
      { pattern: /expected .* to (equal|match|contain)/i, weight: 2, label: 'assertion_mismatch' },
    ],
  },
  {
    type: 'LINT_FAILURE',
    signals: [
      { pattern: /eslint/i, weight: 3, label: 'eslint_mentioned' },
      { pattern: /lint error/i, weight: 3, label: 'lint_error' },
      { pattern: /lint fail/i, weight: 3, label: 'lint_failed' },
      { pattern: /no-unused-vars|unused variable|no-undef|no-console|prefer const|unexpected token/i, weight: 2, label: 'lint_rule_violation' },
      { pattern: /prettier/i, weight: 2, label: 'prettier_mentioned' },
      { pattern: /\d+ error(s)?,\s*\d+ warning/i, weight: 2, label: 'lint_summary' },
      { pattern: /unexpected token/i, weight: 1, label: 'unexpected_token' },
      { pattern: /style guide violation|code style issues found|prettier check failed/i, weight: 2, label: 'style_violation' },
    ],
  },
  {
    type: 'TEST_FAILURE',
    signals: [
      { pattern: /\d+ (test(s)?|spec(s)?) failed/i, weight: 3, label: 'test_count_failed' },
      { pattern: /\b[1-9]\d*\s+failed\b/i, weight: 2, label: 'test_count_bare' },
      { pattern: /failed\s*\|\s*\d+\s*passed/i, weight: 3, label: 'test_summary_tail' },
      { pattern: /assertion.*failed/i, weight: 3, label: 'assertion_failed' },
      { pattern: /assertionerror/i, weight: 2, label: 'assertion_error' },
      { pattern: /expected .* to (equal|be|contain|match)/i, weight: 2, label: 'matcher_expected' },
      { pattern: /expect\(.*\)\.to/i, weight: 2, label: 'jest_expect' },
      { pattern: /FAIL\s+src\//i, weight: 2, label: 'jest_fail_line' },
      { pattern: /FAIL\s+\S+/i, weight: 2, label: 'fail_generic' },
      { pattern: /vitest.*failed/i, weight: 2, label: 'vitest_failed' },
      { pattern: /test.*failed/i, weight: 1, label: 'test_failed_generic' },
      { pattern: /expected .* to (equal|match|contain)/i, weight: 2, label: 'assertion_mismatch' },
      { pattern: /test suite failed|should create a snapshot|snapshot.*failed/i, weight: 2, label: 'test_suite_failure' },
    ],
  },
  {
    type: 'BUILD_FAILURE',
    signals: [
      { pattern: /build failed/i, weight: 3, label: 'build_failed' },
      { pattern: /compile error/i, weight: 2, label: 'compile_error' },
      { pattern: /failed to compile/i, weight: 3, label: 'failed_to_compile' },
      { pattern: /webpack.*error/i, weight: 2, label: 'webpack_error' },
      { pattern: /compilation failed/i, weight: 3, label: 'compilation_failed' },
      { pattern: /esbuild.*error/i, weight: 2, label: 'esbuild_error' },
      { pattern: /exited with [1-9]\d* errors?/i, weight: 3, label: 'exited_with_errors' },
      { pattern: /error.*during build/i, weight: 2, label: 'error_during_build' },
      { pattern: /exit code [1-9]/i, weight: 1, label: 'nonzero_exit' },
      { pattern: /vite build failed|npm run build failed/i, weight: 2, label: 'build_command_failed' },
      { pattern: /webpack compilation error|esbuild: failed to build app bundle|compilation failed: module not found/i, weight: 2, label: 'build_tooling_error' },
    ],
  },
  {
    type: 'OOM_ERROR',
    signals: [
      { pattern: /out of memory/i, weight: 3, label: 'oom' },
      { pattern: /javascript heap out of memory/i, weight: 3, label: 'js_heap_oom' },
      { pattern: /heap limit/i, weight: 2, label: 'heap_limit' },
      { pattern: /exit 137/i, weight: 4, label: 'exit_137' },
      { pattern: /killed/i, weight: 1, label: 'process_killed' },
      { pattern: /ENOMEM/i, weight: 2, label: 'enomem' },
      { pattern: /allocation failed.*memory/i, weight: 3, label: 'allocation_failed_memory' },
      { pattern: /low memory:\s*\d+MB of \d+MB memory available \(\d+%\)/i, weight: 4, label: 'low_memory_machine_check' },
      { pattern: /memory pressure (high|critical)/i, weight: 3, label: 'memory_pressure' },
    ],
  },
  {
    type: 'NETWORK_ERROR',
    signals: [
      { pattern: /ECONNREFUSED/i, weight: 3, label: 'econnrefused' },
      { pattern: /ENOTFOUND/i, weight: 3, label: 'enotfound' },
      { pattern: /ERR_CONNECTION_REFUSED|ECONNRESET|socket hang up/i, weight: 3, label: 'connection_reset' },
      { pattern: /fetch failed/i, weight: 3, label: 'fetch_failed' },
      { pattern: /network.*timeout/i, weight: 2, label: 'network_timeout' },
      { pattern: /unable to connect/i, weight: 2, label: 'unable_to_connect' },
      { pattern: /connection refused/i, weight: 2, label: 'connection_refused' },
      { pattern: /failed to fetch|ERR_NAME_NOT_RESOLVED/i, weight: 2, label: 'dns_or_fetch' },
      { pattern: /getaddrinfo ENOTFOUND|dns lookup failed/i, weight: 2, label: 'dns_failure' },
      { pattern: /did not accept a\s*(tcp\s*)?connection|service unreachable/i, weight: 3, label: 'service_unreachable' },
    ],
  },
  {
    type: 'TIMEOUT',
    signals: [
      { pattern: /timed? out/i, weight: 3, label: 'timed_out' },
      { pattern: /exceeded.*timeout/i, weight: 3, label: 'exceeded_timeout' },
      { pattern: /timeout/i, weight: 1, label: 'timeout_word' },
      { pattern: /took too long/i, weight: 2, label: 'took_too_long' },
      { pattern: /deadline exceeded/i, weight: 2, label: 'deadline_exceeded' },
      { pattern: /timed out after \d+/i, weight: 3, label: 'timed_out_after' },
      { pattern: /request timeout after \d+ms|operation timed out after \d+/i, weight: 2, label: 'request_timeout' },
    ],
  },
  {
    type: 'PERMISSION_ERROR',
    signals: [
      { pattern: /EACCES/i, weight: 3, label: 'eacces' },
      { pattern: /EPERM/i, weight: 3, label: 'eperm' },
      { pattern: /permission denied/i, weight: 3, label: 'permission_denied' },
      { pattern: /access denied/i, weight: 2, label: 'access_denied' },
      { pattern: /operation not permitted/i, weight: 2, label: 'operation_not_permitted' },
      { pattern: /permission denied.*(mkdir|open|write|create)/i, weight: 2, label: 'permission_denied_file_operation' },
    ],
  },
  {
    // Real-world disk exhaustion: ENOSPC everywhere, df thresholds, quota
    // errors. Observed live: "CRITICAL Filesystem / at 99% used".
    type: 'DISK_FULL',
    signals: [
      { pattern: /no space left on device|ENOSPC/i, weight: 5, label: 'enospc' },
      { pattern: /filesystem\s+\S+\s+at\s+\d{2,3}%\s+used/i, weight: 3, label: 'filesystem_pct_used' },
      { pattern: /disk.*(full|exhausted)|(97|98|99|100)%\s*used/i, weight: 3, label: 'disk_full_pct' },
      { pattern: /disk quota exceeded/i, weight: 4, label: 'disk_quota' },
      { pattern: /write failed.*disk|disk write error/i, weight: 2, label: 'disk_write_error' },
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
    const firedSignals: string[] = [];
    let matchedWeight = 0;

    for (const sig of def.signals) {
      if (sig.pattern.test(clean)) {
        firedSignals.push(sig.label);
        matchedWeight += sig.weight;
      }
    }

    if (matchedWeight === 0) continue;

    const confidence = Math.min(matchedWeight / (matchedWeight + CONFIDENCE_SCALE), 1);
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
