-- Migration: Create user_pnl_history table
-- Tracks historical P&L snapshots for users to enable charting overall profit/loss over time

CREATE TABLE IF NOT EXISTS user_pnl_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_user_id VARCHAR(255) NOT NULL,
  
  -- P&L values (at the time of snapshot)
  total_pnl DECIMAL(36, 18) NOT NULL, -- Total P&L (realized + unrealized)
  realized_pnl DECIMAL(36, 18) NOT NULL DEFAULT 0, -- P&L from closed positions
  unrealized_pnl DECIMAL(36, 18) NOT NULL DEFAULT 0, -- P&L from active positions
  
  -- Portfolio values
  portfolio_value DECIMAL(36, 18) NOT NULL DEFAULT 0, -- Current portfolio value (active positions)
  usdc_balance DECIMAL(36, 18) NOT NULL DEFAULT 0, -- USDC balance at snapshot time
  total_value DECIMAL(36, 18) NOT NULL DEFAULT 0, -- Total value (portfolio + balance)
  
  -- Position counts
  active_positions_count INTEGER NOT NULL DEFAULT 0,
  total_positions_count INTEGER NOT NULL DEFAULT 0, -- All-time positions count
  
  -- Percentages
  total_percent_pnl DECIMAL(10, 4) NOT NULL DEFAULT 0, -- Percentage P&L
  
  -- Timestamp
  snapshot_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_user_pnl_history_privy_user_id ON user_pnl_history(privy_user_id);
CREATE INDEX IF NOT EXISTS idx_user_pnl_history_snapshot_at ON user_pnl_history(privy_user_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_pnl_history_user_snapshot ON user_pnl_history(privy_user_id, snapshot_at DESC);

-- Comments
COMMENT ON TABLE user_pnl_history IS 'Historical P&L snapshots for users to enable charting overall profit/loss over time';
COMMENT ON COLUMN user_pnl_history.total_pnl IS 'Total P&L (realized + unrealized)';
COMMENT ON COLUMN user_pnl_history.realized_pnl IS 'P&L from closed/realized positions (sold or redeemed)';
COMMENT ON COLUMN user_pnl_history.unrealized_pnl IS 'P&L from active/unrealized positions';
COMMENT ON COLUMN user_pnl_history.portfolio_value IS 'Current value of active positions';
COMMENT ON COLUMN user_pnl_history.total_value IS 'Total value (portfolio + USDC balance)';

