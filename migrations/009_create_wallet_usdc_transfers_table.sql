-- Migration: Create wallet_usdc_transfers table
-- Tracks all USDC.e transfers (incoming and outgoing) for each proxy wallet
-- Useful for auditing, charting, and transaction history

CREATE TABLE IF NOT EXISTS wallet_usdc_transfers (
    id SERIAL PRIMARY KEY,
    proxy_wallet_address VARCHAR(255) NOT NULL,
    privy_user_id VARCHAR(255) NOT NULL,
    transfer_type VARCHAR(10) NOT NULL,  -- 'in' or 'out'
    from_address VARCHAR(255) NOT NULL,
    to_address VARCHAR(255) NOT NULL,
    amount_raw VARCHAR(78) NOT NULL,  -- Store as string to handle large numbers
    amount_human DECIMAL(20, 6) NOT NULL,  -- Human-readable amount
    transaction_hash VARCHAR(255) NOT NULL,
    block_number BIGINT NOT NULL,
    block_timestamp TIMESTAMP WITH TIME ZONE,
    log_index INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign key to users table
    CONSTRAINT fk_wallet_transfer_user FOREIGN KEY (privy_user_id) REFERENCES users(privy_user_id) ON DELETE CASCADE,
    
    -- Unique constraint to prevent duplicate transfers
    CONSTRAINT unique_transfer UNIQUE (transaction_hash, log_index)
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_wallet_transfers_proxy_wallet ON wallet_usdc_transfers(proxy_wallet_address);
CREATE INDEX IF NOT EXISTS idx_wallet_transfers_privy_user ON wallet_usdc_transfers(privy_user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transfers_type ON wallet_usdc_transfers(transfer_type);
CREATE INDEX IF NOT EXISTS idx_wallet_transfers_tx_hash ON wallet_usdc_transfers(transaction_hash);
CREATE INDEX IF NOT EXISTS idx_wallet_transfers_block_number ON wallet_usdc_transfers(block_number DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_transfers_created_at ON wallet_usdc_transfers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_transfers_user_created ON wallet_usdc_transfers(privy_user_id, created_at DESC);

-- Comment
COMMENT ON TABLE wallet_usdc_transfers IS 'Tracks all USDC.e transfers (incoming and outgoing) for auditing and charting';
