/**
 * User Service
 * Handles user profile CRUD operations in PostgreSQL
 * Stores the mapping between Privy users, embedded wallets, and proxy wallets
 */

import { pool, memoryStore, getDatabaseConfig } from '../../config/database';
import { logger } from '../../config/logger';
import { UserProfile, CreateUserRequest } from './privy.types';

/**
 * Initialize the users table in PostgreSQL
 * Creates the table if it doesn't exist
 */
export async function initializeUsersTable(): Promise<void> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    logger.info({ message: 'Users table initialization skipped - using in-memory storage' });
    return;
  }

  const client = await pool.connect();
  
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        privy_user_id VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(50) UNIQUE NOT NULL,
        embedded_wallet_address VARCHAR(42) NOT NULL,
        proxy_wallet_address VARCHAR(42),
        session_signer_enabled BOOLEAN DEFAULT FALSE,
        usdc_approval_enabled BOOLEAN DEFAULT FALSE,
        ctf_approval_enabled BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Add Solana wallet columns if missing (idempotent)
      ALTER TABLE users ADD COLUMN IF NOT EXISTS solana_wallet_address VARCHAR(64);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS solana_wallet_id VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS embedded_wallet_id VARCHAR(255);

      CREATE INDEX IF NOT EXISTS idx_users_privy_user_id ON users(privy_user_id);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_embedded_wallet ON users(embedded_wallet_address);
      CREATE INDEX IF NOT EXISTS idx_users_proxy_wallet ON users(proxy_wallet_address);
      CREATE INDEX IF NOT EXISTS idx_users_solana_wallet ON users(solana_wallet_address);
    `);
    
    logger.info({ message: 'Users table initialized successfully' });
  } catch (error) {
    logger.error({
      message: 'Error initializing users table',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Create a new user profile
 */
export async function createUser(request: CreateUserRequest): Promise<UserProfile> {
  const dbConfig = getDatabaseConfig();
  const normalizedAddress = request.embeddedWalletAddress.toLowerCase();
  
  if (dbConfig.type !== 'postgres') {
    // In-memory storage for development
    const id = `user_${Date.now()}`;
    const user: UserProfile = {
      id,
      privyUserId: request.privyUserId,
      username: request.username,
      embeddedWalletAddress: normalizedAddress,
      proxyWalletAddress: null,
      sessionSignerEnabled: false,
      usdcApprovalEnabled: false,
      ctfApprovalEnabled: false,
      onboardingCompleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    
    memoryStore.set(`user:${id}`, user);
    memoryStore.set(`user:privy:${request.privyUserId}`, user);
    memoryStore.set(`user:username:${request.username.toLowerCase()}`, user);
    memoryStore.set(`user:wallet:${normalizedAddress}`, user);
    
    logger.info({
      message: 'User created (in-memory)',
      userId: id,
      username: request.username,
    });
    
    return user;
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `INSERT INTO users (privy_user_id, username, embedded_wallet_address)
       VALUES ($1, $2, $3)
       RETURNING id, privy_user_id, username, embedded_wallet_address, 
                 proxy_wallet_address, session_signer_enabled, usdc_approval_enabled, 
                 ctf_approval_enabled, onboarding_completed, created_at, updated_at`,
      [request.privyUserId, request.username, normalizedAddress]
    );

    const row = result.rows[0];
    const user: UserProfile = {
      id: row.id,
      privyUserId: row.privy_user_id,
      username: row.username,
      embeddedWalletAddress: row.embedded_wallet_address,
      proxyWalletAddress: row.proxy_wallet_address,
      sessionSignerEnabled: row.session_signer_enabled,
      usdcApprovalEnabled: row.usdc_approval_enabled,
      ctfApprovalEnabled: row.ctf_approval_enabled,
      onboardingCompleted: row.onboarding_completed ?? false,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };

    logger.info({
      message: 'User created',
      userId: user.id,
      username: user.username,
    });

    return user;
  } catch (error) {
    logger.error({
      message: 'Error creating user',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get user by Privy user ID
 */
export async function getUserByPrivyId(privyUserId: string): Promise<UserProfile | null> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return memoryStore.get(`user:privy:${privyUserId}`) || null;
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT id, privy_user_id, username, embedded_wallet_address, 
              proxy_wallet_address, session_signer_enabled, usdc_approval_enabled,
              ctf_approval_enabled, onboarding_completed, created_at, updated_at,
              trading_region, solana_wallet_address, solana_wallet_id, kalshi_onboarding_completed, kalshi_usdc_balance,
              embedded_wallet_id
       FROM users WHERE privy_user_id = $1`,
      [privyUserId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const user: UserProfile = {
      id: row.id,
      privyUserId: row.privy_user_id,
      username: row.username,
      embeddedWalletAddress: row.embedded_wallet_address,
      proxyWalletAddress: row.proxy_wallet_address,
      sessionSignerEnabled: row.session_signer_enabled,
      usdcApprovalEnabled: row.usdc_approval_enabled ?? false,
      ctfApprovalEnabled: row.ctf_approval_enabled ?? false,
      onboardingCompleted: row.onboarding_completed ?? false,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
    if (row.trading_region != null) user.tradingRegion = row.trading_region;
    if (row.solana_wallet_address != null) user.solanaWalletAddress = row.solana_wallet_address;
    if (row.solana_wallet_id != null) user.solanaWalletId = row.solana_wallet_id;
    if (row.kalshi_onboarding_completed != null) user.kalshiOnboardingCompleted = row.kalshi_onboarding_completed;
    if (row.kalshi_usdc_balance != null) user.kalshiUsdcBalance = String(row.kalshi_usdc_balance);
    if (row.embedded_wallet_id != null) user.embeddedWalletId = row.embedded_wallet_id;
    return user;
  } finally {
    client.release();
  }
}

