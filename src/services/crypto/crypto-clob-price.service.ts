/**
 * Crypto CLOB Price Service
 * Runs in the CLOB background worker.
 *
 * Responsibilities:
 * 1. Listens on Redis (crypto:clob:subscribe) for token registrations from HTTP workers.
 *    When a user opens a crypto short-term detail page, the HTTP worker publishes
 *    { slug, upClobTokenId, downClobTokenId } so this service subscribes those tokens.
 * 2. Uses clobWebSocketService.addAssets() to subscribe incrementally (no full replace).
 * 3. On price_change events from CLOB WS, extracts prices for registered tokens,
 *    publishes to Redis (crypto:prices) immediately for real-time frontend delivery,
 *    and queues a bulk DB flush to crypto_markets.markets[0].outcomePrices.
 */

import { logger } from '../../config/logger';
import { clobWebSocketService } from '../polymarket/clob-websocket.service';
import { connectWithRetry } from '../../config/database';
import {
  subscribeToCryptoClobSubscribe,
  publishCryptoPriceUpdate,
  CryptoClobSubscribeMessage,
  CryptoPriceBroadcastMessage,
} from '../redis-cluster-broadcast.service';

interface TokenMapping {
  slug: string;
  outcomeLabel: 'up' | 'down';
  outcomeIndex: number; // 0 = up, 1 = down
}

export class CryptoClobPriceService {
  // token_id -> { slug, outcomeLabel, outcomeIndex }
  private tokenToSlug: Map<string, TokenMapping> = new Map();
  // slug -> { upClobTokenId, downClobTokenId }
  private slugToTokens: Map<string, { upClobTokenId: string; downClobTokenId: string }> = new Map();

  // Pending DB writes: slug -> latest known prices (always both sides from lastKnownPrices)
  private pendingDbWrites: Map<string, { upPrice: number; downPrice: number }> = new Map();
  private dbFlushTimer: NodeJS.Timeout | null = null;
  private isFlushingDb: boolean = false;
  private readonly DB_FLUSH_INTERVAL_MS = 2000;

  private redisUnsubscribe: (() => void) | null = null;
  private isInitialized: boolean = false;
  private diagnosticTimer: NodeJS.Timeout | null = null;
  private matchCount: number = 0;
  private missCount: number = 0;

  // Dedup per token: only publish to Redis when best_bid actually changes
  private lastPublishedByToken: Map<string, number> = new Map();
  // Last known prices per slug for DB writes (merges partial updates)
  private lastKnownPrices: Map<string, { upPrice: number; downPrice: number }> = new Map();

  initialize(): void {
    if (this.isInitialized) return;
    this.isInitialized = true;

    // Register callback for CLOB price_change events
    clobWebSocketService.onOrderBookUpdate((updates: any[]) => {
      for (const update of updates) {
        if (update.event_type === 'price_change' && Array.isArray(update.price_changes)) {
          // Check if any crypto tokens are in this price_change
          const matchingTokens = update.price_changes.filter(
            (pc: any) => this.tokenToSlug.has(pc.asset_id)
          );
          if (matchingTokens.length > 0) {
            this.matchCount++;
          } else {
            this.missCount++;
          }
          this.handlePriceChange(update.price_changes);
        }
      }
    });

    // Subscribe to Redis for new token registrations from HTTP workers
    this.redisUnsubscribe = subscribeToCryptoClobSubscribe((msg: CryptoClobSubscribeMessage) => {
      this.registerTokens(msg);
    });

    // Periodic diagnostic: log tracked tokens and match rate
    // this.diagnosticTimer = setInterval(() => {
    //   if (this.tokenToSlug.size === 0) return;
    //   const trackedTokenPrefixes = Array.from(this.tokenToSlug.keys()).map(t => t.substring(0, 20) + '...');
    //   const trackedSlugs = Array.from(this.slugToTokens.keys());
    //   logger.info({
    //     message: 'Crypto CLOB diagnostic',
    //     trackedTokenCount: this.tokenToSlug.size,
    //     trackedSlugs,
    //     trackedTokenPrefixes,
    //     matchCount: this.matchCount,
    //     missCount: this.missCount,
    //   });
    //   this.matchCount = 0;
    //   this.missCount = 0;
    // }, 30000);

    logger.info({ message: 'Crypto CLOB price service initialized' });
  }

