/**
 * Games Routes
 * Endpoints for live games, SSE updates, and frontend-formatted games
 */

import { Router, Request, Response } from 'express';
import { 
  getAllLiveGames, 
  getLiveGameById,
  refreshLiveGames,
  liveGamesService,
  LiveGame 
} from '../services/polymarket/live-games.service';
import { sportsWebSocketService } from '../services/polymarket/sports-websocket.service';
import { getProbabilityHistoryStats } from '../services/polymarket/probability-history.service';
import { transformToFrontendGames, transformToFrontendGame, FrontendGame } from '../services/polymarket/frontend-game.transformer';
import { teamsService } from '../services/polymarket/teams.service';
import { logger } from '../config/logger';

const router = Router();

// Store SSE clients
const sseClients: Set<Response> = new Set();

/**
 * Broadcast full games update to all SSE clients
 */
async function broadcastToClients(games: LiveGame[]): Promise<void> {
  const frontendGames = await transformToFrontendGames(games);
  const data = JSON.stringify({ type: 'games_update', games: frontendGames });
  
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (error) {
      sseClients.delete(client);
    }
  }
  
  logger.debug({
    message: 'Broadcasted games update to SSE clients',
    clientCount: sseClients.size,
    gameCount: games.length,
  });
}

/**
 * Broadcast single game update to all SSE clients (partial update)
 */
async function broadcastPartialToClients(game: LiveGame): Promise<void> {
  const frontendGame = await transformToFrontendGame(game);
  const data = JSON.stringify({ type: 'game_update', game: frontendGame });
  
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch (error) {
      sseClients.delete(client);
    }
  }
  
  logger.debug({
    message: 'Broadcasted partial game update to SSE clients',
    clientCount: sseClients.size,
    gameId: game.id,
  });
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
 *     summary: Get all live games in frontend format
 *     description: Returns all active live games transformed into the frontend Game interface
 *     tags: [Games]
 *     parameters:
 *       - in: query
 *         name: sport
 *         schema:
 *           type: string
 *         description: Filter by sport (e.g., nba, nfl)
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *         description: Filter only live games
 *     responses:
 *       200:
 *         description: List of frontend-formatted games
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
 */
router.get('/frontend', async (req: Request, res: Response) => {
  try {
    let games = await getAllLiveGames();
    
    // Apply filters
    const { sport, live } = req.query;
    
    if (sport) {
      games = games.filter(g => g.sport?.toLowerCase() === String(sport).toLowerCase());
    }
    
    if (live === 'true') {
      games = games.filter(g => g.live === true);
    }
    
    const frontendGames = await transformToFrontendGames(games);
    
    res.json({
      success: true,
      count: frontendGames.length,
      games: frontendGames,
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
  
  logger.info({
    message: 'SSE client connected',
    totalClients: sseClients.size,
  });
  
  // Send initial data
  try {
    const games = await getAllLiveGames();
    const frontendGames = await transformToFrontendGames(games);
    res.write(`data: ${JSON.stringify({ type: 'initial', games: frontendGames })}\n\n`);
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
  const probHistoryStats = await getProbabilityHistoryStats();
  
  res.json({
    success: true,
    liveGames: {
      ...liveGamesStatus,
      sseClients: sseClients.size,
    },
    webSocket: webSocketStatus,
    probabilityHistory: probHistoryStats,
  });
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
    const game = await getLiveGameById(id);
    
    if (!game) {
      return res.status(404).json({
        success: false,
        error: 'Game not found',
      });
    }
    
    const frontendGame = await transformToFrontendGame(game);
    
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

