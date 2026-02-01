-- Migration: Track which users' proxy_wallet_address has been synced to Alchemy webhook
-- Avoids re-adding addresses on each sync; force sync can re-add all

ALTER TABLE users ADD COLUMN IF NOT EXISTS alchemy_webhook_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_alchemy_synced 
  ON users(proxy_wallet_address) 
  WHERE proxy_wallet_address IS NOT NULL AND alchemy_webhook_synced_at IS NULL;

COMMENT ON COLUMN users.alchemy_webhook_synced_at IS 'When proxy_wallet_address was last added to Alchemy webhook for deposit tracking';
