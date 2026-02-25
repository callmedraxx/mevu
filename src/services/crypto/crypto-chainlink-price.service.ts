/**
 * Crypto Chainlink Price Service
 * Runs in CLOB background worker — connects to Polymarket's live-data WebSocket
 * and streams real-time Chainlink oracle prices for crypto assets.
 *
 * Upstream WS: wss://ws-live-data.polymarket.com/
 * Topic: crypto_prices_chainlink
 * Symbols: btc/usd, eth/usd, sol/usd, xrp/usd
 *
 * Maintains an in-memory ring buffer of recent prices per symbol (60 min)
 * so HTTP workers can send chart history to newly-connecting frontend clients.
 *
 * Publishes price updates to Redis (crypto:chainlink_prices) for all HTTP workers.
 * Listens on Redis (crypto:chainlink:subscribe) for on-demand symbol requests.
 */

import WebSocket from 'ws';
import { logger } from '../../config/logger';
import {
  initRedisClusterBroadcast,
  publishCryptoChainlinkPriceUpdate,
  subscribeToCryptoChainlinkSubscribe,
  CryptoChainlinkPriceBroadcastMessage,
  ChainlinkPricePoint,
} from '../redis-cluster-broadcast.service';

// All supported symbols — we subscribe to all on connect
const SUPPORTED_SYMBOLS = ['btc/usd', 'eth/usd', 'sol/usd', 'xrp/usd'];

const WS_URL = 'wss://ws-live-data.polymarket.com/';

/** Normalize symbol from Polymarket (may use different casing/format) to our canonical format */
function normalizeChainlinkSymbol(symbol: string): string {
  const lower = symbol.toLowerCase().trim();
  const aliases: Record<string, string> = {
    'bitcoin/usd': 'btc/usd',
    'ethereum/usd': 'eth/usd',
    'solana/usd': 'sol/usd',
    'ripple/usd': 'xrp/usd',
    'btc': 'btc/usd',
    'eth': 'eth/usd',
    'sol': 'sol/usd',
    'xrp': 'xrp/usd',
    'xrp-usd': 'xrp/usd',
    'eth-usd': 'eth/usd',
    'sol-usd': 'sol/usd',
    'btc-usd': 'btc/usd',
  };
  return aliases[lower] ?? (lower.includes('/') ? lower : `${lower}/usd`);
}

// Ring buffer holds ~60 minutes of data per symbol (~1 update/sec = ~3600 points)
const MAX_HISTORY_SIZE = 3600;

// Reconnect with exponential backoff
const INITIAL_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30000;
// If no price update for this long, assume zombie connection and force reconnect
const SILENCE_RECONNECT_MS = 120000; // 2 minutes

/** Upstream message format from Polymarket live-data WS */
interface PolymarketChainlinkMessage {
  connection_id?: string;
  payload: {
    full_accuracy_value: string;
    symbol: string;
    timestamp: number; // ms epoch
    value: number;
  };
  timestamp: number;
  topic: string;
  type: string;
}

class CryptoChainlinkPriceService {
  private ws: WebSocket | null = null;
  private isShuttingDown = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private silenceCheckTimer: NodeJS.Timeout | null = null;
  private lastPriceAt: number = 0;
  private diagnosticTimer: NodeJS.Timeout | null = null;
  private redisUnsubscribe: (() => void) | null = null;
  private updateCount: number = 0;

  // symbol -> ring buffer of price points
  private priceHistory: Map<string, ChainlinkPricePoint[]> = new Map();
  // Track subscribed symbols (all by default, but can be extended dynamically)
  private subscribedSymbols: Set<string> = new Set(SUPPORTED_SYMBOLS);
  // Latest price per symbol (for quick lookups)
  private latestPrices: Map<string, ChainlinkPricePoint> = new Map();

