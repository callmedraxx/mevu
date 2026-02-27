/**
 * Positions Service
 * Handles fetching, storing, and managing user positions from Polymarket
 */

import axios from 'axios';
import { pool } from '../../config/database';
import { logger } from '../../config/logger';
import { getUserByPrivyId } from '../privy/user.service';
import { getAllLiveGamesFromCache } from '../polymarket/live-games.service';
import {
  getTokenPricesForPositions,
  hasTokenPricesInCache,
  setTokenPricesForPositions,
} from '../polymarket/redis-games-cache.service';
import {
  PolymarketPosition,
  UserPosition,
  PositionsQueryParams,
  PortfolioSummary,
} from './positions.types';

const POLYMARKET_DATA_API_URL = 'https://data-api.polymarket.com';

/**
 * Build a price lookup map from our live games data
 * Maps clobTokenId -> { buyPrice, sellPrice }
 *
 * buyPrice = best_ask (what you pay to BUY)
 * sellPrice = best_bid (what you GET when you SELL) - used for position valuation
 *
 * When assetIds is provided and token-prices cache is populated, uses fast HMGET path
 * instead of slow getAllGamesFromCache (avoids ~5–10s delay).
 * Also returns a set of assets from ended games (these should not be enriched)
 */
async function buildPriceLookupFromLiveGames(assetIds?: string[]): Promise<{
  priceMap: Map<string, { buyPrice: number; sellPrice: number }>;
  endedAssets: Set<string>;
}> {
  const priceMap = new Map<string, { buyPrice: number; sellPrice: number }>();
  const endedAssets = new Set<string>();

  // Fast path: use token-prices cache when we have assetIds and cache is warm
  // Only use cache when we get at least one hit — otherwise fall back to full scan
  if (assetIds && assetIds.length > 0) {
    try {
      const cachePopulated = await hasTokenPricesInCache();
      if (cachePopulated) {
        const cached = await getTokenPricesForPositions(assetIds);
        const hits = cached.priceMap.size + cached.endedAssets.size;
        if (hits > 0) {
          logger.debug({
            message: 'Using token-prices cache for position enrichment',
            assetCount: assetIds.length,
            cacheHits: hits,
          });
          return cached;
        }
      }
    } catch (err) {
      logger.warn({
        message: 'Token-prices cache read failed, falling back to full scan',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Full scan: fetch all games and build price map (also populates cache for next time)
  try {
    const games = await getAllLiveGamesFromCache();
    
    for (const game of games) {
      // Use game.markets, fall back to rawData.markets for sports games (tennis, etc.)
      const markets = game.markets && game.markets.length > 0
        ? game.markets
        : ((game.rawData as any)?.markets?.length > 0 ? (game.rawData as any).markets : []);

      if (markets.length === 0) continue;

      // Check if game is ended
      const isEnded = game.ended === true || game.closed === true;

      for (const market of markets) {
        const outcomes = market.structuredOutcomes;
        if (!outcomes) continue;
        
        for (const outcome of outcomes) {
          if (!outcome.clobTokenId) continue;
          
          // Track assets from ended games
          if (isEnded) {
            endedAssets.add(outcome.clobTokenId);
            continue; // Don't add prices for ended games
          }
          
          // Only use prices if we have ACTUAL sellPrice from CLOB (not calculated)
          // This ensures we're using real order book data
          if (outcome.sellPrice === undefined) {
            // No real sellPrice, skip this asset
            continue;
          }
          
          // buyPrice is best_ask (what you'd pay to buy)
          let buyPrice = 0;
          if (outcome.buyPrice !== undefined) {
            buyPrice = (typeof outcome.buyPrice === 'number' ? outcome.buyPrice : parseFloat(String(outcome.buyPrice))) / 100;
          }
          
          // sellPrice is best_bid (what you actually get when selling)
          let sellPrice = (typeof outcome.sellPrice === 'number' ? outcome.sellPrice : parseFloat(String(outcome.sellPrice))) / 100;
          
          if (buyPrice > 0 || sellPrice > 0) {
            priceMap.set(outcome.clobTokenId, {
              buyPrice,
              sellPrice,
            });
          }
        }
      }
    }
    
    logger.debug({
      message: 'Built price lookup map from live games',
      uniqueAssets: priceMap.size,
      endedAssets: endedAssets.size,
    });
  } catch (error) {
    logger.warn({
      message: 'Failed to build price lookup from live games',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { priceMap, endedAssets };
}

/**
 * Enrich PolymarketPosition[] with real-time prices from our live games data
 * This replaces stale curPrice from Polymarket with our CLOB WebSocket prices
 * 
 * For LIVE games: Uses sellPrice (best_bid) for position valuation
 * For ENDED/REDEEMABLE games: Keep Polymarket's curPrice (which reflects final outcome)
 * 
 * @param endedAssets - Set of asset IDs that belong to ended games (don't enrich these)
 */
function enrichPositionsWithLivePrices(
  positions: PolymarketPosition[],
  priceLookup: Map<string, { buyPrice: number; sellPrice: number }>,
  endedAssets: Set<string> = new Set()
): PolymarketPosition[] {
  return positions.map(position => {
    // For redeemable positions OR positions from ended games, keep Polymarket's curPrice
    // Polymarket knows the final/settlement outcome better than our stale CLOB data
    if (position.redeemable || endedAssets.has(position.asset)) {
      // Keep original Polymarket data for ended games
      return position;
    }
    
    const livePrice = priceLookup.get(position.asset);
    
    // Only enrich if we have a valid sellPrice (not just a fallback calculation)
    // Check if this looks like real CLOB data vs calculated fallback
    if (!livePrice || livePrice.sellPrice <= 0) {
      // No valid live sell price available, keep original Polymarket data
      return position;
    }
    
    // For live games: Use sellPrice (best_bid) for position valuation
    // This is what you'd actually GET if you sold now
    const size = position.size;
    const initialValue = position.initialValue;
    const newCurPrice = livePrice.sellPrice; // best_bid - what you get when selling
    const newCurrentValue = size * newCurPrice;
    const newCashPnl = newCurrentValue - initialValue;
    const newPercentPnl = initialValue > 0 ? (newCashPnl / initialValue) * 100 : 0;
    
    return {
      ...position,
      curPrice: newCurPrice,
      currentValue: newCurrentValue,
      cashPnl: newCashPnl,
      percentPnl: newPercentPnl,
    };
  });
}

/**
 * Enrich UserPosition[] (from database) with real-time prices from our live games data
 * Uses buyPrice for position valuation to match frontend display
 */
function enrichUserPositionsWithLivePrices(
  positions: UserPosition[],
  priceLookup: Map<string, { buyPrice: number; sellPrice: number }>
): UserPosition[] {
  let enrichedCount = 0;
  
  const enriched = positions.map(position => {
    const livePrice = priceLookup.get(position.asset);
    
    if (!livePrice || livePrice.buyPrice <= 0) {
      // No live price available, keep original
      return position;
    }
    
    // Calculate new values based on buyPrice (current market price)
    const size = parseFloat(position.size);
    const initialValue = parseFloat(position.initialValue);
    const newCurPrice = livePrice.buyPrice;
    const newCurrentValue = size * newCurPrice;
    const newCashPnl = newCurrentValue - initialValue;
    const newPercentPnl = initialValue > 0 ? (newCashPnl / initialValue) * 100 : 0;
    
    const originalCurPrice = parseFloat(position.curPrice);
    if (Math.abs(originalCurPrice - newCurPrice) > 0.001) {
      enrichedCount++;
    }
    
    return {
      ...position,
      curPrice: newCurPrice.toFixed(6),
      currentValue: newCurrentValue.toFixed(6),
      cashPnl: newCashPnl.toFixed(6),
      percentPnl: newPercentPnl.toFixed(4),
    };
  });
  
  if (enrichedCount > 0) {
    logger.info({
      message: 'Enriched positions with live buyPrice',
      totalPositions: positions.length,
      updatedWithLivePrices: enrichedCount,
    });
  }
  
  return enriched;
}

/**
 * Fetch positions from Polymarket Data API
 */
async function fetchPositionsFromPolymarket(
  proxyWalletAddress: string,
  params: PositionsQueryParams = {}
): Promise<PolymarketPosition[]> {
  const {
    limit = 100,
    offset = 0,
    sortBy = 'TOKENS',
    sortDirection = 'DESC',
  } = params;

  const url = `${POLYMARKET_DATA_API_URL}/positions`;
  const queryParams = new URLSearchParams({
    user: proxyWalletAddress,
    sizeThreshold: '1', // Only positions with size >= 1
    limit: String(limit),
    offset: String(offset),
    sortBy,
    sortDirection,
  });

  try {
    logger.info({
      message: 'Fetching positions from Polymarket',
      proxyWalletAddress,
      limit,
      offset,
    });

    const response = await axios.get(`${url}?${queryParams.toString()}`, {
      timeout: 30000, // 30 second timeout
      headers: {
        'Accept': 'application/json',
      },
    });

    const positions: PolymarketPosition[] = response.data || [];
    
    logger.info({
      message: 'Fetched positions from Polymarket',
      proxyWalletAddress,
      positionCount: positions.length,
    });

    return positions;
  } catch (error) {
    logger.error({
      message: 'Error fetching positions from Polymarket',
      proxyWalletAddress,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Upsert positions to database
 */
async function upsertPositions(
  privyUserId: string,
  proxyWalletAddress: string,
  positions: PolymarketPosition[]
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const position of positions) {
      await client.query(
        `INSERT INTO user_positions (
          privy_user_id,
          proxy_wallet_address,
          asset,
          condition_id,
          size,
          avg_price,
          initial_value,
          current_value,
          cash_pnl,
          percent_pnl,
          cur_price,
          redeemable,
          mergeable,
          negative_risk,
          title,
          slug,
          event_id,
          event_slug,
          outcome,
          outcome_index,
          opposite_outcome,
          opposite_asset,
          end_date,
          total_bought,
          realized_pnl,
          percent_realized_pnl,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, CURRENT_TIMESTAMP
        )
        ON CONFLICT (privy_user_id, asset)
        DO UPDATE SET
          proxy_wallet_address = EXCLUDED.proxy_wallet_address,
          condition_id = EXCLUDED.condition_id,
          size = EXCLUDED.size,
          avg_price = EXCLUDED.avg_price,
          initial_value = EXCLUDED.initial_value,
          current_value = EXCLUDED.current_value,
          cash_pnl = EXCLUDED.cash_pnl,
          percent_pnl = EXCLUDED.percent_pnl,
          cur_price = EXCLUDED.cur_price,
          redeemable = EXCLUDED.redeemable,
          mergeable = EXCLUDED.mergeable,
          negative_risk = EXCLUDED.negative_risk,
          title = EXCLUDED.title,
          slug = EXCLUDED.slug,
          event_id = EXCLUDED.event_id,
          event_slug = EXCLUDED.event_slug,
          outcome = EXCLUDED.outcome,
          outcome_index = EXCLUDED.outcome_index,
          opposite_outcome = EXCLUDED.opposite_outcome,
          opposite_asset = EXCLUDED.opposite_asset,
          end_date = EXCLUDED.end_date,
          total_bought = EXCLUDED.total_bought,
          realized_pnl = EXCLUDED.realized_pnl,
          percent_realized_pnl = EXCLUDED.percent_realized_pnl,
          updated_at = CURRENT_TIMESTAMP`,
        [
          privyUserId,
          proxyWalletAddress,
          position.asset,
          position.conditionId,
          position.size,
          position.avgPrice,
          position.initialValue,
          position.currentValue,
          position.cashPnl,
          position.percentPnl,
          position.curPrice,
          position.redeemable,
          position.mergeable,
          position.negativeRisk,
          position.title,
          position.slug,
          position.eventId,
          position.eventSlug,
          position.outcome,
          position.outcomeIndex,
          position.oppositeOutcome,
          position.oppositeAsset,
          position.endDate ? new Date(position.endDate).toISOString().split('T')[0] : null,
          position.totalBought,
          position.realizedPnl,
          position.percentRealizedPnl,
        ]
      );
    }

    // Remove positions that are no longer in Polymarket (not in the fetched list)
    const assetIds = positions.map(p => p.asset);
    if (assetIds.length > 0) {
      await client.query(
        `DELETE FROM user_positions 
         WHERE privy_user_id = $1 AND asset != ALL($2::text[])`,
        [privyUserId, assetIds]
      );
    } else {
      // If no positions returned, delete all for this user
      await client.query(
        `DELETE FROM user_positions WHERE privy_user_id = $1`,
        [privyUserId]
      );
    }

    await client.query('COMMIT');

    logger.info({
      message: 'Upserted positions to database',
      privyUserId,
      positionCount: positions.length,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({
      message: 'Error upserting positions',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get positions from database
 */
async function getPositionsFromDatabase(privyUserId: string): Promise<UserPosition[]> {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT * FROM user_positions 
       WHERE privy_user_id = $1 
       ORDER BY updated_at DESC`,
      [privyUserId]
    );

    return result.rows.map(row => ({
      id: row.id,
      privyUserId: row.privy_user_id,
      proxyWalletAddress: row.proxy_wallet_address,
      asset: row.asset,
      conditionId: row.condition_id,
      size: String(row.size),
      avgPrice: String(row.avg_price),
      initialValue: String(row.initial_value),
      currentValue: String(row.current_value),
      cashPnl: String(row.cash_pnl),
      percentPnl: String(row.percent_pnl),
      curPrice: String(row.cur_price),
      redeemable: row.redeemable,
      mergeable: row.mergeable,
      negativeRisk: row.negative_risk,
      title: row.title,
      slug: row.slug,
      eventId: row.event_id,
      eventSlug: row.event_slug,
      outcome: row.outcome,
      outcomeIndex: row.outcome_index,
      oppositeOutcome: row.opposite_outcome,
      oppositeAsset: row.opposite_asset,
      endDate: row.end_date,
      totalBought: row.total_bought ? String(row.total_bought) : null,
      realizedPnl: row.realized_pnl ? String(row.realized_pnl) : null,
      percentRealizedPnl: row.percent_realized_pnl ? String(row.percent_realized_pnl) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } finally {
    client.release();
  }
}

/**
 * Calculate portfolio value from positions
 */
async function calculatePortfolio(privyUserId: string): Promise<number> {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT COALESCE(SUM(current_value), 0) as portfolio
       FROM user_positions
       WHERE privy_user_id = $1`,
      [privyUserId]
    );

    const portfolio = parseFloat(result.rows[0]?.portfolio || '0');
    return portfolio;
  } finally {
    client.release();
  }
}

/**
 * Update user portfolio in users table
 */
async function updateUserPortfolio(privyUserId: string, portfolio: number): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query(
      `UPDATE users 
       SET portfolio = $1, updated_at = CURRENT_TIMESTAMP
       WHERE privy_user_id = $2`,
      [portfolio, privyUserId]
    );

    logger.debug({
      message: 'Updated user portfolio',
      privyUserId,
      portfolio,
    });
  } finally {
    client.release();
  }
}

/**
 * Fetch and store positions for a user
 * Always fetches fresh data from Polymarket for real-time accuracy
 */
export async function fetchAndStorePositions(
  privyUserId: string,
  params: PositionsQueryParams = {}
): Promise<UserPosition[]> {
  // Get user to verify they exist and get proxy wallet
  const user = await getUserByPrivyId(privyUserId);
  if (!user) {
    throw new Error('User not found');
  }

  if (!user.proxyWalletAddress) {
    logger.warn({
      message: 'User does not have proxy wallet address',
      privyUserId,
    });
    return [];
  }

  // Always fetch fresh positions from Polymarket (no caching)
  const polymarketPositions = await fetchPositionsFromPolymarket(
    user.proxyWalletAddress,
    params
  );

  let enrichedPositions: PolymarketPosition[];

  if (polymarketPositions.length === 0) {
    // No positions — skip expensive price lookup (Redis hgetall + DB query).
    // Avoids ~5–10s delay when user has no positions.
    enrichedPositions = [];
  } else {
    // Enrich positions with real-time prices from sports only.
    // Crypto positions: frontend uses WebSocket for live prices — skip backend enrichment to speed up response.
    const assetIds = polymarketPositions.map((p) => p.asset);
    const sportsLookup = await buildPriceLookupFromLiveGames(assetIds);

    const priceMap = sportsLookup.priceMap;
    const endedAssets = sportsLookup.endedAssets;

    enrichedPositions = enrichPositionsWithLivePrices(polymarketPositions, priceMap, endedAssets);

    // Populate token-prices cache with merged sports+crypto so subsequent requests use fast path
    const cacheUpdates = new Array<{ clobTokenId: string; buyPrice: number; sellPrice: number; isEnded: boolean }>();
    for (const [clobTokenId, { buyPrice, sellPrice }] of priceMap) {
      cacheUpdates.push({ clobTokenId, buyPrice: buyPrice * 100, sellPrice: sellPrice * 100, isEnded: false });
    }
    for (const clobTokenId of endedAssets) {
      if (!priceMap.has(clobTokenId)) {
        cacheUpdates.push({ clobTokenId, buyPrice: 0, sellPrice: 0, isEnded: true });
      }
    }
    if (cacheUpdates.length > 0) {
      setTokenPricesForPositions(cacheUpdates).catch((err) =>
        logger.warn({ message: 'Failed to populate token-prices cache', error: err instanceof Error ? err.message : String(err) })
      );
    }

    // Log enrichment stats
    const enrichedCount = enrichedPositions.filter((p, i) =>
      p.curPrice !== polymarketPositions[i].curPrice
    ).length;
    if (enrichedCount > 0) {
      logger.info({
        message: 'Enriched positions with live prices (sports only, crypto uses WebSocket)',
        privyUserId,
        totalPositions: enrichedPositions.length,
        enrichedWithLivePrices: enrichedCount,
      });
    }
  }

  // Store enriched positions in database
  await upsertPositions(privyUserId, user.proxyWalletAddress, enrichedPositions);

  // Calculate and update portfolio (now based on live prices)
  const portfolio = await calculatePortfolio(privyUserId);
  await updateUserPortfolio(privyUserId, portfolio);

  // Return positions from database
  return await getPositionsFromDatabase(privyUserId);
}

/**
 * Get positions from database (without fetching from Polymarket)
 */
export async function getPositions(privyUserId: string): Promise<UserPosition[]> {
  return await getPositionsFromDatabase(privyUserId);
}

/**
 * Get portfolio summary
 */
export async function getPortfolioSummary(privyUserId: string): Promise<PortfolioSummary> {
  const positions = await getPositionsFromDatabase(privyUserId);
  const portfolio = await calculatePortfolio(privyUserId);

  const totalPnl = positions.reduce((sum, p) => sum + parseFloat(p.cashPnl), 0);
  const totalInitialValue = positions.reduce((sum, p) => sum + parseFloat(p.initialValue), 0);
  const totalPercentPnl = totalInitialValue > 0 ? (totalPnl / totalInitialValue) * 100 : 0;

  return {
    portfolio,
    totalPositions: positions.length,
    totalPnl,
    totalPercentPnl,
    positions,
  };
}

/**
 * Refresh positions and portfolio (public API).
 * Publishes to Redis when done so portfolio SSE streams on all workers receive the update.
 */
export async function refreshPositions(
  privyUserId: string,
  params: PositionsQueryParams = {}
): Promise<PortfolioSummary> {
  await fetchAndStorePositions(privyUserId, params);
  const summary = await getPortfolioSummary(privyUserId);
  // Publish so SSE connections on other workers (e.g. the one with user's stream) receive the update
  try {
    const { isRedisClusterBroadcastReady, publishPortfolioUpdate } = await import('../redis-cluster-broadcast.service');
    if (isRedisClusterBroadcastReady()) {
      publishPortfolioUpdate(privyUserId, summary.portfolio);
    }
  } catch (err) {
    logger.warn({
      message: 'Failed to publish portfolio update to Redis',
      privyUserId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return summary;
}
