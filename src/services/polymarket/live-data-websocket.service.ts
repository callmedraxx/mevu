/**
 * WebSocket client for Polymarket Live Data API
 * Connects to ws-live-data.polymarket.com to receive real-time market activity
 */

import WebSocket from 'ws';
import { logger } from '../../config/logger';
import { LiveDataOrdersMatched } from './polymarket.types';

const LIVE_DATA_WS_URL = 'wss://ws-live-data.polymarket.com/';

export interface LiveDataSubscription {
  topic: string; // e.g., "activity", "comments"
  type: string; // e.g., "orders_matched", "*"
  filters: string; // JSON string with filter criteria
}

export interface LiveDataMessage {
  connection_id?: string;
  payload?: any;
  timestamp?: number;
  topic?: string;
  type?: string;
  [key: string]: any;
}


export class LiveDataWebSocketService {
  private ws: WebSocket | null = null;
  private reconnectAttempts: number = 0;
  private isConnecting: boolean = false;
  private isConnected: boolean = false;
  private messageHistory: LiveDataMessage[] = [];
  private subscriptions: LiveDataSubscription[] = [];
  private connectionId: string | null = null;
  private maxHistorySize: number = 200;

  /**
   * Connect to the Live Data WebSocket endpoint
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.isConnected) {
      logger.warn({
        message: 'Live Data WebSocket already connecting or connected',
        isConnecting: this.isConnecting,
        isConnected: this.isConnected,
      });
      return;
    }

    // Reset state for new connection
    this.isConnecting = true;
    this.isConnected = false;
    this.reconnectAttempts = 0;

    try {
      logger.info({
        message: 'Connecting to Live Data WebSocket',
        url: LIVE_DATA_WS_URL,
      });

      this.ws = new WebSocket(LIVE_DATA_WS_URL, {
        headers: {
          'Origin': 'https://polymarket.com',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        },
      });

      this.setupEventHandlers();
    } catch (error) {
      this.isConnecting = false;
      logger.error({
        message: 'Failed to create Live Data WebSocket connection',
        error: error instanceof Error ? error.message : String(error),
      });
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
      
      logger.info({
        message: 'Live Data WebSocket connected',
        url: LIVE_DATA_WS_URL,
      });

      logger.info({
        message: 'Waiting for connection_id and ready to subscribe...',
      });
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message = this.parseMessage(data);
        this.handleMessage(message);
      } catch (error) {
        logger.error({
          message: 'Error parsing Live Data WebSocket message',
          error: error instanceof Error ? error.message : String(error),
          rawData: data.toString().substring(0, 500),
        });
      }
    });

    this.ws.on('error', (error: Error) => {
      logger.error({
        message: 'Live Data WebSocket error',
        error: error.message,
        stack: error.stack,
      });
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.isConnected = false;
      this.isConnecting = false;

      const reasonStr = reason.length > 0 ? reason.toString() : 'No reason provided';
      
      logger.warn({
        message: 'Live Data WebSocket closed',
        code,
        reason: reasonStr,
        codeMeaning: this.getCloseCodeMeaning(code),
        reconnectAttempts: this.reconnectAttempts,
      });
    });

    this.ws.on('ping', (data: Buffer) => {
      logger.debug({
        message: 'Received ping from Live Data server',
        data: data.toString(),
      });
      // Respond to ping with pong
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.pong(data);
        logger.debug({
          message: 'Sent pong response to Live Data server',
        });
      }
    });

    this.ws.on('pong', (data: Buffer) => {
      logger.debug({
        message: 'Received pong from Live Data server',
        data: data.toString(),
      });
    });
  }

  /**
   * Parse incoming WebSocket message
   */
  private parseMessage(data: WebSocket.Data): LiveDataMessage {
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
      logger.debug({
        message: 'Received PING text message from Live Data server',
      });
      // Respond with PONG
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('PONG');
        logger.debug({
          message: 'Sent PONG response to Live Data server',
        });
      }
      return {
        type: 'ping',
        raw: rawString,
      };
    }
    
    // Try to parse as JSON
    try {
      const parsed = JSON.parse(rawString);
      return parsed as LiveDataMessage;
    } catch {
      // If not JSON, return as raw string with metadata
      return {
        raw: rawString,
        rawLength: rawString.length,
        type: 'raw',
        isBinary: !/^[\x20-\x7E\s]*$/.test(rawString),
      };
    }
  }

  /**
   * Handle incoming messages
   */
  private handleMessage(message: LiveDataMessage): void {
    // Store message in history
    this.messageHistory.push(message);
    if (this.messageHistory.length > this.maxHistorySize) {
      this.messageHistory.shift();
    }

    // Extract connection_id if present
    if (message.connection_id) {
      this.connectionId = message.connection_id;
      logger.info({
        message: 'Received connection_id',
        connectionId: this.connectionId,
      });
    }

    // Log the message with details
    logger.info({
      message: 'Live Data WebSocket message received',
      topic: message.topic,
      type: message.type,
      connectionId: message.connection_id,
      hasPayload: !!message.payload,
      payloadKeys: message.payload ? Object.keys(message.payload) : [],
      timestamp: message.timestamp,
    });

    // Log payload details if it's an orders_matched event
    if (message.topic === 'activity' && message.type === 'orders_matched' && message.payload) {
      this.logOrdersMatched(message.payload as LiveDataOrdersMatched);
    }
  }

  /**
   * Log orders matched details
   */
  private logOrdersMatched(payload: LiveDataOrdersMatched): void {
    logger.info({
      message: 'Order matched',
      eventSlug: payload.eventSlug,
      title: payload.title,
      outcome: payload.outcome,
      side: payload.side,
      price: payload.price,
      size: payload.size,
      conditionId: payload.conditionId,
      asset: payload.asset,
      transactionHash: payload.transactionHash,
    });
  }

  /**
   * Send a message to the WebSocket
   */
  send(message: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn({
        message: 'Cannot send message: Live Data WebSocket not connected',
        readyState: this.ws?.readyState,
      });
      return;
    }

    const messageString = typeof message === 'string' ? message : JSON.stringify(message);
    
    logger.info({
      message: 'Sending message to Live Data WebSocket',
      messageString: messageString,
    });

    this.ws.send(messageString);
  }

  /**
   * Subscribe to topics
   */
  subscribe(subscriptions: LiveDataSubscription[]): void {
    if (!subscriptions || subscriptions.length === 0) {
      logger.warn({
        message: 'Cannot subscribe: no subscriptions provided',
      });
      return;
    }

    // Store subscriptions
    this.subscriptions = [...this.subscriptions, ...subscriptions];

    const subscribeMessage = {
      action: 'subscribe',
      subscriptions: subscriptions,
    };

    logger.info({
      message: 'Subscribing to topics',
      subscriptions: subscriptions.map(s => ({ topic: s.topic, type: s.type })),
    });

    this.send(subscribeMessage);
  }

  /**
   * Subscribe to activity (orders matched) for a specific event
   */
  subscribeToEventActivity(eventSlug: string): void {
    this.subscribe([
      {
        topic: 'activity',
        type: 'orders_matched',
        filters: JSON.stringify({ event_slug: eventSlug }),
      },
    ]);
  }

  /**
   * Subscribe to comments for a specific entity
   */
  subscribeToComments(parentEntityID: number, parentEntityType: string = 'Series'): void {
    this.subscribe([
      {
        topic: 'comments',
        type: '*',
        filters: JSON.stringify({
          parentEntityID: parentEntityID,
          parentEntityType: parentEntityType,
        }),
      },
    ]);
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (this.ws) {
      logger.info({
        message: 'Disconnecting from Live Data WebSocket',
      });
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
    this.connectionId = null;
  }

  /**
   * Get connection status
   */
  getStatus(): {
    isConnected: boolean;
    isConnecting: boolean;
    reconnectAttempts: number;
    messageCount: number;
    connectionId: string | null;
    subscriptionCount: number;
  } {
    return {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      reconnectAttempts: this.reconnectAttempts,
      messageCount: this.messageHistory.length,
      connectionId: this.connectionId,
      subscriptionCount: this.subscriptions.length,
    };
  }

  /**
   * Get message history
   */
  getMessageHistory(): LiveDataMessage[] {
    return [...this.messageHistory];
  }

  /**
   * Get orders matched messages
   */
  getOrdersMatched(): LiveDataOrdersMatched[] {
    return this.messageHistory
      .filter((msg) => msg.topic === 'activity' && msg.type === 'orders_matched' && msg.payload)
      .map((msg) => msg.payload as LiveDataOrdersMatched);
  }

  /**
   * Get messages by topic
   */
  getMessagesByTopic(topic: string): LiveDataMessage[] {
    return this.messageHistory.filter((msg) => msg.topic === topic);
  }

  /**
   * Clear message history
   */
  clearHistory(): void {
    this.messageHistory = [];
    logger.info({
      message: 'Live Data message history cleared',
    });
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
export const liveDataWebSocketService = new LiveDataWebSocketService();

