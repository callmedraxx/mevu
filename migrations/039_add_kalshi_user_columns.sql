-- Migration: Add Kalshi user columns for US trading flow
-- Adds trading_region, Solana wallet, Kalshi onboarding, and USDC balance fields

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS trading_region TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS solana_wallet_address TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS kalshi_onboarding_completed BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS kalshi_usdc_balance NUMERIC(20,6) DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_trading_region ON users(trading_region);
CREATE INDEX IF NOT EXISTS idx_users_solana_wallet ON users(solana_wallet_address);
