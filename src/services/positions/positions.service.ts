/**
 * Positions Service
 * Handles fetching, storing, and managing user positions from Polymarket
 */

import axios from 'axios';
import { pool } from '../../config/database';
import { logger } from '../../config/logger';
import { getUserByPrivyId } from '../privy/user.service';
import {
  PolymarketPosition,
  UserPosition,
  PositionsQueryParams,
  PortfolioSummary,
} from './positions.types';

const POLYMARKET_DATA_API_URL = 'https://data-api.polymarket.com';

// Cache to track when positions were last fetched from Polymarket (per user)
// This prevents excessive API calls when frontend polls frequently
const lastFetchTime = new Map<string, number>();
const CACHE_TTL_MS = 100; // 100 milliseconds - only fetch from Polymarket if data is older than this

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
 * Uses caching to prevent excessive Polymarket API calls
 * @param forceRefresh - If true, ignores cache and fetches from Polymarket
 */
export async function fetchAndStorePositions(
  privyUserId: string,
  params: PositionsQueryParams = {},
  forceRefresh: boolean = false
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

  // Check cache - only fetch from Polymarket if data is stale or forceRefresh is true
  const lastFetch = lastFetchTime.get(privyUserId) || 0;
  const now = Date.now();
  const isStale = (now - lastFetch) > CACHE_TTL_MS;

  if (!isStale && !forceRefresh) {
    // Data is fresh, return from database
    logger.debug({
      message: 'Using cached positions (not stale yet)',
      privyUserId,
      cacheAge: now - lastFetch,
      cacheTTL: CACHE_TTL_MS,
    });
    return await getPositionsFromDatabase(privyUserId);
  }

  // Fetch positions from Polymarket
  const polymarketPositions = await fetchPositionsFromPolymarket(
    user.proxyWalletAddress,
    params
  );

  // Update cache timestamp
  lastFetchTime.set(privyUserId, now);

  // Store positions in database
  await upsertPositions(privyUserId, user.proxyWalletAddress, polymarketPositions);

  // Calculate and update portfolio
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
 * Refresh positions and portfolio (public API)
 */
export async function refreshPositions(
  privyUserId: string,
  params: PositionsQueryParams = {}
): Promise<PortfolioSummary> {
  await fetchAndStorePositions(privyUserId, params);
  return await getPortfolioSummary(privyUserId);
}
