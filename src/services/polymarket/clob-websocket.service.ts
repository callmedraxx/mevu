/**
 * WebSocket client for Polymarket CLOB subscriptions
 * Connects to ws-subscriptions-clob.polymarket.com to explore subscription protocol
 */

import WebSocket from 'ws';
import { logger } from '../../config/logger';
import { ClobOrderBookUpdate, ClobWebSocketMessage } from './polymarket.types';

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/** Polymarket requires text "PING" every 10s — see docs.polymarket.com CLOB WebSocket */
const PING_INTERVAL_MS = 10_000;

/**
 * Polymarket enforces an undocumented limit of ~500 instruments per WebSocket connection.
 * Beyond 500, initial snapshots are skipped and updates become unreliable.
 * We shard subscriptions across multiple connections, each handling ≤ MAX_ASSETS_PER_CONNECTION.
 */
const MAX_ASSETS_PER_CONNECTION = 500;

/** Represents one WebSocket connection and its assigned assets */
interface WsShard {
  ws: WebSocket;
  assets: string[];
  pingInterval: NodeJS.Timeout | null;
  reconnectTimer: NodeJS.Timeout | null;
  isConnected: boolean;
  destroyed: boolean;
  shardIndex: number;
  connectedAt: number; // timestamp for uptime diagnostics
  /** Consecutive rapid-failure count; reset when connection was stable (>10s) before close */
  rapidFailureCount: number;
}

