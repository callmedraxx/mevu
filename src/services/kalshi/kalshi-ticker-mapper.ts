/**
 * Kalshi Ticker Mapper
 * Efficiently maps Kalshi market tickers to our live_game_id
 * Uses in-memory cache with periodic refresh from database
 * 
 * Key features:
 * - In-memory cache for O(1) ticker lookups during hot path
 * - Periodic refresh from database (every 60s)
 * - Redis coordination for cross-worker consistency
 * - Memory-bounded with LRU eviction
 */

import { connectWithRetry } from '../../config/database';
import { logger } from '../../config/logger';
import { registerOnGamesRefreshed } from '../polymarket/live-games.service';
import Redis from 'ioredis';

// Cache settings
// Fallback interval: refresh every 5 minutes as safety net (matches happen every ~20 min)
const REFRESH_INTERVAL_MS = 5 * 60_000;  // Refresh cache every 5 minutes (fallback)
const MAX_CACHE_SIZE = 2000;         // Max entries before LRU eviction
const REDIS_TICKER_MAP_KEY = 'kalshi:ticker_map';
const REDIS_TICKER_MAP_TTL = 120;    // 2 minute TTL in Redis

export interface TickerMapping {
  ticker: string;
  liveGameId: string;
  homeTeam: string;
  awayTeam: string;
  sport: string;
  gameDate: Date;
  /** Game slug from live_games (e.g. atp-player1-player2-date). Used for tennis to derive away/home from our slug order. */
  slug?: string;
}

export class KalshiTickerMapper {
  // In-memory cache: Kalshi ticker → mapping info
  private tickerToMapping: Map<string, TickerMapping> = new Map();
  
  // Reverse map: live_game_id → Set of Kalshi tickers
  private gameIdToTickers: Map<string, Set<string>> = new Map();
  
  // Track access order for LRU eviction
  private accessOrder: Map<string, number> = new Map();
  private accessCounter = 0;
  
  // Refresh timer
  private refreshTimer: NodeJS.Timeout | null = null;
  private isRefreshing = false;
  
  // Event-driven refresh callback
  private unregisterOnGamesRefreshed: (() => void) | null = null;
  
  // Redis client (optional, for cross-worker coordination)
  private redis: Redis | null = null;

  // Singleton pattern
  private static instance: KalshiTickerMapper | null = null;

  static getInstance(): KalshiTickerMapper {
    if (!KalshiTickerMapper.instance) {
      KalshiTickerMapper.instance = new KalshiTickerMapper();
    }
    return KalshiTickerMapper.instance;
  }

  private constructor() {}

  /**
   * Initialize the mapper
   * Sets up Redis connection, registers for event-driven refresh, and starts periodic fallback
   */
  async initialize(): Promise<void> {
    // Try to connect to Redis for cross-worker coordination
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      try {
        this.redis = new Redis(redisUrl, {
          maxRetriesPerRequest: 3,
          connectTimeout: 5000,
          commandTimeout: 5000,
        });
        
        this.redis.on('error', (err) => {
          logger.debug({
            message: 'Kalshi ticker mapper Redis error (non-critical)',
            error: err.message,
          });
        });
        
        //logger.info({ message: 'Kalshi ticker mapper Redis connected' });
      } catch (error) {
        logger.debug({
          message: 'Kalshi ticker mapper Redis connection failed (will use local cache only)',
          error: error instanceof Error ? error.message : String(error),
        });
        this.redis = null;
      }
    }

    // Initial cache load
    await this.refreshCache();

