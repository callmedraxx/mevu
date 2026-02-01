/**
 * CLOB Price Update Service
 * Manages CLOB WebSocket subscriptions and updates prices/probabilities for all live games
 * Uses price_change events with best_ask for probability updates
 */

import { logger } from '../../config/logger';
import { clobWebSocketService } from './clob-websocket.service';
import { ClobPriceChangeUpdate, ClobPriceChange } from './polymarket.types';
import { getAllLiveGames, updateGameInCache, LiveGame, registerOnGamesRefreshed, registerOnRefreshStarting, registerOnRefreshEnded, acquireLiveGamesWriteLock, releaseLiveGamesWriteLock } from './live-games.service';
import { gamesWebSocketService } from './games-websocket.service';
import { activityWatcherWebSocketService } from './activity-watcher-websocket.service';
import { positionsWebSocketService } from '../positions/positions-websocket.service';
import { connectWithRetry } from '../../config/database';
import { transformToFrontendGame, FrontendGame } from './frontend-game.transformer';
import { transformToActivityWatcherGame, ActivityWatcherGame } from './activity-watcher.transformer';
import { bulkUpsertFrontendGamesWithClient, clearFrontendGamesCache } from './frontend-games.service';

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

  // Cache for probability changes per game (avoids DB lookup during hot path broadcasts)
  private probabilityChangeCache: Map<string, CachedProbabilityChange> = new Map();

  // Local games cache - avoids getAllLiveGames in hot path. Filled on first use / subscribeToAllGames.
  // Updated with merged results after each price update so next event reuses fresh data.
  private gamesByIdCache: Map<string, LiveGame> = new Map();

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

    // Wait for games to be loaded from database/API before subscribing
    // The live games service starts with a 2-second delay, so we wait 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Subscribe once on init (getAllLiveGames fills cache, subscribes to CLOB assets)
    await this.subscribeToAllGames();

    // Re-subscribe only when live games or sports games refresh (no periodic timer)
    this.unregisterOnGamesRefreshed = registerOnGamesRefreshed(() => {
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

    logger.info({ message: 'CLOB price update service initialized' });
  }

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
    
    //logger.info({ message: 'Price change handler registered' });
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
      
      const buyPrice = Math.round(bestAsk * 100);  // best_ask * 100 for buyPrice
      const sellPrice = Math.round(bestBid * 100); // best_bid * 100 for sellPrice

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

    // Apply updates to each game
    for (const [gameId, { game, updates }] of gamesToUpdate) {
      try {
        // Update all affected markets
        const updatedMarkets = game.markets.map(market => {
          if (!market.structuredOutcomes) return market;

          let hasChanges = false;
          const updatedOutcomes = market.structuredOutcomes.map((outcome, index) => {
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
            // This uses the probability for the raw outcomePrices
            let updatedOutcomePrices = market.outcomePrices;
            if (market.outcomePrices && Array.isArray(market.outcomePrices)) {
              updatedOutcomePrices = [...market.outcomePrices];
              for (const [assetId, update] of updates) {
                // Find which index this asset corresponds to
                const outcomeIdx = market.structuredOutcomes?.findIndex(o => o.clobTokenId === assetId);
                if (outcomeIdx !== undefined && outcomeIdx >= 0 && outcomeIdx < updatedOutcomePrices.length) {
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
        const updatedGame = { ...game, markets: updatedMarkets, updatedAt: new Date() };
        updateGameInCache(gameId, updatedGame);
        this.gamesByIdCache.set(gameId, updatedGame);

        // Get cached probability change or use defaults (skip DB lookup)
        const cachedProbChange = this.getCachedProbabilityChange(gameId);
        
        // Pre-transform ONCE for both broadcasts (avoid double transformation)
        // Pass cached historical change to skip DB lookup in transformer
        let frontendGame: FrontendGame;
        let activityWatcherGame: ActivityWatcherGame;
        try {
          frontendGame = await transformToFrontendGame(updatedGame, cachedProbChange);
          activityWatcherGame = await transformToActivityWatcherGame(updatedGame);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('timeout') || msg.includes('connect')) {
            logger.warn({ message: '[CLOB_TIMEOUT_SOURCE] transformToFrontendGame/transformToActivityWatcherGame', gameId, error: msg });
          }
          throw err;
        }

        // Broadcast to BOTH WebSockets in parallel using fire-and-forget (no await)
        // These are synchronous sends after transformation - ultra low latency
        gamesWebSocketService.broadcastFrontendGame(frontendGame, 'price_update');
        activityWatcherWebSocketService.broadcastActivityWatcherGame(activityWatcherGame);

        // Queue both live_games and frontend_games writes (batched in same transaction)
        this.queueDatabaseWrite(gameId, updatedMarkets, frontendGame);

        logger.debug({
          message: 'Game prices updated and broadcast (optimized path)',
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

      for (const [gameId, data] of writesToFlush) {
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
   * Subscribe to ALL games and ALL their clobTokenIds
   */
  async subscribeToAllGames(): Promise<void> {
    try {
      //logger.info({ message: 'Subscribing to all games for price updates' });

      const games = await getAllLiveGames();
      const assetIds: string[] = [];
      const newAssetMap = new Map<string, AssetGameMapping>();

      // Pre-warm local games cache so handlePriceChangeEvent avoids DB on first events
      this.gamesByIdCache.clear();
      for (const g of games) {
        this.gamesByIdCache.set(g.id, g);
      }

      // Extract ALL asset IDs from ALL markets (not just moneyline)
      for (const game of games) {
        if (!game.markets || game.markets.length === 0) {
          continue;
        }

        for (const market of game.markets) {
          if (!market.structuredOutcomes || market.structuredOutcomes.length === 0) {
            continue;
          }

          // Extract asset IDs from ALL outcomes
          for (let i = 0; i < market.structuredOutcomes.length; i++) {
            const outcome = market.structuredOutcomes[i];
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

      // Subscribe to all assets at once
      clobWebSocketService.subscribeToAssets(assetIds);
      
      this.isSubscribed = true;
      // logger.info({
      //   message: 'Subscribed to all games for price updates',
      //   totalGames: games.length,
      //   totalAssets: assetIds.length,
      // });
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
    this.assetToGameMap.clear();
    this.isSubscribed = false;
    logger.info({ message: 'CLOB price update service shut down' });
  }
}

// Export singleton instance
export const clobPriceUpdateService = new ClobPriceUpdateService();
