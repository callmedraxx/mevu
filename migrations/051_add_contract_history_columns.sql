-- Add columns for tracking price and odds extremes during contract windows
-- price_high / price_low: Chainlink asset price extremes during the window
-- odds_high / odds_low: Up outcome CLOB price extremes (0-100 cents)

ALTER TABLE crypto_markets ADD COLUMN IF NOT EXISTS price_high NUMERIC;
ALTER TABLE crypto_markets ADD COLUMN IF NOT EXISTS price_low NUMERIC;
ALTER TABLE crypto_markets ADD COLUMN IF NOT EXISTS odds_high NUMERIC;
ALTER TABLE crypto_markets ADD COLUMN IF NOT EXISTS odds_low NUMERIC;
