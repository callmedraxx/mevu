import { Router } from 'express';
import logosRouter from './logos';
import gamesRouter from './games';
import teamsRouter from './teams';
import activityWatcherRouter from './activitywatcher';
import tradesRouter from './trades';
import holdersRouter from './holders';
import whaleWatcherRouter from './whale-watcher';
import liveStatsRouter from './live-stats';

const router = Router();

/**
 * @swagger
 * /api:
 *   get:
 *     summary: API information
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: API information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: MEVU API v1.0.0
 */
router.get('/', (req, res) => {
  res.json({
    message: 'MEVU API v1.0.0',
  });
});

// Logo routes
router.use('/logos', logosRouter);

// Games routes (live games, SSE, frontend format)
router.use('/games', gamesRouter);

// Activity watcher routes (per-game view with SSE)
router.use('/activitywatcher', activityWatcherRouter);

// Trades routes (live trade widget)
router.use('/trades', tradesRouter);

// Holders routes (top holders)
router.use('/holders', holdersRouter);

// Whale watcher routes (whale trades >= $1000)
router.use('/whale-watcher', whaleWatcherRouter);

// Live stats routes (period scores and live game stats)
router.use('/live-stats', liveStatsRouter);

// Teams routes
router.use('/teams', teamsRouter);

export default router;
