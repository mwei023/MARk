import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Gateway } from '../src/core/gateway';
import { classifyFailure } from '../src/core/failure-classifier';

// Resolve paths robustly: if run from ~/jarvis-core/app, root is ~/jarvis-core
const root = join(process.cwd(), '..');
const trainingDir = join(root, 'data', 'training');
const reportDir = join(trainingDir, 'reports');

// Ensure reports directory exists
mkdirSync(reportDir, { recursive: true });

function readJsonl(path: string): any[] {
  try {
    const text = readFileSync(path, 'utf8');
    return text
      .split(/\r?\n/)
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(entry => entry.line.length > 0)
      .map(({ line, number }) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`Invalid JSON in ${path}:${number}: ${String(error)}`);
        }
      });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      throw new Error(`Dataset file not found: ${path}\nMake sure you are running this from ~/jarvis-core/app`);
    }
    throw error;
  }
}

function normalizeRouteLabel(label: string): string {
  return label.startsWith('agent:') ? `agent:${label.slice('agent:'.length)}` : label;
}

function routeMatches(expectedLabel: string, predicted: any): boolean {
  const expected = normalizeRouteLabel(expectedLabel);
  const actual = predicted?.agent ? `agent:${predicted.agent}` : predicted?.path ?? 'unknown';
  return actual === expected;
}

function saveJson(name: string, data: unknown) {
  writeFileSync(
    join(reportDir, name),
    JSON.stringify(data, null, 2) + '\n',
    'utf8'
  );
}

// Load datasets (will now throw a clear error if paths are wrong)
const routingRows = readJsonl(join(trainingDir, 'routing.jsonl'));
const failureRows = readJsonl(join(trainingDir, 'failure.jsonl'));
const gateway = new Gateway();

let routingCorrect = 0;
const routingByLabel = new Map<string, { total: number; correct: number }>();
const routingErrors: any[] = [];

for (const row of routingRows) {
  const event: any = {
    id: 'eval',
    timestamp: new Date(),
    source: 'user_command',
    type: 'user.command.received',
    severity: 'info',
    data: { command: row.text },
  };
  const decision = gateway.classify(event);
  const ok = routeMatches(row.label, decision);
  
  if (ok) {
    routingCorrect++;
  } else {
    routingErrors.push({
      text: row.text,
      expected: row.label,
      actual: decision.agent ? `agent:${decision.agent}` : decision.path ?? 'unknown',
      reasoning: decision.reasoning,
    });
  }
  
  const entry = routingByLabel.get(row.label) ?? { total: 0, correct: 0 };
  entry.total += 1;
  if (ok) entry.correct += 1;
  routingByLabel.set(row.label, entry);
}

let failureCorrect = 0;
const failureByLabel = new Map<string, { total: number; correct: number }>();
const failureErrors: any[] = [];

for (const row of failureRows) {
  const result = classifyFailure(row.text);
  const ok = result.type === row.label;
  
  if (ok) {
    failureCorrect++;
  } else {
    failureErrors.push({
      text: row.text,
      expected: row.label,
      actual: result.type,
    });
  }
  
  const entry = failureByLabel.get(row.label) ?? { total: 0, correct: 0 };
  entry.total += 1;
  if (ok) entry.correct += 1;
  failureByLabel.set(row.label, entry);
}

const routeAccuracy = routingRows.length ? routingCorrect / routingRows.length : 0;
const failureAccuracy = failureRows.length ? failureCorrect / failureRows.length : 0;

console.log('=== Training Eval Summary ===');
console.log(`routing rows: ${routingRows.length}`);
console.log(`routing accuracy: ${(routeAccuracy * 100).toFixed(2)}%`);
for (const [label, value] of [...routingByLabel.entries()].sort()) {
  const acc = value.total ? (value.correct / value.total) * 100 : 0;
  console.log(`  ${label}: ${value.correct}/${value.total} (${acc.toFixed(1)}%)`);
}

console.log(`\nfailure rows: ${failureRows.length}`);
console.log(`failure accuracy: ${(failureAccuracy * 100).toFixed(2)}%`);
for (const [label, value] of [...failureByLabel.entries()].sort()) {
  const acc = value.total ? (value.correct / value.total) * 100 : 0;
  console.log(`  ${label}: ${value.correct}/${value.total} (${acc.toFixed(1)}%)`);
}

console.log('\n=== Misclassification Reports Generated ===');
saveJson('routing-misclassifications.json', routingErrors);
saveJson('failure-misclassifications.json', failureErrors);
console.log(`Routing errors saved: ${routingErrors.length}`);
console.log(`Failure errors saved: ${failureErrors.length}`);
console.log(`Reports directory: ${reportDir}`);