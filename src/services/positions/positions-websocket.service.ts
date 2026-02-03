/**
 * Positions WebSocket Service
 * Provides real-time position price updates to connected users
 * 
 * WebSocket endpoint: /ws/positions
 * 
 * Client sends on connect:
 * { "type": "subscribe", "privyUserId": "...", "assets": ["clobTokenId1", "clobTokenId2", ...] }
 * 
 * Server sends:
 * - { "type": "position_price_update", "asset": "...", "prices": { curPrice, buyPrice, sellPrice } }
 * - { "type": "positions_refresh", "positions": [...] }
 */

import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { Server as HttpServer } from 'http';
import { logger } from '../../config/logger';
import { getAllLiveGames } from '../polymarket/live-games.service';
import { fetchAndStorePositions } from './positions.service';

interface PositionSubscription {
  privyUserId: string;
  assets: Set<string>; // clobTokenIds the user has positions in
  ws: WebSocket;
}

class PositionsWebSocketService {
  private wss: WebSocketServer | null = null;
  // Map of privyUserId -> subscription
  private subscriptions = new Map<string, PositionSubscription>();
  // Map of asset (clobTokenId) -> Set of privyUserIds who have this position
  private assetToUsers = new Map<string, Set<string>>();

  /**
   * Initialize WebSocket server
   */
  initialize(server: HttpServer): void {
    this.wss = new WebSocketServer({ 
      noServer: true,
      path: '/ws/positions',
    });

    // Handle upgrade requests for /ws/positions
    server.on('upgrade', (request, socket, head) => {
      const pathname = request.url?.split('?')[0];
      
      if (pathname === '/ws/positions') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      }
      // Don't handle other paths - let other WebSocket services handle them
    });

    this.setupConnectionHandler();

