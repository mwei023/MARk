-- Migration 007: Monitored repositories registry persistence
-- The repository registry upserts here on every register(); without this
-- table the persist silently no-ops and every restart re-discovers.

CREATE TABLE IF NOT EXISTS monitored_repositories (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'github',
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL UNIQUE,
  local_path TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  enabled BOOLEAN NOT NULL DEFAULT true,
  source TEXT NOT NULL DEFAULT 'config',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitored_repos_owner_name ON monitored_repositories(owner, name);
CREATE INDEX IF NOT EXISTS idx_monitored_repos_enabled ON monitored_repositories(enabled) WHERE enabled = true;
