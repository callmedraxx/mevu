/**
 * Referral Earnings Service
 * Handles calculation and crediting of referral earnings from trades
 */

import { pool, getDatabaseConfig } from '../../config/database';
import { logger } from '../../config/logger';
import { getUserByPrivyId } from '../privy/user.service';

const REFERRAL_RATE = 0.25; // 25% of platform fee (which is 1% of trade)

/**
 * Calculate and credit referral earnings when a trade fee is paid
 * Called after a successful fee transfer
 */
export async function calculateAndCreditReferralEarnings(
  tradeId: string,
  privyUserId: string,
  feeAmount: number,
  tradeCost: number
): Promise<void> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    // In-memory mode - skip
    return;
  }

  try {
    // Get the user who made the trade
    const user = await getUserByPrivyId(privyUserId);
    if (!user) {
      logger.warn({
        message: 'User not found for referral earnings calculation',
        privyUserId,
        tradeId,
      });
      return;
    }

    // Check if user was referred by someone
    const client = await pool.connect();
    
    try {
      // Get user ID and referred_by_user_id
      const userResult = await client.query(
        'SELECT id, referred_by_user_id FROM users WHERE privy_user_id = $1',
        [privyUserId]
      );
      
      if (userResult.rows.length === 0) {
        return;
      }
      
      const referredUserId = userResult.rows[0].id;
      const referrerUserId = userResult.rows[0].referred_by_user_id;
      
      if (!referrerUserId) {
        // User was not referred, no earnings to credit
        return;
      }

      // Calculate referral earnings: 25% of platform fee = 0.25% of trade cost
      // feeAmount is 1% of tradeCost, so referral earnings = feeAmount * 0.25
      const referralEarnings = feeAmount * REFERRAL_RATE;
      
      logger.info({
        message: 'Calculating referral earnings',
        tradeId,
        referredUserId: privyUserId,
        referrerUserId,
        tradeCost,
        platformFee: feeAmount,
        referralEarnings,
      });

      // Credit the earnings
      await creditReferralEarnings(
        referrerUserId,
        referredUserId,
        tradeId,
        referralEarnings,
        feeAmount,
        tradeCost
      );
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error({
      message: 'Error calculating referral earnings',
      tradeId,
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't throw - we don't want to fail the trade if referral earnings fail
  }
}

/**
 * Credit referral earnings to referrer's balance
 */
export async function creditReferralEarnings(
  referrerUserId: string, // UUID from users.id
  referredUserId: string, // UUID from users.id
  tradeId: string,
  earnings: number,
  platformFee: number,
  tradeCost: number
): Promise<void> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return;
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Check if earnings already credited for this trade (idempotency)
    const existingResult = await client.query(
      'SELECT id, status FROM referral_earnings WHERE trade_id = $1 AND referrer_user_id = $2',
      [tradeId, referrerUserId]
    );

    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];
      if (existing.status === 'CREDITED') {
        logger.info({
          message: 'Referral earnings already credited for this trade',
          tradeId,
          referrerUserId,
          existingId: existing.id,
        });
        await client.query('COMMIT');
        return;
      }
    }

    // Insert earnings record
    const insertResult = await client.query(
      `INSERT INTO referral_earnings 
       (referrer_user_id, referred_user_id, trade_id, trade_cost_usdc, 
        platform_fee_usdc, referral_earnings_usdc, status, created_at, credited_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'CREDITED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id`,
      [referrerUserId, referredUserId, tradeId, tradeCost, platformFee, earnings]
    );

    const earningsId = insertResult.rows[0].id;

    // Update referrer's balance
    await client.query(
      `UPDATE users 
       SET referral_earnings_balance = referral_earnings_balance + $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [earnings, referrerUserId]
    );

    // Get referrer's privy_user_id for logging
    const referrerResult = await client.query(
      'SELECT privy_user_id, username FROM users WHERE id = $1',
      [referrerUserId]
    );
    const referrerPrivyId = referrerResult.rows[0]?.privy_user_id || 'unknown';
    const referrerUsername = referrerResult.rows[0]?.username || 'unknown';

    await client.query('COMMIT');

    logger.info({
      message: 'Referral earnings credited',
      earningsId,
      referrerUserId,
      referrerPrivyId,
      referrerUsername,
      referredUserId,
      tradeId,
      earnings,
      platformFee,
      tradeCost,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({
      message: 'Error crediting referral earnings',
      referrerUserId,
      referredUserId,
      tradeId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get total lifetime earnings for a referrer
 */
export async function getTotalEarnings(referrerUserId: string): Promise<number> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return 0;
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT COALESCE(SUM(referral_earnings_usdc), 0) as total
       FROM referral_earnings
       WHERE referrer_user_id = $1 AND status = 'CREDITED'`,
      [referrerUserId]
    );
    
    return parseFloat(result.rows[0].total || '0');
  } finally {
    client.release();
  }
}

/**
 * Get withdrawable balance for a referrer
 */
export async function getWithdrawableBalance(referrerUserId: string): Promise<number> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return 0;
  }

  const client = await pool.connect();
  
  try {
    const result = await client.query(
      'SELECT referral_earnings_balance FROM users WHERE id = $1',
      [referrerUserId]
    );
    
    if (result.rows.length === 0) {
      return 0;
    }
    
    return parseFloat(result.rows[0].referral_earnings_balance || '0');
  } finally {
    client.release();
  }
}

/**
 * Deduct from referral earnings balance (for withdrawals)
 */
export async function deductReferralBalance(
  referrerUserId: string,
  amount: number
): Promise<void> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return;
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Check current balance
    const balanceResult = await client.query(
      'SELECT referral_earnings_balance FROM users WHERE id = $1 FOR UPDATE',
      [referrerUserId]
    );
    
    if (balanceResult.rows.length === 0) {
      throw new Error('User not found');
    }
    
    const currentBalance = parseFloat(balanceResult.rows[0].referral_earnings_balance || '0');
    
    if (currentBalance < amount) {
      throw new Error(`Insufficient referral earnings balance. Available: ${currentBalance}, Requested: ${amount}`);
    }

    // Deduct amount
    await client.query(
      `UPDATE users 
       SET referral_earnings_balance = referral_earnings_balance - $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [amount, referrerUserId]
    );

    await client.query('COMMIT');

    logger.info({
      message: 'Referral earnings balance deducted',
      referrerUserId,
      amount,
      previousBalance: currentBalance,
      newBalance: currentBalance - amount,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({
      message: 'Error deducting referral earnings balance',
      referrerUserId,
      amount,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

