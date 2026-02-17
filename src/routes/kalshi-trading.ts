/**
 * Kalshi Trading API Routes
 * US-only, geo-enforced routes for Kalshi trading via DFlow
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { geoDetectMiddleware, requireKalshiRegion } from '../middleware/geo-detect.middleware';
import { executeKalshiBuy, executeKalshiSell } from '../services/kalshi/kalshi-trading.service';
import { dflowMetadataService } from '../services/dflow/dflow-metadata.service';
import { redeemKalshiPosition, getRedeemablePositions } from '../services/kalshi/kalshi-redemption.service';
import { getUserByPrivyId } from '../services/privy/user.service';
import { handleOnrampWebhook } from '../services/onramp/onramp-webhook.service';
import { subscribeToKalshiUserBroadcast } from '../services/redis-cluster-broadcast.service';
import { pool, getDatabaseConfig } from '../config/database';
import { getSolanaUsdcBalance } from '../services/solana/solana-usdc-balance';
import { setKalshiUsdcBalance } from '../services/privy/kalshi-user.service';

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error) || 'Unknown error';
}

const router = Router();
const KALSHI_ENABLED = process.env.KALSHI_TRADING_ENABLED === 'true';

router.use(geoDetectMiddleware);
router.use(requireKalshiRegion);

/**
 * GET /api/kalshi-trading/available-markets
 * Returns Kalshi tickers with cached DFlow mappings.
 * Mappings are populated on-demand when users trade — no bulk sync needed.
 */
router.get('/available-markets', async (_req: Request, res: Response) => {
  const tickers = await dflowMetadataService.listCachedTickers();
  return res.json({ tickers, count: tickers.length });
});

router.post('/buy', async (req: Request, res: Response) => {
  if (!KALSHI_ENABLED) return res.status(503).json({ success: false, error: 'Kalshi trading disabled' });
  const { privyUserId, kalshiTicker, outcome, usdcAmount, slippageBps } = req.body;
  if (!privyUserId || !kalshiTicker || !outcome || !usdcAmount) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  const result = await executeKalshiBuy({ privyUserId, kalshiTicker, outcome, usdcAmount, slippageBps });
  return res.status(result.success ? 200 : 400).json(result);
});

router.post('/sell', async (req: Request, res: Response) => {
  if (!KALSHI_ENABLED) return res.status(503).json({ success: false, error: 'Kalshi trading disabled' });
  const { privyUserId, kalshiTicker, outcome, tokenAmount, slippageBps } = req.body;
  if (!privyUserId || !kalshiTicker || !outcome || !tokenAmount) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  const result = await executeKalshiSell({ privyUserId, kalshiTicker, outcome, tokenAmount, slippageBps });
  return res.status(result.success ? 200 : 400).json(result);
});

router.get('/history', async (req: Request, res: Response) => {
  const privyUserId = req.query.privyUserId as string;
  if (!privyUserId) return res.status(400).json({ success: false, error: 'Missing privyUserId' });
  if (getDatabaseConfig().type !== 'postgres') return res.json({ trades: [] });
  const client = await pool.connect();
  try {
    const r = await client.query(
      'SELECT * FROM kalshi_trades_history WHERE privy_user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [privyUserId]
    );
    return res.json({ trades: r.rows });
  } finally {
    client.release();
  }
});

router.get('/positions', async (req: Request, res: Response) => {
  const privyUserId = req.query.privyUserId as string;
  if (!privyUserId) return res.status(400).json({ success: false, error: 'Missing privyUserId' });
  if (getDatabaseConfig().type !== 'postgres') return res.json({ positions: [] });
  const client = await pool.connect();
  try {
    const r = await client.query(
      'SELECT * FROM kalshi_positions WHERE privy_user_id = $1',
      [privyUserId]
    );
    return res.json({ positions: r.rows });
  } finally {
    client.release();
  }
});

/**
 * GET /api/kalshi-trading/portfolio
 * Portfolio summary for Kalshi (USDC balance + positions cost basis).
 * Use when platform toggle is kalshi - display instead of Polymarket portfolio.
 */
router.get('/portfolio', async (req: Request, res: Response) => {
  const privyUserId = req.query.privyUserId as string;
  if (!privyUserId) return res.status(400).json({ success: false, error: 'Missing privyUserId' });
  if (getDatabaseConfig().type !== 'postgres') {
    return res.json({
      success: true,
      portfolio: 0,
      balance: '0',
      positions: [],
      totalPositions: 0,
    });
  }
  const user = await getUserByPrivyId(privyUserId);
  let balance = parseFloat(user?.kalshiUsdcBalance ?? '0') || 0;

  // Always use on-chain balance as source of truth
  const solanaAddress = (user as any)?.solanaWalletAddress;
  if (solanaAddress) {
    const onChainBalance = await getSolanaUsdcBalance(solanaAddress);
    const onChainNum = parseFloat(onChainBalance) || 0;
    if (Math.abs(onChainNum - balance) > 0.001) {
      await setKalshiUsdcBalance(privyUserId, onChainBalance);
    }
    balance = onChainNum;
  }

  const client = await pool.connect();
  try {
    const r = await client.query(
      'SELECT * FROM kalshi_positions WHERE privy_user_id = $1',
      [privyUserId]
    );
    const positions = r.rows;
    const positionsCost = positions.reduce((sum: number, p: { total_cost_usdc?: string | number }) => {
      const v = p.total_cost_usdc;
      return sum + (typeof v === 'string' ? parseFloat(v) : Number(v) || 0);
    }, 0);
    const portfolio = balance + positionsCost;
    return res.json({
      success: true,
      portfolio,
      balance: String(balance),
      positions,
      totalPositions: positions.length,
    });
  } finally {
    client.release();
  }
});

