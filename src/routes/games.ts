/**
 * Games Routes
 * Endpoints for live games, SSE updates, and frontend-formatted games
 */

import { Router, Request, Response } from 'express';
import { 
  getAllLiveGames, 
  getLiveGameById,
  getLiveGameBySlug,
  refreshLiveGames,
  liveGamesService,
  LiveGame,
  filterOutEndedLiveGames,
} from '../services/polymarket/live-games.service';
import { sportsWebSocketService } from '../services/polymarket/sports-websocket.service';
import { gamesWebSocketService } from '../services/polymarket/games-websocket.service';
import { clobPriceUpdateService } from '../services/polymarket/clob-price-update.service';
import { getProbabilityHistoryStats } from '../services/polymarket/probability-history.service';
import { transformToFrontendGames, transformToFrontendGame, FrontendGame } from '../services/polymarket/frontend-game.transformer';
import { teamsService } from '../services/polymarket/teams.service';
import { logger } from '../config/logger';
import { getFrontendGamesFromDatabase, getFrontendGameByIdFromDatabase, getFrontendGameBySlugFromDatabase } from '../services/polymarket/frontend-games.service';
import { initRedisGamesBroadcast, subscribeToGamesBroadcast, isRedisGamesBroadcastReady } from '../services/redis-games-broadcast.service';

const router = Router();

// Store SSE clients
const sseClients: Set<Response> = new Set();

// Subscribe to Redis for cluster-wide games broadcast (SSE receives same updates as WebSocket)
initRedisGamesBroadcast();
subscribeToGamesBroadcast((msg) => {
  try {
    const raw = msg as { type?: string; payload: string };

    // Skip cache_invalidate messages - they're for HTTP workers, not SSE clients
    if (raw.type === 'cache_invalidate') {
      return;
    }

    if (raw.type === 'batch') {
      const arr = JSON.parse(raw.payload) as unknown[];
      for (const item of arr) {
        const data = JSON.stringify(item);
        for (const client of sseClients) {
          try {
            client.write(`data: ${data}\n\n`);
          } catch {
            sseClients.delete(client);
          }
        }
      }
    } else {
      const parsed = JSON.parse(msg.payload);
      const data = JSON.stringify(parsed);
      for (const client of sseClients) {
        try {
          client.write(`data: ${data}\n\n`);
        } catch {
          sseClients.delete(client);
        }
      }
    }
  } catch {
    // ignore parse errors
  }
});

/**
 * Broadcast full games update to all SSE clients
 */
async function broadcastToClients(games: LiveGame[]): Promise<void> {
  // Filter out ended games before broadcasting
  const activeGames = filterOutEndedLiveGames(games);
  const frontendGames = await transformToFrontendGames(activeGames);
  const data = JSON.stringify({ type: 'games_update', games: frontendGames });
  
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (error) {
      sseClients.delete(client);
    }
  }
  
  // logger.debug({
  //   message: 'Broadcasted games update to SSE clients',
  //   clientCount: sseClients.size,
  //   gameCount: activeGames.length,
  // });
}

/**
 * Broadcast single game update to all SSE clients (partial update)
 * Skip when Redis is used - Redis subscription will deliver to all workers
 */
