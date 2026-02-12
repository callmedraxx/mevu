-- Migration: Create kalshi_positions table
-- Tracks user positions in Kalshi outcome tokens (SPL tokens)

CREATE TABLE IF NOT EXISTS kalshi_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_user_id TEXT NOT NULL,
  solana_wallet_address TEXT NOT NULL,
  kalshi_ticker TEXT NOT NULL,
  outcome_mint TEXT NOT NULL,
  outcome TEXT NOT NULL,
  market_title TEXT,
  -- Position data
  token_balance TEXT NOT NULL DEFAULT '0',
  avg_entry_price NUMERIC(10,4),
  total_cost_usdc NUMERIC(20,6) DEFAULT 0,
  -- Status
  is_redeemable BOOLEAN DEFAULT FALSE,
  is_winning BOOLEAN DEFAULT NULL,
  redeemed_at TIMESTAMPTZ DEFAULT NULL,
  -- Metadata
  live_game_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(privy_user_id, outcome_mint)
);

CREATE INDEX IF NOT EXISTS idx_kalshi_positions_privy ON kalshi_positions(privy_user_id);
CREATE INDEX IF NOT EXISTS idx_kalshi_positions_mint ON kalshi_positions(outcome_mint);
CREATE INDEX IF NOT EXISTS idx_kalshi_positions_game ON kalshi_positions(live_game_id);
