-- Migration 002: Alerts table
-- Covers: alerts.sql (jarvis_alerts)

CREATE TABLE IF NOT EXISTS jarvis_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  value INTEGER,
  threshold INTEGER,
  suggestion TEXT,
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_user ON jarvis_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_time ON jarvis_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unresolved ON jarvis_alerts(user_id, resolved) WHERE resolved = FALSE;
