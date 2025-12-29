/**
 * Trading Routes
 * Endpoints for buying and selling markets on Polymarket
 * 
 * @swagger
 * components:
 *   schemas:
 *     TradeRecord:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *         privyUserId:
 *           type: string
 *         proxyWalletAddress:
 *           type: string
 *         marketId:
 *           type: string
 *         marketQuestion:
 *           type: string
 *         clobTokenId:
 *           type: string
 *         outcome:
 *           type: string
 *         side:
 *           type: string
 *           enum: [BUY, SELL]
 *         orderType:
 *           type: string
 *           enum: [FOK, FAK, LIMIT, MARKET]
 *         size:
 *           type: string
 *         price:
 *           type: string
 *         costUsdc:
 *           type: string
 *         feeUsdc:
 *           type: string
 *         orderId:
 *           type: string
 *         transactionHash:
 *           type: string
 *         blockNumber:
 *           type: integer
 *         blockTimestamp:
 *           type: string
 *           format: date-time
 *         status:
 *           type: string
 *           enum: [PENDING, FILLED, PARTIALLY_FILLED, CANCELLED, FAILED]
 *         metadata:
 *           type: object
 *         createdAt:
 *           type: string
 *           format: date-time
 *         updatedAt:
 *           type: string
 *           format: date-time
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { executeTrade } from '../services/polymarket/trading/trading.service';
import { getTradeHistory } from '../services/polymarket/trading/trades-history.service';
import { CreateTradeRequest, TradeHistoryQuery, TradeSide, OrderType } from '../services/polymarket/trading/trading.types';

const router = Router();

/**
 * @swagger
 * /api/trading/buy:
 *   post:
 *     summary: Buy shares in a market
 *     description: Execute a buy order on Polymarket CLOB. Uses gasless transactions via RelayerClient.
 *     tags: [Trading]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - privyUserId
 *               - marketInfo
 *               - size
 *               - price
 *             properties:
 *               privyUserId:
 *                 type: string
 *                 description: Privy user ID
 *                 example: "did:privy:cmj921f4201dql40c3nubss93"
 *               userJwt:
 *                 type: string
 *                 description: Optional user JWT token for session signer
 *               marketInfo:
 *                 type: object
 *                 required:
 *                   - marketId
 *                   - clobTokenId
 *                   - outcome
 *                 properties:
 *                   marketId:
 *                     type: string
 *                     example: "0x123..."
 *                   marketQuestion:
 *                     type: string
 *                     example: "Will Team A win?"
 *                   clobTokenId:
 *                     type: string
 *                     description: CLOB token ID for the specific outcome
 *                     example: "16678291189211314787145083999015737376658799626130630684070927984975568281601"
 *                   outcome:
 *                     type: string
 *                     example: "Yes"
 *                   metadata:
 *                     type: object
 *                     description: Additional market metadata
 *               orderType:
 *                 type: string
 *                 enum: [FOK, FAK]
 *                 default: FOK
 *                 description: Order type - FOK (Fill or Kill) or FAK (Fill and Kill)
 *               size:
 *                 type: string
 *                 description: Number of shares to buy (e.g., "10" = 10 shares). Backend calculates USDC amount = shares * price.
 *                 example: "10"
 *               price:
 *                 type: string
 *                 description: Price per share (0-1). Required for all order types to calculate USDC amount.
 *                 example: "0.5"
 *     responses:
 *       200:
 *         description: Trade executed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 orderId:
 *                   type: string
 *                 transactionHash:
 *                   type: string
 *                 status:
 *                   type: string
 *                 trade:
 *                   $ref: '#/components/schemas/TradeRecord'
 *       400:
 *         description: Invalid request or insufficient approvals
 *       404:
 *         description: User not found
 *       500:
 *         description: Internal server error
 */
