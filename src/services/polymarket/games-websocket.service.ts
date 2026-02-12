/**
 * Games WebSocket Service
 * Real-time WebSocket for frontend game updates - replaces SSE for lower latency
 */

import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { Server as HttpServer } from 'http';
import { logger } from '../../config/logger';
import { LiveGame, getAllLiveGames, liveGamesService, filterOutEndedLiveGames } from './live-games.service';
import { transformToFrontendGames, transformToFrontendGame, FrontendGame } from './frontend-game.transformer';
import { getFrontendGamesFromDatabase } from './frontend-games.service';
import {
  initRedisGamesBroadcast,
  subscribeToGamesBroadcast,
  publishGamesBroadcast,
  isRedisGamesBroadcastReady,
} from '../redis-games-broadcast.service';
import {
  subscribeToKalshiPriceBroadcast,
  KalshiPriceBroadcastMessage,
} from '../redis-cluster-broadcast.service';

// Message types for WebSocket communication
interface WSMessage {
  type: 'initial' | 'games_update' | 'game_update' | 'price_update' | 'kalshi_price_update' | 'heartbeat' | 'error' | 'subscribed';
  games?: FrontendGame[];
  game?: FrontendGame;
  timestamp?: string;
  message?: string;
  clientCount?: number;
  // Kalshi price update fields
  gameId?: string;
  awayTeam?: { kalshiBuyPrice: number; kalshiSellPrice: number };
  homeTeam?: { kalshiBuyPrice: number; kalshiSellPrice: number };
}

/**
 * Games WebSocket Service
 * Manages WebSocket connections for real-time game updates
 */
export class GamesWebSocketService {
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private isInitialized: boolean = false;
  private redisUnsubscribe: (() => void) | null = null;
  private kalshiRedisUnsubscribe: (() => void) | null = null;

  private wsPath: string = '/ws/games';
  
