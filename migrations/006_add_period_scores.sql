-- Add period_scores column to live_games table
-- Stores period-by-period scores as JSONB: { q1: { home: 25, away: 20 }, q2: { home: 30, away: 25 }, ... }
-- Supports different period formats (Q1-Q4 for NBA/NFL, P1-P3 for NHL, 1H-2H for soccer)

ALTER TABLE live_games 
ADD COLUMN IF NOT EXISTS period_scores JSONB;

-- Create index for period_scores queries (optional, but can help with filtering)
CREATE INDEX IF NOT EXISTS idx_live_games_period_scores ON live_games USING GIN (period_scores);
