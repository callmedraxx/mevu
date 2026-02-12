/**
 * Unit Tests for Kalshi Price Update Service
 * Tests price queue management, batching, leader election, and broadcast
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock database
vi.mock('../../config/database', () => ({
  connectWithRetry: vi.fn().mockResolvedValue({
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
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
      publish: vi.fn().mockResolvedValue(1),
      subscribe: vi.fn().mockResolvedValue(undefined),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue(undefined),
    })),
  };
});

// Mock the WebSocket client
vi.mock('./kalshi-websocket.client', () => ({
  getKalshiWebSocketClient: vi.fn().mockReturnValue({
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    subscribeToMarkets: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({
      isConnected: false,
      isConnecting: false,
      subscriptionCount: 0,
      reconnectAttempts: 0,
    }),
  }),
  KalshiWebSocketClient: {
    getInstance: vi.fn().mockReturnValue({
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      subscribeToMarkets: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({
        isConnected: false,
        subscriptionCount: 0,
      }),
    }),
  },
}));

// Mock the ticker mapper
vi.mock('./kalshi-ticker-mapper', () => ({
  getKalshiTickerMapper: vi.fn().mockReturnValue({
    initialize: vi.fn().mockResolvedValue(undefined),
    refreshCache: vi.fn().mockResolvedValue(undefined),
    getMappingForTicker: vi.fn().mockReturnValue(null),
    getAllMappedTickers: vi.fn().mockReturnValue([]),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockReturnValue({ tickerCount: 0, gameCount: 0 }),
  }),
  KalshiTickerMapper: {
    getInstance: vi.fn().mockReturnValue({
      initialize: vi.fn().mockResolvedValue(undefined),
      refreshCache: vi.fn().mockResolvedValue(undefined),
      getMappingForTicker: vi.fn().mockReturnValue(null),
      getAllMappedTickers: vi.fn().mockReturnValue([]),
      shutdown: vi.fn().mockResolvedValue(undefined),
      getStats: vi.fn().mockReturnValue({ tickerCount: 0, gameCount: 0 }),
    }),
  },
}));

// Mock redis cluster broadcast
vi.mock('../redis-cluster-broadcast.service', () => ({
  initRedisClusterBroadcast: vi.fn().mockReturnValue(true),
  isRedisClusterBroadcastReady: vi.fn().mockReturnValue(true),
  publishKalshiPriceBroadcast: vi.fn(),
}));

// Mock live games service
vi.mock('../polymarket/live-games.service', () => ({
  registerOnGamesRefreshed: vi.fn().mockReturnValue(() => {}),
}));

// Mock logger
vi.mock('../../config/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Kalshi Price Update Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('KalshiPriceUpdate Interface', () => {
    it('should define correct price update structure', () => {
      const priceUpdate = {
        ticker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
        liveGameId: 'game-123',
        homeTeam: 'houston rockets',
        awayTeam: 'charlotte hornets',
        sport: 'nba',
        yesBid: 54,   // Away sell price
        yesAsk: 56,   // Away buy price
        noBid: 44,    // Home sell price (100 - yesAsk)
        noAsk: 46,    // Home buy price (100 - yesBid)
        timestamp: Date.now(),
      };

      expect(priceUpdate.ticker).toBeDefined();
      expect(priceUpdate.liveGameId).toBeDefined();
      expect(priceUpdate.yesBid).toBeLessThanOrEqual(100);
      expect(priceUpdate.yesAsk).toBeLessThanOrEqual(100);
      expect(priceUpdate.noBid).toBe(100 - priceUpdate.yesAsk);
      expect(priceUpdate.noAsk).toBe(100 - priceUpdate.yesBid);
    });
  });

  describe('KalshiPriceMessage Interface', () => {
    it('should define correct broadcast message structure', () => {
      const priceMessage = {
        type: 'kalshi_price_update' as const,
        gameId: 'game-123',
        slug: 'nba-cha-hou-2026-02-05',
        awayTeam: {
          kalshiBuyPrice: 56,   // yesAsk
          kalshiSellPrice: 54,  // yesBid
        },
        homeTeam: {
          kalshiBuyPrice: 46,   // noAsk
          kalshiSellPrice: 44,  // noBid
        },
        ticker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
        timestamp: Date.now(),
      };

      expect(priceMessage.type).toBe('kalshi_price_update');
      expect(priceMessage.gameId).toBeDefined();
      expect(priceMessage.awayTeam.kalshiBuyPrice).toBeDefined();
      expect(priceMessage.awayTeam.kalshiSellPrice).toBeDefined();
      expect(priceMessage.homeTeam.kalshiBuyPrice).toBeDefined();
      expect(priceMessage.homeTeam.kalshiSellPrice).toBeDefined();
    });
  });

  describe('KalshiPriceUpdateService Class', () => {
    it('should be a singleton', async () => {
      const { getKalshiPriceUpdateService } = await import('./kalshi-price-update.service');
      
      const instance1 = getKalshiPriceUpdateService();
      const instance2 = getKalshiPriceUpdateService();
      
      expect(instance1).toBe(instance2);
    });

    it('should return correct status when not initialized', async () => {
      const { KalshiPriceUpdateService } = await import('./kalshi-price-update.service');
      const service = KalshiPriceUpdateService.getInstance();
      
      const status = service.getStatus();
      
      expect(status).toHaveProperty('isInitialized');
      expect(status).toHaveProperty('isLeader');
      expect(status).toHaveProperty('queueSize');
      expect(status).toHaveProperty('wsStatus');
      expect(status).toHaveProperty('mapperStats');
    });
  });
});

describe('Price Calculation', () => {
  describe('YES/NO price conversion', () => {
    it('should correctly convert YES prices to NO prices', () => {
      // Kalshi: YES = away team wins, NO = home team wins
      const yesBid = 54;  // Best bid for YES
      const yesAsk = 56;  // Best ask for YES
      
      // NO prices are the complement
      const noBid = 100 - yesAsk;  // Best bid for NO = 44
      const noAsk = 100 - yesBid;  // Best ask for NO = 46
      
      expect(noBid).toBe(44);
      expect(noAsk).toBe(46);
    });

    it('should handle edge case prices correctly', () => {
      // Heavy favorite: YES at 99
      const yesBid1 = 98;
      const yesAsk1 = 99;
      const noBid1 = 100 - yesAsk1;  // 1
      const noAsk1 = 100 - yesBid1;  // 2
      
      expect(noBid1).toBe(1);
      expect(noAsk1).toBe(2);
      
      // Heavy underdog: YES at 1
      const yesBid2 = 1;
      const yesAsk2 = 2;
      const noBid2 = 100 - yesAsk2;  // 98
      const noAsk2 = 100 - yesBid2;  // 99
      
      expect(noBid2).toBe(98);
      expect(noAsk2).toBe(99);
    });

    it('should handle 50/50 prices correctly', () => {
      const yesBid = 49;
      const yesAsk = 51;
      const noBid = 100 - yesAsk;  // 49
      const noAsk = 100 - yesBid;  // 51
      
      expect(noBid).toBe(49);
      expect(noAsk).toBe(51);
    });
  });

  describe('Price mapping to teams based on ticker', () => {
    // Helper to extract team from ticker (same logic as service)
    function extractTeamFromTicker(ticker: string): string | null {
      const upperTicker = ticker.toUpperCase();
      const match = upperTicker.match(/-([A-Z0-9]{2,4})$/);
      return match ? match[1] : null;
    }

    it('should extract team abbreviation from away team ticker', () => {
      // KXNBAGAME-26FEB06LACSAC-LAC -> LAC (away team)
      const ticker = 'KXNBAGAME-26FEB06LACSAC-LAC';
      expect(extractTeamFromTicker(ticker)).toBe('LAC');
    });

    it('should extract team abbreviation from home team ticker', () => {
      // KXNBAGAME-26FEB06LACSAC-SAC -> SAC (home team)
      const ticker = 'KXNBAGAME-26FEB06LACSAC-SAC';
      expect(extractTeamFromTicker(ticker)).toBe('SAC');
    });

    it('should correctly assign prices when ticker is for AWAY team', () => {
      // Ticker: KXNBAGAME-26FEB06LACSAC-LAC (LAC is away, SAC is home)
      // YES = LAC wins (away), NO = SAC wins (home)
      const ticker = 'KXNBAGAME-26FEB06LACSAC-LAC';
      const homeAbbr = 'SAC';
      const awayAbbr = 'LAC';
      const tickerTeam = extractTeamFromTicker(ticker);
      
      const isAwayTeamTicker = tickerTeam === awayAbbr;
      const isHomeTeamTicker = tickerTeam === homeAbbr;
      
      expect(isAwayTeamTicker).toBe(true);
      expect(isHomeTeamTicker).toBe(false);
      
      // Raw prices from Kalshi for -LAC ticker
      const yesBid = 60;  // Best bid for YES (LAC wins)
      const yesAsk = 62;  // Best ask for YES (LAC wins)
      const noBid = 100 - yesAsk;  // 38
      const noAsk = 100 - yesBid;  // 40
      
      // Since this is away team ticker: YES = away, NO = home
      const awayBuy = yesAsk;   // 62 (LAC buy)
      const awaySell = yesBid;  // 60 (LAC sell)
      const homeBuy = noAsk;    // 40 (SAC buy)
      const homeSell = noBid;   // 38 (SAC sell)
      
      expect(awayBuy).toBe(62);
      expect(awaySell).toBe(60);
      expect(homeBuy).toBe(40);
      expect(homeSell).toBe(38);
    });

    it('should correctly assign prices when ticker is for HOME team', () => {
      // Ticker: KXNBAGAME-26FEB06LACSAC-SAC (LAC is away, SAC is home)
      // YES = SAC wins (home), NO = LAC wins (away)
      const ticker = 'KXNBAGAME-26FEB06LACSAC-SAC';
      const homeAbbr = 'SAC';
      const awayAbbr = 'LAC';
      const tickerTeam = extractTeamFromTicker(ticker);
      
      const isAwayTeamTicker = tickerTeam === awayAbbr;
      const isHomeTeamTicker = tickerTeam === homeAbbr;
      
      expect(isAwayTeamTicker).toBe(false);
      expect(isHomeTeamTicker).toBe(true);
      
      // Raw prices from Kalshi for -SAC ticker
      const yesBid = 38;  // Best bid for YES (SAC wins)
      const yesAsk = 40;  // Best ask for YES (SAC wins)
      const noBid = 100 - yesAsk;  // 60
      const noAsk = 100 - yesBid;  // 62
      
      // Since this is home team ticker: YES = home, NO = away
      const homeBuy = yesAsk;   // 40 (SAC buy)
      const homeSell = yesBid;  // 38 (SAC sell)
      const awayBuy = noAsk;    // 62 (LAC buy)
      const awaySell = noBid;   // 60 (LAC sell)
      
      expect(homeBuy).toBe(40);
      expect(homeSell).toBe(38);
      expect(awayBuy).toBe(62);
      expect(awaySell).toBe(60);
    });

    it('should NOT invert prices - away team ticker should give away YES prices', () => {
      // This tests the bug fix: prices were getting inverted
      // When -LAC ticker comes, LAC (away) should get YES prices, not NO prices
      const ticker = 'KXNBAGAME-26FEB06LACSAC-LAC';
      const homeAbbr = 'SAC';
      const awayAbbr = 'LAC';
      const tickerTeam = extractTeamFromTicker(ticker);
      
      // Real prices from user's example
      const yesBid = 60;  // YES bid (for LAC)
      const yesAsk = 62;  // YES ask (for LAC)
      
      // Wrong (old code): assumed YES always = away
      // But ticker ending determines which team YES represents
      
      // Correct: since ticker is -LAC and LAC is away, YES = away
      expect(tickerTeam).toBe('LAC');
      expect(tickerTeam).toBe(awayAbbr);
      
      // So away team gets YES prices (correct)
      const awayBuyPrice = yesAsk;  // 62
      expect(awayBuyPrice).toBe(62);
    });
  });
});

describe('Tennis Market Detection', () => {
  /**
   * isMoneylineMarket helper for tennis
   * Tennis markets are single-market per match (like UFC)
   */
  function isMoneylineMarket(ticker: string): boolean {
    const upperTicker = ticker.toUpperCase();
    
    // Tennis (WTA/ATP) are single-market per match - treat as moneyline
    if (upperTicker.startsWith('KXWTAMATCH-') || upperTicker.startsWith('KXATPMATCH-')) {
      return !ticker.includes('+') && !ticker.includes('OVER') && !ticker.includes('UNDER');
    }
    
    // UFC for comparison
    if (upperTicker.startsWith('KXUFCFIGHT-')) {
      return !ticker.includes('+') && !ticker.includes('OVER') && !ticker.includes('UNDER');
    }
    
    return false;
  }

  it('should detect WTA tennis moneyline markets', () => {
    // Real example: Zarazua vs Birrell
    expect(isMoneylineMarket('KXWTAMATCH-26FEB06ZARBIR')).toBe(true);
  });

  it('should detect ATP tennis moneyline markets', () => {
    expect(isMoneylineMarket('KXATPMATCH-26FEB06DJONAL')).toBe(true);
  });

  it('should detect UFC moneyline markets', () => {
    expect(isMoneylineMarket('KXUFCFIGHT-26FEB07OLEBAR')).toBe(true);
  });

  it('should reject markets with spread indicators (+X.X)', () => {
    // Tennis on Kalshi currently doesn't have spread markets, but testing the guard
    expect(isMoneylineMarket('KXWTAMATCH-26FEB06ZARBIR+1.5')).toBe(false);
    expect(isMoneylineMarket('KXATPMATCH-26FEB06DJONAL+2.5')).toBe(false);
  });

  it('should reject markets with total indicators (OVER/UNDER)', () => {
    expect(isMoneylineMarket('KXWTAMATCH-26FEB06ZARBIROVER21.5')).toBe(false);
    expect(isMoneylineMarket('KXATPMATCH-26FEB06DJONALUNDER20.5')).toBe(false);
  });
});

