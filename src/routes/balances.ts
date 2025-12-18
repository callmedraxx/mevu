/**
 * Balance API Routes
 * Handles USDC.e balance tracking using Alchemy API
 * Real-time updates are handled via Alchemy webhooks
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
