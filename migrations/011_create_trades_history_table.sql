-- Migration: Create trades_history table
-- Tracks user trades on Polymarket for PnL calculation and trade history

CREATE TABLE IF NOT EXISTS trades_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_user_id VARCHAR(255) NOT NULL,
  proxy_wallet_address VARCHAR(42) NOT NULL,
  
  -- Market information
  market_id VARCHAR(255) NOT NULL,
  market_question TEXT,
  clob_token_id VARCHAR(255) NOT NULL,
  outcome TEXT NOT NULL, -- The outcome/choice the user traded
  
  -- Trade details
  side VARCHAR(10) NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type VARCHAR(20) NOT NULL CHECK (order_type IN ('FOK', 'FAK', 'LIMIT', 'MARKET')),
  
  -- Amounts
  size DECIMAL(36, 18) NOT NULL, -- Number of shares
  price DECIMAL(36, 18) NOT NULL, -- Price per share
  cost_usdc DECIMAL(36, 18) NOT NULL, -- Total cost in USDC (size * price)
  
  -- Fees
  fee_usdc DECIMAL(36, 18) DEFAULT 0, -- Fee paid in USDC
  
  -- Transaction details
  order_id VARCHAR(255), -- CLOB order ID
  transaction_hash VARCHAR(66), -- On-chain transaction hash
  block_number BIGINT,
  block_timestamp TIMESTAMP WITH TIME ZONE,
  
  -- Status
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'FAILED')),
  
  -- Metadata
  metadata JSONB, -- Additional market/trade metadata from frontend
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_trades_history_privy_user_id ON trades_history(privy_user_id);
CREATE INDEX IF NOT EXISTS idx_trades_history_proxy_wallet ON trades_history(proxy_wallet_address);
CREATE INDEX IF NOT EXISTS idx_trades_history_market_id ON trades_history(market_id);
CREATE INDEX IF NOT EXISTS idx_trades_history_clob_token_id ON trades_history(clob_token_id);
CREATE INDEX IF NOT EXISTS idx_trades_history_status ON trades_history(status);
CREATE INDEX IF NOT EXISTS idx_trades_history_created_at ON trades_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_history_side ON trades_history(side);

-- Composite index for user trade history queries
CREATE INDEX IF NOT EXISTS idx_trades_history_user_created ON trades_history(privy_user_id, created_at DESC);

-- Comments
COMMENT ON TABLE trades_history IS 'Tracks all user trades on Polymarket for history and PnL calculation';
COMMENT ON COLUMN trades_history.clob_token_id IS 'The CLOB token ID for the specific outcome being traded';
COMMENT ON COLUMN trades_history.cost_usdc IS 'Total cost in USDC (size * price)';
COMMENT ON COLUMN trades_history.fee_usdc IS 'Fee paid in USDC for this trade';