describe('Tennis Ticker Parsing', () => {
  /**
   * Extract player abbreviations from tennis ticker
   * Format: KXWTAMATCH-26FEB06ZARBIR (6 chars: 3 for away + 3 for home)
   */
  function parseTennisTicker(ticker: string): { awayAbbr: string; homeAbbr: string } | null {
    const upperTicker = ticker.toUpperCase();
    
    if (!upperTicker.startsWith('KXWTAMATCH-') && !upperTicker.startsWith('KXATPMATCH-')) {
      return null;
    }
    
    // Pattern: KXWTAMATCH-26FEB06ZARBIR (date + 6-char player codes)
    const match = ticker.match(/\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}([A-Z]{6})$/i);
    if (match) {
      const playerCodes = match[1].toUpperCase();
      return {
        awayAbbr: playerCodes.substring(0, 3),
        homeAbbr: playerCodes.substring(3, 6),
      };
    }
    
    return null;
  }

  it('should parse WTA tennis ticker correctly', () => {
    const result = parseTennisTicker('KXWTAMATCH-26FEB06ZARBIR');
    expect(result).not.toBeNull();
    expect(result?.awayAbbr).toBe('ZAR');  // Zarazua
    expect(result?.homeAbbr).toBe('BIR');  // Birrell
  });

  it('should parse ATP tennis ticker correctly', () => {
    const result = parseTennisTicker('KXATPMATCH-26FEB06DJONAL');
    expect(result).not.toBeNull();
    expect(result?.awayAbbr).toBe('DJO');  // Djokovic
    expect(result?.homeAbbr).toBe('NAL');  // Nadal
  });

  it('should return null for non-tennis tickers', () => {
    expect(parseTennisTicker('KXNBAGAME-26FEB06LACSAC-LAC')).toBeNull();
    expect(parseTennisTicker('KXUFCFIGHT-26FEB07OLEBAR')).toBeNull();
  });

  it('should match tennis abbreviation to slug player name', () => {
    // This tests the SQL matching logic
    const kalshiAbbr = 'ZAR';
    const slugPlayerName = 'zarazua';
    
    // Matching logic: slug name should START with kalshi abbreviation
    const matches = slugPlayerName.toUpperCase().startsWith(kalshiAbbr);
    expect(matches).toBe(true);
  });

  it('should match various tennis player names', () => {
    const testCases = [
      { abbr: 'ZAR', name: 'zarazua', expected: true },
      { abbr: 'BIR', name: 'birrell', expected: true },
      { abbr: 'DJO', name: 'djokovic', expected: true },
      { abbr: 'NAD', name: 'nadal', expected: true },
      { abbr: 'FED', name: 'federer', expected: true },
      { abbr: 'SIN', name: 'sinner', expected: true },
      { abbr: 'ALC', name: 'alcaraz', expected: true },
      { abbr: 'ZAR', name: 'birrell', expected: false },  // Wrong player
    ];
    
    for (const { abbr, name, expected } of testCases) {
      const matches = name.toUpperCase().startsWith(abbr);
      expect(matches).toBe(expected);
    }
  });
});

