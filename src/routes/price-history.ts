/**
 * Price History Routes
 * Endpoints for fetching price history data from Polymarket CLOB API
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import {
  fetchAndStorePriceHistory,
  fetchAndStorePriceHistoryBulk,
  getPriceHistoryFromDatabase,
} from '../services/polymarket/price-history.service';

const router = Router();

const validIntervals = ['1h', '6h', '1d', '1w', '1m', 'max'] as const;

/**
 * @swagger
 * /api/price-history/batch:
 *   post:
 *     summary: Get price history for multiple CLOB tokens
 *     description: Fetches price history for all tokens in parallel, stores in one bulk insert, returns all histories.
 *     tags: [Price History]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [clobTokenIds, interval]
 *             properties:
 *               clobTokenIds:
 *                 type: array
 *                 items: { type: string }
 *               interval:
 *                 type: string
 *                 enum: [1h, 6h, 1d, 1w, 1m, max]
 *               fidelity:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Price histories keyed by clobTokenId
 *       400:
 *         description: Invalid request body
 *       500:
 *         description: Failed to fetch price history
 */
router.post('/batch', async (req, res) => {
  try {
    const { clobTokenIds, interval, fidelity } = req.body ?? {};

    if (!Array.isArray(clobTokenIds) || clobTokenIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'clobTokenIds must be a non-empty array of strings',
      });
    }

    if (!interval || typeof interval !== 'string' || !(validIntervals as readonly string[]).includes(interval)) {
      return res.status(400).json({
        success: false,
        error: `interval must be one of: ${validIntervals.join(', ')}`,
      });
    }

    const ids = clobTokenIds.filter((id: unknown) => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one valid clobTokenId is required',
      });
    }

    let fidelityNumber: number | undefined;
    if (fidelity !== undefined) {
      const parsed = parseInt(String(fidelity), 10);
      if (isNaN(parsed) || parsed <= 0) {
        return res.status(400).json({
          success: false,
          error: 'fidelity must be a positive integer',
        });
      }
      fidelityNumber = parsed;
    }

    const histories = await fetchAndStorePriceHistoryBulk(ids, interval as (typeof validIntervals)[number], fidelityNumber);

    res.json({
      success: true,
      interval,
      histories,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching batch price history',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch batch price history',
      details: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.message : String(error)) : undefined,
    });
  }
});

/**
 * @swagger
 * /api/price-history/{clobTokenId}:
 *   get:
 *     summary: Get price history for a CLOB token
 *     description: Fetches price history from Polymarket CLOB API, stores it in database, and returns the data. Always fetches fresh data from Polymarket.
 *     tags: [Price History]
 *     parameters:
 *       - in: path
 *         name: clobTokenId
 *         required: true
 *         schema:
 *           type: string
 *         description: The CLOB token ID
 *       - in: query
 *         name: interval
 *         required: true
 *         schema:
 *           type: string
 *           enum: [1h, 6h, 1d, 1w, 1m, max]
 *         description: Time interval for price history
 *       - in: query
 *         name: fidelity
 *         schema:
 *           type: integer
 *         description: Optional resolution in minutes. If not provided, Polymarket's default is used.
 *     responses:
 *       200:
 *         description: Price history data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 clobTokenId:
 *                   type: string
 *                 interval:
 *                   type: string
 *                 pointCount:
 *                   type: integer
 *                 history:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       timestamp:
 *                         type: integer
 *                         description: Unix timestamp in seconds
 *                       price:
 *                         type: number
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to fetch price history
 */
router.get('/:clobTokenId', async (req: Request, res: Response) => {
  try {
    const { clobTokenId } = req.params;
    const { interval, fidelity } = req.query;

    // Validate interval parameter
    if (!interval || typeof interval !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'interval query parameter is required',
      });
    }

    if (!(validIntervals as readonly string[]).includes(interval)) {
      return res.status(400).json({
        success: false,
        error: `interval must be one of: ${validIntervals.join(', ')}`,
      });
    }

    // Parse fidelity if provided
    let fidelityNumber: number | undefined;
    if (fidelity !== undefined) {
      const parsed = parseInt(fidelity as string, 10);
      if (isNaN(parsed) || parsed <= 0) {
        return res.status(400).json({
          success: false,
          error: 'fidelity must be a positive integer',
        });
      }
      fidelityNumber = parsed;
    }

    try {
      // Always fetch fresh data from Polymarket and store it
      const response = await fetchAndStorePriceHistory(clobTokenId, interval as (typeof validIntervals)[number], fidelityNumber);

      // Transform response to match our API format
      const history = response.history.map((point) => ({
        timestamp: point.t,
        price: point.p,
      }));

      res.json({
        success: true,
        clobTokenId,
        interval,
        pointCount: history.length,
        history,
      });
    } catch (fetchError) {
      // If Polymarket fetch fails, try to return cached data from database
      logger.warn({
        message: 'Polymarket fetch failed, attempting to return cached data',
        clobTokenId,
        interval,
        error: fetchError instanceof Error ? fetchError.message : String(fetchError),
      });

      try {
        const cachedHistory = await getPriceHistoryFromDatabase(clobTokenId);

        if (cachedHistory.length > 0) {
          logger.info({
            message: 'Returning cached price history from database',
            clobTokenId,
            pointCount: cachedHistory.length,
          });

          return res.json({
            success: true,
            clobTokenId,
            interval,
            pointCount: cachedHistory.length,
            history: cachedHistory,
            cached: true, // Indicate this is cached data
          });
        }
      } catch (dbError) {
        logger.error({
          message: 'Error fetching cached data from database',
          clobTokenId,
          error: dbError instanceof Error ? dbError.message : String(dbError),
        });
      }

      // If both fetch and cache fail, return error
      throw fetchError;
    }
  } catch (error) {
    logger.error({
      message: 'Error fetching price history',
      clobTokenId: req.params.clobTokenId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch price history',
      details: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.message : String(error)) : undefined,
    });
  }
});

export default router;

