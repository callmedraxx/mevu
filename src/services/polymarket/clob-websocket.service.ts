/**
 * WebSocket client for Polymarket CLOB subscriptions
 * Connects to ws-subscriptions-clob.polymarket.com to explore subscription protocol
 */

import WebSocket from 'ws';
import { logger } from '../../config/logger';
import { ClobOrderBookUpdate, ClobWebSocketMessage } from './polymarket.types';

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

export class ClobWebSocketService {
  private ws: WebSocket | null = null;
  private reconnectAttempts: number = 0;
  private isConnecting: boolean = false;
  private isConnected: boolean = false;
  private messageHistory: ClobWebSocketMessage[] = [];
  private orderBookUpdates: ClobOrderBookUpdate[] = [];
  private maxHistorySize: number = 100;
  private maxOrderBookHistory: number = 50;
  private orderBookUpdateCallbacks: Set<(updates: ClobOrderBookUpdate[]) => void> = new Set();

  /**
   * Connect to the CLOB WebSocket endpoint
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.isConnected) {
      // logger.warn({
//         message: 'WebSocket already connecting or connected',
//         isConnecting: this.isConnecting,
//         isConnected: this.isConnected,
//       });
      return;
    }

    // Reset state for new connection
    this.isConnecting = true;
    this.isConnected = false;
    this.reconnectAttempts = 0;

    try {
      // logger.info({
//         message: 'Connecting to CLOB WebSocket',
//         url: CLOB_WS_URL,
//       });

      this.ws = new WebSocket(CLOB_WS_URL, {
        headers: {
          'Origin': 'https://polymarket.com',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        },
      });

      this.setupEventHandlers();
    } catch (error) {
      this.isConnecting = false;
      // logger.error({
//         message: 'Failed to create WebSocket connection',
//         error: error instanceof Error ? error.message : String(error),
//       });
      throw error;
    }
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
      
      // logger.info({
//         message: 'CLOB WebSocket connected',
//         url: CLOB_WS_URL,
//       });

      // Log that we're ready to receive messages
      // logger.info({
//         message: 'Waiting for initial messages from server...',
//       });
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
      this.isConnected = false;
      this.isConnecting = false;

      const reasonStr = reason.length > 0 ? reason.toString() : 'No reason provided';
      
      // logger.warn({
//         message: 'CLOB WebSocket closed',
//         code,
//         reason: reasonStr,
//         codeMeaning: this.getCloseCodeMeaning(code),
//         reconnectAttempts: this.reconnectAttempts,
//       });

      // Don't auto-reconnect during testing - let the test script handle it
      // Attempt to reconnect if not a normal closure
      // if (code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
      //   this.scheduleReconnect();
      // }
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
    // Check if this is an array of order book updates
    if (Array.isArray(message) && message.length > 0 && 'market' in message[0] && 'bids' in message[0]) {
      // This is an array of order book updates
      const updates = message as ClobOrderBookUpdate[];
      
      // logger.info({
//         message: 'CLOB order book update received',
//         updateCount: updates.length,
//         markets: updates.map(u => ({ market: u.market, asset_id: u.asset_id })),
//       });

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

      return;
    }

    // Handle single message object
    const msg = message as ClobWebSocketMessage;
    
    // Store message in history
    this.messageHistory.push(msg);
    if (this.messageHistory.length > this.maxHistorySize) {
      this.messageHistory.shift();
    }

    // Log the message with full details
    // logger.info({
//       message: 'CLOB WebSocket message received',
//       messageType: msg.type || msg.event || msg.channel || 'unknown',
//       fullMessage: msg,
//       messageKeys: Object.keys(msg),
//     });

    // Try to identify message structure
    this.analyzeMessage(msg);
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
      // logger.warn({
//         message: 'Cannot subscribe: no asset IDs provided',
//       });
      return;
    }

    const subscriptionMessage = {
      assets_ids: assetIds,
      type: 'market',
    };

    // logger.info({
//       message: 'Subscribing to assets',
//       assetIds,
//       count: assetIds.length,
//     });

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


  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (this.ws) {
      // logger.info({
//         message: 'Disconnecting from CLOB WebSocket',
//       });
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
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

