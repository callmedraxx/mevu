/**
 * Unified Trade History Service
 * Merges Polymarket and Kalshi trade history for the activity/history tab.
 * Each trade includes a platform label ('polymarket' | 'kalshi').
 */

import { pool, getDatabaseConfig } from '../../config/database';
import { getTradeHistory } from '../polymarket/trading/trades-history.service';
import { TradeHistoryQuery } from '../polymarket/trading/trading.types';
import { dflowMetadataService } from '../dflow/dflow-metadata.service';

export type UnifiedTradePlatform = 'polymarket' | 'kalshi';

export interface UnifiedTrade {
  id: string;
  platform: UnifiedTradePlatform;
  side: string;
  outcome: string;
  size: string;
  price: string;
  costUsdc: string;
  /** Polymarket: marketQuestion. Kalshi: marketTitle. */
  marketQuestion?: string;
  /** Kalshi: kalshiTicker */
  kalshiTicker?: string;
  /** Polymarket: transactionHash. Kalshi: solanaSignature */
  transactionHash?: string;
  solanaSignature?: string;
  status: string;
  createdAt: string;
  /** Polymarket: clobTokenId. Kalshi: outcomeMint */
  asset?: string;
  outcomeMint?: string;
  /** Kalshi: raw input/output amounts (6 decimals) */
  inputAmount?: string;
  outputAmount?: string;
  /** Polymarket: requested size when PARTIALLY_FILLED (e.g. "72.65" for "41 of 72.65 filled") */
  requestedSize?: string;
}

export interface UnifiedTradeHistoryQuery {
  privyUserId: string;
  limit?: number;
  offset?: number;
  side?: string;
  platform?: 'all' | 'polymarket' | 'kalshi';
  status?: string;
}

/**
 * Fetch Kalshi trade history for a user, with optional market title enrichment.
 */
async function getKalshiTradeHistory(
  privyUserId: string,
  limit: number,
  offset: number,
  side?: string
): Promise<UnifiedTrade[]> {
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return [];

  const client = await pool.connect();
  try {
    const conditions: string[] = ['privy_user_id = $1', "status = 'FILLED'"];
    const values: any[] = [privyUserId];
    let paramIndex = 2;

    if (side) {
      conditions.push(`side = $${paramIndex++}`);
      values.push(side.toUpperCase());
    }

    values.push(limit, offset);

    const r = await client.query(
      `SELECT id, kalshi_ticker, outcome_mint, outcome, side, input_amount, output_amount,
              price_per_token, market_title, solana_signature, status, created_at
       FROM kalshi_trades_history
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      values
    );

    const trades: UnifiedTrade[] = [];
    for (const row of r.rows) {
      const input = row.input_amount || '0';
      const output = row.output_amount || '0';
      // Price in 0-1 format (USDC per share) so frontend displays (price*100)¢
      // Prefer stored price_per_token (effective execution price). Fallback: BUY = input/output, SELL = output/input.
      let priceNum = row.price_per_token != null ? parseFloat(String(row.price_per_token)) : 0;
      if (priceNum <= 0 && parseFloat(input) > 0 && parseFloat(output) > 0) {
        priceNum = row.side === 'BUY'
          ? (parseFloat(input) / 1e6) / (parseFloat(output) / 1e6)
          : (parseFloat(output) / 1e6) / (parseFloat(input) / 1e6);
      }
      const costUsdc = row.side === 'BUY'
        ? (parseFloat(input) / 1e6).toFixed(2)
        : (parseFloat(output) / 1e6).toFixed(2);
      const size = row.side === 'BUY'
        ? (parseFloat(output) / 1e6).toFixed(2)
        : (parseFloat(input) / 1e6).toFixed(2);

      let marketTitle = row.market_title;
      if (!marketTitle && row.outcome_mint) {
        const market = await dflowMetadataService.getMarketByMint(row.outcome_mint);
        marketTitle = market?.title ?? row.kalshi_ticker;
      }

      trades.push({
        id: row.id,
        platform: 'kalshi',
        side: row.side,
        outcome: row.outcome || '',
        size,
        price: priceNum.toFixed(4),
        costUsdc,
        marketQuestion: marketTitle || row.kalshi_ticker,
        kalshiTicker: row.kalshi_ticker,
        solanaSignature: row.solana_signature,
        transactionHash: row.solana_signature,
        status: row.status || 'FILLED',
        createdAt: new Date(row.created_at).toISOString(),
        outcomeMint: row.outcome_mint,
        inputAmount: row.input_amount,
        outputAmount: row.output_amount,
      });
    }
    return trades;
  } finally {
    client.release();
  }
}

/**
 * Transform Polymarket TradeRecord to UnifiedTrade.
 */
function toUnifiedTrade(row: {
  id: string;
  side: string;
  outcome: string;
  size: string;
  price: string;
  costUsdc: string;
  marketQuestion?: string;
  transactionHash?: string;
  status: string;
  createdAt: Date;
  clobTokenId: string;
  metadata?: Record<string, any>;
}): UnifiedTrade {
  const requestedSize = row.metadata?.requestedSize;
  return {
    id: row.id,
    platform: 'polymarket',
    side: row.side,
    outcome: row.outcome,
    size: String(row.size),
    price: String(row.price),
    costUsdc: String(row.costUsdc),
    marketQuestion: row.marketQuestion,
    transactionHash: row.transactionHash,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    asset: row.clobTokenId,
    ...(requestedSize && { requestedSize }),
  };
}

/**
 * Get unified trade history (Polymarket + Kalshi) with platform labels.
 * Sorted by createdAt descending.
 */
export async function getUnifiedTradeHistory(
  query: UnifiedTradeHistoryQuery
): Promise<UnifiedTrade[]> {
  const limit = Math.min(query.limit ?? 100, 200);
  const offset = query.offset ?? 0;
  const platform = query.platform ?? 'all';

  const wantsPoly = platform === 'all' || platform === 'polymarket';
  const wantsKalshi = platform === 'all' || platform === 'kalshi';

  // When platform=all, fetch extra from each so merged result has good mix after sort+slice
  const fetchLimit = platform === 'all' ? limit * 2 : limit;

  const [polyTrades, kalshiTrades] = await Promise.all([
    wantsPoly
      ? getTradeHistory({
          privyUserId: query.privyUserId,
          limit: fetchLimit,
          offset: platform === 'all' ? 0 : offset,
          side: query.side as any,
          status: query.status,
        }).then((rows) => rows.map((r) => toUnifiedTrade(r)))
      : Promise.resolve([] as UnifiedTrade[]),
    wantsKalshi
      ? getKalshiTradeHistory(
          query.privyUserId,
          fetchLimit,
          platform === 'all' ? 0 : offset,
          query.side
        )
      : Promise.resolve([] as UnifiedTrade[]),
  ]);

  if (platform !== 'all') {
    return platform === 'polymarket' ? polyTrades : kalshiTrades;
  }

  // Merge and sort by createdAt descending
  const merged = [...polyTrades, ...kalshiTrades].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return merged.slice(0, limit);
}
