-- Create live_games table
CREATE TABLE IF NOT EXISTS live_games (
  id VARCHAR(255) PRIMARY KEY,
  ticker VARCHAR(255),
  slug VARCHAR(255) NOT NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  resolution_source TEXT,
  start_date TIMESTAMP,
  end_date TIMESTAMP,
  image TEXT,
  icon TEXT,
  active BOOLEAN DEFAULT true,
  closed BOOLEAN DEFAULT false,
  archived BOOLEAN DEFAULT false,
  restricted BOOLEAN DEFAULT false,
  liquidity DECIMAL(20, 2),
  volume DECIMAL(20, 2),
  volume_24hr DECIMAL(20, 2),
  competitive DECIMAL(10, 4),
  sport VARCHAR(50),
  league VARCHAR(50),
  series_id VARCHAR(255),
  game_id INTEGER,
  score VARCHAR(50),
  period VARCHAR(50),
  elapsed VARCHAR(50),
  live BOOLEAN DEFAULT false,
  ended BOOLEAN DEFAULT false,
  transformed_data JSONB,
  raw_data JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_live_games_sport ON live_games(sport);
CREATE INDEX IF NOT EXISTS idx_live_games_league ON live_games(league);
CREATE INDEX IF NOT EXISTS idx_live_games_active ON live_games(active);
CREATE INDEX IF NOT EXISTS idx_live_games_live ON live_games(live);
CREATE INDEX IF NOT EXISTS idx_live_games_game_id ON live_games(game_id);
CREATE INDEX IF NOT EXISTS idx_live_games_volume_24hr ON live_games(volume_24hr DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_live_games_start_date ON live_games(start_date);

