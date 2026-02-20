/**
 * On-chain Solana USDC balance check.
 * Fallback for when Alchemy webhooks miss a deposit.
 * Uses JSON-RPC getTokenAccountsByOwner — no SDK needed.
 *
 * Uses Alchemy Solana RPC when ALCHEMY_SOLANA_API_KEY or ALCHEMY_API_KEY is set (avoids 429 rate limits).
 */

import axios from 'axios';
import { logger } from '../../config/logger';

function getSolanaRpcUrl(): string {
  const key = process.env.ALCHEMY_SOLANA_API_KEY || process.env.ALCHEMY_API_KEY;
  if (key) return `https://solana-mainnet.g.alchemy.com/v2/${key}`;
  return process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Fetch the USDC balance (human-readable, e.g. "4.88") for a Solana wallet.
 * Returns "0" if no token account exists or on error.
 */
export async function getSolanaUsdcBalance(walletAddress: string): Promise<string> {
  try {
    const response = await axios.post(
      getSolanaRpcUrl(),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          walletAddress,
          { mint: USDC_MINT },
          { encoding: 'jsonParsed' },
        ],
      },
      { timeout: 10000 }
    );

    const accounts = response.data?.result?.value;
    if (!Array.isArray(accounts) || accounts.length === 0) return '0';

    const tokenAmount = accounts[0]?.account?.data?.parsed?.info?.tokenAmount;
    const uiAmount = tokenAmount?.uiAmountString ?? '0';

    return uiAmount;
  } catch (error) {
    logger.error({
      message: 'Failed to fetch Solana USDC balance on-chain',
      walletAddress: walletAddress.slice(0, 8) + '...',
      error: error instanceof Error ? error.message : String(error),
    });
    return '0';
  }
}
