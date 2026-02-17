/**
 * Frontend Crypto Markets Service
 * Fetches crypto_markets from DB, transforms to PredictionMarket format.
 * Uses in-memory cache, promise coalescing for burst traffic, connect-only-when-read.
 */

import { connectWithRetry } from '../../config/database';
import {
  transformCryptoMarketToFrontend,
  PredictionMarketFrontend,
  CryptoMarketRow,
} from './crypto-market.transformer';
import { fetchOpeningPrice } from './crypto-opening-price.service';

interface CacheEntry {
  data: PredictionMarketFrontend[];
  timestamp: number;
  total: number;
  hasMore: boolean;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** In-flight promises keyed by cache key to coalesce concurrent identical requests */
const inFlight = new Map<string, Promise<PaginatedResult>>();

export interface PaginatedResult {
  markets: PredictionMarketFrontend[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface ListOptions {
  timeframe?: string | null;
  asset?: string | null;
  page?: number;
  limit?: number;
}

const TIMEFRAME_ALIASES: Record<string, string> = {
  '15min': '15m',
  '15m': '15m',
  '1h': '1h',
  'hourly': '1h',
  '4h': '4h',
  '4hour': '4h',
  'daily': 'daily',
  'weekly': 'weekly',
  'monthly': 'monthly',
  'yearly': 'yearly',
  'pre-market': 'pre-market',
  'etf': 'etf',
};

function normalizeTimeframe(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.toLowerCase().trim();
  return (TIMEFRAME_ALIASES[s] ?? s) || null;
}

function normalizeAsset(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.toLowerCase().trim();
  return s || null;
}

/** Timeframes where we deduplicate by series_slug, showing only the current/active window.
 *  Short intervals (5m–daily) have many recurring events per asset; longer ones (weekly+)
 *  are naturally unique but included for safety — DISTINCT ON is a no-op when only one exists. */
const DEDUP_TIMEFRAMES = new Set(['5m', '15m', '1h', '4h', 'daily', 'weekly', 'monthly', 'yearly', 'pre-market', 'etf']);

async function fetchFromDb(options: ListOptions): Promise<PaginatedResult> {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
  const offset = (page - 1) * limit;
  const timeframe = normalizeTimeframe(options.timeframe);
  const asset = normalizeAsset(options.asset);

  const client = await connectWithRetry();
  try {
    const params: unknown[] = [];
    const where: string[] = ['active = true', 'closed = false', 'archived = false'];

    if (timeframe) {
      params.push(timeframe);
      where.push(`LOWER(timeframe) = $${params.length}`);
    }
    if (asset) {
      params.push(asset);
      where.push(`LOWER(asset) = $${params.length}`);
    }

    const isShortTimeframe = timeframe != null && DEDUP_TIMEFRAMES.has(timeframe);
    const whereClause = where.join(' AND ');

    let q: string;
    if (isShortTimeframe) {
      // Short timeframes (15m, 5m): deduplicate by series_slug, pick the current window.
      // DISTINCT ON picks one row per series_slug. The CASE expression prioritises
      // the window we are inside (start_time <= NOW) over future windows, and
      // end_date ASC picks the soonest-ending within each priority tier.
      // COUNT(*) OVER() avoids a separate COUNT round-trip.
      params.push(limit, offset);
      q = `
        SELECT *, COUNT(*) OVER () AS total_count FROM (
          SELECT DISTINCT ON (series_slug)
            id, slug, title, end_date, icon, active, closed, liquidity, volume,
            comment_count, is_live, timeframe, asset, tags, markets
          FROM crypto_markets
          WHERE ${whereClause}
            AND series_slug IS NOT NULL
            AND end_date > NOW()
          ORDER BY series_slug,
            CASE WHEN start_time <= NOW() THEN 0 ELSE 1 END,
            end_date ASC NULLS LAST
        ) AS deduped
        ORDER BY volume DESC NULLS LAST, end_date ASC NULLS LAST
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `;
    } else {
      // Normal path: single query with window-function count.
      params.push(limit, offset);
      q = `
        SELECT id, slug, title, end_date, icon, active, closed, liquidity, volume,
               comment_count, is_live, timeframe, asset, tags, markets,
               COUNT(*) OVER () AS total_count
        FROM crypto_markets
        WHERE ${whereClause}
        ORDER BY volume DESC NULLS LAST, end_date ASC NULLS LAST
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `;
    }

    const res = await client.query(q, params);
    const rows = res.rows as (CryptoMarketRow & { total_count?: string })[];
    const total = rows.length > 0 ? parseInt(rows[0].total_count ?? '0', 10) : 0;
    const markets = rows.map(transformCryptoMarketToFrontend);

    return {
      markets,
      total,
      page,
      limit,
      hasMore: offset + markets.length < total,
    };
  } finally {
    client.release();
  }
}

export async function getFrontendCryptoMarketsFromDatabase(
  options: ListOptions
): Promise<PaginatedResult> {
  // Skip DB when no database configured (local dev without DATABASE_URL)
  if (!process.env.DATABASE_URL) {
    return { markets: [], total: 0, page: 1, limit: DEFAULT_LIMIT, hasMore: false };
  }

  const cacheKey = JSON.stringify({
    tf: options.timeframe ?? null,
    a: options.asset ?? null,
    p: options.page ?? 1,
    l: options.limit ?? DEFAULT_LIMIT,
  });

  const now = Date.now();
  const tf = normalizeTimeframe(options.timeframe);
  const asset = normalizeAsset(options.asset);
  const isFirstPageUnfiltered =
    !tf &&
    !asset &&
    (options.page ?? 1) === 1 &&
    (options.limit ?? DEFAULT_LIMIT) === DEFAULT_LIMIT;
  const simpleCacheKey = 'list:p1:default';

  if (isFirstPageUnfiltered) {
    const hit = cache.get(simpleCacheKey);
    if (hit && now - hit.timestamp < CACHE_TTL_MS) {
      return {
        markets: hit.data,
        total: hit.total,
        page: 1,
        limit: DEFAULT_LIMIT,
        hasMore: hit.hasMore,
      };
    }
  }

  let promise = inFlight.get(cacheKey);
  if (!promise) {
    promise = fetchFromDb(options);
    inFlight.set(cacheKey, promise);
    promise.finally(() => inFlight.delete(cacheKey));
  }
  const result = await promise;

  if (isFirstPageUnfiltered) {
    cache.set(simpleCacheKey, {
      data: result.markets,
      timestamp: now,
      total: result.total,
      hasMore: result.hasMore,
    });
    if (cache.size > 10) {
      for (const [k, e] of cache.entries()) {
        if (now - e.timestamp >= CACHE_TTL_MS) cache.delete(k);
      }
    }
  }

  return result;
}

/**
 * Fetch full/raw detail of a crypto market by slug — SSR-like structure.
 * Composes the response in PostgreSQL to minimise Node.js work.
 * Returns null when not found.
 */
export async function getCryptoMarketDetailBySlug(
  slug: string
): Promise<Record<string, unknown> | null> {
  if (!process.env.DATABASE_URL) return null;

  const client = await connectWithRetry();
  try {
    const res = await client.query(
      `SELECT
         id, ticker, slug, title, description, resolution_source,
         start_date, end_date, start_time, image, icon,
         active, closed, archived, restricted,
         liquidity, volume, open_interest, competitive,
         enable_order_book, liquidity_clob, neg_risk,
         comment_count, is_live,
         timeframe, asset, series_slug,
         opening_price,
         markets, series, tags_data AS tags
       FROM crypto_markets
       WHERE LOWER(slug) = LOWER($1)
       LIMIT 1`,
      [slug]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0] as Record<string, unknown>;

    // On-demand: if opening_price is missing and market has started, fetch from Polymarket SSR
    if (row.opening_price == null && row.start_time && new Date(row.start_time as string) <= new Date()) {
      try {
        const price = await fetchOpeningPrice(row.slug as string);
        if (price != null) {
          row.opening_price = price;
          // Persist in background (don't block response)
          client.query(
            'UPDATE crypto_markets SET opening_price = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [price, row.id]
          ).catch(() => {});
        }
      } catch {
        // Non-critical — return row without opening_price
      }
    }

    return row;
  } finally {
    client.release();
  }
}

export async function getFrontendCryptoMarketBySlugFromDatabase(
  slug: string
): Promise<PredictionMarketFrontend | null> {
  if (!process.env.DATABASE_URL) return null;

  const client = await connectWithRetry();
  try {
    const res = await client.query(
      `SELECT id, slug, title, end_date, icon, active, closed, liquidity, volume,
              comment_count, is_live, timeframe, asset, tags, markets
       FROM crypto_markets
       WHERE LOWER(slug) = LOWER($1) AND active = true AND closed = false`,
      [slug]
    );
    if (res.rows.length === 0) return null;
    return transformCryptoMarketToFrontend(res.rows[0] as CryptoMarketRow);
  } finally {
    client.release();
  }
}

export async function getFrontendCryptoMarketByIdFromDatabase(
  id: string
): Promise<PredictionMarketFrontend | null> {
  if (!process.env.DATABASE_URL) return null;

  const client = await connectWithRetry();
  try {
    const res = await client.query(
      `SELECT id, slug, title, end_date, icon, active, closed, liquidity, volume,
              comment_count, is_live, timeframe, asset, tags, markets
       FROM crypto_markets
       WHERE id = $1 AND active = true AND closed = false`,
      [id]
    );
    if (res.rows.length === 0) return null;
    return transformCryptoMarketToFrontend(res.rows[0] as CryptoMarketRow);
  } finally {
    client.release();
  }
}

/**
 * Get the currently active market in a series (start_time <= now AND end_date > now).
 * Returns the slug of the active market or null if none is active.
 */
export async function getCurrentMarketBySeriesSlug(
  seriesSlug: string
): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;

  const client = await connectWithRetry();
  try {
    const res = await client.query(
      `SELECT slug FROM crypto_markets
       WHERE series_slug = $1
         AND start_time <= NOW()
         AND end_date > NOW()
         AND active = true
       ORDER BY start_time DESC
       LIMIT 1`,
      [seriesSlug]
    );
    return res.rows[0]?.slug ?? null;
  } finally {
    client.release();
  }
}

/**
 * Get a timeline of markets in a series around the current time.
 * Returns `past` (most recent N ended) + `current` (if any) + `future` (next N upcoming).
 * Each entry includes slug, start_time, end_date, and opening_price.
 * Past markets also include outcome data via the SSR past-results.
 */
export interface TimelineMarket {
  slug: string;
  startTime: string;
  endTime: string;
  openingPrice: number | null;
  status: 'past' | 'current' | 'future';
  outcome: 'up' | 'down' | null; // null for current/future
}

export async function getSeriesTimeline(
  seriesSlug: string,
  pastCount = 4,
  futureCount = 3,
): Promise<TimelineMarket[]> {
  if (!process.env.DATABASE_URL) return [];

  const client = await connectWithRetry();
  try {
    // Single query: grab a window around NOW
    const res = await client.query(
      `(
        SELECT slug, start_time, end_date, opening_price, markets, 'past' AS status
        FROM crypto_markets
        WHERE series_slug = $1 AND end_date <= NOW() AND start_time IS NOT NULL
        ORDER BY start_time DESC
        LIMIT $2
      )
      UNION ALL
      (
        SELECT slug, start_time, end_date, opening_price, markets, 'current' AS status
        FROM crypto_markets
        WHERE series_slug = $1 AND start_time <= NOW() AND end_date > NOW() AND start_time IS NOT NULL
        ORDER BY start_time DESC
        LIMIT 1
      )
      UNION ALL
      (
        SELECT slug, start_time, end_date, opening_price, markets, 'future' AS status
        FROM crypto_markets
        WHERE series_slug = $1 AND start_time > NOW() AND start_time IS NOT NULL
        ORDER BY start_time ASC
        LIMIT $3
      )
      ORDER BY start_time ASC`,
      [seriesSlug, pastCount, futureCount]
    );

    return res.rows.map((r: Record<string, unknown>) => {
      let outcome: 'up' | 'down' | null = null;
      if (r.status === 'past') {
        // Derive outcome from outcomePrices: [upPrice, downPrice]
        try {
          const mkts = typeof r.markets === 'string' ? JSON.parse(r.markets) : r.markets;
          if (Array.isArray(mkts) && mkts.length > 0) {
            const prices = mkts[0].outcomePrices;
            if (Array.isArray(prices) && prices.length >= 2) {
              const upPrice = parseFloat(prices[0]);
              outcome = upPrice > 0.5 ? 'up' : 'down';
            }
          }
        } catch { /* ignore parse errors */ }
      }

      return {
        slug: r.slug as string,
        startTime: (r.start_time as Date).toISOString(),
        endTime: (r.end_date as Date).toISOString(),
        openingPrice: r.opening_price != null ? Number(r.opening_price) : null,
        status: r.status as 'past' | 'current' | 'future',
        outcome,
      };
    });
  } finally {
    client.release();
  }
}
