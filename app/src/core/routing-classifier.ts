/**
 * Lightweight routing classifier trained from the repo's routing JSONL corpus.
 *
 * This model is intentionally compact: a small Naive-Bayes-style token scorer
 * trained from the repository's JSONL routing data and persisted to the training
 * directory for reuse. It augments the deterministic regexes in gateway.ts, but
 * does not replace them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type RoutingLabel =
  | 'deterministic'
  | 'reasoning'
  | 'agent:git-agent'
  | 'agent:devops-agent'
  | 'agent:cicd-agent'
  | 'agent:code-agent'
  | 'agent:web-agent'
  | 'agent:research-agent'
  | 'agent:system-agent';

export interface RoutingPrediction {
  label: RoutingLabel;
  confidence: number;
  evidence: string[];
}

interface TrainingExample {
  text: string;
  label: string;
}

interface RoutingModel {
  version: number;
  labels: RoutingLabel[];
  priors: Record<RoutingLabel, number>;
  tokenCounts: Record<RoutingLabel, Record<string, number>>;
  tokenTotals: Record<RoutingLabel, number>;
  vocabSize: number;
  /** Provenance required for a persisted model to be loaded. Prevents a model trained on self-labeled synthetic rows from serving live traffic. */
  trainedOn?: 'live' | 'defaults';
  exampleCount?: number;
}

/** ANB is only allowed to serve live traffic once trained on this many real rows. */
export const MIN_LIVE_TRAINING_EXAMPLES = 200;

const LABELS: RoutingLabel[] = [
  'deterministic',
  'reasoning',
  'agent:git-agent',
  'agent:devops-agent',
  'agent:cicd-agent',
  'agent:code-agent',
  'agent:web-agent',
  'agent:research-agent',
  'agent:system-agent',
];

const DEFAULT_EXAMPLES: TrainingExample[] = [
  { text: 'what time is it', label: 'deterministic' },
  { text: 'show disk usage', label: 'deterministic' },
  { text: 'check memory', label: 'deterministic' },
  { text: 'list git branches', label: 'agent:git-agent' },
  { text: 'git status', label: 'agent:git-agent' },
  { text: 'deploy to staging', label: 'agent:devops-agent' },
  { text: 'rollback the deploy', label: 'agent:devops-agent' },
  { text: 'restart the container', label: 'agent:devops-agent' },
  { text: 'is the pipeline green', label: 'agent:cicd-agent' },
  { text: 'repair the lint errors', label: 'agent:code-agent' },
  { text: 'look up flights over Nairobi', label: 'agent:web-agent' },
  { text: 'deep research vector databases', label: 'agent:research-agent' },
  { text: 'is the operating system healthy', label: 'agent:system-agent' },
  { text: 'help me understand neural networks', label: 'reasoning' },
  { text: 'teach me data structures', label: 'reasoning' },
  { text: 'who is the president of Kenya', label: 'reasoning' },
  { text: 'play some music', label: 'reasoning' },
  { text: 'open vlc', label: 'reasoning' },
];

function resolveTrainingDir(): string {
  const cwd = process.cwd();
  const candidates = [
    join(cwd, 'data', 'training'),
    join(cwd, '..', 'data', 'training'),
    join(cwd, 'app', '..', 'data', 'training'),
  ];
  return candidates.find(path => existsSync(path)) ?? candidates[0];
}

function resolveModelPath(): string {
  return join(resolveTrainingDir(), 'routing-model.json');
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized.split(' ').filter(Boolean).filter(word => word.length >= 2);
}

function parseLabel(value: string): RoutingLabel | null {
  if (LABELS.includes(value as RoutingLabel)) return value as RoutingLabel;
  return null;
}

