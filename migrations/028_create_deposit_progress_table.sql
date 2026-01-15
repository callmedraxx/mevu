-- Migration: Create deposit_progress table
-- Tracks the progress of deposits through the auto-transfer pipeline

CREATE TABLE IF NOT EXISTS deposit_progress (
  id VARCHAR(255) PRIMARY KEY,
  privy_user_id VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL,
  step INTEGER NOT NULL DEFAULT 1,
  amount_usdc DECIMAL(18,6),
  amount_out DECIMAL(18,6),
  deposit_tx_hash VARCHAR(66),
  swap_tx_hash VARCHAR(66),
  transfer_tx_hash VARCHAR(66),
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Index for querying by user
CREATE INDEX IF NOT EXISTS idx_deposit_progress_user ON deposit_progress(privy_user_id);

-- Index for querying active deposits
CREATE INDEX IF NOT EXISTS idx_deposit_progress_status ON deposit_progress(status);

-- Index for querying recent deposits
CREATE INDEX IF NOT EXISTS idx_deposit_progress_created ON deposit_progress(created_at DESC);

-- Composite index for user + status queries
CREATE INDEX IF NOT EXISTS idx_deposit_progress_user_status ON deposit_progress(privy_user_id, status);
