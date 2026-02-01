-- Migration: Add optimized index for live_games ordering used by /api/games/frontend
--
-- The getAllLiveGamesFromDatabase() query orders by:
--   ORDER BY
--     CASE WHEN live = true THEN 0 ELSE 1 END,
--     volume_24hr DESC NULLS LAST,
--     created_at DESC
--
-- This composite index helps PostgreSQL satisfy that ORDER BY more efficiently.

CREATE INDEX IF NOT EXISTS idx_live_games_live_volume_created
ON live_games (
  live,
  volume_24hr DESC,
  created_at DESC
);

