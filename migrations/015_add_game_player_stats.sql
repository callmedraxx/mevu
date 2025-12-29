-- Migration: Add game player stats support
-- Links player statistics from Ball Don't Lie API to live_games

-- Add column to store Ball Don't Lie game ID for mapping
-- This allows us to map Polymarket game_id to Ball Don't Lie game_id
ALTER TABLE live_games
ADD COLUMN IF NOT EXISTS balldontlie_game_id INTEGER;

-- Create index for fast lookups by Ball Don't Lie game ID
CREATE INDEX IF NOT EXISTS idx_live_games_balldontlie_game_id 
ON live_games(balldontlie_game_id) 
WHERE balldontlie_game_id IS NOT NULL;

-- Create game_player_stats table
-- Stores player statistics for each game, linked to live_games
CREATE TABLE IF NOT EXISTS game_player_stats (
    id SERIAL PRIMARY KEY,
    game_id VARCHAR(255) NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
    balldontlie_game_id INTEGER, -- Denormalized for faster queries
    player_id INTEGER NOT NULL, -- Ball Don't Lie player ID
    player_first_name VARCHAR(255),
    player_last_name VARCHAR(255),
    player_position VARCHAR(10),
    team_id INTEGER, -- Ball Don't Lie team ID
    team_abbreviation VARCHAR(10),
    team_name VARCHAR(255),
    is_home BOOLEAN, -- true for home team, false for away team
    
    -- Game stats (from Ball Don't Lie API)
    min VARCHAR(10), -- Minutes played (e.g., "35:24")
    fgm INTEGER, -- Field goals made
    fga INTEGER, -- Field goals attempted
    fg_pct DECIMAL(5, 3), -- Field goal percentage
    fg3m INTEGER, -- 3-pointers made
    fg3a INTEGER, -- 3-pointers attempted
    fg3_pct DECIMAL(5, 3), -- 3-point percentage
    ftm INTEGER, -- Free throws made
    fta INTEGER, -- Free throws attempted
    ft_pct DECIMAL(5, 3), -- Free throw percentage
    oreb INTEGER, -- Offensive rebounds
    dreb INTEGER, -- Defensive rebounds
    reb INTEGER, -- Total rebounds
    ast INTEGER, -- Assists
    stl INTEGER, -- Steals
    blk INTEGER, -- Blocks
    turnover INTEGER, -- Turnovers
    pf INTEGER, -- Personal fouls
    pts INTEGER, -- Points
    
    -- Metadata
    sport VARCHAR(10), -- Sport name (nba, nfl, mlb, nhl, epl)
    sport_stats JSONB, -- Sport-specific stats stored as JSONB for flexibility
    stats_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Ensure one stat record per player per game
    CONSTRAINT unique_player_game UNIQUE (game_id, player_id)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_player_stats_game_id 
ON game_player_stats(game_id);

CREATE INDEX IF NOT EXISTS idx_player_stats_balldontlie_game_id 
ON game_player_stats(balldontlie_game_id) 
WHERE balldontlie_game_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_player_stats_player_id 
ON game_player_stats(player_id);

CREATE INDEX IF NOT EXISTS idx_player_stats_team_id 
ON game_player_stats(team_id);

CREATE INDEX IF NOT EXISTS idx_player_stats_updated_at 
ON game_player_stats(stats_updated_at DESC);

-- Index for querying by game and team
CREATE INDEX IF NOT EXISTS idx_player_stats_game_team 
ON game_player_stats(game_id, is_home);

-- Comment
COMMENT ON TABLE game_player_stats IS 'Stores real-time player statistics from Ball Don''t Lie API, linked to live_games';
COMMENT ON COLUMN game_player_stats.game_id IS 'References live_games.id (Polymarket event ID)';
COMMENT ON COLUMN game_player_stats.balldontlie_game_id IS 'Ball Don''t Lie game ID (denormalized for faster queries)';