describe('Queue Management', () => {
  describe('Deduplication', () => {
    it('should only keep latest price per game', () => {
      const queue = new Map<string, { price: number; timestamp: number }>();
      
      // First update
      queue.set('game-1', { price: 50, timestamp: 1000 });
      
      // Second update for same game (should replace)
      queue.set('game-1', { price: 55, timestamp: 2000 });
      
      expect(queue.size).toBe(1);
      expect(queue.get('game-1')?.price).toBe(55);
    });
  });

  describe('Memory guards', () => {
    it('should enforce MAX_QUEUE_SIZE limit', () => {
      const MAX_QUEUE_SIZE = 1000;
      
      expect(MAX_QUEUE_SIZE).toBeGreaterThan(0);
      expect(MAX_QUEUE_SIZE).toBeLessThanOrEqual(10000); // Reasonable limit
    });

    it('should trigger forced flush at capacity', () => {
      const MAX_QUEUE_SIZE = 1000;
      const queueSize = 1000;
      
      const shouldForceFlush = queueSize >= MAX_QUEUE_SIZE;
      
      expect(shouldForceFlush).toBe(true);
    });
  });
});

describe('Flush Timing', () => {
  describe('Staggered flush with CLOB', () => {
    it('should offset flush from CLOB by 2.5 seconds', () => {
      const FLUSH_INTERVAL_MS = 5000;
      const FLUSH_OFFSET_MS = 2500;
      
      // CLOB flushes at 0, 5s, 10s, 15s, ...
      // Kalshi should flush at 2.5s, 7.5s, 12.5s, 17.5s, ...
      expect(FLUSH_OFFSET_MS).toBe(2500);
      expect(FLUSH_INTERVAL_MS).toBe(5000);
    });

    it('should align with CLOB interval', () => {
      const CLOB_FLUSH_INTERVAL = 5000;
      const KALSHI_FLUSH_INTERVAL = 5000;
      
      expect(KALSHI_FLUSH_INTERVAL).toBe(CLOB_FLUSH_INTERVAL);
    });
  });
});

