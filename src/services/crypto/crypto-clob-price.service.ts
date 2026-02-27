/**
 * Crypto CLOB Price Service
 * Runs in the CLOB background worker.
 *
 * Responsibilities:
 * 1. Listens on Redis (crypto:clob:subscribe) for token registrations from HTTP workers.
 *    When a user opens a crypto short-term detail page, the HTTP worker publishes
 *    { slug, upClobTokenId, downClobTokenId } so this service subscribes those tokens.
 * 2. Registers tokens in local maps for routing; CLOB WS subscription managed by subscribeToAllGames().
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
import { isCryptoRefreshInProgress } from '../polymarket/redis-games-cache.service';

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
  // Finance market slugs (for routing DB writes to finance_markets table)
  private financeSlugs: Set<string> = new Set();

  // Pending DB writes: slug -> latest known prices (always both sides from lastKnownPrices)
  private pendingDbWrites: Map<string, { upPrice: number; downPrice: number }> = new Map();
  private dbFlushTimer: NodeJS.Timeout | null = null;
  private isFlushingDb: boolean = false;
  private readonly DB_FLUSH_INTERVAL_MS = 2000;

  private redisUnsubscribe: (() => void) | null = null;
  private isInitialized: boolean = false;
  private diagnosticTimer: NodeJS.Timeout | null = null;
  private proactiveSubscribeTimer: NodeJS.Timeout | null = null;
  private matchCount: number = 0;
  private missCount: number = 0;

  // Dedup per token: only publish to Redis when best_bid actually changes
  private lastPublishedByToken: Map<string, number> = new Map();
  // Last known prices per slug for DB writes (merges partial updates)
  private lastKnownPrices: Map<string, { upPrice: number; downPrice: number }> = new Map();

  // Odds extremes (Up outcome) per slug — flushed to DB alongside outcomePrices
  private oddsExtremes: Map<string, { high: number; low: number }> = new Map();

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

    // Proactively subscribe to short-term markets about to start or active (so we get price updates even without user visits)
    this.startProactiveSubscribe();

    logger.info({ message: 'Crypto CLOB price service initialized' });
  }

  /**
   * Proactively register all active crypto market tokens in the local routing maps
   * (tokenToSlug / slugToTokens) so incoming CLOB price events are routed correctly.
   *
   * Does NOT call addAssets / trigger WS reconnects — the CLOB WS subscription list
   * is managed centrally by subscribeToAllGames() which includes both sports + crypto tokens.
   * Runs every hour, aligned with crypto markets refresh.
   */
  private startProactiveSubscribe(): void {
    const RUN_INTERVAL_MS = 60 * 60 * 1000; // Every hour (aligned with crypto refresh)
    const subscribe = async () => {
      let client;
      try {
        client = await connectWithRetry(2, 200);

        // Query both crypto and finance markets
        const cryptoRes = await client.query(
          `SELECT slug, markets FROM crypto_markets WHERE end_date > NOW() AND active = true`
        );
        const financeRes = await client.query(
          `SELECT slug, markets FROM finance_markets WHERE end_date > NOW() AND active = true`
        );

        // Clear odds extremes for markets that have ended (not in active set)
        const activeSlugs = new Set([
          ...cryptoRes.rows.map((r: { slug: string }) => r.slug),
          ...financeRes.rows.map((r: { slug: string }) => r.slug),
        ]);
        for (const slug of this.oddsExtremes.keys()) {
          if (!activeSlugs.has(slug)) {
            this.oddsExtremes.delete(slug);
          }
        }

        // Track finance slugs for DB write routing
        this.financeSlugs.clear();
        for (const row of financeRes.rows as { slug: string }[]) {
          this.financeSlugs.add(row.slug);
        }

        let registered = 0;
        const allRows = [
          ...cryptoRes.rows as { slug: string; markets: unknown }[],
          ...financeRes.rows as { slug: string; markets: unknown }[],
        ];

        for (const row of allRows) {
          try {
            const mkts = Array.isArray(row.markets) ? row.markets : [];
            const m = mkts[0];
            if (!m) continue;
            const outcomes = Array.isArray(m.outcomes) ? m.outcomes.map(String) : [];
            const tokenIds = Array.isArray(m.clobTokenIds) ? m.clobTokenIds : [];
            const upIdx = outcomes.findIndex((o: string) => o.toLowerCase() === 'up');
            const downIdx = outcomes.findIndex((o: string) => o.toLowerCase() === 'down');
            const upToken = upIdx >= 0 ? tokenIds[upIdx] : tokenIds[0];
            const downToken = downIdx >= 0 ? tokenIds[downIdx] : tokenIds[1];
            if (!upToken) continue;

            // Register in local maps only (no WS reconnect)
            const upTokenStr = String(upToken);
            const downTokenStr = downToken ? String(downToken) : '';
            if (!this.tokenToSlug.has(upTokenStr)) {
              this.tokenToSlug.set(upTokenStr, { slug: row.slug, outcomeLabel: 'up', outcomeIndex: 0 });
            }
            if (downTokenStr && !this.tokenToSlug.has(downTokenStr)) {
              this.tokenToSlug.set(downTokenStr, { slug: row.slug, outcomeLabel: 'down', outcomeIndex: 1 });
            }
            this.slugToTokens.set(row.slug, { upClobTokenId: upTokenStr, downClobTokenId: downTokenStr });
            registered++;
          } catch {
            // Skip malformed rows
          }
        }
        logger.info({
          message: 'CLOB: refreshed local token maps (crypto + finance)',
          registeredSlugs: registered,
          financeSlugs: this.financeSlugs.size,
          totalTokens: this.tokenToSlug.size,
        });
      } catch (err) {
        logger.debug({
          message: 'CLOB proactive subscribe query failed',
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        client?.release();
      }
    };
    subscribe();
    this.proactiveSubscribeTimer = setInterval(subscribe, RUN_INTERVAL_MS);
  }

  /**
   * Register a crypto market's outcome tokens for CLOB subscription.
   * Called when an HTTP worker forwards a frontend client's subscribe request.
   */
  /**
   * Register a crypto market's outcome tokens in local routing maps.
   * Does NOT trigger WS reconnect — CLOB subscription is managed centrally
   * by subscribeToAllGames() which includes crypto tokens.
   */
  private registerTokens(msg: CryptoClobSubscribeMessage): void {
    const { slug, upClobTokenId, downClobTokenId } = msg;
    if (!slug || !upClobTokenId) return;

    if (!this.tokenToSlug.has(upClobTokenId)) {
      this.tokenToSlug.set(upClobTokenId, { slug, outcomeLabel: 'up', outcomeIndex: 0 });
    }

    if (downClobTokenId && !this.tokenToSlug.has(downClobTokenId)) {
      this.tokenToSlug.set(downClobTokenId, { slug, outcomeLabel: 'down', outcomeIndex: 1 });
    }

    // Always refresh slug -> tokens mapping (idempotent)
    this.slugToTokens.set(slug, {
      upClobTokenId,
      downClobTokenId: downClobTokenId || '',
    });
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

      // Track odds extremes for Up outcome
      if (outcomeLabel === 'up') {
        const ext = this.oddsExtremes.get(slug);
        if (!ext) {
          this.oddsExtremes.set(slug, { high: priceInCents, low: priceInCents });
        } else {
          if (priceInCents > ext.high) ext.high = priceInCents;
          if (priceInCents < ext.low) ext.low = priceInCents;
        }
      }

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
   * Uses single batch UPDATE statements (unnest arrays) to acquire all row locks
   * atomically, preventing deadlocks from conflicting lock ordering.
   */
  private async flushToDb(): Promise<void> {
    this.dbFlushTimer = null;
    if (this.pendingDbWrites.size === 0 || this.isFlushingDb) return;

    // Cross-worker: skip flush during crypto markets refresh (sports worker) to prevent deadlock
    if (await isCryptoRefreshInProgress()) {
      if (this.pendingDbWrites.size > 0) {
        this.scheduleDbFlush();
      }
      return;
    }

    this.isFlushingDb = true;
    const writes = new Map(this.pendingDbWrites);
    this.pendingDbWrites.clear();

    let client;
    try {
      client = await connectWithRetry(3, 100);

      // Split writes by table (crypto vs finance)
      const cryptoSlugs: string[] = [];
      const cryptoPricesArr: string[] = [];
      const cryptoHighArr: (number | null)[] = [];
      const cryptoLowArr: (number | null)[] = [];
      const financeSlugs: string[] = [];
      const financePricesArr: string[] = [];
      const financeHighArr: (number | null)[] = [];
      const financeLowArr: (number | null)[] = [];

      for (const [slug, { upPrice, downPrice }] of writes) {
        const upDecimal = (upPrice / 100).toFixed(2);
        const downDecimal = (downPrice / 100).toFixed(2);
        const pricesJson = JSON.stringify([upDecimal, downDecimal]);
        const ext = this.oddsExtremes.get(slug);

        if (this.financeSlugs.has(slug)) {
          financeSlugs.push(slug);
          financePricesArr.push(pricesJson);
          financeHighArr.push(ext ? ext.high : null);
          financeLowArr.push(ext ? ext.low : null);
        } else {
          cryptoSlugs.push(slug);
          cryptoPricesArr.push(pricesJson);
          cryptoHighArr.push(ext ? ext.high : null);
          cryptoLowArr.push(ext ? ext.low : null);
        }
      }

      // Batch UPDATE for crypto_markets
      if (cryptoSlugs.length > 0) {
        await client.query(
          `UPDATE crypto_markets AS cm
           SET markets = jsonb_set(cm.markets, '{0,outcomePrices}', v.outcome_prices::jsonb, false),
               odds_high = CASE WHEN v.odds_high IS NOT NULL
                            THEN GREATEST(COALESCE(cm.odds_high, 0), v.odds_high)
                            ELSE cm.odds_high END,
               odds_low = CASE WHEN v.odds_low IS NOT NULL
                           THEN LEAST(COALESCE(cm.odds_low, 100), v.odds_low)
                           ELSE cm.odds_low END,
               updated_at = NOW()
           FROM unnest($1::text[], $2::text[], $3::int[], $4::int[])
                AS v(slug, outcome_prices, odds_high, odds_low)
           WHERE cm.slug = v.slug`,
          [cryptoSlugs, cryptoPricesArr, cryptoHighArr, cryptoLowArr]
        );
      }

      // Batch UPDATE for finance_markets
      if (financeSlugs.length > 0) {
        await client.query(
          `UPDATE finance_markets AS fm
           SET markets = jsonb_set(fm.markets, '{0,outcomePrices}', v.outcome_prices::jsonb, false),
               odds_high = CASE WHEN v.odds_high IS NOT NULL
                            THEN GREATEST(COALESCE(fm.odds_high, 0), v.odds_high)
                            ELSE fm.odds_high END,
               odds_low = CASE WHEN v.odds_low IS NOT NULL
                           THEN LEAST(COALESCE(fm.odds_low, 100), v.odds_low)
                           ELSE fm.odds_low END,
               updated_at = NOW()
           FROM unnest($1::text[], $2::text[], $3::int[], $4::int[])
                AS v(slug, outcome_prices, odds_high, odds_low)
           WHERE fm.slug = v.slug`,
          [financeSlugs, financePricesArr, financeHighArr, financeLowArr]
        );
      }

      // Flush odds for slugs NOT in current writes batch (accumulated extremes)
      const extraCryptoSlugs: string[] = [];
      const extraCryptoHighs: number[] = [];
      const extraCryptoLows: number[] = [];
      const extraFinanceSlugs: string[] = [];
      const extraFinanceHighs: number[] = [];
      const extraFinanceLows: number[] = [];
      for (const [slug, { high, low }] of this.oddsExtremes) {
        if (!writes.has(slug)) {
          if (this.financeSlugs.has(slug)) {
            extraFinanceSlugs.push(slug);
            extraFinanceHighs.push(high);
            extraFinanceLows.push(low);
          } else {
            extraCryptoSlugs.push(slug);
            extraCryptoHighs.push(high);
            extraCryptoLows.push(low);
          }
        }
      }
      if (extraCryptoSlugs.length > 0) {
        await client.query(
          `UPDATE crypto_markets AS cm
           SET odds_high = GREATEST(COALESCE(cm.odds_high, 0), v.odds_high),
               odds_low = LEAST(COALESCE(cm.odds_low, 100), v.odds_low),
               updated_at = NOW()
           FROM unnest($1::text[], $2::int[], $3::int[])
                AS v(slug, odds_high, odds_low)
           WHERE cm.slug = v.slug`,
          [extraCryptoSlugs, extraCryptoHighs, extraCryptoLows]
        );
      }
      if (extraFinanceSlugs.length > 0) {
        await client.query(
          `UPDATE finance_markets AS fm
           SET odds_high = GREATEST(COALESCE(fm.odds_high, 0), v.odds_high),
               odds_low = LEAST(COALESCE(fm.odds_low, 100), v.odds_low),
               updated_at = NOW()
           FROM unnest($1::text[], $2::int[], $3::int[])
                AS v(slug, odds_high, odds_low)
           WHERE fm.slug = v.slug`,
          [extraFinanceSlugs, extraFinanceHighs, extraFinanceLows]
        );
      }
    } catch (error) {
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
    if (this.proactiveSubscribeTimer) {
      clearInterval(this.proactiveSubscribeTimer);
      this.proactiveSubscribeTimer = null;
    }
    this.tokenToSlug.clear();
    this.slugToTokens.clear();
    this.financeSlugs.clear();
    this.pendingDbWrites.clear();
    this.lastPublishedByToken.clear();
    this.lastKnownPrices.clear();
    this.oddsExtremes.clear();
    this.isInitialized = false;
    logger.info({ message: 'Crypto CLOB price service shut down' });
  }
}

export const cryptoClobPriceService = new CryptoClobPriceService();
