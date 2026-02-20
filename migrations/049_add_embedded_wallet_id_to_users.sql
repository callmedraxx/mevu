-- Add embedded_wallet_id column to users table
-- Caches the Privy wallet ID to avoid repeated API lookups during trading
ALTER TABLE users ADD COLUMN IF NOT EXISTS embedded_wallet_id VARCHAR(255);