/**
 * Get user by username
 */
export async function getUserByUsername(username: string): Promise<UserProfile | null> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return memoryStore.get(`user:username:${username.toLowerCase()}`) || null;
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT id, privy_user_id, username, embedded_wallet_address, 
              proxy_wallet_address, session_signer_enabled, usdc_approval_enabled,
              ctf_approval_enabled, onboarding_completed, created_at, updated_at
       FROM users WHERE LOWER(username) = LOWER($1)`,
      [username]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      privyUserId: row.privy_user_id,
      username: row.username,
      embeddedWalletAddress: row.embedded_wallet_address,
      proxyWalletAddress: row.proxy_wallet_address,
      sessionSignerEnabled: row.session_signer_enabled,
      usdcApprovalEnabled: row.usdc_approval_enabled ?? false,
      ctfApprovalEnabled: row.ctf_approval_enabled ?? false,
      onboardingCompleted: row.onboarding_completed ?? false,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  } finally {
    client.release();
  }
}

/**
 * Get user by embedded wallet address
 */
export async function getUserByWalletAddress(walletAddress: string): Promise<UserProfile | null> {
  const dbConfig = getDatabaseConfig();
  const normalizedAddress = walletAddress.toLowerCase();
  
  if (dbConfig.type !== 'postgres') {
    return memoryStore.get(`user:wallet:${normalizedAddress}`) || null;
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT id, privy_user_id, username, embedded_wallet_address, 
              proxy_wallet_address, session_signer_enabled, usdc_approval_enabled,
              ctf_approval_enabled, onboarding_completed, created_at, updated_at
       FROM users WHERE LOWER(embedded_wallet_address) = $1`,
      [normalizedAddress]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      privyUserId: row.privy_user_id,
      username: row.username,
      embeddedWalletAddress: row.embedded_wallet_address,
      proxyWalletAddress: row.proxy_wallet_address,
      sessionSignerEnabled: row.session_signer_enabled,
      usdcApprovalEnabled: row.usdc_approval_enabled ?? false,
      ctfApprovalEnabled: row.ctf_approval_enabled ?? false,
      onboardingCompleted: row.onboarding_completed ?? false,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  } finally {
    client.release();
  }
}

/**
 * Update user's proxy wallet address
 */
