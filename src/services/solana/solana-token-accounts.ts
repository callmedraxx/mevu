/**
 * Solana token accounts for a wallet.
 * Kalshi outcome tokens can use either standard SPL Token or Token-2022 depending on market.
 * DFlow/PM transactions may use the standard Token program; we query both for robustness.
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

/** Standard SPL Token program — some outcome tokens use this */
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** Token-2022 program ID — outcome tokens may use this program */
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export interface TokenBalance {
  mint: string;
  rawBalance: string;
  balance: number;
  decimals: number;
  /** Which token program this account belongs to — for diagnostics when sell fails with "insufficient funds" */
  tokenProgram?: 'Token' | 'Token-2022';
}

async function getTokenBalancesByProgram(
  walletAddress: string,
  programId: string,
  logLabel: string,
  tokenProgram: 'Token' | 'Token-2022'
): Promise<TokenBalance[]> {
  try {
    const response = await axios.post(
      getSolanaRpcUrl(),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          walletAddress,
          { programId },
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
        tokenProgram,
      });
    }

    return tokens;
  } catch (error) {
    logger.error({
      message: `Failed to fetch Solana ${logLabel} balances`,
      walletAddress: walletAddress.slice(0, 8) + '...',
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Fetch non-zero Token-2022 token balances for a wallet.
 * Uses JSON-RPC getTokenAccountsByOwner with programId filter.
 */
export async function getToken2022Balances(walletAddress: string): Promise<TokenBalance[]> {
  return getTokenBalancesByProgram(walletAddress, TOKEN_2022_PROGRAM_ID, 'Token-2022', 'Token-2022');
}

/**
 * Fetch non-zero standard SPL Token balances for a wallet.
 */
export async function getStandardTokenBalances(walletAddress: string): Promise<TokenBalance[]> {
  return getTokenBalancesByProgram(walletAddress, TOKEN_PROGRAM_ID, 'standard SPL Token', 'Token');
}

/**
 * Fetch all outcome token balances from both standard SPL Token and Token-2022 programs.
 * DFlow/PM transactions may use either program; outcome mints can vary by market.
 * Merges results by mint (each mint exists in at most one program).
 */
export async function getAllOutcomeTokenBalances(walletAddress: string): Promise<TokenBalance[]> {
  const [standard, token2022] = await Promise.all([
    getStandardTokenBalances(walletAddress),
    getToken2022Balances(walletAddress),
  ]);
  const byMint = new Map<string, TokenBalance>();
  for (const t of [...standard, ...token2022]) {
    const existing = byMint.get(t.mint);
    if (!existing || BigInt(t.rawBalance) > BigInt(existing.rawBalance)) {
      byMint.set(t.mint, t);
    }
  }
  return Array.from(byMint.values());
}

/**
 * Fetch the token program that owns a mint (standard Token vs Token-2022).
 * Used to diagnose "insufficient funds" when DFlow tx uses the wrong program.
 */
export async function getMintTokenProgram(mint: string): Promise<'Token' | 'Token-2022' | null> {
  try {
    const response = await axios.post(
      getSolanaRpcUrl(),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [mint, { encoding: 'jsonParsed' }],
      },
      { timeout: 10000 }
    );
    const owner = response.data?.result?.value?.owner;
    if (owner === TOKEN_PROGRAM_ID) return 'Token';
    if (owner === TOKEN_2022_PROGRAM_ID) return 'Token-2022';
    return null;
  } catch {
    return null;
  }
}