  /**
   * Register a crypto market's outcome tokens for CLOB subscription.
   * Called when an HTTP worker forwards a frontend client's subscribe request.
   */
  private registerTokens(msg: CryptoClobSubscribeMessage): void {
    const { slug, upClobTokenId, downClobTokenId } = msg;
    if (!slug || !upClobTokenId) return;

    const newTokens: string[] = [];

    if (!this.tokenToSlug.has(upClobTokenId)) {
      this.tokenToSlug.set(upClobTokenId, { slug, outcomeLabel: 'up', outcomeIndex: 0 });
      newTokens.push(upClobTokenId);
    }

    if (downClobTokenId && !this.tokenToSlug.has(downClobTokenId)) {
      this.tokenToSlug.set(downClobTokenId, { slug, outcomeLabel: 'down', outcomeIndex: 1 });
      newTokens.push(downClobTokenId);
    }

    // Always refresh slug -> tokens mapping (idempotent)
    this.slugToTokens.set(slug, {
      upClobTokenId,
      downClobTokenId: downClobTokenId || '',
    });

    if (newTokens.length > 0) {
      // addAssets merges without replacing existing sports subscriptions
      clobWebSocketService.addAssets(newTokens);
      logger.info({
        message: 'Crypto CLOB: registered new tokens',
        slug,
        newTokenCount: newTokens.length,
        totalCryptoTokens: this.tokenToSlug.size,
        upToken: upClobTokenId.substring(0, 30) + '...',
        downToken: (downClobTokenId || 'none').substring(0, 30) + '...',
      });
    } else {
      logger.info({
        message: 'Crypto CLOB: tokens already registered (idempotent)',
        slug,
        totalCryptoTokens: this.tokenToSlug.size,
      });
    }
  }

  /**
   * Handle price_change events from CLOB WebSocket.
   * Only processes tokens registered by registerTokens().
   *
   * Uses best_bid (NOT last trade price) per token. Each token's price is
   * published independently — the frontend matches clobTokenId to the correct
   * Up/Down button. No derivation (100 - price) is ever performed.
   *
   * The `price` field from CLOB is just the last trade price and can land
   * anywhere in the order book; using it caused wild oscillations (e.g. 8→92→53).
   * best_bid represents what buyers are willing to pay = the market's consensus.
   */
  private handlePriceChange(priceChanges: any[]): void {
    const now = Date.now();
    let needsDbFlush = false;

    for (const change of priceChanges) {
      const mapping = this.tokenToSlug.get(change.asset_id);
      if (!mapping) continue;

      const { slug, outcomeLabel } = mapping;

      // Use best_bid for price (what buyers will pay = market consensus)
      const bestBid = parseFloat(change.best_bid);
      if (isNaN(bestBid) || bestBid <= 0 || bestBid >= 1) continue;

      const priceInCents = Math.round(bestBid * 100);
      if (priceInCents <= 0 || priceInCents >= 100) continue;

      // Dedup: skip if this token's price hasn't changed
      const lastPrice = this.lastPublishedByToken.get(change.asset_id);
      if (lastPrice === priceInCents) continue;
      this.lastPublishedByToken.set(change.asset_id, priceInCents);

      // Publish per-token update — frontend matches clobTokenId to the button
      const message: CryptoPriceBroadcastMessage = {
        type: 'crypto_price_update',
        slug,
        clobTokenId: change.asset_id,
        price: priceInCents,
        timestamp: now,
      };
      publishCryptoPriceUpdate(message);

      // Merge into lastKnownPrices for DB writes
      const known = this.lastKnownPrices.get(slug) || { upPrice: 50, downPrice: 50 };
      if (outcomeLabel === 'up') {
        known.upPrice = priceInCents;
      } else {
        known.downPrice = priceInCents;
      }
      this.lastKnownPrices.set(slug, known);
      this.pendingDbWrites.set(slug, { upPrice: known.upPrice, downPrice: known.downPrice });
      needsDbFlush = true;
    }

    if (needsDbFlush) {
      this.scheduleDbFlush();
    }
  }

