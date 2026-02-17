import { Router } from 'express';
import logosRouter from './logos';
import gamesRouter from './games';
import teamsRouter from './teams';
import activityWatcherRouter from './activitywatcher';
import tradesRouter from './trades';
import holdersRouter from './holders';
import whaleWatcherRouter from './whale-watcher';
import liveStatsRouter from './live-stats';
import usersRouter from './users';
import walletsRouter from './wallets';
import balancesRouter from './balances';
import tradingRouter from './trading';
import positionsRouter from './positions';
import webhooksRouter from './webhooks';
import priceHistoryRouter from './price-history';
import playByPlayRouter from './playbyplay';
import whaleProfileRouter from './whale-profile';
import referralRouter from './referral';
import oceanRouter from './ocean';
import kalshiTradingRouter from './kalshi-trading';
import announcementsRouter from './announcements';
import proofRouter from './proof';
import cryptoMarketsRouter from './crypto-markets';

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

// Users routes (registration, wallet deployment, token approvals)
router.use('/users', usersRouter);

// Wallets routes (wallet creation)
router.use('/wallets', walletsRouter);

// Balances routes (USDC.e balance tracking)
router.use('/balances', balancesRouter);

// Trading routes (buy/sell markets)
router.use('/trading', tradingRouter);

// Positions routes (user positions and portfolio)
router.use('/positions', positionsRouter);

// Webhooks routes (Alchemy, etc.)
router.use('/webhooks', webhooksRouter);

// Price history routes (CLOB price history)
router.use('/price-history', priceHistoryRouter);

// Play-by-play routes (live game events from Ball Don't Lie)
router.use('/playbyplay', playByPlayRouter);

// Whale profile routes (whale trading data from Polymarket)
router.use('/whale-profile', whaleProfileRouter);

// Referral routes (referral links, stats, earnings)
router.use('/referral', referralRouter);

// Ocean routes (whale trades aggregation)
router.use('/ocean', oceanRouter);
router.use('/kalshi-trading', kalshiTradingRouter);
router.use('/announcements', announcementsRouter);
router.use('/proof', proofRouter);
router.use('/crypto-markets', cryptoMarketsRouter);

export default router;
