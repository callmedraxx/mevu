/**
 * Ocean Routes
 * Endpoints for fetching aggregated whale trades from all live games
 * Optimized for the Ocean page with pagination and filtering
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { getOceanTrades, OceanTradesOptions } from '../services/polymarket/ocean-trades.service';

const router = Router();

/**
 * @swagger
 * /api/ocean/trades:
 *   get:
 *     summary: Get whale trades from all live games
 *     description: |
 *       Aggregates whale trades (amount >= $1000) from all live games.
 *       Supports pagination, filtering by sport and trade type, and configurable minimum amount.
 *       Optimized for fast queries with database indexes.
 *     tags: [Ocean]
 *     parameters:
 *       - in: query
 *         name: minAmount
 *         schema:
 *           type: number
 *           default: 1000
 *         description: Minimum trade amount in USD
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           minimum: 1
 *           maximum: 200
 *         description: Number of trades per page
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *           minimum: 0
 *         description: Pagination offset
 *       - in: query
 *         name: sport
 *         schema:
 *           type: string
 *         description: Filter by sport (e.g., nba, nfl, nhl). Omit or use 'all' for all sports.
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [buy, sell, all]
 *           default: all
 *         description: Filter by trade type
 *     responses:
 *       200:
 *         description: List of whale trades from live games
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 trades:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/WhaleTrade'
 *                 total:
 *                   type: integer
 *                   description: Total number of trades matching the filters
 *                 hasMore:
 *                   type: boolean
 *                   description: Whether there are more trades to load
 *       500:
 *         description: Failed to fetch ocean trades
 */
router.get('/trades', async (req: Request, res: Response) => {
  try {
    const minAmount = req.query.minAmount 
      ? Math.max(0, parseFloat(String(req.query.minAmount))) 
      : 1000;
    const limit = req.query.limit 
      ? Math.min(200, Math.max(1, parseInt(String(req.query.limit), 10))) 
      : 50;
    const offset = req.query.offset 
      ? Math.max(0, parseInt(String(req.query.offset), 10)) 
      : 0;
    const sport = req.query.sport as string | undefined;
    const type = (req.query.type as 'buy' | 'sell' | 'all' | undefined) || 'all';

    const options: OceanTradesOptions = {
      minAmount,
      limit,
      offset,
      sport,
      type,
    };

    const result = await getOceanTrades(options);

    res.json({
      success: true,
      trades: result.trades,
      total: result.total,
      hasMore: result.hasMore,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching ocean trades',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      success: false,
      error: 'Failed to fetch ocean trades',
      details: process.env.NODE_ENV === 'development' 
        ? (error instanceof Error ? error.message : String(error)) 
        : undefined,
    });
  }
});

export default router;

