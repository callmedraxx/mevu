/**
 * Ocean Trades Service
 * Aggregates whale trades from all live games for the Ocean page
 * Optimized for fast queries with pagination
 */

import { logger } from '../../config/logger';
import { pool } from '../../config/database';
import { getAllLiveGames, filterOutEndedLiveGames, getLiveGameById, LiveGame } from './live-games.service';
import {
  extractAllMarketConditionIds,
  fetchTradesFromPolymarket,
  storeTrades,
} from './trades.service';
import { StoredTrade } from './trades.types';
import { transformWhaleTrade } from './whale-trades.transformer';
import { WhaleTrade } from './whale-trades.types';

export interface OceanTradesOptions {
  minAmount?: number;  // Minimum trade amount (default: 1000)
  limit?: number;      // Number of trades per page (default: 50)
  offset?: number;     // Pagination offset (default: 0)
  sport?: string;      // Filter by sport (optional)
  type?: 'buy' | 'sell' | 'all';  // Filter by trade type (optional, default: 'all')
}

export interface OceanTradesResult {
  trades: WhaleTrade[];
  total: number;
  hasMore: boolean;
}

/**
 * Get ocean trades for all live games
 * Single optimized query to fetch whale trades across all live games
 */
export async function getOceanTrades(options: OceanTradesOptions = {}): Promise<OceanTradesResult> {
  const {
    minAmount = 1000,
    limit = 50,
    offset = 0,
    sport,
    type = 'all',
  } = options;

  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    logger.warn({
      message: 'getOceanTrades called in development mode - returning empty array',
    });
    return {
      trades: [],
      total: 0,
      hasMore: false,
    };
  }

  // Get all live games
  let liveGames = await getAllLiveGames();
  liveGames = filterOutEndedLiveGames(liveGames);

  // Filter by sport if specified
  if (sport && sport !== 'all') {
    liveGames = liveGames.filter(
      (game) => game.sport?.toLowerCase() === sport.toLowerCase() || 
                game.league?.toLowerCase() === sport.toLowerCase()
    );
  }

  if (liveGames.length === 0) {
    return {
      trades: [],
      total: 0,
      hasMore: false,
    };
  }

  const gameIds = liveGames.map((game) => game.id);

  // Create a map of gameId -> LiveGame for quick lookups
  const gameMap = new Map<string, LiveGame>();
  for (const game of liveGames) {
    gameMap.set(game.id, game);
  }

  const client = await pool.connect();

  try {
    // Check if any trades exist for these games
    const checkResult = await client.query(
      `SELECT COUNT(*) as count 
       FROM trades 
       WHERE game_id = ANY($1::text[]) AND (size * price) >= $2
       LIMIT 1`,
      [gameIds, minAmount]
    );

    const tradeCount = parseInt(checkResult.rows[0]?.count || '0', 10);

    // If no trades found, trigger on-demand fetching (non-blocking)
    if (tradeCount === 0) {
      // Trigger async fetch for games without trades (don't wait)
      fetchTradesForLiveGames(liveGames).catch((error) => {
        logger.error({
          message: 'Error fetching trades for live games in background',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // Build base WHERE clause
    let whereClause = `WHERE game_id = ANY($1::text[]) AND (size * price) >= $2`;
    const queryParams: any[] = [gameIds, minAmount];
    let paramIndex = 3;

    // Add type filter if specified
    if (type !== 'all') {
      whereClause += ` AND side = $${paramIndex}`;
      queryParams.push(type === 'buy' ? 'BUY' : 'SELL');
      paramIndex++;
    }

    // Get total count for hasMore calculation
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM trades 
      ${whereClause}
    `;
    const countResult = await client.query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0]?.total || '0', 10);

    // Build main query with pagination
    const query = `
      SELECT 
        id, proxy_wallet, side, asset, condition_id,
        size, price, timestamp, title, slug, icon, event_slug,
        outcome, outcome_index, name, pseudonym, bio,
        profile_image, profile_image_optimized,
        transaction_hash, game_id, created_at
      FROM trades
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    queryParams.push(limit, offset);

    // Execute main query
    const result = await client.query(query, queryParams);

    const storedTrades: StoredTrade[] = result.rows.map((row) => ({
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

    // Transform trades using game information (in parallel for performance)
    const transformPromises = storedTrades.map(async (trade) => {
      const game = gameMap.get(trade.gameId);
      if (!game) {
        logger.warn({
          message: 'Game not found for trade',
          tradeId: trade.id,
          gameId: trade.gameId,
        });
        return null;
      }

      try {
        const transformed = await transformWhaleTrade(trade, game);
        // Add game slug for frontend navigation
        (transformed as any).gameSlug = game.slug;
        (transformed as any).sport = game.sport || game.league || 'nba';
        return transformed;
      } catch (error) {
        logger.warn({
          message: 'Error transforming trade, skipping',
          tradeId: trade.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    });

    const transformedResults = await Promise.all(transformPromises);
    const transformedTrades: WhaleTrade[] = transformedResults.filter((t): t is WhaleTrade => t !== null);

    const hasMore = offset + transformedTrades.length < total;

    return {
      trades: transformedTrades,
      total,
      hasMore,
    };
  } catch (error) {
    logger.error({
      message: 'Error fetching ocean trades',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Fetch trades for live games that don't have trades yet (on-demand)
 * This runs asynchronously in the background
 */
async function fetchTradesForLiveGames(games: LiveGame[]): Promise<void> {
  const batchSize = 5; // Process games in batches to avoid overwhelming the API

  for (let i = 0; i < games.length; i += batchSize) {
    const batch = games.slice(i, i + batchSize);
    
    await Promise.all(
      batch.map(async (game) => {
        try {
          // Check if trades already exist
          const client = await pool.connect();
          try {
            const checkResult = await client.query(
              'SELECT COUNT(*) as count FROM trades WHERE game_id = $1 LIMIT 1',
              [game.id]
            );
            const count = parseInt(checkResult.rows[0]?.count || '0', 10);
            
            if (count > 0) {
              // Trades already exist, skip
              return;
            }
          } finally {
            client.release();
          }

          // Extract condition IDs and fetch trades
          const conditionIds = extractAllMarketConditionIds(game);
          if (conditionIds.length === 0) {
            return;
          }

          const trades = await fetchTradesFromPolymarket(conditionIds);
          if (trades.length > 0) {
            await storeTrades(trades, game.id);
            logger.debug({
              message: 'Fetched and stored trades for game',
              gameId: game.id,
              gameSlug: game.slug,
              tradesCount: trades.length,
            });
          }
        } catch (error) {
          logger.warn({
            message: 'Error fetching trades for game',
            gameId: game.id,
            error: error instanceof Error ? error.message : String(error),
          });
          // Continue with other games
        }
      })
    );
  }
}

