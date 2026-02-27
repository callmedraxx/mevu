/**
 * Alchemy Solana Webhook Address Management
 * Registers Solana wallet addresses with Alchemy Address Activity webhook for USDC balance tracking.
 * Registers both the wallet address AND its USDC ATA (Associated Token Account),
 * since Solana USDC transfers happen at the ATA, not the wallet itself.
 */

import axios from 'axios';
import { logger } from '../../config/logger';

const ALCHEMY_API_URL = 'https://dashboard.alchemy.com/api';
const ALCHEMY_AUTH_TOKEN = process.env.ALCHEMY_AUTH_TOKEN;
const ALCHEMY_SOLANA_WEBHOOK_ID = process.env.ALCHEMY_SOLANA_WEBHOOK_ID;
/** Full URL Alchemy should POST to; set in Alchemy Dashboard when creating the webhook */
export const ALCHEMY_SOLANA_WEBHOOK_URL = process.env.ALCHEMY_SOLANA_WEBHOOK_URL;

const USDC_MINT_SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function getSolanaRpcUrl(): string {
  const key = process.env.ALCHEMY_SOLANA_API_KEY || process.env.ALCHEMY_API_KEY;
  if (key) return `https://solana-mainnet.g.alchemy.com/v2/${key}`;
  return process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

/**
 * Look up the USDC Associated Token Account (ATA) address for a wallet via RPC.
 */
async function getUsdcAtaAddress(walletAddress: string): Promise<string | null> {
  try {
    const resp = await axios.post(
      getSolanaRpcUrl(),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [walletAddress, { mint: USDC_MINT_SOLANA }, { encoding: 'jsonParsed' }],
      },
      { timeout: 10000 }
    );
    const accounts = resp.data?.result?.value;
    if (Array.isArray(accounts) && accounts.length > 0) {
      return accounts[0].pubkey as string;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Add a Solana address (and its USDC ATA) to the Alchemy Address Activity webhook.
 * Solana addresses are base58 - do NOT lowercase (unlike EVM addresses).
 */
export async function addSolanaAddressToWebhook(solanaAddress: string): Promise<void> {
  if (!ALCHEMY_SOLANA_WEBHOOK_ID || !ALCHEMY_AUTH_TOKEN) {
    return;
  }

  const trimmed = solanaAddress.trim();
  if (!trimmed) return;

  const addressesToAdd = [trimmed];

  try {
    const ataAddress = await getUsdcAtaAddress(trimmed);
    if (ataAddress && ataAddress !== trimmed) {
      addressesToAdd.push(ataAddress);
    }
  } catch { /* ATA lookup failed, register wallet only */ }

  try {
    await axios.patch(
      `${ALCHEMY_API_URL}/update-webhook-addresses`,
      {
        webhook_id: ALCHEMY_SOLANA_WEBHOOK_ID,
        addresses_to_add: addressesToAdd,
        addresses_to_remove: [],
      },
      {
        headers: {
          'X-Alchemy-Token': ALCHEMY_AUTH_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error: any) {
    logger.warn({
      message: 'Failed to add Solana address to Alchemy webhook',
      address: trimmed.slice(0, 8) + '...',
      error: error.message,
      statusCode: error.response?.status,
    });
  }
}
