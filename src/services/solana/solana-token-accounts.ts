/**
 * Solana Token-2022 accounts for a wallet.
 * Used for Kalshi positions — DFlow outcome tokens are Token-2022.
 * See: https://pond.dflow.net/build/recipes/prediction-markets/track-positions
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

/** Token-2022 program ID — outcome tokens use this program */
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export interface TokenBalance {
  mint: string;
  rawBalance: string;
  balance: number;
  decimals: number;
}

/**
 * Fetch non-zero Token-2022 token balances for a wallet.
 * Uses JSON-RPC getTokenAccountsByOwner with programId filter.
 */
export async function getToken2022Balances(walletAddress: string): Promise<TokenBalance[]> {
  try {
    const response = await axios.post(
      getSolanaRpcUrl(),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          walletAddress,
          { programId: TOKEN_2022_PROGRAM_ID },
          { encoding: 'jsonParsed' },
        ],
      },
      { timeout: 15000 }
    );

    const accounts = response.data?.result?.value;
    if (!Array.isArray(accounts)) return [];

    const tokens: TokenBalance[] = [];
    for (const item of accounts) {
      const info = item?.account?.data?.parsed?.info;
      if (!info?.mint || !info?.tokenAmount) continue;

      const { amount, uiAmount, decimals } = info.tokenAmount;
      const balance = uiAmount ?? Number(amount) / Math.pow(10, decimals || 6);
      if (balance <= 0) continue;

      tokens.push({
        mint: info.mint,
        rawBalance: amount,
        balance,
        decimals: decimals ?? 6,
      });
    }

    return tokens;
  } catch (error) {
    logger.error({
      message: 'Failed to fetch Solana Token-2022 balances',
      walletAddress: walletAddress.slice(0, 8) + '...',
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
