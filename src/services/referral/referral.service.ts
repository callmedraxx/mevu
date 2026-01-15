/**
 * Referral Service
 * Handles referral code generation, link creation, and referral statistics
 */

import { pool, getDatabaseConfig } from '../../config/database';
import { logger } from '../../config/logger';
import { getUserByPrivyId } from '../privy/user.service';

const REFERRAL_CODE_LENGTH = 8;
const REFERRAL_BASE_URL = process.env.REFERRAL_BASE_URL || 'https://app.mevu.com';
const REFERRAL_RATE = 0.25; // 25% of platform fee

/**
 * Generate a unique referral code
 * Format: 8 alphanumeric characters (uppercase)
 */
async function generateUniqueReferralCode(): Promise<string> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    // In-memory mode - generate simple code
    return `REF${Date.now().toString(36).toUpperCase().slice(-5)}`;
  }

  const client = await pool.connect();
  
  try {
    let attempts = 0;
    const maxAttempts = 10;
    
    while (attempts < maxAttempts) {
      // Generate random alphanumeric code
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude similar-looking chars (0, O, I, 1)
      let code = '';
      for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      
      // Check if code already exists
      const result = await client.query(
        'SELECT id FROM users WHERE referral_code = $1',
        [code]
      );
      
      if (result.rows.length === 0) {
        return code;
      }
      
      attempts++;
    }
    
    throw new Error('Failed to generate unique referral code after multiple attempts');
  } finally {
    client.release();
  }
}

/**
 * Generate or retrieve referral code for a user
 */
export async function generateReferralCode(privyUserId: string): Promise<string> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    // In-memory mode - return generated code
    return await generateUniqueReferralCode();
  }

  const user = await getUserByPrivyId(privyUserId);
  if (!user) {
    throw new Error('User not found');
  }

  // If user already has a referral code, return it
  if ((user as any).referralCode) {
    return (user as any).referralCode;
  }

  // Generate new referral code
  const code = await generateUniqueReferralCode();
  const client = await pool.connect();
  
  try {
    await client.query(
      `UPDATE users 
       SET referral_code = $1, 
           referral_code_created_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $2`,
      [code, privyUserId]
    );
    
    logger.info({
      message: 'Referral code generated',
      privyUserId,
      referralCode: code,
    });
    
    return code;
  } finally {
    client.release();
  }
}

/**
 * Get referral link for a user
 */
export async function getReferralLink(privyUserId: string): Promise<string> {
  const code = await generateReferralCode(privyUserId);
  return `${REFERRAL_BASE_URL}/?ref=${code}`;
}

/**
 * Get referral statistics for a user
 */
export async function getReferralStats(privyUserId: string): Promise<{
  totalReferrals: number;
  totalEarnings: number;
  lifetimeEarnings: number;
  withdrawableBalance: number;
}> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return {
      totalReferrals: 0,
      totalEarnings: 0,
      lifetimeEarnings: 0,
      withdrawableBalance: 0,
    };
  }

  const user = await getUserByPrivyId(privyUserId);
  if (!user) {
    throw new Error('User not found');
  }

  const client = await pool.connect();
  
  try {
    // Get user ID (not privy_user_id)
    const userResult = await client.query(
      'SELECT id, referral_earnings_balance FROM users WHERE privy_user_id = $1',
      [privyUserId]
    );
    
    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }
    
    const userId = userResult.rows[0].id;
    const withdrawableBalance = parseFloat(userResult.rows[0].referral_earnings_balance || '0');

    // Count total referrals
    const referralsResult = await client.query(
      'SELECT COUNT(*) as count FROM users WHERE referred_by_user_id = $1',
      [userId]
    );
    const totalReferrals = parseInt(referralsResult.rows[0].count || '0', 10);

    // Get lifetime earnings (sum of all CREDITED earnings)
    const earningsResult = await client.query(
      `SELECT COALESCE(SUM(referral_earnings_usdc), 0) as total
       FROM referral_earnings
       WHERE referrer_user_id = $1 AND status = 'CREDITED'`,
      [userId]
    );
    const lifetimeEarnings = parseFloat(earningsResult.rows[0].total || '0');

    // Total earnings is same as lifetime earnings (all credited)
    const totalEarnings = lifetimeEarnings;

    return {
      totalReferrals,
      totalEarnings,
      lifetimeEarnings,
      withdrawableBalance,
    };
  } finally {
    client.release();
  }
}

