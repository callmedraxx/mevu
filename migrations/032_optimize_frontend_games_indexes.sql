-- Optimize frontend_games table for better query performance
-- 1. Ensure sport values are lowercase (for index efficiency)
-- 2. Add additional index for sport-only queries

-- Update existing sport values to lowercase
UPDATE frontend_games SET sport = LOWER(sport) WHERE sport IS NOT NULL;

-- Add index for sport-only queries (common case)
CREATE INDEX IF NOT EXISTS idx_frontend_games_sport_updated
ON frontend_games (sport, updated_at DESC)
WHERE sport IS NOT NULL;

-- The existing composite index covers most filter combinations
-- This additional index helps with sport-only queries
