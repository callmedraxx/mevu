/**
 * Activity Watcher WebSocket Service
 * Real-time WebSocket for per-game activity updates - provides price/probability updates
 */

import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { Server as HttpServer } from 'http';
import { logger } from '../../config/logger';
import { LiveGame, getAllLiveGames, getLiveGameBySlug, liveGamesService } from './live-games.service';
import { transformToActivityWatcherGame, ActivityWatcherGame } from './activity-watcher.transformer';

// Message types for WebSocket communication
interface WSMessage {
  type: 'initial' | 'game_update' | 'price_update' | 'heartbeat' | 'error' | 'subscribed' | 'unsubscribed';
  game?: ActivityWatcherGame;
  slug?: string;
  timestamp?: string;
  message?: string;
  clientCount?: number;
}

interface ClientSubscription {
  ws: WebSocket;
  slug: string;
}

/**
 * Activity Watcher WebSocket Service
 * Manages WebSocket connections for per-game activity updates
 */
export class ActivityWatcherWebSocketService {
  private wss: WebSocketServer | null = null;
  private clients: Map<WebSocket, string> = new Map(); // ws -> subscribed slug
  private slugClients: Map<string, Set<WebSocket>> = new Map(); // slug -> set of ws clients
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isInitialized: boolean = false;

  private wsPath: string = '/ws/activity';
  
