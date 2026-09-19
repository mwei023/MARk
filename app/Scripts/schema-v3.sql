-- MARK schema v3: persistent workflow memory + kernel confirmations.
-- Approvals must survive restarts (REPL already warns they don't).

CREATE TABLE IF NOT EXISTS learned_workflows (
  id VARCHAR(255) PRIMARY KEY,
  goal TEXT NOT NULL,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  success_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  explanation TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_learned_workflows_created_at ON learned_workflows (created_at);

CREATE TABLE IF NOT EXISTS kernel_confirmations (
  id VARCHAR(255) PRIMARY KEY,
  tool_id VARCHAR(255) NOT NULL,
  action_id VARCHAR(255) NOT NULL,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by VARCHAR(255) NOT NULL DEFAULT 'unknown',
  reason TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_kernel_confirmations_status ON kernel_confirmations (status);
