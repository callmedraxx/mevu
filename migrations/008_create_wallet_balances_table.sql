-- Migration: Create wallet_balances table
-- Tracks current USDC.e balance for each proxy wallet

CREATE TABLE IF NOT EXISTS wallet_balances (
    id SERIAL PRIMARY KEY,
    proxy_wallet_address VARCHAR(255) NOT NULL UNIQUE,
    privy_user_id VARCHAR(255) NOT NULL,
    balance_raw VARCHAR(78) NOT NULL,  -- Store as string to handle large numbers (max uint256)
    balance_human DECIMAL(20, 6) NOT NULL,  -- Human-readable balance (USDC has 6 decimals)
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Foreign key to users table (if exists)
    CONSTRAINT fk_wallet_balance_user FOREIGN KEY (privy_user_id) REFERENCES users(privy_user_id) ON DELETE CASCADE
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_wallet_balances_proxy_wallet ON wallet_balances(proxy_wallet_address);
CREATE INDEX IF NOT EXISTS idx_wallet_balances_privy_user ON wallet_balances(privy_user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_balances_last_updated ON wallet_balances(last_updated_at DESC);

-- Comment
COMMENT ON TABLE wallet_balances IS 'Tracks current USDC.e balance for each proxy wallet in real-time';
