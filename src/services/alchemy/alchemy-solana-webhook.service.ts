/**
 * Alchemy Solana Webhook Service
 * Tracks USDC deposits to user Solana wallets for Kalshi trading balance
 * Alchemy Address Activity webhook supports Solana (early beta)
 * @see https://docs.alchemy.com/reference/address-activity-webhook
 */

import { pool } from '../../config/database';
import { logger } from '../../config/logger';
import { addToKalshiUsdcBalance, subtractFromKalshiUsdcBalance } from '../privy/kalshi-user.service';
import { publishKalshiPositionUpdate } from '../redis-cluster-broadcast.service';

const ALCHEMY_SOLANA_SIGNING_KEY = process.env.ALCHEMY_SOLANA_SIGNING_KEY || process.env.ALCHEMY_SIGNING_KEY;

// USDC mint on Solana mainnet
const USDC_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Solana network identifier in Alchemy webhooks (beta)
const SOLANA_NETWORK = 'SOLANA_MAINNET';

interface SolanaActivity {
  blockNum?: string;
  hash?: string;
  fromAddress?: string;
  toAddress?: string;
  value?: number;
  asset?: string;
  category?: string;
  rawContract?: {
    address?: string;
    rawValue?: string;
    decimals?: number;
  };
}

interface AlchemySolanaWebhookPayload {
  webhookId?: string;
  id?: string;
  type?: string;
  event?: {
    network?: string;
    activity?: SolanaActivity[];
  };
}

/**
 * Verify Alchemy webhook signature (same mechanism as Polygon webhook)
 */
export function verifySolanaWebhookSignature(rawBody: string, signature: string): boolean {
  if (!ALCHEMY_SOLANA_SIGNING_KEY) return true;
  try {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', ALCHEMY_SOLANA_SIGNING_KEY);
    hmac.update(rawBody);
    const digest = hmac.digest('hex');
    return signature === digest;
  } catch {
    return false;
  }
}

/**
 * Process Alchemy Solana webhook - detect USDC deposits to user wallets
 */
export async function processSolanaWebhook(payload: AlchemySolanaWebhookPayload): Promise<void> {
  const activity = payload.event?.activity;
  const network = payload.event?.network;

  if (!activity || activity.length === 0) return;

  if (network !== SOLANA_NETWORK && !String(network || '').toUpperCase().includes('SOLANA')) {
    return;
  }

  const client = await pool.connect();
  let solanaToUser: Map<string, string> | null = null;

  try {
    const r = await client.query<{ privy_user_id: string; solana_wallet_address: string }>(
      `SELECT privy_user_id, solana_wallet_address FROM users WHERE solana_wallet_address IS NOT NULL`
    );
    solanaToUser = new Map(r.rows.map((row) => [row.solana_wallet_address, row.privy_user_id]));
  } finally {
    client.release();
  }

  for (const a of activity) {
    const fromAddress = (a.fromAddress || '').trim();
    const toAddress = (a.toAddress || '').trim();
    const value = a.value ?? 0;
    const asset = (a.asset || '').toUpperCase();

    if (value <= 0) continue;

    const isUsdc =
      asset === 'USDC' ||
      a.rawContract?.address === USDC_MINT_SOLANA ||
      (a.category === 'token' && value > 0);

    if (!isUsdc) continue;

    const amountRaw = (a.rawContract?.rawValue && parseInt(a.rawContract.rawValue, 16)) || value * 1e6;
    const amountHuman = (amountRaw / 1e6).toFixed(6);

    // Incoming: toAddress is user's Solana wallet
    const incomingUserId = solanaToUser?.get(toAddress);
    if (incomingUserId) {
      try {
        await addToKalshiUsdcBalance(incomingUserId, amountHuman);
        publishKalshiPositionUpdate(incomingUserId, {
          type: 'balance_update',
          amount: amountHuman,
          source: 'solana_deposit',
        });
        logger.info({
          message: 'Solana USDC deposit detected and credited',
          privyUserId: incomingUserId,
          toAddress: toAddress.slice(0, 8) + '...',
          amount: amountHuman,
          txHash: a.hash,
        });
      } catch (err) {
        logger.error({
          message: 'Failed to credit Solana deposit',
          privyUserId: incomingUserId,
          amount: amountHuman,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    // Outgoing: fromAddress is user's Solana wallet
    const outgoingUserId = solanaToUser?.get(fromAddress);
    if (outgoingUserId) {
      try {
        await subtractFromKalshiUsdcBalance(outgoingUserId, amountHuman);
        publishKalshiPositionUpdate(outgoingUserId, {
          type: 'balance_update',
          amount: `-${amountHuman}`,
          source: 'solana_withdrawal',
        });
        logger.info({
          message: 'Solana USDC withdrawal detected and debited',
          privyUserId: outgoingUserId,
          fromAddress: fromAddress.slice(0, 8) + '...',
          amount: amountHuman,
          txHash: a.hash,
        });
      } catch (err) {
        logger.error({
          message: 'Failed to debit Solana withdrawal',
          privyUserId: outgoingUserId,
          amount: amountHuman,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
