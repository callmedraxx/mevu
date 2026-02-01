-- UFC fighter records from Ball Don't Lie MMA API
-- Separate from teams table; schema differs (fighters vs teams)
-- Used to persist fighter W-L-D records for frontend display

CREATE TABLE IF NOT EXISTS ufc_fighter_records (
  name_normalized TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  record TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ufc_fighter_records_updated_at
  ON ufc_fighter_records(updated_at);

COMMENT ON TABLE ufc_fighter_records IS 'Fighter W-L-D records from Ball Don''t Lie MMA API; persists across restarts';
