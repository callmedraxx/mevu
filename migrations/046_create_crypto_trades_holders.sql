-- Crypto trades table (separate from sports trades, no FK to live_games)
CREATE TABLE IF NOT EXISTS crypto_trades (
  id SERIAL PRIMARY KEY,
  crypto_market_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  proxy_wallet TEXT,
  side TEXT NOT NULL,          -- 'BUY' or 'SELL'
  size NUMERIC NOT NULL,
  price NUMERIC NOT NULL,
  outcome TEXT,
  outcome_index INTEGER,
  timestamp BIGINT NOT NULL,
  transaction_hash TEXT,
  name TEXT,
  pseudonym TEXT,
  profile_image TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crypto_trades_txhash ON crypto_trades (transaction_hash) WHERE transaction_hash IS NOT NULL AND transaction_hash != '';
CREATE INDEX IF NOT EXISTS idx_crypto_trades_market ON crypto_trades (crypto_market_id);
CREATE INDEX IF NOT EXISTS idx_crypto_trades_ts ON crypto_trades (crypto_market_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_crypto_trades_whale ON crypto_trades (crypto_market_id, size, price) WHERE (size * price) >= 1000;

-- Crypto holders table
CREATE TABLE IF NOT EXISTS crypto_holders (
  id SERIAL PRIMARY KEY,
  crypto_market_id TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  token TEXT,
  proxy_wallet TEXT NOT NULL,
  asset TEXT,
  amount NUMERIC NOT NULL DEFAULT 0,
  outcome_index INTEGER,
  name TEXT,
  pseudonym TEXT,
  profile_image TEXT,
  verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crypto_holders_wallet_asset ON crypto_holders (crypto_market_id, proxy_wallet, asset);
CREATE INDEX IF NOT EXISTS idx_crypto_holders_market ON crypto_holders (crypto_market_id);
CREATE INDEX IF NOT EXISTS idx_crypto_holders_amount ON crypto_holders (crypto_market_id, amount DESC);

-- Fetch timestamp tracking (cooldown for Polymarket API calls)
CREATE TABLE IF NOT EXISTS crypto_market_fetch_log (
  crypto_market_id TEXT NOT NULL,
  fetch_type TEXT NOT NULL,         -- 'trades' or 'holders'
  last_fetched_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (crypto_market_id, fetch_type)
);
