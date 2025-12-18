/**
 * CLOB Price Update Service
 * Manages CLOB WebSocket subscriptions and updates prices/probabilities for all live games
 */

import { logger } from '../../config/logger';
import { clobWebSocketService } from './clob-websocket.service';
import { ClobOrderBookUpdate } from './polymarket.types';
import { getAllLiveGames, updateGame, LiveGame } from './live-games.service';
import { gamesWebSocketService } from './games-websocket.service';

// Map asset_id -> game info for quick lookup
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
  private updateThrottle: Map<string, number> = new Map(); // Throttle updates per game
  private readonly THROTTLE_MS = 1000; // Max 1 update per second per game

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

    // Set up order book update handler
    this.setupOrderBookHandler();

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
   * Set up handler for order book updates
   */
  private setupOrderBookHandler(): void {
    // Register callback for real-time order book updates
    clobWebSocketService.onOrderBookUpdate((updates: ClobOrderBookUpdate[]) => {
      logger.info({
        message: 'Order book update callback triggered',
        updateCount: updates.length,
      });
      
      // Process updates asynchronously
      updates.forEach(update => {
        this.handleOrderBookUpdate(update).catch((error) => {
          logger.error({
            message: 'Error processing order book update',
            assetId: update.asset_id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
    });
    
    logger.info({ message: 'Order book update handler registered' });
  }

  /**
   * Handle a single order book update
   */
  private async handleOrderBookUpdate(update: ClobOrderBookUpdate): Promise<void> {
    const mapping = this.assetToGameMap.get(update.asset_id);
    if (!mapping) {
      // Asset not in our subscription list, skip (this is normal for some assets)
      return;
    }

      logger.info({
        message: 'Processing order book update for game',
        assetId: update.asset_id,
        gameId: mapping.gameId,
        outcome: mapping.outcomeLabel,
      });

    // Throttle updates per game
    const now = Date.now();
    const lastUpdate = this.updateThrottle.get(mapping.gameId) || 0;
    if (now - lastUpdate < this.THROTTLE_MS) {
      return; // Skip if too soon
    }

    try {
      // Calculate current price from best ask (buy price = current probability)
      const bestAsk = update.asks.length > 0 ? parseFloat(update.asks[0].price) : null;
      const bestBid = update.bids.length > 0 ? parseFloat(update.bids[0].price) : null;
      const lastTradePrice = update.last_trade_price ? parseFloat(update.last_trade_price) : null;

      if (bestAsk === null && bestBid === null && lastTradePrice === null) {
        return; // No price data available
      }

      // Use best ask as current buy price (probability)
      // If no ask, use best bid
      // If neither, use last trade price
      const currentPrice = bestAsk ?? bestBid ?? lastTradePrice ?? 0.5;
      const probability = Math.max(0, Math.min(100, Math.round(currentPrice * 100 * 10) / 10)); // Round to 1 decimal

      // Get the game
      const games = await getAllLiveGames();
      const game = games.find(g => g.id === mapping.gameId);
      
      if (!game) {
        // Game no longer exists, remove from map
        this.assetToGameMap.delete(update.asset_id);
        return;
      }

      // Update the market outcome price
      // Safety check: Only update moneyline markets (team vs team)
      const updatedMarkets = game.markets.map(market => {
        if (market.id !== mapping.marketId) {
          return market;
        }

        // Double-check this is a moneyline market (not Over/Under)
        if (market.structuredOutcomes) {
          const labels = market.structuredOutcomes.map(o => o.label?.toLowerCase() || '');
          if (labels.some(l => l.includes('over') || l.includes('under') || l.includes('o/u') ||
                              l.includes('points') || l.includes('rebounds') || l.includes('assists'))) {
            logger.warn({
              message: 'Skipping non-moneyline market update',
              marketId: market.id,
              gameId: mapping.gameId,
              labels,
            });
            return market; // Don't update non-moneyline markets
          }
        }

        const updatedOutcomes = market.structuredOutcomes?.map((outcome, index) => {
          if (index === mapping.outcomeIndex) {
            return {
              ...outcome,
              price: probability.toFixed(1),
              probability: probability,
            };
          }
          return outcome;
        });

        return {
          ...market,
          structuredOutcomes: updatedOutcomes,
          bestBid: bestBid ? bestBid * 100 : market.bestBid,
          bestAsk: bestAsk ? bestAsk * 100 : market.bestAsk,
          lastTradePrice: lastTradePrice ? lastTradePrice * 100 : market.lastTradePrice,
          spread: bestBid && bestAsk ? (bestAsk - bestBid) * 100 : market.spread,
        };
      });

      // Update game in database
      await updateGame({
        id: mapping.gameId,
        markets: updatedMarkets,
      });

      // Update throttle timestamp
      this.updateThrottle.set(mapping.gameId, now);

      // Broadcast update to WebSocket clients
      const updatedGame = { ...game, markets: updatedMarkets };
      await gamesWebSocketService.broadcastGameUpdate(updatedGame);

      logger.info({
        message: 'Updated game price from CLOB',
        gameId: mapping.gameId,
        assetId: update.asset_id,
        outcome: mapping.outcomeLabel,
        probability,
        bestBid: bestBid ? bestBid * 100 : null,
        bestAsk: bestAsk ? bestAsk * 100 : null,
      });
    } catch (error) {
      logger.error({
        message: 'Error handling order book update',
        assetId: update.asset_id,
        gameId: mapping?.gameId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Subscribe to all games in the database
   */
  async subscribeToAllGames(): Promise<void> {
    try {
      logger.info({ message: 'Subscribing to all games for price updates' });

      const games = await getAllLiveGames();
      const assetIds: string[] = [];
      const newAssetMap = new Map<string, AssetGameMapping>();

      // Extract all asset IDs from all games
      for (const game of games) {
        if (!game.markets || game.markets.length === 0) {
          continue;
        }

        // Find moneyline market (team vs team)
        for (const market of game.markets) {
          if (!market.structuredOutcomes || market.structuredOutcomes.length < 2) {
            continue;
          }

          // Skip Over/Under markets
          const labels = market.structuredOutcomes.map(o => o.label?.toLowerCase() || '');
          if (labels.some(l => l.includes('over') || l.includes('under') || l.includes('o/u'))) {
            continue;
          }

          // Extract asset IDs from outcomes
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

      // Subscribe in batches (CLOB may have limits)
      const batchSize = 100;
      for (let i = 0; i < assetIds.length; i += batchSize) {
        const batch = assetIds.slice(i, i + batchSize);
        clobWebSocketService.subscribeToAssets(batch);
        
        logger.info({
          message: 'Subscribed to asset batch',
          batch: i / batchSize + 1,
          totalBatches: Math.ceil(assetIds.length / batchSize),
          assetCount: batch.length,
        });
      }

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
    this.updateThrottle.clear();
    this.isSubscribed = false;
    logger.info({ message: 'CLOB price update service shut down' });
  }
}

// Export singleton instance
export const clobPriceUpdateService = new ClobPriceUpdateService();
