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
  getCurrentMarketBySeriesSlug,
  getSeriesTimeline,
} from '../services/crypto/frontend-crypto-markets.service';
import { transformCryptoDetailToActivity } from '../services/crypto/crypto-activity.transformer';
import { cryptoMarketsService } from '../services/crypto/crypto-markets.service';
import { getCryptoTrades, getCryptoHolders, getCryptoWhales } from '../services/crypto/crypto-trading-data.service';

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
 * /api/crypto-markets/activity/{slug}:
 *   get:
 *     summary: Get crypto market in activity-watcher format (markets + outcomes, no teams)
 *     description: |
 *       Returns crypto market detail in activity-watcher style for the Active Markets widget.
 *       No team data — just parent metadata and sub-markets with outcomes, volume, liquidity.
 *       Same API contract as /api/activitywatcher/{slug} for games but simplified for crypto.
 *     tags: [CryptoMarkets]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: Market slug (e.g., what-price-will-bitcoin-hit-in-february-2026)
 *     responses:
 *       200:
 *         description: Activity-style payload with markets and outcomes
 *       404:
 *         description: Market not found
 *       500:
 *         description: Server error
 */
router.get('/activity/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const detail = await getCryptoMarketDetailBySlug(slug);

    if (!detail) {
      return res.status(404).json({
        success: false,
        error: 'Market not found',
      });
    }

    const activity = transformCryptoDetailToActivity(detail);
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, market: activity });
  } catch (error) {
    logger.error({
      message: 'Error fetching crypto market activity',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch crypto market activity',
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
 * /api/crypto-markets/series/{seriesSlug}/current:
 *   get:
 *     summary: Get the currently active market in a series
 *     description: Returns the slug of the market whose time window is currently active (start_time <= now < end_date).
 *     tags: [CryptoMarkets]
 *     parameters:
 *       - in: path
 *         name: seriesSlug
 *         required: true
 *         schema:
 *           type: string
 *         description: Series slug (e.g., btc-up-or-down-15m)
 *     responses:
 *       200:
 *         description: Current market slug (or null if none active)
 *       500:
 *         description: Server error
 */
router.get('/series/:seriesSlug/current', async (req: Request, res: Response) => {
  try {
    const { seriesSlug } = req.params;
    const slug = await getCurrentMarketBySeriesSlug(seriesSlug);

    return res.json({
      success: true,
      slug,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching current market for series',
      seriesSlug: req.params.seriesSlug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch current market',
    });
  }
});

/**
 * @swagger
 * /api/crypto-markets/series/{seriesSlug}/timeline:
 *   get:
 *     summary: Get a timeline of markets in a series
 *     description: Returns past, current, and future markets around now for the time window selector widget.
 *     tags: [CryptoMarkets]
 *     parameters:
 *       - in: path
 *         name: seriesSlug
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: past
 *         schema:
 *           type: integer
 *           default: 4
 *       - in: query
 *         name: future
 *         schema:
 *           type: integer
 *           default: 3
 *     responses:
 *       200:
 *         description: Timeline of markets
 */
router.get('/series/:seriesSlug/timeline', async (req: Request, res: Response) => {
  try {
    const { seriesSlug } = req.params;
    const past = Math.min(Number(req.query.past) || 4, 20);
    const future = Math.min(Number(req.query.future) || 3, 20);
    const timeline = await getSeriesTimeline(seriesSlug, past, future);
    return res.json({ success: true, timeline });
  } catch (error) {
    logger.error({
      message: 'Error fetching series timeline',
      seriesSlug: req.params.seriesSlug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Failed to fetch timeline' });
  }
});

/**
 * GET /api/crypto-markets/trades/:slug
 * Trades for a crypto market (cached in DB, fetches from Polymarket with cooldown).
 */
router.get('/trades/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);
    const result = await getCryptoTrades(slug, limit);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Market not found' });
    }
    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error({
      message: 'Error fetching crypto trades',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Failed to fetch trades' });
  }
});

/**
 * GET /api/crypto-markets/holders/:slug
 * Top holders for a crypto market (cached in DB, fetches from Polymarket with cooldown).
 */
router.get('/holders/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const result = await getCryptoHolders(slug);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Market not found' });
    }
    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error({
      message: 'Error fetching crypto holders',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Failed to fetch holders' });
  }
});

/**
 * GET /api/crypto-markets/whales/:slug
 * Whale trades (>= $1000) for a crypto market.
 */
router.get('/whales/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);
    const result = await getCryptoWhales(slug, limit);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Market not found' });
    }
    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error({
      message: 'Error fetching crypto whale trades',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Failed to fetch whale trades' });
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

/**
 * GET /api/crypto-markets/orderbook/:clobTokenId
 * Proxies the Polymarket CLOB REST API for the initial orderbook snapshot.
 * Returns bids, asks, and lastTradePrice before the WebSocket stream starts.
 * No auth required on the CLOB API side — we proxy to avoid CORS issues.
 */
router.get('/orderbook/:clobTokenId', async (req: Request, res: Response) => {
  const { clobTokenId } = req.params;
  if (!clobTokenId) {
    return res.status(400).json({ success: false, error: 'Missing clobTokenId' });
  }

  try {
    const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(clobTokenId)}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MevuBot/1.0)',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: `CLOB API returned ${response.status}`,
      });
    }

    const data = await response.json() as any;

    return res.json({
      success: true,
      book: {
        clobTokenId: data.asset_id || clobTokenId,
        conditionId: data.market || '',
        bids: data.bids || [],
        asks: data.asks || [],
        lastTradePrice: data.last_trade_price ?? null,
        minOrderSize: data.min_order_size ?? null,
        tickSize: data.tick_size ?? null,
      },
    });
  } catch (error) {
    logger.error({
      message: 'Failed to fetch orderbook from CLOB API',
      clobTokenId,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Failed to fetch orderbook' });
  }
});

export default router;