  /**
   * Initialize the WebSocket server
   * @param server - HTTP server instance to attach WebSocket to
   * @param path - WebSocket path (default: /ws/activity)
   */
  initialize(server: HttpServer, path: string = '/ws/activity'): void {
    if (this.isInitialized) {
      logger.warn({ message: 'Activity Watcher WebSocket already initialized' });
      return;
    }

    this.wsPath = path;

    // Create WebSocket server with noServer to handle upgrades manually
    this.wss = new WebSocketServer({ 
      noServer: true,
      perMessageDeflate: false, // Completely disable compression
      maxPayload: 100 * 1024 * 1024, // 100MB max payload
      clientTracking: true,
    });

    // Handle upgrade requests manually to strip compression extensions
    server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
      
      if (pathname === this.wsPath) {
        // Remove Sec-WebSocket-Extensions header to prevent compression negotiation
        delete request.headers['sec-websocket-extensions'];
        
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      }
      // Let other handlers deal with other paths
    });

    this.setupEventHandlers();
    this.setupBroadcastCallbacks();
    this.startHeartbeat();
    this.isInitialized = true;

    logger.info({ 
      message: 'Activity Watcher WebSocket server initialized',
      path,
    });
  }

  /**
   * Set up WebSocket event handlers
   */
  private setupEventHandlers(): void {
    if (!this.wss) return;

    this.wss.on('connection', async (ws: WebSocket, request) => {
      const clientIp = request.headers['x-forwarded-for'] || 
                       request.headers['x-real-ip'] || 
                       request.socket.remoteAddress;

      logger.info({
        message: 'Activity Watcher WebSocket client connected',
        clientIp,
      });

      // Handle incoming messages (subscription commands)
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleClientMessage(ws, message);
        } catch (error) {
          logger.debug({
            message: 'Invalid Activity Watcher WebSocket message received',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      // Handle client disconnect
      ws.on('close', (code, reason) => {
        this.unsubscribeClient(ws);
        // Only log at info level for normal closures, debug for abnormal
        const logFn = code === 1000 || code === 1001 ? logger.info : logger.debug;
        logFn.call(logger, {
          message: 'Activity Watcher WebSocket client disconnected',
          code,
          reason: reason.toString(),
        });
      });

      // Handle errors
      ws.on('error', (error) => {
        logger.error({
          message: 'Activity Watcher WebSocket client error',
          error: error.message,
        });
        this.unsubscribeClient(ws);
      });
    });

    this.wss.on('error', (error) => {
      logger.error({
        message: 'Activity Watcher WebSocket server error',
        error: error.message,
      });
    });
  }

  /**
   * Handle incoming client messages
   */
  private handleClientMessage(ws: WebSocket, message: any): void {
    switch (message.type) {
      case 'subscribe':
        if (message.slug) {
          this.subscribeClient(ws, message.slug);
        }
        break;
      case 'unsubscribe':
        this.unsubscribeClient(ws);
        break;
      case 'ping':
        this.sendToClient(ws, { type: 'heartbeat', timestamp: new Date().toISOString() });
        break;
      case 'refresh':
        // Client requests fresh data
        this.sendCurrentData(ws);
        break;
      default:
        logger.debug({
          message: 'Unknown Activity Watcher WebSocket message type',
          type: message.type,
        });
    }
  }

  /**
   * Subscribe a client to a specific game
   */
  private async subscribeClient(ws: WebSocket, slug: string): Promise<void> {
    const normalizedSlug = slug.toLowerCase();

    // Unsubscribe from previous game if any
    this.unsubscribeClient(ws);

    // Add to tracking maps
    this.clients.set(ws, normalizedSlug);
    
    if (!this.slugClients.has(normalizedSlug)) {
      this.slugClients.set(normalizedSlug, new Set());
    }
    this.slugClients.get(normalizedSlug)!.add(ws);

    // Send confirmation
    this.sendToClient(ws, {
      type: 'subscribed',
      slug: normalizedSlug,
      message: `Subscribed to game: ${normalizedSlug}`,
      timestamp: new Date().toISOString(),
    });

    // Send initial data for the game
    await this.sendInitialData(ws, normalizedSlug);

    logger.info({
      message: 'Client subscribed to game',
      slug: normalizedSlug,
      clientCount: this.slugClients.get(normalizedSlug)?.size || 0,
    });
  }

  /**
   * Unsubscribe a client from all games
   */
  private unsubscribeClient(ws: WebSocket): void {
    const slug = this.clients.get(ws);
    if (!slug) return;

    // Remove from slug tracking
    const slugSet = this.slugClients.get(slug);
    if (slugSet) {
      slugSet.delete(ws);
      if (slugSet.size === 0) {
        this.slugClients.delete(slug);
      }
    }

    // Remove from main tracking
    this.clients.delete(ws);
  }

  /**
   * Send initial game data to a newly subscribed client
   */
  private async sendInitialData(ws: WebSocket, slug: string): Promise<void> {
    try {
      const game = await getLiveGameBySlug(slug);
      
      if (!game) {
        this.sendToClient(ws, {
          type: 'error',
          message: `Game not found: ${slug}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const transformed = await transformToActivityWatcherGame(game);
      
      this.sendToClient(ws, {
        type: 'initial',
        game: transformed,
        timestamp: new Date().toISOString(),
      });

      logger.debug({
        message: 'Sent initial activity data to WebSocket client',
        slug,
      });
    } catch (error) {
      logger.error({
        message: 'Error sending initial Activity Watcher data',
        slug,
        error: error instanceof Error ? error.message : String(error),
      });
      
      this.sendToClient(ws, {
        type: 'error',
        message: 'Failed to fetch initial game data',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Send current data to a client (for refresh requests)
   */
  private async sendCurrentData(ws: WebSocket): Promise<void> {
    const slug = this.clients.get(ws);
    if (slug) {
      await this.sendInitialData(ws, slug);
    }
  }

  /**
   * Set up broadcast callbacks from live games service
   */
  private setupBroadcastCallbacks(): void {
    // Register for full game updates
    liveGamesService.addSSEBroadcastCallback(async (games: LiveGame[]) => {
      await this.broadcastGamesUpdate(games);
    });

    // Register for partial (single game) updates
    liveGamesService.addSSEPartialBroadcastCallback(async (game: LiveGame) => {
      await this.broadcastGameUpdate(game);
    });

    logger.info({ message: 'Activity Watcher WebSocket broadcast callbacks registered' });
  }

  /**
   * Broadcast updates when multiple games change
   */
  async broadcastGamesUpdate(games: LiveGame[]): Promise<void> {
    if (this.slugClients.size === 0) return;

    // Build a map of slug -> game for quick lookup
    const gamesBySlug = new Map<string, LiveGame>();
    for (const game of games) {
      if (game.slug) {
        gamesBySlug.set(game.slug.toLowerCase(), game);
      }
      // Also map by id
      gamesBySlug.set(game.id.toLowerCase(), game);
    }

    // Send updates to subscribed clients
    for (const [slug, clients] of this.slugClients.entries()) {
      if (clients.size === 0) continue;
      
      const game = gamesBySlug.get(slug);
      if (!game) continue;

      try {
        const transformed = await transformToActivityWatcherGame(game);
        const data = JSON.stringify({
          type: 'game_update',
          game: transformed,
          timestamp: new Date().toISOString(),
        });

        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) {
            try {
              client.send(data, { compress: false });
            } catch (error) {
              this.unsubscribeClient(client);
            }
          }
        }
      } catch (error) {
        logger.error({
          message: 'Error broadcasting activity update',
          slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Broadcast single game update to subscribed clients
   */
  async broadcastGameUpdate(game: LiveGame): Promise<void> {
    // logger.info({
    //   message: 'Activity watcher broadcastGameUpdate called',
    //   gameId: game.id,
    //   slug: game.slug,
    //   totalSubscriptions: this.slugClients.size,
    // });

    if (this.slugClients.size === 0) {
      return;
    }

    // Find all slugs that match this game
    const matchingSlugs: string[] = [];
    if (game.slug) matchingSlugs.push(game.slug.toLowerCase());
    matchingSlugs.push(game.id.toLowerCase());

    // logger.info({
    //   message: 'Looking for matching slugs',
    //   matchingSlugs,
    //   subscribedSlugs: Array.from(this.slugClients.keys()),
    // });

    for (const slug of matchingSlugs) {
      const clients = this.slugClients.get(slug);
      if (!clients || clients.size === 0) continue;

      try {
        const transformed = await transformToActivityWatcherGame(game);
        const data = JSON.stringify({
          type: 'game_update',
          game: transformed,
          timestamp: new Date().toISOString(),
        });

        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) {
            try {
              client.send(data, { compress: false });
            } catch (error) {
              this.unsubscribeClient(client);
            }
          }
        }

        logger.debug({
          message: 'Broadcasted activity update to subscribed clients',
          slug,
          clientCount: clients.size,
        });
      } catch (error) {
        logger.error({
          message: 'Error broadcasting activity game update',
          slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Broadcast pre-transformed activity watcher game to subscribed clients (ultra-fast path)
   * This skips the transformation step entirely for maximum speed
   */
  broadcastActivityWatcherGame(game: ActivityWatcherGame): void {
    if (this.slugClients.size === 0) {
      return;
    }

    // Find all slugs that match this game
    const matchingSlugs: string[] = [];
    if (game.slug) matchingSlugs.push(game.slug.toLowerCase());
    matchingSlugs.push(game.id.toLowerCase());

    const data = JSON.stringify({
      type: 'game_update',
      game,
      timestamp: new Date().toISOString(),
    });

    for (const slug of matchingSlugs) {
      const clients = this.slugClients.get(slug);
      if (!clients || clients.size === 0) continue;

      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(data, { compress: false });
          } catch (error) {
            this.unsubscribeClient(client);
          }
        }
      }
    }
  }

  /**
   * Send message to a specific client
   */
  private sendToClient(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message), { compress: false });
      } catch (error) {
        logger.error({
          message: 'Error sending to Activity Watcher WebSocket client',
          error: error instanceof Error ? error.message : String(error),
        });
        this.unsubscribeClient(ws);
      }
    }
  }

  /**
   * Start heartbeat interval to keep connections alive
   */
  private startHeartbeat(): void {
    // Send heartbeat every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      if (this.clients.size > 0) {
        const heartbeat = JSON.stringify({
          type: 'heartbeat',
          timestamp: new Date().toISOString(),
        });

        for (const [ws] of this.clients) {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(heartbeat, { compress: false });
            } catch (error) {
              this.unsubscribeClient(ws);
            }
          }
        }
      }
    }, 30000);
  }

  /**
   * Get service status
   */
  getStatus(): { 
    isInitialized: boolean; 
    clientCount: number;
    subscribedGames: string[];
    path: string;
  } {
    return {
      isInitialized: this.isInitialized,
      clientCount: this.clients.size,
      subscribedGames: Array.from(this.slugClients.keys()),
      path: '/ws/activity',
    };
  }

  /**
   * Graceful shutdown
   */
  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Notify clients of shutdown
    const shutdownMessage = JSON.stringify({
      type: 'error',
      message: 'Server shutting down',
      timestamp: new Date().toISOString(),
    });

    for (const [ws] of this.clients) {
      try {
        ws.send(shutdownMessage, { compress: false });
        ws.close(1001, 'Server shutting down');
      } catch (error) {
        // Ignore close errors
      }
    }
    
    this.clients.clear();
    this.slugClients.clear();

    // Close the WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.isInitialized = false;
    logger.info({ message: 'Activity Watcher WebSocket server shut down' });
  }
}

// Export singleton instance
export const activityWatcherWebSocketService = new ActivityWatcherWebSocketService();
