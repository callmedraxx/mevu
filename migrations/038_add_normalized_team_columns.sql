-- Add normalized team columns to live_games for efficient SQL matching with Kalshi
ALTER TABLE live_games
ADD COLUMN IF NOT EXISTS home_team_normalized VARCHAR(255),
ADD COLUMN IF NOT EXISTS away_team_normalized VARCHAR(255),
ADD COLUMN IF NOT EXISTS home_abbr VARCHAR(20),
ADD COLUMN IF NOT EXISTS away_abbr VARCHAR(20);

-- Index for efficient team/date matching with Kalshi markets
CREATE INDEX IF NOT EXISTS idx_live_games_team_matching
ON live_games(sport, start_date, home_team_normalized, away_team_normalized);
