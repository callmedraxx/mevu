-- Migration: Create game_probability_history table
-- Tracks probability changes over time for calculating percent change

CREATE TABLE IF NOT EXISTS game_probability_history (
    id SERIAL PRIMARY KEY,
    game_id VARCHAR(255) NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
    home_probability DECIMAL(5, 2) NOT NULL,  -- e.g., 50.50
    away_probability DECIMAL(5, 2) NOT NULL,  -- e.g., 49.50
    home_buy_price INTEGER NOT NULL,          -- rounded up YES price
    away_buy_price INTEGER NOT NULL,          -- rounded up YES price
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Index for efficient queries
    CONSTRAINT fk_game FOREIGN KEY (game_id) REFERENCES live_games(id) ON DELETE CASCADE
);

-- Index for fast lookups by game_id and time
CREATE INDEX IF NOT EXISTS idx_probability_history_game_time 
ON game_probability_history(game_id, recorded_at DESC);

-- Index for cleanup of old records
CREATE INDEX IF NOT EXISTS idx_probability_history_recorded_at 
ON game_probability_history(recorded_at);

-- Comment
COMMENT ON TABLE game_probability_history IS 'Stores historical probability snapshots for calculating percent change over time';

