-- Index for fast slug lookups (LOWER(slug) for case-insensitive match)
CREATE INDEX IF NOT EXISTS idx_crypto_markets_slug_lower ON crypto_markets (LOWER(slug));
