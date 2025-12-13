/**
 * Whale Watcher Routes
 * Endpoints for fetching and displaying whale trades (amount >= $1000) for games
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { getLiveGameById, getLiveGameBySlug } from '../services/polymarket/live-games.service';
import {
  extractAllMarketConditionIds,
  fetchTradesFromPolymarket,
  storeTrades,
  getWhaleTradesByGameId,
} from '../services/polymarket/trades.service';
import { transformWhaleTrades } from '../services/polymarket/whale-trades.transformer';
import { StoredTrade } from '../services/polymarket/trades.types';

const router = Router();

/**
 * @swagger
 * /api/whale-watcher/{gameIdentifier}:
 *   get:
 *     summary: Get whale trades for a game by ID or slug
 *     description: Fetches trades with amount >= $1000 from the database. If no trades exist for the game, triggers the trades service to fetch and store trades, then returns filtered whale trades.
 *     tags: [WhaleWatcher]
 *     parameters:
 *       - in: path
 *         name: gameIdentifier
 *         required: true
 *         schema:
 *           type: string
 *         description: Game ID or slug
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of whale trades to return
 *     responses:
 *       200:
 *         description: List of whale trades
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: integer
 *                 trades:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/WhaleTrade'
 *       404:
 *         description: Game not found
 *       500:
 *         description: Failed to fetch whale trades
 */
router.get('/:gameIdentifier', async (req: Request, res: Response) => {
  try {
    const { gameIdentifier } = req.params;
    const limit = parseInt(req.query.limit as string, 10) || 100;

    // Try to find game by ID first, then by slug
    let game = await getLiveGameById(gameIdentifier);
    if (!game) {
      game = await getLiveGameBySlug(gameIdentifier);
    }

    if (!game) {
      return res.status(404).json({
        success: false,
        error: 'Game not found',
      });
    }

    // Check if whale trades exist in database (check with limit 1)
    let whaleTrades: StoredTrade[];
    try {
      whaleTrades = await getWhaleTradesByGameId(game.id, 1);
    } catch (dbError) {
      // If table doesn't exist, provide helpful error message
      const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
      if (errorMessage.includes('does not exist') || (errorMessage.includes('relation') && errorMessage.includes('trades'))) {
        logger.error({
          message: 'Trades table does not exist - migration needs to be run',
          gameId: game.id,
        });
        return res.status(500).json({
          success: false,
          error: 'Database table not found. Please run migration 004_create_trades_table.sql',
        });
      }
      // Re-throw other database errors
      throw dbError;
    }

    // If no whale trades exist, trigger population by fetching and storing trades
    if (whaleTrades.length === 0) {
      logger.info({
        message: 'No whale trades found, triggering trade population',
        gameId: game.id,
        gameSlug: game.slug,
      });

      // Extract all market conditionIds from the game
      const conditionIds = extractAllMarketConditionIds(game);
      if (conditionIds.length === 0) {
        logger.warn({
          message: 'No markets found for game',
          gameId: game.id,
          gameSlug: game.slug,
        });
        return res.status(404).json({
          success: false,
          error: 'No markets found for this game',
        });
      }

      // Fetch trades from Polymarket API for all markets
      const trades = await fetchTradesFromPolymarket(conditionIds);

      // Store trades in database (deduplication handled by unique constraint)
      if (trades.length > 0) {
        try {
          await storeTrades(trades, game.id);
          logger.info({
            message: 'Trades stored, fetching whale trades',
            gameId: game.id,
            tradesStored: trades.length,
          });
        } catch (storeError) {
          logger.warn({
            message: 'Failed to store trades',
            gameId: game.id,
            error: storeError instanceof Error ? storeError.message : String(storeError),
          });
          // Continue - we'll try to get existing trades from DB
        }
      }
    }

    // Fetch whale trades from database (ordered by created_at DESC)
    try {
      whaleTrades = await getWhaleTradesByGameId(game.id, limit);
    } catch (dbError) {
      const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
      if (errorMessage.includes('does not exist') || (errorMessage.includes('relation') && errorMessage.includes('trades'))) {
        logger.error({
          message: 'Trades table does not exist - migration needs to be run',
          gameId: game.id,
        });
        return res.status(500).json({
          success: false,
          error: 'Database table not found. Please run migration 004_create_trades_table.sql',
        });
      }
      throw dbError;
    }

    // Transform whale trades to frontend format
    const transformedTrades = await transformWhaleTrades(whaleTrades, game);

    res.json({
      success: true,
      count: transformedTrades.length,
      trades: transformedTrades,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching whale trades',
      gameIdentifier: req.params.gameIdentifier,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch whale trades',
      details: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.message : String(error)) : undefined,
    });
  }
});

export default router;
