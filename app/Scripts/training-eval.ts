/**
 * Reproducible routing-model evaluation — the enablement evidence.
 *
 * 5-fold cross-validation over the live routing rows using the SAME naive
 * Bayes training code the sanctioned retrain uses. Reports overall
 * accuracy versus the majority-class baseline and PER-CLASS accuracy,
 * because the enablement bar is per-class: the router must NOT silently
 * default agent classes into reasoning.
 *
 * Enablement policy (stated, not silent): MARK_TRAINED_ROUTER may turn on
 * when reasoning+deterministic hold >=90% and every agent class >=70%.
 * This script prints the table; the decision is the user's.
 *
 * Usage: npm run training:eval
 */
import {
  loadRoutingTrainingExamples,
  trainRoutingModel,
} from '../src/core/routing-classifier';
import { appendTrainingArtifact } from '../src/core/training-log';

const examples = loadRoutingTrainingExamples({ liveOnly: true });
const folds = 5;

let total = 0;
let correct = 0;
const perLabel = new Map<string, { n: number; ok: number }>();

for (let fold = 0; fold < folds; fold++) {
  const test = examples.filter((_, i) => i % folds === fold);
  const train = examples.filter((_, i) => i % folds !== fold);
  const model = trainRoutingModel(train);
  for (const ex of test) {
    const tokenz = String(ex.text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const ranked = model.labels.map(label => {
      let score = Math.log(model.priors?.[label] ?? 1e-9);
      for (const token of tokenz) {
        score += Math.log(((model.tokenCounts?.[label] as Record<string, number>)?.[token] ?? 0) + 1e-9);
      }
      return { label, score };
    }).sort((a, b) => b.score - a.score);
    const predicted = ranked[0]?.label;
    total += 1;
    correct += predicted === ex.label ? 1 : 0;
    const stat = perLabel.get(ex.label) ?? { n: 0, ok: 0 };
    stat.n += 1;
    stat.ok += predicted === ex.label ? 1 : 0;
    perLabel.set(ex.label, stat);
  }
}

const majority = Math.max(...[...perLabel.values()].map(s => s.n)) / total * 100;
console.log(`===== ROUTING MODEL EVAL (5-fold CV, ${examples.length} live rows) =====`);
console.log(`overall accuracy : ${(correct / total * 100).toFixed(1)}% (${correct}/${total})`);
console.log(`majority baseline: ${majority.toFixed(1)}%`);
const enableReady: string[] = [];
for (const [label, stat] of [...perLabel.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const pct = (stat.ok / stat.n) * 100;
  console.log(`  ${label.padEnd(18)} ${String(stat.ok).padStart(3)}/${String(stat.n).padStart(3)}  ${pct.toFixed(0)}%`);
  enableReady.push(String(pct));
}
const every = [...perLabel.entries()];
const agentOk = every.filter(([l]) => l.startsWith('agent:')).every(([, s]) => s.ok / s.n >= 0.7);
const mainOk = ['reasoning', 'deterministic'].every(l => {
  const s = perLabel.get(l);
  return s && s.ok / s.n >= 0.9;
});
console.log(agentOk && mainOk
  ? 'ENABLEMENT CHECK: bar met in this CV — user decision pending.'
  : 'ENABLEMENT CHECK: bar NOT met (reasoning/deterministic >=90%, every agent class >=70%). Keep collecting the weak classes.');

// Archive one summary row so weekly runs form a trackable history
// (the 90-day benchmark spine). Best-effort — never fails the eval.
appendTrainingArtifact('eval-history.jsonl', {
  ts: new Date().toISOString(),
  rows: total,
  overall: Number((correct / total * 100).toFixed(1)),
  perClass: Object.fromEntries(
    [...perLabel.entries()].map(([label, stat]) => [
      label,
      Number((stat.ok / stat.n * 100).toFixed(1)),
    ]),
  ),
  barMet: agentOk && mainOk,
});