    // Register for games refresh to refresh cache when new matches occur
    // Matches happen when live games refresh (every ~20 minutes)
    this.unregisterOnGamesRefreshed = registerOnGamesRefreshed(() => {
      // Refresh cache after games refresh (when new Kalshi matches may have occurred)
      this.refreshCache().catch(err => {
        logger.error({
          message: 'Error refreshing ticker mapper cache after games refresh',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    // Start periodic refresh as fallback safety net
    this.startPeriodicRefresh();

    // logger.info({
    //   message: 'Kalshi ticker mapper initialized',
    //   cacheSize: this.tickerToMapping.size,
    //   refreshIntervalMinutes: REFRESH_INTERVAL_MS / 60_000,
    // });
  }

  /**
   * Start periodic cache refresh
   */
  private startPeriodicRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    this.refreshTimer = setInterval(async () => {
      try {
        await this.refreshCache();
      } catch (error) {
        logger.error({
          message: 'Kalshi ticker mapper refresh failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, REFRESH_INTERVAL_MS);
  }

  /**
   * Refresh cache from database
   * Loads all matched Kalshi markets (those with live_game_id set)
   */
  async refreshCache(): Promise<void> {
    if (this.isRefreshing) {
      return;
    }

    this.isRefreshing = true;
    const startTime = Date.now();

    let client;
    try {
      client = await connectWithRetry(3, 100);

      // Load all matched markets from kalshi_markets; join live_games for slug (tennis uses slug for away/home order)
      const result = await client.query(`
        SELECT 
          km.ticker,
          km.live_game_id,
          km.home_team_abbr as home_team,
          km.away_team_abbr as away_team,
          km.sport,
          km.game_date,
          lg.slug
        FROM kalshi_markets km
        LEFT JOIN live_games lg ON lg.id = km.live_game_id
        WHERE km.live_game_id IS NOT NULL
          AND km.status IN ('open', 'unopened', 'active', 'initialized')
          AND km.close_ts > NOW() - INTERVAL '1 hour'
        ORDER BY km.game_date ASC
      `);

      // Clear and rebuild cache
      this.tickerToMapping.clear();
      this.gameIdToTickers.clear();
      this.accessOrder.clear();
      this.accessCounter = 0;

      for (const row of result.rows) {
        let homeTeam = row.home_team;
        let awayTeam = row.away_team;
        // Super Bowl (KXSB-): kalshi_markets has home_team_abbr empty and away_team_abbr = ticker's team only.
        // Use game slug for game-level away/home so both tickers get the same mapping and we assign sides correctly.
        const tickerUpper = (row.ticker as string).toUpperCase();
        const slug = row.slug as string | null;
        if (tickerUpper.startsWith('KXSB-') && slug && typeof slug === 'string') {
          const parts = slug.split('-');
          // slug format: sport-away-home-yyyy-mm-dd (e.g. nfl-kc-sf-2026-02-08)
          if (parts.length >= 4) {
            awayTeam = (parts[1] ?? '').toUpperCase();
            homeTeam = (parts[2] ?? '').toUpperCase();
          }
        }
        const mapping: TickerMapping = {
          ticker: row.ticker,
          liveGameId: row.live_game_id,
          homeTeam,
          awayTeam,
          sport: row.sport,
          gameDate: row.game_date,
          slug: row.slug ?? undefined,
        };

        this.tickerToMapping.set(row.ticker, mapping);
        this.accessOrder.set(row.ticker, this.accessCounter++);

        // Build reverse map
        if (!this.gameIdToTickers.has(row.live_game_id)) {
          this.gameIdToTickers.set(row.live_game_id, new Set());
        }
        this.gameIdToTickers.get(row.live_game_id)!.add(row.ticker);
      }

      // Store in Redis for cross-worker access
      if (this.redis) {
        try {
          const cacheData = JSON.stringify(
            Object.fromEntries(
              Array.from(this.tickerToMapping.entries()).map(([k, v]) => [
                k,
                { ...v, gameDate: v.gameDate.toISOString() },
              ])
            )
          );
          await this.redis.set(REDIS_TICKER_MAP_KEY, cacheData, 'EX', REDIS_TICKER_MAP_TTL);
        } catch (redisError) {
          // Non-critical - local cache still works
          logger.debug({
            message: 'Failed to store ticker map in Redis',
            error: redisError instanceof Error ? redisError.message : String(redisError),
          });
        }
      }

      // logger.info({
      //   message: 'Kalshi ticker mapper cache refreshed',
      //   tickerCount: this.tickerToMapping.size,
      //   gameCount: this.gameIdToTickers.size,
      //   durationMs: Date.now() - startTime,
      // });
    } catch (error) {
      logger.error({
        message: 'Kalshi ticker mapper cache refresh failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (client) {
        client.release();
      }
      this.isRefreshing = false;
    }
  }

  /**
   * Get mapping for a ticker (O(1) lookup)
   * Updates access order for LRU tracking
   */
  getMappingForTicker(ticker: string): TickerMapping | null {
    const mapping = this.tickerToMapping.get(ticker);
    if (mapping) {
      // Update access order for LRU
      this.accessOrder.set(ticker, this.accessCounter++);
    }
    return mapping || null;
  }

  /**
   * Get game ID for a ticker (convenience method)
   */
  getGameIdForTicker(ticker: string): string | null {
    const mapping = this.getMappingForTicker(ticker);
    return mapping?.liveGameId || null;
  }

  /**
   * Get all tickers for a game ID
   */
  getTickersForGameId(gameId: string): string[] {
    const tickers = this.gameIdToTickers.get(gameId);
    return tickers ? Array.from(tickers) : [];
  }

  /**
   * Get all mapped tickers (for subscription)
   */
  getAllMappedTickers(): string[] {
    return Array.from(this.tickerToMapping.keys());
  }

  /**
   * Get all mapped game IDs
   */
  getAllMappedGameIds(): string[] {
    return Array.from(this.gameIdToTickers.keys());
  }

  /**
   * Add a new mapping (for real-time updates when matching completes)
   */
  addMapping(mapping: TickerMapping): void {
    // Check cache size and evict if necessary
    if (this.tickerToMapping.size >= MAX_CACHE_SIZE) {
      this.evictLRU();
    }

    this.tickerToMapping.set(mapping.ticker, mapping);
    this.accessOrder.set(mapping.ticker, this.accessCounter++);

    if (!this.gameIdToTickers.has(mapping.liveGameId)) {
      this.gameIdToTickers.set(mapping.liveGameId, new Set());
    }
    this.gameIdToTickers.get(mapping.liveGameId)!.add(mapping.ticker);
  }

  /**
   * Remove a mapping
   */
  removeMapping(ticker: string): void {
    const mapping = this.tickerToMapping.get(ticker);
    if (!mapping) return;

    this.tickerToMapping.delete(ticker);
    this.accessOrder.delete(ticker);

    // Update reverse map
    const tickers = this.gameIdToTickers.get(mapping.liveGameId);
    if (tickers) {
      tickers.delete(ticker);
      if (tickers.size === 0) {
        this.gameIdToTickers.delete(mapping.liveGameId);
      }
    }
  }

  /**
   * Evict least recently used entries
   */
  private evictLRU(): void {
    const toEvict = Math.floor(MAX_CACHE_SIZE * 0.1); // Evict 10%
    
    // Sort by access order (oldest first)
    const sorted = Array.from(this.accessOrder.entries())
      .sort((a, b) => a[1] - b[1])
      .slice(0, toEvict);

    for (const [ticker] of sorted) {
      this.removeMapping(ticker);
    }

    // logger.debug({
    //   message: 'Kalshi ticker mapper LRU eviction',
    //   evictedCount: sorted.length,
    //   remainingSize: this.tickerToMapping.size,
    // });
  }

  /**
   * Get cache stats
   */
  getStats(): {
    tickerCount: number;
    gameCount: number;
    isRefreshing: boolean;
  } {
    return {
      tickerCount: this.tickerToMapping.size,
      gameCount: this.gameIdToTickers.size,
      isRefreshing: this.isRefreshing,
    };
  }

  /**
   * Shutdown
   */
  async shutdown(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.unregisterOnGamesRefreshed) {
      this.unregisterOnGamesRefreshed();
      this.unregisterOnGamesRefreshed = null;
    }

    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }

    this.tickerToMapping.clear();
    this.gameIdToTickers.clear();
    this.accessOrder.clear();

    logger.info({ message: 'Kalshi ticker mapper shut down' });
  }
}

// Export singleton getter
export function getKalshiTickerMapper(): KalshiTickerMapper {
  return KalshiTickerMapper.getInstance();
}
