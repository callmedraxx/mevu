/**
 * CLOB Price Update Service
 * Manages CLOB WebSocket subscriptions and updates prices/probabilities for all live games
 * Uses price_change events with best_ask for probability updates
 */

import { logger } from '../../config/logger';
import { clobWebSocketService } from './clob-websocket.service';
import { ClobPriceChangeUpdate, ClobPriceChange } from './polymarket.types';
import { getAllLiveGames, updateGame, updateGameInCache, LiveGame } from './live-games.service';
import { gamesWebSocketService } from './games-websocket.service';
import { pool } from '../../config/database';

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
  private subscriptionCheckInterval: NodeJS.Timeout | null = null;

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

    // Subscribe to all games
    await this.subscribeToAllGames();

    // Set up periodic re-subscription check (every 5 minutes)
    this.subscriptionCheckInterval = setInterval(() => {
      this.subscribeToAllGames().catch((error) => {
        logger.error({
          message: 'Error in periodic subscription check',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 5 * 60 * 1000);

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
    
    logger.info({ message: 'Price change handler registered' });
  }

  /**
   * Handle a price_change event - update all outcomes in the market
   */
  private async handlePriceChangeEvent(event: ClobPriceChangeUpdate): Promise<void> {
    const gamesToUpdate = new Map<string, { game: LiveGame; updates: Map<string, { outcomeIndex: number; probability: number; buyPrice: number; sellPrice: number }> }>();

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
      // This gives the most stable representation of the market's view
      let probability: number;
      if (bestBid > 0 && bestAsk > 0 && bestAsk < 1) {
        // Use mid-price for probability
        probability = Math.round(((bestBid + bestAsk) / 2) * 100);
      } else if (bestBid > 0) {
        probability = Math.round(bestBid * 100);
      } else {
        probability = Math.round(bestAsk * 100);
      }
      
      const buyPrice = Math.round(bestAsk * 100);  // best_ask * 100 for buyPrice
      const sellPrice = Math.round(bestBid * 100); // best_bid * 100 for sellPrice

      logger.info({
        message: 'Processing price change',
        assetId: priceChange.asset_id.substring(0, 20) + '...',
        gameId: mapping.gameId,
        outcome: mapping.outcomeLabel,
        bestBid,
        bestAsk,
        probability,
        buyPrice,
      });

      // Group updates by game
      if (!gamesToUpdate.has(mapping.gameId)) {
        const games = await getAllLiveGames();
        const game = games.find(g => g.id === mapping.gameId);
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
                // buyPrice is from best_ask
                buyPrice: update.buyPrice,
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

        // Update game in database directly (bypass cache for speed)
        await this.updateGamePricesInDatabase(gameId, updatedMarkets);

        // Update cache so API calls get fresh data
        const updatedGame = { ...game, markets: updatedMarkets, updatedAt: new Date() };
        updateGameInCache(gameId, updatedGame);

        // Broadcast to frontend WebSocket immediately
        await gamesWebSocketService.broadcastPriceUpdate(updatedGame);

        logger.info({
          message: 'Game prices updated and broadcast',
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
   * Update game prices directly in database (fast path)
   * Uses atomic JSONB update to avoid race conditions with sports score updates
   */
  private async updateGamePricesInDatabase(gameId: string, markets: any[]): Promise<void> {
    const client = await pool.connect();
    try {
      // Use atomic JSONB update to set markets and updatedAt without reading first
      // This avoids race conditions with sports WebSocket score updates
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
        [JSON.stringify(markets), new Date().toISOString(), gameId]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Subscribe to ALL games and ALL their clobTokenIds
   */
  async subscribeToAllGames(): Promise<void> {
    try {
      logger.info({ message: 'Subscribing to all games for price updates' });

      const games = await getAllLiveGames();
      const assetIds: string[] = [];
      const newAssetMap = new Map<string, AssetGameMapping>();

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
      logger.info({
        message: 'Subscribed to all games for price updates',
        totalGames: games.length,
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
    if (this.subscriptionCheckInterval) {
      clearInterval(this.subscriptionCheckInterval);
      this.subscriptionCheckInterval = null;
    }
    this.assetToGameMap.clear();
    this.isSubscribed = false;
    logger.info({ message: 'CLOB price update service shut down' });
  }
}

// Export singleton instance
export const clobPriceUpdateService = new ClobPriceUpdateService();