router.get('/positions/redeemable', async (req: Request, res: Response) => {
  const privyUserId = req.query.privyUserId as string;
  if (!privyUserId) return res.status(400).json({ success: false, error: 'Missing privyUserId' });
  const positions = await getRedeemablePositions(privyUserId);
  return res.json({ positions });
});

router.post('/redeem', async (req: Request, res: Response) => {
  const { privyUserId, outcomeMint } = req.body;
  if (!privyUserId || !outcomeMint) return res.status(400).json({ success: false, error: 'Missing privyUserId or outcomeMint' });
  const result = await redeemKalshiPosition(privyUserId, outcomeMint);
  return res.status(result.success ? 200 : 400).json(result);
});

router.post('/redeem/all', async (req: Request, res: Response) => {
  const { privyUserId } = req.body;
  if (!privyUserId) return res.status(400).json({ success: false, error: 'Missing privyUserId' });
  const positions = await getRedeemablePositions(privyUserId);
  const results = await Promise.all(positions.map((p: any) => redeemKalshiPosition(privyUserId, p.outcome_mint)));
  const successCount = results.filter((r) => r.success).length;
  return res.json({ success: true, redeemed: successCount, total: positions.length });
});

router.get('/balance', async (req: Request, res: Response) => {
  const privyUserId = req.query.privyUserId as string;
  if (!privyUserId) return res.status(400).json({ success: false, error: 'Missing privyUserId' });
  const user = await getUserByPrivyId(privyUserId);

  // Always use on-chain balance as source of truth (Alchemy Solana webhooks are unreliable)
  const solanaAddress = (user as any)?.solanaWalletAddress;
  if (solanaAddress) {
    const onChainBalance = await getSolanaUsdcBalance(solanaAddress);
    const dbBalance = parseFloat(user?.kalshiUsdcBalance ?? '0') || 0;
    const onChainNum = parseFloat(onChainBalance) || 0;
    // Sync to DB if different (avoid unnecessary writes)
    if (Math.abs(onChainNum - dbBalance) > 0.001) {
      await setKalshiUsdcBalance(privyUserId, onChainBalance);
    }
    return res.json({ balance: onChainBalance });
  }

  return res.json({ balance: user?.kalshiUsdcBalance ?? '0' });
});

/**
 * GET /api/kalshi-trading/balance/stream?privyUserId=...
 * SSE stream for real-time Kalshi USDC balance updates (deposits, withdrawals, trades).
 */
router.get('/balance/stream', async (req: Request, res: Response) => {
  const privyUserId = req.query.privyUserId as string;
  if (!privyUserId) return res.status(400).json({ success: false, error: 'Missing privyUserId' });

  try {
    const user = await getUserByPrivyId(privyUserId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    if (!(user as any).solanaWalletAddress) return res.status(400).json({ success: false, error: 'No Solana wallet' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const balance = (user as any).kalshiUsdcBalance ?? '0';
    res.write(`data: ${JSON.stringify({ type: 'snapshot', balance })}\n\n`);

    const unsubscribe = subscribeToKalshiUserBroadcast((msg) => {
      if (msg.privyUserId !== privyUserId) return;
      if (msg.type !== 'kalshi_position_update') return;
      const pos = msg.position as { type?: string };
      if (pos?.type !== 'balance_update') return;
      getUserByPrivyId(privyUserId).then((u) => {
        const newBalance = (u as any)?.kalshiUsdcBalance ?? '0';
        try {
          res.write(`data: ${JSON.stringify({ type: 'balance_update', balance: newBalance })}\n\n`);
        } catch (err) {
          logger.error({ message: 'Error writing Kalshi balance SSE', error: extractErrorMessage(err) });
        }
      }).catch(() => {});
    });

    const heartbeatInterval = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        clearInterval(heartbeatInterval);
        unsubscribe();
      }
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeatInterval);
      unsubscribe();
      res.end();
    });
  } catch (error) {
    if (!res.headersSent) {
      logger.error({ message: 'Error setting up Kalshi balance stream', error: extractErrorMessage(error) });
      res.status(500).json({ success: false, error: extractErrorMessage(error) });
    }
  }
});

/** Onramp disabled - Kalshi deposits use Privy MoonPay or crypto (send USDC to Solana address) */
router.post('/deposit/onramp', async (_req: Request, res: Response) => {
  return res.status(503).json({
    success: false,
    error: 'Onramp disabled. Use crypto deposit (send USDC to your Solana address) or Privy MoonPay.',
  });
});

router.post('/deposit/webhook', async (req: Request, res: Response) => {
  const signature = req.headers['x-webhook-signature'] as string;
  const result = await handleOnrampWebhook(req.body, signature);
  return res.status(result.success ? 200 : 400).json(result);
});

export default router;
