-- Add sort_timestamp for chronological ordering of frontend games.
-- sort_timestamp = date from slug + time from endDate (ensures games ordered by when they're played).
-- Enables ORDER BY sport, sort_timestamp for efficient chronological pagination.

-- Add column (nullable for existing rows until backfill)
ALTER TABLE frontend_games ADD COLUMN IF NOT EXISTS sort_timestamp TIMESTAMPTZ;

-- Backfill: date from slug (YYYY-MM-DD at end) + time from endDate
UPDATE frontend_games
SET sort_timestamp = CASE
  WHEN slug ~ '\d{4}-\d{2}-\d{2}$' AND frontend_data->>'endDate' IS NOT NULL AND (frontend_data->>'endDate')::timestamptz IS NOT NULL
  THEN ((regexp_match(slug, '(\d{4}-\d{2}-\d{2})$'))[1])::date + ((frontend_data->>'endDate')::timestamptz)::time
  WHEN slug ~ '\d{4}-\d{2}-\d{2}$'
  THEN ((regexp_match(slug, '(\d{4}-\d{2}-\d{2})$'))[1])::timestamp
  WHEN frontend_data->>'endDate' IS NOT NULL AND (frontend_data->>'endDate')::timestamptz IS NOT NULL
  THEN (frontend_data->>'endDate')::timestamptz
  ELSE '2099-12-31'::timestamptz
END
WHERE sort_timestamp IS NULL;

-- Index for ORDER BY sport, sort_timestamp (covers filtered + chronological queries)
CREATE INDEX IF NOT EXISTS idx_frontend_games_sport_sort_timestamp
ON frontend_games (sport NULLS LAST, sort_timestamp ASC NULLS LAST)
WHERE (slug IS NULL OR slug NOT LIKE '%-more-markets');

-- Index for unfiltered chronological queries
CREATE INDEX IF NOT EXISTS idx_frontend_games_sort_timestamp
ON frontend_games (sort_timestamp ASC NULLS LAST)
WHERE (slug IS NULL OR slug NOT LIKE '%-more-markets');
