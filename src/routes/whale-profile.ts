/**
 * Whale Profile Routes
 * Endpoints for fetching comprehensive whale trading data from Polymarket
 * 
 * @swagger
 * components:
 *   schemas:
 *     WhaleStats:
 *       type: object
 *       description: Core statistics for a whale trader
 *       properties:
 *         wallet:
 *           type: string
 *           description: Proxy wallet address
 *           example: "0x3a090da22b2bcfee0f3125a26265efbcd356f9f7"
 *         username:
 *           type: string
 *           description: User's display name (if set)
 *           example: "eepybeepy"
 *         pseudonym:
 *           type: string
 *           description: User's pseudonym
 *           example: "Fat-Solidarity"
 *         bio:
 *           type: string
 *           description: User's bio
 *         profileImage:
 *           type: string
 *           description: URL to profile image
 *         totalVolume:
 *           type: number
 *           description: Total trading volume in USD
 *           example: 125430.50
 *         avgTradeSize:
 *           type: number
 *           description: Average trade size in USD
 *           example: 245.75
 *         winRate:
 *           type: number
 *           description: Win percentage (0-100)
 *           example: 68
 *         tradesCount:
 *           type: integer
 *           description: Total number of trades
 *           example: 510
 *         pnl:
 *           type: number
 *           description: Total profit/loss in USD
 *           example: 8540.25
 *         pnlChange:
 *           type: number
 *           description: PnL percentage change
 *           example: 12.5
 *         firstSeen:
 *           type: string
 *           description: When first seen trading
 *           example: "Jan 2024"
 *         lastActive:
 *           type: string
 *           description: Time since last activity
 *           example: "2 hours ago"
 *         favoriteSport:
 *           type: string
 *           description: Most traded sport
 *           example: "NBA"
 *     WhalePosition:
 *       type: object
 *       description: A position held by the whale
 *       properties:
 *         id:
 *           type: integer
 *           example: 1
 *         question:
 *           type: string
 *           description: Market question
 *           example: "Lakers vs. Warriors"
 *         side:
 *           type: string
 *           enum: [Yes, No]
 *           example: "Yes"
 *         shares:
 *           type: number
 *           description: Number of shares held
 *           example: 150.5
 *         avgPrice:
 *           type: number
 *           description: Average entry price in cents
 *           example: 65
 *         currentPrice:
 *           type: number
 *           description: Current price in cents
 *           example: 72
 *         value:
 *           type: number
 *           description: Current position value in USD
 *           example: 108.36
 *         pnl:
 *           type: number
 *           description: Position P&L in USD
 *           example: 10.55
 *         pnlPercent:
 *           type: number
 *           description: Position P&L percentage
 *           example: 10.77
 *         sport:
 *           type: string
 *           description: Sport code
 *           example: "nba"
 *         team:
 *           type: string
 *           description: Team abbreviation
 *           example: "LAL"
 *         platform:
 *           type: string
 *           enum: [polymarket, kalshi]
 *           example: "polymarket"
 *     WhaleTrade:
 *       type: object
 *       description: A recent trade by the whale
 *       properties:
 *         type:
 *           type: string
 *           enum: [buy, sell]
 *           example: "buy"
 *         question:
 *           type: string
 *           description: Market question
 *           example: "Lakers vs. Warriors"
 *         amount:
 *           type: number
 *           description: Trade amount in USD
 *           example: 97.50
 *         shares:
 *           type: number
 *           description: Number of shares
 *           example: 150
 *         price:
 *           type: number
 *           description: Price in cents
 *           example: 65
 *         time:
 *           type: string
 *           description: Relative time
 *           example: "2m ago"
 *         sport:
 *           type: string
 *           example: "nba"
 *         homeTeam:
 *           type: string
 *           example: "Warriors"
 *         awayTeam:
 *           type: string
 *           example: "Lakers"
 *         platform:
 *           type: string
 *           enum: [polymarket, kalshi]
 *           example: "polymarket"
 *     PnlDataPoint:
 *       type: object
 *       properties:
 *         day:
 *           type: integer
 *           example: 1
 *         value:
 *           type: number
 *           example: 125.50
 *     SportVolumePoint:
 *       type: object
 *       properties:
 *         sport:
 *           type: string
 *           example: "NBA"
 *         volume:
 *           type: number
 *           example: 45000
 *         color:
 *           type: string
 *           example: "#C9082A"
 *     WhaleProfileResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           example: true
 *         stats:
 *           $ref: '#/components/schemas/WhaleStats'
 *         positions:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/WhalePosition'
 *         recentTrades:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/WhaleTrade'
 *         pnlChart:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/PnlDataPoint'
 *         volumeBySport:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/SportVolumePoint'
 *         error:
 *           type: string
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { getWhaleProfile, getWhaleStats } from '../services/polymarket/whale-profile.service';

const router = Router();

/**
 * @swagger
 * /api/whale-profile/{wallet}:
 *   get:
 *     summary: Get complete whale profile
 *     description: |
 *       Fetches comprehensive trading data for a whale wallet from Polymarket.
 *       Returns stats, positions, recent trades, and chart data.
 *       
 *       **Data Sources:**
 *       - Positions: Current open positions with P&L
 *       - Trades: Recent trade history (up to 500 trades)
 *       - Stats: Calculated from trades and positions
 *       
 *       **Note:** This endpoint makes multiple API calls to Polymarket and may take 2-5 seconds.
 *     tags: [WhaleProfile]
 *     parameters:
 *       - in: path
 *         name: wallet
 *         required: true
 *         schema:
 *           type: string
 *         description: Proxy wallet address (0x...)
 *         example: "0x3a090da22b2bcfee0f3125a26265efbcd356f9f7"
 *     responses:
 *       200:
 *         description: Whale profile data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WhaleProfileResponse'
 *             example:
 *               success: true
 *               stats:
 *                 wallet: "0x3a090da22b2bcfee0f3125a26265efbcd356f9f7"
 *                 username: "eepybeepy"
 *                 pseudonym: "Fat-Solidarity"
 *                 totalVolume: 125430.50
 *                 avgTradeSize: 245.75
 *                 winRate: 68
 *                 tradesCount: 510
 *                 pnl: 8540.25
 *                 pnlChange: 12.5
 *                 firstSeen: "Jan 2024"
 *                 lastActive: "2 hours ago"
 *                 favoriteSport: "NBA"
 *               positions:
 *                 - id: 1
 *                   question: "Lakers vs. Warriors"
 *                   side: "Yes"
 *                   shares: 150.5
 *                   avgPrice: 65
 *                   currentPrice: 72
 *                   value: 108.36
 *                   pnl: 10.55
 *                   pnlPercent: 10.77
 *                   sport: "nba"
 *                   team: "LAL"
 *                   platform: "polymarket"
 *               recentTrades:
 *                 - type: "buy"
 *                   question: "Lakers vs. Warriors"
 *                   amount: 97.50
 *                   shares: 150
 *                   price: 65
 *                   time: "2m ago"
 *                   sport: "nba"
 *                   homeTeam: "Warriors"
 *                   awayTeam: "Lakers"
 *                   platform: "polymarket"
 *               pnlChart:
 *                 - day: 1
 *                   value: 125.50
 *               volumeBySport:
 *                 - sport: "NBA"
 *                   volume: 45000
 *                   color: "#C9082A"
 *       400:
 *         description: Invalid wallet address
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Invalid wallet address format"
 *       500:
 *         description: Internal server error
 */
