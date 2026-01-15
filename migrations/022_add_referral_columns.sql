-- Migration: Add referral columns to users table
-- Adds referral code, referrer tracking, and referral code creation timestamp

ALTER TABLE users
ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20) UNIQUE,
ADD COLUMN IF NOT EXISTS referred_by_user_id UUID REFERENCES users(id),
ADD COLUMN IF NOT EXISTS referral_code_created_at TIMESTAMP WITH TIME ZONE;

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by_user_id);

-- Add comments for documentation
COMMENT ON COLUMN users.referral_code IS 'Unique referral code for sharing (e.g., ABC123)';
COMMENT ON COLUMN users.referred_by_user_id IS 'Foreign key to users.id - who referred this user';
COMMENT ON COLUMN users.referral_code_created_at IS 'Timestamp when referral code was generated';

