/**
 * Crypto Orderbook Service
 * Runs in the CLOB background worker.
 *
 * Handles Polymarket CLOB `book` events (full bids/asks arrays) for the orderbook widget.
 * Tokens are registered on-demand via Redis (crypto:orderbook:subscribe).
 *
 * CLOB WS subscription is managed centrally by subscribeToAllGames() which includes
 * all active crypto tokens. This service only registers tokens in a local routing set
 * so incoming book events are forwarded to the correct Redis channel.
 */

import { logger } from '../../config/logger';
import { clobWebSocketService } from '../polymarket/clob-websocket.service';
import {
  subscribeToCryptoOrderbookSubscribe,
  publishCryptoOrderbookUpdate,
  CryptoOrderbookSubscribeMessage,
  CryptoOrderbookBroadcastMessage,
} from '../redis-cluster-broadcast.service';

export class CryptoOrderbookService {
  // Set of clobTokenIds we're routing book events for
  private registeredTokens: Set<string> = new Set();
  private redisUnsubscribe: (() => void) | null = null;
  private isInitialized: boolean = false;

  initialize(): void {
    if (this.isInitialized) return;
    this.isInitialized = true;

    // Register callback for all CLOB events
    clobWebSocketService.onOrderBookUpdate((updates: any[]) => {
      // book events: updates[0] has bids/asks (no event_type === 'price_change')
      if (updates.length === 0) return;
      const first = updates[0];
      // Distinguish from price_change events which come as [priceChangeMsgObject]
      if (first?.event_type === 'price_change') return;
      if (!first?.bids || !first?.asks) return;

      // Each element in updates is a ClobOrderBookUpdate
      for (const bookUpdate of updates) {
        if (!this.registeredTokens.has(bookUpdate.asset_id)) continue;

        logger.debug({
          message: 'Crypto orderbook: book event for registered token',
          clobTokenId: bookUpdate.asset_id?.substring(0, 20) + '...',
          bidCount: bookUpdate.bids?.length || 0,
          askCount: bookUpdate.asks?.length || 0,
          lastTradePrice: bookUpdate.last_trade_price,
        });

        const message: CryptoOrderbookBroadcastMessage = {
          type: 'orderbook_update',
          clobTokenId: bookUpdate.asset_id,
          conditionId: bookUpdate.market || '',
          bids: bookUpdate.bids || [],
          asks: bookUpdate.asks || [],
          lastTradePrice: bookUpdate.last_trade_price ?? null,
          timestamp: Date.now(),
        };

        publishCryptoOrderbookUpdate(message);
      }
    });

    // Subscribe to Redis for token registration requests from HTTP workers
    this.redisUnsubscribe = subscribeToCryptoOrderbookSubscribe(
      (msg: CryptoOrderbookSubscribeMessage) => {
        this.registerToken(msg.clobTokenId);
      }
    );

    logger.info({ message: 'Crypto orderbook service initialized' });
  }

  /**
   * Register a clobTokenId for orderbook event routing (local map only).
   * The token is already subscribed on the CLOB WS via subscribeToAllGames().
   */
  private registerToken(clobTokenId: string): void {
    if (!clobTokenId) return;

    const isNew = !this.registeredTokens.has(clobTokenId);
    this.registeredTokens.add(clobTokenId);

    if (isNew) {
      clobWebSocketService.noteTokenRegistrationForDiagnostics([clobTokenId]);
      logger.info({
        message: 'Crypto orderbook: registered token for routing',
        clobTokenId: clobTokenId.substring(0, 20) + '...',
        totalOrderbookTokens: this.registeredTokens.size,
      });
    }
  }

  getStatus() {
    return {
      isInitialized: this.isInitialized,
      registeredTokens: this.registeredTokens.size,
    };
  }

  shutdown(): void {
    if (this.redisUnsubscribe) {
      this.redisUnsubscribe();
      this.redisUnsubscribe = null;
    }
    this.registeredTokens.clear();
    this.isInitialized = false;
    logger.info({ message: 'Crypto orderbook service shut down' });
  }
}

export const cryptoOrderbookService = new CryptoOrderbookService();