/**
 * Get referral earnings history
 */
export async function getReferralEarnings(
  privyUserId: string,
  limit: number = 50,
  offset: number = 0
): Promise<Array<{
  id: string;
  referredUserId: string;
  referredUsername: string;
  tradeId: string;
  tradeCostUsdc: number;
  platformFeeUsdc: number;
  referralEarningsUsdc: number;
  status: string;
  createdAt: Date;
  creditedAt: Date | null;
}>> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return [];
  }

  const user = await getUserByPrivyId(privyUserId);
  if (!user) {
    throw new Error('User not found');
  }

  const client = await pool.connect();
  
  try {
    // Get user ID
    const userResult = await client.query(
      'SELECT id FROM users WHERE privy_user_id = $1',
      [privyUserId]
    );
    
    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }
    
    const userId = userResult.rows[0].id;

    // Get earnings with referred user info
    const result = await client.query(
      `SELECT 
        re.id,
        re.referred_user_id,
        u.username as referred_username,
        re.trade_id,
        re.trade_cost_usdc,
        re.platform_fee_usdc,
        re.referral_earnings_usdc,
        re.status,
        re.created_at,
        re.credited_at
       FROM referral_earnings re
       JOIN users u ON re.referred_user_id = u.id
       WHERE re.referrer_user_id = $1
       ORDER BY re.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return result.rows.map(row => ({
      id: row.id,
      referredUserId: row.referred_user_id,
      referredUsername: row.referred_username,
      tradeId: row.trade_id,
      tradeCostUsdc: parseFloat(row.trade_cost_usdc),
      platformFeeUsdc: parseFloat(row.platform_fee_usdc),
      referralEarningsUsdc: parseFloat(row.referral_earnings_usdc),
      status: row.status,
      createdAt: new Date(row.created_at),
      creditedAt: row.credited_at ? new Date(row.credited_at) : null,
    }));
  } finally {
    client.release();
  }
}

/**
 * Get current referral earnings balance
 */
export async function getReferralBalance(privyUserId: string): Promise<number> {
  const user = await getUserByPrivyId(privyUserId);
  if (!user) {
    throw new Error('User not found');
  }

  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return 0;
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query(
      'SELECT referral_earnings_balance FROM users WHERE privy_user_id = $1',
      [privyUserId]
    );
    
    if (result.rows.length === 0) {
      throw new Error('User not found');
    }
    
    return parseFloat(result.rows[0].referral_earnings_balance || '0');
  } finally {
    client.release();
  }
}

/**
 * Get list of referred users
 */
export async function getReferredUsers(
  privyUserId: string,
  limit: number = 50,
  offset: number = 0
): Promise<Array<{
  userId: string;
  username: string;
  createdAt: Date;
  totalTrades: number;
  totalEarnings: number;
}>> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return [];
  }

  const user = await getUserByPrivyId(privyUserId);
  if (!user) {
    throw new Error('User not found');
  }

  const client = await pool.connect();
  
  try {
    // Get user ID
    const userResult = await client.query(
      'SELECT id FROM users WHERE privy_user_id = $1',
      [privyUserId]
    );
    
    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }
    
    const userId = userResult.rows[0].id;

    // Get referred users with stats
    const result = await client.query(
      `SELECT 
        u.id as user_id,
        u.username,
        u.created_at,
        COUNT(DISTINCT re.trade_id) as total_trades,
        COALESCE(SUM(CASE WHEN re.status = 'CREDITED' THEN re.referral_earnings_usdc ELSE 0 END), 0) as total_earnings
       FROM users u
       LEFT JOIN referral_earnings re ON re.referred_user_id = u.id AND re.referrer_user_id = $1
       WHERE u.referred_by_user_id = $1
       GROUP BY u.id, u.username, u.created_at
       ORDER BY u.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    return result.rows.map(row => ({
      userId: row.user_id,
      username: row.username,
      createdAt: new Date(row.created_at),
      totalTrades: parseInt(row.total_trades || '0', 10),
      totalEarnings: parseFloat(row.total_earnings || '0'),
    }));
  } finally {
    client.release();
  }
}

/**
 * Validate referral code and get referrer user ID
 */
export async function validateReferralCode(referralCode: string): Promise<string | null> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return null;
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query(
      'SELECT privy_user_id FROM users WHERE referral_code = $1',
      [referralCode.toUpperCase()]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0].privy_user_id;
  } finally {
    client.release();
  }
}

