/**
 * WebSocket client for Polymarket CLOB subscriptions
 * Connects to ws-subscriptions-clob.polymarket.com to explore subscription protocol
 */

import WebSocket from 'ws';
import { logger } from '../../config/logger';
import { ClobOrderBookUpdate, ClobWebSocketMessage } from './polymarket.types';

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/** Interval (ms) for client-side ping to prevent idle timeout (1006) */
const PING_INTERVAL_MS = 25_000;

export class ClobWebSocketService {
  private ws: WebSocket | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 5000; // Start with 5 seconds
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private isConnecting: boolean = false;
  private isConnected: boolean = false;
  private messageHistory: ClobWebSocketMessage[] = [];
  private orderBookUpdates: ClobOrderBookUpdate[] = [];
  private maxHistorySize: number = 100;
  private maxOrderBookHistory: number = 50;
  private orderBookUpdateCallbacks: Set<(updates: ClobOrderBookUpdate[]) => void> = new Set();
  private pendingSubscriptions: string[] = []; // Store subscriptions to re-apply after reconnect

  /**
   * Connect to the CLOB WebSocket endpoint
   * Returns a Promise that resolves when the WebSocket is actually connected
   */
  async connect(): Promise<void> {
    if (this.isConnecting) {
      // Wait for existing connection attempt to complete
      return new Promise((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (this.isConnected) {
            clearInterval(checkInterval);
            resolve();
          } else if (!this.isConnecting) {
            clearInterval(checkInterval);
            reject(new Error('Connection attempt failed'));
          }
        }, 100);
        // Timeout after 30 seconds
        setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error('Connection timeout'));
        }, 30000);
      });
    }
    
    if (this.isConnected) {
      return;
    }

    // Reset state for new connection
    this.isConnecting = true;
    this.isConnected = false;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(CLOB_WS_URL, {
          headers: {
            'Origin': 'https://polymarket.com',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
          },
        });

        // Set up a one-time handler to resolve the promise when connected
        const onOpen = () => {
          this.ws?.removeListener('error', onError);
          resolve();
        };
        
        const onError = (error: Error) => {
          this.ws?.removeListener('open', onOpen);
          this.isConnecting = false;
          reject(error);
        };
        
        this.ws.once('open', onOpen);
        this.ws.once('error', onError);

        this.setupEventHandlers();
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => {
      this.isConnecting = false;
      this.isConnected = true;
      this.reconnectAttempts = 0;

      this.clearPingInterval();
      this.pingInterval = setInterval(() => this.ping(), PING_INTERVAL_MS);

      logger.info({
        message: 'CLOB WebSocket connected',
        url: CLOB_WS_URL,
      });
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = this.parseMessage(data);
        this.handleMessage(message);
      } catch (error) {
        // logger.error({
//           message: 'Error parsing WebSocket message',
//           error: error instanceof Error ? error.message : String(error),
//           rawData: data.toString().substring(0, 500), // Log first 500 chars
//         });
      }
    });

    this.ws.on('error', (error: Error) => {
      // logger.error({
//         message: 'CLOB WebSocket error',
//         error: error.message,
//         stack: error.stack,
//       });
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.clearPingInterval();
      this.isConnected = false;
      this.isConnecting = false;

      const reasonStr = reason.length > 0 ? reason.toString() : 'No reason provided';
      
      logger.warn({
        message: 'CLOB WebSocket closed',
        code,
        reason: reasonStr,
        codeMeaning: this.getCloseCodeMeaning(code),
        reconnectAttempts: this.reconnectAttempts,
      });

      // Attempt to reconnect if not a normal closure
      if (code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect();
      } else if (code === 1000) {
        logger.info({ message: 'CLOB WebSocket closed normally, not reconnecting' });
      } else {
        logger.error({ message: 'CLOB WebSocket max reconnect attempts reached', attempts: this.reconnectAttempts });
      }
    });

    this.ws.on('ping', (data: Buffer) => {
      // logger.debug({
//         message: 'Received ping from server',
//         data: data.toString(),
//       });
      // Respond to ping with pong
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.pong(data);
        // logger.debug({
//           message: 'Sent pong response to server',
//         });
      }
    });

    this.ws.on('pong', (data: Buffer) => {
      // logger.debug({
//         message: 'Received pong from server',
//         data: data.toString(),
//       });
    });
  }

  /**
   * Parse incoming WebSocket message
   */
  private parseMessage(data: WebSocket.Data): ClobWebSocketMessage | ClobOrderBookUpdate[] {
    // Handle different data types
    let rawString: string;
    
    if (Buffer.isBuffer(data)) {
      rawString = data.toString('utf8');
    } else if (typeof data === 'string') {
      rawString = data;
    } else if (data instanceof ArrayBuffer) {
      rawString = Buffer.from(data).toString('utf8');
    } else {
      rawString = String(data);
    }
    
    // Check if it's a PING message (text)
    if (rawString === 'PING' || rawString.trim() === 'PING') {
      // logger.debug({
//         message: 'Received PING text message from server',
//       });
      // Respond with PONG
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('PONG');
        // logger.debug({
//           message: 'Sent PONG response to server',
//         });
      }
      return {
        type: 'ping',
        raw: rawString,
      };
    }
    
    // Try to parse as JSON
    try {
      const parsed = JSON.parse(rawString);
      
      // Check if it's an array of order book updates
      if (Array.isArray(parsed) && parsed.length > 0) {
        const firstItem = parsed[0];
        if (firstItem && typeof firstItem === 'object' && 'market' in firstItem && 'bids' in firstItem && 'asks' in firstItem) {
          // This is an array of order book updates
          return parsed as ClobOrderBookUpdate[];
        }
      }
      
      return parsed as ClobWebSocketMessage;
    } catch {
      // If not JSON, return as raw string with metadata
      return {
        raw: rawString,
        rawLength: rawString.length,
        type: 'raw',
        isBinary: !/^[\x20-\x7E\s]*$/.test(rawString), // Check if contains non-printable chars
      };
    }
  }

  /**
   * Handle incoming messages
   */
  private handleMessage(message: ClobWebSocketMessage | ClobOrderBookUpdate[]): void {
    // Check if this is a price_change event (the format we want)
    const msg = message as any;
    if (msg && typeof msg === 'object' && msg.event_type === 'price_change' && msg.price_changes) {
      // logger.info({
      //   message: 'CLOB price_change event received',
      //   market: msg.market?.substring(0, 20) + '...',
      //   priceChangeCount: msg.price_changes.length,
      //   timestamp: msg.timestamp,
      // });

      // Notify callbacks with the price changes
      if (this.orderBookUpdateCallbacks.size > 0) {
        for (const callback of this.orderBookUpdateCallbacks) {
          try {
            // Pass the entire price_change message
            callback([msg]);
          } catch (error) {
            logger.error({
              message: 'Error in price change callback',
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      return;
    }

    // Check if this is an array of order book updates (legacy format)
    if (Array.isArray(message) && message.length > 0 && 'market' in message[0] && 'bids' in message[0]) {
      // This is an array of order book updates
      const updates = message as ClobOrderBookUpdate[];
      
      logger.info({
        message: 'CLOB order book update received',
        updateCount: updates.length,
        firstAssetId: updates[0]?.asset_id?.substring(0, 20) + '...',
      });

      // Store order book updates
      for (const update of updates) {
        this.orderBookUpdates.push(update);
        if (this.orderBookUpdates.length > this.maxOrderBookHistory) {
          this.orderBookUpdates.shift();
        }

        // Log order book summary
        this.logOrderBookSummary(update);
      }

      // Also store in general message history
      this.messageHistory.push(message as any);
      if (this.messageHistory.length > this.maxHistorySize) {
        this.messageHistory.shift();
      }

      // Notify all registered callbacks about the order book updates
      if (this.orderBookUpdateCallbacks.size > 0) {
        logger.debug({
          message: 'Calling order book update callbacks',
          callbackCount: this.orderBookUpdateCallbacks.size,
          updateCount: updates.length,
        });
        for (const callback of this.orderBookUpdateCallbacks) {
          try {
            callback(updates);
          } catch (error) {
            logger.error({
              message: 'Error in order book update callback',
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } else {
        logger.debug({
          message: 'No callbacks registered for order book updates',
          updateCount: updates.length,
        });
      }

      return;
    }

    // Handle single message object
    const singleMsg = message as ClobWebSocketMessage;
    
    // Store message in history
    this.messageHistory.push(singleMsg);
    if (this.messageHistory.length > this.maxHistorySize) {
      this.messageHistory.shift();
    }

    // Try to identify message structure
    this.analyzeMessage(singleMsg);
  }

  /**
   * Analyze message structure to understand protocol
   */
  private analyzeMessage(message: ClobWebSocketMessage): void {
    // Log specific patterns we might recognize
    if (message.type) {
      // logger.debug({
//         message: 'Message has type field',
//         type: message.type,
//       });
    }

    if (message.event) {
      // logger.debug({
//         message: 'Message has event field',
//         event: message.event,
//       });
    }

    if (message.channel) {
      // logger.debug({
//         message: 'Message has channel field',
//         channel: message.channel,
//       });
    }

    if (message.data) {
      // logger.debug({
//         message: 'Message has data field',
//         dataType: typeof message.data,
//         dataKeys: typeof message.data === 'object' && message.data !== null ? Object.keys(message.data) : null,
//       });
    }
  }

  /**
   * Send a message to the WebSocket
   */
  send(message: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // logger.warn({
//         message: 'Cannot send message: WebSocket not connected',
//         readyState: this.ws?.readyState,
//       });
      return;
    }

    const messageString = typeof message === 'string' ? message : JSON.stringify(message);
    
    // logger.info({
//       message: 'Sending message to CLOB WebSocket',
//       messageString: messageString,
//     });

    this.ws.send(messageString);
  }

  /**
   * Subscribe to market updates for specific asset IDs (clobTokenIds)
   */
  subscribeToAssets(assetIds: string[]): void {
    if (!assetIds || assetIds.length === 0) {
      return;
    }

    // Store subscriptions for reconnect
    this.pendingSubscriptions = assetIds;

    // Check if WebSocket is actually ready to send
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn({
        message: 'CLOB WebSocket not ready for subscription, will retry on reconnect',
        readyState: this.ws?.readyState,
        isConnected: this.isConnected,
        assetCount: assetIds.length,
      });
      return;
    }

    const subscriptionMessage = {
      assets_ids: assetIds,
      type: 'market',
    };

    logger.info({
      message: 'Subscribing to CLOB assets',
      count: assetIds.length,
      firstAsset: assetIds[0]?.substring(0, 20) + '...',
    });

    this.send(subscriptionMessage);
  }

  /**
   * Send PING to server (for keepalive)
   */
  ping(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // logger.debug({
//       message: 'Sending ping to server',
//     });

    this.ws.ping();
  }


  private clearPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    this.clearPingInterval();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.isConnected = false;
    this.isConnecting = false;

    // Clear reconnect timer if any
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    this.reconnectAttempts++;
    // Exponential backoff: 5s, 10s, 20s, 40s, ... up to 5 minutes max
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 300000);
    
    logger.info({
      message: 'Scheduling CLOB WebSocket reconnect',
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      
      try {
        logger.info({
          message: 'CLOB WebSocket reconnect attempt starting',
          attempt: this.reconnectAttempts,
          pendingSubscriptionCount: this.pendingSubscriptions.length,
        });
        
        await this.connect();
        
        logger.info({
          message: 'CLOB WebSocket reconnect successful',
          isConnected: this.isConnected,
          pendingSubscriptionCount: this.pendingSubscriptions.length,
        });
        
        // Re-subscribe to assets after successful reconnection
        if (this.pendingSubscriptions.length > 0) {
          // Small delay to ensure connection is stable before subscribing
          await new Promise(resolve => setTimeout(resolve, 500));
          
          logger.info({
            message: 'Re-subscribing to CLOB assets after reconnect',
            assetCount: this.pendingSubscriptions.length,
            firstAsset: this.pendingSubscriptions[0]?.substring(0, 20) + '...',
          });
          
          this.subscribeToAssets(this.pendingSubscriptions);
        } else {
          logger.warn({
            message: 'CLOB WebSocket reconnected but no pending subscriptions to restore',
          });
        }
        
        // Reset reconnect attempts on successful reconnection
        this.reconnectAttempts = 0;
      } catch (error) {
        logger.error({
          message: 'Failed to reconnect CLOB WebSocket',
          error: error instanceof Error ? error.message : String(error),
          attempt: this.reconnectAttempts,
        });
        
        // Schedule another reconnect if we haven't exceeded max attempts
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect();
        } else {
          logger.error({
            message: 'CLOB WebSocket max reconnect attempts reached, giving up',
            attempts: this.reconnectAttempts,
          });
        }
      }
    }, delay);
  }

  /**
   * Get connection status
   */
  getStatus(): {
    isConnected: boolean;
    isConnecting: boolean;
    reconnectAttempts: number;
    messageCount: number;
  } {
    return {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      reconnectAttempts: this.reconnectAttempts,
      messageCount: this.messageHistory.length,
    };
  }

  /**
   * Get message history
   */
  getMessageHistory(): ClobWebSocketMessage[] {
    return [...this.messageHistory];
  }

  /**
   * Get order book update history
   */
  getOrderBookHistory(): ClobOrderBookUpdate[] {
    return [...this.orderBookUpdates];
  }

  /**
   * Get latest order book for a specific asset
   */
  getLatestOrderBook(assetId: string): ClobOrderBookUpdate | null {
    // Find the most recent update for this asset
    for (let i = this.orderBookUpdates.length - 1; i >= 0; i--) {
      if (this.orderBookUpdates[i].asset_id === assetId) {
        return this.orderBookUpdates[i];
      }
    }
    return null;
  }

  /**
   * Log order book summary
   */
  private logOrderBookSummary(update: ClobOrderBookUpdate): void {
    const bestBid = update.bids.length > 0 ? update.bids[0] : null;
    const bestAsk = update.asks.length > 0 ? update.asks[0] : null;
    const spread = bestBid && bestAsk 
      ? (parseFloat(bestAsk.price) - parseFloat(bestBid.price)).toFixed(4)
      : null;

    // logger.info({
//       message: 'Order book summary',
//       market: update.market,
//       asset_id: update.asset_id,
//       timestamp: update.timestamp,
//       bestBid: bestBid ? { price: bestBid.price, size: bestBid.size } : null,
//       bestAsk: bestAsk ? { price: bestAsk.price, size: bestAsk.size } : null,
//       spread: spread,
//       lastTradePrice: update.last_trade_price,
//       bidCount: update.bids.length,
//       askCount: update.asks.length,
//     });
  }

  /**
   * Register callback for order book updates
   */
  onOrderBookUpdate(callback: (updates: ClobOrderBookUpdate[]) => void): void {
    this.orderBookUpdateCallbacks.add(callback);
  }

  /**
   * Unregister callback for order book updates
   */
  offOrderBookUpdate(callback: (updates: ClobOrderBookUpdate[]) => void): void {
    this.orderBookUpdateCallbacks.delete(callback);
  }

  /**
   * Clear message history
   */
  clearHistory(): void {
    this.messageHistory = [];
    // logger.info({
    //   message: 'Message history cleared',
    // });
  }

  /**
   * Get human-readable meaning of WebSocket close codes
   */
  private getCloseCodeMeaning(code: number): string {
    const codes: Record<number, string> = {
      1000: 'Normal Closure',
      1001: 'Going Away',
      1002: 'Protocol Error',
      1003: 'Unsupported Data',
      1004: 'Reserved',
      1005: 'No Status Received',
      1006: 'Abnormal Closure',
      1007: 'Invalid Frame Payload Data',
      1008: 'Policy Violation',
      1009: 'Message Too Big',
      1010: 'Mandatory Extension',
      1011: 'Internal Server Error',
      1012: 'Service Restart',
      1013: 'Try Again Later',
      1014: 'Bad Gateway',
      1015: 'TLS Handshake',
    };
    return codes[code] || `Unknown code: ${code}`;
  }
}

// Export singleton instance
export const clobWebSocketService = new ClobWebSocketService();

