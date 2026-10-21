/**
 * Retrain the routing NB — the ONLY sanctioned path to a persisted model.
 *
 * Hard rules baked into routing-classifier.ts and enforced here:
 * - Trains exclusively on source:'live' rows harvested by logRoutingDecision.
 * - Refuses below MIN_LIVE_TRAINING_EXAMPLES (default 200).
 * - Writes provenance (trainedOn:'live', exampleCount) — models without a
 *   live marker are rejected by loadRoutingModel no matter what.
 *
 * After retraining, RESTART the server (the classifier caches the model in
 * memory via the module-level load... it reloads per call from disk, but the
 * gateway consults it per command — restart to be safe).
 *
 * Usage: npm run training:retrain
 * Set MARK_FORCE_DEFAULTS_RETRAIN=true to keep a defaults-trained model for
 * offline experiments (still NOT trusted for live traffic by the loader).
 */
import { trainRoutingModel, saveRoutingModel, MIN_LIVE_TRAINING_EXAMPLES } from '../src/core/routing-classifier';
import { loadRoutingTrainingExamples } from '../src/core/routing-classifier';

const liveExamples = loadRoutingTrainingExamples({ liveOnly: true });
console.log(`live routing rows available: ${liveExamples.length} (need >= ${MIN_LIVE_TRAINING_EXAMPLES})`);

const forceDefaults = process.env.MARK_FORCE_DEFAULTS_RETRAIN === 'true';
if (liveExamples.length < MIN_LIVE_TRAINING_EXAMPLES && !forceDefaults) {
  console.error('ABORT: not enough live data. Keep using Mark; check npm run training:status.');
  process.exit(1);
}
if (forceDefaults) {
  console.warn('MARK_FORCE_DEFAULTS_RETRAIN=true — model will be trained on DEFAULT_EXAMPLES and marked untrusted for live traffic.');
}

const model = forceDefaults
  ? trainRoutingModel([], { allowFallback: true })
  : trainRoutingModel(liveExamples);
const path = saveRoutingModel(model);
console.log(`saved ${path}`);
console.log(`trainedOn=${model.trainedOn} examples=${model.exampleCount} labels=${model.labels.length} vocab=${model.vocabSize}`);
