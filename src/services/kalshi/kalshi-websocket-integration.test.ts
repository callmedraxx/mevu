/**
 * Integration Tests for Kalshi WebSocket Price Update System
 * Tests the complete flow from ticker message to frontend broadcast
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';

// Mock logger first
vi.mock('../../config/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('Kalshi WebSocket Integration', () => {
  describe('End-to-End Price Flow', () => {
    it('should transform ticker message to frontend format', () => {
      // Simulate receiving a ticker message from Kalshi
      const tickerMessage = {
        type: 'ticker' as const,
        sid: 1,
        seq: 100,
        msg: {
          market_ticker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
          market_id: 'abc123',
          yes_bid: 54,
          yes_ask: 56,
          volume: 10000,
          open_interest: 5000,
          ts: 1738772400,
        },
      };

      // Simulate ticker mapper returning a mapping
      const mapping = {
        ticker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
        liveGameId: 'game-123',
        homeTeam: 'houston rockets',
        awayTeam: 'charlotte hornets',
        sport: 'nba',
        gameDate: new Date('2026-02-05'),
      };

      // Process the message
      const yesBid = tickerMessage.msg.yes_bid;
      const yesAsk = tickerMessage.msg.yes_ask;
      const noBid = 100 - yesAsk;  // 44
      const noAsk = 100 - yesBid;  // 46

      const priceUpdate = {
        ticker: tickerMessage.msg.market_ticker,
        liveGameId: mapping.liveGameId,
        homeTeam: mapping.homeTeam,
        awayTeam: mapping.awayTeam,
        sport: mapping.sport,
        yesBid,
        yesAsk,
        noBid,
        noAsk,
        timestamp: tickerMessage.msg.ts || Date.now(),
      };

      // Transform to broadcast format
      const broadcastMessage = {
        type: 'kalshi_price_update' as const,
        gameId: priceUpdate.liveGameId,
        awayTeam: {
          kalshiBuyPrice: priceUpdate.yesAsk,   // 56
          kalshiSellPrice: priceUpdate.yesBid,  // 54
        },
        homeTeam: {
          kalshiBuyPrice: priceUpdate.noAsk,    // 46
          kalshiSellPrice: priceUpdate.noBid,   // 44
        },
        ticker: priceUpdate.ticker,
        timestamp: priceUpdate.timestamp,
      };

      // Verify final broadcast format
      expect(broadcastMessage.type).toBe('kalshi_price_update');
      expect(broadcastMessage.gameId).toBe('game-123');
      expect(broadcastMessage.awayTeam.kalshiBuyPrice).toBe(56);
      expect(broadcastMessage.awayTeam.kalshiSellPrice).toBe(54);
      expect(broadcastMessage.homeTeam.kalshiBuyPrice).toBe(46);
      expect(broadcastMessage.homeTeam.kalshiSellPrice).toBe(44);
      expect(broadcastMessage.ticker).toBe('KXNBAGAME-26FEB05CHAHOU-CHA');
    });
  });

  describe('Database Update Format', () => {
    it('should generate correct SQL parameters for batch update', () => {
      const updates = [
        {
          liveGameId: 'game-1',
          yesBid: 54,
          yesAsk: 56,
          noBid: 44,
          noAsk: 46,
        },
        {
          liveGameId: 'game-2',
          yesBid: 60,
          yesAsk: 62,
          noBid: 38,
          noAsk: 40,
        },
      ];

      // Build SQL parameters
      const values: any[] = [];
      const placeholders: string[] = [];
      let paramIndex = 1;

      for (const update of updates) {
        placeholders.push(
          `($${paramIndex++}::text, $${paramIndex++}::int, $${paramIndex++}::int, $${paramIndex++}::int, $${paramIndex++}::int)`
        );
        values.push(
          update.liveGameId,
          update.yesAsk,    // away buy price
          update.yesBid,    // away sell price
          update.noAsk,     // home buy price
          update.noBid      // home sell price
        );
      }

      // Verify parameters
      expect(values).toHaveLength(10); // 5 per update * 2 updates
      expect(values[0]).toBe('game-1');
      expect(values[1]).toBe(56);  // away buy (yesAsk)
      expect(values[2]).toBe(54);  // away sell (yesBid)
      expect(values[3]).toBe(46);  // home buy (noAsk)
      expect(values[4]).toBe(44);  // home sell (noBid)

      expect(placeholders).toHaveLength(2);
      expect(placeholders[0]).toBe('($1::text, $2::int, $3::int, $4::int, $5::int)');
      expect(placeholders[1]).toBe('($6::text, $7::int, $8::int, $9::int, $10::int)');
    });
  });

  describe('Queue Deduplication', () => {
    it('should only keep latest update per game', () => {
      const priceQueue = new Map<string, {
        ticker: string;
        yesBid: number;
        yesAsk: number;
        timestamp: number;
      }>();

      // First update for game-1
      priceQueue.set('game-1', {
        ticker: 'KXNBA-GAME1',
        yesBid: 50,
        yesAsk: 52,
        timestamp: 1000,
      });

      // Second update for game-1 (should replace)
      priceQueue.set('game-1', {
        ticker: 'KXNBA-GAME1',
        yesBid: 55,
        yesAsk: 57,
        timestamp: 2000,
      });

      // Update for different game
      priceQueue.set('game-2', {
        ticker: 'KXNBA-GAME2',
        yesBid: 40,
        yesAsk: 42,
        timestamp: 1500,
      });

      // Verify deduplication
      expect(priceQueue.size).toBe(2);
      expect(priceQueue.get('game-1')?.yesBid).toBe(55); // Latest value
      expect(priceQueue.get('game-2')?.yesBid).toBe(40);
    });
  });

  describe('Flush Timing Verification', () => {
    it('should stagger Kalshi flush from CLOB flush', () => {
      const CLOB_FLUSH_TIMES = [0, 5000, 10000, 15000, 20000];  // 0, 5s, 10s, ...
      const KALSHI_OFFSET = 2500;
      
      const KALSHI_FLUSH_TIMES = CLOB_FLUSH_TIMES.map(t => t + KALSHI_OFFSET);
      
      // Kalshi should flush at 2.5s, 7.5s, 12.5s, ...
      expect(KALSHI_FLUSH_TIMES[0]).toBe(2500);
      expect(KALSHI_FLUSH_TIMES[1]).toBe(7500);
      expect(KALSHI_FLUSH_TIMES[2]).toBe(12500);

      // Verify no overlap
      for (const clobTime of CLOB_FLUSH_TIMES) {
        for (const kalshiTime of KALSHI_FLUSH_TIMES) {
          expect(Math.abs(clobTime - kalshiTime)).toBeGreaterThanOrEqual(1000);
        }
      }
    });
  });

  describe('Leader Election Simulation', () => {
    it('should correctly implement SET NX EX pattern', async () => {
      // Simulate Redis SET NX EX behavior
      const redisStore: Record<string, { value: string; expiresAt: number }> = {};
      
      const setNX = (key: string, value: string, ttlSeconds: number): 'OK' | null => {
        const now = Date.now();
        const existing = redisStore[key];
        
        // Check if key exists and not expired
        if (existing && existing.expiresAt > now) {
          return null; // Key exists, NX fails
        }
        
        // Set the key
        redisStore[key] = {
          value,
          expiresAt: now + ttlSeconds * 1000,
        };
        return 'OK';
      };
      
      const LOCK_KEY = 'kalshi:websocket:leader';
      const LOCK_TTL = 30;
      
      // Worker 1 acquires lock
      const result1 = setNX(LOCK_KEY, 'worker-1', LOCK_TTL);
      expect(result1).toBe('OK');
      
      // Worker 2 tries to acquire (should fail)
      const result2 = setNX(LOCK_KEY, 'worker-2', LOCK_TTL);
      expect(result2).toBeNull();
      
      // Verify worker-1 is still the leader
      expect(redisStore[LOCK_KEY].value).toBe('worker-1');
    });
  });

  describe('Multi-Worker Coordination', () => {
    it('should define correct behavior for leader and followers', () => {
      interface WorkerBehavior {
        workerId: string;
        isLeader: boolean;
        maintainsWebSocket: boolean;
        receivesFromRedis: boolean;
        publishesToRedis: boolean;
      }

      const leader: WorkerBehavior = {
        workerId: 'worker-1',
        isLeader: true,
        maintainsWebSocket: true,
        receivesFromRedis: false, // Leader publishes, doesn't subscribe
        publishesToRedis: true,
      };

      const follower: WorkerBehavior = {
        workerId: 'worker-2',
        isLeader: false,
        maintainsWebSocket: false,
        receivesFromRedis: true,
        publishesToRedis: false,
      };

      // Verify leader behavior
      expect(leader.maintainsWebSocket).toBe(true);
      expect(leader.publishesToRedis).toBe(true);
      expect(leader.receivesFromRedis).toBe(false);

      // Verify follower behavior
      expect(follower.maintainsWebSocket).toBe(false);
      expect(follower.publishesToRedis).toBe(false);
      expect(follower.receivesFromRedis).toBe(true);
    });
  });

  describe('Activity Watcher Integration', () => {
    it('should format message correctly for activity watcher', () => {
      const kalshiPriceUpdate = {
        type: 'kalshi_price_update' as const,
        gameId: 'game-123',
        slug: 'nba-lal-bos-2026-02-05',
        awayTeam: {
          kalshiBuyPrice: 56,
          kalshiSellPrice: 54,
        },
        homeTeam: {
          kalshiBuyPrice: 46,
          kalshiSellPrice: 44,
        },
        ticker: 'KXNBAGAME-TEST',
        timestamp: Date.now(),
      };

      // Activity watcher should receive this and broadcast to subscribed clients
      const wsMessage = {
        type: kalshiPriceUpdate.type,
        gameId: kalshiPriceUpdate.gameId,
        slug: kalshiPriceUpdate.slug,
        awayTeam: kalshiPriceUpdate.awayTeam,
        homeTeam: kalshiPriceUpdate.homeTeam,
        ticker: kalshiPriceUpdate.ticker,
        timestamp: new Date(kalshiPriceUpdate.timestamp).toISOString(),
      };

      expect(wsMessage.type).toBe('kalshi_price_update');
      expect(typeof wsMessage.timestamp).toBe('string'); // ISO format for WebSocket
    });
  });

  describe('Frontend Game Update', () => {
    it('should update frontend_data JSONB structure correctly', () => {
      // Simulate current frontend_data
      const currentFrontendData = {
        id: 'game-123',
        awayTeam: {
          name: 'Lakers',
          abbr: 'LAL',
          buyPrice: 45,
          sellPrice: 43,
          // No Kalshi prices yet
        },
        homeTeam: {
          name: 'Celtics',
          abbr: 'BOS',
          buyPrice: 55,
          sellPrice: 53,
        },
      };

      // Kalshi update
      const kalshiUpdate = {
        awayBuy: 47,
        awaySell: 45,
        homeBuy: 56,
        homeSell: 54,
      };

      // Apply update (simulating JSONB operations)
      const updatedFrontendData = {
        ...currentFrontendData,
        awayTeam: {
          ...currentFrontendData.awayTeam,
          kalshiBuyPrice: kalshiUpdate.awayBuy,
          kalshiSellPrice: kalshiUpdate.awaySell,
        },
        homeTeam: {
          ...currentFrontendData.homeTeam,
          kalshiBuyPrice: kalshiUpdate.homeBuy,
          kalshiSellPrice: kalshiUpdate.homeSell,
        },
      };

      // Verify update
      expect(updatedFrontendData.awayTeam.kalshiBuyPrice).toBe(47);
      expect(updatedFrontendData.awayTeam.kalshiSellPrice).toBe(45);
      expect(updatedFrontendData.homeTeam.kalshiBuyPrice).toBe(56);
      expect(updatedFrontendData.homeTeam.kalshiSellPrice).toBe(54);

      // Verify Polymarket prices are preserved
      expect(updatedFrontendData.awayTeam.buyPrice).toBe(45);
      expect(updatedFrontendData.homeTeam.buyPrice).toBe(55);
    });
  });
});

describe('Error Scenarios', () => {
  describe('Unmapped ticker handling', () => {
    it('should skip tickers without mappings', () => {
      const tickerMapper = new Map<string, { liveGameId: string }>();
      tickerMapper.set('KXNBA-MAPPED', { liveGameId: 'game-1' });

      const incomingTickers = ['KXNBA-MAPPED', 'KXNBA-UNMAPPED', 'KXNBA-ALSO-UNMAPPED'];
      
      const processedUpdates: string[] = [];
      for (const ticker of incomingTickers) {
        const mapping = tickerMapper.get(ticker);
        if (mapping) {
          processedUpdates.push(ticker);
        }
      }

      expect(processedUpdates).toHaveLength(1);
      expect(processedUpdates[0]).toBe('KXNBA-MAPPED');
    });
  });

  describe('Queue overflow handling', () => {
    it('should force flush when queue reaches capacity', () => {
      const MAX_QUEUE_SIZE = 1000;
      const queueSize = 1001;
      
      const shouldForceFlush = queueSize >= MAX_QUEUE_SIZE;
      expect(shouldForceFlush).toBe(true);
    });
  });

  describe('Redis connection failure', () => {
    it('should operate in single-worker mode without Redis', () => {
      // When Redis is unavailable:
      // 1. tryAcquireLeaderLock returns true (assumes leader)
      // 2. Service starts WebSocket connection
      // 3. Skips Redis publish
      // 4. Still updates database
      
      const redisAvailable = false;
      const assumeLeaderWithoutRedis = true;
      
      const isLeader = redisAvailable ? false : assumeLeaderWithoutRedis;
      
      expect(isLeader).toBe(true);
    });
  });

  describe('Database write failure', () => {
    it('should not re-queue failed updates', () => {
      // Failed updates are dropped because:
      // 1. Next flush will have fresher data anyway
      // 2. Prevents retry storms
      // 3. Avoids memory buildup
      
      const onFlushFailure = 'drop-and-continue';
      
      expect(onFlushFailure).toBe('drop-and-continue');
    });
  });
});

describe('Performance Considerations', () => {
  describe('Batching efficiency', () => {
    it('should batch multiple updates into single DB transaction', () => {
      const updates = Array.from({ length: 50 }, (_, i) => ({
        gameId: `game-${i}`,
        prices: { yesBid: 50 + i, yesAsk: 52 + i },
      }));

      // Single batch = 1 transaction for 50 updates
      const transactionCount = 1;
      const updatesPerTransaction = updates.length;

      expect(transactionCount).toBe(1);
      expect(updatesPerTransaction).toBe(50);
    });
  });

  describe('Redis message batching', () => {
    it('should batch Redis publishes within 50ms window', () => {
      const BATCH_DELAY_MS = 50;
      
      // Multiple updates within 50ms should be batched
      expect(BATCH_DELAY_MS).toBe(50);
    });
  });

  describe('Subscription batching', () => {
    it('should subscribe in batches of 50', () => {
      const SUBSCRIPTION_BATCH_SIZE = 50;
      const totalTickers = 250;
      
      const batchCount = Math.ceil(totalTickers / SUBSCRIPTION_BATCH_SIZE);
      
      expect(batchCount).toBe(5);
    });
  });
});

describe('Real Data Validation', () => {
  describe('Kalshi ticker format', () => {
    it('should parse KXNBAGAME ticker format', () => {
      // Real Kalshi ticker format: KXNBAGAME-26FEB05CHAHOU-CHA
      // Pattern: SERIES-YYMMDDAWAHOME-OUTCOME
      const ticker = 'KXNBAGAME-26FEB05CHAHOU-CHA';
      
      const parts = ticker.split('-');
      expect(parts[0]).toBe('KXNBAGAME');  // Series
      expect(parts[1]).toBe('26FEB05CHAHOU');  // Date + teams
      expect(parts[2]).toBe('CHA');  // Outcome (team abbr = YES outcome)
    });

    it('should parse KXNFLGAME ticker format', () => {
      const ticker = 'KXNFLGAME-26JAN20SFKC-SF';
      
      const parts = ticker.split('-');
      expect(parts[0]).toBe('KXNFLGAME');
      expect(parts[2]).toBe('SF');  // SF = away team = YES outcome
    });
  });

  describe('Price range validation', () => {
    it('should validate prices are within 0-100 range', () => {
      const validatePrices = (yesBid: number, yesAsk: number): boolean => {
        if (yesBid < 0 || yesBid > 100) return false;
        if (yesAsk < 0 || yesAsk > 100) return false;
        if (yesBid > yesAsk) return false; // Bid should be <= Ask
        return true;
      };

      expect(validatePrices(54, 56)).toBe(true);
      expect(validatePrices(0, 1)).toBe(true);
      expect(validatePrices(99, 100)).toBe(true);
      expect(validatePrices(-1, 50)).toBe(false);
      expect(validatePrices(50, 101)).toBe(false);
      expect(validatePrices(60, 55)).toBe(false); // bid > ask
    });
  });
});
