/**
 * WebSocket client for Polymarket Sports API
 * Connects to sports-api.polymarket.com to receive live game updates
 */

import WebSocket from 'ws';
import { logger } from '../../config/logger';
import { SportsGameUpdate } from './polymarket.types';

const SPORTS_WS_URL = 'wss://sports-api.polymarket.com/ws';

export interface SportsWebSocketMessage {
  type?: string;
  event?: string;
  action?: string;
  [key: string]: any;
}

export class SportsWebSocketService {
  private ws: WebSocket | null = null;
  private reconnectAttempts: number = 0;
  private isConnecting: boolean = false;
  private isConnected: boolean = false;
  private messageHistory: SportsWebSocketMessage[] = [];
  private gameUpdates: Map<number, SportsGameUpdate> = new Map(); // gameId -> latest update
  private maxHistorySize: number = 100;

  /**
   * Connect to the Sports WebSocket endpoint
   */
  async connect(): Promise<void> {
//     if (this.isConnecting || this.isConnected) {
//       logger.warn({
//         message: 'Sports WebSocket already connecting or connected',
//         isConnecting: this.isConnecting,
//         isConnected: this.isConnected,
//       });
//       return;
//     }
// 
//     // Reset state for new connection
//     this.isConnecting = true;
//     this.isConnected = false;
//     this.reconnectAttempts = 0;
// 
//     try {
//       logger.info({
//         message: 'Connecting to Sports WebSocket',
//         url: SPORTS_WS_URL,
//       });
// 
//       this.ws = new WebSocket(SPORTS_WS_URL, {
//         headers: {
//           'Origin': 'https://polymarket.com',
//           'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
//         },
//       });
// 
//       this.setupEventHandlers();
//     } catch (error) {
//       this.isConnecting = false;
//       logger.error({
//         message: 'Failed to create Sports WebSocket connection',
//         error: error instanceof Error ? error.message : String(error),
//       });
//       throw error;
//     }
  }
// 
//   /**
//    * Setup WebSocket event handlers
//    */
//   private setupEventHandlers(): void {
//     if (!this.ws) return;
// 
//     this.ws.on('open', () => {
//       this.isConnecting = false;
//       this.isConnected = true;
//       this.reconnectAttempts = 0;
// 
//       logger.info({
//         message: 'Sports WebSocket connected',
//         url: SPORTS_WS_URL,
//       });
// 
//       logger.info({
//         message: 'Waiting for initial messages from server...',
//       });
//     });
// 
//     this.ws.on('message', (data: WebSocket.Data) => {
//       try {
//         const message = this.parseMessage(data);
//         this.handleMessage(message);
//       } catch (error) {
//         logger.error({
//           message: 'Error parsing Sports WebSocket message',
//           error: error instanceof Error ? error.message : String(error),
//           rawData: data.toString().substring(0, 500),
//         });
//       }
//     });
// 
//     this.ws.on('error', (error: Error) => {
//       logger.error({
//         message: 'Sports WebSocket error',
//         error: error.message,
//         stack: error.stack,
//       });
//     });
// 
//     this.ws.on('close', (code: number, reason: Buffer) => {
//       this.isConnected = false;
//       this.isConnecting = false;
// 
//       const reasonStr = reason.length > 0 ? reason.toString() : 'No reason provided';
// 
//       logger.warn({
//         message: 'Sports WebSocket closed',
//         code,
//         reason: reasonStr,
//         codeMeaning: this.getCloseCodeMeaning(code),
//         reconnectAttempts: this.reconnectAttempts,
//       });
//     });
// 
//     this.ws.on('ping', (data: Buffer) => {
//       logger.debug({
//         message: 'Received ping from Sports server',
//         data: data.toString(),
//       });
//       // Respond to ping with pong
//       if (this.ws && this.ws.readyState === WebSocket.OPEN) {
//         this.ws.pong(data);
//         logger.debug({
//           message: 'Sent pong response to Sports server',
//         });
//       }
//     });
// 
//     this.ws.on('pong', (data: Buffer) => {
//       logger.debug({
//         message: 'Received pong from Sports server',
//         data: data.toString(),
//       });
//     });
//   }
// 
//   /**
//    * Parse incoming WebSocket message
//    */
//   private parseMessage(data: WebSocket.Data): SportsWebSocketMessage | SportsGameUpdate {
//     // Handle different data types
//     let rawString: string;
// 
//     if (Buffer.isBuffer(data)) {
//       rawString = data.toString('utf8');
//     } else if (typeof data === 'string') {
//       rawString = data;
//     } else if (data instanceof ArrayBuffer) {
//       rawString = Buffer.from(data).toString('utf8');
//     } else {
//       rawString = String(data);
//     }
// 
//     // Check if it's a PING message (text)
//     if (rawString === 'PING' || rawString.trim() === 'PING') {
//       logger.debug({
//         message: 'Received PING text message from Sports server',
//       });
//       // Respond with PONG
//       if (this.ws && this.ws.readyState === WebSocket.OPEN) {
//         this.ws.send('PONG');
//         logger.debug({
//           message: 'Sent PONG response to Sports server',
//         });
//       }
//       return {
//         type: 'ping',
//         raw: rawString,
//       };
//     }
// 
//     // Try to parse as JSON
//     try {
//       const parsed = JSON.parse(rawString);
// 
//       // Check if it's a game update (has gameId, score, etc.)
//       if (parsed && typeof parsed === 'object' && 'gameId' in parsed && 'score' in parsed) {
//         return parsed as SportsGameUpdate;
//       }
// 
//       return parsed as SportsWebSocketMessage;
//     } catch {
//       // If not JSON, return as raw string with metadata
//       return {
//         raw: rawString,
//         rawLength: rawString.length,
//         type: 'raw',
//         isBinary: !/^[\x20-\x7E\s]*$/.test(rawString),
//       };
//     }
//   }

