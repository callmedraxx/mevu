/**
 * Crypto Orderbook Service
 * Runs in the CLOB background worker.
 *
 * Handles Polymarket CLOB `book` events (full bids/asks arrays) for the orderbook widget.
 * Tokens are registered on-demand via Redis (crypto:orderbook:subscribe).
 *
 * Deduplication: addAssets() checks pendingSubscriptions, so a token already subscribed
 * (e.g. for crypto price updates) will NOT trigger a second CLOB subscription message.
 * Both this service and cryptoClobPriceService register independent callbacks on the
 * shared clobWebSocketService, so each gets all messages and filters for its type.
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
   * Register a clobTokenId for orderbook event routing.
   * Calls addAssets() which deduplicates at the CLOB WS level — if the token is
   * already subscribed (for price updates or a prior orderbook request), no
   * duplicate CLOB subscription message is sent.
   */
  private registerToken(clobTokenId: string): void {
    if (!clobTokenId) return;

    const isNew = !this.registeredTokens.has(clobTokenId);
    this.registeredTokens.add(clobTokenId);

    // addAssets() internally checks pendingSubscriptions — safe to call even if
    // the token was already subscribed by cryptoClobPriceService.
    if (isNew) {
      clobWebSocketService.addAssets([clobTokenId]);
      logger.info({
        message: 'Crypto orderbook: registered token',
        clobTokenId: clobTokenId.substring(0, 20) + '...',
        totalOrderbookTokens: this.registeredTokens.size,
      });
    }
    // If not new, the token is already subscribed and events already flow — no-op.
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
