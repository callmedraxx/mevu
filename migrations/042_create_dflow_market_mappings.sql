-- Migration: Create dflow_market_mappings table
-- Maps Kalshi tickers to DFlow SPL token mint addresses

CREATE TABLE IF NOT EXISTS dflow_market_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kalshi_ticker TEXT NOT NULL UNIQUE,
  yes_mint TEXT NOT NULL,
  no_mint TEXT NOT NULL,
  settlement_mint TEXT NOT NULL,
  market_ledger TEXT,
  status TEXT DEFAULT 'active',
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dflow_mappings_ticker ON dflow_market_mappings(kalshi_ticker);
CREATE INDEX IF NOT EXISTS idx_dflow_mappings_yes_mint ON dflow_market_mappings(yes_mint);
CREATE INDEX IF NOT EXISTS idx_dflow_mappings_no_mint ON dflow_market_mappings(no_mint);