function loadExamplesFromJsonl(path: string, opts: { liveOnly?: boolean } = {}): TrainingExample[] {
  try {
    const text = readFileSync(path, 'utf8');
    const rows = text.split(/\r?\n/).filter(Boolean);
    const parsed: TrainingExample[] = [];
    for (const row of rows) {
      try {
        const value = JSON.parse(row);
        const label = typeof value.label === 'string' ? parseLabel(value.label) : null;
        if (typeof value.text === 'string' && label) {
          // Live/synthetic provenance is part of the row contract. Rows
          // without a source (or claimed synthetic) are NOT training truth:
          // templated labels were derived FROM the gateway itself
          // (circular). Only real usage (source 'live') may teach the NB.
          if (opts.liveOnly && value.source !== 'live') continue;
          parsed.push({ text: value.text, label });
        }
      } catch {
        // Malformed rows are ignored rather than poisoning the model.
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

export function loadRoutingTrainingExamples(opts: { liveOnly?: boolean } = {}): TrainingExample[] {
  const trainingPath = join(resolveTrainingDir(), 'routing.jsonl');
  const examples = loadExamplesFromJsonl(trainingPath, opts);
  return examples.length > 0 ? examples : DEFAULT_EXAMPLES;
}

/**
 * Train ONLY on live rows. Throws when real data is too thin — callers must
 * not persist a model built from defaults or templates; that is the exact
 * failure mode that let synthetic weights serve live traffic.
 */
export function trainRoutingModel(
  examples: TrainingExample[] = loadRoutingTrainingExamples({ liveOnly: true }),
  opts: { allowFallback?: boolean } = {},
): RoutingModel {
  const liveCount = examples.length;
  const allowFallback = opts.allowFallback === true;
  if (liveCount < MIN_LIVE_TRAINING_EXAMPLES && !allowFallback) {
    throw new Error(
      `routing: refusing to train on ${liveCount} example(s) — need >= ${MIN_LIVE_TRAINING_EXAMPLES} live rows. ` +
      'Collect real usage (logRoutingDecision) before retraining.',
    );
  }
  const effectiveExamples = examples.length > 0 && (liveCount >= MIN_LIVE_TRAINING_EXAMPLES || allowFallback)
    ? examples
    : DEFAULT_EXAMPLES;
  const labels = LABELS.filter(label => effectiveExamples.some(example => parseLabel(example.label) === label));
  const safeLabels = labels.length > 0 ? labels : LABELS;
  const priors: Record<RoutingLabel, number> = {} as Record<RoutingLabel, number>;
  const tokenCounts: Record<RoutingLabel, Record<string, number>> = {} as Record<RoutingLabel, Record<string, number>>;
  const tokenTotals: Record<RoutingLabel, number> = {} as Record<RoutingLabel, number>;

  for (const label of safeLabels) {
    priors[label] = 0;
    tokenCounts[label] = {};
    tokenTotals[label] = 0;
  }

  for (const example of effectiveExamples) {
    const label = parseLabel(example.label) ?? 'reasoning';
    if (!safeLabels.includes(label)) continue;
    priors[label] += 1;

    const seen = new Set<string>();
    for (const word of tokenize(example.text)) {
      if (!word || seen.has(word)) continue;
      seen.add(word);
      tokenCounts[label][word] = (tokenCounts[label][word] ?? 0) + 1;
      tokenTotals[label] += 1;
    }
  }

  const totalExamples = safeLabels.reduce((sum, label) => sum + (priors[label] ?? 0), 0) || 1;
  for (const label of safeLabels) {
    priors[label] = (priors[label] ?? 0) / totalExamples;
  }

  const vocab = new Set<string>();
  for (const label of safeLabels) {
    for (const token of Object.keys(tokenCounts[label] ?? {})) vocab.add(token);
  }

  return {
    version: 1,
    labels: safeLabels,
    priors,
    tokenCounts,
    tokenTotals,
    vocabSize: vocab.size || 1,
    trainedOn: liveCount >= MIN_LIVE_TRAINING_EXAMPLES ? 'live' : 'defaults',
    exampleCount: effectiveExamples.length,
  };
}

export function saveRoutingModel(model: RoutingModel): string {
  const dir = resolveTrainingDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'routing-model.json');
  writeFileSync(path, JSON.stringify(model, null, 2));
  return path;
}

export function loadRoutingModel(): RoutingModel | null {
  const path = resolveModelPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as RoutingModel;
    if (!raw || typeof raw.version !== 'number' || !Array.isArray(raw.labels)) return null;
    // Provenance gate: no trusted OnDiskModel without a live-trained marker.
    // The pre-existing routing-model.json (trained on 4.7k self-labeled
    // synthetic rows) stays permanently inert through this check, even if
    // MARK_TRAINED_ROUTER=on is flipped later — it must be explicitly
    // retrained on >= MIN_LIVE_TRAINING_EXAMPLES real rows.
    if (raw.trainedOn !== 'live' || (raw.exampleCount ?? 0) < MIN_LIVE_TRAINING_EXAMPLES) return null;
    return raw;
  } catch {
    // Ignore unreadable model files and fall back to the JSONL data.
  }
  return null;
}

export function trainAndPersistRoutingModel(): RoutingModel {
  const model = trainRoutingModel();
  saveRoutingModel(model);
  return model;
}

function computeScore(model: RoutingModel, label: RoutingLabel, text: string): number {
  const tokens = tokenize(text);
  if (!tokens.length) return Math.log(model.priors[label] ?? 0.1);

  const classTokens = model.tokenCounts[label] ?? {};
  const total = model.tokenTotals[label] ?? 1;
  let score = Math.log(model.priors[label] ?? 0.1);

  for (const token of tokens) {
    const count = classTokens[token] ?? 0;
    const probability = (count + 1) / (total + model.vocabSize);
    score += Math.log(probability);
  }

  const phraseBoosts: Record<RoutingLabel, RegExp[]> = {
    deterministic: [
      /\b(what time is it|what date is it|what day is it|show .*files|list .*files|check .*disk|check .*cpu|check .*memory|show .*usage|display .*files|what is in the .*directory|what is in the .*folder)\b/i,
    ],
    reasoning: [
      /\b(help me (learn|understand|know)|teach me|who is|what do you think|can you help|explain|why|how do i|how does|hi|hello|what is a|what does .* mean|why does|can you explain)\b/i,
    ],
    'agent:git-agent': [
      /\b(git|branch|branches|commit|merge|pull request|status|remote|stash|reflog|tag|checkout)\b/i,
    ],
    'agent:devops-agent': [
      /\b(deploy|rollback|restart|docker|container|health|kubernetes|service|services|staging|production|pod|scale|rolling|release|redeploy)\b/i,
    ],
    'agent:cicd-agent': [
      /\b(pipeline|build|test|lint|ci|workflow|job|check(s)?|run the tests|build logs)\b/i,
    ],
    'agent:code-agent': [
      /\b(repair|fix|debug|patch|resolve|refactor|compile|syntax|type mismatch|regression|broken function)\b/i,
    ],
    'agent:web-agent': [
      /\b(look up|search the web|search|browse|link|url|website|web|docs|documentation|homepage|status page)\b/i,
    ],
    'agent:research-agent': [
      /\b(deep research|research|survey|investigate|literature review|study|state of the art|deep dive|analyze)\b/i,
    ],
    'agent:system-agent': [
      /\b(system|service|process|cpu|memory|disk|port|os|daemon|uptime|health|server|status)\b/i,
    ],
  };

  for (const pattern of phraseBoosts[label] ?? []) {
    if (pattern.test(text)) score += 2;
  }

  return score;
}

export function classifyRoutingIntent(text: string): RoutingPrediction | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;

  // Load a provenance-checked model, or nothing. Deliberately NEVER
  // auto-train-and-persist here: the previous fallback trained on whatever
  // sat in routing.jsonl (4.7k self-labeled synthetic rows) and that model
  // then served live traffic. Retraining is an explicit act
  // (npm run training:retrain) gated on live-row volume.
  const model = loadRoutingModel();
  if (!model) return null;

  const scores = model.labels.map(label => ({ label, score: computeScore(model, label, raw) }));
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  if (!best) return null;

  const second = scores[1]?.score ?? best.score - 0.01;
  const margin = best.score - second;
  const confidence = Math.min(0.99, Math.max(0.55, 0.6 + margin / 10));
  const evidence = Array.from(new Set(tokenize(raw))).slice(0, 5);

  return {
    label: best.label,
    confidence,
    evidence,
  };
}

export function parseRoutingLabel(label: string): RoutingLabel | null {
  return parseLabel(label);
}
