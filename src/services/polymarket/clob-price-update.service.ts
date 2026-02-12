/**
 * CLOB Price Update Service
 * Manages CLOB WebSocket subscriptions and updates prices/probabilities for all live games
 * Uses price_change events with best_ask for probability updates
 */

import { logger } from '../../config/logger';
import { clobWebSocketService } from './clob-websocket.service';
import { ClobPriceChangeUpdate, ClobPriceChange } from './polymarket.types';
import { getAllLiveGames, updateGameInCache, LiveGame, registerOnGamesRefreshed, registerOnRefreshStarting, registerOnRefreshEnded, acquireLiveGamesWriteLock, releaseLiveGamesWriteLock } from './live-games.service';
import { positionsWebSocketService } from '../positions/positions-websocket.service';
import { connectWithRetry } from '../../config/database';
import { transformToFrontendGame, FrontendGame, KalshiPriceData } from './frontend-game.transformer';
import { transformToActivityWatcherGame, ActivityWatcherGame } from './activity-watcher.transformer';
import { bulkUpsertFrontendGamesWithClient, clearFrontendGamesCache } from './frontend-games.service';
import { kalshiService } from '../kalshi/kalshi.service';
import {
  publishGamesBroadcast,
  publishActivityBroadcast,
  isRedisGamesBroadcastReady,
} from '../redis-cluster-broadcast.service';

// Cache for probability changes per game (avoids DB lookup during hot path)
interface CachedProbabilityChange {
  homePercentChange: number;
  awayPercentChange: number;
  timestamp: number;
}

// Long TTL for cached probability changes (5 minutes) since historical data doesn't change rapidly
const PROB_CHANGE_CACHE_TTL = 5 * 60 * 1000;

// Map asset_id -> game/market info for quick lookup
interface AssetGameMapping {
  gameId: string;
  marketId: string;
  outcomeIndex: number;
  outcomeLabel: string;
}

export class ClobPriceUpdateService {
  private assetToGameMap: Map<string, AssetGameMapping> = new Map();
  private isSubscribed: boolean = false;
  private unregisterOnGamesRefreshed: (() => void) | null = null;
  private unregisterOnRefreshStarting: (() => void) | null = null;
  private unregisterOnRefreshEnded: (() => void) | null = null;
  private flushPaused: boolean = false;

  // Write queue for batching database updates (live_games + frontend_games in same transaction)
  private pendingWrites: Map<string, { markets: any[]; timestamp: Date; frontendGame?: FrontendGame }> = new Map();
  private writeFlushTimer: NodeJS.Timeout | null = null;
  private writeFlushInterval: number = 1000; // Flush every 1s; real-time updates go via WebSocket
  private isFlushingWrites: boolean = false;
  private readonly MAX_PENDING_WRITES = 500; // Prevent unbounded memory growth on flush failures

  // Cache for probability changes per game (avoids DB lookup during hot path broadcasts)
  private probabilityChangeCache: Map<string, CachedProbabilityChange> = new Map();
  private probabilityCacheCleanupTimer: NodeJS.Timeout | null = null;
  private readonly PROB_CACHE_CLEANUP_INTERVAL = 10 * 60 * 1000; // Clean every 10 minutes
  private readonly MAX_PROB_CACHE_SIZE = 500; // Max entries before forced cleanup (reduced for memory efficiency)

  // Local games cache - avoids getAllLiveGames in hot path. Filled on first use / subscribeToAllGames.
  // Updated with merged results after each price update so next event reuses fresh data.
  private gamesByIdCache: Map<string, LiveGame> = new Map();

  // Throttle: track last processed time per game to avoid processing too many updates
  private lastProcessedTime: Map<string, number> = new Map();
  private readonly THROTTLE_INTERVAL_MS = 250; // Only process one update per game every 250ms (4 updates/sec max per game)

