/**
 * Finance Markets Routes
 * Frontend-formatted finance prediction markets with pagination and filters.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import {
  getFrontendFinanceMarketsFromDatabase,
  getFrontendFinanceMarketBySlugFromDatabase,
  getFrontendFinanceMarketByIdFromDatabase,
  getFinanceMarketDetailBySlug,
  getCurrentFinanceMarketBySeriesSlug,
  getFinanceSeriesTimeline,
} from '../services/finance/frontend-finance-markets.service';
import { financeMarketsService } from '../services/finance/finance-markets.service';
import { transformCryptoDetailToActivity } from '../services/crypto/crypto-activity.transformer';
import { getFinanceTrades, getFinanceHolders, getFinanceWhales } from '../services/crypto/crypto-trading-data.service';
import { fetchAndStorePriceHistory, getPriceHistoryFromDatabase } from '../services/polymarket/price-history.service';

const router = Router();

/**
 * @swagger
 * /api/finance-markets:
 *   get:
 *     summary: Get finance markets in frontend format (paginated)
 *     description: Returns finance prediction markets from Polymarket. Supports pagination and filters by timeframe and asset (subcategory).
 *     tags: [FinanceMarkets]
 *     parameters:
 *       - in: query
 *         name: timeframe
 *         schema:
 *           type: string
 *           enum: [daily, weekly, monthly]
 *         description: Filter by timeframe. Omit for all.
 *       - in: query
 *         name: asset
 *         schema:
 *           type: string
 *           enum: [stocks, earnings, indicies, commodities, forex, collectibles, acquisitions, earnings-calls, ipos, fed-rates, prediction-markets, treasuries, tech, big-tech, economy]
 *         description: Filter by asset/subcategory. Omit for all.
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
 *         description: Paginated list of finance markets
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
  const t0 = Date.now();
  try {
    const { timeframe, asset, page, limit } = req.query;
    const pageNum = page ? Math.max(1, parseInt(String(page), 10)) : 1;
    const limitNum = limit
      ? Math.max(1, Math.min(100, parseInt(String(limit), 10)))
      : 50;

    const result = await getFrontendFinanceMarketsFromDatabase({
      timeframe: timeframe ? String(timeframe) : null,
      asset: asset ? String(asset) : null,
      page: pageNum,
      limit: limitNum,
    });

    const fetchMs = Date.now() - t0;
    res.setHeader('X-Fetch-Ms', String(fetchMs));
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
      message: 'Error fetching finance markets',
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch finance markets',
    });
  }
});

/**
 * @swagger
 * /api/finance-markets/status:
 *   get:
 *     summary: Get finance markets service status
 *     tags: [FinanceMarkets]
 *     responses:
 *       200:
 *         description: Status
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const status = await financeMarketsService.getFinanceMarketsStatus();
    return res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching finance markets status',
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
 * /api/finance-markets/refresh:
 *   post:
 *     summary: Manually trigger finance markets refresh
 *     tags: [FinanceMarkets]
 *     responses:
 *       200:
 *         description: Refresh completed
 *       500:
 *         description: Refresh failed
 */
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    await financeMarketsService.refreshFinanceMarkets();
    const status = await financeMarketsService.getFinanceMarketsStatus();
    return res.json({
      success: true,
      count: status.count,
      message: `Refreshed finance markets. ${status.count} active in database.`,
    });
  } catch (error) {
    logger.error({
      message: 'Error refreshing finance markets',
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
 * /api/finance-markets/activity/{slug}:
 *   get:
 *     summary: Get finance market in activity-watcher format (markets + outcomes)
 *     description: |
 *       Returns finance market detail in activity-watcher style for the Active Markets widget.
 *       Same API contract as /api/crypto-markets/activity/{slug}.
 *     tags: [FinanceMarkets]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Activity-watcher-style market detail
 *       404:
 *         description: Market not found
 *       500:
 *         description: Server error
 */
router.get('/activity/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const detail = await getFinanceMarketDetailBySlug(slug);

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
      message: 'Error fetching finance market activity',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch finance market activity',
    });
  }
});

/**
 * @swagger
 * /api/finance-markets/trades/{slug}:
 *   get:
 *     summary: Get trades for a finance market
 *     tags: [FinanceMarkets]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *     responses:
 *       200:
 *         description: Trades list
 *       404:
 *         description: Market not found
 *       500:
 *         description: Server error
 */
router.get('/trades/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);
    const result = await getFinanceTrades(slug, limit);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Market not found' });
    }
    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error({
      message: 'Error fetching finance trades',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Failed to fetch trades' });
  }
});

/**
 * @swagger
 * /api/finance-markets/holders/{slug}:
 *   get:
 *     summary: Get top holders for a finance market
 *     tags: [FinanceMarkets]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Holders list
 *       404:
 *         description: Market not found
 *       500:
 *         description: Server error
 */