/** If connection was stable this long before close, treat next disconnect as fresh (use short delay) */
const SHARD_STABLE_UPTIME_MS = 10_000;

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
  private addAssetsTimer: NodeJS.Timeout | null = null;
  /** Additional WebSocket connections for assets beyond the first 500 */
  private shards: WsShard[] = [];
  /** Recently registered tokens (for diagnostics: correlate shard closes with new market visits) */
  private recentlyRegisteredTokens: Map<string, number> = new Map();
  private static readonly RECENT_TOKEN_TTL_MS = 60_000;

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
      logger.error({
        message: 'CLOB WebSocket error',
        error: error.message,
      });
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
      // logger.debug({
      //   message: 'CLOB price_change event received',
      //   market: msg.market?.substring(0, 20) + '...',
      //   priceChangeCount: msg.price_changes.length,
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

    // Check if this is an array of order book updates
    if (Array.isArray(message) && message.length > 0 && 'market' in message[0] && 'bids' in message[0]) {
      // This is an array of order book updates
      const updates = message as ClobOrderBookUpdate[];
      this.processBookUpdates(updates);
      return;
    }

    // Check if this is a SINGLE book object (event_type: 'book') — Polymarket can send
    // book events as individual objects instead of arrays
    if (msg && !Array.isArray(msg) && msg.event_type === 'book' && msg.bids && msg.asks && msg.asset_id) {
      this.processBookUpdates([msg as ClobOrderBookUpdate]);
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
   * Centralized handler for book updates (array or single-object form).
   */
  private processBookUpdates(updates: ClobOrderBookUpdate[]): void {
    logger.debug({
      message: 'CLOB book event',
      updateCount: updates.length,
      assetId: updates[0]?.asset_id?.substring(0, 20) + '...',
      eventType: updates[0]?.event_type,
    });

    // Store order book updates
    for (const update of updates) {
      this.orderBookUpdates.push(update);
      if (this.orderBookUpdates.length > this.maxOrderBookHistory) {
        this.orderBookUpdates.shift();
      }
      this.logOrderBookSummary(update);
    }

    this.messageHistory.push(updates as any);
    if (this.messageHistory.length > this.maxHistorySize) {
      this.messageHistory.shift();
    }

    // Notify all registered callbacks about the order book updates
    if (this.orderBookUpdateCallbacks.size > 0) {
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
    }
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
   * Subscribe to market updates for specific asset IDs (clobTokenIds).
   * Merges with existing pendingSubscriptions so crypto tokens registered before CLOB connect
   * are preserved when sports subscribeToAllGames runs.
   */
  subscribeToAssets(assetIds: string[]): void {
    if (!assetIds || assetIds.length === 0) {
      return;
    }

    // Merge with existing (e.g. crypto tokens added before CLOB connected)
    const existing = new Set(this.pendingSubscriptions);
    const merged = [...this.pendingSubscriptions, ...assetIds.filter((id) => !existing.has(id))];
    this.pendingSubscriptions = merged;

    // Check if primary WebSocket is actually ready to send
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn({
        message: 'CLOB WebSocket not ready for subscription, will retry on reconnect',
        readyState: this.ws?.readyState,
        isConnected: this.isConnected,
        assetCount: this.pendingSubscriptions.length,
      });
      return;
    }

    logger.info({
      message: 'Subscribing to CLOB assets',
      count: this.pendingSubscriptions.length,
      firstAsset: this.pendingSubscriptions[0]?.substring(0, 20) + '...',
    });

    this.distributeSubscriptions(this.pendingSubscriptions);
  }

  /**
   * Distribute assets across the primary WS and shard connections.
   * Polymarket limits each connection to ~500 instruments.
   * The primary `this.ws` gets the first chunk; additional chunks get their own connections.
   */
  private async distributeSubscriptions(allAssets: string[]): Promise<void> {
    // Close existing shards before redistributing
    this.closeShards();

    const chunks: string[][] = [];
    for (let i = 0; i < allAssets.length; i += MAX_ASSETS_PER_CONNECTION) {
      chunks.push(allAssets.slice(i, i + MAX_ASSETS_PER_CONNECTION));
    }

    logger.info({
      message: 'Distributing CLOB subscriptions across connections',
      totalAssets: allAssets.length,
      connectionCount: chunks.length,
      assetsPerConnection: MAX_ASSETS_PER_CONNECTION,
    });

    // First chunk goes to the primary connection
    if (chunks.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({
        assets_ids: chunks[0],
        type: 'market',
      });
      logger.info({
        message: 'CLOB primary connection subscribed',
        assets: chunks[0].length,
      });
    }

    // Remaining chunks each get a new shard connection
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const shard = await this.createShard(chunk, i);
        this.shards.push(shard);
      } catch (err) {
        logger.error({
          message: `Failed to create CLOB shard connection ${i}`,
          error: err instanceof Error ? err.message : String(err),
          assets: chunk.length,
        });
      }
    }

    logger.info({
      message: 'CLOB subscription distribution complete',
      totalAssets: allAssets.length,
      primaryAssets: chunks[0]?.length ?? 0,
      shardCount: this.shards.length,
    });
  }

  /** Max rapid reconnects before backing off; only applies when connection died within 10s of connect */
  private static readonly SHARD_MAX_RECONNECT = 5;
  private static readonly SHARD_RECONNECT_BASE_MS = 3000;

  /**
   * Create a shard WebSocket connection for a chunk of assets.
   * Reuses the same message handling pipeline as the primary connection.
   * Reconnects on abnormal closure. Stable disconnects (uptime >10s) always retry; rapid failures use exponential backoff and a 60s cooldown after 5 attempts.
   */
  private createShard(assets: string[], shardIndex: number): Promise<WsShard> {
    const shard: WsShard = {
      ws: null as any,
      assets,
      pingInterval: null,
      reconnectTimer: null,
      isConnected: false,
      destroyed: false,
      shardIndex,
      connectedAt: 0,
      rapidFailureCount: 0,
    };

    const connectShard = (attempt: number = 0): Promise<void> => {
      return new Promise((resolve, reject) => {
        if (shard.destroyed) return resolve();

        const ws = new WebSocket(CLOB_WS_URL, {
          headers: {
            'Origin': 'https://polymarket.com',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
          },
        });

        shard.ws = ws;

        const timeout = setTimeout(() => {
          ws.removeAllListeners();
          try { ws.close(); } catch {}
          reject(new Error(`Shard ${shardIndex} connection timeout`));
        }, 15000);

        ws.once('open', () => {
          clearTimeout(timeout);
          shard.isConnected = true;
          shard.connectedAt = Date.now();

          // Start ping keepalive — Polymarket expects text "PING", not ws.ping()
          if (shard.pingInterval) clearInterval(shard.pingInterval);
          shard.pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send('PING');
          }, PING_INTERVAL_MS);

          // Subscribe to this shard's assets
          ws.send(JSON.stringify({ assets_ids: assets, type: 'market' }));

          logger.info({
            message: `CLOB shard ${shardIndex} connected and subscribed`,
            assets: assets.length,
            attempt,
          });

          resolve();
        });

        ws.on('message', (data: WebSocket.Data) => {
          try {
            // Handle text PING on the shard's own WS (parseMessage would
            // incorrectly respond via this.ws — the primary connection)
            const raw = Buffer.isBuffer(data) ? data.toString('utf8') : typeof data === 'string' ? data : String(data);
            if (raw === 'PING' || raw.trim() === 'PING') {
              if (ws.readyState === WebSocket.OPEN) ws.send('PONG');
              return;
            }
            const message = this.parseMessage(data);
            this.handleMessage(message);
          } catch {}
        });

        ws.on('error', (error: Error) => {
          logger.error({ message: `CLOB shard ${shardIndex} error`, error: error.message });
        });

        ws.on('close', (code: number) => {
          shard.isConnected = false;
          if (shard.pingInterval) { clearInterval(shard.pingInterval); shard.pingInterval = null; }

          if (code === 1000 || shard.destroyed) return;

          const uptimeMs = shard.connectedAt > 0 ? Date.now() - shard.connectedAt : 0;
          const uptimeSec = Math.round(uptimeMs / 1000);
          const now = Date.now();
          const recentOverlap = assets.filter((a) => {
            const t = this.recentlyRegisteredTokens.get(a);
            return t != null && now - t < ClobWebSocketService.RECENT_TOKEN_TTL_MS;
          });
          logger.warn({
            message: `CLOB shard ${shardIndex} closed, will reconnect`,
            code,
            codeMeaning: code === 1006 ? 'Abnormal closure (remote closed without close frame)' : undefined,
            assets: assets.length,
            uptimeSec,
            uptimeMin: uptimeSec >= 60 ? (uptimeSec / 60).toFixed(1) : undefined,
            ...(recentOverlap.length > 0 && {
              recentlyRegisteredTokenOnShard: true,
              overlapCount: recentOverlap.length,
              sample: recentOverlap[0]?.substring(0, 20) + '...',
            }),
          });

          // Reset rapid-failure count if connection was stable; otherwise use exponential backoff
          const wasStable = uptimeMs >= SHARD_STABLE_UPTIME_MS;
          if (wasStable) {
            shard.rapidFailureCount = 0;
          }
          const nextAttempt = shard.rapidFailureCount + 1;
          shard.rapidFailureCount = nextAttempt;

          // Max reconnect limit only applies to rapid failures; stable disconnects always retry
          const exceededRapidLimit = !wasStable && nextAttempt > ClobWebSocketService.SHARD_MAX_RECONNECT;
          if (exceededRapidLimit) {
            logger.error({
              message: `CLOB shard ${shardIndex} max rapid-reconnect attempts reached, will retry after 60s`,
              attempts: nextAttempt,
            });
            shard.rapidFailureCount = 0; // Reset so next attempt gets short delay
            shard.reconnectTimer = setTimeout(() => {
              shard.reconnectTimer = null;
              if (!shard.destroyed) {
                connectShard(1).catch((err) => {
                  logger.error({ message: `CLOB shard ${shardIndex} reconnect failed`, error: err instanceof Error ? err.message : String(err) });
                });
              }
            }, 60_000); // Wait 60s before retrying after rapid failure exhaustion
          } else {
            const delay = ClobWebSocketService.SHARD_RECONNECT_BASE_MS * Math.pow(2, Math.min(nextAttempt - 1, 4));
            logger.info({
              message: `Scheduling CLOB shard ${shardIndex} reconnect`,
              attempt: nextAttempt,
              delayMs: delay,
              rapidFailure: !wasStable,
            });
            shard.reconnectTimer = setTimeout(() => {
              shard.reconnectTimer = null;
              if (!shard.destroyed) {
                connectShard(nextAttempt).catch((err) => {
                  logger.error({ message: `CLOB shard ${shardIndex} reconnect failed`, error: err instanceof Error ? err.message : String(err) });
                });
              }
            }, delay);
          }
        });

        ws.on('ping', (data: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) ws.pong(data);
        });

        ws.once('error', (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
    };

    return connectShard(0).then(() => shard);
  }

  /** Close all shard connections and clear the list */
  private closeShards(): void {
    for (const shard of this.shards) {
      shard.destroyed = true;
      if (shard.pingInterval) { clearInterval(shard.pingInterval); shard.pingInterval = null; }
      if (shard.reconnectTimer) { clearTimeout(shard.reconnectTimer); shard.reconnectTimer = null; }
      if (shard.ws) {
        shard.ws.removeAllListeners();
        try { shard.ws.close(1000, 'Shard closing'); } catch {}
      }
    }
    if (this.shards.length > 0) {
      logger.info({ message: 'Closed CLOB shard connections', count: this.shards.length });
    }
    this.shards = [];
  }

  /**
   * Replace the full subscription list (prunes stale tokens from ended games).
   * Called during full game refreshes where we have the authoritative list of active assets.
   * Triggers a reconnect if the list changed.
   */
  replaceSubscriptions(assetIds: string[]): void {
    if (!assetIds || assetIds.length === 0) return;

    const oldSize = this.pendingSubscriptions.length;
    const oldSet = new Set(this.pendingSubscriptions);
    const newSet = new Set(assetIds);

    // Check if the list actually changed
    const added = assetIds.filter(id => !oldSet.has(id));
    const removed = [...oldSet].filter(id => !newSet.has(id));

    if (added.length === 0 && removed.length === 0) {
      logger.debug({
        message: 'CLOB replaceSubscriptions: no change, skipping forceReconnect',
        assetCount: assetIds.length,
      });
      return; // No change
    }

    this.pendingSubscriptions = assetIds;

    logger.info({
      message: 'CLOB subscriptions replaced (pruned stale tokens), triggering forceReconnect',
      oldCount: oldSize,
      newCount: assetIds.length,
      added: added.length,
      removed: removed.length,
    });

    // Reconnect to apply new subscription list
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (this.addAssetsTimer) {
        clearTimeout(this.addAssetsTimer);
        this.addAssetsTimer = null;
      }
      this.addAssetsTimer = setTimeout(() => {
        this.addAssetsTimer = null;
        this.forceReconnect();
      }, 200);
    }
  }

  /**
   * Send PING to server (for keepalive).
   * Polymarket expects text "PING" every 10s, not ws.ping() — see docs.polymarket.com CLOB WebSocket.
   */
  ping(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send('PING');
  }

  /**
   * Note token registration for diagnostics. Called when a user subscribes to a new crypto/finance market.
   * When a shard closes, we check if it handled recently-registered tokens (correlates with "new market visit → shard disconnect").
   */
  noteTokenRegistrationForDiagnostics(tokenIds: string[]): void {
    if (!tokenIds?.length) return;
    const now = Date.now();
    const cutoff = now - ClobWebSocketService.RECENT_TOKEN_TTL_MS;
    for (const id of tokenIds) {
      if (id) this.recentlyRegisteredTokens.set(id, now);
    }
    // Prune old entries
    for (const [id, t] of this.recentlyRegisteredTokens) {
      if (t < cutoff) this.recentlyRegisteredTokens.delete(id);
    }
    if (this.recentlyRegisteredTokens.size > 100) {
      const entries = Array.from(this.recentlyRegisteredTokens.entries()).sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < entries.length - 50; i++) {
        this.recentlyRegisteredTokens.delete(entries[i][0]);
      }
    }
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
    this.closeShards();
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
    if (this.addAssetsTimer) {
      clearTimeout(this.addAssetsTimer);
      this.addAssetsTimer = null;
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
   * Add assets to the pending subscription list (passive merge, no reconnect).
   *
   * The CLOB WS subscription is managed centrally by subscribeToAllGames() which
   * calls replaceSubscriptions() with the authoritative list. This method only
   * merges tokens into pendingSubscriptions so they survive the next reconnect.
   * New tokens will be picked up on the next scheduled refresh cycle.
   */
  addAssets(assetIds: string[]): void {
    if (!assetIds || assetIds.length === 0) return;

    const existing = new Set(this.pendingSubscriptions);
    const newAssets = assetIds.filter((id) => !existing.has(id));
    if (newAssets.length === 0) return;

    this.pendingSubscriptions = [...this.pendingSubscriptions, ...newAssets];
  }

  /**
   * Force a reconnect to re-subscribe with updated pendingSubscriptions.
   *
   * Uses a **close-then-open** strategy to prevent duplicate connections to
   * Polymarket (which can cause the server to drop the newer connection with 1006).
   * The brief sub-second gap is acceptable — downstream services dedup and
   * the next price event re-syncs state.
   */
  private async forceReconnect(): Promise<void> {
    logger.info({
      message: 'CLOB WS: reconnect for updated subscriptions',
      totalAssets: this.pendingSubscriptions.length,
    });

    // Close all shard connections (they'll be recreated after reconnect)
    this.closeShards();

    // 1. Close old connection first to avoid duplicate connections
    const oldWs = this.ws;
    const oldPingInterval = this.pingInterval;

    if (oldWs) {
      oldWs.removeAllListeners();
      try { oldWs.close(1000, 'Reconnecting with updated subscriptions'); } catch {}
    }
    if (oldPingInterval) {
      clearInterval(oldPingInterval);
    }

    // 2. Reset instance state so connect() creates a fresh connection
    this.ws = null;
    this.pingInterval = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;

    try {
      // 3. Open new connection
      await this.connect();

      // 4. Subscribe with the complete token list
      if (this.pendingSubscriptions.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 300));
        logger.info({
          message: 'CLOB WS: subscribing on new connection',
          assetCount: this.pendingSubscriptions.length,
        });
        this.subscribeToAssets(this.pendingSubscriptions);
      }

      logger.info({
        message: 'CLOB WS: reconnect complete',
        totalAssets: this.pendingSubscriptions.length,
      });
    } catch (error) {
      logger.error({
        message: 'CLOB WS: reconnect failed, scheduling retry',
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect();
    }
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

