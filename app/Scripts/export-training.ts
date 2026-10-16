/**
 * Export training datasets for Mark's future classifier distillation.
 *
 * Reads the eval routing cases (ground truth labels) + representative
 * failure-log examples per FailureType, runs them through the live
 * Gateway / failure-classifier, and writes JSONL with both the expected
 * label and Mark's current prediction.
 *
 * Usage: npx tsx Scripts/export-training.ts
 * Output: data/training/routing.jsonl, data/training/failure.jsonl
 *
 * Rows marked "agree": true are high-quality distillation targets.
 * Rows with "agree": false are where Mark is wrong today — the most
 * valuable training data (fix rules first, distill second).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gateway } from '../src/core/gateway';
import { classifyFailure } from '../src/core/failure-classifier';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '../../data/training');
mkdirSync(outDir, { recursive: true });

// ─── Routing (from eval suite ground truth) ─────────────────────────
const routingCases: Array<[string, string, string?]> = [
  ['what time is it?', 'deterministic'],
  ['show disk usage', 'deterministic'],
  ['check memory', 'deterministic'],
  ['list git branches', 'agent', 'git-agent'],
  ['deploy to staging', 'agent', 'devops-agent'],
  ['rollback the deploy', 'agent', 'devops-agent'],
  ['is the pipeline green', 'agent', 'cicd-agent'],
  ['git status of mwei023/MARk', 'agent', 'git-agent'],
  ['help me understand neural networks', 'reasoning'],
  ['compose homepage markup for Mark OS', 'reasoning'],
  ['draft the README autobiography', 'reasoning'],
  ['deep research vector databases', 'agent', 'research-agent'],
  ['look up flights over Nairobi', 'agent', 'web-agent'],
  ['repair the lint errors', 'agent', 'code-agent'],
  ['restart the container', 'agent', 'devops-agent'],
  ['is the operating system healthy', 'agent', 'system-agent'],
  ['is the linkedin link working', 'agent', 'web-agent'],
  ['check on the link', 'agent', 'web-agent'],
];

const gw = new Gateway();
const routingRows = routingCases.map(([text, wantPath, wantAgent]) => {
  const d: any = gw.classify({
    id: 'export', timestamp: new Date(), source: 'user_command',
    type: 'user.command.received', severity: 'info', data: { command: text },
  } as any);
  const expected = wantAgent ? `agent:${wantAgent}` : wantPath;
  const predicted = d.agent ? `agent:${d.agent}` : d.path;
  return JSON.stringify({ text, label: expected, predicted: predicted, agree: expected === predicted });
});
writeFileSync(join(outDir, 'routing.jsonl'), routingRows.join('\n') + '\n');

// ─── Failure classification (representative logs per type) ──────────
const failureExamples: Array<[string, string]> = [
  ["Cannot find module 'pg'", 'MISSING_DEPENDENCY'],
  ['Error: Cannot find module ./config', 'MISSING_DEPENDENCY'],
  ['npm ERR! missing peer dep react@18', 'MISSING_DEPENDENCY'],
  ["Module not found: Can't resolve 'zod'", 'MISSING_DEPENDENCY'],
  ['error TS2322: Type string is not assignable to type number', 'TYPE_ERROR'],
  ['TypeError: Cannot read properties of undefined', 'TYPE_ERROR'],
  ['src/index.ts(12,5): error TS2554: Expected 1 arguments, but got 2', 'TYPE_ERROR'],
  ['ESLint: missing semicolon, unexpected console', 'LINT_FAILURE'],
  ['lint failed with 14 errors, 0 warnings', 'LINT_FAILURE'],
  ['FAIL src/api/observability.unit.test.ts > serves the UI bundle', 'TEST_FAILURE'],
  ['AssertionError: expected 200 to equal 404', 'TEST_FAILURE'],
  ['1 failed | 399 passed', 'TEST_FAILURE'],
  ['build failed: vite compile error', 'BUILD_FAILURE'],
  // Ambiguous by design: tsc failing IS the build failing ("exited with N
  // errors" is build-output language). Kept as a boundary case.
  ['tsc --noEmit exited with 9 errors', 'BUILD_FAILURE'],
  ['JavaScript heap out of memory', 'OOM_ERROR'],
  ['OOM killed container (exit 137)', 'OOM_ERROR'],
  ['getaddrinfo ENOTFOUND registry.npmjs.org', 'NETWORK_ERROR'],
  ['fetch failed: network timeout', 'NETWORK_ERROR'],
  ['operation timed out after 120000ms', 'TIMEOUT'],
  ['EACCES: permission denied, open /root/.npm', 'PERMISSION_ERROR'],
];

const failureRows = failureExamples.map(([text, label]) => {
  const r: any = classifyFailure(text);
  return JSON.stringify({
    text, label, predicted: r.type,
    confidence: Number(r.confidence.toFixed(3)),
    agree: r.type === label,
  });
});
writeFileSync(join(outDir, 'failure.jsonl'), failureRows.join('\n') + '\n');

const routingAgree = routingRows.filter((r) => JSON.parse(r).agree).length;
const failureAgree = failureRows.filter((r) => JSON.parse(r).agree).length;
console.log(`routing: ${routingAgree}/${routingRows.length} agree`);
console.log(`failure: ${failureAgree}/${failureRows.length} agree`);
console.log(`wrote ${outDir}/routing.jsonl + failure.jsonl`);