router.get('/holders/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const result = await getFinanceHolders(slug);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Market not found' });
    }
    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error({
      message: 'Error fetching finance holders',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Failed to fetch holders' });
  }
});

/**
 * @swagger
 * /api/finance-markets/whales/{slug}:
 *   get:
 *     summary: Get whale trades for a finance market
 *     tags: [FinanceMarkets]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *     responses:
 *       200:
 *         description: Whale trades list
 *       404:
 *         description: Market not found
 *       500:
 *         description: Server error
 */
router.get('/whales/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);
    const result = await getFinanceWhales(slug, limit);
    if (!result) {
      return res.status(404).json({ success: false, error: 'Market not found' });
    }
    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error({
      message: 'Error fetching finance whale trades',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Failed to fetch whale trades' });
  }
});

/**
 * @swagger
 * /api/finance-markets/detail/{slug}:
 *   get:
 *     summary: Get full finance market detail by slug (SSR-like)
 *     tags: [FinanceMarkets]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Full finance market detail
 *       404:
 *         description: Market not found
 *       500:
 *         description: Server error
 */
router.get('/detail/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const market = await getFinanceMarketDetailBySlug(slug);

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
      message: 'Error fetching finance market detail',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch finance market detail',
    });
  }
});

/**
 * @swagger
 * /api/finance-markets/slug/{slug}:
 *   get:
 *     summary: Get a finance market by slug
 *     tags: [FinanceMarkets]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Finance market details
 *       404:
 *         description: Market not found
 *       500:
 *         description: Server error
 */
router.get('/slug/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const market = await getFrontendFinanceMarketBySlugFromDatabase(slug);

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
      message: 'Error fetching finance market by slug',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch finance market',
    });
  }
});

/**
 * @swagger
 * /api/finance-markets/series/{seriesSlug}/current:
 *   get:
 *     summary: Get the currently active finance market in a series
 *     tags: [FinanceMarkets]
 *     parameters:
 *       - in: path
 *         name: seriesSlug
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Current market slug (or null if none active)
 *       500:
 *         description: Server error
 */
router.get('/series/:seriesSlug/current', async (req: Request, res: Response) => {
  try {
    const { seriesSlug } = req.params;
    const slug = await getCurrentFinanceMarketBySeriesSlug(seriesSlug);

    return res.json({
      success: true,
      slug,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching current finance market for series',
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
 * /api/finance-markets/series/{seriesSlug}/timeline:
 *   get:
 *     summary: Get a timeline of finance markets in a series
 *     tags: [FinanceMarkets]
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
    const timeline = await getFinanceSeriesTimeline(seriesSlug, past, future);
    return res.json({ success: true, timeline });
  } catch (error) {
    logger.error({
      message: 'Error fetching finance series timeline',
      seriesSlug: req.params.seriesSlug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Failed to fetch timeline' });
  }
});

/**
 * @swagger
 * /api/finance-markets/{id}:
 *   get:
 *     summary: Get a finance market by id
 *     tags: [FinanceMarkets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Finance market details
 *       404:
 *         description: Market not found
 *       500:
 *         description: Server error
 */
/**
 * @swagger
 * /api/finance-markets/price-history/{clobTokenId}:
 *   get:
 *     summary: Get price history for a CLOB token (Up or Down outcome)
 *     tags: [FinanceMarkets]
 *     parameters:
 *       - in: path
 *         name: clobTokenId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: interval
 *         schema:
 *           type: string
 *           enum: [1h, 6h, 1d, 1w, 1m, max]
 *           default: 1d
 *       - in: query
 *         name: fidelity
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Price history points
 *       500:
 *         description: Server error
 */
router.get('/price-history/:clobTokenId', async (req: Request, res: Response) => {
  try {
    const { clobTokenId } = req.params;
    const interval = (req.query.interval as string) || '1d';
    const fidelity = req.query.fidelity ? parseInt(req.query.fidelity as string, 10) : undefined;

    // Try DB first, then fetch from Polymarket if needed
    const response = await fetchAndStorePriceHistory(clobTokenId, interval, fidelity);

    const prices = (response.history || []).map((p) => ({
      timestamp: p.t,
      price: p.p,
    }));

    return res.json({
      success: true,
      clobTokenId,
      interval,
      count: prices.length,
      prices,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching price history',
      clobTokenId: req.params.clobTokenId,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Failed to fetch price history' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const market = await getFrontendFinanceMarketByIdFromDatabase(id);

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
      message: 'Error fetching finance market by id',
      id: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch finance market',
    });
  }
});

/**
 * GET /api/finance-markets/orderbook/:clobTokenId
 * Proxies the Polymarket CLOB REST API for the initial orderbook snapshot.
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
