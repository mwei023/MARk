-- Migration 009: personal tasks and calendar events
-- Local-first task tracking and event scheduling for the assistant domain.
-- No external sync: rows are created by task.* / schedule.* kernel tools.

CREATE TABLE IF NOT EXISTS assistant_tasks (
  id VARCHAR(255) PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT chk_task_status CHECK (status IN ('open', 'done', 'cancelled')),
  CONSTRAINT chk_task_priority CHECK (priority IN ('low', 'normal', 'high'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON assistant_tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON assistant_tasks(due_at) WHERE due_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS assistant_events (
  id VARCHAR(255) PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  location TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_event_status CHECK (status IN ('scheduled', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_events_start ON assistant_events(starts_at);
CREATE INDEX IF NOT EXISTS idx_events_status ON assistant_events(status);
