-- Migration: Add referral_earnings_balance to users table
-- Tracks total withdrawable referral earnings balance

ALTER TABLE users
ADD COLUMN IF NOT EXISTS referral_earnings_balance DECIMAL(36, 18) DEFAULT 0 NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN users.referral_earnings_balance IS 'Total withdrawable referral earnings balance in USDC';

