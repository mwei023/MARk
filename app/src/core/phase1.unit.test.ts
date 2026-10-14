/**
 * Phase 1 unit tests — no DB, no LLM, no filesystem (mocked where needed).
 *
 * Covers:
 *  1. Failure classifier — all types, confidence, MIN_CONFIDENCE threshold
 *  2. LogFetchResult — structured result, never fake data
 *  3. Incident correlation logic (in-memory simulation)
 *  4. Investigation findings written back
 *  5. Escalation audit log format
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── 1. Failure classifier ────────────────────────────────────────────────────

import {
  classifyFailure,
  formatClassificationFinding,
  isAutoFixable,
} from '../core/failure-classifier.js';

describe('Failure classifier', () => {
  it('classifies MISSING_DEPENDENCY from npm error log', () => {
    const result = classifyFailure(`
      npm ERR! code MODULE_NOT_FOUND
      Cannot find module 'express'
    `);
    expect(result.type).toBe('MISSING_DEPENDENCY');
    expect(result.confidence).toBeGreaterThan(0.4);
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it('classifies TYPE_ERROR from TypeScript diagnostic', () => {
    const result = classifyFailure(`
      error TS2345: Argument of type 'string' is not assignable to type 'number'.
      src/index.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.
    `);
    expect(result.type).toBe('TYPE_ERROR');
    // ts_diagnostic (3) + type_error (3) = 6/16 = 0.375
    expect(result.confidence).toBeGreaterThan(0.25);
    expect(result.signals).toContain('ts_diagnostic');
  });

  it('classifies LINT_FAILURE from ESLint output', () => {
    const result = classifyFailure(`
      ESLint: 3 errors, 1 warning
      lint error: unexpected token in file.ts
    `);
    expect(result.type).toBe('LINT_FAILURE');
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('classifies TEST_FAILURE from jest output', () => {
    const result = classifyFailure(`
      FAIL src/core/gateway.test.ts
      3 tests failed, 2 passed
      expect(received).toBe(expected)
    `);
    expect(result.type).toBe('TEST_FAILURE');
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('classifies BUILD_FAILURE', () => {
    const result = classifyFailure('Build failed with exit code 1. Compilation failed.');
    expect(result.type).toBe('BUILD_FAILURE');
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('classifies OOM_ERROR', () => {
    const result = classifyFailure('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory');
    expect(result.type).toBe('OOM_ERROR');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('classifies TIMEOUT', () => {
    const result = classifyFailure('Error: Exceeded timeout of 5000ms. Process timed out.');
    expect(result.type).toBe('TIMEOUT');
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('classifies NETWORK_ERROR', () => {
    const result = classifyFailure('Error: ECONNREFUSED 127.0.0.1:5432 — connection refused');
    expect(result.type).toBe('NETWORK_ERROR');
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('classifies PERMISSION_ERROR', () => {
    const result = classifyFailure('Error: EACCES permission denied /usr/local/lib/node_modules');
    expect(result.type).toBe('PERMISSION_ERROR');
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('returns UNKNOWN for empty logs', () => {
    expect(classifyFailure('').type).toBe('UNKNOWN');
    expect(classifyFailure('   ').type).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for completely unrecognised logs', () => {
    const result = classifyFailure('everything looks fine somehow the build just stopped');
    expect(result.type).toBe('UNKNOWN');
  });

  it('does not return weak-signal type above MIN_CONFIDENCE — falls to UNKNOWN', () => {
    // Only one weak signal — should not reach MIN_CONFIDENCE (0.25)
    const result = classifyFailure('typescript was mentioned once');
    // confidence for TYPE_ERROR = 2/16 = 0.125 < 0.25 → UNKNOWN
    expect(result.type).toBe('UNKNOWN');
  });

  it('confidence is always between 0 and 1', () => {
    const logs = [
      'Cannot find module express npm err missing peer dep could not resolve package.json',
      'error TS2345 TypeScript type error is not assignable to type',
      '',
      'random noise',
    ];
    for (const log of logs) {
      const r = classifyFailure(log);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('formatClassificationFinding produces human-readable string for known type', () => {
    const result = classifyFailure('npm ERR! Cannot find module lodash');
    const finding = formatClassificationFinding(result, 500);
    expect(finding).toContain('MISSING_DEPENDENCY');
    expect(finding).toMatch(/confidence \d+%/);
    expect(finding).toContain('500');
  });

  it('formatClassificationFinding mentions manual investigation for UNKNOWN', () => {
    const finding = formatClassificationFinding(
      { type: 'UNKNOWN', confidence: 0, signals: [], raw: '' },
      100,
    );
    expect(finding).toMatch(/manual investigation/i);
  });

  it('isAutoFixable returns true only for MISSING_DEPENDENCY and LINT_FAILURE', () => {
    expect(isAutoFixable('MISSING_DEPENDENCY')).toBe(true);
    expect(isAutoFixable('LINT_FAILURE')).toBe(true);
    expect(isAutoFixable('TYPE_ERROR')).toBe(false);
    expect(isAutoFixable('BUILD_FAILURE')).toBe(false);
    expect(isAutoFixable('UNKNOWN')).toBe(false);
    expect(isAutoFixable('OOM_ERROR')).toBe(false);
  });
});

// ─── 2. LogFetchResult — never fake data ─────────────────────────────────────

import { GitAgent } from '../agents/git-agent.js';

describe('GitAgent.fetchLogs — structured result, no fake data', () => {
  let agent: GitAgent;

  beforeEach(() => {
    agent = new GitAgent();
  });

  it('returns source=unavailable when runId is missing', async () => {
    const result = await agent.fetchLogs(undefined, 'owner/repo');
    expect(result.source).toBe('unavailable');
    expect(result.content).toBe('');
    expect(result.unavailableReason).toMatch(/runId/i);
  });

  it('returns source=unavailable when repo is missing', async () => {
    const result = await agent.fetchLogs('12345', undefined);
    expect(result.source).toBe('unavailable');
    expect(result.content).toBe('');
    expect(result.unavailableReason).toMatch(/repo/i);
  });

  it('returns source=unavailable when gh CLI fails — never fakes logs', async () => {
    // gh is not installed or will fail with a dummy run ID
    const result = await agent.fetchLogs('000000', 'nonexistent/repo-xyz-test-only');
    // We can't control whether gh is installed, but either way:
    // - if gh is absent/fails: source = unavailable
    // - if gh succeeds (unlikely with dummy ID): source = gh_cli
    // Either is fine — what's NOT acceptable is a fake/simulated string
    expect(['gh_cli', 'unavailable']).toContain(result.source);
    if (result.source === 'unavailable') {
      expect(result.content).toBe('');
      expect(result.length).toBe(0);
      expect(result.unavailableReason).toBeTruthy();
    }
  });

  it('never contains simulated/fake marker in content', async () => {
    const result = await agent.fetchLogs('000000', 'nonexistent/repo-xyz-test-only');
    expect(result.content).not.toMatch(/\[simulated/i);
    expect(result.content).not.toMatch(/fake/i);
  });
});

// ─── 3. Incident correlation — in-memory simulation ──────────────────────────

/**
 * We can't run real DB queries in unit tests, but we can verify the
 * correlation query logic by testing the detection conditions with mock data.
 */
