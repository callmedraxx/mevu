/**
 * Integration tests for Kalshi Trading routes
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.stubEnv('GEO_ENFORCEMENT_ENABLED', 'false');
vi.stubEnv('KALSHI_TRADING_ENABLED', 'false');

vi.mock('../services/privy/user.service', () => ({ getUserByPrivyId: vi.fn() }));
vi.mock('../services/kalshi/kalshi-trading.service', () => ({ executeKalshiBuy: vi.fn(), executeKalshiSell: vi.fn() }));
vi.mock('../services/kalshi/kalshi-redemption.service', () => ({ redeemKalshiPosition: vi.fn(), getRedeemablePositions: vi.fn().mockResolvedValue([]) }));
vi.mock('../services/onramp/onramp.service', () => ({ createOnrampSession: vi.fn().mockResolvedValue({ provider: 'moonpay', widgetUrl: 'https://buy.moonpay.com' }) }));
vi.mock('../services/onramp/onramp-webhook.service', () => ({ handleOnrampWebhook: vi.fn().mockResolvedValue({ success: true }) }));

let kalshiTradingRouter: import('express').Router;
beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import('./kalshi-trading');
  kalshiTradingRouter = mod.default;
});

function appWithRouter() {
  const a = express();
  a.use(express.json());
  a.use('/api/kalshi-trading', kalshiTradingRouter);
  return a;
}

describe('Kalshi Trading Routes', () => {
  it('GET /balance returns 400 when privyUserId missing', async () => {
    const res = await request(appWithRouter()).get('/api/kalshi-trading/balance').expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('privyUserId');
  });

  it('GET /balance returns balance when user found', async () => {
    const { getUserByPrivyId } = await import('../services/privy/user.service');
    vi.mocked(getUserByPrivyId).mockResolvedValue({ kalshiUsdcBalance: '1000000' } as never);
    const res = await request(appWithRouter()).get('/api/kalshi-trading/balance').query({ privyUserId: 'did:privy:u1' }).expect(200);
    expect(res.body.balance).toBe('1000000');
  });

  it('GET /history returns 400 when privyUserId missing', async () => {
    const res = await request(appWithRouter()).get('/api/kalshi-trading/history').expect(400);
    expect(res.body.success).toBe(false);
  });

  it('POST /buy returns 503 when Kalshi trading disabled', async () => {
    const res = await request(appWithRouter())
      .post('/api/kalshi-trading/buy')
      .send({ privyUserId: 'did:privy:u1', kalshiTicker: 'KXNBAGAME', outcome: 'YES', usdcAmount: '1000000' })
      .expect(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('disabled');
  });

  it('POST /deposit/onramp returns 400 when privyUserId missing', async () => {
    const res = await request(appWithRouter()).post('/api/kalshi-trading/deposit/onramp').send({}).expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('privyUserId');
  });

  it('POST /deposit/onramp returns widget when user has Solana wallet', async () => {
    const { getUserByPrivyId } = await import('../services/privy/user.service');
    vi.mocked(getUserByPrivyId).mockResolvedValue({ solanaWalletAddress: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' } as never);
    const res = await request(appWithRouter()).post('/api/kalshi-trading/deposit/onramp').send({ privyUserId: 'did:privy:u1' }).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.widgetUrl).toBeDefined();
  });
});
