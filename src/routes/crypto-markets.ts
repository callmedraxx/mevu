/**
 * Crypto Markets Routes
 * Frontend-formatted crypto prediction markets with pagination and filters.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import {
  getFrontendCryptoMarketsFromDatabase,
  getFrontendCryptoMarketBySlugFromDatabase,
  getFrontendCryptoMarketByIdFromDatabase,
  getCryptoMarketDetailBySlug,
} from '../services/crypto/frontend-crypto-markets.service';
import { cryptoMarketsService } from '../services/crypto/crypto-markets.service';

const router = Router();

/**
 * @swagger
 * /api/crypto-markets:
 *   get:
 *     summary: Get crypto markets in frontend format (paginated)
 *     description: Returns crypto prediction markets from Polymarket. Supports pagination and filters by timeframe and asset (subcategory).
 *     tags: [CryptoMarkets]
 *     parameters:
 *       - in: query
 *         name: timeframe
 *         schema:
 *           type: string
 *           enum: [15min, hourly, 4hour, daily, weekly, monthly, pre-market, etf]
 *         description: Filter by timeframe. Omit for all.
 *       - in: query
 *         name: asset
 *         schema:
 *           type: string
 *         description: Filter by asset/subcategory (e.g., bitcoin, ethereum, solana). Omit for all.
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number (1-based)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Number of markets per page
 *     responses:
 *       200:
 *         description: Paginated list of crypto markets
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 count: { type: integer }
 *                 total: { type: integer }
 *                 page: { type: integer }
 *                 limit: { type: integer }
 *                 hasMore: { type: boolean }
 *                 markets:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/PredictionMarket'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { timeframe, asset, page, limit } = req.query;
    const pageNum = page ? Math.max(1, parseInt(String(page), 10)) : 1;
    const limitNum = limit
      ? Math.max(1, Math.min(100, parseInt(String(limit), 10)))
      : 50;

    const result = await getFrontendCryptoMarketsFromDatabase({
      timeframe: timeframe ? String(timeframe) : null,
      asset: asset ? String(asset) : null,
      page: pageNum,
      limit: limitNum,
    });

    return res.json({
      success: true,
      count: result.markets.length,
      total: result.total,
      page: result.page,
      limit: result.limit,
      hasMore: result.hasMore,
      markets: result.markets,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching crypto markets',
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch crypto markets',
    });
  }
});

/**
 * @swagger
 * /api/crypto-markets/status:
 *   get:
 *     summary: Get crypto markets service status
 *     description: Returns count in DB, last refresh time, and refresh interval. Useful for debugging empty results.
 *     tags: [CryptoMarkets]
 *     responses:
 *       200:
 *         description: Status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 count: { type: integer }
 *                 lastRefreshAt: { type: string, format: date-time, nullable: true }
 *                 refreshIntervalMs: { type: integer }
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const status = await cryptoMarketsService.getCryptoMarketsStatus();
    return res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching crypto markets status',
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch status',
    });
  }
});

/**
 * @swagger
 * /api/crypto-markets/refresh:
 *   post:
 *     summary: Manually trigger crypto markets refresh
 *     description: Fetches from Gamma API and stores in DB. Use when empty or after server restart to populate immediately.
 *     tags: [CryptoMarkets]
 *     responses:
 *       200:
 *         description: Refresh completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 count: { type: integer }
 *                 message: { type: string }
 *       500:
 *         description: Refresh failed
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    await cryptoMarketsService.refreshCryptoMarkets();
    const status = await cryptoMarketsService.getCryptoMarketsStatus();
    return res.json({
      success: true,
      count: status.count,
      message: `Refreshed crypto markets. ${status.count} active in database.`,
    });
  } catch (error) {
    logger.error({
      message: 'Error refreshing crypto markets',
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * @swagger
 * /api/crypto-markets/detail/{slug}:
 *   get:
 *     summary: Get full crypto market detail by slug (SSR-like)
 *     description: |
 *       Returns the full/raw market data for a crypto event, including description,
 *       resolution source, start/end times, nested sub-markets with bestBid/bestAsk/
 *       lastTradePrice, series metadata, and tags. No PredictionMarket transformation
 *       — suitable for detail pages that need open/close price context.
 *     tags: [CryptoMarkets]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: Market slug (e.g., btc-updown-15m-1771235100)
 *     responses:
 *       200:
 *         description: Full crypto market detail
 *       404:
 *         description: Market not found
 *       500:
 *         description: Server error
 */
router.get('/detail/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const market = await getCryptoMarketDetailBySlug(slug);

    if (!market) {
      return res.status(404).json({
        success: false,
        error: 'Market not found',
      });
    }

    return res.json({
      success: true,
      market,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching crypto market detail',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch crypto market detail',
    });
  }
});

/**
 * @swagger
 * /api/crypto-markets/slug/{slug}:
 *   get:
 *     summary: Get a crypto market by slug
 *     description: Returns a single crypto market in frontend format, looked up by URL-friendly slug.
 *     tags: [CryptoMarkets]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: Market slug (e.g., will-bitcoin-exceed-120000-by-march-2026)
 *     responses:
 *       200:
 *         description: Crypto market details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 market: { $ref: '#/components/schemas/PredictionMarket' }
 *       404:
 *         description: Market not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/slug/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const market = await getFrontendCryptoMarketBySlugFromDatabase(slug);

    if (!market) {
      return res.status(404).json({
        success: false,
        error: 'Market not found',
      });
    }

    return res.json({
      success: true,
      market,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching crypto market by slug',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch crypto market',
    });
  }
});

/**
 * @swagger
 * /api/crypto-markets/{id}:
 *   get:
 *     summary: Get a crypto market by id
 *     description: Returns a single crypto market in frontend format, looked up by Polymarket event id.
 *     tags: [CryptoMarkets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Polymarket event/market id
 *     responses:
 *       200:
 *         description: Crypto market details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 market: { $ref: '#/components/schemas/PredictionMarket' }
 *       404:
 *         description: Market not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const market = await getFrontendCryptoMarketByIdFromDatabase(id);

    if (!market) {
      return res.status(404).json({
        success: false,
        error: 'Market not found',
      });
    }

    return res.json({
      success: true,
      market,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching crypto market by id',
      id: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch crypto market',
    });
  }
});

export default router;