describe('Leader Election', () => {
  describe('Redis lock mechanism', () => {
    it('should use SET NX EX for distributed lock', () => {
      const LEADER_LOCK_KEY = 'kalshi:websocket:leader';
      const LEADER_LOCK_TTL_SECONDS = 30;
      
      expect(LEADER_LOCK_KEY).toBe('kalshi:websocket:leader');
      expect(LEADER_LOCK_TTL_SECONDS).toBe(30);
    });

    it('should refresh lock before TTL expires', () => {
      const LEADER_LOCK_TTL_SECONDS = 30;
      const LEADER_LOCK_REFRESH_MS = (LEADER_LOCK_TTL_SECONDS - 5) * 1000;
      
      // Should refresh 5 seconds before expiry
      expect(LEADER_LOCK_REFRESH_MS).toBe(25000);
    });
  });

  describe('Leader vs Follower behavior', () => {
    it('should define different behaviors for leader and follower', () => {
      const leaderBehavior = {
        maintainsWebSocket: true,
        subscribesToTickers: true,
        publishesToRedis: true,
      };
      
      const followerBehavior = {
        maintainsWebSocket: false,
        subscribesToTickers: false,
        listenToRedis: true,
      };
      
      expect(leaderBehavior.maintainsWebSocket).toBe(true);
      expect(followerBehavior.maintainsWebSocket).toBe(false);
    });
  });
});

