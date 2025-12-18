-- Migration: Add REDEEM to trades_history constraints
-- Allows tracking redemption transactions in trade history

-- Drop existing constraints
ALTER TABLE trades_history DROP CONSTRAINT IF EXISTS trades_history_side_check;
ALTER TABLE trades_history DROP CONSTRAINT IF EXISTS trades_history_order_type_check;

-- Add updated constraints with REDEEM option
ALTER TABLE trades_history ADD CONSTRAINT trades_history_side_check 
  CHECK (side IN ('BUY', 'SELL', 'REDEEM'));

ALTER TABLE trades_history ADD CONSTRAINT trades_history_order_type_check 
  CHECK (order_type IN ('FOK', 'FAK', 'LIMIT', 'MARKET', 'REDEEM'));

-- Add comment
COMMENT ON COLUMN trades_history.side IS 'Trade side: BUY, SELL, or REDEEM (for redemption of winning positions)';
