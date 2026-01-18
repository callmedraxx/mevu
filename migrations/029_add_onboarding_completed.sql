-- Migration: Add onboarding_completed column to users table
-- This column tracks whether a user has completed the full onboarding flow
-- It's used to prevent the onboarding modal from showing again after completion

ALTER TABLE users
ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE;

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_users_onboarding_completed ON users(onboarding_completed);

-- Add comment for documentation
COMMENT ON COLUMN users.onboarding_completed IS 'Whether user has completed the full onboarding flow (username, session signer, token approvals, and clicked Start Trading)';

-- Update existing users who have completed all onboarding steps
-- (have session_signer_enabled, usdc_approval_enabled, and ctf_approval_enabled all true)
UPDATE users
SET onboarding_completed = TRUE
WHERE session_signer_enabled = TRUE
  AND usdc_approval_enabled = TRUE
  AND ctf_approval_enabled = TRUE
  AND proxy_wallet_address IS NOT NULL;
