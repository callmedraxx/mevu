import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../privy/kalshi-user.service', () => ({
  updateUserKalshiUsdcBalance: vi.fn().mockResolvedValue(true),
}));

vi.mock('../privy/user.service', () => ({
  getUserByPrivyId: vi.fn(),
}));

vi.mock('../redis-cluster-broadcast.service', () => ({
  publishKalshiPositionUpdate: vi.fn(),
}));

describe('Onramp Webhook Service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns success for completed deposit', async () => {
    const { getUserByPrivyId } = await import('../privy/user.service');
    vi.mocked(getUserByPrivyId).mockResolvedValue({ id: '1' } as any);
    const { handleOnrampWebhook } = await import('./onramp-webhook.service');
    const result = await handleOnrampWebhook({
      provider: 'moonpay',
      privyUserId: 'did:privy:u1',
      amount: '1000000',
      status: 'completed',
    });
    expect(result.success).toBe(true);
  });

  it('skips non-completed status', async () => {
    const { handleOnrampWebhook } = await import('./onramp-webhook.service');
    const result = await handleOnrampWebhook({
      provider: 'moonpay',
      privyUserId: 'did:privy:u1',
      amount: '1000000',
      status: 'pending',
    });
    expect(result.success).toBe(true);
  });

  it('returns error when user not found', async () => {
    const { getUserByPrivyId } = await import('../privy/user.service');
    vi.mocked(getUserByPrivyId).mockResolvedValue(null);
    const { handleOnrampWebhook } = await import('./onramp-webhook.service');
    const result = await handleOnrampWebhook({
      provider: 'moonpay',
      privyUserId: 'did:privy:nonexistent',
      amount: '1000000',
      status: 'completed',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('User not found');
  });
});
