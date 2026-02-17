/**
 * Unit Tests for DFlow Client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');
vi.mock('../../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('DFlow Client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DFLOW_API_KEY', 'test-key');
  });

  it('should build buy order request with correct params', async () => {
    const mockGet = vi.fn().mockResolvedValue({
      data: { transaction: 'base64tx', orderId: 'ord-1' },
    });
    vi.mocked(axios.create).mockReturnValue({
      get: mockGet,
      post: vi.fn(),
    } as any);

    const { dflowClient } = await import('./dflow.client');
    await dflowClient.getBuyOrder({
      inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      outputMint: 'Token1111111111111111111111111111111111111',
      amount: '1000000',
      userPublicKey: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
      slippageBps: 50,
    });

    expect(mockGet).toHaveBeenCalled();
    const callUrl = mockGet.mock.calls[0][0];
    expect(callUrl).toContain('/order');
    expect(callUrl).toContain('inputMint');
    expect(callUrl).toContain('outputMint');
    expect(callUrl).toContain('amount=1000000');
    expect(callUrl).toContain('slippageBps=50');
  });

  it('should return transaction from getBuyOrder response', async () => {
    const mockGet = vi.fn().mockResolvedValue({
      data: {
        transaction: 'serialized-tx-base64',
        orderId: 'ord-123',
        outAmount: '1000000',
      },
    });
    vi.mocked(axios.create).mockReturnValue({
      get: mockGet,
      post: vi.fn(),
    } as any);

    const { dflowClient } = await import('./dflow.client');
    const result = await dflowClient.getBuyOrder({
      inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      outputMint: 'Token1111111111111111111111111111111111111',
      amount: '1000000',
      userPublicKey: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
    });

    expect(result.transaction).toBe('serialized-tx-base64');
    expect(result.outAmount).toBeDefined();
  });

  it('isConfigured should return true when DFLOW_API_KEY set', async () => {
    vi.stubEnv('DFLOW_API_KEY', 'has-key');
    const { dflowClient } = await import('./dflow.client');
    expect(dflowClient.isConfigured()).toBe(true);
  });
});
