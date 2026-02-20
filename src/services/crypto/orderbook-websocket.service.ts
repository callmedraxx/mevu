/**
 * Orderbook WebSocket Service
 * Runs in HTTP workers — serves frontend clients at /ws/orderbook.
 *
 * Protocol:
 * - Client connects, sends: { type: "subscribe", clobTokenId: "0x..." }
 * - Server checks if already tracking this token (no duplicate registration).
 * - Server publishes to Redis (crypto:orderbook:subscribe) so CLOB worker subscribes.
 *   addAssets() on the CLOB side is idempotent — safe to call for already-subscribed tokens.
 * - Server subscribes to Redis (crypto:orderbook) and routes book events to matching clients.
 * - Client receives: {
 *     type: "orderbook_update",
 *     clobTokenId, conditionId,
 *     bids: [{ price, size }],   // descending
 *     asks: [{ price, size }],   // ascending
 *     lastTradePrice, timestamp
 *   }
 * - A client can re-subscribe to a different token at any time.
 * - Server sends heartbeat every 30s.
 */

import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { Server as HttpServer } from 'http';
import { logger } from '../../config/logger';
import {
  initRedisClusterBroadcast,
  publishCryptoOrderbookSubscribe,
  subscribeToCryptoOrderbook,
  CryptoOrderbookBroadcastMessage,
} from '../redis-cluster-broadcast.service';

export class OrderbookWebSocketService {
  private wss: WebSocketServer | null = null;
  // ws -> subscribed clobTokenId
  private clients: Map<WebSocket, string> = new Map();
  // clobTokenId -> connected clients
  private tokenClients: Map<string, Set<WebSocket>> = new Map();
  // Tokens already published to Redis for registration (per-process dedup)
  private publishedTokens: Set<string> = new Set();

  private heartbeatInterval: NodeJS.Timeout | null = null;
  private redisUnsubscribe: (() => void) | null = null;
  private isInitialized: boolean = false;
  private wsPath: string = '/ws/orderbook';

  initialize(server: HttpServer, path: string = '/ws/orderbook'): void {
    if (this.isInitialized) return;
    this.wsPath = path;

    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: 2 * 1024 * 1024, // 2MB — orderbook payloads can be larger
      clientTracking: true,
    });

    server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
      if (pathname === this.wsPath) {
        delete request.headers['sec-websocket-extensions'];
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      }
    });

    this.setupEventHandlers();
    this.setupRedisSubscription();
    this.startHeartbeat();
    this.isInitialized = true;

    logger.info({ message: 'Orderbook WebSocket service initialized', path });
  }

  private setupEventHandlers(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleClientMessage(ws, msg);
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on('close', () => this.removeClient(ws));
      ws.on('error', () => this.removeClient(ws));
    });

    this.wss.on('error', (error) => {
      logger.error({ message: 'Orderbook WebSocket server error', error: error.message });
    });
  }

  private handleClientMessage(ws: WebSocket, msg: any): void {
    if (msg.type === 'subscribe') {
      const { clobTokenId } = msg;
      if (!clobTokenId || typeof clobTokenId !== 'string') return;

      // Unsubscribe from previous token
      this.removeClient(ws);

      // Track this client
      this.clients.set(ws, clobTokenId);
      if (!this.tokenClients.has(clobTokenId)) {
        this.tokenClients.set(clobTokenId, new Set());
      }
      this.tokenClients.get(clobTokenId)!.add(ws);

      // Publish registration to CLOB worker via Redis.
      // publishedTokens deduplicates within this process so we don't flood Redis
      // on every new client. The CLOB worker's addAssets() also deduplicates at
      // the CLOB WS level, so the overall system is fully idempotent.
      // Only mark as published AFTER a successful Redis publish — if Redis isn't
      // ready yet, future clients will retry the publish for this token.
      if (!this.publishedTokens.has(clobTokenId)) {
        if (initRedisClusterBroadcast()) {
          publishCryptoOrderbookSubscribe({ clobTokenId });
          this.publishedTokens.add(clobTokenId);
          logger.debug({
            message: 'Orderbook WS: registered new token with CLOB worker',
            clobTokenId: clobTokenId.substring(0, 20) + '...',
          });
        } else {
          logger.warn({
            message: 'Orderbook WS: Redis not ready, token will be retried on next client subscribe',
            clobTokenId: clobTokenId.substring(0, 20) + '...',
          });
        }
      }

      // Confirm subscription
      this.sendToClient(ws, {
        type: 'subscribed',
        clobTokenId,
        timestamp: Date.now(),
      });
    } else if (msg.type === 'ping') {
      this.sendToClient(ws, { type: 'pong', timestamp: Date.now() });
    }
  }

  private removeClient(ws: WebSocket): void {
    const tokenId = this.clients.get(ws);
    if (!tokenId) return;

    const tokenSet = this.tokenClients.get(tokenId);
    if (tokenSet) {
      tokenSet.delete(ws);
      if (tokenSet.size === 0) {
        this.tokenClients.delete(tokenId);
        // Note: keep publishedTokens entry so re-joining clients don't re-register
      }
    }

    this.clients.delete(ws);
  }

  /**
   * Subscribe to Redis (crypto:orderbook) and route book events to matching clients.
   */
  private setupRedisSubscription(): void {
    if (!initRedisClusterBroadcast()) return;

    this.redisUnsubscribe = subscribeToCryptoOrderbook(
      (msg: CryptoOrderbookBroadcastMessage) => {
        const clients = this.tokenClients.get(msg.clobTokenId);
        if (!clients || clients.size === 0) return;

        const data = JSON.stringify(msg);
        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) {
            try {
              client.send(data, { compress: false });
            } catch {
              this.removeClient(client);
            }
          }
        }
      }
    );
  }

  private sendToClient(ws: WebSocket, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(data), { compress: false });
      } catch {
        this.removeClient(ws);
      }
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.clients.size === 0) return;
      const heartbeat = JSON.stringify({ type: 'heartbeat', timestamp: Date.now() });
      for (const [ws] of this.clients) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(heartbeat, { compress: false });
          } catch {
            this.removeClient(ws);
          }
        }
      }
    }, 30000);
  }

  getStatus() {
    return {
      isInitialized: this.isInitialized,
      clientCount: this.clients.size,
      trackedTokens: Array.from(this.tokenClients.keys()).map(
        (t) => t.substring(0, 20) + '...'
      ),
      path: this.wsPath,
    };
  }

  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.redisUnsubscribe) {
      this.redisUnsubscribe();
      this.redisUnsubscribe = null;
    }
    const shutdownMsg = JSON.stringify({ type: 'error', message: 'Server shutting down' });
    for (const [ws] of this.clients) {
      try {
        ws.send(shutdownMsg, { compress: false });
        ws.close(1001, 'Server shutting down');
      } catch {}
    }
    this.clients.clear();
    this.tokenClients.clear();
    this.publishedTokens.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.isInitialized = false;
    logger.info({ message: 'Orderbook WebSocket service shut down' });
  }
}

export const orderbookWebSocketService = new OrderbookWebSocketService();
