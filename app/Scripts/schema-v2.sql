/**
 * Database schema initialization for Mark.
 * Run this after creating the PostgreSQL database.
 */

-- Incidents table: tracks operational problems
CREATE TABLE IF NOT EXISTS incidents (
  id VARCHAR(255) PRIMARY KEY,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  title VARCHAR(1024) NOT NULL,
  description TEXT NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status VARCHAR(20) NOT NULL CHECK (status IN ('open', 'investigating', 'resolved', 'escalated')),
  
  trigger_event VARCHAR(255) NOT NULL,
  trigger_event_id VARCHAR(255) NOT NULL,
  correlation_id VARCHAR(255) NOT NULL,
  
  assigned_agent VARCHAR(255) NOT NULL,
  tags JSONB DEFAULT '[]'::jsonb,
  context JSONB DEFAULT '{}'::jsonb,
  
  investigation JSONB,
  resolved_at TIMESTAMP,
  resolution JSONB,
  ai_analysis JSONB
);

CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents (status);
CREATE INDEX IF NOT EXISTS idx_incidents_assigned_agent ON incidents (assigned_agent);
CREATE INDEX IF NOT EXISTS idx_incidents_correlation_id ON incidents (correlation_id);
CREATE INDEX IF NOT EXISTS idx_incidents_created_at ON incidents (created_at);

-- Incident actions: audit trail of what was tried
CREATE TABLE IF NOT EXISTS incident_actions (
  id SERIAL PRIMARY KEY,
  incident_id VARCHAR(255) NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  timestamp TIMESTAMP NOT NULL,
  
  agent VARCHAR(255) NOT NULL,
  action VARCHAR(255) NOT NULL,
  tool VARCHAR(255) NOT NULL,
  args JSONB DEFAULT '{}'::jsonb,
  result VARCHAR(20) NOT NULL CHECK (result IN ('success', 'failure')),
  details TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incident_actions_incident_id ON incident_actions (incident_id);
CREATE INDEX IF NOT EXISTS idx_incident_actions_timestamp ON incident_actions (timestamp);

-- Event log: audit trail of all events (sampling)
CREATE TABLE IF NOT EXISTS event_log (
  id VARCHAR(255) PRIMARY KEY,
  timestamp TIMESTAMP NOT NULL,
  source VARCHAR(100) NOT NULL,
  type VARCHAR(255) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  correlation_id VARCHAR(255),
  data JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log (type);
CREATE INDEX IF NOT EXISTS idx_event_log_timestamp ON event_log (timestamp);
CREATE INDEX IF NOT EXISTS idx_event_log_correlation_id ON event_log (correlation_id);

-- Approval requests: track what needed user sign-off
CREATE TABLE IF NOT EXISTS approval_requests (
  id VARCHAR(255) PRIMARY KEY,
  incident_id VARCHAR(255) NOT NULL REFERENCES incidents(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  action VARCHAR(1024) NOT NULL,
  reason TEXT NOT NULL,
  approved BOOLEAN,
  approved_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_incident_id ON approval_requests (incident_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_approved ON approval_requests (approved);

-- Repositories table: tracks which GitHub repositories are monitored
CREATE TABLE IF NOT EXISTS monitored_repositories (
  id VARCHAR(255) PRIMARY KEY,
  provider VARCHAR(50) NOT NULL DEFAULT 'github',
  owner VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL UNIQUE,
  local_path TEXT,
  default_branch VARCHAR(255) NOT NULL DEFAULT 'main',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  source VARCHAR(50) NOT NULL DEFAULT 'config',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitored_repositories_provider ON monitored_repositories (provider);
CREATE INDEX IF NOT EXISTS idx_monitored_repositories_enabled ON monitored_repositories (enabled);
CREATE INDEX IF NOT EXISTS idx_monitored_repositories_full_name ON monitored_repositories (full_name);
