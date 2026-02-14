/**
 * Alchemy Solana Webhook Address Management
 * Registers Solana wallet addresses with Alchemy Address Activity webhook for USDC balance tracking.
 * Call addSolanaAddress when a user creates a Solana wallet.
 */

import axios from 'axios';
import { logger } from '../../config/logger';

const ALCHEMY_API_URL = 'https://dashboard.alchemy.com/api';
const ALCHEMY_AUTH_TOKEN = process.env.ALCHEMY_AUTH_TOKEN;
const ALCHEMY_SOLANA_WEBHOOK_ID = process.env.ALCHEMY_SOLANA_WEBHOOK_ID;
/** Full URL Alchemy should POST to; set in Alchemy Dashboard when creating the webhook */
export const ALCHEMY_SOLANA_WEBHOOK_URL = process.env.ALCHEMY_SOLANA_WEBHOOK_URL;

/**
 * Add a Solana address to the Alchemy Solana Address Activity webhook.
 * Enables real-time USDC deposit/withdrawal notifications for Kalshi balance tracking.
 * Solana addresses are base58 - do NOT lowercase (unlike EVM addresses).
 */
export async function addSolanaAddressToWebhook(solanaAddress: string): Promise<void> {
  if (!ALCHEMY_SOLANA_WEBHOOK_ID || !ALCHEMY_AUTH_TOKEN) {
    logger.debug({
      message: 'Alchemy Solana webhook not configured, skipping address registration',
      address: solanaAddress.slice(0, 8) + '...',
    });
    return;
  }

  const trimmed = solanaAddress.trim();
  if (!trimmed) return;

  try {
    await axios.patch(
      `${ALCHEMY_API_URL}/update-webhook-addresses`,
      {
        webhook_id: ALCHEMY_SOLANA_WEBHOOK_ID,
        addresses_to_add: [trimmed],
        addresses_to_remove: [],
      },
      {
        headers: {
          'X-Alchemy-Token': ALCHEMY_AUTH_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );
    logger.info({
      message: 'Solana address added to Alchemy webhook',
      address: trimmed.slice(0, 8) + '...',
    });
  } catch (error: any) {
    logger.warn({
      message: 'Failed to add Solana address to Alchemy webhook',
      address: trimmed.slice(0, 8) + '...',
      error: error.message,
      statusCode: error.response?.status,
    });
    // Don't throw - address registration is non-critical; webhook may already have it
  }
}
