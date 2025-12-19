/**
 * Balance API Routes
 * Handles USDC.e balance tracking using Alchemy API
 * Real-time updates are handled via Alchemy webhooks
 * 
 * @swagger
 * tags:
 *   - name: Balances
 *     description: USDC.e balance tracking and transfer history
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { getUserByPrivyId } from '../services/privy/user.service';
import { alchemyWebhookService } from '../services/alchemy/alchemy-webhook.service';
import { refreshAndUpdateBalance } from '../services/alchemy/balance.service';
import { pool } from '../config/database';

const router = Router();

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error) || 'Unknown error';
}

/**
 * @swagger
 * /api/balances/stream/{privyUserId}:
 *   get:
 *     summary: Stream real-time balance updates via SSE
 *     description: Opens an SSE connection for real-time balance updates when deposits/withdrawals occur
 *     tags: [Balances]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: User's Privy ID
 *         example: "did:privy:clx1234567890"
 *     responses:
 *       200:
 *         description: SSE stream opened
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       404:
 *         description: User not found
 *       400:
 *         description: User has no proxy wallet
 */
router.get('/stream/:privyUserId', async (req: Request, res: Response) => {
  const { privyUserId } = req.params;

  try {
    const user = await getUserByPrivyId(privyUserId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    if (!user.proxyWalletAddress) return res.status(400).json({ success: false, error: 'No proxy wallet' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Only read from database - no Alchemy fetch (balance updated by webhooks/trades)
    const dbResult = await pool.query(
      'SELECT balance_raw, balance_human FROM wallet_balances WHERE proxy_wallet_address = $1',
      [user.proxyWalletAddress.toLowerCase()]
    );
    const currentBalance = dbResult.rows.length > 0
      ? { balanceRaw: dbResult.rows[0].balance_raw, balanceHuman: dbResult.rows[0].balance_human.toString() }
      : { balanceRaw: '0', balanceHuman: '0' };

    res.write(`data: ${JSON.stringify({ type: 'snapshot', balance: currentBalance.balanceRaw, humanBalance: currentBalance.balanceHuman })}\n\n`);

    const unsubscribe = alchemyWebhookService.subscribeToDeposits(privyUserId, (notification) => {
      try {
        res.write(`data: ${JSON.stringify({ type: notification.type, balance: notification.newBalance, humanBalance: notification.newBalance, amount: notification.amount, txHash: notification.txHash })}\n\n`);
      } catch (error) {
        logger.error({ message: 'Error writing to SSE', error: extractErrorMessage(error) });
      }
    });

    const heartbeatInterval = setInterval(() => {
      try { res.write(`: heartbeat\n\n`); } catch { clearInterval(heartbeatInterval); unsubscribe(); }
    }, 30000);

    req.on('close', () => { clearInterval(heartbeatInterval); unsubscribe(); res.end(); });
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ success: false, error: extractErrorMessage(error) });
  }
});

/**
 * @swagger
 * /api/balances/{privyUserId}:
 *   get:
 *     summary: Get current USDC.e balance
 *     description: Returns the user's current USDC.e balance from the database. Balance is updated by webhooks and after trades.
 *     tags: [Balances]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: User's Privy ID
 *         example: "did:privy:clx1234567890"
 *     responses:
 *       200:
 *         description: Balance retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 balance:
 *                   type: string
 *                   description: Raw balance (wei)
 *                   example: "1000000"
 *                 humanBalance:
 *                   type: string
 *                   description: Human-readable balance (USDC)
 *                   example: "1.00"
 *                 source:
 *                   type: string
 *                   example: "database"
 *                 lastUpdated:
 *                   type: string
 *                   format: date-time
 *                 proxyWalletAddress:
 *                   type: string
 *                   example: "0x1234..."
 *       404:
 *         description: User not found
 *       400:
 *         description: User has no proxy wallet
 */
router.get('/:privyUserId', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.params;
    const user = await getUserByPrivyId(privyUserId);

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    if (!user.proxyWalletAddress) return res.status(400).json({ success: false, error: 'No proxy wallet' });

    // Only read from database - no polling. Balance is updated by:
    // 1. Alchemy webhooks (deposits/withdrawals)
    // 2. After successful trades (buy/sell)
    const dbResult = await pool.query(
      'SELECT balance_raw, balance_human, last_updated_at FROM wallet_balances WHERE LOWER(proxy_wallet_address) = LOWER($1)',
      [user.proxyWalletAddress]
    );
    
    const balance = dbResult.rows.length > 0
      ? { balanceRaw: dbResult.rows[0].balance_raw, balanceHuman: dbResult.rows[0].balance_human.toString() }
      : { balanceRaw: '0', balanceHuman: '0' };
    
    const lastUpdated = dbResult.rows.length > 0 ? dbResult.rows[0].last_updated_at : null;

    res.json({ 
      success: true, 
      balance: balance.balanceRaw, 
      humanBalance: balance.balanceHuman, 
      source: 'database',
      lastUpdated,
      proxyWalletAddress: user.proxyWalletAddress 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: extractErrorMessage(error) });
  }
});