  /**
   * Initialize the service: set up Redis subscription and connect to upstream WS.
   * Call this in the CLOB background worker.
   */
  initialize(): void {
    logger.info({ message: 'Initializing Crypto Chainlink Price Service' });

    // Listen for on-demand symbol subscribe requests from HTTP workers
    if (initRedisClusterBroadcast()) {
      this.redisUnsubscribe = subscribeToCryptoChainlinkSubscribe((msg) => {
        if (msg.symbol && !this.subscribedSymbols.has(msg.symbol)) {
          this.subscribedSymbols.add(msg.symbol);
          // logger.info({
          //   message: 'Chainlink: dynamic symbol subscription requested',
          //   symbol: msg.symbol,
          // });
          // If connected, send additional subscribe message
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.subscribeSymbol(msg.symbol);
          }
        }
      });
    }

    // Initialize price history buffers
    for (const symbol of SUPPORTED_SYMBOLS) {
      this.priceHistory.set(symbol, []);
    }

    // Periodic diagnostic log every 10s
    this.diagnosticTimer = setInterval(() => {
      const latest = this.getAllLatestPrices();
      const latestSummary = Object.entries(latest).map(([s, p]) => `${s}=$${p.price.toFixed(2)}`).join(', ');
      // logger.info({
      //   message: 'Chainlink price diagnostic',
      //   connected: this.ws?.readyState === WebSocket.OPEN,
      //   updateCount: this.updateCount,
      //   historySize: Object.fromEntries(
      //     Array.from(this.priceHistory.entries()).map(([k, v]) => [k, v.length])
      //   ),
      //   latestPrices: latestSummary || 'none',
      // });
      this.updateCount = 0;
    }, 10000);

