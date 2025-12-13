-- Migration: Create trades table
-- Stores trade data from Polymarket data API for live trade widget

CREATE TABLE IF NOT EXISTS trades (
    id SERIAL PRIMARY KEY,
    proxy_wallet VARCHAR(255),
    side VARCHAR(10) NOT NULL,  -- 'BUY' or 'SELL'
    asset VARCHAR(255),
    condition_id VARCHAR(255) NOT NULL,
    size DECIMAL(20, 8) NOT NULL,
    price DECIMAL(20, 8) NOT NULL,
    timestamp BIGINT NOT NULL,
    title VARCHAR(500),
    slug VARCHAR(255),
    icon TEXT,
    event_slug VARCHAR(255),
    outcome VARCHAR(255),
    outcome_index INTEGER,
    name VARCHAR(255),  -- trader name
    pseudonym VARCHAR(255),
    bio TEXT,
    profile_image TEXT,
    profile_image_optimized TEXT,
    transaction_hash VARCHAR(255) NOT NULL,
    game_id VARCHAR(255) NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Unique constraint for deduplication
    CONSTRAINT unique_transaction_hash UNIQUE (transaction_hash)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_trades_condition_id ON trades(condition_id);
CREATE INDEX IF NOT EXISTS idx_trades_game_id ON trades(game_id);
CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_game_created ON trades(game_id, created_at DESC);

-- Comment
COMMENT ON TABLE trades IS 'Stores trade data from Polymarket data API for live trade widget';
