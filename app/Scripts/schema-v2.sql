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
  correlation_id VARCHAR(255) NOT NULL, -- Links related events
  
  assigned_agent VARCHAR(255) NOT NULL,
  tags JSONB DEFAULT '[]',
  context JSONB DEFAULT '{}',
  
  investigation JSONB,
  resolved_at TIMESTAMP,
  resolution JSONB,
  ai_analysis JSONB,
  
  INDEX idx_status (status),
  INDEX idx_assigned_agent (assigned_agent),
  INDEX idx_correlation_id (correlation_id),
  INDEX idx_created_at (created_at)
);

-- Incident actions: audit trail of what was tried
CREATE TABLE IF NOT EXISTS incident_actions (
  id SERIAL PRIMARY KEY,
  incident_id VARCHAR(255) NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  timestamp TIMESTAMP NOT NULL,
  
  agent VARCHAR(255) NOT NULL, -- Which agent performed this
  action VARCHAR(255) NOT NULL, -- What was done
  tool VARCHAR(255) NOT NULL, -- Which tool was used
  args JSONB DEFAULT '{}',
  result VARCHAR(20) NOT NULL CHECK (result IN ('success', 'failure')), -- Outcome
  details TEXT NOT NULL,
  
  INDEX idx_incident_id (incident_id),
  INDEX idx_timestamp (timestamp)
);

-- Event log: audit trail of all events (sampling)
CREATE TABLE IF NOT EXISTS event_log (
  id VARCHAR(255) PRIMARY KEY,
  timestamp TIMESTAMP NOT NULL,
  source VARCHAR(100) NOT NULL,
  type VARCHAR(255) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  correlation_id VARCHAR(255),
  data JSONB DEFAULT '{}',
  
  INDEX idx_type (type),
  INDEX idx_timestamp (timestamp),
  INDEX idx_correlation_id (correlation_id)
);

-- Approval requests: track what needed user sign-off
CREATE TABLE IF NOT EXISTS approval_requests (
  id VARCHAR(255) PRIMARY KEY,
  incident_id VARCHAR(255) NOT NULL REFERENCES incidents(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  action VARCHAR(1024) NOT NULL,
  reason TEXT NOT NULL,
  approved BOOLEAN,
  approved_at TIMESTAMP,
  
  INDEX idx_incident_id (incident_id),
  INDEX idx_approved (approved)
);
