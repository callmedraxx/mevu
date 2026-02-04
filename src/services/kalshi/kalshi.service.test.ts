/**
 * Unit Tests for Kalshi Service
 * Tests market transformation and service functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { kalshiService } from './kalshi.service';
import { KalshiMarket } from './kalshi.types';

// Mock the database module
vi.mock('../../config/database', () => ({
  connectWithRetry: vi.fn().mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  }),
}));

// Mock the logger
vi.mock('../../config/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Kalshi Service', () => {
  describe('getStatus', () => {
    it('should return service status', () => {
      const status = kalshiService.getStatus();

      expect(status).toHaveProperty('isRunning');
      expect(status).toHaveProperty('lastRefreshTime');
      expect(status).toHaveProperty('lastRefreshCount');
      expect(status).toHaveProperty('lastError');

      expect(typeof status.isRunning).toBe('boolean');
    });
  });

  describe('Market Transformation', () => {
    // Access private method via any type for testing
    const transformMarket = (kalshiService as any).transformMarket.bind(kalshiService);

    it('should transform a valid NBA market', () => {
      const market: KalshiMarket & { _sport: string } = {
        ticker: 'KXNBA-123',
        event_ticker: 'KXNBA-EVENT',
        title: 'Lakers vs Celtics',
        status: 'open',
        close_time: '2025-01-15T23:00:00Z',
        yes_bid: 45,
        yes_ask: 47,
        no_bid: 52,
        no_ask: 54,
        volume: 10000,
        open_interest: 5000,
        _sport: 'nba',
      };

      const result = transformMarket(market);

      expect(result).not.toBeNull();
      expect(result.ticker).toBe('KXNBA-123');
      expect(result.sport).toBe('nba');
      expect(result.awayTeam).toBe('los angeles lakers');
      expect(result.homeTeam).toBe('boston celtics');
      expect(result.yesBid).toBe(45);
      expect(result.yesAsk).toBe(47);
      expect(result.noBid).toBe(52);
      expect(result.noAsk).toBe(54);
    });

    it('should transform a market with @ separator', () => {
      const market: KalshiMarket & { _sport: string } = {
        ticker: 'KXNFL-456',
        event_ticker: 'KXNFL-EVENT',
        title: 'Chiefs @ Bills',
        status: 'open',
        close_time: '2025-01-16T20:00:00Z',
        yes_bid: 60,
        yes_ask: 62,
        no_bid: 37,
        no_ask: 39,
        volume: 25000,
        open_interest: 12000,
        _sport: 'nfl',
      };

      const result = transformMarket(market);

      expect(result).not.toBeNull();
      expect(result.awayTeam).toBe('kansas city chiefs');
      expect(result.homeTeam).toBe('buffalo bills');
    });

    it('should return null for unparseable titles', () => {
      const market: KalshiMarket & { _sport: string } = {
        ticker: 'KXNBA-789',
        event_ticker: 'KXNBA-EVENT',
        title: 'Something unparseable here',
        status: 'open',
        close_time: '2025-01-17T23:00:00Z',
        yes_bid: 50,
        yes_ask: 52,
        no_bid: 47,
        no_ask: 49,
        volume: 5000,
        open_interest: 2500,
        _sport: 'nba',
      };

      const result = transformMarket(market);

      expect(result).toBeNull();
    });

    it('should extract game date from close_time', () => {
      const market: KalshiMarket & { _sport: string } = {
        ticker: 'KXNBA-DATE',
        event_ticker: 'KXNBA-EVENT',
        title: 'Warriors vs Thunder',
        status: 'open',
        close_time: '2025-02-20T04:00:00Z',
        yes_bid: 35,
        yes_ask: 37,
        no_bid: 62,
        no_ask: 64,
        volume: 8000,
        open_interest: 4000,
        _sport: 'nba',
      };

      const result = transformMarket(market);

      expect(result).not.toBeNull();
      // Game date should be normalized to midnight
      expect(result.gameDate.getHours()).toBe(0);
      expect(result.gameDate.getMinutes()).toBe(0);
      expect(result.gameDate.getSeconds()).toBe(0);
    });

    it('should handle zero prices', () => {
      const market: KalshiMarket & { _sport: string } = {
        ticker: 'KXNBA-ZERO',
        event_ticker: 'KXNBA-EVENT',
        title: 'Spurs vs Jazz',
        status: 'open',
        close_time: '2025-02-21T03:00:00Z',
        yes_bid: 0,
        yes_ask: 0,
        no_bid: 0,
        no_ask: 0,
        volume: 0,
        open_interest: 0,
        _sport: 'nba',
      };

      const result = transformMarket(market);

      expect(result).not.toBeNull();
      expect(result.yesBid).toBe(0);
      expect(result.yesAsk).toBe(0);
    });

    it('should extract team abbreviations', () => {
      const market: KalshiMarket & { _sport: string } = {
        ticker: 'KXNBA-ABBR',
        event_ticker: 'KXNBA-EVENT',
        title: 'Los Angeles Lakers vs Boston Celtics',
        status: 'open',
        close_time: '2025-02-22T03:00:00Z',
        yes_bid: 40,
        yes_ask: 42,
        no_bid: 57,
        no_ask: 59,
        volume: 15000,
        open_interest: 7500,
        _sport: 'nba',
      };

      const result = transformMarket(market);

      expect(result).not.toBeNull();
      expect(result.awayTeamAbbr).toBe('LAL');
      expect(result.homeTeamAbbr).toBe('BC');
    });
  });

  describe('getKalshiPricesForGames', () => {
    it('should return empty map for empty input', async () => {
      const result = await kalshiService.getKalshiPricesForGames([]);
      expect(result.size).toBe(0);
    });

    // Note: Additional tests would require database mocking
    // In development mode, this will return empty map
    it('should return empty map in development mode', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const result = await kalshiService.getKalshiPricesForGames(['game-1', 'game-2']);
      expect(result.size).toBe(0);

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('getKalshiPricesForSlug', () => {
    it('should return null in development mode', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const result = await kalshiService.getKalshiPricesForSlug('nba-lal-bos-2025-01-15');
      expect(result).toBeNull();

      process.env.NODE_ENV = originalEnv;
    });
  });
});

describe('Sport Configuration', () => {
  it('should have all required sports configured', async () => {
    const { KALSHI_SPORT_SERIES, getSupportedKalshiSports } = await import('./kalshi.config');

    const supportedSports = getSupportedKalshiSports();

    // Verify all required sports are configured
    expect(supportedSports).toContain('nba');
    expect(supportedSports).toContain('nfl');
    expect(supportedSports).toContain('nhl');
    expect(supportedSports).toContain('epl');
    expect(supportedSports).toContain('tennis');
    expect(supportedSports).toContain('cbb');
    expect(supportedSports).toContain('cfb');

    // Verify each sport has at least one series ticker
    for (const sport of supportedSports) {
      expect(KALSHI_SPORT_SERIES[sport].length).toBeGreaterThan(0);
    }
  });

  it('should correctly map series tickers to sports', async () => {
    const { getSportFromKalshiSeries } = await import('./kalshi.config');

    expect(getSportFromKalshiSeries('KXNBA')).toBe('nba');
    expect(getSportFromKalshiSeries('KXNFL')).toBe('nfl');
    expect(getSportFromKalshiSeries('KXNHL')).toBe('nhl');
    expect(getSportFromKalshiSeries('KXEPL')).toBe('epl');
    expect(getSportFromKalshiSeries('KXATP')).toBe('tennis');
    expect(getSportFromKalshiSeries('KXWTA')).toBe('tennis');
    expect(getSportFromKalshiSeries('KXNCAAB')).toBe('cbb');
    expect(getSportFromKalshiSeries('KXCFB')).toBe('cfb');

    // Unknown series should return null
    expect(getSportFromKalshiSeries('UNKNOWN')).toBeNull();
    expect(getSportFromKalshiSeries('')).toBeNull();
  });
});