    logger.info({
      message: 'Positions WebSocket service initialized',
      path: '/ws/positions',
    });
  }

  /**
   * Setup WebSocket connection handler
   */
  private setupConnectionHandler(): void {
    if (!this.wss) return;

    this.wss.on('connection', async (ws: WebSocket, request) => {
      const clientIp = request.socket.remoteAddress;
      
      // logger.info({
      //   message: 'Positions WebSocket client connected',
      //   clientIp,
      // });

      // Handle incoming messages (subscribe requests)
      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          await this.handleMessage(ws, message);
        } catch (error) {
          logger.warn({
            message: 'Invalid WebSocket message',
            error: error instanceof Error ? error.message : String(error),
          });
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
      });

      // Handle client disconnect
      ws.on('close', () => {
        this.handleDisconnect(ws);
      });

      ws.on('error', (error) => {
        logger.warn({
          message: 'Positions WebSocket client error',
          error: error.message,
        });
      });

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to positions WebSocket. Send subscribe message with privyUserId and assets.',
        timestamp: new Date().toISOString(),
      }));
    });

    this.wss.on('error', (error) => {
      logger.error({
        message: 'Positions WebSocket server error',
        error: error.message,
      });
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private async handleMessage(ws: WebSocket, message: any): Promise<void> {
    if (message.type === 'subscribe') {
      const { privyUserId, assets } = message;
      
      if (!privyUserId) {
        ws.send(JSON.stringify({ type: 'error', message: 'privyUserId is required' }));
        return;
      }

      // If no assets provided, fetch positions to get assets
      let assetList = assets || [];
      if (assetList.length === 0 && privyUserId) {
        try {
          const positions = await fetchAndStorePositions(privyUserId);
          assetList = positions.map(p => p.asset);
        } catch (error) {
          logger.warn({
            message: 'Failed to fetch positions for subscription',
            privyUserId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.subscribeUser(privyUserId, assetList, ws);

      // Send initial prices for all assets
      const initialPrices = await this.getInitialPricesForAssets(assetList);
      const pricesArray = Array.from(initialPrices.entries()).map(([asset, prices]) => ({
        asset,
        ...prices,
      }));

      ws.send(JSON.stringify({
        type: 'subscribed',
        privyUserId,
        assetCount: assetList.length,
        initialPrices: pricesArray,
        timestamp: new Date().toISOString(),
      }));

    } else if (message.type === 'update_assets') {
      const { privyUserId, assets } = message;
      if (privyUserId && assets) {
        this.updateUserAssets(privyUserId, assets);
        ws.send(JSON.stringify({
          type: 'assets_updated',
          assetCount: assets.length,
          timestamp: new Date().toISOString(),
        }));
      }

    } else if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
    }
  }

  /**
   * Handle client disconnect
   */
  private handleDisconnect(ws: WebSocket): void {
    // Find and remove the subscription for this WebSocket
    for (const [privyUserId, subscription] of this.subscriptions) {
      if (subscription.ws === ws) {
        this.unsubscribeUser(privyUserId);
        // logger.info({
        //   message: 'Positions WebSocket client disconnected',
        //   privyUserId,
        // });
        break;
      }
    }
  }

  /**
   * Subscribe a user to position updates
   */
  private subscribeUser(privyUserId: string, assets: string[], ws: WebSocket): void {
    // Clean up any existing subscription for this user
    this.unsubscribeUser(privyUserId);

    const assetSet = new Set(assets);
    
    this.subscriptions.set(privyUserId, {
      privyUserId,
      assets: assetSet,
      ws,
    });

    // Update asset -> users mapping
    for (const asset of assets) {
      if (!this.assetToUsers.has(asset)) {
        this.assetToUsers.set(asset, new Set());
      }
      this.assetToUsers.get(asset)!.add(privyUserId);
    }

    // logger.info({
    //   message: 'User subscribed to position updates',
    //   privyUserId,
    //   assetCount: assets.length,
    //   totalSubscriptions: this.subscriptions.size,
    // });
  }

  /**
   * Unsubscribe a user from position updates
   */
  private unsubscribeUser(privyUserId: string): void {
    const subscription = this.subscriptions.get(privyUserId);
    if (!subscription) return;

    // Remove from asset -> users mapping
    for (const asset of subscription.assets) {
      const users = this.assetToUsers.get(asset);
      if (users) {
        users.delete(privyUserId);
        if (users.size === 0) {
          this.assetToUsers.delete(asset);
        }
      }
    }

    this.subscriptions.delete(privyUserId);
  }

  /**
   * Update a user's subscribed assets (called after buy/sell)
   */
  updateUserAssets(privyUserId: string, newAssets: string[]): void {
    const subscription = this.subscriptions.get(privyUserId);
    if (!subscription) return;

    // Remove old asset mappings
    for (const asset of subscription.assets) {
      const users = this.assetToUsers.get(asset);
      if (users) {
        users.delete(privyUserId);
        if (users.size === 0) {
          this.assetToUsers.delete(asset);
        }
      }
    }

    // Add new asset mappings
    const assetSet = new Set(newAssets);
    subscription.assets = assetSet;

    for (const asset of newAssets) {
      if (!this.assetToUsers.has(asset)) {
        this.assetToUsers.set(asset, new Set());
      }
      this.assetToUsers.get(asset)!.add(privyUserId);
    }

    // logger.debug({
    //   message: 'Updated user position assets',
    //   privyUserId,
    //   assetCount: newAssets.length,
    // });
  }

  /**
   * Called when CLOB price update is received
   * Broadcasts to all users who have positions in the affected assets
   */
  onPriceUpdate(assetId: string, priceData: {
    price: number;      // probability/mid-price (0-100)
    buyPrice: number;   // best ask (0-100)
    sellPrice: number;  // best bid (0-100)
  }): void {
    const affectedUsers = this.assetToUsers.get(assetId);
    
    // Debug: log when we have subscribed users for this asset
    // if (this.subscriptions.size > 0) {
    //   logger.debug({
    //     message: 'Positions WebSocket price update check',
    //     assetId: assetId.substring(0, 20) + '...',
    //     hasSubscribedUsers: !!affectedUsers && affectedUsers.size > 0,
    //     totalSubscriptions: this.subscriptions.size,
    //     totalTrackedAssets: this.assetToUsers.size,
    //   });
    // }
    
    if (!affectedUsers || affectedUsers.size === 0) return;

    // logger.info({
    //   message: 'Broadcasting position price update',
    //   assetId: assetId.substring(0, 20) + '...',
    //   affectedUserCount: affectedUsers.size,
    //   priceData,
    // });

    // Build the update message
    // For position holders, curPrice = sellPrice (best_bid) = what they can actually sell for
    const update = {
      type: 'position_price_update',
      asset: assetId,
      prices: {
        curPrice: priceData.sellPrice / 100, // Use sellPrice (best_bid) for position valuation
        buyPrice: priceData.buyPrice,
        sellPrice: priceData.sellPrice,
        probability: priceData.price,
      },
      timestamp: new Date().toISOString(),
    };

    const message = JSON.stringify(update);

    // Send to all affected users
    for (const userId of affectedUsers) {
      const subscription = this.subscriptions.get(userId);
      if (subscription && subscription.ws.readyState === WebSocket.OPEN) {
        try {
          subscription.ws.send(message);
        } catch (error) {
          logger.warn({
            message: 'Failed to send position update to user',
            privyUserId: userId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /**
   * Broadcast full position refresh to a specific user
   */
  async broadcastPositionRefresh(
    privyUserId: string,
    positions: Array<{
      asset: string;
      outcome: string;
      size: string;
      curPrice: string;
      currentValue: string;
      cashPnl: string;
      percentPnl: string;
    }>
  ): Promise<void> {
    const subscription = this.subscriptions.get(privyUserId);
    if (!subscription || subscription.ws.readyState !== WebSocket.OPEN) return;

    const message = JSON.stringify({
      type: 'positions_refresh',
      positions,
      timestamp: new Date().toISOString(),
    });

    try {
      subscription.ws.send(message);
      
      // Also update the asset subscriptions
      const newAssets = positions.map(p => p.asset);
      this.updateUserAssets(privyUserId, newAssets);
      
      // logger.debug({
      //   message: 'Sent positions refresh to user',
      //   privyUserId,
      //   positionCount: positions.length,
      // });
    } catch (error) {
      logger.warn({
        message: 'Failed to send positions refresh',
        privyUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get initial price data for assets
   */
  private async getInitialPricesForAssets(
    assets: string[]
  ): Promise<Map<string, { curPrice: number; buyPrice: number; sellPrice: number }>> {
    const priceMap = new Map<string, { curPrice: number; buyPrice: number; sellPrice: number }>();

    if (assets.length === 0) return priceMap;

    try {
      const games = await getAllLiveGames();

      for (const game of games) {
        // Use game.markets, fall back to rawData.markets for sports games (tennis, etc.)
        const markets = game.markets && game.markets.length > 0
          ? game.markets
          : ((game.rawData as any)?.markets?.length > 0 ? (game.rawData as any).markets : []);

        if (markets.length === 0) continue;

        for (const market of markets) {
          const outcomes = market.structuredOutcomes;
          if (!outcomes) continue;

          for (const outcome of outcomes) {
            if (!outcome.clobTokenId || !assets.includes(outcome.clobTokenId)) continue;

            let buyPrice = 0;
            let sellPrice = 0;
            
            // Get buyPrice from best_ask
            if (outcome.buyPrice !== undefined) {
              buyPrice = typeof outcome.buyPrice === 'number' ? outcome.buyPrice : parseFloat(String(outcome.buyPrice));
            } else if (outcome.price !== undefined) {
              buyPrice = typeof outcome.price === 'string' ? parseFloat(outcome.price) : outcome.price;
            }

            // Get sellPrice from best_bid (what you actually get when selling)
            if (outcome.sellPrice !== undefined) {
              sellPrice = typeof outcome.sellPrice === 'number' ? outcome.sellPrice : parseFloat(String(outcome.sellPrice));
            } else {
              // Fallback: calculate from buyPrice (less accurate)
              sellPrice = 100 - buyPrice;
            }
            
            // curPrice = sellPrice for position holders (what they can sell for)
            const curPrice = sellPrice / 100;

            priceMap.set(outcome.clobTokenId, {
              curPrice,
              buyPrice,
              sellPrice,
            });
          }
        }
      }
    } catch (error) {
      logger.warn({
        message: 'Failed to get initial prices for assets',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return priceMap;
  }

  /**
   * Get subscription stats
   */
  getStats(): {
    totalUsers: number;
    totalAssets: number;
  } {
    return {
      totalUsers: this.subscriptions.size,
      totalAssets: this.assetToUsers.size,
    };
  }

  /**
   * Check if user is subscribed
   */
  isUserSubscribed(privyUserId: string): boolean {
    return this.subscriptions.has(privyUserId);
  }

  /**
   * Shutdown the WebSocket server
   */
  shutdown(): void {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.subscriptions.clear();
    this.assetToUsers.clear();
    logger.info({ message: 'Positions WebSocket service shut down' });
  }
}

// Export singleton instance
export const positionsWebSocketService = new PositionsWebSocketService();
