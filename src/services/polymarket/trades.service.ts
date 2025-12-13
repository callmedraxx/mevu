/**
 * Trades Service
 * Fetches trades from Polymarket data API and stores them in database
 */

import axios from 'axios';
import { logger } from '../../config/logger';
import { pool } from '../../config/database';
import { LiveGame, getLiveGameById, getLiveGameBySlug } from './live-games.service';
import { TransformedMarket } from './polymarket.types';
import { PolymarketTrade, StoredTrade } from './trades.types';

const DATA_API_BASE_URL = 'https://data-api.polymarket.com';

/**
 * Extract all market conditionIds from a game
 * Similar to holders.service.ts extractAllMarketConditionIds()
 */
export function extractAllMarketConditionIds(game: LiveGame): string[] {
  if (!game.markets || game.markets.length === 0) {
    return [];
  }

  const conditionIds: string[] = [];

  for (const market of game.markets) {
    if (market.conditionId) {
      conditionIds.push(market.conditionId);
    }
  }

  return conditionIds;
}

/**
 * Fetch trades from Polymarket data API
 * Builds query string with multiple market parameters (similar to holders service)
 */
export async function fetchTradesFromPolymarket(conditionIds: string[]): Promise<PolymarketTrade[]> {
  if (conditionIds.length === 0) {
    return [];
  }

  try {
    const url = `${DATA_API_BASE_URL}/trades`;
    const allTrades: PolymarketTrade[] = [];
    const maxLimit = 500; // Polymarket API maximum limit per request
    const maxOffset = 1000; // Polymarket API maximum offset
    let offset = 0;
    let hasMore = true;

    // Build base query params with multiple market parameters
    const baseSearchParams = new URLSearchParams();
    baseSearchParams.append('limit', String(maxLimit));
    baseSearchParams.append('takerOnly', 'false');
    for (const conditionId of conditionIds) {
      baseSearchParams.append('market', conditionId);
    }

    // Fetch trades with pagination (max 500 per request, max offset 1000)
    // This allows us to fetch up to 1500 trades (500 + 500 + 500)
    while (hasMore && offset <= maxOffset) {
      const searchParams = new URLSearchParams(baseSearchParams);
      if (offset > 0) {
        searchParams.append('offset', String(offset));
      }

      const fullUrl = `${url}?${searchParams.toString()}`;

      logger.info({
        message: 'Fetching trades from Polymarket data API',
        conditionIdsCount: conditionIds.length,
        offset,
        url: fullUrl,
      });

      const response = await axios.get<PolymarketTrade[]>(fullUrl, {
        timeout: 30000,
        headers: {
          'Accept': 'application/json',
        },
      });

      const trades = response.data || [];
      
      if (trades.length === 0) {
        hasMore = false;
      } else {
        allTrades.push(...trades);
        
        // If we got fewer than maxLimit, we've reached the end
        if (trades.length < maxLimit) {
          hasMore = false;
        } else {
          // Continue to next page
          offset += maxLimit;
          // Stop if we've reached max offset
          if (offset > maxOffset) {
            hasMore = false;
          }
        }
      }
    }

    logger.info({
      message: 'Trades fetched successfully',
      conditionIdsCount: conditionIds.length,
      totalCount: allTrades.length,
      pagesFetched: Math.ceil(offset / maxLimit) || 1,
    });

    return allTrades;
  } catch (error) {
    logger.error({
      message: 'Error fetching trades from Polymarket',
      conditionIdsCount: conditionIds.length,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Store trades in database
 * Uses ON CONFLICT to deduplicate by transaction_hash
 */
export async function storeTrades(trades: PolymarketTrade[], gameId: string): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    logger.warn({
      message: 'storeTrades called in development mode - trades not persisted',
      gameId,
      tradeCount: trades.length,
    });
    return;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const insertQuery = `
      INSERT INTO trades (
        proxy_wallet, side, asset, condition_id, size, price, timestamp,
        title, slug, icon, event_slug, outcome, outcome_index,
        name, pseudonym, bio, profile_image, profile_image_optimized,
        transaction_hash, game_id, created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, CURRENT_TIMESTAMP
      )
      ON CONFLICT (transaction_hash) DO NOTHING
    `;

    let insertedCount = 0;
    for (const trade of trades) {
      const result = await client.query(insertQuery, [
        trade.proxyWallet,
        trade.side,
        trade.asset,
        trade.conditionId,
        trade.size,
        trade.price,
        trade.timestamp,
        trade.title,
        trade.slug,
        trade.icon,
        trade.eventSlug,
        trade.outcome,
        trade.outcomeIndex,
        trade.name,
        trade.pseudonym,
        trade.bio,
        trade.profileImage,
        trade.profileImageOptimized,
        trade.transactionHash,
        gameId,
      ]);

      if (result.rowCount && result.rowCount > 0) {
        insertedCount++;
      }
    }

    await client.query('COMMIT');

    logger.info({
      message: 'Trades stored in database',
      gameId,
      totalTrades: trades.length,
      insertedCount,
      skippedCount: trades.length - insertedCount,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({
      message: 'Error storing trades in database',
      gameId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      // Check if it's a table doesn't exist error
      isTableMissing: error instanceof Error && error.message.includes('does not exist'),
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get trades by game ID from database
 */
export async function getTradesByGameId(gameId: string, limit: number = 100): Promise<StoredTrade[]> {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    logger.warn({
      message: 'getTradesByGameId called in development mode - returning empty array',
      gameId,
    });
    return [];
  }

  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT 
        id, proxy_wallet, side, asset, condition_id,
        size, price, timestamp, title, slug, icon, event_slug,
        outcome, outcome_index, name, pseudonym, bio,
        profile_image, profile_image_optimized,
        transaction_hash, game_id, created_at
      FROM trades
      WHERE game_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
      [gameId, limit]
    );

    return result.rows.map(row => ({
      id: row.id,
      proxyWallet: row.proxy_wallet,
      side: row.side,
      asset: row.asset,
      conditionId: row.condition_id,
      size: Number(row.size),
      price: Number(row.price),
      timestamp: Number(row.timestamp),
      title: row.title,
      slug: row.slug,
      icon: row.icon,
      eventSlug: row.event_slug,
      outcome: row.outcome,
      outcomeIndex: row.outcome_index,
      name: row.name,
      pseudonym: row.pseudonym,
      bio: row.bio,
      profileImage: row.profile_image,
      profileImageOptimized: row.profile_image_optimized,
      transactionHash: row.transaction_hash,
      gameId: row.game_id,
      createdAt: new Date(row.created_at),
    }));
  } catch (error) {
    logger.error({
      message: 'Error fetching trades from database',
      gameId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      // Check if it's a table doesn't exist error
      isTableMissing: error instanceof Error && error.message.includes('does not exist'),
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get trades by game slug
 * Looks up game by slug first, then fetches trades
 */
export async function getTradesByGameSlug(slug: string, limit: number = 100): Promise<StoredTrade[]> {
  const game = await getLiveGameBySlug(slug);
  if (!game) {
    logger.warn({
      message: 'Game not found for slug',
      slug,
    });
    return [];
  }

  return getTradesByGameId(game.id, limit);
}

/**
 * Get whale trades by game ID from database
 * Filters trades where amount (size * price) >= 1000
 */
export async function getWhaleTradesByGameId(gameId: string, limit: number = 100): Promise<StoredTrade[]> {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    logger.warn({
      message: 'getWhaleTradesByGameId called in development mode - returning empty array',
      gameId,
    });
    return [];
  }

  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT 
        id, proxy_wallet, side, asset, condition_id,
        size, price, timestamp, title, slug, icon, event_slug,
        outcome, outcome_index, name, pseudonym, bio,
        profile_image, profile_image_optimized,
        transaction_hash, game_id, created_at
      FROM trades
      WHERE game_id = $1 AND (size * price) >= 1000
      ORDER BY created_at DESC
      LIMIT $2`,
      [gameId, limit]
    );

    return result.rows.map(row => ({
      id: row.id,
      proxyWallet: row.proxy_wallet,
      side: row.side,
      asset: row.asset,
      conditionId: row.condition_id,
      size: Number(row.size),
      price: Number(row.price),
      timestamp: Number(row.timestamp),
      title: row.title,
      slug: row.slug,
      icon: row.icon,
      eventSlug: row.event_slug,
      outcome: row.outcome,
      outcomeIndex: row.outcome_index,
      name: row.name,
      pseudonym: row.pseudonym,
      bio: row.bio,
      profileImage: row.profile_image,
      profileImageOptimized: row.profile_image_optimized,
      transactionHash: row.transaction_hash,
      gameId: row.game_id,
      createdAt: new Date(row.created_at),
    }));
  } catch (error) {
    logger.error({
      message: 'Error fetching whale trades from database',
      gameId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      // Check if it's a table doesn't exist error
      isTableMissing: error instanceof Error && error.message.includes('does not exist'),
    });
    throw error;
  } finally {
    client.release();
  }
}
