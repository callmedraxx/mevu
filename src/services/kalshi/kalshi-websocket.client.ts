/**
 * Kalshi WebSocket Client
 * Low-level WebSocket connection management for real-time price updates
 * 
 * Key features:
 * - Authenticated WebSocket connection to Kalshi
 * - Automatic reconnection with exponential backoff
 * - Ping/Pong heartbeat handling
 * - Batched subscriptions to respect rate limits
 * - Event emitter for price updates
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { logger } from '../../config/logger';

// Kalshi WebSocket URLs
const KALSHI_WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2';

// Connection settings
const PING_INTERVAL_MS = 10000; // Kalshi sends pings every 10s
const PONG_TIMEOUT_MS = 5000;   // Wait 5s for pong response
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000]; // Exponential backoff
const MAX_RECONNECT_ATTEMPTS = 10;

// Subscription settings
const SUBSCRIPTION_BATCH_SIZE = 50;  // Subscribe to 50 tickers at a time
const SUBSCRIPTION_BATCH_DELAY_MS = 100;  // 100ms between batches
// Memory guard: max subscriptions (configurable via env, default 2000)
const MAX_SUBSCRIPTIONS = parseInt(process.env.KALSHI_MAX_SUBSCRIPTIONS || '2000', 10);

// Message types from Kalshi
export interface KalshiTickerMessage {
  type: 'ticker';
  sid: number;
  seq: number;
  msg: {
    market_ticker: string;
    market_id?: string;
    price?: number;        // Last traded price (1-99 cents)
    yes_bid: number;       // Best bid for YES
    yes_ask: number;       // Best ask for YES
    volume?: number;       // Contract volume
    dollar_volume?: number; // Dollars traded (use for kalshi_markets.volume when liquidity is thin)
    open_interest?: number;
    ts?: number;           // Unix timestamp
  };
}

export interface KalshiSubscribeCommand {
  id: number;
  cmd: 'subscribe';
  params: {
    channels: string[];
    market_tickers: string[];
  };
}

export interface KalshiUnsubscribeCommand {
  id: number;
  cmd: 'unsubscribe';
  params: {
    channels: string[];
    market_tickers: string[];
  };
}

// Events emitted by the client
export interface KalshiWebSocketEvents {
  'connected': () => void;
  'disconnected': (code: number, reason: string) => void;
  'ticker': (message: KalshiTickerMessage) => void;
  'error': (error: Error) => void;
  'subscribed': (tickers: string[]) => void;
  'unsubscribed': (tickers: string[]) => void;
}

export class KalshiWebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private isConnecting = false;
  private isShuttingDown = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private pongTimeout: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private subscribedTickers: Set<string> = new Set();
  private pendingSubscriptions: Set<string> = new Set();
  private commandId = 1;
  private messageTypesLogged: Set<string> = new Set();

  // Singleton pattern - only one instance per process
  private static instance: KalshiWebSocketClient | null = null;

  static getInstance(): KalshiWebSocketClient {
    if (!KalshiWebSocketClient.instance) {
      KalshiWebSocketClient.instance = new KalshiWebSocketClient();
    }
    return KalshiWebSocketClient.instance;
  }

  private constructor() {
    super();
    this.setMaxListeners(50);
  }

  /**
   * Connect to Kalshi WebSocket
   * Uses API key authentication if available
   */
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      logger.debug({ message: 'Kalshi WebSocket already connected' });
      return;
    }

    if (this.isConnecting) {
      logger.debug({ message: 'Kalshi WebSocket connection already in progress' });
      return;
    }

    this.isConnecting = true;
    this.isShuttingDown = false;

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'mevu-backend/1.0',
      };
      
      // Kalshi WebSocket authentication: API Key ID + RSA-PSS SHA256 signature
      const apiKeyId = process.env.KALSHI_API_KEY_ID;
      const apiPrivateKey = process.env.KALSHI_API_PRIVATE_KEY;
      
      if (apiKeyId && apiPrivateKey) {
        const timestamp = Date.now().toString();
        const path = '/trade-api/ws/v2';
        const method = 'GET';
        
        // Create message: timestamp + HTTP_METHOD + path
        const message = timestamp + method + path;
        
        try {
          // Sign with RSA-PSS SHA256 (Kalshi requires PSS padding)
          // Create message: timestamp + HTTP_METHOD + path
          const messageBuffer = Buffer.from(message, 'utf8');
          
          // Use crypto.sign() with RSA-PSS padding
          const signature = crypto.sign('RSA-SHA256', messageBuffer, {
            key: apiPrivateKey,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
          });
          
          const signatureBase64 = signature.toString('base64');
          
          headers['KALSHI-ACCESS-KEY'] = apiKeyId;
          headers['KALSHI-ACCESS-TIMESTAMP'] = timestamp;
          headers['KALSHI-ACCESS-SIGNATURE'] = signatureBase64;
          
          logger.debug({ message: 'Kalshi WebSocket authentication headers added' });
        } catch (signError) {
          logger.error({
            message: 'Failed to sign Kalshi WebSocket request',
            error: signError instanceof Error ? signError.message : String(signError),
          });
          // Continue without auth - might work for public channels
        }
      } else {
        logger.warn({
          message: 'Kalshi API credentials not configured - WebSocket may require authentication',
        });
      }

      this.ws = new WebSocket(KALSHI_WS_URL, {
        headers,
        handshakeTimeout: 10000,
      });

      await this.setupWebSocketHandlers();
      
      logger.info({ message: 'Kalshi WebSocket connecting...', url: KALSHI_WS_URL });
    } catch (error) {
      this.isConnecting = false;
      logger.error({
        message: 'Failed to create Kalshi WebSocket',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Set up WebSocket event handlers
   */
  private setupWebSocketHandlers(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not initialized'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 15000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        
        logger.info({ message: 'Kalshi WebSocket connected' });
        
        this.startPingPong();
        this.emit('connected');
        
        // Re-subscribe to previously subscribed tickers
        if (this.subscribedTickers.size > 0) {
          const tickers = Array.from(this.subscribedTickers);
          this.subscribedTickers.clear();
          this.subscribeToMarkets(tickers).catch(err => {
            logger.error({
              message: 'Failed to re-subscribe after reconnect',
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
        
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        this.isConnecting = false;
        this.stopPingPong();
        
        const reasonStr = reason.toString() || 'Unknown';
        logger.info({
          message: 'Kalshi WebSocket closed',
          code,
          reason: reasonStr,
        });
        
        this.emit('disconnected', code, reasonStr);
        
        // Attempt reconnection if not shutting down
        if (!this.isShuttingDown) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error: Error) => {
        clearTimeout(timeout);
        logger.error({
          message: 'Kalshi WebSocket error',
          error: error.message,
        });
        this.emit('error', error);
      });

      this.ws.on('pong', () => {
        // Clear pong timeout - connection is alive
        if (this.pongTimeout) {
          clearTimeout(this.pongTimeout);
          this.pongTimeout = null;
        }
      });
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: Buffer): void {
    try {
      const message = JSON.parse(data.toString());
      
      // Log first few messages of each type for debugging
      if (!this.messageTypesLogged.has(message.type)) {
        this.messageTypesLogged.add(message.type);
        logger.info({
          message: 'Kalshi WebSocket message type first seen',
          type: message.type,
          fullMessage: JSON.stringify(message).substring(0, 500),
        });
      }
      
      // Handle different message types
      if (message.type === 'ticker') {
        // Log every 100th ticker message to avoid spam but confirm receipt
        if (Math.random() < 0.01) {
          logger.debug({
            message: 'Kalshi ticker received (sample)',
            ticker: message.msg?.market_ticker,
            yesBid: message.msg?.yes_bid,
            yesAsk: message.msg?.yes_ask,
          });
        }
        this.emit('ticker', message as KalshiTickerMessage);
      } else if (message.type === 'subscribed') {
        logger.info({
          message: 'Kalshi subscription confirmed',
          channels: message.msg?.channels,
          tickerCount: message.msg?.market_tickers?.length,
        });
      } else if (message.type === 'error') {
        logger.error({
          message: 'Kalshi WebSocket error message',
          error: message.msg,
        });
      } else {
        // Log any unknown message types
        logger.debug({
          message: 'Kalshi WebSocket unknown message type',
          type: message.type,
        });
      }
    } catch (error) {
      logger.error({
        message: 'Failed to parse Kalshi WebSocket message',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Start ping/pong heartbeat
   */
  private startPingPong(): void {
    this.stopPingPong();
    
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
        
        // Set timeout for pong response
        this.pongTimeout = setTimeout(() => {
          logger.warn({ message: 'Kalshi WebSocket pong timeout, reconnecting' });
          this.ws?.terminate();
        }, PONG_TIMEOUT_MS);
      }
    }, PING_INTERVAL_MS);
  }

  /**
   * Stop ping/pong heartbeat
   */
  private stopPingPong(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout || this.isShuttingDown) {
      return;
    }

    this.reconnectAttempts++;
    
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      logger.error({
        message: 'Kalshi WebSocket max reconnection attempts reached',
        attempts: this.reconnectAttempts,
      });
      this.emit('error', new Error('Max reconnection attempts reached'));
      return;
    }

    const delayIndex = Math.min(this.reconnectAttempts - 1, RECONNECT_DELAYS.length - 1);
    const delay = RECONNECT_DELAYS[delayIndex];

    logger.info({
      message: 'Kalshi WebSocket scheduling reconnect',
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      try {
        await this.connect();
      } catch (error) {
        logger.error({
          message: 'Kalshi WebSocket reconnection failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, delay);
  }

  /**
   * Subscribe to market tickers for price updates
   * Batches subscriptions to respect rate limits
   */
  async subscribeToMarkets(tickers: string[]): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Queue subscriptions for when connection opens
      tickers.forEach(t => this.pendingSubscriptions.add(t));
      logger.debug({
        message: 'Kalshi WebSocket not connected, queuing subscriptions',
        count: tickers.length,
      });
      return;
    }

    // Filter out already subscribed tickers
    const newTickers = tickers.filter(t => !this.subscribedTickers.has(t));
    
    if (newTickers.length === 0) {
      return;
    }

    // Check memory guard
    const totalAfterSubscribe = this.subscribedTickers.size + newTickers.length;
    if (totalAfterSubscribe > MAX_SUBSCRIPTIONS) {
      const allowedCount = MAX_SUBSCRIPTIONS - this.subscribedTickers.size;
      const truncatedCount = newTickers.length - allowedCount;
      logger.warn({
        message: 'Kalshi subscription limit reached, truncating subscriptions',
        requested: newTickers.length,
        allowed: allowedCount,
        truncated: truncatedCount,
        currentlySubscribed: this.subscribedTickers.size,
        maxSubscriptions: MAX_SUBSCRIPTIONS,
        tip: 'Increase KALSHI_MAX_SUBSCRIPTIONS env var if needed (monitor for Kalshi API errors)',
        note: 'This is a conservative memory guard - Kalshi may allow more, but monitor for subscription errors',
      });
      newTickers.length = Math.max(0, allowedCount);
    }

    if (newTickers.length === 0) {
      return;
    }

    // Batch subscribe to avoid overwhelming Kalshi
    for (let i = 0; i < newTickers.length; i += SUBSCRIPTION_BATCH_SIZE) {
      const batch = newTickers.slice(i, i + SUBSCRIPTION_BATCH_SIZE);
      
      const command: KalshiSubscribeCommand = {
        id: this.commandId++,
        cmd: 'subscribe',
        params: {
          channels: ['ticker'],
          market_tickers: batch,
        },
      };

      try {
        this.ws.send(JSON.stringify(command));
        batch.forEach(t => this.subscribedTickers.add(t));
        
        logger.debug({
          message: 'Kalshi subscribe batch sent',
          batchSize: batch.length,
          totalSubscribed: this.subscribedTickers.size,
        });
      } catch (error) {
        logger.error({
          message: 'Failed to send Kalshi subscribe command',
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Delay between batches
      if (i + SUBSCRIPTION_BATCH_SIZE < newTickers.length) {
        await this.sleep(SUBSCRIPTION_BATCH_DELAY_MS);
      }
    }

    this.emit('subscribed', newTickers);
    
    logger.info({
      message: 'Kalshi subscribed to markets',
      newCount: newTickers.length,
      totalSubscribed: this.subscribedTickers.size,
    });
  }

  /**
   * Unsubscribe from market tickers
   */
  async unsubscribeFromMarkets(tickers: string[]): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Just remove from local tracking
      tickers.forEach(t => {
        this.subscribedTickers.delete(t);
        this.pendingSubscriptions.delete(t);
      });
      return;
    }

    const subscribedTickers = tickers.filter(t => this.subscribedTickers.has(t));
    
    if (subscribedTickers.length === 0) {
      return;
    }

    const command: KalshiUnsubscribeCommand = {
      id: this.commandId++,
      cmd: 'unsubscribe',
      params: {
        channels: ['ticker'],
        market_tickers: subscribedTickers,
      },
    };

    try {
      this.ws.send(JSON.stringify(command));
      subscribedTickers.forEach(t => this.subscribedTickers.delete(t));
      this.emit('unsubscribed', subscribedTickers);
      
      logger.info({
        message: 'Kalshi unsubscribed from markets',
        count: subscribedTickers.length,
        remaining: this.subscribedTickers.size,
      });
    } catch (error) {
      logger.error({
        message: 'Failed to send Kalshi unsubscribe command',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get current subscription count
   */
  getSubscriptionCount(): number {
    return this.subscribedTickers.size;
  }

  /**
   * Get all subscribed tickers
   */
  getSubscribedTickers(): string[] {
    return Array.from(this.subscribedTickers);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get status
   */
  getStatus(): {
    isConnected: boolean;
    isConnecting: boolean;
    subscriptionCount: number;
    reconnectAttempts: number;
  } {
    return {
      isConnected: this.isConnected(),
      isConnecting: this.isConnecting,
      subscriptionCount: this.subscribedTickers.size,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    
    // Clear timers
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.stopPingPong();

    // Close WebSocket
    if (this.ws) {
      this.ws.close(1000, 'Shutdown');
      this.ws = null;
    }

    // Clear state
    this.subscribedTickers.clear();
    this.pendingSubscriptions.clear();
    this.reconnectAttempts = 0;
    this.isConnecting = false;

    logger.info({ message: 'Kalshi WebSocket client shut down' });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton getter
export function getKalshiWebSocketClient(): KalshiWebSocketClient {
  return KalshiWebSocketClient.getInstance();
}