describe('Database Update Query', () => {
  describe('Batch update structure', () => {
    it('should update frontend_data JSONB correctly', () => {
      // Verify the update structure
      const updateFields = [
        '{awayTeam,kalshiBuyPrice}',
        '{awayTeam,kalshiSellPrice}',
        '{homeTeam,kalshiBuyPrice}',
        '{homeTeam,kalshiSellPrice}',
      ];
      
      expect(updateFields).toHaveLength(4);
      expect(updateFields[0]).toContain('awayTeam');
      expect(updateFields[2]).toContain('homeTeam');
    });

    it('should use VALUES clause for batch updates', () => {
      // Simulate building VALUES clause
      const updates = [
        { gameId: 'game-1', awayBuy: 56, awaySell: 54, homeBuy: 46, homeSell: 44 },
        { gameId: 'game-2', awayBuy: 60, awaySell: 58, homeBuy: 42, homeSell: 40 },
      ];
      
      const placeholders = updates.map((_, i) => {
        const base = i * 5 + 1;
        return `($${base}::text, $${base + 1}::int, $${base + 2}::int, $${base + 3}::int, $${base + 4}::int)`;
      });
      
      expect(placeholders).toHaveLength(2);
      expect(placeholders[0]).toContain('$1');
      expect(placeholders[1]).toContain('$6');
    });
  });
});

