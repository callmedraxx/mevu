import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { transformToActivityWatcherGame } from '../services/polymarket/activity-watcher.transformer';
import { getLiveGameBySlug, liveGamesService, LiveGame } from '../services/polymarket/live-games.service';
import { kalshiActivityService } from '../services/kalshi';

const router = Router();

// Track SSE clients keyed by game slug
const activityClients: Map<string, Set<Response>> = new Map();

function addClient(slug: string, res: Response): void {
  const key = slug.toLowerCase();
  if (!activityClients.has(key)) {
    activityClients.set(key, new Set());
  }
  activityClients.get(key)!.add(res);
}

function removeClient(slug: string, res: Response): void {
  const key = slug.toLowerCase();
  if (!activityClients.has(key)) return;
  const clients = activityClients.get(key)!;
  clients.delete(res);
  if (clients.size === 0) {
    activityClients.delete(key);
  }
}

async function broadcastForSlug(slug: string, game: LiveGame): Promise<void> {
  const key = slug.toLowerCase();
  const clients = activityClients.get(key);
  if (!clients || clients.size === 0) return;

  try {
    const transformed = await transformToActivityWatcherGame(game);
    const payload = JSON.stringify({ type: 'game_update', game: transformed });
    for (const client of clients) {
      client.write(`data: ${payload}\n\n`);
    }
  } catch (error) {
    logger.error({
      message: 'Failed to broadcast activity watcher update',
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleFullBroadcast(games: LiveGame[]): Promise<void> {
  if (activityClients.size === 0) return;

  const gamesBySlug = new Map<string, LiveGame>();
  for (const game of games) {
    if (game.slug) {
      gamesBySlug.set(game.slug.toLowerCase(), game);
    }
  }

  for (const [slug, clients] of activityClients.entries()) {
    if (!clients.size) continue;
    const game = gamesBySlug.get(slug);
    if (!game) continue;
    await broadcastForSlug(slug, game);
  }
}

async function handlePartialBroadcast(game: LiveGame): Promise<void> {
  if (!game.slug) return;
  await broadcastForSlug(game.slug, game);
}

// Register broadcast listeners (do this once when the router is loaded)
liveGamesService.addSSEBroadcastCallback(handleFullBroadcast);
liveGamesService.addSSEPartialBroadcastCallback(handlePartialBroadcast);

/**
 * @swagger
 * /api/activitywatcher/{slug}:
 *   get:
 *     summary: Get a single live game in Activity Watcher format
 *     tags: [ActivityWatcher]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: Game slug or id
 *       - in: query
 *         name: platform
 *         schema:
 *           type: string
 *           enum: [polymarket, kalshi]
 *           default: polymarket
 *         description: Market platform to fetch prices from. 'polymarket' (default) or 'kalshi'
 *     responses:
 *       200:
 *         description: Activity watcher game payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 game:
 *                   $ref: '#/components/schemas/ActivityWatcherGame'
 *       404:
 *         description: Game not found
 *       500:
 *         description: Failed to fetch game
 */
router.get('/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    const platform = (req.query.platform as string) || 'polymarket';

    // If Kalshi platform requested, use Kalshi activity service
    if (platform === 'kalshi') {
      const kalshiGame = await kalshiActivityService.getActivityForSlug(slug);
      if (!kalshiGame) {
        return res.status(404).json({ success: false, error: 'Game not found' });
      }
      return res.json({ success: true, game: kalshiGame });
    }

    // Default: Polymarket activity
    const game = await getLiveGameBySlug(slug);

    if (!game) {
      return res.status(404).json({ success: false, error: 'Game not found' });
    }

    const transformed = await transformToActivityWatcherGame(game);
    return res.json({ success: true, game: transformed });
  } catch (error) {
    logger.error({
      message: 'Error fetching activity watcher game',
      slug: req.params.slug,
      platform: req.query.platform,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Failed to fetch game' });
  }
});

/**
 * @swagger
 * /api/activitywatcher/{slug}/stream:
 *   get:
 *     summary: SSE stream for a single live game (Activity Watcher)
 *     description: Streams updates for the specified live game. Sends initial payload, heartbeats, and game_update events.
 *     tags: [ActivityWatcher]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: Game slug or id
 *     responses:
 *       200:
 *         description: SSE stream established
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       404:
 *         description: Game not found
 *       500:
 *         description: Failed to start stream
 */
router.get('/:slug/stream', async (req: Request, res: Response) => {
  const slug = req.params.slug;
  const key = slug.toLowerCase();

  try {
    const game = await getLiveGameBySlug(slug);
    if (!game) {
      return res.status(404).json({ success: false, error: 'Game not found' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    addClient(key, res);

    const transformed = await transformToActivityWatcherGame(game);
    res.write(`data: ${JSON.stringify({ type: 'initial', game: transformed })}\n\n`);

    const heartbeat = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`);
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeClient(key, res);
    });
  } catch (error) {
    logger.error({
      message: 'Error establishing activity watcher stream',
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Failed to start stream' });
  }
});

export default router;
