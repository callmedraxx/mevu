/**
 * Crypto Live Price WebSocket Service
 * Runs in HTTP workers — serves frontend clients at /ws/crypto-prices.
 *
 * Streams real-time Chainlink oracle prices for crypto assets (BTC, ETH, SOL, XRP).
 * On subscribe, sends recent price history for chart initialization, then streams updates.
 *
 * Protocol:
 * - Client connects, sends: { type: "subscribe", symbol: "btc/usd" }
 * - Server responds: { type: "price_history", symbol, prices: [{ price, timestamp }...] }
 * - Server streams:  { type: "price_update", symbol, price, timestamp }
 * - Server sends heartbeat every 30s.
 *
 * Multi-worker broadcasting via Redis (crypto:chainlink_prices channel).
 * In-memory history buffer per symbol maintained in each HTTP worker
 * (populated from incoming Redis messages).
 */

import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { Server as HttpServer } from 'http';
import { logger } from '../../config/logger';
import {
  initRedisClusterBroadcast,
  publishCryptoChainlinkSubscribe,
  subscribeToCryptoChainlinkPrices,
  CryptoChainlinkPriceBroadcastMessage,
  ChainlinkPricePoint,
} from '../redis-cluster-broadcast.service';

// Ring buffer size per symbol (60 min of ~1/sec updates)
const MAX_HISTORY_SIZE = 3600;

// Map full asset names to Polymarket Chainlink symbols
const SYMBOL_ALIASES: Record<string, string> = {
  'bitcoin/usd': 'btc/usd',
  'ethereum/usd': 'eth/usd',
  'solana/usd': 'sol/usd',
  'ripple/usd': 'xrp/usd',
};

/** Normalize a symbol: apply alias mapping and lowercase */
function normalizeSymbol(symbol: string): string {
  const lower = symbol.toLowerCase();
  return SYMBOL_ALIASES[lower] || lower;
}

interface ClientSubscription {
  symbol: string;
}

export class CryptoLivePriceWebSocketService {
  private wss: WebSocketServer | null = null;
  // ws -> subscription info
  private clients: Map<WebSocket, ClientSubscription> = new Map();
  // symbol -> connected clients
  private symbolClients: Map<string, Set<WebSocket>> = new Map();
  // symbol -> price history ring buffer (populated from Redis)
  private priceHistory: Map<string, ChainlinkPricePoint[]> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private redisUnsubscribe: (() => void) | null = null;
  private isInitialized: boolean = false;
  private wsPath: string = '/ws/crypto-prices';

  initialize(server: HttpServer, path: string = '/ws/crypto-prices'): void {
    if (this.isInitialized) return;
    this.wsPath = path;

    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: 1 * 1024 * 1024,
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

    logger.info({ message: 'Crypto Live Price WebSocket service initialized', path });
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
        message: 'Crypto Live Price WebSocket server error',
        error: error.message,
      });
    });
  }

  private handleClientMessage(ws: WebSocket, msg: any): void {
    if (msg.type === 'subscribe') {
      const { symbol } = msg;
      if (!symbol) return;

      const normalizedSymbol = normalizeSymbol(symbol);

      // Unsubscribe from any previous symbol
      this.removeClient(ws);

      // Track this client
      this.clients.set(ws, { symbol: normalizedSymbol });

      if (!this.symbolClients.has(normalizedSymbol)) {
        this.symbolClients.set(normalizedSymbol, new Set());
      }
      this.symbolClients.get(normalizedSymbol)!.add(ws);

      // Tell CLOB worker to subscribe to this symbol via Redis
      if (initRedisClusterBroadcast()) {
        publishCryptoChainlinkSubscribe({ symbol: normalizedSymbol });
      }

      // Send price history snapshot for chart initialization
      const history = this.priceHistory.get(normalizedSymbol) || [];
      this.sendToClient(ws, {
        type: 'price_history',
        symbol: normalizedSymbol,
        prices: history,
      });

      // Confirm subscription
      this.sendToClient(ws, {
        type: 'subscribed',
        symbol: normalizedSymbol,
        timestamp: Date.now(),
      });

      // logger.info({
      //   message: 'Crypto Live Price WS: client subscribed',
      //   symbol: normalizedSymbol,
      //   historySize: history.length,
      //   clientCount: this.symbolClients.get(normalizedSymbol)?.size || 0,
      // });
    } else if (msg.type === 'ping') {
      this.sendToClient(ws, { type: 'pong', timestamp: Date.now() });
    }
  }

  private removeClient(ws: WebSocket): void {
    const info = this.clients.get(ws);
    if (!info) return;

    const symbolSet = this.symbolClients.get(info.symbol);
    if (symbolSet) {
      symbolSet.delete(ws);
      if (symbolSet.size === 0) {
        this.symbolClients.delete(info.symbol);
      }
    }

    this.clients.delete(ws);
  }

  /**
   * Subscribe to Redis (crypto:chainlink_prices) and:
   * 1. Append to local history buffer (so new subscribers get recent data)
   * 2. Forward updates to matching frontend clients with zero delay
   */
  private setupRedisSubscription(): void {
    if (!initRedisClusterBroadcast()) return;

    //logger.info({ message: 'Crypto Live Price WS: subscribing to Redis chainlink prices channel' });

    this.redisUnsubscribe = subscribeToCryptoChainlinkPrices(
      (msg: CryptoChainlinkPriceBroadcastMessage) => {
        const { symbol, price, timestamp } = msg;

        // Append to local history buffer
        if (!this.priceHistory.has(symbol)) {
          this.priceHistory.set(symbol, []);
        }
        const history = this.priceHistory.get(symbol)!;
        history.push({ price, timestamp });
        if (history.length > MAX_HISTORY_SIZE) {
          history.splice(0, history.length - MAX_HISTORY_SIZE);
        }

        // Forward to subscribed clients — zero latency, no batching
        const clients = this.symbolClients.get(symbol);
        if (!clients || clients.size === 0) return;

        // logger.debug({
        //   message: 'Chainlink price -> frontend',
        //   symbol,
        //   price: price.toFixed(2),
        //   clientCount: clients.size,
        // });

        const data = JSON.stringify({
          type: 'price_update',
          symbol,
          price,
          timestamp,
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
      subscribedSymbols: Array.from(this.symbolClients.keys()),
      historySizes: Object.fromEntries(
        Array.from(this.priceHistory.entries()).map(([k, v]) => [k, v.length])
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
    this.symbolClients.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.isInitialized = false;
    logger.info({ message: 'Crypto Live Price WebSocket service shut down' });
  }
}

export const cryptoLivePriceWebSocketService = new CryptoLivePriceWebSocketService();
