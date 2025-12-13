/**
 * Live Stats Routes
 * Endpoints for fetching live game statistics including period scores
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { getLiveGameById, getLiveGameBySlug } from '../services/polymarket/live-games.service';
import { transformToLiveStats } from '../services/polymarket/live-stats.transformer';

const router = Router();

/**
 * @swagger
 * /api/live-stats/{gameIdentifier}:
 *   get:
 *     summary: Get live stats for a game by ID or slug
 *     description: Returns team objects, period scores, and final score for a game. For games with period "NS" (not started), returns empty/null values for period scores and final score.
 *     tags: [LiveStats]
 *     parameters:
 *       - in: path
 *         name: gameIdentifier
 *         required: true
 *         schema:
 *           type: string
 *         description: Game ID or slug
 *     responses:
 *       200:
 *         description: Live stats for the game
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stats:
 *                   $ref: '#/components/schemas/LiveStats'
 *       404:
 *         description: Game not found
 *       500:
 *         description: Failed to fetch live stats
 */
router.get('/:gameIdentifier', async (req: Request, res: Response) => {
  try {
    const { gameIdentifier } = req.params;

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

    // Transform to live stats format
    const stats = await transformToLiveStats(game);

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching live stats',
      gameIdentifier: req.params.gameIdentifier,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch live stats',
      details: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.message : String(error)) : undefined,
    });
  }
});

export default router;
