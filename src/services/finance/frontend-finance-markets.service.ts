/**
 * Frontend Finance Markets Service
 * Fetches finance_markets from DB, transforms to FinanceMarketFrontend format.
 * Uses in-memory cache, promise coalescing for burst traffic.
 */

import { connectWithRetry } from '../../config/database';
import {
  transformFinanceMarketToFrontend,
  FinanceMarketFrontend,
  FinanceMarketRow,
} from './finance-market.transformer';

interface CacheEntry {
  data: FinanceMarketFrontend[];
  timestamp: number;
  total: number;
  hasMore: boolean;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const inFlight = new Map<string, Promise<PaginatedResult>>();

export interface PaginatedResult {
  markets: FinanceMarketFrontend[];
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
  'daily': 'daily',
  'weekly': 'weekly',
  'monthly': 'monthly',
  'yearly': 'yearly',
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

const DEDUP_TIMEFRAMES = new Set(['daily', 'weekly', 'monthly', 'yearly']);

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
      params.push(limit, offset);
      q = `
        SELECT *, COUNT(*) OVER () AS total_count FROM (
          SELECT DISTINCT ON (series_slug)
            id, slug, title, end_date, icon, active, closed, liquidity, volume,
            comment_count, is_live, timeframe, asset, tags, markets
          FROM finance_markets
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
      params.push(limit, offset);
      q = `
        SELECT id, slug, title, end_date, icon, active, closed, liquidity, volume,
               comment_count, is_live, timeframe, asset, tags, markets,
               COUNT(*) OVER () AS total_count
        FROM finance_markets
        WHERE ${whereClause}
        ORDER BY volume DESC NULLS LAST, end_date ASC NULLS LAST
        LIMIT $${params.length - 1} OFFSET $${params.length}
      `;
    }

    const res = await client.query(q, params);
    const rows = res.rows as (FinanceMarketRow & { total_count?: string })[];
    const total = rows.length > 0 ? parseInt(rows[0].total_count ?? '0', 10) : 0;
    const markets = rows.map(transformFinanceMarketToFrontend);

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

export async function getFrontendFinanceMarketsFromDatabase(
  options: ListOptions
): Promise<PaginatedResult> {
  if (!process.env.DATABASE_URL) {
    return { markets: [], total: 0, page: 1, limit: DEFAULT_LIMIT, hasMore: false };
  }

  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
  const tf = normalizeTimeframe(options.timeframe);
  const asset = normalizeAsset(options.asset);

  const cacheKey = JSON.stringify({ tf, a: asset, p: page, l: limit });

  const now = Date.now();
  const isFirstPageUnfiltered = !tf && !asset && page === 1 && limit === DEFAULT_LIMIT;
  const simpleCacheKey = 'finance:list:p1:default';

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

  const existingInFlight = inFlight.get(cacheKey);
  if (existingInFlight) {
    return existingInFlight;
  }

  const fetchPromise = fetchFromDb(options);
  inFlight.set(cacheKey, fetchPromise);
  try {
    const result = await fetchPromise;

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
  } finally {
    inFlight.delete(cacheKey);
  }
}

export async function getFinanceMarketDetailBySlug(
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
         opening_price, closing_price,
         markets, series, tags_data AS tags
       FROM finance_markets
       WHERE LOWER(slug) = LOWER($1)
       LIMIT 1`,
      [slug]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0] as Record<string, unknown>;
  } finally {
    client.release();
  }
}

export async function getFrontendFinanceMarketBySlugFromDatabase(
  slug: string
): Promise<FinanceMarketFrontend | null> {
  if (!process.env.DATABASE_URL) return null;

  const client = await connectWithRetry();
  try {
    const res = await client.query(
      `SELECT id, slug, title, end_date, icon, active, closed, liquidity, volume,
              comment_count, is_live, timeframe, asset, tags, markets
       FROM finance_markets
       WHERE LOWER(slug) = LOWER($1) AND active = true AND closed = false`,
      [slug]
    );
    if (res.rows.length === 0) return null;
    return transformFinanceMarketToFrontend(res.rows[0] as FinanceMarketRow);
  } finally {
    client.release();
  }
}

export async function getFrontendFinanceMarketByIdFromDatabase(
  id: string
): Promise<FinanceMarketFrontend | null> {
  if (!process.env.DATABASE_URL) return null;

  const client = await connectWithRetry();
  try {
    const res = await client.query(
      `SELECT id, slug, title, end_date, icon, active, closed, liquidity, volume,
              comment_count, is_live, timeframe, asset, tags, markets
       FROM finance_markets
       WHERE id = $1 AND active = true AND closed = false`,
      [id]
    );
    if (res.rows.length === 0) return null;
    return transformFinanceMarketToFrontend(res.rows[0] as FinanceMarketRow);
  } finally {
    client.release();
  }
}

export async function getCurrentFinanceMarketBySeriesSlug(
  seriesSlug: string
): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;

  const client = await connectWithRetry();
  try {
    const res = await client.query(
      `SELECT slug FROM finance_markets
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

export interface TimelineMarket {
  slug: string;
  startTime: string;
  endTime: string;
  openingPrice: number | null;
  closingPrice: number | null;
  priceHigh: number | null;
  priceLow: number | null;
  oddsHigh: number | null;
  oddsLow: number | null;
  status: 'past' | 'current' | 'future';
  outcome: 'up' | 'down' | null;
}

export async function getFinanceSeriesTimeline(
  seriesSlug: string,
  pastCount = 4,
  futureCount = 3,
): Promise<TimelineMarket[]> {
  if (!process.env.DATABASE_URL) return [];

  const client = await connectWithRetry();
  try {
    const res = await client.query(
      `(
        SELECT slug, start_time, end_date, opening_price, closing_price,
               price_high, price_low, odds_high, odds_low,
               markets, 'past' AS status
        FROM finance_markets
        WHERE series_slug = $1 AND end_date <= NOW() AND start_time IS NOT NULL
        ORDER BY start_time DESC
        LIMIT $2
      )
      UNION ALL
      (
        SELECT slug, start_time, end_date, opening_price, closing_price,
               price_high, price_low, odds_high, odds_low,
               markets, 'current' AS status
        FROM finance_markets
        WHERE series_slug = $1 AND start_time <= NOW() AND end_date > NOW() AND start_time IS NOT NULL
        ORDER BY start_time DESC
        LIMIT 1
      )
      UNION ALL
      (
        SELECT slug, start_time, end_date, opening_price, closing_price,
               price_high, price_low, odds_high, odds_low,
               markets, 'future' AS status
        FROM finance_markets
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
        const open = r.opening_price != null ? Number(r.opening_price) : null;
        const close = r.closing_price != null ? Number(r.closing_price) : null;
        if (open != null && close != null) {
          outcome = close > open ? 'up' : close < open ? 'down' : null;
        } else {
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
      }

      return {
        slug: r.slug as string,
        startTime: (r.start_time as Date).toISOString(),
        endTime: (r.end_date as Date).toISOString(),
        openingPrice: r.opening_price != null ? Number(r.opening_price) : null,
        closingPrice: r.closing_price != null ? Number(r.closing_price) : null,
        priceHigh: r.price_high != null ? Number(r.price_high) : null,
        priceLow: r.price_low != null ? Number(r.price_low) : null,
        oddsHigh: r.odds_high != null ? Number(r.odds_high) : null,
        oddsLow: r.odds_low != null ? Number(r.odds_low) : null,
        status: r.status as 'past' | 'current' | 'future',
        outcome,
      };
    });
  } finally {
    client.release();
  }
}
