-- Add data_source column to live_games table to track the source of game data
-- 'live_games' = from live games endpoint (highest priority)
-- 'sports_games' = from sports games endpoint (can be replaced by live_games)

ALTER TABLE live_games 
ADD COLUMN IF NOT EXISTS data_source VARCHAR(20) DEFAULT 'live_games';

-- Set default for existing records
UPDATE live_games 
SET data_source = 'live_games' 
WHERE data_source IS NULL;

-- Create index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_live_games_data_source ON live_games(data_source);


