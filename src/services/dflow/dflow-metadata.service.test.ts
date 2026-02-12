/**
 * Unit Tests for DFlow Metadata Service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/database', () => ({
  pool: {
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }),
  },
  getDatabaseConfig: vi.fn().mockReturnValue({ type: 'postgres' }),
}));

vi.mock('../../utils/cache', () => ({
  getCache: vi.fn().mockResolvedValue(null),
  setCache: vi.fn().mockResolvedValue('OK'),
}));

vi.mock('../../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('DFlow Metadata Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DFLOW_API_KEY', 'test-key');
  });

  it('getOutcomeMint should return yesMint for YES', async () => {
    const { dflowMetadataService } = await import('./dflow-metadata.service');
    const { pool } = await import('../../config/database');
    const { getCache } = await import('../../utils/cache');

    vi.mocked(getCache).mockResolvedValue(
      JSON.stringify({
        kalshiTicker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
        yesMint: 'YesMint111',
        noMint: 'NoMint111',
        settlementMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      })
    );

    const mint = await dflowMetadataService.getOutcomeMint(
      'KXNBAGAME-26FEB05CHAHOU-CHA',
      'YES'
    );
    expect(mint).toBe('YesMint111');
  });

  it('getOutcomeMint should return noMint for NO', async () => {
    const { dflowMetadataService } = await import('./dflow-metadata.service');
    const { getCache } = await import('../../utils/cache');

    vi.mocked(getCache).mockResolvedValue(
      JSON.stringify({
        kalshiTicker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
        yesMint: 'YesMint111',
        noMint: 'NoMint111',
        settlementMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      })
    );

    const mint = await dflowMetadataService.getOutcomeMint(
      'KXNBAGAME-26FEB05CHAHOU-CHA',
      'NO'
    );
    expect(mint).toBe('NoMint111');
  });

  it('getMapping should return null when not in cache or DB', async () => {
    const { dflowMetadataService } = await import('./dflow-metadata.service');
    const { getCache } = await import('../../utils/cache');
    vi.mocked(getCache).mockResolvedValue(null);

    const mapping = await dflowMetadataService.getMapping('UNKNOWN-TICKER');
    expect(mapping).toBeNull();
  });

  it('isEnabled should return true when DFLOW_API_KEY set', async () => {
    vi.stubEnv('DFLOW_API_KEY', 'key');
    const { dflowMetadataService } = await import('./dflow-metadata.service');
    expect(dflowMetadataService.isEnabled()).toBe(true);
  });
});
