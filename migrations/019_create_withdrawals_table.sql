-- Create withdrawals table for tracking USDC.e withdrawals from proxy wallets
CREATE TABLE IF NOT EXISTS withdrawals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    privy_user_id VARCHAR(255) NOT NULL,
    from_address VARCHAR(42) NOT NULL,
    to_address VARCHAR(42) NOT NULL,
    amount_usdc DECIMAL(18, 6) NOT NULL,
    transaction_hash VARCHAR(66),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_withdrawals_privy_user_id ON withdrawals(privy_user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_from_address ON withdrawals(from_address);
CREATE INDEX IF NOT EXISTS idx_withdrawals_to_address ON withdrawals(to_address);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_created_at ON withdrawals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_tx_hash ON withdrawals(transaction_hash);

-- Constraint to ensure valid status values
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_status_check 
    CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED'));

-- Comment on table
COMMENT ON TABLE withdrawals IS 'Tracks USDC.e withdrawals from proxy wallets on Polygon POS';
