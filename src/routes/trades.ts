/**
 * Trades Routes
 * Endpoints for fetching and displaying live trades for games
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { getLiveGameById, getLiveGameBySlug } from '../services/polymarket/live-games.service';
import {
  extractAllMarketConditionIds,
  fetchTradesFromPolymarket,
  storeTrades,
  getTradesByGameId,
} from '../services/polymarket/trades.service';
import { transformTrades } from '../services/polymarket/trades.transformer';
import { StoredTrade } from '../services/polymarket/trades.types';

const router = Router();

/**
 * @swagger
 * /api/trades/{gameIdentifier}:
 *   get:
 *     summary: Get trades for a game by ID or slug
 *     description: Fetches trades from Polymarket API for all markets in the game, stores them in database, and returns transformed trade data. Fetches up to 500 trades from Polymarket API.
 *     tags: [Trades]
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
 *         description: Maximum number of trades to return
 *     responses:
 *       200:
 *         description: List of transformed trades
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
 *                     type: object
 *                     properties:
 *                       type:
 *                         type: string
 *                         enum: [Buy, Sell]
 *                       amount:
 *                         type: number
 *                       shares:
 *                         type: number
 *                       price:
 *                         type: number
 *                         description: Price multiplied by 100
 *                       trader:
 *                         type: string
 *                       traderAvatar:
 *                         type: string
 *                       outcome:
 *                         type: string
 *                       awayTeam:
 *                         type: object
 *                       homeTeam:
 *                         type: object
 *                       time:
 *                         type: string
 *       404:
 *         description: Game not found
 *       500:
 *         description: Failed to fetch trades
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
    // If storing fails, we'll still try to return existing trades
    if (trades.length > 0) {
      try {
        await storeTrades(trades, game.id);
      } catch (storeError) {
        logger.warn({
          message: 'Failed to store trades, continuing with existing trades',
          gameId: game.id,
          error: storeError instanceof Error ? storeError.message : String(storeError),
        });
        // Continue - we'll try to get existing trades from DB
      }
    }

    // Get stored trades from database (ordered by created_at DESC)
    let storedTrades: StoredTrade[];
    try {
      storedTrades = await getTradesByGameId(game.id, limit);
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

    // Transform trades to frontend format
    const transformedTrades = await transformTrades(storedTrades, game);

    res.json({
      success: true,
      count: transformedTrades.length,
      trades: transformedTrades,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching trades',
      gameIdentifier: req.params.gameIdentifier,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch trades',
      details: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.message : String(error)) : undefined,
    });
  }
});

export default router;
