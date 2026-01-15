-- Migration: Add optimized indexes for Ocean trades queries
-- Improves performance for aggregating whale trades across all live games

-- Composite index for ocean trades queries
-- Covers: game_id filter, cost_usdc filter (>= minAmount), and created_at ordering
CREATE INDEX IF NOT EXISTS idx_trades_game_cost_created 
ON trades(game_id, (size * price), created_at DESC) 
WHERE (size * price) >= 1000;

-- Index for cost_usdc filtering (for whale trades >= $1000)
-- This helps with the WHERE (size * price) >= minAmount filter
CREATE INDEX IF NOT EXISTS idx_trades_cost_usdc 
ON trades((size * price) DESC) 
WHERE (size * price) >= 1000;

-- Composite index for filtering by side and cost
-- Helps with type filter (buy/sell)
CREATE INDEX IF NOT EXISTS idx_trades_side_cost_created 
ON trades(side, (size * price), created_at DESC) 
WHERE (size * price) >= 1000;

-- Comment
COMMENT ON INDEX idx_trades_game_cost_created IS 'Optimized index for Ocean page: filters by game_id and whale trades (>= $1000), orders by created_at';
COMMENT ON INDEX idx_trades_cost_usdc IS 'Index for filtering whale trades by minimum amount';
COMMENT ON INDEX idx_trades_side_cost_created IS 'Index for filtering whale trades by side (buy/sell) and amount';