async function broadcastPartialToClients(game: LiveGame): Promise<void> {
  if (isRedisGamesBroadcastReady()) return;

  const frontendGame = await transformToFrontendGame(game);
  const data = JSON.stringify({ type: 'game_update', game: frontendGame });

  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Set up SSE broadcast callbacks
liveGamesService.setSSEBroadcastCallback(broadcastToClients);
liveGamesService.setSSEPartialBroadcastCallback(broadcastPartialToClients);

/**
 * @swagger
 * /api/games:
 *   get:
 *     summary: Get all live games
 *     description: Returns all active live games from the database
 *     tags: [Games]
 *     responses:
 *       200:
 *         description: List of live games
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: integer
 *                 games:
 *                   type: array
 *                   items:
 *                     type: object
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const games = await getAllLiveGames();
    
    res.json({
      success: true,
      count: games.length,
      games,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching all games',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch games',
    });
  }
});

/**
 * @swagger
 * /api/games/frontend:
 *   get:
 *     summary: Get games in frontend format (paginated)
 *     description: Returns active games transformed into the frontend Game interface. Supports pagination (default 50 per page, max 100). Can filter by sport and live status. By default, ended/closed games are excluded.
 *     tags: [Games]
 *     parameters:
 *       - in: query
 *         name: sport
 *         schema:
 *           type: string
 *         description: Filter by sport (e.g., nba, nfl, nhl). Use "soccer" to get all EPL and LAL games.
 *       - in: query
 *         name: live
 *         schema:
 *           type: string
 *           enum: [true, false]
 *         description: Filter by live status. 'true' = only live games, 'false' = only non-live games, omitted = all games
 *       - in: query
 *         name: includeEnded
 *         schema:
 *           type: string
 *           enum: [true, false]
 *         description: Include ended/closed games. Defaults to false.
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number (1-based). Used with limit for pagination.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Number of games per page. Default 50, max 100.
 *     responses:
 *       200:
 *         description: Paginated list of frontend-formatted games
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: integer
 *                   description: Number of games in this response
 *                 total:
 *                   type: integer
 *                   description: Total number of games matching the filters
 *                 page:
 *                   type: integer
 *                   description: Current page number
 *                 limit:
 *                   type: integer
 *                   description: Page size (games per page)
 *                 hasMore:
 *                   type: boolean
 *                   description: Whether more pages are available
 *                 games:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/FrontendGame'
 */
router.get('/frontend', async (req: Request, res: Response) => {
  try {
    const { sport, live, includeEnded, page, limit } = req.query;

    // Parse pagination parameters
    const pageNum = page ? Math.max(1, parseInt(String(page), 10)) : 1;
    const limitNum = limit ? Math.max(1, Math.min(100, parseInt(String(limit), 10))) : 50; // Default 50, max 100

    const result = await getFrontendGamesFromDatabase({
      sport: sport ? String(sport) : null,
      live: live === 'true' || live === 'false' ? (live as 'true' | 'false') : null,
      includeEnded: includeEnded === 'true' ? 'true' : null,
      page: pageNum,
      limit: limitNum,
    });

    // Safety blacklist (exclude non-sports markets by slug prefix)
    const NON_SPORTS_BLACKLIST = new Set([
      'nflx', // Netflix stock, not NFL
      'tsla', // Tesla stock
      'aapl', // Apple stock
      'spy',  // S&P 500 ETF
      'qqq',  // NASDAQ ETF
      'dow',  // Dow Jones
      'crypto', // Cryptocurrency markets
      'btc',  // Bitcoin
      'eth',  // Ethereum
    ]);

    const filteredGames = result.games.filter(g => {
      if (!g.slug) return true;
      const firstSlugPart = g.slug.toLowerCase().split('-')[0];
      return !NON_SPORTS_BLACKLIST.has(firstSlugPart);
    });

    return res.json({
      success: true,
      count: filteredGames.length,
      total: result.total,
      page: result.page,
      limit: result.limit,
      hasMore: result.hasMore,
      games: filteredGames,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching frontend games',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch games',
    });
  }
});

/**
 * @swagger
 * /api/games/stream:
 *   get:
 *     summary: SSE stream for live game updates
 *     description: Server-Sent Events stream that pushes game updates in real-time
 *     tags: [Games]
 *     responses:
 *       200:
 *         description: SSE stream established
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */
router.get('/stream', async (req: Request, res: Response) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  
  // Add client to set
  sseClients.add(res);
  
  // logger.info({
  //   message: 'SSE client connected',
  //   totalClients: sseClients.size,
  // });
  
  // Send initial data from frontend_games
  try {
    const result = await getFrontendGamesFromDatabase({
      includeEnded: 'false',
      page: 1,
      limit: 1000,
    });
    res.write(`data: ${JSON.stringify({ type: 'initial', games: result.games })}\n\n`);
  } catch (error) {
    logger.error({
      message: 'Error sending initial SSE data',
      error: error instanceof Error ? error.message : String(error),
    });
  }
  
  // Send heartbeat every 30 seconds
  const heartbeat = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`);
    } catch (error) {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 30000);
  
  // Clean up on close
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    logger.info({
      message: 'SSE client disconnected',
      totalClients: sseClients.size,
    });
  });
});

/**
 * @swagger
 * /api/games/refresh:
 *   post:
 *     summary: Trigger a manual refresh of live games
 *     description: Fetches fresh data from Polymarket and updates the database
 *     tags: [Games]
 *     responses:
 *       200:
 *         description: Refresh completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 gamesUpdated:
 *                   type: integer
 */
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    logger.info({ message: 'Manual games refresh triggered' });
    
    const count = await refreshLiveGames();
    
    res.json({
      success: true,
      gamesUpdated: count,
      message: `Successfully refreshed ${count} games`,
    });
  } catch (error) {
    logger.error({
      message: 'Error refreshing games',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to refresh games',
    });
  }
});

/**
 * @swagger
 * /api/games/status:
 *   get:
 *     summary: Get live games service status
 *     tags: [Games]
 *     responses:
 *       200:
 *         description: Service status
 */
router.get('/status', async (req: Request, res: Response) => {
  const liveGamesStatus = liveGamesService.getStatus();
  const webSocketStatus = sportsWebSocketService.getStatus();
  const gamesWsStatus = gamesWebSocketService.getStatus();
  const clobPriceStatus = clobPriceUpdateService.getStatus();
  const probHistoryStats = await getProbabilityHistoryStats();
  
  res.json({
    success: true,
    liveGames: {
      ...liveGamesStatus,
      sseClients: sseClients.size,
    },
    webSocket: webSocketStatus,
    gamesWebSocket: gamesWsStatus,
    clobPriceUpdate: clobPriceStatus,
    probabilityHistory: probHistoryStats,
  });
});

/**
 * @swagger
 * /api/games/slug/{slug}:
 *   get:
 *     summary: Get a specific live game by slug
 *     tags: [Games]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: Game slug (e.g., nba-okc-min-2025-12-19)
 *     responses:
 *       200:
 *         description: Game details (raw format)
 *       404:
 *         description: Game not found
 */
router.get('/slug/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const game = await getLiveGameBySlug(slug);
    
    if (!game) {
      return res.status(404).json({
        success: false,
        error: 'Game not found',
      });
    }
    
    res.json({
      success: true,
      game,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching game by slug',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch game',
    });
  }
});

/**
 * @swagger
 * /api/games/slug/{slug}/frontend:
 *   get:
 *     summary: Get a specific live game by slug in frontend format
 *     tags: [Games]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: Game slug (e.g., nba-okc-min-2025-12-19)
 *     responses:
 *       200:
 *         description: Frontend-formatted game details
 *       404:
 *         description: Game not found
 */
router.get('/slug/:slug/frontend', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;

    // Get pre-computed frontend game directly from frontend_games table
    // This ensures consistency with /games/frontend endpoint
    const frontendGame = await getFrontendGameBySlugFromDatabase(slug);

    if (!frontendGame) {
      return res.status(404).json({
        success: false,
        error: 'Game not found',
      });
    }

    res.json({
      success: true,
      game: frontendGame,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching frontend game by slug',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch game',
    });
  }
});

/**
 * @swagger
 * /api/games/{id}:
 *   get:
 *     summary: Get a specific live game by ID
 *     tags: [Games]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Game ID
 *     responses:
 *       200:
 *         description: Game details
 *       404:
 *         description: Game not found
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const game = await getLiveGameById(id);
    
    if (!game) {
      return res.status(404).json({
        success: false,
        error: 'Game not found',
      });
    }
    
    res.json({
      success: true,
      game,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching game by ID',
      gameId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch game',
    });
  }
});

/**
 * @swagger
 * /api/games/{id}/frontend:
 *   get:
 *     summary: Get a specific live game in frontend format
 *     tags: [Games]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Game ID
 *     responses:
 *       200:
 *         description: Frontend-formatted game details
 *       404:
 *         description: Game not found
 */
router.get('/:id/frontend', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Get pre-computed frontend game directly from frontend_games table
    // This ensures consistency with /games/frontend endpoint
    const frontendGame = await getFrontendGameByIdFromDatabase(id);

    if (!frontendGame) {
      return res.status(404).json({
        success: false,
        error: 'Game not found',
      });
    }

    res.json({
      success: true,
      game: frontendGame,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching frontend game by ID',
      gameId: req.params.id,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch game',
    });
  }
});

export default router;

