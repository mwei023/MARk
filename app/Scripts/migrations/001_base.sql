-- Migration 001: Base tables
-- Covers: init-db.sql (documents, audit_logs) + schema-v2.sql (incidents, incident_actions)

CREATE EXTENSION IF NOT EXISTS vector;

-- RAG document store
CREATE TABLE IF NOT EXISTS documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  text TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  embedding vector(1024),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_embedding
  ON documents USING hnsw (embedding vector_cosine_ops);

-- Generic audit log
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Incident store
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

CREATE TABLE IF NOT EXISTS incident_actions (
  id BIGSERIAL PRIMARY KEY,
  incident_id VARCHAR(255) NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  timestamp TIMESTAMP NOT NULL,
  agent VARCHAR(255) NOT NULL,
  action VARCHAR(255) NOT NULL,
  tool VARCHAR(255) NOT NULL,
  args JSONB DEFAULT '{}'::jsonb,
  result VARCHAR(20) NOT NULL,
  details TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incident_actions_incident ON incident_actions(incident_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_correlation ON incidents(correlation_id);
