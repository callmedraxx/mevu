-- Migration: Create kalshi_trades_history table
-- Stores Kalshi/Solana trade history for US users via DFlow

CREATE TABLE IF NOT EXISTS kalshi_trades_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_user_id TEXT NOT NULL,
  solana_wallet_address TEXT NOT NULL,
  -- Market info
  kalshi_ticker TEXT NOT NULL,
  outcome_mint TEXT NOT NULL,
  market_title TEXT,
  outcome TEXT,
  -- Trade details
  side TEXT NOT NULL,
  input_amount TEXT NOT NULL,
  output_amount TEXT NOT NULL,
  price_per_token NUMERIC(10,4),
  slippage_bps INTEGER,
  platform_fee TEXT,
  -- Execution
  dflow_order_id TEXT,
  execution_mode TEXT,
  solana_signature TEXT,
  status TEXT DEFAULT 'PENDING',
  error_message TEXT,
  -- Metadata
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kalshi_trades_privy ON kalshi_trades_history(privy_user_id);
CREATE INDEX IF NOT EXISTS idx_kalshi_trades_ticker ON kalshi_trades_history(kalshi_ticker);
CREATE INDEX IF NOT EXISTS idx_kalshi_trades_status ON kalshi_trades_history(status);
CREATE INDEX IF NOT EXISTS idx_kalshi_trades_created ON kalshi_trades_history(created_at);