  /**
   * Handle incoming messages
   */
  private async handleMessage(message: SportsWebSocketMessage | SportsGameUpdate): Promise<void> {
    // Check if this is a game update
    if ('gameId' in message && 'score' in message) {
      const gameUpdate = message as SportsGameUpdate;

      // logger.info({
      //   message: 'Sports game update received',
      //   gameId: gameUpdate.gameId,
      //   league: gameUpdate.leagueAbbreviation,
      //   score: gameUpdate.score,
      //   period: gameUpdate.period,
      //   elapsed: gameUpdate.elapsed,
      //   live: gameUpdate.live,
      //   ended: gameUpdate.ended,
      // });

      // Store/update game data
      this.gameUpdates.set(gameUpdate.gameId, gameUpdate);

      // Also store in general message history
      this.messageHistory.push(message as any);
      if (this.messageHistory.length > this.maxHistorySize) {
        this.messageHistory.shift();
      }

      // Update live games database using gameId
      // The gameId from WebSocket should match the gameId stored in live_games table
      try {
        const { updateGameByGameId } = await import('./live-games.service');
        await updateGameByGameId(gameUpdate.gameId, {
          score: gameUpdate.score,
          period: gameUpdate.period,
          elapsed: gameUpdate.elapsed,
          live: gameUpdate.live,
          ended: gameUpdate.ended,
          active: gameUpdate.live && !gameUpdate.ended,
          closed: gameUpdate.ended,
        });
      } catch (error) {
        // logger.warn({
        //   message: 'Error updating live game from WebSocket',
        //   error: error instanceof Error ? error.message : String(error),
        //   gameId: gameUpdate.gameId,
        // });
      }

      return;
    }

    // Handle other message types
    const msg = message as SportsWebSocketMessage;

    // Store message in history
    this.messageHistory.push(msg);
    if (this.messageHistory.length > this.maxHistorySize) {
      this.messageHistory.shift();
    }

    // Log the message
    // logger.info({
    //   message: 'Sports WebSocket message received',
    //   messageType: msg.type || msg.event || msg.action || 'unknown',
    //   fullMessage: msg,
    //   messageKeys: Object.keys(msg),
    // });
  }

  /**
   * Send a message to the WebSocket
   */
  send(message: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // logger.warn({
      //   message: 'Cannot send message: Sports WebSocket not connected',
      //   readyState: this.ws?.readyState,
      // });
      return;
    }

    const messageString = typeof message === 'string' ? message : JSON.stringify(message);

    // logger.info({
    //   message: 'Sending message to Sports WebSocket',
    //   messageString: messageString,
    // });

    this.ws.send(messageString);
  }

  /**
   * Subscribe to games (try different subscription patterns)
   */
  subscribeToGames(gameIds?: number[]): void {
    if (gameIds && gameIds.length > 0) {
      // Try subscribing to specific games
      // logger.info({
      //   message: 'Subscribing to specific games',
      //   gameIds,
      // });
      this.send({
        type: 'subscribe',
        gameIds: gameIds,
      });
    } else {
      // Try subscribing to all games
      // logger.info({
      //   message: 'Subscribing to all games',
      // });
      this.send({
        type: 'subscribe',
        games: 'all',
      });
    }
  }

  /**
   * Subscribe to a league
   */
  subscribeToLeague(league: string): void {
    // logger.info({
    //   message: 'Subscribing to league',
    //   league,
    // });
    this.send({
      type: 'subscribe',
      league: league,
    });
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (this.ws) {
      // logger.info({
      //   message: 'Disconnecting from Sports WebSocket',
      // });
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
    gameCount: number;
  } {
    return {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      reconnectAttempts: this.reconnectAttempts,
      messageCount: this.messageHistory.length,
      gameCount: this.gameUpdates.size,
    };
  }

  /**
   * Get message history
   */
  getMessageHistory(): SportsWebSocketMessage[] {
    return [...this.messageHistory];
  }

  /**
   * Get all game updates
   */
  getAllGames(): SportsGameUpdate[] {
    return Array.from(this.gameUpdates.values());
  }

  /**
   * Get game by ID
   */
  getGame(gameId: number): SportsGameUpdate | null {
    return this.gameUpdates.get(gameId) || null;
  }

  /**
   * Get games by league
   */
  getGamesByLeague(league: string): SportsGameUpdate[] {
    return Array.from(this.gameUpdates.values()).filter(
      (game) => game.leagueAbbreviation.toLowerCase() === league.toLowerCase()
    );
  }

  /**
   * Get live games only
   */
  getLiveGames(): SportsGameUpdate[] {
    return Array.from(this.gameUpdates.values()).filter((game) => game.live && !game.ended);
  }

  /**
   * Clear message history
   */
  clearHistory(): void {
    this.messageHistory = [];
    this.gameUpdates.clear();
    // logger.info({
    //   message: 'Sports message history and games cleared',
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
// 
// Export singleton instance
export const sportsWebSocketService = new SportsWebSocketService();
// 