  /**
   * Initialize the service and start subscribing to price updates
   */
  async initialize(): Promise<void> {
    logger.info({ message: 'Initializing CLOB price update service' });

    // Connect to CLOB WebSocket if not connected
    const initialStatus = clobWebSocketService.getStatus();
    logger.info({
      message: 'CLOB WebSocket initial status',
      isConnected: initialStatus.isConnected,
      isConnecting: initialStatus.isConnecting,
    });

    if (!initialStatus.isConnected && !initialStatus.isConnecting) {
      await clobWebSocketService.connect();
      // Wait a bit for connection to establish
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const statusAfterConnect = clobWebSocketService.getStatus();
    logger.info({
      message: 'CLOB WebSocket status after connect',
      isConnected: statusAfterConnect.isConnected,
      isConnecting: statusAfterConnect.isConnecting,
    });

    // Set up price change handler
    this.setupPriceChangeHandler();

    // IMPORTANT: Register callbacks FIRST before waiting for games
    // This ensures we catch notifyGamesRefreshed() even if it fires during the wait
    this.unregisterOnGamesRefreshed = registerOnGamesRefreshed(() => {
      logger.info({ message: 'Games refreshed - re-subscribing to CLOB assets' });
      this.subscribeToAllGames().catch((error) => {
        logger.error({
          message: 'Error re-subscribing after games refresh',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    // Pause flush during refresh to avoid deadlock with storeGames
    this.unregisterOnRefreshStarting = registerOnRefreshStarting(() => {
      this.flushPaused = true;
      if (this.writeFlushTimer) {
        clearTimeout(this.writeFlushTimer);
        this.writeFlushTimer = null;
      }
    });
    this.unregisterOnRefreshEnded = registerOnRefreshEnded(() => {
      this.flushPaused = false;
      if (this.pendingWrites.size > 0 && !this.writeFlushTimer && !this.isFlushingWrites) {
        this.writeFlushTimer = setTimeout(() => {
          this.flushPendingWrites();
        }, this.writeFlushInterval);
      }
    });

    // Wait for games to be loaded from database/API before initial subscription
    // The live games service starts with a 2-second delay, sports games also loads
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Subscribe once on init (getAllLiveGames fills cache, subscribes to CLOB assets)
    await this.subscribeToAllGames();

    // Start periodic cache cleanup to prevent memory leaks
    this.startCacheCleanup();

    logger.info({ message: 'CLOB price update service initialized' });
  }

  /**
   * Start periodic cache cleanup to prevent memory leaks
   */
  private startCacheCleanup(): void {
    if (this.probabilityCacheCleanupTimer) {
      clearInterval(this.probabilityCacheCleanupTimer);
    }

    this.probabilityCacheCleanupTimer = setInterval(() => {
      this.cleanupExpiredCacheEntries();
    }, this.PROB_CACHE_CLEANUP_INTERVAL);

    logger.info({ message: 'CLOB cache cleanup timer started', intervalMs: this.PROB_CACHE_CLEANUP_INTERVAL });
  }

  /**
   * Clean up expired entries from probability change cache and games cache
   */
  private cleanupExpiredCacheEntries(): void {
    const now = Date.now();
    let probCacheRemoved = 0;
    let gamesCacheRemoved = 0;

    // Remove expired probability cache entries
    for (const [gameId, cached] of this.probabilityChangeCache) {
      if (now - cached.timestamp > PROB_CHANGE_CACHE_TTL) {
        this.probabilityChangeCache.delete(gameId);
        probCacheRemoved++;
      }
    }

    // If probability cache is still too large, remove oldest entries
    if (this.probabilityChangeCache.size > this.MAX_PROB_CACHE_SIZE) {
      const entries = Array.from(this.probabilityChangeCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);

      const toRemove = entries.slice(0, entries.length - this.MAX_PROB_CACHE_SIZE);
      for (const [gameId] of toRemove) {
        this.probabilityChangeCache.delete(gameId);
        probCacheRemoved++;
      }
    }

    // Clean up games cache - remove ended games older than 6 hours
    const sixHoursAgo = now - 6 * 60 * 60 * 1000;
    for (const [gameId, game] of this.gamesByIdCache) {
      // Remove if game ended and end date is more than 6 hours ago
      if (game.ended === true) {
        const endDateStr = game.endDate || (game.rawData as any)?.endDate;
        if (endDateStr) {
          const endDate = new Date(endDateStr).getTime();
          if (!isNaN(endDate) && endDate < sixHoursAgo) {
            this.gamesByIdCache.delete(gameId);
            this.assetToGameMap.forEach((mapping, assetId) => {
              if (mapping.gameId === gameId) {
                this.assetToGameMap.delete(assetId);
              }
            });
            gamesCacheRemoved++;
          }
        }
      }
    }

    // Cap games cache size to prevent unbounded growth
    const MAX_GAMES_CACHE_SIZE = 2000;
    if (this.gamesByIdCache.size > MAX_GAMES_CACHE_SIZE) {
      // Remove oldest games (by updatedAt)
      const gamesWithDates = Array.from(this.gamesByIdCache.entries())
        .map(([id, game]) => ({
          id,
          updatedAt: game.updatedAt?.getTime() || 0,
        }))
        .sort((a, b) => a.updatedAt - b.updatedAt);

      const toRemove = gamesWithDates.slice(0, gamesWithDates.length - MAX_GAMES_CACHE_SIZE);
      for (const { id } of toRemove) {
        this.gamesByIdCache.delete(id);
        gamesCacheRemoved++;
      }
    }

    // Clean up old throttle entries (older than 1 minute)
    const oneMinuteAgo = now - 60 * 1000;
    let throttleEntriesRemoved = 0;
    for (const [gameId, timestamp] of this.lastProcessedTime) {
      if (timestamp < oneMinuteAgo) {
        this.lastProcessedTime.delete(gameId);
        throttleEntriesRemoved++;
      }
    }

    if (probCacheRemoved > 0 || gamesCacheRemoved > 0) {
      logger.info({
        message: 'CLOB cache cleanup completed',
        probCacheRemoved,
        gamesCacheRemoved,
        probCacheSize: this.probabilityChangeCache.size,
        gamesCacheSize: this.gamesByIdCache.size,
        assetMapSize: this.assetToGameMap.size,
      });
    }
  }

  // Counter for logging price updates periodically
  private priceUpdateCount: number = 0;
  private lastPriceLogTime: number = 0;

  /**
   * Set up handler for price change events
   */
  private setupPriceChangeHandler(): void {
    // Register callback for price change updates
    clobWebSocketService.onOrderBookUpdate((updates: any[]) => {
      // Process each update
      for (const update of updates) {
        // Check if this is a price_change event
        if (update.event_type === 'price_change' && update.price_changes) {
          this.priceUpdateCount++;
          // Log every 100 updates or every 30 seconds
          // const now = Date.now();
          // if (this.priceUpdateCount % 100 === 0 || now - this.lastPriceLogTime > 30000) {
          //   logger.info({
          //     message: 'CLOB price updates received',
          //     totalUpdates: this.priceUpdateCount,
          //     currentBatchChanges: update.price_changes?.length || 0,
          //   });
          //   this.lastPriceLogTime = now;
          // }

          this.handlePriceChangeEvent(update as ClobPriceChangeUpdate).catch((error) => {
            logger.error({
              message: 'Error processing price change event',
              market: update.market,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    });

    logger.info({ message: 'CLOB price change handler registered' });
  }

  /**
   * Refresh local games cache from DB. Call only when cache is empty or we have a cache miss.
   */
  private async refreshGamesCache(): Promise<void> {
    const games = await getAllLiveGames();
    this.gamesByIdCache.clear();
    for (const g of games) {
      this.gamesByIdCache.set(g.id, g);
    }
  }

  /**
   * Get gamesById from cache, refreshing from DB only when cache is empty.
   */
  private async getGamesByIdForEvent(): Promise<Map<string, LiveGame>> {
    if (this.gamesByIdCache.size === 0) {
      try {
        await this.refreshGamesCache();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({
          message: '[CLOB_TIMEOUT_SOURCE] refreshGamesCache',
          error: msg,
        });
        throw err;
      }
    }
    return this.gamesByIdCache;
  }

  /**
   * Handle a price_change event - update all outcomes in the market
   */
  private async handlePriceChangeEvent(event: ClobPriceChangeUpdate): Promise<void> {
    const gamesToUpdate = new Map<string, { game: LiveGame; updates: Map<string, { outcomeIndex: number; probability: number; buyPrice: number; sellPrice: number }> }>();

    // Use local cache - no DB call when cache is warm
    const gamesById = await this.getGamesByIdForEvent();

    // Check for cache misses (e.g. new game added since last refresh) - refresh if any
    const neededGameIds = new Set<string>();
    for (const priceChange of event.price_changes) {
      const mapping = this.assetToGameMap.get(priceChange.asset_id);
      if (mapping) neededGameIds.add(mapping.gameId);
    }
    const missed = [...neededGameIds].filter((id) => !gamesById.has(id));
    if (missed.length > 0) {
      try {
        await this.refreshGamesCache();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({
          message: '[CLOB_TIMEOUT_SOURCE] refreshGamesCache (cache miss)',
          missedCount: missed.length,
          error: msg,
        });
        throw err;
      }
    }

    // Process each price change in the event
    for (const priceChange of event.price_changes) {
      const mapping = this.assetToGameMap.get(priceChange.asset_id);
      if (!mapping) {
        continue; // Asset not in our subscription list
      }

      // Use best_bid for probability (what buyers are willing to pay = market's view of probability)
      // Use best_ask for buyPrice (what you'd pay to buy this outcome now)
      // Note: "price" is just the last trade price and can be anywhere in the order book
      const bestAsk = parseFloat(priceChange.best_ask);
      const bestBid = parseFloat(priceChange.best_bid);
      
      // For probability, use mid-price if both exist, otherwise use best_bid
      // Don't round here - let frontend-game.transformer handle ceil/floor logic
      let probability: number;
      if (bestBid > 0 && bestAsk > 0 && bestAsk < 1) {
        // Use mid-price for probability (no rounding - transformer will handle it)
        probability = ((bestBid + bestAsk) / 2) * 100;
      } else if (bestBid > 0) {
        probability = bestBid * 100;
      } else {
        probability = bestAsk * 100;
      }
      
      // Keep decimal precision for prices (e.g., 0.995 → 99.5, not rounded to 100)
      // This gives users more accurate price information
      const buyPrice = Math.round(bestAsk * 1000) / 10;  // best_ask * 100 with 1 decimal place
      const sellPrice = Math.round(bestBid * 1000) / 10; // best_bid * 100 with 1 decimal place

      // logger.info({
      //   message: 'Processing price change',
      //   assetId: priceChange.asset_id.substring(0, 20) + '...',
      //   gameId: mapping.gameId,
      //   outcome: mapping.outcomeLabel,
      //   bestBid,
      //   bestAsk,
      //   probability,
      //   buyPrice,
      // });

      // Broadcast to positions WebSocket for users holding this asset
      positionsWebSocketService.onPriceUpdate(priceChange.asset_id, {
        price: probability,
        buyPrice,
        sellPrice,
      });

      // Group updates by game
      if (!gamesToUpdate.has(mapping.gameId)) {
        const game = gamesById.get(mapping.gameId);
        if (!game) {
          this.assetToGameMap.delete(priceChange.asset_id);
          continue;
        }
        gamesToUpdate.set(mapping.gameId, { game, updates: new Map() });
      }

      gamesToUpdate.get(mapping.gameId)!.updates.set(priceChange.asset_id, {
        outcomeIndex: mapping.outcomeIndex,
        probability,
        buyPrice,
        sellPrice,
      });
    }

    // Apply updates to each game (with throttling to prevent memory explosion)
    const now = Date.now();
    for (const [gameId, { game, updates }] of gamesToUpdate) {
      // Throttle: skip if we processed this game recently
      const lastProcessed = this.lastProcessedTime.get(gameId) || 0;
      if (now - lastProcessed < this.THROTTLE_INTERVAL_MS) {
        continue; // Skip this game, we just processed it
      }
      this.lastProcessedTime.set(gameId, now);

      try {
        // Get markets from game.markets or rawData.markets (for sports games like tennis)
        const sourceMarkets = game.markets && game.markets.length > 0
          ? game.markets
          : ((game.rawData as any)?.markets?.length > 0 ? (game.rawData as any).markets : []);

        if (sourceMarkets.length === 0) {
          continue;
        }

        // Update all affected markets
        const updatedMarkets = sourceMarkets.map((market: any) => {
          // Get or build structuredOutcomes (for rawData.markets, parse from JSON strings)
          let structuredOutcomes = market.structuredOutcomes;
          let outcomePrices = market.outcomePrices;

          if (!structuredOutcomes || structuredOutcomes.length === 0) {
            // Parse clobTokenIds and outcomes from JSON strings if needed
            let clobTokenIds: string[] = [];
            let outcomeLabels: string[] = [];

            if (market.clobTokenIds) {
              if (typeof market.clobTokenIds === 'string') {
                try { clobTokenIds = JSON.parse(market.clobTokenIds); } catch {}
              } else if (Array.isArray(market.clobTokenIds)) {
                clobTokenIds = market.clobTokenIds;
              }
            }

            if (market.outcomes) {
              if (typeof market.outcomes === 'string') {
                try { outcomeLabels = JSON.parse(market.outcomes); } catch {}
              } else if (Array.isArray(market.outcomes)) {
                outcomeLabels = market.outcomes;
              }
            }

            // Parse outcomePrices from JSON string if needed
            if (market.outcomePrices) {
              if (typeof market.outcomePrices === 'string') {
                try { outcomePrices = JSON.parse(market.outcomePrices); } catch {}
              } else if (Array.isArray(market.outcomePrices)) {
                outcomePrices = market.outcomePrices;
              }
            }

            if (clobTokenIds.length > 0) {
              structuredOutcomes = clobTokenIds.map((tokenId: string, idx: number) => ({
                clobTokenId: tokenId,
                label: outcomeLabels[idx] || 'Unknown',
                price: outcomePrices?.[idx] ? String(parseFloat(outcomePrices[idx]) * 100) : '50',
              }));
            }
          }

          if (!structuredOutcomes || structuredOutcomes.length === 0) return market;

          let hasChanges = false;
          const updatedOutcomes = structuredOutcomes.map((outcome: any, index: number) => {
            if (!outcome.clobTokenId) return outcome;

            const update = updates.get(outcome.clobTokenId);
            if (update && update.outcomeIndex === index) {
              hasChanges = true;
              return {
                ...outcome,
                // price field stores the probability (from trade price)
                price: update.probability.toFixed(1),
                probability: update.probability,
                // buyPrice is from best_ask (what you pay to BUY)
                buyPrice: update.buyPrice,
                // sellPrice is from best_bid (what you get when you SELL)
                sellPrice: update.sellPrice,
              };
            }
            return outcome;
          });

          if (hasChanges) {
            // Also update outcomePrices array (raw data) since frontend transformer uses this
            let updatedOutcomePrices = Array.isArray(outcomePrices) ? [...outcomePrices] : [];
            if (updatedOutcomePrices.length > 0) {
              for (const [assetId, update] of updates) {
                // Find which index this asset corresponds to
                const outcomeIdx = structuredOutcomes.findIndex((o: any) => o.clobTokenId === assetId);
                if (outcomeIdx >= 0 && outcomeIdx < updatedOutcomePrices.length) {
                  // Convert probability back to decimal (e.g., 57 -> "0.57")
                  updatedOutcomePrices[outcomeIdx] = (update.probability / 100).toFixed(2);
                }
              }
            }

            // Get prices from first update for market-level data
            const firstUpdate = Array.from(updates.values())[0];

            return {
              ...market,
              structuredOutcomes: updatedOutcomes,
              outcomePrices: updatedOutcomePrices,
              bestBid: firstUpdate?.sellPrice ?? market.bestBid,
              bestAsk: firstUpdate?.buyPrice ?? market.bestAsk,
            };
          }
          return market;
        });

        // Update both caches so next event reuses fresh data (no DB call)
        // Also update rawData.markets for sports games so frontend transformer can find updated prices
        const updatedRawData = game.rawData
          ? { ...(game.rawData as any), markets: updatedMarkets }
          : undefined;
        const updatedGame = {
          ...game,
          markets: updatedMarkets,
          rawData: updatedRawData,
          updatedAt: new Date(),
        };
        updateGameInCache(gameId, updatedGame).catch(() => {});
        this.gamesByIdCache.set(gameId, updatedGame);

        // Get cached probability change or use defaults (skip DB lookup)
        const cachedProbChange = this.getCachedProbabilityChange(gameId);
        
        // Fetch Kalshi prices to preserve them during CLOB price updates
        let kalshiData: KalshiPriceData | undefined;
        try {
          const kalshiPricesMap = await kalshiService.getKalshiPricesForGames([gameId]);
          kalshiData = kalshiPricesMap.get(gameId);
        } catch (err) {
          // Continue without Kalshi data if fetch fails (non-blocking)
          logger.debug({
            message: 'Failed to fetch Kalshi prices during CLOB update',
            gameId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        
        // Pre-transform ONCE for both broadcasts (avoid double transformation)
        // Pass cached historical change to skip DB lookup in transformer
        let frontendGame: FrontendGame;
        let activityWatcherGame: ActivityWatcherGame;
        try {
          frontendGame = await transformToFrontendGame(updatedGame, cachedProbChange, kalshiData);
          activityWatcherGame = await transformToActivityWatcherGame(updatedGame);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('timeout') || msg.includes('connect')) {
            logger.warn({ message: '[CLOB_TIMEOUT_SOURCE] transformToFrontendGame/transformToActivityWatcherGame', gameId, error: msg });
          }
          throw err;
        }

        // Broadcast via Redis to ALL workers (background worker -> HTTP workers)
        if (isRedisGamesBroadcastReady()) {
          // Publish to games channel (for /ws/games clients)
          publishGamesBroadcast({
            type: 'price_update',
            payload: JSON.stringify({
              type: 'price_update',
              game: frontendGame,
              timestamp: new Date().toISOString(),
            }),
          });

          // Publish to activity channel (for /ws/activity clients)
          const slugs = [updatedGame.slug, updatedGame.id].filter(Boolean) as string[];
          publishActivityBroadcast(slugs, {
            type: 'price_update',
            game: activityWatcherGame,
            timestamp: new Date().toISOString(),
          });
        }

        // Queue both live_games and frontend_games writes (batched in same transaction)
        this.queueDatabaseWrite(gameId, updatedMarkets, frontendGame);

        logger.debug({
          message: 'CLOB price update broadcast via Redis',
          gameId,
          updatesApplied: updates.size,
        });
      } catch (error) {
        logger.error({
          message: 'Error updating game prices',
          gameId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Get cached probability change for a game, or return defaults
   * This avoids DB lookups during the hot price update path
   */
  private getCachedProbabilityChange(gameId: string): { homePercentChange: number; awayPercentChange: number } | undefined {
    const cached = this.probabilityChangeCache.get(gameId);
    if (cached && (Date.now() - cached.timestamp) < PROB_CHANGE_CACHE_TTL) {
      return {
        homePercentChange: cached.homePercentChange,
        awayPercentChange: cached.awayPercentChange,
      };
    }
    // Return undefined to use default (0) in transformer - will be updated async
    return undefined;
  }

  /**
   * Update the probability change cache for a game
   * Called by background processes that can afford DB lookups
   */
  updateProbabilityChangeCache(gameId: string, homePercentChange: number, awayPercentChange: number): void {
    this.probabilityChangeCache.set(gameId, {
      homePercentChange,
      awayPercentChange,
      timestamp: Date.now(),
    });
  }

  /**
   * Queue a database write for batching (live_games + frontend_games in same transaction)
   * This reduces connection pressure by batching multiple updates
   */
  private queueDatabaseWrite(gameId: string, markets: any[], frontendGame?: FrontendGame): void {
    // Prevent unbounded memory growth - drop oldest writes if queue is full
    if (this.pendingWrites.size >= this.MAX_PENDING_WRITES && !this.pendingWrites.has(gameId)) {
      // Drop oldest entry (first in Map iteration order)
      const oldestKey = this.pendingWrites.keys().next().value;
      if (oldestKey) {
        this.pendingWrites.delete(oldestKey);
      }
    }
    this.pendingWrites.set(gameId, { markets, timestamp: new Date(), frontendGame });
    
    // Start flush timer if not already running and not paused during refresh
    if (!this.writeFlushTimer && !this.flushPaused) {
      this.writeFlushTimer = setTimeout(() => {
        this.flushPendingWrites();
      }, this.writeFlushInterval);
    }
  }

  /**
   * Flush all pending database writes in a single connection
   */
  private async flushPendingWrites(): Promise<void> {
    this.writeFlushTimer = null;

    if (this.pendingWrites.size === 0 || this.isFlushingWrites || this.flushPaused) {
      return;
    }

    this.isFlushingWrites = true;
    const writesToFlush = new Map(this.pendingWrites);
    this.pendingWrites.clear();

    await acquireLiveGamesWriteLock();
    let client;
    try {
      client = await connectWithRetry(5, 50);

      await client.query('BEGIN');

      const frontendGamesToUpsert: FrontendGame[] = [];

      for (const [gameId, { markets, timestamp, frontendGame }] of writesToFlush) {
        try {
          await client.query(
            `UPDATE live_games 
             SET transformed_data = jsonb_set(
               jsonb_set(
                 COALESCE(transformed_data, '{}'::jsonb),
                 '{markets}',
                 $1::jsonb
               ),
               '{updatedAt}',
               to_jsonb($2::text)
             ),
             updated_at = NOW()
             WHERE id = $3`,
            [JSON.stringify(markets), timestamp.toISOString(), gameId]
          );
          if (frontendGame && process.env.NODE_ENV === 'production') {
            frontendGamesToUpsert.push(frontendGame);
          }
        } catch (error) {
          logger.error({
            message: 'Error updating game in batch',
            gameId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (frontendGamesToUpsert.length > 0) {
        await bulkUpsertFrontendGamesWithClient(client, frontendGamesToUpsert);
        clearFrontendGamesCache();
      }

      await client.query('COMMIT');

      logger.debug({
        message: 'Flushed pending database writes',
        count: writesToFlush.size,
      });
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {}
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({
        message: msg.includes('timeout') || msg.includes('connect')
          ? '[CLOB_TIMEOUT_SOURCE] flushPendingWrites'
          : 'Error flushing pending writes',
        error: msg,
        pendingCount: writesToFlush.size,
      });

      // Re-add failed writes, but respect the cap to prevent memory leaks
      for (const [gameId, data] of writesToFlush) {
        if (this.pendingWrites.size >= this.MAX_PENDING_WRITES) {
          logger.warn({
            message: 'Dropping failed writes due to queue overflow',
            droppedCount: writesToFlush.size - this.pendingWrites.size,
            maxSize: this.MAX_PENDING_WRITES,
          });
          break;
        }
        if (!this.pendingWrites.has(gameId)) {
          this.pendingWrites.set(gameId, data);
        }
      }

      const retryDelay = Math.min(this.writeFlushInterval * 2, 3000);
      if (this.pendingWrites.size > 0 && !this.writeFlushTimer && !this.flushPaused) {
        this.writeFlushTimer = setTimeout(() => {
          this.flushPendingWrites();
        }, retryDelay);
      }
    } finally {
      if (client) {
        client.release();
      }
      this.isFlushingWrites = false;

      if (this.pendingWrites.size > 0 && !this.writeFlushTimer && !this.flushPaused) {
        this.writeFlushTimer = setTimeout(() => {
          this.flushPendingWrites();
        }, this.writeFlushInterval);
      }
    }
  }

  /**
   * Check if a game is eligible for CLOB subscription
   * Only subscribe to games that are live or starting within the next 48 hours
   */
  private isGameEligibleForSubscription(game: LiveGame): boolean {
    // Skip ended games
    if (game.ended === true) return false;

    // Always include live games
    if (game.live === true) return true;

    // Check start date - only include games starting within 48 hours
    const now = Date.now();
    const fortyEightHours = 48 * 60 * 60 * 1000;

    // Check rawData for dates if not on game object
    const startDateStr = game.startDate || (game.rawData as any)?.startDate;
    if (startDateStr) {
      const startDate = new Date(startDateStr).getTime();
      if (!isNaN(startDate)) {
        // Include if starting within 48 hours (past or future)
        if (Math.abs(startDate - now) < fortyEightHours) {
          return true;
        }
        // Exclude if starting more than 48 hours in the future
        if (startDate > now + fortyEightHours) {
          return false;
        }
      }
    }

    // Check end date - exclude if ended more than 5 hours ago
    const endDateStr = game.endDate || (game.rawData as any)?.endDate;
    if (endDateStr) {
      const endDate = new Date(endDateStr).getTime();
      if (!isNaN(endDate)) {
        const fiveHours = 5 * 60 * 60 * 1000;
        if (endDate + fiveHours < now) {
          return false; // Game ended more than 5 hours ago
        }
      }
    }

    // Default: include if we can't determine
    return true;
  }

  /**
   * Subscribe to active games with MONEYLINE markets only
   * Filters aggressively to prevent memory issues from too many subscriptions
   */
  async subscribeToAllGames(): Promise<void> {
    try {
      const allGames = await getAllLiveGames();
      const assetIds: string[] = [];
      const newAssetMap = new Map<string, AssetGameMapping>();

      // Pre-warm local games cache (all games for lookup during price updates)
      this.gamesByIdCache.clear();
      for (const g of allGames) {
        this.gamesByIdCache.set(g.id, g);
      }

      // Filter games for subscription eligibility
      const eligibleGames = allGames.filter(g => this.isGameEligibleForSubscription(g));

      logger.info({
        message: 'Filtering games for CLOB subscription',
        totalGames: allGames.length,
        eligibleGames: eligibleGames.length,
      });

      // Extract ALL asset IDs from ALL markets for eligible games
      for (const game of eligibleGames) {
        const markets = game.markets && game.markets.length > 0
          ? game.markets
          : ((game.rawData as any)?.markets?.length > 0 ? (game.rawData as any).markets : []);

        if (markets.length === 0) continue;

        for (const market of markets) {
          let structuredOutcomes = market.structuredOutcomes;

          if (!structuredOutcomes || structuredOutcomes.length === 0) {
            let clobTokenIds: string[] = [];
            let outcomeLabels: string[] = [];

            if (market.clobTokenIds) {
              if (typeof market.clobTokenIds === 'string') {
                try { clobTokenIds = JSON.parse(market.clobTokenIds); } catch {}
              } else if (Array.isArray(market.clobTokenIds)) {
                clobTokenIds = market.clobTokenIds;
              }
            }

            if (market.outcomes) {
              if (typeof market.outcomes === 'string') {
                try { outcomeLabels = JSON.parse(market.outcomes); } catch {}
              } else if (Array.isArray(market.outcomes)) {
                outcomeLabels = market.outcomes;
              }
            }

            if (clobTokenIds.length > 0) {
              structuredOutcomes = clobTokenIds.map((tokenId: string, idx: number) => ({
                clobTokenId: tokenId,
                label: outcomeLabels[idx] || 'Unknown',
              }));
            }
          }

          if (!structuredOutcomes || structuredOutcomes.length === 0) continue;

          // Subscribe to ALL outcomes for this market
          for (let i = 0; i < structuredOutcomes.length; i++) {
            const outcome = structuredOutcomes[i];
            if (outcome.clobTokenId) {
              assetIds.push(outcome.clobTokenId);
              newAssetMap.set(outcome.clobTokenId, {
                gameId: game.id,
                marketId: market.id,
                outcomeIndex: i,
                outcomeLabel: outcome.label || 'Unknown',
              });
            }
          }
        }
      }

      // Update asset map
      this.assetToGameMap = newAssetMap;

      if (assetIds.length === 0) {
        logger.warn({ message: 'No asset IDs found to subscribe to' });
        return;
      }

      // Subscribe to filtered assets
      clobWebSocketService.subscribeToAssets(assetIds);

      this.isSubscribed = true;
      logger.info({
        message: 'Subscribed to CLOB price updates (filtered by eligibility)',
        totalGames: allGames.length,
        eligibleGames: eligibleGames.length,
        totalAssets: assetIds.length,
      });
    } catch (error) {
      logger.error({
        message: 'Error subscribing to games',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get service status
   */
  getStatus(): {
    isSubscribed: boolean;
    assetCount: number;
    clobStatus: ReturnType<typeof clobWebSocketService.getStatus>;
  } {
    return {
      isSubscribed: this.isSubscribed,
      assetCount: this.assetToGameMap.size,
      clobStatus: clobWebSocketService.getStatus(),
    };
  }

  /**
   * Shutdown service
   */
  shutdown(): void {
    if (this.unregisterOnGamesRefreshed) {
      this.unregisterOnGamesRefreshed();
      this.unregisterOnGamesRefreshed = null;
    }
    if (this.unregisterOnRefreshStarting) {
      this.unregisterOnRefreshStarting();
      this.unregisterOnRefreshStarting = null;
    }
    if (this.unregisterOnRefreshEnded) {
      this.unregisterOnRefreshEnded();
      this.unregisterOnRefreshEnded = null;
    }
    if (this.probabilityCacheCleanupTimer) {
      clearInterval(this.probabilityCacheCleanupTimer);
      this.probabilityCacheCleanupTimer = null;
    }
    this.assetToGameMap.clear();
    this.probabilityChangeCache.clear();
    this.gamesByIdCache.clear();
    this.pendingWrites.clear();
    this.isSubscribed = false;
    logger.info({ message: 'CLOB price update service shut down' });
  }
}

// Export singleton instance
export const clobPriceUpdateService = new ClobPriceUpdateService();
