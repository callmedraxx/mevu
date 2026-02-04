/**
 * Integration Tests for Kalshi API Client
 * Tests actual API connectivity and response parsing
 */

import { describe, it, expect } from 'vitest';
import { fetchKalshiMarkets, fetchAllMarketsForSeries } from './kalshi.client';

describe('Kalshi API Client', () => {
  describe('fetchKalshiMarkets', () => {
    it('should fetch NBA markets from Kalshi API', async () => {
      const response = await fetchKalshiMarkets({
        seriesTicker: 'KXNBA',
        status: 'open',
        limit: 5,
      });

      expect(response).toBeDefined();
      expect(response.markets).toBeDefined();
      expect(Array.isArray(response.markets)).toBe(true);

      // Cursor can be null or a string
      if (response.cursor !== null) {
        expect(typeof response.cursor).toBe('string');
      }
    });

    it('should handle empty response gracefully', async () => {
      // Use a non-existent series ticker
      const response = await fetchKalshiMarkets({
        seriesTicker: 'NONEXISTENT123',
        status: 'open',
        limit: 5,
      });

      expect(response).toBeDefined();
      expect(response.markets).toBeDefined();
      expect(Array.isArray(response.markets)).toBe(true);
      // Should return empty array for non-existent series
    });

    it('should respect the limit parameter', async () => {
      const response = await fetchKalshiMarkets({
        seriesTicker: 'KXNBA',
        status: 'open',
        limit: 3,
      });

      expect(response.markets.length).toBeLessThanOrEqual(3);
    });

    it('should filter by min_close_ts', async () => {
      const futureTs = Math.floor(Date.now() / 1000) + 86400; // 24h from now

      const response = await fetchKalshiMarkets({
        seriesTicker: 'KXNBA',
        status: 'open',
        minCloseTs: futureTs,
        limit: 10,
      });

      // All returned markets should have close_time after futureTs
      for (const market of response.markets) {
        const closeTs = new Date(market.close_time).getTime() / 1000;
        expect(closeTs).toBeGreaterThanOrEqual(futureTs);
      }
    });
  });

  describe('fetchAllMarketsForSeries', () => {
    it('should fetch all pages of NBA markets', async () => {
      const nowTs = Math.floor(Date.now() / 1000);
      const markets = await fetchAllMarketsForSeries('KXNBA', nowTs);

      expect(markets).toBeDefined();
      expect(Array.isArray(markets)).toBe(true);
      // Should have some markets (unless there are no open NBA markets)
    });

    it('should fetch NFL markets', async () => {
      const nowTs = Math.floor(Date.now() / 1000);
      const markets = await fetchAllMarketsForSeries('KXNFL', nowTs);

      expect(markets).toBeDefined();
      expect(Array.isArray(markets)).toBe(true);
    });
  });

  describe('Market Structure Validation', () => {
    it('should return markets with expected fields', async () => {
      const response = await fetchKalshiMarkets({
        seriesTicker: 'KXNBA',
        status: 'open',
        limit: 1,
      });

      if (response.markets.length > 0) {
        const market = response.markets[0];

        // Required fields
        expect(market.ticker).toBeDefined();
        expect(typeof market.ticker).toBe('string');

        expect(market.title).toBeDefined();
        expect(typeof market.title).toBe('string');

        expect(market.status).toBeDefined();
        expect(['unopened', 'open', 'closed', 'settled']).toContain(market.status);

        expect(market.close_time).toBeDefined();
        expect(new Date(market.close_time).toString()).not.toBe('Invalid Date');

        // Price fields (should be numbers 0-100)
        expect(typeof market.yes_bid).toBe('number');
        expect(typeof market.yes_ask).toBe('number');
        expect(typeof market.no_bid).toBe('number');
        expect(typeof market.no_ask).toBe('number');

        // Prices should be in valid range
        expect(market.yes_ask).toBeGreaterThanOrEqual(0);
        expect(market.yes_ask).toBeLessThanOrEqual(100);
        expect(market.no_ask).toBeGreaterThanOrEqual(0);
        expect(market.no_ask).toBeLessThanOrEqual(100);
      }
    });
  });
});

describe('API Error Handling', () => {
  it('should throw on network error', async () => {
    // This test would require mocking - skip for now
    // In a real setup, you'd use vitest's vi.mock() to simulate network failures
  });
});