/**
 * @swagger
 * /api/balances/{privyUserId}/refresh:
 *   post:
 *     summary: Force refresh balance from Alchemy
 *     description: Fetches the latest balance from Alchemy API and updates the database. Use this to manually sync balance.
 *     tags: [Balances]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: User's Privy ID
 *         example: "did:privy:clx1234567890"
 *     responses:
 *       200:
 *         description: Balance refreshed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 balance:
 *                   type: string
 *                   description: Raw balance (wei)
 *                   example: "1000000"
 *                 humanBalance:
 *                   type: string
 *                   description: Human-readable balance (USDC)
 *                   example: "1.00"
 *                 proxyWalletAddress:
 *                   type: string
 *                   example: "0x1234..."
 *       404:
 *         description: User not found
 *       400:
 *         description: User has no proxy wallet
 *       500:
 *         description: Error refreshing balance
 */
router.post('/:privyUserId/refresh', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.params;
    const user = await getUserByPrivyId(privyUserId);

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    if (!user.proxyWalletAddress) return res.status(400).json({ success: false, error: 'No proxy wallet' });

    // Manual refresh - fetches from Alchemy and updates DB
    const balance = await refreshAndUpdateBalance(user.proxyWalletAddress, privyUserId);

    logger.info({
      message: 'Balance manually refreshed',
      privyUserId,
      proxyWalletAddress: user.proxyWalletAddress,
      balance: balance.balanceHuman,
    });

    res.json({ success: true, balance: balance.balanceRaw, humanBalance: balance.balanceHuman, proxyWalletAddress: user.proxyWalletAddress });
  } catch (error) {
    logger.error({ message: 'Error refreshing balance', error: extractErrorMessage(error) });
    res.status(500).json({ success: false, error: extractErrorMessage(error) });
  }
});

/**
 * @swagger
 * /api/balances/{privyUserId}/transfers:
 *   get:
 *     summary: Get transfer history
 *     description: Returns all USDC.e transfers (deposits and withdrawals) for the user
 *     tags: [Balances]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: User's Privy ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Max transfers to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number to skip
 *     responses:
 *       200:
 *         description: Transfer history retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 transfers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       transfer_type:
 *                         type: string
 *                         enum: [in, out]
 *                       from_address:
 *                         type: string
 *                       to_address:
 *                         type: string
 *                       amount_human:
 *                         type: string
 *                       transaction_hash:
 *                         type: string
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                 count:
 *                   type: integer
 *       404:
 *         description: User not found
 */
router.get('/:privyUserId/transfers', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const user = await getUserByPrivyId(privyUserId);

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    if (!user.proxyWalletAddress) return res.status(400).json({ success: false, error: 'No proxy wallet' });

    const result = await pool.query(
      `SELECT transfer_type, from_address, to_address, amount_raw, amount_human, transaction_hash, block_number, created_at
       FROM wallet_usdc_transfers WHERE LOWER(proxy_wallet_address) = LOWER($1) ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [user.proxyWalletAddress, limit, offset]
    );

    res.json({ success: true, transfers: result.rows, count: result.rows.length, limit, offset });
  } catch (error) {
    res.status(500).json({ success: false, error: extractErrorMessage(error) });
  }
});

/**
 * @swagger
 * /api/balances/{privyUserId}/deposits:
 *   get:
 *     summary: Get deposit history only
 *     description: Returns only incoming USDC.e transfers (deposits)
 *     tags: [Balances]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: User's Privy ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Deposit history retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 deposits:
 *                   type: array
 *                   items:
 *                     type: object
 *                 count:
 *                   type: integer
 *       404:
 *         description: User not found
 */
router.get('/:privyUserId/deposits', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const user = await getUserByPrivyId(privyUserId);

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    if (!user.proxyWalletAddress) return res.status(400).json({ success: false, error: 'No proxy wallet' });

    const result = await pool.query(
      `SELECT transfer_type, from_address, to_address, amount_raw, amount_human, transaction_hash, block_number, created_at
       FROM wallet_usdc_transfers WHERE LOWER(proxy_wallet_address) = LOWER($1) AND transfer_type = 'in' ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [user.proxyWalletAddress, limit, offset]
    );

    res.json({ success: true, deposits: result.rows, count: result.rows.length, limit, offset });
  } catch (error) {
    res.status(500).json({ success: false, error: extractErrorMessage(error) });
  }
});

export default router;
