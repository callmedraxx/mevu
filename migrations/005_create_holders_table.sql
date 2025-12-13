-- Migration: Create holders table
-- Stores top holders data from Polymarket data API

CREATE TABLE IF NOT EXISTS holders (
    id SERIAL PRIMARY KEY,
    token VARCHAR(255) NOT NULL,
    proxy_wallet VARCHAR(255) NOT NULL,
    asset VARCHAR(255) NOT NULL,
    amount DECIMAL(20, 8) NOT NULL,
    outcome_index INTEGER,
    condition_id VARCHAR(255) NOT NULL,
    market_id VARCHAR(255),
    game_id VARCHAR(255) NOT NULL REFERENCES live_games(id) ON DELETE CASCADE,
    name VARCHAR(255),
    pseudonym VARCHAR(255),
    bio TEXT,
    profile_image TEXT,
    profile_image_optimized TEXT,
    verified BOOLEAN DEFAULT false,
    display_username_public BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_holders_proxy_wallet ON holders(proxy_wallet);
CREATE INDEX IF NOT EXISTS idx_holders_game_id ON holders(game_id);
CREATE INDEX IF NOT EXISTS idx_holders_condition_id ON holders(condition_id);
CREATE INDEX IF NOT EXISTS idx_holders_game_wallet ON holders(game_id, proxy_wallet);
CREATE INDEX IF NOT EXISTS idx_holders_asset ON holders(asset);

-- Comment
COMMENT ON TABLE holders IS 'Stores top holders data from Polymarket data API for games';