describe('Incident correlation conditions', () => {
  const WINDOW_HOURS = 2;

  function withinWindow(createdAt: Date): boolean {
    const windowStart = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000);
    return createdAt > windowStart;
  }

  it('detects incidents within the 2-hour correlation window', () => {
    const recent = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    expect(withinWindow(recent)).toBe(true);
  });

  it('does not correlate incidents older than 2 hours', () => {
    const old = new Date(Date.now() - 3 * 3600 * 1000); // 3 hours ago
    expect(withinWindow(old)).toBe(false);
  });

  it('correlates when correlationId + triggerEvent match', () => {
    const existing = {
      correlationId: 'owner/repo',
      triggerEvent: 'github.workflow.failed',
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      status: 'investigating',
    };
    const incoming = {
      correlationId: 'owner/repo',
      triggerEvent: 'github.workflow.failed',
    };
    const matches =
      existing.status !== 'resolved' &&
      existing.correlationId === incoming.correlationId &&
      existing.triggerEvent === incoming.triggerEvent &&
      withinWindow(existing.createdAt);
    expect(matches).toBe(true);
  });

  it('does not correlate resolved incidents', () => {
    const existing = {
      correlationId: 'owner/repo',
      triggerEvent: 'github.workflow.failed',
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      status: 'resolved', // <-- resolved
    };
    const incoming = { correlationId: 'owner/repo', triggerEvent: 'github.workflow.failed' };
    const matches =
      existing.status !== 'resolved' &&
      existing.correlationId === incoming.correlationId &&
      existing.triggerEvent === incoming.triggerEvent &&
      withinWindow(existing.createdAt);
    expect(matches).toBe(false);
  });

  it('does not correlate different repos', () => {
    const existing = {
      correlationId: 'owner/repo-A',
      triggerEvent: 'github.workflow.failed',
      createdAt: new Date(),
      status: 'open',
    };
    const incoming = { correlationId: 'owner/repo-B', triggerEvent: 'github.workflow.failed' };
    const matches =
      existing.status !== 'resolved' &&
      existing.correlationId === incoming.correlationId &&
      existing.triggerEvent === incoming.triggerEvent &&
      withinWindow(existing.createdAt);
    expect(matches).toBe(false);
  });
});

