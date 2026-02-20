/**
 * Crypto Market WebSocket Service
 * Runs in HTTP workers — serves frontend clients at /ws/crypto.
 *
 * Protocol:
 * - Client connects, sends: { type: "subscribe", slug, upClobTokenId, downClobTokenId }
 * - Server publishes to Redis (crypto:clob:subscribe) so the CLOB worker subscribes tokens.
 * - Server subscribes to Redis (crypto:prices) and forwards updates to matching clients.
 * - Client receives: { type: "price_update", slug, clobTokenId, price, timestamp }
 *   (one message per token — frontend matches clobTokenId to the correct Up/Down button)
 * - Server sends heartbeat every 30s.
 */

import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { Server as HttpServer } from 'http';
import { logger } from '../../config/logger';
import {
  initRedisClusterBroadcast,
  publishCryptoClobSubscribe,
  subscribeToCryptoPrices,
  CryptoPriceBroadcastMessage,
} from '../redis-cluster-broadcast.service';

interface CryptoWSClientInfo {
  slug: string;
  upClobTokenId: string;
  downClobTokenId: string;
}

export class CryptoMarketWebSocketService {
  private wss: WebSocketServer | null = null;
  // ws -> client subscription info
  private clients: Map<WebSocket, CryptoWSClientInfo> = new Map();
  // slug -> connected clients
  private slugClients: Map<string, Set<WebSocket>> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private redisUnsubscribe: (() => void) | null = null;
  private isInitialized: boolean = false;
  private wsPath: string = '/ws/crypto';

  initialize(server: HttpServer, path: string = '/ws/crypto'): void {
    if (this.isInitialized) return;
    this.wsPath = path;

    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: 1 * 1024 * 1024, // 1MB
      clientTracking: true,
    });

    // Handle upgrade manually to strip compression extensions
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

    logger.info({ message: 'Crypto Market WebSocket service initialized', path });
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
      logger.error({
        message: 'Crypto Market WebSocket server error',
        error: error.message,
      });
    });
  }

  private handleClientMessage(ws: WebSocket, msg: any): void {
    if (msg.type === 'subscribe') {
      const { slug, upClobTokenId, downClobTokenId } = msg;
      if (!slug || !upClobTokenId) return;

      // Unsubscribe from any previous slug
      this.removeClient(ws);

      // Track this client
      const info: CryptoWSClientInfo = {
        slug,
        upClobTokenId,
        downClobTokenId: downClobTokenId || '',
      };
      this.clients.set(ws, info);

      if (!this.slugClients.has(slug)) {
        this.slugClients.set(slug, new Set());
      }
      this.slugClients.get(slug)!.add(ws);

      // Tell CLOB worker to subscribe to these tokens via Redis
      if (initRedisClusterBroadcast()) {
        publishCryptoClobSubscribe({
          slug,
          upClobTokenId,
          downClobTokenId: downClobTokenId || '',
        });
      }

      // Confirm subscription to client
      this.sendToClient(ws, {
        type: 'subscribed',
        slug,
        timestamp: Date.now(),
      });

      logger.info({
        message: 'Crypto WS: client subscribed',
        slug,
        upClobTokenId: upClobTokenId.substring(0, 20) + '...',
        downClobTokenId: (downClobTokenId || '').substring(0, 20) + '...',
        clientCount: this.slugClients.get(slug)?.size || 0,
      });
    } else if (msg.type === 'ping') {
      this.sendToClient(ws, { type: 'pong', timestamp: Date.now() });
    }
  }

  private removeClient(ws: WebSocket): void {
    const info = this.clients.get(ws);
    if (!info) return;

    const slugSet = this.slugClients.get(info.slug);
    if (slugSet) {
      slugSet.delete(ws);
      if (slugSet.size === 0) {
        this.slugClients.delete(info.slug);
      }
    }

    this.clients.delete(ws);
  }

  /**
   * Subscribe to Redis (crypto:prices) and forward per-token updates to matching clients.
   * Each message contains a single clobTokenId + price. The frontend matches the
   * clobTokenId to the correct Up/Down button — no derivation needed.
   */
  private setupRedisSubscription(): void {
    if (!initRedisClusterBroadcast()) return;

    this.redisUnsubscribe = subscribeToCryptoPrices((msg: CryptoPriceBroadcastMessage) => {
      const clients = this.slugClients.get(msg.slug);
      if (!clients || clients.size === 0) return;

      const data = JSON.stringify({
        type: 'price_update',
        slug: msg.slug,
        clobTokenId: msg.clobTokenId,
        price: msg.price,
        timestamp: msg.timestamp,
      });

      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(data, { compress: false });
          } catch {
            this.removeClient(client);
          }
        }
      }
    });
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
      subscribedSlugs: Array.from(this.slugClients.keys()),
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
    this.slugClients.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.isInitialized = false;
    logger.info({ message: 'Crypto Market WebSocket service shut down' });
  }
}

export const cryptoMarketWebSocketService = new CryptoMarketWebSocketService();
