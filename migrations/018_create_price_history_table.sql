-- Migration: Create clob_price_history table
-- Stores historical price data from Polymarket CLOB API for price charting

CREATE TABLE IF NOT EXISTS clob_price_history (
    id SERIAL PRIMARY KEY,
    clob_token_id VARCHAR(255) NOT NULL,
    timestamp BIGINT NOT NULL, -- Unix timestamp in seconds
    price DECIMAL(10, 6) NOT NULL, -- Price value (probability 0-100 or decimal 0-1)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Unique constraint to prevent duplicate entries for same token and timestamp
    CONSTRAINT unique_clob_token_timestamp UNIQUE (clob_token_id, timestamp)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_price_history_clob_token_id ON clob_price_history(clob_token_id);
CREATE INDEX IF NOT EXISTS idx_price_history_timestamp ON clob_price_history(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_clob_token_timestamp ON clob_price_history(clob_token_id, timestamp DESC);

-- Comment
COMMENT ON TABLE clob_price_history IS 'Stores historical price data from Polymarket CLOB API for price charting';
COMMENT ON COLUMN clob_price_history.clob_token_id IS 'The CLOB token ID for the specific outcome';
COMMENT ON COLUMN clob_price_history.timestamp IS 'Unix timestamp in seconds';
COMMENT ON COLUMN clob_price_history.price IS 'Price value from Polymarket CLOB API';