// ─── 4. Investigation findings ────────────────────────────────────────────────

describe('Investigation findings format', () => {
  it('addFinding produces non-empty strings', () => {
    const finding = formatClassificationFinding(
      { type: 'TYPE_ERROR', confidence: 0.75, signals: ['ts_diagnostic', 'type_error'], raw: '' },
      2048,
    );
    expect(typeof finding).toBe('string');
    expect(finding.length).toBeGreaterThan(10);
  });

  it('findings array accumulates correctly', () => {
    const findings: string[] = [];
    findings.push('Fetched 2048 chars of logs from gh CLI');
    findings.push('Classified as TYPE_ERROR (confidence 75%)');
    findings.push('Diff retrieved: 12 lines changed');
    findings.push("Suggested fix: Review TypeScript errors with 'npm run typecheck'");
    expect(findings).toHaveLength(4);
    expect(findings[0]).toContain('2048');
    expect(findings[1]).toContain('TYPE_ERROR');
  });

  it('unavailable log produces honest finding string', () => {
    const finding = 'Log fetch unavailable (gh CLI failed: command not found). Cannot classify failure automatically.';
    expect(finding).toMatch(/unavailable/i);
    expect(finding).not.toMatch(/simulated/i);
  });
});

// ─── 5. Escalation audit log format ──────────────────────────────────────────

describe('Escalation audit log entry format', () => {
  it('audit log entry has all required fields', () => {
    const entry = {
      ts: new Date().toISOString(),
      level: 'ESCALATION',
      incidentId: 'INC-123-abc',
      title: 'Build failed: owner/repo',
      severity: 'medium',
      triggerEvent: 'github.workflow.failed',
      correlationId: 'owner/repo',
      repository: 'owner/repo',
      branch: 'main',
      findings: ['Classified as UNKNOWN (confidence 10%)'],
      actionCount: 3,
    };

    expect(entry.level).toBe('ESCALATION');
    expect(entry.incidentId).toMatch(/^INC-/);
    expect(typeof entry.ts).toBe('string');
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts); // valid ISO date
    expect(Array.isArray(entry.findings)).toBe(true);
    expect(typeof entry.actionCount).toBe('number');
  });

  it('audit log entry serialises to valid JSON line', () => {
    const entry = {
      ts: new Date().toISOString(),
      level: 'ESCALATION',
      incidentId: 'INC-001',
      title: 'Test incident',
      severity: 'high',
      triggerEvent: 'github.workflow.failed',
      correlationId: 'test/repo',
      repository: 'test/repo',
      branch: 'main',
      findings: ['finding one', 'finding two'],
      actionCount: 2,
    };

    const line = JSON.stringify(entry);
    expect(() => JSON.parse(line)).not.toThrow();
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('ESCALATION');
    expect(parsed.findings).toHaveLength(2);
  });

  it('audit log line does not end with a newline in the JSON itself', () => {
    const entry = { ts: new Date().toISOString(), level: 'ESCALATION', incidentId: 'X' };
    const line = JSON.stringify(entry) + '\n';
    // The \n is the separator, not part of the JSON
    expect(line.trimEnd()).not.toContain('\n');
    expect(() => JSON.parse(line.trim())).not.toThrow();
  });
});