  private scheduleDbFlush(): void {
    if (this.dbFlushTimer || this.isFlushingDb) return;
    this.dbFlushTimer = setTimeout(() => this.flushToDb(), this.DB_FLUSH_INTERVAL_MS);
  }

  /**
   * Bulk flush pending price writes to crypto_markets.markets[0].outcomePrices.
   * Uses a single DB connection / transaction to avoid connection exhaustion.
   */
  private async flushToDb(): Promise<void> {
    this.dbFlushTimer = null;
    if (this.pendingDbWrites.size === 0 || this.isFlushingDb) return;

    this.isFlushingDb = true;
    const writes = new Map(this.pendingDbWrites);
    this.pendingDbWrites.clear();

    let client;
    try {
      client = await connectWithRetry(3, 100);
      await client.query('BEGIN');

      for (const [slug, { upPrice, downPrice }] of writes) {
        // outcomePrices stored as decimal strings: ["0.60", "0.40"]
        const upDecimal = (upPrice / 100).toFixed(2);
        const downDecimal = (downPrice / 100).toFixed(2);
        const outcomePricesJson = JSON.stringify([upDecimal, downDecimal]);

        await client.query(
          `UPDATE crypto_markets
           SET markets = jsonb_set(markets, '{0,outcomePrices}', $2::jsonb, false),
               updated_at = NOW()
           WHERE slug = $1`,
          [slug, outcomePricesJson]
        );
      }

      await client.query('COMMIT');
      logger.debug({
        message: 'Crypto CLOB: flushed price writes to DB',
        count: writes.size,
      });
    } catch (error) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch {}
      }
      logger.error({
        message: 'Crypto CLOB: DB flush failed',
        error: error instanceof Error ? error.message : String(error),
        count: writes.size,
      });
      // Re-queue on failure (dedupe: keep newest write per slug)
      for (const [slug, data] of writes) {
        if (!this.pendingDbWrites.has(slug)) {
          this.pendingDbWrites.set(slug, data);
        }
      }
    } finally {
      if (client) client.release();
      this.isFlushingDb = false;
      if (this.pendingDbWrites.size > 0) {
        this.scheduleDbFlush();
      }
    }
  }

  getStatus() {
    return {
      isInitialized: this.isInitialized,
      trackedTokens: this.tokenToSlug.size,
      trackedSlugs: this.slugToTokens.size,
      pendingDbWrites: this.pendingDbWrites.size,
    };
  }

  shutdown(): void {
    if (this.redisUnsubscribe) {
      this.redisUnsubscribe();
      this.redisUnsubscribe = null;
    }
    if (this.dbFlushTimer) {
      clearTimeout(this.dbFlushTimer);
      this.dbFlushTimer = null;
    }
    if (this.diagnosticTimer) {
      clearInterval(this.diagnosticTimer);
      this.diagnosticTimer = null;
    }
    this.tokenToSlug.clear();
    this.slugToTokens.clear();
    this.pendingDbWrites.clear();
    this.lastPublishedByToken.clear();
    this.lastKnownPrices.clear();
    this.isInitialized = false;
    logger.info({ message: 'Crypto CLOB price service shut down' });
  }
}

export const cryptoClobPriceService = new CryptoClobPriceService();