router.get('/:wallet', async (req: Request, res: Response) => {
  try {
    const { wallet } = req.params;

    if (!wallet) {
      return res.status(400).json({
        success: false,
        error: 'Wallet address is required',
      });
    }

    logger.info({
      message: 'Whale profile request received',
      wallet,
    });

    const result = await getWhaleProfile(wallet);

    if (!result.success && result.error?.includes('Invalid')) {
      return res.status(400).json(result);
    }

    return res.status(200).json(result);
  } catch (error) {
    logger.error({
      message: 'Error in whale profile endpoint',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * @swagger
 * /api/whale-profile/{wallet}/stats:
 *   get:
 *     summary: Get whale stats only (lightweight)
 *     description: |
 *       Fetches only the core statistics for a whale wallet.
 *       Faster than the full profile endpoint.
 *     tags: [WhaleProfile]
 *     parameters:
 *       - in: path
 *         name: wallet
 *         required: true
 *         schema:
 *           type: string
 *         description: Proxy wallet address (0x...)
 *         example: "0x3a090da22b2bcfee0f3125a26265efbcd356f9f7"
 *     responses:
 *       200:
 *         description: Whale stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 stats:
 *                   $ref: '#/components/schemas/WhaleStats'
 *       400:
 *         description: Invalid wallet address
 *       500:
 *         description: Internal server error
 */
router.get('/:wallet/stats', async (req: Request, res: Response) => {
  try {
    const { wallet } = req.params;

    if (!wallet) {
      return res.status(400).json({
        success: false,
        error: 'Wallet address is required',
      });
    }

    const result = await getWhaleStats(wallet);

    if (!result.success && result.error?.includes('Invalid')) {
      return res.status(400).json(result);
    }

    return res.status(200).json(result);
  } catch (error) {
    logger.error({
      message: 'Error in whale stats endpoint',
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

export default router;
