/**
 * Kalshi Trading API Routes
 * US-only, geo-enforced routes for Kalshi trading via DFlow
 */

import { Router, Request, Response } from 'express';
import { geoDetectMiddleware, requireKalshiRegion } from '../middleware/geo-detect.middleware';
import { executeKalshiBuy, executeKalshiSell } from '../services/kalshi/kalshi-trading.service';
import { redeemKalshiPosition, getRedeemablePositions } from '../services/kalshi/kalshi-redemption.service';
import { getUserByPrivyId } from '../services/privy/user.service';
import { createOnrampSession } from '../services/onramp/onramp.service';
import { handleOnrampWebhook } from '../services/onramp/onramp-webhook.service';
import { pool, getDatabaseConfig } from '../config/database';

const router = Router();
const KALSHI_ENABLED = process.env.KALSHI_TRADING_ENABLED === 'true';

router.use(geoDetectMiddleware);
router.use(requireKalshiRegion);

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
  const balance = user?.kalshiUsdcBalance ?? '0';
  return res.json({ balance });
});

router.post('/deposit/onramp', async (req: Request, res: Response) => {
  const privyUserId = req.body.privyUserId as string;
  if (!privyUserId) return res.status(400).json({ success: false, error: 'Missing privyUserId' });
  const user = await getUserByPrivyId(privyUserId);
  const solanaWallet = (user as any)?.solanaWalletAddress;
  if (!solanaWallet) return res.status(400).json({ success: false, error: 'User has no Solana wallet' });
  const result = await createOnrampSession(solanaWallet, privyUserId);
  return res.json({ success: true, ...result });
});

router.post('/deposit/webhook', async (req: Request, res: Response) => {
  const signature = req.headers['x-webhook-signature'] as string;
  const result = await handleOnrampWebhook(req.body, signature);
  return res.status(result.success ? 200 : 400).json(result);
});

export default router;
