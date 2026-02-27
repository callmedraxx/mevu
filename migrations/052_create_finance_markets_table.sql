-- Finance markets table for Polymarket finance events (Stocks, Indices, Commodities, etc.)
-- Same schema as crypto_markets, fetched from Gamma API with tag_id=120 (Finance)

CREATE TABLE IF NOT EXISTS finance_markets (
  -- Event-level fields (from Gamma API)
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  resolution_source TEXT,
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  image TEXT,
  image_raw TEXT,
  icon TEXT,
  active BOOLEAN DEFAULT true,
  closed BOOLEAN DEFAULT false,
  archived BOOLEAN DEFAULT false,
  new BOOLEAN DEFAULT false,
  featured BOOLEAN DEFAULT false,
  restricted BOOLEAN DEFAULT false,
  liquidity NUMERIC,
  volume NUMERIC,
  open_interest NUMERIC,
  competitive NUMERIC,
  enable_order_book BOOLEAN DEFAULT true,
  liquidity_clob NUMERIC,
  neg_risk BOOLEAN DEFAULT false,
  comment_count INTEGER DEFAULT 0,
  cyom BOOLEAN DEFAULT false,
  show_all_outcomes BOOLEAN DEFAULT true,
  show_market_images BOOLEAN DEFAULT true,
  automatically_active BOOLEAN DEFAULT true,
  neg_risk_augmented BOOLEAN DEFAULT false,
  pending_deployment BOOLEAN DEFAULT false,
  deploying BOOLEAN DEFAULT false,
  is_live BOOLEAN DEFAULT false,
  start_time TIMESTAMPTZ,
  series_slug TEXT,

  -- Categorization columns (extracted from tags)
  timeframe TEXT,
  asset TEXT,
  tags TEXT[],

  -- Nested JSON (SSR-compatible structure)
  markets JSONB NOT NULL,
  series JSONB,
  tags_data JSONB,

  -- Pricing
  opening_price NUMERIC,
  closing_price NUMERIC,
  price_high NUMERIC,
  price_low NUMERIC,
  odds_high NUMERIC,
  odds_low NUMERIC,

  -- Raw storage
  raw_data JSONB NOT NULL,

  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for querying
CREATE INDEX IF NOT EXISTS idx_finance_markets_active ON finance_markets (active, closed, archived);
CREATE INDEX IF NOT EXISTS idx_finance_markets_timeframe ON finance_markets (timeframe);
CREATE INDEX IF NOT EXISTS idx_finance_markets_asset ON finance_markets (asset);
CREATE INDEX IF NOT EXISTS idx_finance_markets_timeframe_asset ON finance_markets (timeframe, asset);
CREATE INDEX IF NOT EXISTS idx_finance_markets_tags ON finance_markets USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_finance_markets_end_date ON finance_markets (end_date);
CREATE INDEX IF NOT EXISTS idx_finance_markets_volume ON finance_markets (volume DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_finance_markets_series_slug ON finance_markets (series_slug);
CREATE INDEX IF NOT EXISTS idx_finance_markets_slug ON finance_markets (LOWER(slug));
