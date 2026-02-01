-- Create frontend_games table to store precomputed frontend representations
-- of live games. This allows /api/games/frontend to serve data without running
-- CPU-intensive transformation logic on each request.

CREATE TABLE IF NOT EXISTS frontend_games (
  id           VARCHAR(255) PRIMARY KEY, -- matches live_games.id
  sport        VARCHAR(50),
  league       VARCHAR(50),
  slug         VARCHAR(255),
  live         BOOLEAN,
  ended        BOOLEAN,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  frontend_data JSONB NOT NULL
);

-- Index to support common filters in /api/games/frontend
CREATE INDEX IF NOT EXISTS idx_frontend_games_sport_live_ended_updated
ON frontend_games (sport, live, ended, updated_at DESC);

