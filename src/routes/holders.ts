/**
 * Holders Routes
 * Endpoints for fetching and displaying top holders for games
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { getLiveGameBySlug } from '../services/polymarket/live-games.service';
import {
  extractAllMarketConditionIds,
  fetchHoldersFromPolymarket,
  storeHolders,
  getHoldersByGameId,
  aggregateHoldersByWallet,
} from '../services/polymarket/holders.service';
import { transformHolders } from '../services/polymarket/holders.transformer';
import { StoredHolder } from '../services/polymarket/holders.types';

const router = Router();

/**
 * @swagger
 * /api/holders/{slug}:
 *   get:
 *     summary: Get top holders for a game by slug
 *     description: Fetches holders from Polymarket API for all markets in the game, stores them in database, aggregates by wallet, and returns ranked holders
 *     tags: [Holders]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: Game slug
 *     responses:
 *       200:
 *         description: List of transformed holders ranked by total amount
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: integer
 *                 holders:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       rank:
 *                         type: number
 *                       wallet:
 *                         type: string
 *                       totalAmount:
 *                         type: number
 *                       assets:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             assetId:
 *                               type: string
 *                             shortLabel:
 *                               type: string
 *                             amount:
 *                               type: number
 *       404:
 *         description: Game not found or no markets found
 *       500:
 *         description: Failed to fetch holders
 */
router.get('/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;

    // Find game by slug
    const game = await getLiveGameBySlug(slug);

    if (!game) {
      return res.status(404).json({
        success: false,
        error: 'Game not found',
      });
    }

    // Extract all market conditionIds
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

    // Fetch holders from Polymarket API
    const holdersResponse = await fetchHoldersFromPolymarket(conditionIds);

    // Store holders in database
    if (holdersResponse.length > 0) {
      try {
        await storeHolders(holdersResponse, game);
      } catch (storeError) {
        logger.warn({
          message: 'Failed to store holders, continuing with existing holders',
          gameId: game.id,
          error: storeError instanceof Error ? storeError.message : String(storeError),
        });
        // Continue - we'll try to get existing holders from DB
      }
    }

    // Get stored holders from database
    let storedHolders: StoredHolder[];
    try {
      storedHolders = await getHoldersByGameId(game.id);
    } catch (dbError) {
      const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
      if (errorMessage.includes('does not exist') || (errorMessage.includes('relation') && errorMessage.includes('holders'))) {
        logger.error({
          message: 'Holders table does not exist - migration needs to be run',
          gameId: game.id,
        });
        return res.status(500).json({
          success: false,
          error: 'Database table not found. Please run migration 005_create_holders_table.sql',
        });
      }
      throw dbError;
    }

    // Aggregate holders by wallet
    const aggregatedHolders = aggregateHoldersByWallet(storedHolders, game);

    // Transform to frontend format
    const transformedHolders = transformHolders(aggregatedHolders, storedHolders);

    res.json({
      success: true,
      count: transformedHolders.length,
      holders: transformedHolders,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching holders',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch holders',
      details: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.message : String(error)) : undefined,
    });
  }
});

export default router;
