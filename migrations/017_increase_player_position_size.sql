-- Migration: Increase player_position and team_abbreviation column sizes
-- Some positions (especially for NFL) can be longer than 10 characters
-- Examples: "QB/WR", "OL/DL", or full position names like "Wide Receiver"

ALTER TABLE game_player_stats
ALTER COLUMN player_position TYPE VARCHAR(50);

ALTER TABLE game_player_stats
ALTER COLUMN team_abbreviation TYPE VARCHAR(50);

