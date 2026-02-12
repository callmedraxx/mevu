/**
 * Kalshi User Service
 * Extensions for US/Kalshi user flow: trading_region, Solana wallet, Kalshi onboarding
 */

import { pool, getDatabaseConfig } from '../../config/database';
import { logger } from '../../config/logger';
import type { TradingRegion } from './privy.types';

export async function updateUserTradingRegion(
  privyUserId: string,
  tradingRegion: TradingRegion
): Promise<boolean> {
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return false;

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE users SET trading_region = $1, updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $2`,
      [tradingRegion, privyUserId]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

export async function updateUserSolanaWallet(
  privyUserId: string,
  solanaWalletAddress: string
): Promise<boolean> {
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return false;

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE users SET solana_wallet_address = $1, updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $2`,
      [solanaWalletAddress, privyUserId]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

export async function updateUserKalshiOnboarding(
  privyUserId: string,
  completed: boolean
): Promise<boolean> {
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return false;

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE users SET kalshi_onboarding_completed = $1, updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $2`,
      [completed, privyUserId]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

export async function updateUserKalshiUsdcBalance(
  privyUserId: string,
  balance: string
): Promise<boolean> {
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return false;

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE users SET kalshi_usdc_balance = $1, updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $2`,
      [balance, privyUserId]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

export async function createUserWithRegion(
  privyUserId: string,
  username: string,
  embeddedWalletAddress: string,
  tradingRegion: TradingRegion,
  solanaWalletAddress?: string | null
): Promise<{ id: string } | null> {
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return null;

  const client = await pool.connect();
  try {
    const result = await client.query(
      `INSERT INTO users (privy_user_id, username, embedded_wallet_address, trading_region, solana_wallet_address)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (privy_user_id) DO UPDATE SET
         trading_region = EXCLUDED.trading_region,
         solana_wallet_address = COALESCE(EXCLUDED.solana_wallet_address, users.solana_wallet_address),
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [privyUserId, username, embeddedWalletAddress.toLowerCase(), tradingRegion, solanaWalletAddress ?? null]
    );
    if (result.rows.length === 0) return null;
    return { id: result.rows[0].id };
  } catch (error) {
    logger.error({
      message: 'Error creating user with region',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}
