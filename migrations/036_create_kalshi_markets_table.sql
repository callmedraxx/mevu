-- Store Kalshi markets keyed by their ticker
-- Matching to Polymarket is done via live_game_id (foreign key to live_games)
CREATE TABLE IF NOT EXISTS kalshi_markets (
  ticker VARCHAR(255) PRIMARY KEY,          -- Kalshi market ticker (unique ID)
  event_ticker VARCHAR(255),                 -- Kalshi event ticker
  title VARCHAR(500),                        -- Market question/title
  subtitle VARCHAR(500),                     -- Market subtitle
  status VARCHAR(50),                        -- open, closed, settled
  close_ts TIMESTAMP,                        -- When market closes
  sport VARCHAR(50),                         -- nba, nfl, etc.
  league VARCHAR(50),                        -- League identifier

  -- Matching fields (for joining with live_games)
  home_team VARCHAR(255),                    -- Normalized home team name
  away_team VARCHAR(255),                    -- Normalized away team name
  home_team_abbr VARCHAR(20),                -- Team abbreviation
  away_team_abbr VARCHAR(20),                -- Team abbreviation
  game_date DATE,                            -- Game date (for matching)
  live_game_id VARCHAR(255),                 -- FK to live_games.id (NULL if unmatched)

  -- Price data (stored as cents, 0-100)
  yes_bid SMALLINT,                          -- Best bid for YES (sell price)
  yes_ask SMALLINT,                          -- Best ask for YES (buy price)
  no_bid SMALLINT,                           -- Best bid for NO
  no_ask SMALLINT,                           -- Best ask for NO

  -- Volume/liquidity
  volume DECIMAL(20, 2),
  open_interest DECIMAL(20, 2),

  -- Raw data for debugging
  raw_data JSONB,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient matching
CREATE INDEX IF NOT EXISTS idx_kalshi_markets_live_game_id ON kalshi_markets(live_game_id);
CREATE INDEX IF NOT EXISTS idx_kalshi_markets_sport ON kalshi_markets(sport);
CREATE INDEX IF NOT EXISTS idx_kalshi_markets_status ON kalshi_markets(status);
CREATE INDEX IF NOT EXISTS idx_kalshi_markets_close_ts ON kalshi_markets(close_ts);

-- Composite index for team/date matching (used by matching query)
CREATE INDEX IF NOT EXISTS idx_kalshi_markets_matching
ON kalshi_markets(sport, game_date, home_team, away_team);
