-- Migration: Create referral_earnings table
-- Tracks referral earnings from trades made by referred users

CREATE TABLE IF NOT EXISTS referral_earnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_id UUID NOT NULL REFERENCES trades_history(id) ON DELETE CASCADE,
  trade_cost_usdc DECIMAL(36, 18) NOT NULL,
  platform_fee_usdc DECIMAL(36, 18) NOT NULL,
  referral_earnings_usdc DECIMAL(36, 18) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CREDITED', 'WITHDRAWN')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  credited_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_referral_earnings_referrer ON referral_earnings(referrer_user_id);
CREATE INDEX IF NOT EXISTS idx_referral_earnings_referred ON referral_earnings(referred_user_id);
CREATE INDEX IF NOT EXISTS idx_referral_earnings_trade ON referral_earnings(trade_id);
CREATE INDEX IF NOT EXISTS idx_referral_earnings_status ON referral_earnings(status);
CREATE INDEX IF NOT EXISTS idx_referral_earnings_created_at ON referral_earnings(created_at DESC);

-- Composite index for common queries
CREATE INDEX IF NOT EXISTS idx_referral_earnings_referrer_status ON referral_earnings(referrer_user_id, status);

-- Add comments for documentation
COMMENT ON TABLE referral_earnings IS 'Tracks referral earnings from trades made by referred users';
COMMENT ON COLUMN referral_earnings.referrer_user_id IS 'User who referred the trader';
COMMENT ON COLUMN referral_earnings.referred_user_id IS 'User who made the trade';
COMMENT ON COLUMN referral_earnings.trade_id IS 'Trade that generated the referral earnings';
COMMENT ON COLUMN referral_earnings.trade_cost_usdc IS 'Total trade volume that generated the fee';
COMMENT ON COLUMN referral_earnings.platform_fee_usdc IS '1% platform fee from the trade';
COMMENT ON COLUMN referral_earnings.referral_earnings_usdc IS '25% of platform fee (0.25% of trade volume)';
COMMENT ON COLUMN referral_earnings.status IS 'Status: PENDING, CREDITED, or WITHDRAWN';

