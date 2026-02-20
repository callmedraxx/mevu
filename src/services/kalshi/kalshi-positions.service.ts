/**
 * Kalshi Positions Service
 * Fetches positions from on-chain (Solana Token-2022) + DFlow metadata API.
 * Per DFlow's official recipe: https://pond.dflow.net/build/recipes/prediction-markets/track-positions
 *
 * Enrichment: avg entry from kalshi_trades_history, current price from kalshi_markets or Kalshi API.
 */

import { pool, getDatabaseConfig } from '../../config/database';
import { getToken2022Balances } from '../solana/solana-token-accounts';
import { dflowMetadataService } from '../dflow/dflow-metadata.service';
import { SOLANA_USDC_MINT } from '../dflow/dflow-order-validation';
import { fetchKalshiMarketByTicker } from './kalshi.client';

export interface KalshiPosition {
  outcomeMint: string;
  kalshiTicker: string;
  outcome: 'YES' | 'NO';
  tokenBalance: string;
  tokenBalanceHuman: string;
  marketTitle: string;
  /** Avg entry price in cents (0-100). From on-chain we don't have cost basis — null. */
  avgEntryPrice: number | null;
  /** Total cost USDC. From on-chain we don't have cost basis — "0". */
  totalCostUsdc: string;
  /** For sell payload */
  sellAction: {
    type: 'kalshi';
    kalshiTicker: string;
    outcome: string;
    tokenAmount: string;
  };
}

/**
 * Fetch Kalshi positions for a Solana wallet.
 * Flow: Solana Token-2022 balances → DFlow filter_outcome_mints → DFlow markets/batch → map to positions.
 */
export async function getKalshiPositions(solanaWalletAddress: string): Promise<KalshiPosition[]> {
  if (!solanaWalletAddress) return [];

  // 1. Solana RPC: Token-2022 non-zero balances
  const tokens = await getToken2022Balances(solanaWalletAddress);
  if (tokens.length === 0) return [];

  const mintAddresses = tokens.map((t) => t.mint);
  const mintToToken = new Map(tokens.map((t) => [t.mint, t]));

  // 2. DFlow: filter to outcome mints only
  const outcomeMints = await dflowMetadataService.filterOutcomeMints(mintAddresses);
  if (outcomeMints.length === 0) return [];

  // 3. DFlow: fetch market metadata for outcome mints
  const markets = await dflowMetadataService.getMarketsBatch(outcomeMints);
  const mintToMarket = new Map<string, typeof markets[0]>();
  const mintToOutcome = new Map<string, 'YES' | 'NO'>();

  for (const market of markets) {
    const usdcAccount = market?.accounts?.[SOLANA_USDC_MINT];
    if (!usdcAccount) continue;
    if (usdcAccount.yesMint) {
      mintToMarket.set(usdcAccount.yesMint, market);
      mintToOutcome.set(usdcAccount.yesMint, 'YES');
    }
    if (usdcAccount.noMint) {
      mintToMarket.set(usdcAccount.noMint, market);
      mintToOutcome.set(usdcAccount.noMint, 'NO');
    }
  }

  // 4. Map each outcome token to a position
  const positions: KalshiPosition[] = [];

  for (const mint of outcomeMints) {
    const token = mintToToken.get(mint);
    const market = mintToMarket.get(mint);
    const outcome = mintToOutcome.get(mint);

    if (!token || !market?.ticker || !outcome) continue;

    const tokenBalance = token.rawBalance;
    const tokenBalanceHuman = token.balance.toFixed(6).replace(/\.?0+$/, '') || '0';
    const kalshiTicker = market.ticker;
    const marketTitle = market.title ?? kalshiTicker;

    positions.push({
      outcomeMint: mint,
      kalshiTicker,
      outcome,
      tokenBalance,
      tokenBalanceHuman,
      marketTitle,
      avgEntryPrice: null, // On-chain: no cost basis
      totalCostUsdc: '0', // On-chain: no cost basis
      sellAction: {
        type: 'kalshi',
        kalshiTicker,
        outcome,
        tokenAmount: tokenBalance,
      },
    });
  }

  return positions;
}

/**
 * Get volume-weighted average entry price (cents) from kalshi_trades_history BUY fills.
 * Returns null if no BUY trades found for this user + ticker + outcome.
 */
export async function getKalshiAvgEntryFromTrades(
  privyUserId: string,
  kalshiTicker: string,
  outcome: string
): Promise<number | null> {
  if (getDatabaseConfig().type !== 'postgres') return null;
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT input_amount, output_amount
       FROM kalshi_trades_history
       WHERE privy_user_id = $1 AND kalshi_ticker = $2 AND outcome = $3 AND side = 'BUY' AND status = 'FILLED'
       ORDER BY created_at ASC`,
      [privyUserId, kalshiTicker, outcome]
    );
    if (r.rows.length === 0) return null;
    let totalInput = 0;
    let totalOutput = 0;
    for (const row of r.rows) {
      const input = parseInt(String(row.input_amount || '0'), 10);
      const output = parseInt(String(row.output_amount || '0'), 10);
      if (output <= 0) continue;
      totalInput += input;
      totalOutput += output;
    }
    if (totalOutput <= 0) return null;
    // Price per share in cents: (USDC_raw/1e6)*100 / (tokens_raw/1e6) = input*100/output
    const avgCents = Math.round((totalInput * 100) / totalOutput);
    return Math.max(1, Math.min(99, avgCents));
  } finally {
    client.release();
  }
}

/**
 * Get current sell price (cents) for a Kalshi position.
 * For YES: yes_bid (what market will pay). For NO: no_bid.
 * Tries kalshi_markets DB first, then Kalshi API.
 */
export async function getKalshiCurrentPrice(
  ticker: string,
  outcome: 'YES' | 'NO'
): Promise<number | null> {
  if (getDatabaseConfig().type === 'postgres') {
    const client = await pool.connect();
    try {
      const r = await client.query(
        `SELECT yes_bid, no_bid FROM kalshi_markets WHERE ticker = $1`,
        [ticker]
      );
      if (r.rows.length > 0) {
        const row = r.rows[0];
        const bid = outcome === 'YES' ? row.yes_bid : row.no_bid;
        if (bid != null && bid >= 0) return bid;
      }
    } finally {
      client.release();
    }
  }
  const market = await fetchKalshiMarketByTicker(ticker);
  if (!market) return null;
  const bid = outcome === 'YES' ? market.yes_bid : market.no_bid;
  return bid != null && bid >= 0 ? bid : null;
}
