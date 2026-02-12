/**
 * Unit Tests for Kalshi Service
 * Tests market transformation and service functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { kalshiService } from './kalshi.service';
import { KalshiMarket } from './kalshi.types';
import { connectWithRetry } from '../../config/database';

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
      // Ticker must match real Kalshi format: series-YYMONDD+GAMECODE (e.g. 26JAN15LALBOS = Lakers @ Celtics)
      const market: KalshiMarket & { _sport: string } = {
        ticker: 'KXNBAGAME-26JAN15LALBOS',
        event_ticker: 'KXNBAGAME-EVENT',
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
      expect(result!.ticker).toBe('KXNBAGAME-26JAN15LALBOS');
      expect(result!.sport).toBe('nba');
      expect(result!.awayTeam).toBe('los angeles lakers');
      expect(result!.homeTeam).toBe('boston celtics');
      expect(result!.yesBid).toBe(45);
      expect(result!.yesAsk).toBe(47);
      expect(result!.noBid).toBe(52);
      expect(result!.noAsk).toBe(54);
    });

    it('should transform a market with @ separator', () => {
      // Real ticker format: 6-char game code (e.g. KCCBUF = KC Chiefs + BUF Bills)
      const market: KalshiMarket & { _sport: string } = {
        ticker: 'KXNFLGAME-26JAN16KCCBUF',
        event_ticker: 'KXNFLGAME-EVENT',
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
      expect(result!.awayTeam).toBe('kansas city chiefs');
      expect(result!.homeTeam).toBe('buffalo bills');
    });

    it('should transform a valid UFC market (KXUFCFIGHT)', () => {
      const market: KalshiMarket & { _sport: string } = {
        ticker: 'KXUFCFIGHT-26FEB07OLEBAR',
        event_ticker: 'KXUFCFIGHT-EVENT',
        title: 'Oleksiejczuk vs Barriault UFC Fight',
        status: 'open',
        close_time: '2026-02-08T01:00:00Z',
        yes_bid: 21,
        yes_ask: 22,
        no_bid: 78,
        no_ask: 79,
        volume: 5000,
        open_interest: 1000,
        _sport: 'ufc',
      };

      const result = transformMarket(market);

      expect(result).not.toBeNull();
      expect(result!.ticker).toBe('KXUFCFIGHT-26FEB07OLEBAR');
      expect(result!.sport).toBe('ufc');
      expect(result!.homeTeamAbbr).toBe('BAR');
      expect(result!.awayTeamAbbr).toBe('OLE');
      expect(result!.gameDate.getFullYear()).toBe(2026);
      expect(result!.gameDate.getMonth()).toBe(1);
      expect(result!.gameDate.getDate()).toBe(7);
      expect(result!.yesBid).toBe(21);
      expect(result!.yesAsk).toBe(22);
      expect(result!.noBid).toBe(78);
      expect(result!.noAsk).toBe(79);
    });

    it('should return null when ticker has no date or team code', () => {
      // Ticker without YYMONDD+GAMECODE pattern causes extractGameDateFromTicker / extractTeamsFromTicker to return null
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

    it('should extract game date from ticker', () => {
      const market: KalshiMarket & { _sport: string } = {
        ticker: 'KXNBAGAME-26FEB20GSWOKC',
        event_ticker: 'KXNBAGAME-EVENT',
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
      // Game date from ticker 26FEB20 = 2026-02-20, normalized to midnight
      expect(result!.gameDate.getHours()).toBe(0);
      expect(result!.gameDate.getMinutes()).toBe(0);
      expect(result!.gameDate.getSeconds()).toBe(0);
      expect(result!.gameDate.getFullYear()).toBe(2026);
      expect(result!.gameDate.getMonth()).toBe(1);
      expect(result!.gameDate.getDate()).toBe(20);
    });

    it('should handle zero prices', () => {
      const market: KalshiMarket & { _sport: string } = {
        ticker: 'KXNBAGAME-26FEB21SASUTA',
        event_ticker: 'KXNBAGAME-EVENT',
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
      expect(result!.yesBid).toBe(0);
      expect(result!.yesAsk).toBe(0);
    });

    it('should extract team abbreviations from ticker', () => {
      const market: KalshiMarket & { _sport: string } = {
        ticker: 'KXNBAGAME-26FEB22LALBOS',
        event_ticker: 'KXNBAGAME-EVENT',
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
      // Abbreviations come from ticker game code (LALBOS = LAL + BOS)
      expect(result!.awayTeamAbbr).toBe('LAL');
      expect(result!.homeTeamAbbr).toBe('BOS');
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

    // Verify configured sports (cfb is not configured - no individual game markets on Kalshi)
    expect(supportedSports).toContain('nba');
    expect(supportedSports).toContain('nfl');
    expect(supportedSports).toContain('nhl');
    expect(supportedSports).toContain('epl');
    expect(supportedSports).toContain('tennis');
    expect(supportedSports).toContain('cbb');
    expect(supportedSports).toContain('lal');
    expect(supportedSports).toContain('ufc');

    // Verify each sport has at least one series ticker
    for (const sport of supportedSports) {
      expect(KALSHI_SPORT_SERIES[sport].length).toBeGreaterThan(0);
    }
  });

  it('should correctly map series tickers to sports', async () => {
    const { getSportFromKalshiSeries } = await import('./kalshi.config');

    // Config uses full series tickers (e.g. KXNBAGAME), not short prefixes
    expect(getSportFromKalshiSeries('KXNBAGAME')).toBe('nba');
    expect(getSportFromKalshiSeries('KXNFLGAME')).toBe('nfl');
    expect(getSportFromKalshiSeries('KXNHLGAME')).toBe('nhl');
    expect(getSportFromKalshiSeries('KXEPLGAME')).toBe('epl');
    expect(getSportFromKalshiSeries('KXATPMATCH')).toBe('tennis');
    expect(getSportFromKalshiSeries('KXWTAMATCH')).toBe('tennis');
    expect(getSportFromKalshiSeries('KXNCAAMBGAME')).toBe('cbb');
    expect(getSportFromKalshiSeries('KXLALIGAGAME')).toBe('lal');
    expect(getSportFromKalshiSeries('KXUFCFIGHT')).toBe('ufc');

    // Unknown series should return null
    expect(getSportFromKalshiSeries('UNKNOWN')).toBeNull();
    expect(getSportFromKalshiSeries('')).toBeNull();
  });
});

describe('Kalshi Service - UFC slug and config', () => {
  const UFC_SLUG_REGEX = /^[a-z]+-[a-z0-9]+-[a-z0-9]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

  it('should allow UFC slugs with alphanumeric team parts (mic1, mar14)', () => {
    expect(UFC_SLUG_REGEX.test('ufc-mic1-mar14-2026-02-07')).toBe(true);
    expect(UFC_SLUG_REGEX.test('ufc-riz-jai3-2026-02-07')).toBe(true);
    expect(UFC_SLUG_REGEX.test('nba-cha-hou-2026-02-05')).toBe(true);
    expect(UFC_SLUG_REGEX.test('ufc-2026-02-07')).toBe(false);
  });
});

describe('Kalshi Service - UFC prices', () => {
  beforeEach(() => {
    vi.mocked(connectWithRetry).mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    });
  });

  it('should return Kalshi prices for UFC slug when single KXUFCFIGHT market is matched', async () => {
    const ufcRow = {
      yes_bid: 21,
      yes_ask: 22,
      no_bid: 78,
      no_ask: 79,
      ticker: 'KXUFCFIGHT-26FEB07OLEBAR',
      away_team_abbr: 'OLE',
      home_team_abbr: 'BAR',
    };
    vi.mocked(connectWithRetry).mockResolvedValueOnce({
      query: vi.fn().mockResolvedValueOnce({ rows: [ufcRow], rowCount: 1 }),
      release: vi.fn(),
    });

    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const result = await kalshiService.getKalshiPricesForSlug('ufc-mic1-mar14-2026-02-07');

      expect(result).not.toBeNull();
      expect(result!.yesBid).toBe(21);
      expect(result!.yesAsk).toBe(22);
      expect(result!.noBid).toBe(78);
      expect(result!.noAsk).toBe(79);
      expect(result!.ticker).toBe('KXUFCFIGHT-26FEB07OLEBAR');
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});
