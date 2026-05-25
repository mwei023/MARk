-- src/db/migrations/002_alerts.sql
CREATE TABLE IF NOT EXISTS jarvis_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  alert_type TEXT NOT NULL, -- 'disk', 'memory', 'cpu', 'service', 'cloudflared'
  severity TEXT NOT NULL,   -- 'warning', 'critical'
  message TEXT NOT NULL,
  value INTEGER,            -- e.g., 99 for 99%
  threshold INTEGER,        -- e.g., 90 for threshold
  suggestion TEXT,          -- "Would you like me to...?"
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_alerts_user ON jarvis_alerts(user_id);
CREATE INDEX idx_alerts_time ON jarvis_alerts(created_at DESC);
CREATE INDEX idx_alerts_unresolved ON jarvis_alerts(user_id, resolved) WHERE resolved = FALSE;