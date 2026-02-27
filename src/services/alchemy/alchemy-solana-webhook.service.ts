/**
 * Alchemy Solana Webhook Service
 * Tracks USDC balance changes for user Solana wallets via Alchemy Address Activity webhook.
 *
 * Alchemy's Solana webhook (early beta) sends raw transaction data in `event.transaction[]`
 * — NOT the parsed `event.activity[]` format used for EVM chains.
 *
 * We parse `meta.post_token_balances` from the transaction to get the exact post-trade
 * USDC balance for each user wallet — no polling or on-chain RPC calls needed.
 *
 * @see https://docs.alchemy.com/reference/address-activity-webhook
 */

import { pool } from '../../config/database';
import { logger } from '../../config/logger';
import { setKalshiUsdcBalance } from '../privy/kalshi-user.service';
import { publishKalshiPositionUpdate } from '../redis-cluster-broadcast.service';

const ALCHEMY_SOLANA_SIGNING_KEY = process.env.ALCHEMY_SOLANA_SIGNING_KEY;

const USDC_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_NETWORK = 'SOLANA_MAINNET';

/* ─── Types ────────────────────────────────────────────────────────── */

interface TokenBalance {
  account_index: number;
  mint: string;
  owner?: string;
  ui_token_amount?: {
    amount?: string;
    decimals?: number;
    ui_amount?: number | null;
    ui_amount_string?: string;
  };
}

interface TxMeta {
  post_token_balances?: TokenBalance[];
  pre_token_balances?: TokenBalance[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface TxMessage {
  account_keys?: string[];
}

interface TxInner {
  signatures?: string[];
  message?: TxMessage[];
}

interface TxWrapper {
  signature?: string;
  transaction?: TxInner[];
  meta?: TxMeta[];
}

interface AlchemySolanaWebhookPayload {
  webhookId?: string;
  id?: string;
  type?: string;
  event?: {
    network?: string;
    transaction?: TxWrapper[];
  };
}

/* ─── Signature verification ──────────────────────────────────────── */

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

/* ─── Balance extraction from transaction metadata ────────────────── */

interface UserBalanceUpdate {
  privyUserId: string;
  walletAddress: string;
  newBalance: string;
  signature: string;
}

/**
 * Parse post_token_balances from Alchemy Solana webhook transactions
 * to extract the final USDC balance for each user wallet.
 */
function extractUsdcBalances(
  payload: AlchemySolanaWebhookPayload,
  walletToUser: Map<string, string>
): UserBalanceUpdate[] {
  const updates: UserBalanceUpdate[] = [];
  const transactions = payload.event?.transaction;
  if (!Array.isArray(transactions)) return updates;

  for (const txWrapper of transactions) {
    const signature = txWrapper.signature || txWrapper.transaction?.[0]?.signatures?.[0] || 'unknown';

    // Get post_token_balances from meta
    const metaArray = txWrapper.meta || (txWrapper as any).meta;
    if (!Array.isArray(metaArray)) continue;

    for (const meta of metaArray) {
      const postBalances = meta.post_token_balances;
      if (!Array.isArray(postBalances)) continue;

      for (const tb of postBalances) {
        if (tb.mint !== USDC_MINT_SOLANA) continue;

        const owner = tb.owner;
        if (!owner) continue;

        const privyUserId = walletToUser.get(owner);
        if (!privyUserId) continue;

        const balance = tb.ui_token_amount?.ui_amount_string
          || (tb.ui_token_amount?.amount
            ? (parseInt(tb.ui_token_amount.amount) / Math.pow(10, tb.ui_token_amount.decimals || 6)).toFixed(6)
            : null);

        if (balance !== null) {
          updates.push({ privyUserId, walletAddress: owner, newBalance: balance, signature });
        }
      }
    }
  }

  // Deduplicate — keep the latest balance per user (last transaction wins)
  const byUser = new Map<string, UserBalanceUpdate>();
  for (const u of updates) {
    byUser.set(u.privyUserId, u);
  }
  return Array.from(byUser.values());
}

/* ─── Main processor ──────────────────────────────────────────────── */

export async function processSolanaWebhook(payload: AlchemySolanaWebhookPayload): Promise<void> {
  const network = payload.event?.network;
  const transactions = payload.event?.transaction;

  if (!Array.isArray(transactions) || transactions.length === 0) return;

  if (network !== SOLANA_NETWORK && !String(network || '').toUpperCase().includes('SOLANA')) {
    return;
  }

  // Load wallet -> user mapping
  const client = await pool.connect();
  let walletToUser: Map<string, string>;
  try {
    const r = await client.query<{ privy_user_id: string; solana_wallet_address: string }>(
      `SELECT privy_user_id, solana_wallet_address FROM users WHERE solana_wallet_address IS NOT NULL`
    );
    walletToUser = new Map(r.rows.map((row) => [row.solana_wallet_address, row.privy_user_id]));
  } finally {
    client.release();
  }

  // Extract USDC balance updates directly from transaction metadata
  const balanceUpdates = extractUsdcBalances(payload, walletToUser);
  if (balanceUpdates.length === 0) return;

  // Apply balance updates
  for (const update of balanceUpdates) {
    try {
      const dbClient = await pool.connect();
      let dbBalance = 0;
      try {
        const r = await dbClient.query(
          `SELECT kalshi_usdc_balance FROM users WHERE privy_user_id = $1`,
          [update.privyUserId]
        );
        dbBalance = parseFloat(r.rows[0]?.kalshi_usdc_balance ?? '0') || 0;
      } finally {
        dbClient.release();
      }

      const newBalanceNum = parseFloat(update.newBalance) || 0;

      if (Math.abs(newBalanceNum - dbBalance) > 0.001) {
        await setKalshiUsdcBalance(update.privyUserId, update.newBalance);
        publishKalshiPositionUpdate(update.privyUserId, {
          type: 'balance_update',
          amount: update.newBalance,
          source: 'solana_webhook',
        });
        logger.info({
          message: 'Solana USDC balance updated via webhook',
          privyUserId: update.privyUserId,
          walletAddress: update.walletAddress.slice(0, 8) + '...',
          previousBalance: dbBalance,
          newBalance: update.newBalance,
        });
      }
    } catch (err) {
      logger.error({
        message: 'Failed to update Solana USDC balance from webhook',
        privyUserId: update.privyUserId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
