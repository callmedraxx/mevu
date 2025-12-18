-- Add fee tracking columns to trades_history table
ALTER TABLE trades_history
ADD COLUMN IF NOT EXISTS fee_rate DECIMAL(10, 6) DEFAULT 0.005,
ADD COLUMN IF NOT EXISTS fee_amount DECIMAL(36, 18),
ADD COLUMN IF NOT EXISTS fee_status VARCHAR(20) DEFAULT 'PENDING' CHECK (fee_status IN ('PENDING', 'PAID', 'FAILED', 'RETRYING')),
ADD COLUMN IF NOT EXISTS fee_tx_hash VARCHAR(66),
ADD COLUMN IF NOT EXISTS fee_retry_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS fee_last_retry TIMESTAMP WITH TIME ZONE;

-- Create index for efficient fee retry queries
CREATE INDEX IF NOT EXISTS idx_trades_fee_status ON trades_history(fee_status) WHERE fee_status IN ('PENDING', 'FAILED', 'RETRYING');

-- Add comments for documentation
COMMENT ON COLUMN trades_history.fee_rate IS 'Fee rate applied (0.005 = 0.5%)';
COMMENT ON COLUMN trades_history.fee_amount IS 'Actual fee amount charged in USDC';
COMMENT ON COLUMN trades_history.fee_status IS 'Status of fee payment: PENDING, PAID, FAILED, RETRYING';
COMMENT ON COLUMN trades_history.fee_tx_hash IS 'Transaction hash of fee transfer to fee wallet';
COMMENT ON COLUMN trades_history.fee_retry_count IS 'Number of retry attempts for failed fee transfers';
COMMENT ON COLUMN trades_history.fee_last_retry IS 'Timestamp of last fee transfer retry attempt';
