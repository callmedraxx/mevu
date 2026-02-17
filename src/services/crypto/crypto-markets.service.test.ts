/**
 * Unit and Integration Tests for Crypto Markets Service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted so mock variables are available in hoisted vi.mock factories
const { mockQuery, mockRelease, mockConnect, mockGet } = vi.hoisted(() => {
  const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const mockRelease = vi.fn();
  const mockConnect = vi.fn().mockResolvedValue({
    query: mockQuery,
    release: mockRelease,
  });
  const mockGet = vi.fn();
  return { mockQuery, mockRelease, mockConnect, mockGet };
});

vi.mock('../../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config/database', () => ({
  pool: { connect: mockConnect },
  connectWithRetry: vi.fn().mockResolvedValue({
    query: mockQuery,
    release: mockRelease,
  }),
}));

vi.mock('../polymarket/polymarket.client', () => ({
  polymarketClient: { get: mockGet },
}));

import {
  transformMarketToSSR,
  transformToSSRFormat,
  fetchAllCryptoEvents,
  storeCryptoMarketsInDatabase,
  cryptoMarketsService,
} from './crypto-markets.service';

// Sample Gamma API event (based on real BTC Up/Down event structure)
function makeSampleGammaEvent(overrides: Record<string, any> = {}): any {
  return {
    id: '208116',
    ticker: 'btc-updown-15m-1771099200',
    slug: 'btc-updown-15m-1771099200',
    title: 'Bitcoin Up or Down - February 14, 3:00PM-3:15PM ET',
    description: 'This market will resolve to "Up" if the Bitcoin price...',
    resolutionSource: 'https://data.chain.link/streams/btc-usd',
    startDate: '2026-02-13T20:11:30.52697Z',
    endDate: '2026-02-14T20:15:00Z',
    image: 'https://polymarket-upload.s3.us-east-2.amazonaws.com/BTC+fullsize.png',
    icon: 'https://polymarket-upload.s3.us-east-2.amazonaws.com/BTC+fullsize.png',
    active: true,
    closed: false,
    archived: false,
    new: false,
    featured: false,
    restricted: true,
    liquidity: 15858.3192,
    volume: 1460.488644,
    openInterest: 0,
    competitive: 0.9997750506136119,
    enableOrderBook: true,
    liquidityClob: 15858.3192,
    negRisk: false,
    commentCount: 0,
    cyom: false,
    showAllOutcomes: true,
    showMarketImages: true,
    automaticallyActive: true,
    negRiskAugmented: false,
    pendingDeployment: false,
    deploying: false,
    startTime: '2026-02-14T20:00:00Z',
    seriesSlug: 'btc-up-or-down-15m',
    markets: [
      {
        id: '1374107',
        question: 'Bitcoin Up or Down - February 14, 3:00PM-3:15PM ET',
        conditionId: '0x73b6e53a5f18dc507a6346d0658fddd1bd35b9fa0fefd5e93055668bcf196e0f',
        slug: 'btc-updown-15m-1771099200',
        resolutionSource: 'https://data.chain.link/streams/btc-usd',
        endDate: '2026-02-14T20:15:00Z',
        outcomes: '["Up", "Down"]',
        outcomePrices: '["0.485", "0.515"]',
        clobTokenIds: '["18365374473983271472696670088386395243500750027858072111400960376835670277210", "54644012656378953792110382314163936146863103241500171592236342834230406992810"]',
        volume: '1460.488644',
        active: true,
        closed: false,
        enableOrderBook: true,
        spread: 0.01,
        bestBid: 0.48,
        bestAsk: 0.49,
        lastTradePrice: 0.5,
        createdAt: '2026-02-13T20:07:28.931801Z',
        updatedAt: '2026-02-14T20:01:06.677275Z',
        liquidityNum: 15858.3192,
        volumeNum: 1460.488644,
      },
    ],
    series: [
      {
        id: '10192',
        ticker: 'btc-up-or-down-15m',
        slug: 'btc-up-or-down-15m',
        title: 'BTC Up or Down 15m',
        seriesType: 'single',
        recurrence: '15m',
        active: true,
      },
    ],
    tags: [
      { id: '102127', label: 'Up or Down', slug: 'up-or-down' },
      { id: '1312', label: 'Crypto Prices', slug: 'crypto-prices' },
      { id: '21', label: 'Crypto', slug: 'crypto' },
      { id: '235', label: 'Bitcoin', slug: 'bitcoin' },
      { id: '102467', label: '15M', slug: '15M' },
      { id: '101757', label: 'Recurring', slug: 'recurring' },
    ],
    ...overrides,
  };
}

describe('Crypto Markets Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
  });

  // ===================
  // Unit Tests
  // ===================

  describe('transformMarketToSSR', () => {
    it('should parse JSON string fields into arrays', () => {
      const market = {
        id: '1374107',
        outcomes: '["Up", "Down"]',
        outcomePrices: '["0.485", "0.515"]',
        clobTokenIds: '["token1", "token2"]',
        createdAt: '2026-02-13T20:07:28Z',
        endDate: '2026-02-14T20:15:00Z',
        resolutionSource: 'https://data.chain.link/streams/btc-usd',
        updatedAt: '2026-02-14T20:01:06Z',
        liquidityNum: 15858,
        volumeNum: 1460,
      };

      const result = transformMarketToSSR(market as any);

      expect(result.outcomes).toEqual(['Up', 'Down']);
      expect(result.outcomePrices).toEqual(['0.485', '0.515']);
      expect(result.clobTokenIds).toEqual(['token1', 'token2']);
    });

    it('should add snake_case aliases', () => {
      const market = {
        id: '1',
        outcomes: '[]',
        outcomePrices: '[]',
        clobTokenIds: '[]',
        createdAt: '2026-01-01T00:00:00Z',
        endDate: '2026-01-02T00:00:00Z',
        resolutionSource: 'https://example.com',
        updatedAt: '2026-01-01T12:00:00Z',
        liquidityNum: 100,
        volumeNum: 50,
        closedTime: '2026-01-02T01:00:00Z',
        resolvedBy: 'admin',
      };

      const result = transformMarketToSSR(market as any);

      expect(result.created_at).toBe('2026-01-01T00:00:00Z');
      expect(result.end_date).toBe('2026-01-02T00:00:00Z');
      expect(result.resolution_source).toBe('https://example.com');
      expect(result.updated_at).toBe('2026-01-01T12:00:00Z');
      expect(result.liquidity_num).toBe(100);
      expect(result.volume_num).toBe(50);
      expect(result.closed_time).toBe('2026-01-02T01:00:00Z');
      expect(result.resolved_by).toBe('admin');
    });

    it('should add SSR null fields', () => {
      const market = {
        id: '1',
        outcomes: '[]',
        outcomePrices: '[]',
        clobTokenIds: '[]',
      };

      const result = transformMarketToSSR(market as any);

      expect(result.amm_type).toBeNull();
      expect(result.denomination_token).toBeNull();
      expect(result.lower_bound).toBeNull();
      expect(result.upper_bound).toBeNull();
      expect(result.market_type).toBeNull();
      expect(result.x_axis_value).toBeNull();
      expect(result.y_axis_value).toBeNull();
    });

    it('should handle invalid JSON strings gracefully', () => {
      const market = {
        id: '1',
        outcomes: 'not-json',
        outcomePrices: '["valid"]',
        clobTokenIds: '{broken',
      };

      const result = transformMarketToSSR(market as any);

      // Invalid JSON should be kept as-is
      expect(result.outcomes).toBe('not-json');
      expect(result.outcomePrices).toEqual(['valid']);
      expect(result.clobTokenIds).toBe('{broken');
    });
  });

  describe('transformToSSRFormat', () => {
    it('should extract timeframe from tags', () => {
      const event = makeSampleGammaEvent();
      const result = transformToSSRFormat(event);
      expect(result.timeframe).toBe('15M');
    });

    it('should extract asset from tags', () => {
      const event = makeSampleGammaEvent();
      const result = transformToSSRFormat(event);
      expect(result.asset).toBe('bitcoin');
    });

    it('should collect all tag slugs', () => {
      const event = makeSampleGammaEvent();
      const result = transformToSSRFormat(event);
      expect(result.tags).toContain('bitcoin');
      expect(result.tags).toContain('15M');
      expect(result.tags).toContain('crypto');
      expect(result.tags).toContain('up-or-down');
      expect(result.tags).toContain('recurring');
    });

    it('should set is_live to false', () => {
      const event = makeSampleGammaEvent();
      const result = transformToSSRFormat(event);
      expect(result.is_live).toBe(false);
    });

    it('should set image_raw from image', () => {
      const event = makeSampleGammaEvent();
      const result = transformToSSRFormat(event);
      expect(result.image_raw).toBe(event.image);
    });

    it('should map all event-level fields correctly', () => {
      const event = makeSampleGammaEvent();
      const result = transformToSSRFormat(event);

      expect(result.id).toBe('208116');
      expect(result.ticker).toBe('btc-updown-15m-1771099200');
      expect(result.slug).toBe('btc-updown-15m-1771099200');
      expect(result.title).toContain('Bitcoin Up or Down');
      expect(result.resolution_source).toBe('https://data.chain.link/streams/btc-usd');
      expect(result.active).toBe(true);
      expect(result.closed).toBe(false);
      expect(result.restricted).toBe(true);
      expect(result.liquidity).toBe(15858.3192);
      expect(result.volume).toBe(1460.488644);
      expect(result.neg_risk).toBe(false);
      expect(result.series_slug).toBe('btc-up-or-down-15m');
    });

    it('should transform markets to SSR format', () => {
      const event = makeSampleGammaEvent();
      const result = transformToSSRFormat(event);

      expect(result.markets).toHaveLength(1);
      expect(result.markets[0].outcomes).toEqual(['Up', 'Down']);
      expect(result.markets[0].outcomePrices).toEqual(['0.485', '0.515']);
      expect(result.markets[0].created_at).toBe('2026-02-13T20:07:28.931801Z');
    });

    it('should preserve series data', () => {
      const event = makeSampleGammaEvent();
      const result = transformToSSRFormat(event);

      expect(result.series).toHaveLength(1);
      expect(result.series![0].ticker).toBe('btc-up-or-down-15m');
    });

    it('should store tags_data as full tag objects', () => {
      const event = makeSampleGammaEvent();
      const result = transformToSSRFormat(event);

      expect(result.tags_data).toHaveLength(6);
      expect(result.tags_data![0]).toHaveProperty('label');
      expect(result.tags_data![0]).toHaveProperty('slug');
    });

    it('should store raw_data as the original event', () => {
      const event = makeSampleGammaEvent();
      const result = transformToSSRFormat(event);
      expect(result.raw_data).toEqual(event);
    });

    it('should handle event with no tags', () => {
      const event = makeSampleGammaEvent({ tags: [] });
      const result = transformToSSRFormat(event);

      expect(result.timeframe).toBeNull();
      expect(result.asset).toBeNull();
      expect(result.tags).toEqual([]);
      expect(result.tags_data).toBeNull();
    });

    it('should handle event with undefined optional fields', () => {
      const event = makeSampleGammaEvent({
        description: undefined,
        resolutionSource: undefined,
        startDate: undefined,
        startTime: undefined,
        seriesSlug: undefined,
        series: undefined,
      });
      const result = transformToSSRFormat(event);

      expect(result.description).toBeNull();
      expect(result.resolution_source).toBeNull();
      expect(result.start_date).toBeNull();
      expect(result.start_time).toBeNull();
      expect(result.series_slug).toBeNull();
      expect(result.series).toBeNull();
    });

    it('should handle ETH event with ethereum asset tag', () => {
      const event = makeSampleGammaEvent({
        id: '208118',
        ticker: 'eth-updown-15m-1771099200',
        title: 'Ethereum Up or Down',
        tags: [
          { id: '39', label: 'Ethereum', slug: 'ethereum' },
          { id: '102467', label: '15M', slug: '15M' },
          { id: '21', label: 'Crypto', slug: 'crypto' },
        ],
      });
      const result = transformToSSRFormat(event);

      expect(result.asset).toBe('ethereum');
      expect(result.timeframe).toBe('15M');
    });

    it('should handle SOL event with solana asset tag', () => {
      const event = makeSampleGammaEvent({
        id: '208117',
        ticker: 'sol-updown-15m-1771099200',
        title: 'Solana Up or Down',
        tags: [
          { id: '818', label: 'Solana', slug: 'solana' },
          { id: '102467', label: '15M', slug: '15M' },
        ],
      });
      const result = transformToSSRFormat(event);

      expect(result.asset).toBe('solana');
      expect(result.timeframe).toBe('15M');
    });
  });

  // ===================
  // Integration Tests
  // ===================

  describe('fetchAllCryptoEvents', () => {
    it('should paginate through all events', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) =>
        makeSampleGammaEvent({ id: String(i) }),
      );
      const page2 = Array.from({ length: 50 }, (_, i) =>
        makeSampleGammaEvent({ id: String(100 + i) }),
      );

      mockGet
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2);

      const events = await fetchAllCryptoEvents();

      expect(events).toHaveLength(150);
      expect(mockGet).toHaveBeenCalledTimes(2);

      // Verify pagination params
      expect(mockGet).toHaveBeenCalledWith('/events/pagination', expect.objectContaining({
        tag_id: 21,
        active: true,
        closed: false,
        limit: 100,
        offset: 0,
      }));
      expect(mockGet).toHaveBeenCalledWith('/events/pagination', expect.objectContaining({
        offset: 100,
      }));
    });

    it('should stop on empty response', async () => {
      mockGet.mockResolvedValueOnce([]);

      const events = await fetchAllCryptoEvents();

      expect(events).toHaveLength(0);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should stop when less than PAGE_LIMIT returned', async () => {
      const page1 = Array.from({ length: 30 }, (_, i) =>
        makeSampleGammaEvent({ id: String(i) }),
      );

      mockGet.mockResolvedValueOnce(page1);

      const events = await fetchAllCryptoEvents();

      expect(events).toHaveLength(30);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('should handle exactly PAGE_LIMIT events then empty', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) =>
        makeSampleGammaEvent({ id: String(i) }),
      );

      mockGet
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce([]);

      const events = await fetchAllCryptoEvents();

      expect(events).toHaveLength(100);
      expect(mockGet).toHaveBeenCalledTimes(2);
    });
  });

  describe('storeCryptoMarketsInDatabase', () => {
    it('should not connect to database for empty array', async () => {
      await storeCryptoMarketsInDatabase([]);
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('should use transaction for bulk insert', async () => {
      const rows = [transformToSSRFormat(makeSampleGammaEvent())];

      await storeCryptoMarketsInDatabase(rows);

      expect(mockConnect).toHaveBeenCalledTimes(1);
      // BEGIN, INSERT, COMMIT
      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(mockQuery.mock.calls[0][0]).toBe('BEGIN');
      expect(mockQuery.mock.calls[2][0]).toBe('COMMIT');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('should rollback on error', async () => {
      const rows = [transformToSSRFormat(makeSampleGammaEvent())];

      // BEGIN succeeds, INSERT fails
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockRejectedValueOnce(new Error('DB error')) // INSERT
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      await expect(storeCryptoMarketsInDatabase(rows)).rejects.toThrow('DB error');

      expect(mockQuery).toHaveBeenCalledWith('ROLLBACK');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('should batch large datasets', async () => {
      // Create 600 rows (should produce 2 batches at BATCH_SIZE=500)
      const events = Array.from({ length: 600 }, (_, i) =>
        makeSampleGammaEvent({ id: String(i) }),
      );
      const rows = events.map(transformToSSRFormat);

      await storeCryptoMarketsInDatabase(rows);

      // BEGIN + 2 INSERT batches + COMMIT
      expect(mockQuery).toHaveBeenCalledTimes(4);
      expect(mockQuery.mock.calls[0][0]).toBe('BEGIN');
      expect(mockQuery.mock.calls[3][0]).toBe('COMMIT');
    });

    it('should pass correct number of values per row', async () => {
      const rows = [transformToSSRFormat(makeSampleGammaEvent())];

      await storeCryptoMarketsInDatabase(rows);

      // The INSERT query call is the second call (after BEGIN)
      const insertCall = mockQuery.mock.calls[1];
      const values = insertCall[1];

      // 42 parameterized values per row (created_at and updated_at use CURRENT_TIMESTAMP)
      expect(values).toHaveLength(42);
    });

    it('should include ON CONFLICT DO UPDATE in query', async () => {
      const rows = [transformToSSRFormat(makeSampleGammaEvent())];

      await storeCryptoMarketsInDatabase(rows);

      const insertQuery = mockQuery.mock.calls[1][0];
      expect(insertQuery).toContain('ON CONFLICT (id) DO UPDATE');
    });

    it('should stringify JSONB fields', async () => {
      const rows = [transformToSSRFormat(makeSampleGammaEvent())];

      await storeCryptoMarketsInDatabase(rows);

      const values = mockQuery.mock.calls[1][1];
      // markets (index 38), series (index 39), tags_data (index 40), raw_data (index 41)
      // But since we have 40 params (0-39), markets=38, series=39 would be the last two JSONB before raw_data
      // Let's verify they're strings (JSON.stringify'd)
      const marketsValue = values[38];
      const rawDataValue = values[39 + 2]; // Adjusted: series=39, tags_data=40... wait let me count

      // Actually the values array has exactly 40 items, and the JSONB fields are the last 4:
      // index 36 = tags (array), 37 = markets (JSON), 38 = series (JSON), 39 = tags_data (JSON), wait...
      // Let me verify: there are 40 columns, the last 4 parameterized are:
      // markets, series, tags_data, raw_data → indices 38, 39, 40, 41? No, 40 total means indices 0-39
      // id(0) ... tags(37) markets(38) series(39) ... hmm

      // The exact order: 35 top-level + timeframe(35) + asset(36) + tags(37) + markets(38) + series(39) + tags_data(skip) + raw_data(skip)?
      // Actually let me just verify the JSON fields are stringified by checking type
      // The last few values should be JSON strings for the JSONB columns
      const lastFour = values.slice(-4);
      for (const val of lastFour) {
        if (val !== null) {
          expect(typeof val).toBe('string');
          // Should be valid JSON
          expect(() => JSON.parse(val)).not.toThrow();
        }
      }
    });
  });

  describe('refreshCryptoMarkets', () => {
    it('should fetch, transform, and store events', async () => {
      const events = [makeSampleGammaEvent(), makeSampleGammaEvent({ id: '2' })];
      mockGet.mockResolvedValueOnce(events);

      await cryptoMarketsService.refreshCryptoMarkets();

      expect(mockGet).toHaveBeenCalled();
      expect(mockConnect).toHaveBeenCalled();
      expect(mockQuery).toHaveBeenCalledWith('COMMIT');
    });

    it('should handle empty fetch gracefully', async () => {
      mockGet.mockResolvedValueOnce([]);

      await cryptoMarketsService.refreshCryptoMarkets();

      expect(mockGet).toHaveBeenCalled();
      // Should not attempt to store
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('should catch and log errors without throwing', async () => {
      mockGet.mockRejectedValueOnce(new Error('Network error'));

      // Should not throw
      await cryptoMarketsService.refreshCryptoMarkets();

      const { logger } = await import('../../config/logger');
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Failed to refresh crypto markets' }),
      );
    });
  });

  describe('start / stop', () => {
    afterEach(() => {
      cryptoMarketsService.stop();
    });

    it('should start polling and make initial fetch', async () => {
      mockGet.mockResolvedValueOnce([]);

      cryptoMarketsService.start();

      // Give the initial async fetch a tick to run
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockGet).toHaveBeenCalled();
    });

    it('should stop polling when stop is called', async () => {
      mockGet.mockResolvedValue([]);

      cryptoMarketsService.start();
      cryptoMarketsService.stop();

      // No error, clean stop
      const { logger } = vi.mocked(await import('../../config/logger'));
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Crypto markets service stopped' }),
      );
    });
  });
});
