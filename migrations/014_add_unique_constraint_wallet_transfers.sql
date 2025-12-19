-- Migration: Add unique constraint for (transaction_hash, proxy_wallet_address)
-- This prevents duplicate transfer records for the same transaction per wallet
-- Note: A single transaction can affect multiple wallets (sender and receiver), so we need wallet_address in the constraint

-- First, remove any potential duplicates (keep the first one)
DELETE FROM wallet_usdc_transfers
WHERE id NOT IN (
  SELECT MIN(id)
  FROM wallet_usdc_transfers
  GROUP BY transaction_hash, proxy_wallet_address
);

-- Add unique constraint
ALTER TABLE wallet_usdc_transfers
ADD CONSTRAINT unique_transfer_per_wallet UNIQUE (transaction_hash, proxy_wallet_address);

-- Comment
COMMENT ON CONSTRAINT unique_transfer_per_wallet ON wallet_usdc_transfers IS 
  'Prevents duplicate transfer records for the same transaction per wallet';
