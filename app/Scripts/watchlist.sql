-- Run once in your PostgreSQL
-- Watchlist alerts
CREATE TABLE IF NOT EXISTS jarvis_watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  alert_type TEXT NOT NULL, -- 'above' or 'below'
  threshold NUMERIC NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, symbol, alert_type)
);

-- Portfolio holdings
CREATE TABLE IF NOT EXISTS jarvis_holdings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  avg_buy_price NUMERIC NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, symbol)
);

-- Market query audit (for learning)
CREATE TABLE IF NOT EXISTS jarvis_market_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  query_type TEXT NOT NULL, -- 'snapshot', 'brief', 'watchlist'
  symbol TEXT,
  response TEXT,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_watchlist_user ON jarvis_watchlist(user_id);
CREATE INDEX idx_holdings_user ON jarvis_holdings(user_id);