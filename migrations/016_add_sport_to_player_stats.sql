-- Migration: Add sport support to game_player_stats
-- Extends player stats table to support multiple sports (NBA, NFL, MLB, NHL, EPL)

-- Add sport column to track which sport the stats are for
ALTER TABLE game_player_stats
ADD COLUMN IF NOT EXISTS sport VARCHAR(50);

-- Add JSONB column for sport-specific stats
-- Different sports have different stat fields (NFL has pass_yds, MLB has hr, etc.)
ALTER TABLE game_player_stats
ADD COLUMN IF NOT EXISTS sport_stats JSONB;

-- Create index for sport-based queries
CREATE INDEX IF NOT EXISTS idx_player_stats_sport 
ON game_player_stats(sport) 
WHERE sport IS NOT NULL;

-- Create index for sport_stats JSONB queries
CREATE INDEX IF NOT EXISTS idx_player_stats_sport_stats 
ON game_player_stats USING GIN (sport_stats) 
WHERE sport_stats IS NOT NULL;

-- Update unique constraint to include sport (allows same player_id in different sports)
-- Note: This is a breaking change if you have existing data, but it's necessary
-- for multi-sport support. If you have existing data, you may need to:
-- 1. Drop the old constraint
-- 2. Add the new constraint
-- 3. Update existing rows to set sport = 'nba' (or appropriate sport)

-- Drop old constraint if it exists
ALTER TABLE game_player_stats
DROP CONSTRAINT IF EXISTS unique_player_game;

-- Add new constraint with sport
ALTER TABLE game_player_stats
ADD CONSTRAINT unique_player_game_sport 
UNIQUE (game_id, player_id, sport);

-- Comments
COMMENT ON COLUMN game_player_stats.sport IS 'Sport name (nba, nfl, mlb, nhl, epl)';
COMMENT ON COLUMN game_player_stats.sport_stats IS 'Sport-specific statistics stored as JSONB (e.g., NFL pass_yds, MLB hr, NHL goals)';

