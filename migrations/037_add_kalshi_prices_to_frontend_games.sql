-- Add Kalshi price columns to frontend_games
-- These will be populated during frontend_games transformation when a match exists
ALTER TABLE frontend_games
ADD COLUMN IF NOT EXISTS kalshi_away_buy SMALLINT,     -- Kalshi buy price for away team (cents)
ADD COLUMN IF NOT EXISTS kalshi_away_sell SMALLINT,    -- Kalshi sell price for away team
ADD COLUMN IF NOT EXISTS kalshi_home_buy SMALLINT,     -- Kalshi buy price for home team
ADD COLUMN IF NOT EXISTS kalshi_home_sell SMALLINT,    -- Kalshi sell price for home team
ADD COLUMN IF NOT EXISTS kalshi_ticker VARCHAR(255);   -- Kalshi market ticker for linking
