/**
 * One-time script to sync all existing Solana wallets to Alchemy Solana webhook
 * Ensures all users with Solana wallets receive USDC balance updates (deposits, withdrawals).
 *
 * Prerequisites: Create an Address Activity webhook for Solana in Alchemy Dashboard.
 * Use ALCHEMY_SOLANA_WEBHOOK_URL (or https://your-api/api/webhooks/alchemy-solana) as the webhook URL.
 * Set ALCHEMY_SOLANA_WEBHOOK_ID and ALCHEMY_AUTH_TOKEN in .env.
 *
 * Run with: npx tsx src/scripts/sync-solana-wallets-to-webhook.ts
 */

import { pool } from '../config/database';
import { logger } from '../config/logger';
import { addSolanaAddressToWebhook } from '../services/alchemy/alchemy-solana-webhook-addresses';
import dotenv from 'dotenv';

dotenv.config();

async function syncSolanaWallets(): Promise<void> {
  try {
    if (!process.env.ALCHEMY_SOLANA_WEBHOOK_ID || !process.env.ALCHEMY_AUTH_TOKEN) {
      logger.error({
        message: 'ALCHEMY_SOLANA_WEBHOOK_ID and ALCHEMY_AUTH_TOKEN required',
      });
      process.exit(1);
    }

    const result = await pool.query(
      `SELECT privy_user_id, solana_wallet_address FROM users WHERE solana_wallet_address IS NOT NULL`
    );

    const users = result.rows;
    logger.info({ message: 'Found users with Solana wallets', count: users.length });

    if (users.length === 0) {
      logger.info({ message: 'No Solana wallets to sync' });
      return;
    }

    let success = 0;
    for (const u of users) {
      try {
        await addSolanaAddressToWebhook(u.solana_wallet_address);
        success++;
      } catch (e) {
        logger.warn({
          message: 'Failed to add Solana address',
          address: u.solana_wallet_address?.slice(0, 8) + '...',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    logger.info({ message: 'Solana wallet sync completed', success, total: users.length });
  } catch (error) {
    logger.error({ message: 'Sync failed', error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

syncSolanaWallets();
