-- Migration 010: strategy evaluations (self-measuring control system)
-- One row per strategy trial: which topology ran a task class, what the
-- richer execution record was, the computed utility, and the posterior
-- snapshot after incorporating the trial. Posteriors are re-derived by
-- aggregation; the stored alpha/beta is the audit trail, not the source.

CREATE TABLE IF NOT EXISTS strategy_trials (
  id VARCHAR(255) PRIMARY KEY,
  task_class VARCHAR(100) NOT NULL,
  classifier_version VARCHAR(50) NOT NULL DEFAULT 'tc-v1',
  strategy_id VARCHAR(100) NOT NULL,
  strategy_version VARCHAR(50) NOT NULL DEFAULT 'v1',
  success BOOLEAN NOT NULL DEFAULT false,
  verified BOOLEAN NOT NULL DEFAULT false,
  regression BOOLEAN NOT NULL DEFAULT false,
  tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms BIGINT NOT NULL DEFAULT 0,
  utility NUMERIC(10,4) NOT NULL DEFAULT 0,
  weights_version VARCHAR(50) NOT NULL DEFAULT 'u-v1',
  binary_outcome BOOLEAN NOT NULL DEFAULT false,
  posterior_alpha NUMERIC(12,4) NOT NULL DEFAULT 1,
  posterior_beta NUMERIC(12,4) NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_trials_class ON strategy_trials(task_class, strategy_id);
CREATE INDEX IF NOT EXISTS idx_strategy_trials_created ON strategy_trials(created_at);
