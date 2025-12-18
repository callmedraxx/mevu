-- Migration: Create users table
-- Stores user profiles with Privy integration
-- Maps Privy users to embedded wallets and proxy wallets

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_user_id VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(50) UNIQUE NOT NULL,
  embedded_wallet_address VARCHAR(42) NOT NULL,
  proxy_wallet_address VARCHAR(42),
  session_signer_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_users_privy_user_id ON users(privy_user_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_embedded_wallet ON users(embedded_wallet_address);
CREATE INDEX IF NOT EXISTS idx_users_proxy_wallet ON users(proxy_wallet_address);

-- Comment
COMMENT ON TABLE users IS 'Stores user profiles with Privy integration and wallet mappings';