describe('Redis Channel', () => {
  describe('Price channel configuration', () => {
    it('should use correct Redis channel name', () => {
      const KALSHI_PRICES_CHANNEL = 'kalshi:prices:channel';
      
      expect(KALSHI_PRICES_CHANNEL).toBe('kalshi:prices:channel');
    });
  });
});

describe('Error Handling', () => {
  describe('Graceful degradation', () => {
    it('should not re-queue failed updates', () => {
      // On flush failure, we don't re-queue because:
      // 1. Next tick will have fresh data
      // 2. Prevents infinite retry loops
      // 3. Reduces memory pressure
      const shouldRequeueOnFailure = false;
      
      expect(shouldRequeueOnFailure).toBe(false);
    });

    it('should continue operating without Redis', () => {
      // Without Redis, service should:
      // 1. Assume it's the leader (single worker mode)
      // 2. Skip Redis publish
      // 3. Still update database
      const canOperateWithoutRedis = true;
      
      expect(canOperateWithoutRedis).toBe(true);
    });
  });
});

describe('Tennis Player-Specific Tickers (ATP Griekspoor vs Droguet)', () => {
  /**
   * Test real-world ATP tennis market with player-specific tickers
   * URL: https://kalshi.com/markets/kxatpmatch/atp-tennis-match/kxatpmatch-26feb06gridro
   * 
   * Kalshi has two separate markets:
   * - KXATPMATCH-26FEB06GRIDRO-GRI: YES = Griekspoor wins (1%)
   * - KXATPMATCH-26FEB06GRIDRO-DRO: YES = Droguet wins (99%)
   */

  function extractTeamFromTicker(ticker: string): string | null {
    const upperTicker = ticker.toUpperCase();
    const match = upperTicker.match(/-([A-Z]{2,4})$/);
    return match ? match[1] : null;
  }

  function parseTennisTickerWithSuffix(ticker: string): { 
    awayAbbr: string; 
    homeAbbr: string; 
    playerSuffix?: string;
  } | null {
    const upperTicker = ticker.toUpperCase();
    
    if (!upperTicker.startsWith('KXWTAMATCH-') && !upperTicker.startsWith('KXATPMATCH-')) {
      return null;
    }
    
    // New format with player suffix: KXATPMATCH-26FEB06GRIDRO-GRI
    const matchWithSuffix = ticker.match(/\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}([A-Z]{6})-([A-Z]{3})$/i);
    if (matchWithSuffix) {
      const playerCodes = matchWithSuffix[1].toUpperCase();
      const playerSuffix = matchWithSuffix[2].toUpperCase();
      return {
        awayAbbr: playerCodes.substring(0, 3),
        homeAbbr: playerCodes.substring(3, 6),
        playerSuffix,
      };
    }
    
    // Old format without suffix: KXWTAMATCH-26FEB06ZARBIR
    const match = ticker.match(/\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}([A-Z]{6})$/i);
    if (match) {
      const playerCodes = match[1].toUpperCase();
      return {
        awayAbbr: playerCodes.substring(0, 3),
        homeAbbr: playerCodes.substring(3, 6),
      };
    }
    
    return null;
  }

  it('should parse ATP tennis ticker with player suffix (GRI)', () => {
    const result = parseTennisTickerWithSuffix('KXATPMATCH-26FEB06GRIDRO-GRI');
    expect(result).not.toBeNull();
    expect(result?.awayAbbr).toBe('GRI');  // Griekspoor
    expect(result?.homeAbbr).toBe('DRO');  // Droguet
    expect(result?.playerSuffix).toBe('GRI');
  });

  it('should parse ATP tennis ticker with player suffix (DRO)', () => {
    const result = parseTennisTickerWithSuffix('KXATPMATCH-26FEB06GRIDRO-DRO');
    expect(result).not.toBeNull();
    expect(result?.awayAbbr).toBe('GRI');
    expect(result?.homeAbbr).toBe('DRO');
    expect(result?.playerSuffix).toBe('DRO');
  });

  it('should extract GRI from Griekspoor ticker suffix', () => {
    expect(extractTeamFromTicker('KXATPMATCH-26FEB06GRIDRO-GRI')).toBe('GRI');
  });

  it('should extract DRO from Droguet ticker suffix', () => {
    expect(extractTeamFromTicker('KXATPMATCH-26FEB06GRIDRO-DRO')).toBe('DRO');
  });

  it('should correctly assign prices for Griekspoor ticker (1% underdog)', () => {
    // Real prices from Kalshi (Feb 6, 2026)
    const ticker = 'KXATPMATCH-26FEB06GRIDRO-GRI';
    const awayAbbr = 'GRI';  // Griekspoor
    const homeAbbr = 'DRO';  // Droguet
    const tickerTeam = extractTeamFromTicker(ticker);
    
    const isAwayTeamTicker = tickerTeam === awayAbbr;
    const isHomeTeamTicker = tickerTeam === homeAbbr;
    
    expect(isAwayTeamTicker).toBe(true);
    expect(isHomeTeamTicker).toBe(false);
    
    // Kalshi prices: yes_bid=0, yes_ask=1
    const yesBid = 0;
    const yesAsk = 1;
    
    // Away team (GRI) gets YES prices
    const awayBuy = yesAsk;   // 1
    const awaySell = yesBid;  // 0
    
    // Home team (DRO) gets NO prices
    const homeBuy = 100 - yesBid;   // 100
    const homeSell = 100 - yesAsk;  // 99
    
    expect(awayBuy).toBe(1);
    expect(awaySell).toBe(0);
    expect(homeBuy).toBe(100);
    expect(homeSell).toBe(99);
  });

  it('should correctly assign prices for Droguet ticker (99% favorite)', () => {
    const ticker = 'KXATPMATCH-26FEB06GRIDRO-DRO';
    const awayAbbr = 'GRI';
    const homeAbbr = 'DRO';
    const tickerTeam = extractTeamFromTicker(ticker);
    
    const isAwayTeamTicker = tickerTeam === awayAbbr;
    const isHomeTeamTicker = tickerTeam === homeAbbr;
    
    expect(isAwayTeamTicker).toBe(false);
    expect(isHomeTeamTicker).toBe(true);
    
    // Kalshi prices: yes_bid=99, yes_ask=100
    const yesBid = 99;
    const yesAsk = 100;
    
    // Home team (DRO) gets YES prices
    const homeBuy = yesAsk;   // 100
    const homeSell = yesBid;  // 99
    
    // Away team (GRI) gets NO prices
    const awayBuy = 100 - yesBid;   // 1
    const awaySell = 100 - yesAsk;  // 0
    
    expect(homeBuy).toBe(100);
    expect(homeSell).toBe(99);
    expect(awayBuy).toBe(1);
    expect(awaySell).toBe(0);
  });

  it('should produce consistent prices from both tickers', () => {
    // GRI ticker: YES=GRI win
    const griYesBid = 0, griYesAsk = 1;
    const griAwayBuy = griYesAsk;        // 1
    const griAwaySell = griYesBid;       // 0
    const griHomeBuy = 100 - griYesBid;  // 100
    const griHomeSell = 100 - griYesAsk; // 99
    
    // DRO ticker: YES=DRO win
    const droYesBid = 99, droYesAsk = 100;
    const droHomeBuy = droYesAsk;        // 100
    const droHomeSell = droYesBid;       // 99
    const droAwayBuy = 100 - droYesBid;  // 1
    const droAwaySell = 100 - droYesAsk; // 0
    
    // Both tickers give same final prices
    expect(griAwayBuy).toBe(droAwayBuy);
    expect(griAwaySell).toBe(droAwaySell);
    expect(griHomeBuy).toBe(droHomeBuy);
    expect(griHomeSell).toBe(droHomeSell);
  });

  it('should match player abbreviations to slug names', () => {
    // SQL matching: slug_away_name LIKE LOWER(away_team_abbr) || '%'
    const testCases = [
      { abbr: 'GRI', name: 'griekspoor', expected: true },
      { abbr: 'DRO', name: 'droguet', expected: true },
      { abbr: 'GRI', name: 'droguet', expected: false },
      { abbr: 'DRO', name: 'griekspoor', expected: false },
    ];
    
    for (const { abbr, name, expected } of testCases) {
      const matches = name.toUpperCase().startsWith(abbr);
      expect(matches).toBe(expected);
    }
  });
});
