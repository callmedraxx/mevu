-- Migration: Create user_positions table
-- Stores user positions fetched from Polymarket Data API

CREATE TABLE IF NOT EXISTS user_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_user_id VARCHAR(255) NOT NULL,
  proxy_wallet_address VARCHAR(42) NOT NULL,
  
  -- Position identifiers
  asset VARCHAR(255) NOT NULL, -- Token ID (used as clobTokenId for selling)
  condition_id VARCHAR(66) NOT NULL, -- Condition ID (0x...)
  
  -- Position metrics
  size NUMERIC(20,6) NOT NULL,
  avg_price NUMERIC(20,6) NOT NULL,
  initial_value NUMERIC(20,6) NOT NULL,
  current_value NUMERIC(20,6) NOT NULL,
  cash_pnl NUMERIC(20,6) NOT NULL,
  percent_pnl NUMERIC(10,4) NOT NULL,
  cur_price NUMERIC(20,6) NOT NULL,
  
  -- Position status
  redeemable BOOLEAN DEFAULT FALSE,
  mergeable BOOLEAN DEFAULT FALSE,
  negative_risk BOOLEAN DEFAULT FALSE,
  
  -- Market information
  title VARCHAR(500),
  slug VARCHAR(255),
  event_id VARCHAR(255),
  event_slug VARCHAR(255),
  outcome VARCHAR(255),
  outcome_index INTEGER,
  opposite_outcome VARCHAR(255),
  opposite_asset VARCHAR(255),
  end_date DATE,
  
  -- Metadata
  total_bought NUMERIC(20,6),
  realized_pnl NUMERIC(20,6),
  percent_realized_pnl NUMERIC(10,4),
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  
  -- Foreign key constraint
  CONSTRAINT fk_user_positions_user FOREIGN KEY (privy_user_id) REFERENCES users(privy_user_id) ON DELETE CASCADE
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_user_positions_privy_user_id ON user_positions(privy_user_id);
CREATE INDEX IF NOT EXISTS idx_user_positions_proxy_wallet ON user_positions(proxy_wallet_address);
CREATE INDEX IF NOT EXISTS idx_user_positions_asset ON user_positions(asset);
CREATE INDEX IF NOT EXISTS idx_user_positions_event_id ON user_positions(event_id);
CREATE INDEX IF NOT EXISTS idx_user_positions_updated_at ON user_positions(updated_at DESC);

-- Unique constraint: one position per user per asset
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_positions_unique_user_asset ON user_positions(privy_user_id, asset);

-- Comment
COMMENT ON TABLE user_positions IS 'Stores user positions fetched from Polymarket Data API. Positions are updated on-demand when user requests their positions.';