    this.connect();
  }

  private connect(): void {
    if (this.isShuttingDown) return;

    try {
      logger.info({ message: 'Connecting to Polymarket live-data WS', url: WS_URL });

      this.ws = new WebSocket(WS_URL, {
        headers: {
          'User-Agent': 'mevu-backend/1.0',
        },
      });

      this.ws.on('open', () => {
        logger.info({ message: 'Connected to Polymarket live-data WS' });
        this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

        // Subscribe to all symbols
        this.subscribeAll();

        // Start heartbeat (ping every 30s)
        this.startHeartbeat();

        // Silence check: if no price for 2min, connection is likely dead — force reconnect
        this.startSilenceCheck();
      });

      this.ws.on('message', (data) => {
        try {
          const raw = data.toString();
          // Skip empty frames (Polymarket sends one on connect)
          if (!raw || raw.length === 0) return;
          // Polymarket may send ping/pong frames or heartbeats
          if (raw === 'PING' || raw === 'ping') {
            this.ws?.send('PONG');
            return;
          }
          const msg = JSON.parse(raw);

          // Log ALL messages for debugging (first 20 chars of raw for non-price messages)
          // if (msg.topic === 'crypto_prices_chainlink' && msg.type === 'update') {
          //   // Price update — log concisely
          //   logger.debug({
          //     message: 'Chainlink WS price tick',
          //     symbol: msg.payload?.symbol,
          //     price: msg.payload?.value,
          //     ts: msg.payload?.timestamp,
          //   });
          // } else {
          //   // Non-price message (connection ack, error, etc.) — log full
          //   logger.info({
          //     message: 'Chainlink WS message (non-price)',
          //     topic: msg.topic,
          //     type: msg.type,
          //     connectionId: msg.connection_id,
          //     keys: Object.keys(msg),
          //     raw: raw.substring(0, 300),
          //   });
          // }

          this.handleMessage(msg);
        } catch (err) {
          logger.warn({
            message: 'Chainlink WS message parse error',
            error: err instanceof Error ? err.message : String(err),
            rawPreview: data.toString().substring(0, 200),
          });
        }
      });

      this.ws.on('close', (code, reason) => {
        logger.warn({
          message: 'Polymarket live-data WS closed',
          code,
          reason: reason?.toString(),
        });
        this.stopHeartbeat();
        this.stopSilenceCheck();
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        logger.error({
          message: 'Polymarket live-data WS error',
          error: error.message,
        });
      });
    } catch (error) {
      logger.error({
        message: 'Failed to connect to Polymarket live-data WS',
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect();
    }
  }

  /**
   * Subscribe to all Chainlink symbols at once.
   * Polymarket docs: use filters: "" to get all symbols (btc/usd, eth/usd, sol/usd, xrp/usd).
   * Per-symbol filters can fail for some symbols; subscribe-to-all is more reliable.
   */
  private subscribeAll(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg = {
      action: 'subscribe',
      subscriptions: [
        {
          topic: 'crypto_prices_chainlink',
          type: '*',
          filters: '', // Empty = all symbols (btc, eth, sol, xrp)
        },
      ],
    };

    this.ws.send(JSON.stringify(msg));

    // logger.info({
    //   message: 'Subscribed to chainlink price feeds (all symbols)',
    //   symbols: Array.from(this.subscribedSymbols),
    // });
  }

  /**
   * Subscribe to a single additional symbol (dynamic on-demand).
   */
  private subscribeSymbol(symbol: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Ensure history buffer exists
    if (!this.priceHistory.has(symbol)) {
      this.priceHistory.set(symbol, []);
    }

    const msg = {
      action: 'subscribe',
      subscriptions: [
        {
          topic: 'crypto_prices_chainlink',
          type: '*',
          filters: JSON.stringify({ symbol }),
        },
      ],
    };

    this.ws.send(JSON.stringify(msg));
    logger.info({ message: 'Subscribed to additional chainlink symbol', symbol });
  }

  /**
   * Handle an incoming message from the upstream WS.
   * Two message types:
   * - snapshot: initial history per symbol { payload: { data: [{timestamp, value}...], symbol }, topic, type: "snapshot" }
   * - update:   individual price tick { payload: { symbol, timestamp, value }, topic, type: "update" }
   */
  private handleMessage(msg: any): void {
    if (msg.topic !== 'crypto_prices_chainlink') return;

    // Handle initial snapshot (historical data array)
    if (msg.type === 'snapshot' && msg.payload?.data && Array.isArray(msg.payload.data)) {
      const rawSymbol = msg.payload.symbol as string | undefined;
      if (!rawSymbol) return;
      const symbol = normalizeChainlinkSymbol(rawSymbol);

      const dataPoints = msg.payload.data as Array<{ timestamp: number; value?: number; full_accuracy_value?: string }>;
      // logger.info({
      //   message: 'Chainlink snapshot received',
      //   symbol,
      //   pointCount: dataPoints.length,
      // });

      // Ensure history buffer exists
      if (!this.priceHistory.has(symbol)) {
        this.priceHistory.set(symbol, []);
      }
      const history = this.priceHistory.get(symbol)!;

      // Append snapshot data (support value or full_accuracy_value)
      for (const pt of dataPoints) {
        const ts = typeof pt.timestamp === 'number' ? pt.timestamp : NaN;
        let p = typeof pt.value === 'number' ? pt.value : NaN;
        if (Number.isNaN(p) && typeof pt.full_accuracy_value === 'string') p = parseFloat(pt.full_accuracy_value);
        if (!Number.isNaN(ts) && typeof p === 'number' && !Number.isNaN(p)) {
          history.push({ price: p, timestamp: ts });
        }
      }

      // Trim
      if (history.length > MAX_HISTORY_SIZE) {
        history.splice(0, history.length - MAX_HISTORY_SIZE);
      }

      // Update latest price and publish from last valid point
      if (history.length > 0) {
        const last = history[history.length - 1];
        this.latestPrices.set(symbol, last);
        this.lastPriceAt = Date.now();
        publishCryptoChainlinkPriceUpdate({
          type: 'chainlink_price_update',
          symbol,
          price: last.price,
          timestamp: last.timestamp,
        });
      }
      return;
    }

    // Handle individual price update
    if (msg.type !== 'update') return;
    if (!msg.payload?.symbol) return;

    // Polymarket may send value (number) or full_accuracy_value (string)
    let price: number | undefined = msg.payload.value;
    if (typeof price !== 'number' || Number.isNaN(price)) {
      const acc = msg.payload.full_accuracy_value;
      if (typeof acc === 'string') price = parseFloat(acc);
    }
    if (typeof price !== 'number' || Number.isNaN(price)) {
      // logger.debug({
      //   message: 'Chainlink: dropped update (invalid price)',
      //   symbol: msg.payload.symbol,
      //   value: msg.payload.value,
      //   full_accuracy_value: msg.payload.full_accuracy_value,
      // });
      return;
    }

    const rawSymbol = msg.payload.symbol as string;
    const symbol = normalizeChainlinkSymbol(rawSymbol);
    const timestamp = (typeof msg.payload.timestamp === 'number' ? msg.payload.timestamp : Date.now()) as number;

    // Store in ring buffer
    const history = this.priceHistory.get(symbol);
    if (history) {
      history.push({ price, timestamp });
      // Trim to max size
      if (history.length > MAX_HISTORY_SIZE) {
        history.splice(0, history.length - MAX_HISTORY_SIZE);
      }
    } else {
      // Dynamic symbol — create buffer
      this.priceHistory.set(symbol, [{ price, timestamp }]);
    }

    // Update latest price
    this.latestPrices.set(symbol, { price, timestamp });
    this.updateCount++;
    this.lastPriceAt = Date.now();

    // Publish to Redis for all HTTP workers — no batching, zero latency
    const broadcastMsg: CryptoChainlinkPriceBroadcastMessage = {
      type: 'chainlink_price_update',
      symbol,
      price,
      timestamp,
    };
    publishCryptoChainlinkPriceUpdate(broadcastMsg);
  }

  private scheduleReconnect(): void {
    if (this.isShuttingDown || this.reconnectTimer) return;

    // logger.info({
    //   message: 'Scheduling reconnect to Polymarket live-data WS',
    //   delayMs: this.reconnectDelay,
    // });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          // Ignore ping errors
        }
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startSilenceCheck(): void {
    this.stopSilenceCheck();
    this.lastPriceAt = Date.now();
    this.silenceCheckTimer = setInterval(() => {
      if (this.isShuttingDown || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const elapsed = Date.now() - this.lastPriceAt;
      if (elapsed >= SILENCE_RECONNECT_MS) {
        logger.warn({
          message: 'Polymarket live-data WS: no price update for 2min, forcing reconnect',
          elapsedMs: elapsed,
        });
        this.stopSilenceCheck();
        this.stopHeartbeat();
        try {
          this.ws.close(4000, 'Silence timeout');
        } catch {}
        this.ws = null;
        this.scheduleReconnect();
      }
    }, 15000); // Check every 15s
  }

  private stopSilenceCheck(): void {
    if (this.silenceCheckTimer) {
      clearInterval(this.silenceCheckTimer);
      this.silenceCheckTimer = null;
    }
  }

  /**
   * Get price history for a symbol. Used by HTTP workers (via direct import in dev mode,
   * or sent over Redis as initial snapshot).
   */
  getPriceHistory(symbol: string): ChainlinkPricePoint[] {
    return this.priceHistory.get(symbol) || [];
  }

  /** Get the latest price for a symbol. */
  getLatestPrice(symbol: string): ChainlinkPricePoint | null {
    return this.latestPrices.get(symbol) || null;
  }

  /** Get all latest prices. */
  getAllLatestPrices(): Record<string, ChainlinkPricePoint> {
    const result: Record<string, ChainlinkPricePoint> = {};
    for (const [symbol, point] of this.latestPrices) {
      result[symbol] = point;
    }
    return result;
  }

  getStatus() {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      subscribedSymbols: Array.from(this.subscribedSymbols),
      historySize: Object.fromEntries(
        Array.from(this.priceHistory.entries()).map(([k, v]) => [k, v.length])
      ),
      latestPrices: this.getAllLatestPrices(),
    };
  }

  shutdown(): void {
    this.isShuttingDown = true;
    this.stopHeartbeat();
    this.stopSilenceCheck();
    if (this.diagnosticTimer) {
      clearInterval(this.diagnosticTimer);
      this.diagnosticTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.redisUnsubscribe) {
      this.redisUnsubscribe();
      this.redisUnsubscribe = null;
    }

    if (this.ws) {
      try {
        this.ws.close(1000, 'Shutting down');
      } catch {}
      this.ws = null;
    }

    logger.info({ message: 'Crypto Chainlink Price Service shut down' });
  }
}

export const cryptoChainlinkPriceService = new CryptoChainlinkPriceService();
