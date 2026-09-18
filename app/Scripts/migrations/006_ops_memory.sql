-- Migration 006: Ops incident memory + repo baselines
-- Enables Phase 3 memory and learning features.

-- Incident outcome summaries for learning and recall
CREATE TABLE IF NOT EXISTS ops_incident_memory (
  id VARCHAR(255) PRIMARY KEY,
  incident_id VARCHAR(255) NOT NULL UNIQUE,
  trigger_event VARCHAR(255) NOT NULL,
  failure_type VARCHAR(100) NOT NULL,
  classification_confidence NUMERIC(5,4) NOT NULL DEFAULT 0,
  repository TEXT,
  resolution TEXT NOT NULL,
  success BOOLEAN NOT NULL DEFAULT false,
  duration_ms BIGINT NOT NULL DEFAULT 0,
  verified BOOLEAN NOT NULL DEFAULT false,
  verified_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_memory_trigger_event ON ops_incident_memory(trigger_event);
CREATE INDEX IF NOT EXISTS idx_ops_memory_failure_type ON ops_incident_memory(failure_type);
CREATE INDEX IF NOT EXISTS idx_ops_memory_repository ON ops_incident_memory(repository) WHERE repository IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ops_memory_success ON ops_incident_memory(success, failure_type);
CREATE INDEX IF NOT EXISTS idx_ops_memory_created ON ops_incident_memory(created_at);

-- Per-repository failure baselines for anomaly detection
CREATE TABLE IF NOT EXISTS repo_baselines (
  repository TEXT PRIMARY KEY,
  avg_incidents_per_day NUMERIC(10,4) NOT NULL DEFAULT 0,
  avg_resolution_ms BIGINT NOT NULL DEFAULT 0,
  total_incidents INTEGER NOT NULL DEFAULT 0,
  most_common_type VARCHAR(100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
