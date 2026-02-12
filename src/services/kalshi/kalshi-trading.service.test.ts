/**
 * Unit tests for Kalshi Trading Service
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('KALSHI_TRADING_ENABLED', 'true');

vi.mock('../../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../privy/user.service', () => ({
  getUserByPrivyId: vi.fn(),
}));

vi.mock('../dflow/dflow.client', () => ({
  createBuyOrder: vi.fn(),
  createSellOrder: vi.fn(),
}));

vi.mock('../dflow/dflow-metadata.service', () => ({
  getOutcomeMint: vi.fn(),
}));

describe('Kalshi Trading Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('KALSHI_TRADING_ENABLED', 'true');
  });

  it('executeKalshiBuy returns error when user not found', async () => {
    const { getUserByPrivyId } = await import('../privy/user.service');
    vi.mocked(getUserByPrivyId).mockResolvedValue(null);

    const { executeKalshiBuy } = await import('./kalshi-trading.service');
    const result = await executeKalshiBuy({
      privyUserId: 'did:privy:nonexistent',
      kalshiTicker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
      outcome: 'YES',
      usdcAmount: '1000000',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('User not found');
  });

  it('executeKalshiBuy returns error when user has no Solana wallet', async () => {
    vi.stubEnv('KALSHI_TRADING_ENABLED', 'true');
    const { getUserByPrivyId } = await import('../privy/user.service');
    vi.mocked(getUserByPrivyId).mockResolvedValue({ id: '1' } as never);

    const { executeKalshiBuy } = await import('./kalshi-trading.service');
    const result = await executeKalshiBuy({
      privyUserId: 'did:privy:u1',
      kalshiTicker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
      outcome: 'YES',
      usdcAmount: '1000000',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Solana wallet');
  });
});
