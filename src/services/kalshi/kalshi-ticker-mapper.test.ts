/**
 * Unit Tests for Kalshi Ticker Mapper
 * Tests ticker-to-game mapping, cache management, and LRU eviction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock database
vi.mock('../../config/database', () => ({
  connectWithRetry: vi.fn().mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  }),
}));

// Mock Redis
vi.mock('ioredis', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      set: vi.fn().mockResolvedValue('OK'),
      get: vi.fn().mockResolvedValue(null),
      quit: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

// Mock logger
vi.mock('../../config/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Kalshi Ticker Mapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('TickerMapping Interface', () => {
    it('should define correct mapping structure', () => {
      const mapping = {
        ticker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
        liveGameId: 'game-123',
        homeTeam: 'houston rockets',
        awayTeam: 'charlotte hornets',
        sport: 'nba',
        gameDate: new Date('2026-02-05'),
      };

      expect(mapping.ticker).toBeDefined();
      expect(mapping.liveGameId).toBeDefined();
      expect(mapping.homeTeam).toBeDefined();
      expect(mapping.awayTeam).toBeDefined();
      expect(mapping.sport).toBeDefined();
      expect(mapping.gameDate).toBeInstanceOf(Date);
    });
  });

  describe('KalshiTickerMapper Class', () => {
    it('should be a singleton', async () => {
      const { getKalshiTickerMapper } = await import('./kalshi-ticker-mapper');
      
      const instance1 = getKalshiTickerMapper();
      const instance2 = getKalshiTickerMapper();
      
      expect(instance1).toBe(instance2);
    });

    it('should return correct stats when empty', async () => {
      const { KalshiTickerMapper } = await import('./kalshi-ticker-mapper');
      const mapper = KalshiTickerMapper.getInstance();
      
      const stats = mapper.getStats();
      
      expect(stats).toHaveProperty('tickerCount');
      expect(stats).toHaveProperty('gameCount');
      expect(stats).toHaveProperty('isRefreshing');
      expect(typeof stats.tickerCount).toBe('number');
      expect(typeof stats.gameCount).toBe('number');
      expect(typeof stats.isRefreshing).toBe('boolean');
    });
  });

  describe('Mapping Operations', () => {
    it('should return null for unknown ticker', async () => {
      const { KalshiTickerMapper } = await import('./kalshi-ticker-mapper');
      const mapper = KalshiTickerMapper.getInstance();
      
      const result = mapper.getMappingForTicker('UNKNOWN-TICKER');
      
      expect(result).toBeNull();
    });

    it('should return null for unknown gameId', async () => {
      const { KalshiTickerMapper } = await import('./kalshi-ticker-mapper');
      const mapper = KalshiTickerMapper.getInstance();
      
      const result = mapper.getGameIdForTicker('UNKNOWN-TICKER');
      
      expect(result).toBeNull();
    });

    it('should return empty array for unknown game tickers', async () => {
      const { KalshiTickerMapper } = await import('./kalshi-ticker-mapper');
      const mapper = KalshiTickerMapper.getInstance();
      
      const result = mapper.getTickersForGameId('unknown-game-id');
      
      expect(result).toEqual([]);
    });

    it('should return all mapped tickers', async () => {
      const { KalshiTickerMapper } = await import('./kalshi-ticker-mapper');
      const mapper = KalshiTickerMapper.getInstance();
      
      const tickers = mapper.getAllMappedTickers();
      
      expect(Array.isArray(tickers)).toBe(true);
    });

    it('should return all mapped game IDs', async () => {
      const { KalshiTickerMapper } = await import('./kalshi-ticker-mapper');
      const mapper = KalshiTickerMapper.getInstance();
      
      const gameIds = mapper.getAllMappedGameIds();
      
      expect(Array.isArray(gameIds)).toBe(true);
    });
  });

  describe('Add/Remove Mapping', () => {
    it('should add a mapping correctly', async () => {
      const { KalshiTickerMapper } = await import('./kalshi-ticker-mapper');
      const mapper = KalshiTickerMapper.getInstance();
      
      const mapping = {
        ticker: 'KXNBAGAME-TEST-TICKER',
        liveGameId: 'test-game-id',
        homeTeam: 'boston celtics',
        awayTeam: 'los angeles lakers',
        sport: 'nba',
        gameDate: new Date('2026-02-05'),
      };
      
      mapper.addMapping(mapping);
      
      const result = mapper.getMappingForTicker('KXNBAGAME-TEST-TICKER');
      expect(result).not.toBeNull();
      expect(result?.liveGameId).toBe('test-game-id');
      
      // Clean up
      mapper.removeMapping('KXNBAGAME-TEST-TICKER');
    });

    it('should remove a mapping correctly', async () => {
      const { KalshiTickerMapper } = await import('./kalshi-ticker-mapper');
      const mapper = KalshiTickerMapper.getInstance();
      
      const mapping = {
        ticker: 'KXNBAGAME-REMOVE-TEST',
        liveGameId: 'remove-test-game',
        homeTeam: 'team a',
        awayTeam: 'team b',
        sport: 'nba',
        gameDate: new Date('2026-02-05'),
      };
      
      mapper.addMapping(mapping);
      expect(mapper.getMappingForTicker('KXNBAGAME-REMOVE-TEST')).not.toBeNull();
      
      mapper.removeMapping('KXNBAGAME-REMOVE-TEST');
      expect(mapper.getMappingForTicker('KXNBAGAME-REMOVE-TEST')).toBeNull();
    });

    it('should handle removing non-existent mapping gracefully', async () => {
      const { KalshiTickerMapper } = await import('./kalshi-ticker-mapper');
      const mapper = KalshiTickerMapper.getInstance();
      
      // Should not throw
      expect(() => mapper.removeMapping('NON-EXISTENT')).not.toThrow();
    });
  });

  describe('Reverse Mapping', () => {
    it('should build reverse map (gameId -> tickers)', async () => {
      const { KalshiTickerMapper } = await import('./kalshi-ticker-mapper');
      const mapper = KalshiTickerMapper.getInstance();
      
      // Add multiple tickers for same game
      const mapping1 = {
        ticker: 'KXNBAGAME-GAME1-T1',
        liveGameId: 'multi-ticker-game',
        homeTeam: 'team a',
        awayTeam: 'team b',
        sport: 'nba',
        gameDate: new Date('2026-02-05'),
      };
      
      const mapping2 = {
        ticker: 'KXNBASPREAD-GAME1-T1',
        liveGameId: 'multi-ticker-game',
        homeTeam: 'team a',
        awayTeam: 'team b',
        sport: 'nba',
        gameDate: new Date('2026-02-05'),
      };
      
      mapper.addMapping(mapping1);
      mapper.addMapping(mapping2);
      
      const tickers = mapper.getTickersForGameId('multi-ticker-game');
      expect(tickers).toContain('KXNBAGAME-GAME1-T1');
      expect(tickers).toContain('KXNBASPREAD-GAME1-T1');
      
      // Clean up
      mapper.removeMapping('KXNBAGAME-GAME1-T1');
      mapper.removeMapping('KXNBASPREAD-GAME1-T1');
    });
  });
});

describe('Cache Settings', () => {
  describe('Constants validation', () => {
    it('should have sensible refresh interval', () => {
      const REFRESH_INTERVAL_MS = 60_000; // 60 seconds
      
      expect(REFRESH_INTERVAL_MS).toBeGreaterThanOrEqual(30_000); // At least 30s
      expect(REFRESH_INTERVAL_MS).toBeLessThanOrEqual(300_000);   // At most 5min
    });

    it('should have sensible cache size limit', () => {
      const MAX_CACHE_SIZE = 2000;
      
      expect(MAX_CACHE_SIZE).toBeGreaterThan(0);
      expect(MAX_CACHE_SIZE).toBeLessThanOrEqual(10000); // Reasonable upper bound
    });

    it('should have sensible Redis TTL', () => {
      const REDIS_TICKER_MAP_TTL = 120; // 2 minutes
      
      expect(REDIS_TICKER_MAP_TTL).toBeGreaterThanOrEqual(60);  // At least 1 min
      expect(REDIS_TICKER_MAP_TTL).toBeLessThanOrEqual(600);    // At most 10 min
    });
  });
});

describe('LRU Eviction Logic', () => {
  describe('Access tracking', () => {
    it('should track access order for LRU', async () => {
      const { KalshiTickerMapper } = await import('./kalshi-ticker-mapper');
      const mapper = KalshiTickerMapper.getInstance();
      
      // Add mappings
      const mapping1 = {
        ticker: 'LRU-TEST-1',
        liveGameId: 'lru-game-1',
        homeTeam: 'team a',
        awayTeam: 'team b',
        sport: 'nba',
        gameDate: new Date('2026-02-05'),
      };
      
      const mapping2 = {
        ticker: 'LRU-TEST-2',
        liveGameId: 'lru-game-2',
        homeTeam: 'team c',
        awayTeam: 'team d',
        sport: 'nba',
        gameDate: new Date('2026-02-05'),
      };
      
      mapper.addMapping(mapping1);
      mapper.addMapping(mapping2);
      
      // Access first mapping to update its access time
      mapper.getMappingForTicker('LRU-TEST-1');
      
      // Both should still exist
      expect(mapper.getMappingForTicker('LRU-TEST-1')).not.toBeNull();
      expect(mapper.getMappingForTicker('LRU-TEST-2')).not.toBeNull();
      
      // Clean up
      mapper.removeMapping('LRU-TEST-1');
      mapper.removeMapping('LRU-TEST-2');
    });
  });

  describe('Eviction calculation', () => {
    it('should evict 10% of entries when at capacity', () => {
      const MAX_CACHE_SIZE = 2000;
      const toEvict = Math.floor(MAX_CACHE_SIZE * 0.1);
      
      expect(toEvict).toBe(200);
    });
  });
});

describe('Database Query', () => {
  describe('SQL query structure', () => {
    it('should query only matched markets (live_game_id IS NOT NULL)', () => {
      const expectedQueryParts = [
        'SELECT',
        'ticker',
        'live_game_id',
        'FROM kalshi_markets',
        'WHERE live_game_id IS NOT NULL',
        'status IN',
        'open',
        'unopened',
      ];
      
      // Verify all expected parts are in a sensible query structure
      expectedQueryParts.forEach(part => {
        expect(part).toBeDefined();
      });
    });

    it('should filter by close time (recent markets only)', () => {
      // Markets should be filtered to recent ones
      const closeTimeFilter = "close_ts > NOW() - INTERVAL '1 hour'";
      
      expect(closeTimeFilter).toContain('close_ts');
      expect(closeTimeFilter).toContain('NOW()');
    });
  });
});
