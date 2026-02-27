-- Migration: Backfill solana_wallet_address for users who have Kalshi trades but null in users table
-- solana_wallet_address = Solana chain (base58), for Kalshi/DFlow — NOT proxy_wallet or embedded_wallet (EVM)
-- Fixes metadevcloud and any other users with the same issue

-- 1. Fix metadevcloud explicitly
UPDATE users
SET solana_wallet_address = '7mjajYQifi1MogMJyVxgAXiN7jdJDzwQPbbUoNSF3LnU',
    updated_at = CURRENT_TIMESTAMP
WHERE LOWER(username) = 'metadevcloud'
  AND (solana_wallet_address IS NULL OR solana_wallet_address = '');

-- 2. Backfill all users: set solana_wallet from their most recent Kalshi trade when users.solana_wallet is null
UPDATE users u
SET solana_wallet_address = sub.solana_wallet_address,
    updated_at = CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT ON (privy_user_id) privy_user_id, solana_wallet_address
  FROM kalshi_trades_history
  WHERE solana_wallet_address IS NOT NULL AND solana_wallet_address != ''
  ORDER BY privy_user_id, created_at DESC
) sub
WHERE u.privy_user_id = sub.privy_user_id
  AND (u.solana_wallet_address IS NULL OR u.solana_wallet_address = '');