router.post('/buy', async (req: Request, res: Response) => {
  try {
    const {
      privyUserId,
      userJwt,
      marketInfo,
      orderType = 'FOK',
      size,
      price,
    } = req.body;

    // Validate required fields
    if (!privyUserId || !marketInfo || !size || !price) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: privyUserId, marketInfo, size, price',
      });
    }

    if (!marketInfo.clobTokenId || !marketInfo.outcome) {
      return res.status(400).json({
        success: false,
        message: 'marketInfo must include clobTokenId and outcome',
      });
    }

    const tradeRequest: CreateTradeRequest = {
      privyUserId,
      userJwt,
      marketInfo,
      side: TradeSide.BUY,
      orderType: orderType === 'FAK' ? OrderType.FAK : OrderType.FOK,
      size: String(size),
      price: String(price),
    };

    const result = await executeTrade(tradeRequest);

    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.status(200).json(result);
  } catch (error) {
    logger.error({
      message: 'Error in buy endpoint',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * @swagger
 * /api/trading/sell:
 *   post:
 *     summary: Sell shares in a market
 *     description: Execute a sell order on Polymarket CLOB. Uses gasless transactions via RelayerClient.
 *     tags: [Trading]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - privyUserId
 *               - marketInfo
 *               - size
 *               - price
 *             properties:
 *               privyUserId:
 *                 type: string
 *                 description: Privy user ID
 *                 example: "did:privy:cmj921f4201dql40c3nubss93"
 *               userJwt:
 *                 type: string
 *                 description: Optional user JWT token for session signer
 *               marketInfo:
 *                 type: object
 *                 required:
 *                   - marketId
 *                   - clobTokenId
 *                   - outcome
 *                 properties:
 *                   marketId:
 *                     type: string
 *                     example: "0x123..."
 *                   marketQuestion:
 *                     type: string
 *                     example: "Will Team A win?"
 *                   clobTokenId:
 *                     type: string
 *                     description: CLOB token ID for the specific outcome
 *                     example: "16678291189211314787145083999015737376658799626130630684070927984975568281601"
 *                   outcome:
 *                     type: string
 *                     example: "Yes"
 *                   metadata:
 *                     type: object
 *                     description: Additional market metadata
 *               orderType:
 *                 type: string
 *                 enum: [FOK, FAK]
 *                 default: FOK
 *                 description: Order type - FOK (Fill or Kill) or FAK (Fill and Kill)
 *               size:
 *                 type: string
 *                 description: Number of shares to sell (e.g., "10" = 10 shares). Backend calculates USDC amount = shares * price.
 *                 example: "10"
 *               price:
 *                 type: string
 *                 description: Price per share (0-1). Required for all order types to calculate USDC amount.
 *                 example: "0.5"
 *     responses:
 *       200:
 *         description: Trade executed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 orderId:
 *                   type: string
 *                 transactionHash:
 *                   type: string
 *                 status:
 *                   type: string
 *                 trade:
 *                   $ref: '#/components/schemas/TradeRecord'
 *       400:
 *         description: Invalid request or insufficient approvals
 *       404:
 *         description: User not found
 *       500:
 *         description: Internal server error
 */
router.post('/sell', async (req: Request, res: Response) => {
  // Log immediately when request arrives
  logger.info({
    message: '🔴 SELL ENDPOINT HIT - Request received',
    timestamp: new Date().toISOString(),
    contentLength: req.headers['content-length'],
    contentType: req.headers['content-type'],
    hasBody: !!req.body,
    bodyKeys: req.body ? Object.keys(req.body) : [],
  });
  
  try {
    const {
      privyUserId,
      userJwt,
      marketInfo,
      orderType = 'FOK',
      size,
      price,
    } = req.body;

    // Validate required fields
    if (!privyUserId || !marketInfo || !size || !price) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: privyUserId, marketInfo, size, price',
      });
    }

    if (!marketInfo.clobTokenId || !marketInfo.outcome) {
      return res.status(400).json({
        success: false,
        message: 'marketInfo must include clobTokenId and outcome',
      });
    }

    const tradeRequest: CreateTradeRequest = {
      privyUserId,
      userJwt,
      marketInfo,
      side: TradeSide.SELL,
      orderType: orderType === 'FAK' ? OrderType.FAK : OrderType.FOK,
      size: String(size),
      price: String(price),
    };

    const result = await executeTrade(tradeRequest);

    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.status(200).json(result);
  } catch (error) {
    logger.error({
      message: 'Error in sell endpoint',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * @swagger
 * /api/trading/history:
 *   get:
 *     summary: Get trade history for a user
 *     description: Retrieve trade history with optional filtering
 *     tags: [Trading]
 *     parameters:
 *       - in: query
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: Privy user ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of trades to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of trades to skip
 *       - in: query
 *         name: side
 *         schema:
 *           type: string
 *           enum: [BUY, SELL]
 *         description: Filter by trade side
 *       - in: query
 *         name: marketId
 *         schema:
 *           type: string
 *         description: Filter by market ID
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, FILLED, PARTIALLY_FILLED, CANCELLED, FAILED]
 *         description: Filter by trade status
 *     responses:
 *       200:
 *         description: Trade history retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 trades:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/TradeRecord'
 *                 total:
 *                   type: integer
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Internal server error
 */
router.get('/history', async (req: Request, res: Response) => {
  try {
    const { privyUserId, limit, offset, side, marketId, status } = req.query;

    if (!privyUserId) {
      return res.status(400).json({
        success: false,
        message: 'privyUserId is required',
      });
    }

    const query: TradeHistoryQuery = {
      privyUserId: String(privyUserId),
      limit: limit ? parseInt(String(limit), 10) : undefined,
      offset: offset ? parseInt(String(offset), 10) : undefined,
      side: side ? (side as TradeSide) : undefined,
      marketId: marketId ? String(marketId) : undefined,
      status: status ? String(status) : undefined,
    };

    const trades = await getTradeHistory(query);

    return res.status(200).json({
      success: true,
      trades,
      total: trades.length,
    });
  } catch (error) {
    logger.error({
      message: 'Error in trade history endpoint',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

// ==================== REDEMPTION ENDPOINTS ====================

import {
  getRedeemablePositions,
  redeemPosition,
  redeemAllPositions,
} from '../services/polymarket/trading/redemption.service';

/**
 * @swagger
 * /api/trading/redeem/available:
 *   get:
 *     summary: Get redeemable positions
 *     description: Returns all positions that can be redeemed (winning positions from resolved markets)
 *     tags: [Trading]
 *     parameters:
 *       - in: query
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: User's Privy ID
 *     responses:
 *       200:
 *         description: Redeemable positions retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 positions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       asset:
 *                         type: string
 *                       conditionId:
 *                         type: string
 *                       size:
 *                         type: string
 *                       currentValue:
 *                         type: string
 *                       title:
 *                         type: string
 *                       outcome:
 *                         type: string
 *                 totalRedeemable:
 *                   type: number
 *       400:
 *         description: Missing privyUserId
 *       500:
 *         description: Internal server error
 */
router.get('/redeem/available', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.query;

    if (!privyUserId) {
      return res.status(400).json({
        success: false,
        message: 'privyUserId is required',
      });
    }

    const positions = await getRedeemablePositions(String(privyUserId));
    const totalRedeemable = positions.reduce((sum, p) => sum + parseFloat(p.currentValue), 0);

    return res.status(200).json({
      success: true,
      positions,
      totalRedeemable: totalRedeemable.toFixed(6),
      count: positions.length,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching redeemable positions',
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * @swagger
 * /api/trading/redeem:
 *   post:
 *     summary: Redeem a single position
 *     description: Redeems a winning position for USDC. The position must be redeemable (market resolved, winning outcome).
 *     tags: [Trading]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - privyUserId
 *               - conditionId
 *             properties:
 *               privyUserId:
 *                 type: string
 *                 description: User's Privy ID
 *               conditionId:
 *                 type: string
 *                 description: The condition ID of the position to redeem
 *     responses:
 *       200:
 *         description: Redemption successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 transactionHash:
 *                   type: string
 *                 redemptionId:
 *                   type: string
 *                 redeemedAmount:
 *                   type: string
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Redemption failed
 */
router.post('/redeem', async (req: Request, res: Response) => {
  try {
    const { privyUserId, conditionId } = req.body;

    if (!privyUserId) {
      return res.status(400).json({
        success: false,
        message: 'privyUserId is required',
      });
    }

    if (!conditionId) {
      return res.status(400).json({
        success: false,
        message: 'conditionId is required',
      });
    }

    logger.info({
      message: 'Redemption request received',
      privyUserId,
      conditionId,
    });

    const result = await redeemPosition(String(privyUserId), String(conditionId));

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error,
        redemptionId: result.redemptionId,
      });
    }

    return res.status(200).json({
      success: true,
      transactionHash: result.transactionHash,
      redemptionId: result.redemptionId,
      redeemedAmount: result.redeemedAmount,
    });
  } catch (error) {
    logger.error({
      message: 'Error in redemption endpoint',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * @swagger
 * /api/trading/redeem/all:
 *   post:
 *     summary: Redeem all redeemable positions
 *     description: Redeems all winning positions for USDC at once. Returns results for each position.
 *     tags: [Trading]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - privyUserId
 *             properties:
 *               privyUserId:
 *                 type: string
 *                 description: User's Privy ID
 *     responses:
 *       200:
 *         description: Batch redemption completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 totalRedeemed:
 *                   type: integer
 *                 totalAmount:
 *                   type: string
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       conditionId:
 *                         type: string
 *                       title:
 *                         type: string
 *                       outcome:
 *                         type: string
 *                       success:
 *                         type: boolean
 *                       transactionHash:
 *                         type: string
 *                       redeemedAmount:
 *                         type: string
 *                       error:
 *                         type: string
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Internal server error
 */
router.post('/redeem/all', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.body;

    if (!privyUserId) {
      return res.status(400).json({
        success: false,
        message: 'privyUserId is required',
      });
    }

    logger.info({
      message: 'Batch redemption request received',
      privyUserId,
    });

    const result = await redeemAllPositions(String(privyUserId));

    return res.status(200).json({
      success: result.success,
      totalRedeemed: result.totalRedeemed,
      totalAmount: result.totalAmount,
      results: result.results,
    });
  } catch (error) {
    logger.error({
      message: 'Error in batch redemption endpoint',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

export default router;
