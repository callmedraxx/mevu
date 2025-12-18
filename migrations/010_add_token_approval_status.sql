-- Migration: Add token approval status columns to users table
-- Tracks USDC and CTF token approval status for each user
-- Frontend can check these flags to know when to trigger approval endpoints

ALTER TABLE users 
ADD COLUMN IF NOT EXISTS usdc_approval_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS ctf_approval_enabled BOOLEAN DEFAULT FALSE;

-- Add comments
COMMENT ON COLUMN users.usdc_approval_enabled IS 'Whether USDC token approvals have been set up for this user';
COMMENT ON COLUMN users.ctf_approval_enabled IS 'Whether CTF (ERC1155) token approvals have been set up for this user';

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_users_usdc_approval ON users(usdc_approval_enabled);
CREATE INDEX IF NOT EXISTS idx_users_ctf_approval ON users(ctf_approval_enabled);
