/**
 * Kalshi Positions Service
 * Fetches positions from on-chain (Solana Token-2022) + DFlow metadata API.
 * Per DFlow's official recipe: https://pond.dflow.net/build/recipes/prediction-markets/track-positions
 *
 * Enrichment: avg entry from kalshi_trades_history, current price from kalshi_markets or Kalshi API.
 */

import { pool, getDatabaseConfig } from '../../config/database';
import { getAllOutcomeTokenBalances } from '../solana/solana-token-accounts';
import { dflowMetadataService } from '../dflow/dflow-metadata.service';
import { SOLANA_USDC_MINT } from '../dflow/dflow-order-validation';
import { fetchKalshiMarketByTicker } from './kalshi.client';
import { logger } from '../../config/logger';

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
  /** True when market is determined/finalized and redemption is open (user holds winning outcome). Use Claim instead of Sell. */
  isRedeemable?: boolean;
}

/**
 * Fetch Kalshi positions for a Solana wallet.
 * Flow: Solana Token-2022 balances → DFlow filter_outcome_mints → DFlow markets/batch → map to positions.
 */
export async function getKalshiPositions(solanaWalletAddress: string): Promise<KalshiPosition[]> {
  if (!solanaWalletAddress) return [];

  // 1. Solana RPC: outcome token balances (standard SPL + Token-2022)
  const tokens = await getAllOutcomeTokenBalances(solanaWalletAddress);
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

    const isRedeemable = await dflowMetadataService.isOutcomeRedeemable(mint);

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
      isRedeemable,
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
 * Get Polymarket game slug for a Kalshi ticker (for navigation to GameDetailV2).
 * Uses kalshi_markets.live_game_id → live_games.slug.
 * Returns null if ticker is not matched to a live game.
 */
export async function getGameSlugForKalshiTicker(kalshiTicker: string): Promise<string | null> {
  if (!kalshiTicker || getDatabaseConfig().type !== 'postgres') return null;
  const client = await pool.connect();
  try {
    const r = await client.query<{ slug: string }>(
      `SELECT lg.slug
       FROM kalshi_markets km
       JOIN live_games lg ON km.live_game_id = lg.id
       WHERE km.ticker = $1 AND km.live_game_id IS NOT NULL
       LIMIT 1`,
      [kalshiTicker]
    );
    return r.rows[0]?.slug ?? null;
  } finally {
    client.release();
  }
}

/**
 * Batch lookup: Kalshi ticker → Polymarket game slug.
 * Used by unified positions to enable correct navigation from profile → game detail.
 */
export async function getGameSlugsForKalshiTickers(
  tickers: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (tickers.length === 0 || getDatabaseConfig().type !== 'postgres') return result;
  const client = await pool.connect();
  try {
    const r = await client.query<{ ticker: string; slug: string }>(
      `SELECT km.ticker, lg.slug
       FROM kalshi_markets km
       JOIN live_games lg ON km.live_game_id = lg.id
       WHERE km.ticker = ANY($1::text[]) AND km.live_game_id IS NOT NULL`,
      [tickers]
    );
    for (const row of r.rows) {
      result.set(row.ticker, row.slug);
    }
    return result;
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

/* ─── Instant position updates (DB-first) ──────────────────────────── */

export interface ApplyKalshiTradeParams {
  privyUserId: string;
  solanaWalletAddress: string;
  kalshiTicker: string;
  outcomeMint: string;
  outcome: string;
  marketTitle?: string | null;
  /** Raw token amount (6-decimal integer string, e.g. "1000000" = 1 share) */
  tokenAmount: string;
  /** Price per token as decimal ratio (e.g. 0.65 = 65 cents). Only needed for BUY. */
  effectivePrice?: number | null;
  /** Raw USDC input amount (6-decimal integer string). Only needed for BUY. */
  usdcAmount?: string;
}

/**
 * Immediately upsert (BUY) or decrement (SELL) a position in kalshi_positions
 * after a filled trade. This makes the position visible instantly without
 * waiting for on-chain RPC sync.
 */
export async function applyKalshiTradeToPositions(
  side: 'BUY' | 'SELL',
  params: ApplyKalshiTradeParams
): Promise<void> {
  if (getDatabaseConfig().type !== 'postgres') return;

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    logger.warn({
      message: 'applyKalshiTradeToPositions: failed to get DB connection',
      side,
      privyUserId: params.privyUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  try {
    if (side === 'BUY') {
      // avg_entry_price stored in cents (0-100)
      const avgCents = params.effectivePrice != null
        ? Math.max(1, Math.min(99, Math.round(params.effectivePrice * 100)))
        : null;
      const totalCostUsdc = params.usdcAmount
        ? Number(params.usdcAmount) / 1e6
        : 0;

      await client.query(
        `INSERT INTO kalshi_positions
          (privy_user_id, solana_wallet_address, kalshi_ticker, outcome_mint, outcome,
           market_title, token_balance, avg_entry_price, total_cost_usdc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (privy_user_id, outcome_mint) DO UPDATE SET
           token_balance = (CAST(kalshi_positions.token_balance AS BIGINT) + CAST(EXCLUDED.token_balance AS BIGINT))::TEXT,
           avg_entry_price = CASE
             WHEN kalshi_positions.avg_entry_price IS NOT NULL AND EXCLUDED.avg_entry_price IS NOT NULL THEN
               ROUND(
                 (kalshi_positions.avg_entry_price * CAST(kalshi_positions.token_balance AS NUMERIC)
                  + EXCLUDED.avg_entry_price * CAST(EXCLUDED.token_balance AS NUMERIC))
                 / NULLIF(CAST(kalshi_positions.token_balance AS NUMERIC) + CAST(EXCLUDED.token_balance AS NUMERIC), 0)
               , 4)
             ELSE COALESCE(EXCLUDED.avg_entry_price, kalshi_positions.avg_entry_price)
           END,
           total_cost_usdc = kalshi_positions.total_cost_usdc + EXCLUDED.total_cost_usdc,
           market_title = COALESCE(EXCLUDED.market_title, kalshi_positions.market_title),
           updated_at = NOW()`,
        [
          params.privyUserId,
          params.solanaWalletAddress,
          params.kalshiTicker,
          params.outcomeMint,
          params.outcome,
          params.marketTitle ?? null,
          params.tokenAmount,
          avgCents,
          totalCostUsdc,
        ]
      );
      logger.info({
        message: 'Kalshi position upserted after BUY',
        privyUserId: params.privyUserId,
        kalshiTicker: params.kalshiTicker,
        tokenAmount: params.tokenAmount,
        avgCents,
      });
    } else {
      // SELL: decrement token_balance
      const result = await client.query(
        `UPDATE kalshi_positions
         SET token_balance = (CAST(token_balance AS BIGINT) - $1)::TEXT,
             updated_at = NOW()
         WHERE privy_user_id = $2 AND outcome_mint = $3
         RETURNING token_balance`,
        [params.tokenAmount, params.privyUserId, params.outcomeMint]
      );

      // Delete row if balance reached 0 or below
      const remaining = parseInt(result.rows[0]?.token_balance ?? '0', 10);
      if (remaining <= 0) {
        await client.query(
          `DELETE FROM kalshi_positions WHERE privy_user_id = $1 AND outcome_mint = $2`,
          [params.privyUserId, params.outcomeMint]
        );
      }
      logger.info({
        message: 'Kalshi position updated after SELL',
        privyUserId: params.privyUserId,
        kalshiTicker: params.kalshiTicker,
        remaining,
      });
    }
  } catch (err) {
    logger.warn({
      message: 'Failed to apply Kalshi trade to positions (non-blocking)',
      side,
      privyUserId: params.privyUserId,
      kalshiTicker: params.kalshiTicker,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    client.release();
  }
}

/**
 * Read Kalshi positions from DB (instant, no RPC calls).
 * Returns same KalshiPosition[] shape as getKalshiPositions().
 */
export async function getKalshiPositionsFromDb(privyUserId: string): Promise<KalshiPosition[]> {
  if (getDatabaseConfig().type !== 'postgres') return [];

  const client = await pool.connect();
  try {
    const r = await client.query<{
      outcome_mint: string;
      kalshi_ticker: string;
      outcome: string;
      token_balance: string;
      market_title: string | null;
      avg_entry_price: string | null;
      total_cost_usdc: string | null;
      is_redeemable: boolean;
    }>(
      `SELECT outcome_mint, kalshi_ticker, outcome, token_balance, market_title,
              avg_entry_price, total_cost_usdc, is_redeemable
       FROM kalshi_positions
       WHERE privy_user_id = $1 AND CAST(token_balance AS BIGINT) > 0`,
      [privyUserId]
    );

    return r.rows.map((row) => {
      const tokenBalance = row.token_balance;
      const balanceNum = parseInt(tokenBalance, 10) / 1e6;
      const tokenBalanceHuman = balanceNum.toFixed(6).replace(/\.?0+$/, '') || '0';
      const avgCents = row.avg_entry_price != null ? parseFloat(row.avg_entry_price) : null;

      return {
        outcomeMint: row.outcome_mint,
        kalshiTicker: row.kalshi_ticker,
        outcome: row.outcome as 'YES' | 'NO',
        tokenBalance,
        tokenBalanceHuman,
        marketTitle: row.market_title ?? row.kalshi_ticker,
        avgEntryPrice: avgCents,
        totalCostUsdc: row.total_cost_usdc ?? '0',
        sellAction: {
          type: 'kalshi' as const,
          kalshiTicker: row.kalshi_ticker,
          outcome: row.outcome,
          tokenAmount: tokenBalance,
        },
        isRedeemable: row.is_redeemable ?? false,
      };
    });
  } finally {
    client.release();
  }
}

/**
 * Background on-chain reconciliation: fetch real positions from Solana RPC
 * and upsert into kalshi_positions. Corrects any drift between DB and chain.
 *
 * Throttled: skips if last sync was < 30s ago for this user.
 * Preserves avg_entry_price/total_cost_usdc from trade inserts.
 * Only updates token_balance from on-chain if the row hasn't been updated
 * in the last 30 seconds (avoids overwriting fresh trade-based inserts with
 * stale on-chain data before Solana finality).
 */
const lastSyncTime = new Map<string, number>();

export async function syncKalshiPositionsOnChain(
  privyUserId: string,
  solanaWalletAddress: string
): Promise<void> {
  if (getDatabaseConfig().type !== 'postgres') return;

  // Throttle: skip if synced within last 30s
  const now = Date.now();
  const lastSync = lastSyncTime.get(privyUserId) ?? 0;
  if (now - lastSync < 30_000) return;
  lastSyncTime.set(privyUserId, now);

  const onChainPositions = await getKalshiPositions(solanaWalletAddress);

  const client = await pool.connect();
  try {
    const onChainMints = new Set<string>();

    for (const pos of onChainPositions) {
      onChainMints.add(pos.outcomeMint);

      // Upsert but only overwrite token_balance if the row is older than 30s
      // (avoids clobbering a fresh trade insert with stale on-chain data before Solana finality)
      await client.query(
        `INSERT INTO kalshi_positions
          (privy_user_id, solana_wallet_address, kalshi_ticker, outcome_mint, outcome,
           market_title, token_balance, is_redeemable)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (privy_user_id, outcome_mint) DO UPDATE SET
           token_balance = CASE
             WHEN kalshi_positions.updated_at < NOW() - INTERVAL '30 seconds'
             THEN EXCLUDED.token_balance
             ELSE kalshi_positions.token_balance
           END,
           kalshi_ticker = EXCLUDED.kalshi_ticker,
           market_title = COALESCE(EXCLUDED.market_title, kalshi_positions.market_title),
           is_redeemable = EXCLUDED.is_redeemable,
           updated_at = CASE
             WHEN kalshi_positions.updated_at < NOW() - INTERVAL '30 seconds'
             THEN NOW()
             ELSE kalshi_positions.updated_at
           END`,
        [
          privyUserId,
          solanaWalletAddress,
          pos.kalshiTicker,
          pos.outcomeMint,
          pos.outcome,
          pos.marketTitle,
          pos.tokenBalance,
          pos.isRedeemable ?? false,
        ]
      );
    }

    // Remove positions that are no longer on-chain AND are older than 30s
    // (don't delete fresh trade inserts that haven't finalized on-chain yet)
    if (onChainMints.size > 0) {
      await client.query(
        `DELETE FROM kalshi_positions
         WHERE privy_user_id = $1
           AND outcome_mint != ALL($2::text[])
           AND updated_at < NOW() - INTERVAL '30 seconds'`,
        [privyUserId, Array.from(onChainMints)]
      );
    }
    // Don't clear all positions when on-chain returns empty — could just be RPC lag
  } finally {
    client.release();
  }
}
