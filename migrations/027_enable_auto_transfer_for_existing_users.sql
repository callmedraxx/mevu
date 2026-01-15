-- Migration: Enable auto-transfer for all existing users
-- This enables the automatic transfer of USDC from embedded wallet to proxy wallet
-- when deposits are detected via Alchemy webhook

-- Enable auto-transfer for all existing users who have both embedded and proxy wallets
UPDATE users
SET auto_transfer_enabled = true
WHERE embedded_wallet_address IS NOT NULL
  AND proxy_wallet_address IS NOT NULL;

-- Log the update
DO $$
DECLARE
    updated_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO updated_count
    FROM users
    WHERE auto_transfer_enabled = true
      AND embedded_wallet_address IS NOT NULL
      AND proxy_wallet_address IS NOT NULL;
    
    RAISE NOTICE 'Enabled auto-transfer for % users with both embedded and proxy wallets', updated_count;
END $$;
