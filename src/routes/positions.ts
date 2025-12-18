/**
 * Positions Routes
 * Endpoints for fetching user positions and portfolio tracking
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import {
  fetchAndStorePositions,
  getPositions,
  getPortfolioSummary,
  refreshPositions,
} from '../services/positions/positions.service';
import { PositionsQueryParams } from '../services/positions/positions.types';

const router = Router();

// Store SSE clients for portfolio updates (keyed by privyUserId)
const portfolioSSEClients: Map<string, Set<Response>> = new Map();

/**
 * Broadcast portfolio update to SSE clients for a specific user
 */
function broadcastPortfolioUpdate(privyUserId: string, portfolio: number): void {
  const clients = portfolioSSEClients.get(privyUserId);
  if (!clients || clients.size === 0) return;

  const data = JSON.stringify({
    type: 'portfolio_update',
    portfolio,
    timestamp: new Date().toISOString(),
  });

  for (const client of clients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (error) {
      clients.delete(client);
    }
  }

  logger.debug({
    message: 'Broadcasted portfolio update to SSE clients',
    privyUserId,
    clientCount: clients.size,
    portfolio,
  });
}

/**
 * @swagger
 * /api/positions/{privyUserId}:
 *   get:
 *     summary: Get user positions
 *     description: Fetches positions from Polymarket, updates database, and returns positions to frontend
 *     tags: [Positions]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: The Privy user ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of positions to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of positions to skip
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [TOKENS, VALUE, PNL, PRICE]
 *           default: TOKENS
 *         description: Sort field
 *       - in: query
 *         name: sortDirection
 *         schema:
 *           type: string
 *           enum: [ASC, DESC]
 *           default: DESC
 *         description: Sort direction
 *     responses:
 *       200:
 *         description: Positions retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 positions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/UserPosition'
 *                 portfolio:
 *                   type: number
 *                   example: 1250.50
 *                   description: Total current value of all positions
 *                 totalPositions:
 *                   type: integer
 *                   example: 5
 *                 totalPnl:
 *                   type: number
 *                   example: -25.30
 *                 totalPercentPnl:
 *                   type: number
 *                   example: -1.98
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/:privyUserId', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.params;
    const { limit, offset, sortBy, sortDirection } = req.query;

    const params: PositionsQueryParams = {
      limit: limit ? parseInt(String(limit), 10) : undefined,
      offset: offset ? parseInt(String(offset), 10) : undefined,
      sortBy: sortBy as any,
      sortDirection: sortDirection as any,
    };

    // Fetch and store positions (updates database and portfolio)
    const positions = await fetchAndStorePositions(privyUserId, params);

    // Get portfolio summary
    const summary = await getPortfolioSummary(privyUserId);

    // Broadcast portfolio update to SSE clients
    broadcastPortfolioUpdate(privyUserId, summary.portfolio);

    res.json({
      success: true,
      positions,
      portfolio: summary.portfolio,
      totalPositions: summary.totalPositions,
      totalPnl: summary.totalPnl,
      totalPercentPnl: summary.totalPercentPnl,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching positions',
      privyUserId: req.params.privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof Error && error.message === 'User not found') {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * @swagger
 * /api/positions/{privyUserId}/portfolio:
 *   get:
 *     summary: Get user portfolio value
 *     description: Returns the current portfolio value without fetching from Polymarket
 *     tags: [Positions]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: The Privy user ID
 *     responses:
 *       200:
 *         description: Portfolio retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 portfolio:
 *                   type: number
 *                   example: 1250.50
 *                   description: Total current value of all positions
 *                 totalPositions:
 *                   type: integer
 *                   example: 5
 *                 totalPnl:
 *                   type: number
 *                   example: -25.30
 *                 totalPercentPnl:
 *                   type: number
 *                   example: -1.98
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/:privyUserId/portfolio', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.params;

    const summary = await getPortfolioSummary(privyUserId);

    res.json({
      success: true,
      portfolio: summary.portfolio,
      totalPositions: summary.totalPositions,
      totalPnl: summary.totalPnl,
      totalPercentPnl: summary.totalPercentPnl,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching portfolio',
      privyUserId: req.params.privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * @swagger
 * /api/positions/portfolio/{privyUserId}/stream:
 *   get:
 *     summary: Stream portfolio updates via SSE
 *     description: Server-Sent Events stream for real-time portfolio value updates
 *     tags: [Positions]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: The Privy user ID
 *     responses:
 *       200:
 *         description: SSE stream established
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */
router.get('/portfolio/:privyUserId/stream', async (req: Request, res: Response) => {
  const { privyUserId } = req.params;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Add CORS headers if needed
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // Add client to SSE clients map
  if (!portfolioSSEClients.has(privyUserId)) {
    portfolioSSEClients.set(privyUserId, new Set());
  }
  portfolioSSEClients.get(privyUserId)!.add(res);

  logger.info({
    message: 'Portfolio SSE client connected',
    privyUserId,
    totalClients: portfolioSSEClients.get(privyUserId)!.size,
  });

  // Send initial portfolio value
  try {
    const summary = await getPortfolioSummary(privyUserId);
    res.write(`data: ${JSON.stringify({
      type: 'initial',
      portfolio: summary.portfolio,
      timestamp: new Date().toISOString(),
    })}\n\n`);
  } catch (error) {
    logger.error({
      message: 'Error sending initial portfolio value',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Heartbeat every 30 seconds
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
      })}\n\n`);
    } catch (error) {
      clearInterval(heartbeatInterval);
      const clients = portfolioSSEClients.get(privyUserId);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) {
          portfolioSSEClients.delete(privyUserId);
        }
      }
    }
  }, 30000);

  // Handle client disconnect
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    const clients = portfolioSSEClients.get(privyUserId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        portfolioSSEClients.delete(privyUserId);
      }
    }
    logger.info({
      message: 'Portfolio SSE client disconnected',
      privyUserId,
      remainingClients: clients?.size || 0,
    });
  });
});

export default router;
