-- Create teams table
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  league VARCHAR(50) NOT NULL,
  record VARCHAR(50),
  logo TEXT,
  abbreviation VARCHAR(10) NOT NULL,
  alias VARCHAR(255),
  provider_id INTEGER,
  color VARCHAR(50),
  api_created_at TIMESTAMP,
  api_updated_at TIMESTAMP,
  db_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index on league for faster queries
CREATE INDEX IF NOT EXISTS idx_teams_league ON teams(league);

-- Create index on abbreviation for logo lookups
CREATE INDEX IF NOT EXISTS idx_teams_abbreviation ON teams(league, abbreviation);

