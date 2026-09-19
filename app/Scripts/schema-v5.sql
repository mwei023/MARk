-- MARK schema v5: episodic learning memory + tool reliability stats.
-- Trust streaks live in ~/.config/mark/trust.json alongside grants (no DB needed).

CREATE TABLE IF NOT EXISTS episode_memory (
  id VARCHAR(255) PRIMARY KEY,
  tool_id VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL,
  summary TEXT NOT NULL,
  goal TEXT,
  error TEXT,
  embedding vector(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_episode_memory_tool ON episode_memory (tool_id);
CREATE INDEX IF NOT EXISTS idx_episode_memory_created ON episode_memory (created_at);

CREATE TABLE IF NOT EXISTS tool_reliability (
  tool_id VARCHAR(255) PRIMARY KEY,
  success INTEGER NOT NULL DEFAULT 0,
  failure INTEGER NOT NULL DEFAULT 0,
  verify_fail INTEGER NOT NULL DEFAULT 0,
  recovery_success INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
