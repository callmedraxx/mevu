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

/**
 * Get Solana wallet address for a Kalshi user, with fallback from kalshi_trades_history.
 * Returns solana_wallet_address only — NOT proxy_wallet or embedded_wallet (those are EVM/0x).
 * Call this when you need the Solana address for Kalshi positions/portfolio/balance.
 */
export async function getSolanaAddressForKalshiUser(privyUserId: string): Promise<string | null> {
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return null;

  const client = await pool.connect();
  try {
    const r = await client.query<{ solana_wallet_address: string | null }>(
      `SELECT solana_wallet_address FROM users WHERE privy_user_id = $1`,
      [privyUserId]
    );
    let addr = r.rows[0]?.solana_wallet_address ?? null;
    if (addr) return addr;

    // Fallback: from kalshi_trades_history
    const t = await client.query<{ solana_wallet_address: string }>(
      `SELECT solana_wallet_address FROM kalshi_trades_history
       WHERE privy_user_id = $1 AND solana_wallet_address IS NOT NULL AND solana_wallet_address != ''
       ORDER BY created_at DESC LIMIT 1`,
      [privyUserId]
    );
    addr = t.rows[0]?.solana_wallet_address ?? null;
    if (addr) {
      await updateUserSolanaWallet(privyUserId, addr);
      return addr;
    }
    return null;
  } finally {
    client.release();
  }
}

/**
 * Update users.solana_wallet_address — Solana chain only (base58).
 * Rejects EVM addresses (0x...) to avoid accidental use of proxy_wallet or embedded_wallet.
 */
export async function updateUserSolanaWallet(
  privyUserId: string,
  solanaWalletAddress: string,
  solanaWalletId?: string
): Promise<boolean> {
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return false;

  // Guard: Solana addresses are base58 (~44 chars), not 0x (EVM proxy/embedded)
  if (solanaWalletAddress.startsWith('0x') || solanaWalletAddress.startsWith('0X')) {
    logger.warn({
      message: 'Rejected EVM address for solana_wallet_address — use proxy_wallet or embedded_wallet for EVM',
      privyUserId,
      addressPrefix: solanaWalletAddress.slice(0, 10) + '...',
    });
    return false;
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE users SET solana_wallet_address = $1, solana_wallet_id = $3, updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $2`,
      [solanaWalletAddress, privyUserId, solanaWalletId ?? null]
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

/**
 * Add a deposit amount to the user's Kalshi USDC balance.
 * Used when Solana deposits are detected via Alchemy webhook.
 */
export async function addToKalshiUsdcBalance(
  privyUserId: string,
  amountToAdd: string
): Promise<boolean> {
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return false;

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE users SET
         kalshi_usdc_balance = GREATEST(0, COALESCE(kalshi_usdc_balance, 0) + $1::numeric),
         updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $2`,
      [amountToAdd, privyUserId]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

/**
 * Subtract an amount from the user's Kalshi USDC balance.
 * Used when: (1) outgoing USDC detected via Alchemy webhook, (2) Kalshi buy trade executed.
 */
export async function subtractFromKalshiUsdcBalance(
  privyUserId: string,
  amountToSubtract: string
): Promise<boolean> {
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return false;

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE users SET
         kalshi_usdc_balance = GREATEST(0, COALESCE(kalshi_usdc_balance, 0) - $1::numeric),
         updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $2`,
      [amountToSubtract, privyUserId]
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

/**
 * Set the user's Kalshi USDC balance to an absolute value.
 * Used by the on-chain sync fallback.
 */
export async function setKalshiUsdcBalance(
  privyUserId: string,
  absoluteBalance: string
): Promise<boolean> {
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return false;

  const client = await pool.connect();
  try {
    const result = await client.query(
      `UPDATE users SET
         kalshi_usdc_balance = $1::numeric,
         updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $2`,
      [absoluteBalance, privyUserId]
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