export async function updateUserProxyWallet(
  privyUserId: string,
  proxyWalletAddress: string
): Promise<UserProfile | null> {
  const dbConfig = getDatabaseConfig();
  const normalizedProxyAddress = proxyWalletAddress.toLowerCase();
  
  if (dbConfig.type !== 'postgres') {
    const user = memoryStore.get(`user:privy:${privyUserId}`);
    if (!user) return null;
    
    user.proxyWalletAddress = normalizedProxyAddress;
    user.usdcApprovalEnabled = user.usdcApprovalEnabled ?? false;
    user.ctfApprovalEnabled = user.ctfApprovalEnabled ?? false;
    user.updatedAt = new Date();
    
    memoryStore.set(`user:privy:${privyUserId}`, user);
    memoryStore.set(`user:proxy:${normalizedProxyAddress}`, user);
    
    return user;
  }

  const client = await pool.connect();
  
  try {
    logger.info({
      message: 'Updating user proxy wallet address in database',
      privyUserId,
      proxyWalletAddress: normalizedProxyAddress,
    });

    const result = await client.query(
      `UPDATE users 
       SET proxy_wallet_address = $1, updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $2
       RETURNING id, privy_user_id, username, embedded_wallet_address, 
                 proxy_wallet_address, session_signer_enabled, usdc_approval_enabled,
                 ctf_approval_enabled, onboarding_completed, created_at, updated_at`,
      [normalizedProxyAddress, privyUserId]
    );

    if (result.rows.length === 0) {
      logger.warn({
        message: 'No user found to update with proxy wallet address',
        privyUserId,
        proxyWalletAddress: normalizedProxyAddress,
      });
      return null;
    }

    const row = result.rows[0];
    const updatedUser = {
      id: row.id,
      privyUserId: row.privy_user_id,
      username: row.username,
      embeddedWalletAddress: row.embedded_wallet_address,
      proxyWalletAddress: row.proxy_wallet_address,
      sessionSignerEnabled: row.session_signer_enabled,
      usdcApprovalEnabled: row.usdc_approval_enabled ?? false,
      ctfApprovalEnabled: row.ctf_approval_enabled ?? false,
      onboardingCompleted: row.onboarding_completed ?? false,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };

    logger.info({
      message: 'Successfully updated user proxy wallet address in database',
      privyUserId,
      proxyWalletAddress: normalizedProxyAddress,
      userId: updatedUser.id,
    });

    // Add the new proxy wallet to Alchemy webhook for balance tracking
    try {
      const { alchemyWebhookService } = await import('../alchemy/alchemy-webhook.service');
      await alchemyWebhookService.addUserAddress(normalizedProxyAddress, privyUserId);
    } catch (webhookError) {
      // Don't fail the wallet update if webhook registration fails
      logger.warn({
        message: 'Failed to add address to Alchemy webhook',
        privyUserId,
        proxyWalletAddress: normalizedProxyAddress,
        error: webhookError instanceof Error ? webhookError.message : String(webhookError),
      });
    }

    return updatedUser;
  } catch (error) {
    logger.error({
      message: 'Error updating user proxy wallet address in database',
      privyUserId,
      proxyWalletAddress: normalizedProxyAddress,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // Re-throw the error so the caller can handle it
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Update user's embedded wallet address
 * Useful when Privy wallet address changes or database has stale data
 */
export async function updateUserEmbeddedWalletAddress(
  privyUserId: string,
  embeddedWalletAddress: string
): Promise<UserProfile | null> {
  const dbConfig = getDatabaseConfig();
  const normalizedAddress = embeddedWalletAddress.toLowerCase();
  
  if (dbConfig.type !== 'postgres') {
    const user = memoryStore.get(`user:privy:${privyUserId}`);
    if (!user) return null;
    
    user.embeddedWalletAddress = normalizedAddress;
    user.updatedAt = new Date();
    
    memoryStore.set(`user:privy:${privyUserId}`, user);
    memoryStore.set(`user:embedded:${normalizedAddress}`, user);
    
    return user;
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `UPDATE users 
       SET embedded_wallet_address = $1, updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $2
       RETURNING id, privy_user_id, username, embedded_wallet_address, 
                 proxy_wallet_address, session_signer_enabled, usdc_approval_enabled,
                 ctf_approval_enabled, onboarding_completed, created_at, updated_at`,
      [normalizedAddress, privyUserId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      privyUserId: row.privy_user_id,
      username: row.username,
      embeddedWalletAddress: row.embedded_wallet_address,
      proxyWalletAddress: row.proxy_wallet_address,
      sessionSignerEnabled: row.session_signer_enabled,
      usdcApprovalEnabled: row.usdc_approval_enabled ?? false,
      ctfApprovalEnabled: row.ctf_approval_enabled ?? false,
      onboardingCompleted: row.onboarding_completed ?? false,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  } finally {
    client.release();
  }
}

/**
 * Update user's token approval statuses
 */
export async function updateUserTokenApprovals(
  privyUserId: string,
  usdcApprovalEnabled: boolean,
  ctfApprovalEnabled: boolean
): Promise<UserProfile | null> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    const user = memoryStore.get(`user:privy:${privyUserId}`);
    if (!user) return null;
    
    user.usdcApprovalEnabled = usdcApprovalEnabled;
    user.ctfApprovalEnabled = ctfApprovalEnabled;
    user.updatedAt = new Date();
    
    memoryStore.set(`user:privy:${privyUserId}`, user);
    return user;
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `UPDATE users 
       SET usdc_approval_enabled = $1, ctf_approval_enabled = $2, updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $3
       RETURNING id, privy_user_id, username, embedded_wallet_address, 
                 proxy_wallet_address, session_signer_enabled, usdc_approval_enabled,
                 ctf_approval_enabled, onboarding_completed, created_at, updated_at`,
      [usdcApprovalEnabled, ctfApprovalEnabled, privyUserId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      privyUserId: row.privy_user_id,
      username: row.username,
      embeddedWalletAddress: row.embedded_wallet_address,
      proxyWalletAddress: row.proxy_wallet_address,
      sessionSignerEnabled: row.session_signer_enabled,
      usdcApprovalEnabled: row.usdc_approval_enabled ?? false,
      ctfApprovalEnabled: row.ctf_approval_enabled ?? false,
      onboardingCompleted: row.onboarding_completed ?? false,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  } finally {
    client.release();
  }
}

/**
 * Update user's session signer status
 */
export async function updateUserSessionSigner(
  privyUserId: string,
  enabled: boolean
): Promise<UserProfile | null> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    const user = memoryStore.get(`user:privy:${privyUserId}`);
    if (!user) return null;
    
    user.sessionSignerEnabled = enabled;
    user.usdcApprovalEnabled = user.usdcApprovalEnabled ?? false;
    user.ctfApprovalEnabled = user.ctfApprovalEnabled ?? false;
    user.updatedAt = new Date();
    
    memoryStore.set(`user:privy:${privyUserId}`, user);
    return user;
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `UPDATE users 
       SET session_signer_enabled = $1, updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $2
       RETURNING id, privy_user_id, username, embedded_wallet_address, 
                 proxy_wallet_address, session_signer_enabled, usdc_approval_enabled,
                 ctf_approval_enabled, onboarding_completed, created_at, updated_at`,
      [enabled, privyUserId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      privyUserId: row.privy_user_id,
      username: row.username,
      embeddedWalletAddress: row.embedded_wallet_address,
      proxyWalletAddress: row.proxy_wallet_address,
      sessionSignerEnabled: row.session_signer_enabled,
      usdcApprovalEnabled: row.usdc_approval_enabled ?? false,
      ctfApprovalEnabled: row.ctf_approval_enabled ?? false,
      onboardingCompleted: row.onboarding_completed ?? false,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  } finally {
    client.release();
  }
}

/**
 * Mark user's onboarding as completed
 */
export async function markOnboardingComplete(
  privyUserId: string
): Promise<UserProfile | null> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    const user = memoryStore.get(`user:privy:${privyUserId}`);
    if (!user) return null;
    
    user.onboardingCompleted = true;
    user.updatedAt = new Date();
    
    memoryStore.set(`user:privy:${privyUserId}`, user);
    return user;
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `UPDATE users 
       SET onboarding_completed = TRUE, updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $1
       RETURNING id, privy_user_id, username, embedded_wallet_address, 
                 proxy_wallet_address, session_signer_enabled, usdc_approval_enabled,
                 ctf_approval_enabled, onboarding_completed, created_at, updated_at`,
      [privyUserId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    
    logger.info({
      message: 'Marked onboarding as complete',
      privyUserId,
      username: row.username,
    });
    
    return {
      id: row.id,
      privyUserId: row.privy_user_id,
      username: row.username,
      embeddedWalletAddress: row.embedded_wallet_address,
      proxyWalletAddress: row.proxy_wallet_address,
      sessionSignerEnabled: row.session_signer_enabled,
      usdcApprovalEnabled: row.usdc_approval_enabled ?? false,
      ctfApprovalEnabled: row.ctf_approval_enabled ?? false,
      onboardingCompleted: row.onboarding_completed ?? false,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  } finally {
    client.release();
  }
}

/**
 * Update user's embedded wallet ID (Privy wallet ID cache)
 * Saves the wallet ID to avoid repeated Privy API lookups
 */
export async function updateUserEmbeddedWalletId(
  privyUserId: string,
  embeddedWalletId: string
): Promise<void> {
  const dbConfig = getDatabaseConfig();

  if (dbConfig.type !== 'postgres') {
    const user = memoryStore.get(`user:privy:${privyUserId}`);
    if (user) {
      user.embeddedWalletId = embeddedWalletId;
      memoryStore.set(`user:privy:${privyUserId}`, user);
    }
    return;
  }

  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE users SET embedded_wallet_id = $1, updated_at = CURRENT_TIMESTAMP WHERE privy_user_id = $2`,
      [embeddedWalletId, privyUserId]
    );
  } finally {
    client.release();
  }
}

/**
 * Check if username is available
 */
export async function isUsernameAvailable(username: string): Promise<boolean> {
  const user = await getUserByUsername(username);
  return user === null;
}

/**
 * Check if Privy user already has a profile
 */
export async function userExists(privyUserId: string): Promise<boolean> {
  const user = await getUserByPrivyId(privyUserId);
  return user !== null;
}

/**
 * Delete a user by their embedded wallet address.
 * Removes the user and all related data (CASCADE handles FK tables;
 * manually deletes from tables without FK constraints).
 */
export async function deleteUserByEmbeddedWallet(embeddedWalletAddress: string): Promise<boolean> {
  const dbConfig = getDatabaseConfig();
  const normalizedAddress = embeddedWalletAddress.toLowerCase();

  if (dbConfig.type !== 'postgres') {
    const user = memoryStore.get(`user:wallet:${normalizedAddress}`) as UserProfile | undefined;
    if (!user) return false;

    memoryStore.delete(`user:${user.id}`);
    memoryStore.delete(`user:privy:${user.privyUserId}`);
    memoryStore.delete(`user:username:${user.username.toLowerCase()}`);
    memoryStore.delete(`user:wallet:${normalizedAddress}`);

    logger.info({ message: 'User deleted from in-memory storage', embeddedWalletAddress: normalizedAddress });
    return true;
  }

  const client = await pool.connect();

  try {
    // 1. Find the user
    const userResult = await client.query(
      `SELECT id, privy_user_id FROM users WHERE LOWER(embedded_wallet_address) = $1`,
      [normalizedAddress]
    );

    if (userResult.rows.length === 0) {
      logger.warn({ message: 'User not found for embedded wallet', embeddedWalletAddress: normalizedAddress });
      return false;
    }

    const { id: userId, privy_user_id: privyUserId } = userResult.rows[0];

    await client.query('BEGIN');

    // 2. Clear referred_by_user_id for users who were referred by this user (FK from users to users)
    await client.query(
      `UPDATE users SET referred_by_user_id = NULL WHERE referred_by_user_id = $1`,
      [userId]
    );

    // 3. Delete from tables without FK to users (to avoid orphaned rows)
    await client.query(`DELETE FROM deposit_progress WHERE privy_user_id = $1`, [privyUserId]);
    await client.query(`DELETE FROM withdrawals WHERE privy_user_id = $1`, [privyUserId]);
    await client.query(`DELETE FROM trades_history WHERE privy_user_id = $1`, [privyUserId]);
    await client.query(`DELETE FROM user_pnl_history WHERE privy_user_id = $1`, [privyUserId]);
    await client.query(`DELETE FROM kalshi_positions WHERE privy_user_id = $1`, [privyUserId]).catch(() => {});
    await client.query(`DELETE FROM kalshi_trades_history WHERE privy_user_id = $1`, [privyUserId]).catch(() => {});

    // 4. Delete user (CASCADE handles: embedded_wallet_balances, wallet_balances, wallet_usdc_transfers, user_positions, referral_earnings)
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);

    await client.query('COMMIT');

    logger.info({
      message: 'User deleted by embedded wallet',
      embeddedWalletAddress: normalizedAddress,
      privyUserId,
    });

    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({
      message: 'Error deleting user by embedded wallet',
      embeddedWalletAddress: normalizedAddress,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Delete all users from the database
 * WARNING: This will delete ALL users - use with caution!
 */
export async function deleteAllUsers(): Promise<number> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    // Clear in-memory storage
    const keys = Array.from(memoryStore.keys()).filter(key => key.startsWith('user:'));
    keys.forEach(key => memoryStore.delete(key));
    
    logger.info({
      message: 'All users deleted from in-memory storage',
      count: keys.length,
    });
    
    return keys.length;
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query('DELETE FROM users');
    const deletedCount = result.rowCount || 0;
    
    logger.info({
      message: 'All users deleted from database',
      count: deletedCount,
    });
    
    return deletedCount;
  } catch (error) {
    logger.error({
      message: 'Error deleting all users',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}