  /**
   * Initialize the WebSocket server
   * @param server - HTTP server instance to attach WebSocket to
   * @param path - WebSocket path (default: /ws/games)
   */
  initialize(server: HttpServer, path: string = '/ws/games'): void {
    if (this.isInitialized) {
      logger.warn({ message: 'Games WebSocket already initialized' });
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
    this.setupRedisBroadcast();
    this.startHeartbeat();
    this.isInitialized = true;

    logger.info({ 
      message: 'Games WebSocket server initialized',
      path,
    });
  }

  /**
   * Subscribe to Redis for cluster-wide broadcasts. When we receive a message,
   * broadcast to our local WebSocket clients.
   */
  private setupRedisBroadcast(): void {
    if (!initRedisGamesBroadcast()) return;

    this.redisUnsubscribe = subscribeToGamesBroadcast((msg) => {
      try {
        const msgType = (msg as { type?: string }).type;

        // Skip cache_invalidate messages - they're for HTTP workers, not WebSocket clients
        if (msgType === 'cache_invalidate') {
          return;
        }

        if (msgType === 'batch') {
          const arr = JSON.parse(msg.payload) as WSMessage[];
          for (const p of arr) this.broadcast(p);
        } else {
          const parsed = JSON.parse(msg.payload);
          this.broadcast(parsed);
        }
      } catch (err) {
        logger.warn({
          message: 'Failed to parse Redis broadcast payload',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    
    // Subscribe to Kalshi price broadcasts for real-time Kalshi price updates
    this.setupKalshiPriceBroadcast();
  }
  
  /**
   * Subscribe to Kalshi price broadcasts and forward to WebSocket clients
   */
  private setupKalshiPriceBroadcast(): void {
    this.kalshiRedisUnsubscribe = subscribeToKalshiPriceBroadcast((msg: KalshiPriceBroadcastMessage) => {
      try {
        const clientCount = this.clients.size;
        logger.info({
          message: '[Kalshi broadcast] Games WebSocket received kalshi_price_update, sending to frontend',
          gameId: msg.gameId,
          ticker: msg.ticker,
          clientCount,
        });

        const payload: WSMessage = {
          type: 'kalshi_price_update',
          gameId: msg.gameId,
          awayTeam: {
            kalshiBuyPrice: msg.awayTeam.kalshiBuyPrice,
            kalshiSellPrice: msg.awayTeam.kalshiSellPrice,
          },
          homeTeam: {
            kalshiBuyPrice: msg.homeTeam.kalshiBuyPrice,
            kalshiSellPrice: msg.homeTeam.kalshiSellPrice,
          },
          timestamp: new Date().toISOString(),
          ...(msg.updatedSides?.length && { updatedSides: msg.updatedSides }),
        };
        this.broadcast(payload);
        const sent = Array.from(this.clients).filter((c) => c.readyState === 1).length;
        if (sent > 0) {
          logger.info({
            message: '[Kalshi broadcast] Games WebSocket sent kalshi_price_update to client(s)',
            gameId: msg.gameId,
            sentToCount: sent,
          });
        }
      } catch (err) {
        logger.warn({
          message: 'Failed to broadcast Kalshi price update',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    
    logger.info({ message: 'Kalshi price broadcast subscription initialized' });
  }

  /**
   * Set up WebSocket event handlers
   */
  private setupEventHandlers(): void {
    if (!this.wss) return;

    this.wss.on('connection', async (ws: WebSocket, request) => {
      this.clients.add(ws);
      
      const clientIp = request.headers['x-forwarded-for'] || 
                       request.headers['x-real-ip'] || 
                       request.socket.remoteAddress;

      // logger.info({
      //   message: 'WebSocket client connected',
      //   clientIp,
      //   totalClients: this.clients.size,
      // });

      // Send confirmation message
      this.sendToClient(ws, {
        type: 'subscribed',
        message: 'Connected to games WebSocket',
        timestamp: new Date().toISOString(),
        clientCount: this.clients.size,
      });

      // Send initial games data immediately
      // await this.sendInitialData(ws);

      // Handle incoming messages (for future command support)
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleClientMessage(ws, message);
        } catch (error) {
          logger.debug({
            message: 'Invalid WebSocket message received',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      // Handle client disconnect
      ws.on('close', (code, reason) => {
        this.clients.delete(ws);
        // Only log at info level for normal closures, debug for abnormal
        const logFn = code === 1000 || code === 1001 ? logger.info : logger.debug;
        logFn.call(logger, {
          message: 'WebSocket client disconnected',
          code,
          reason: reason.toString(),
          totalClients: this.clients.size,
        });
      });

      // Handle errors
      ws.on('error', (error) => {
        logger.error({
          message: 'WebSocket client error',
          error: error.message,
        });
        this.clients.delete(ws);
      });
    });

    this.wss.on('error', (error) => {
      logger.error({
        message: 'WebSocket server error',
        error: error.message,
      });
    });
  }

  /**
   * Handle incoming client messages
   */
  private handleClientMessage(ws: WebSocket, message: any): void {
    // Handle different message types from clients
    switch (message.type) {
      case 'ping':
        this.sendToClient(ws, { type: 'heartbeat', timestamp: new Date().toISOString() });
        break;
      case 'refresh':
        // Client requests fresh data
        this.sendInitialData(ws);
        break;
      default:
        logger.debug({
          message: 'Unknown WebSocket message type',
          type: message.type,
        });
    }
  }

  /**
   * Send initial games data to a newly connected client
   */
  private async sendInitialData(ws: WebSocket): Promise<void> {
    try {
      const result = await getFrontendGamesFromDatabase({
        includeEnded: 'false',
        page: 1,
        limit: 1000,
      });
      
      this.sendToClient(ws, {
        type: 'initial',
        games: result.games,
        timestamp: new Date().toISOString(),
      });

      // logger.debug({
      //   message: 'Sent initial games data to WebSocket client',
      //   gameCount: frontendGames.length,
      // });
    } catch (error) {
      logger.error({
        message: 'Error sending initial WebSocket data',
        error: error instanceof Error ? error.message : String(error),
      });
      
      this.sendToClient(ws, {
        type: 'error',
        message: 'Failed to fetch initial games data',
        timestamp: new Date().toISOString(),
      });
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

    logger.info({ message: 'WebSocket broadcast callbacks registered' });
  }

  /**
   * Broadcast full games update to all connected clients
   */
  async broadcastGamesUpdate(games: LiveGame[]): Promise<void> {
    if (this.clients.size === 0 && !isRedisGamesBroadcastReady()) return;

    try {
      const activeGames = filterOutEndedLiveGames(games);
      const frontendGames = await transformToFrontendGames(activeGames);
      const message: WSMessage = {
        type: 'games_update',
        games: frontendGames,
        timestamp: new Date().toISOString(),
      };

      if (isRedisGamesBroadcastReady()) {
        await publishGamesBroadcast({ type: 'games_update', payload: JSON.stringify(message) });
      } else {
        this.broadcast(message);
      }
    } catch (error) {
      logger.error({
        message: 'Error broadcasting games update',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Broadcast single game update to all connected clients (partial update)
   */
  async broadcastGameUpdate(game: LiveGame): Promise<void> {
    if (this.clients.size === 0 && !isRedisGamesBroadcastReady()) return;

    try {
      const frontendGame = await transformToFrontendGame(game);
      const message: WSMessage = {
        type: 'game_update',
        game: frontendGame,
        timestamp: new Date().toISOString(),
      };

      if (isRedisGamesBroadcastReady()) {
        await publishGamesBroadcast({ type: 'game_update', payload: JSON.stringify(message) });
      } else {
        this.broadcast(message);
      }
    } catch (error) {
      logger.error({
        message: 'Error broadcasting game update',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Broadcast price update to all connected clients (fast path for real-time prices)
   */
  async broadcastPriceUpdate(game: LiveGame): Promise<void> {
    if (this.clients.size === 0 && !isRedisGamesBroadcastReady()) return;

    try {
      const frontendGame = await transformToFrontendGame(game);
      const message: WSMessage = {
        type: 'price_update' as any,
        game: frontendGame,
        timestamp: new Date().toISOString(),
      };

      if (isRedisGamesBroadcastReady()) {
        await publishGamesBroadcast({ type: 'price_update', payload: JSON.stringify(message) });
      } else {
        this.broadcast(message);
      }
    } catch (error) {
      logger.error({
        message: 'Error broadcasting price update',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Broadcast pre-transformed frontend game to all connected clients (ultra-fast path)
   * This skips the transformation step entirely for maximum speed
   */
  broadcastFrontendGame(frontendGame: FrontendGame, type: 'price_update' | 'game_update' = 'price_update'): void {
    if (this.clients.size === 0 && !isRedisGamesBroadcastReady()) return;

    const message: WSMessage = {
      type: type as any,
      game: frontendGame,
      timestamp: new Date().toISOString(),
    };

    if (isRedisGamesBroadcastReady()) {
      publishGamesBroadcast({ type, payload: JSON.stringify(message) }).catch(() => {});
    } else {
      this.broadcast(message);
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
          message: 'Error sending to WebSocket client',
          error: error instanceof Error ? error.message : String(error),
        });
        this.clients.delete(ws);
      }
    }
  }

  /**
   * Broadcast message to all connected clients
   */
  private broadcast(message: WSMessage): void {
    const data = JSON.stringify(message);
    
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(data, { compress: false });
        } catch (error) {
          logger.error({
            message: 'Error broadcasting to WebSocket client',
            error: error instanceof Error ? error.message : String(error),
          });
          this.clients.delete(client);
        }
      } else {
        // Remove disconnected clients
        this.clients.delete(client);
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
        this.broadcast({
          type: 'heartbeat',
          timestamp: new Date().toISOString(),
        });
      }
    }, 30000);
  }

  /**
   * Get service status
   */
  getStatus(): { 
    isInitialized: boolean; 
    clientCount: number;
    path: string;
  } {
    return {
      isInitialized: this.isInitialized,
      clientCount: this.clients.size,
      path: '/ws/games',
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

    if (this.redisUnsubscribe) {
      this.redisUnsubscribe();
      this.redisUnsubscribe = null;
    }
    
    if (this.kalshiRedisUnsubscribe) {
      this.kalshiRedisUnsubscribe();
      this.kalshiRedisUnsubscribe = null;
    }

    // Notify clients of shutdown
    this.broadcast({
      type: 'error',
      message: 'Server shutting down',
      timestamp: new Date().toISOString(),
    });

    // Close all client connections
    for (const client of this.clients) {
      try {
        client.close(1001, 'Server shutting down');
      } catch (error) {
        // Ignore close errors
      }
    }
    this.clients.clear();

    // Close the WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.isInitialized = false;
    logger.info({ message: 'Games WebSocket server shut down' });
  }
}

// Export singleton instance
export const gamesWebSocketService = new GamesWebSocketService();
