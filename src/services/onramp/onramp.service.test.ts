/**
 * Unit Tests for Onramp Service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Onramp Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('createOnrampSession returns widget URL with wallet address', async () => {
    vi.stubEnv('ONRAMP_API_KEY', '');
    vi.stubEnv('ONRAMP_PROVIDER', 'moonpay');
    const { createOnrampSession } = await import('./onramp.service');

    const result = await createOnrampSession('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs');

    expect(result.provider).toBe('moonpay');
    expect(result.widgetUrl).toContain('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs');
    expect(result.widgetUrl).toContain('usdc');
  });

  it('createOnrampSession with privyUserId includes externalTransactionId when API key set', async () => {
    vi.stubEnv('ONRAMP_API_KEY', 'pk_test_123');
    vi.stubEnv('ONRAMP_PROVIDER', 'moonpay');
    vi.resetModules();
    const { createOnrampSession } = await import('./onramp.service');
    const result = await createOnrampSession('addr123', 'did:privy:u1');
    expect(result.widgetUrl).toContain('externalTransactionId');
    expect(result.widgetUrl).toContain('did%3Aprivy%3Au1');
  });

  it('createOnrampSession with API key includes apiKey param', async () => {
    vi.stubEnv('ONRAMP_API_KEY', 'pk_test_123');
    vi.stubEnv('ONRAMP_PROVIDER', 'moonpay');
    vi.resetModules();
    const { createOnrampSession } = await import('./onramp.service');
    const result = await createOnrampSession('addr123');
    expect(result.widgetUrl).toContain('apiKey=pk_test_123');
    expect(result.widgetUrl).toContain('walletAddress=addr123');
  });
});
