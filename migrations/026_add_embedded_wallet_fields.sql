-- Migration: Add embedded wallet balance fields and auto-transfer preferences
-- Tracks USDC balance in embedded wallets and user preferences for automatic transfers

-- Add columns to users table for embedded wallet balance
ALTER TABLE users
ADD COLUMN IF NOT EXISTS embedded_wallet_balance_raw VARCHAR(78) DEFAULT '0',
ADD COLUMN IF NOT EXISTS embedded_wallet_balance_human DECIMAL(20, 6) DEFAULT 0,
ADD COLUMN IF NOT EXISTS embedded_balance_last_updated TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS auto_transfer_enabled BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS auto_transfer_min_amount DECIMAL(20, 6) DEFAULT 0;

-- Create separate table for embedded wallet balances (better for tracking and history)
CREATE TABLE IF NOT EXISTS embedded_wallet_balances (
    id SERIAL PRIMARY KEY,
    privy_user_id VARCHAR(255) NOT NULL UNIQUE,
    embedded_wallet_address VARCHAR(255) NOT NULL,
    balance_raw VARCHAR(78) DEFAULT '0',
    balance_human DECIMAL(20, 6) DEFAULT 0,
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (privy_user_id) REFERENCES users(privy_user_id) ON DELETE CASCADE
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_embedded_balances_privy_user ON embedded_wallet_balances(privy_user_id);
CREATE INDEX IF NOT EXISTS idx_embedded_balances_address ON embedded_wallet_balances(embedded_wallet_address);
CREATE INDEX IF NOT EXISTS idx_embedded_balances_last_updated ON embedded_wallet_balances(last_updated_at DESC);

-- Add comments for documentation
COMMENT ON COLUMN users.embedded_wallet_balance_raw IS 'Raw USDC balance in embedded wallet (as string to handle large numbers)';
COMMENT ON COLUMN users.embedded_wallet_balance_human IS 'Human-readable USDC balance in embedded wallet';
COMMENT ON COLUMN users.embedded_balance_last_updated IS 'Timestamp when embedded wallet balance was last updated';
COMMENT ON COLUMN users.auto_transfer_enabled IS 'Whether to automatically transfer USDC from embedded wallet to proxy wallet';
COMMENT ON COLUMN users.auto_transfer_min_amount IS 'Minimum USDC amount required to trigger automatic transfer (0 = no minimum)';
COMMENT ON TABLE embedded_wallet_balances IS 'Tracks USDC balance in embedded wallets for all users';

