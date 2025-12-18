-- Migration: Add portfolio column to users table
-- Stores the total current value of all user positions

ALTER TABLE users ADD COLUMN IF NOT EXISTS portfolio NUMERIC(20,6) DEFAULT 0;

-- Index for efficient portfolio queries (if needed for leaderboards, etc.)
CREATE INDEX IF NOT EXISTS idx_users_portfolio ON users(portfolio DESC);

-- Comment
COMMENT ON COLUMN users.portfolio IS 'Total current value of all user positions (sum of current_value from user_positions)';
