-- Migration 011: durable agent action proposals
-- Pending proposals must survive a MARK restart so an approval cannot vanish
-- between incident creation and the operator's decision.

CREATE TABLE IF NOT EXISTS action_proposals (
  id VARCHAR(255) PRIMARY KEY,
  incident_id VARCHAR(255) NOT NULL,
  action TEXT NOT NULL,
  tool VARCHAR(255) NOT NULL,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale TEXT NOT NULL,
  risk_level VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  decided_by VARCHAR(50),
  execution_result TEXT,
  CONSTRAINT chk_action_proposal_risk CHECK (risk_level IN ('low', 'medium', 'high')),
  CONSTRAINT chk_action_proposal_status CHECK (status IN ('pending', 'approved', 'denied', 'executed', 'dry_run'))
);

CREATE INDEX IF NOT EXISTS idx_action_proposals_pending
  ON action_proposals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_proposals_incident
  ON action_proposals(incident_id, created_at ASC);
