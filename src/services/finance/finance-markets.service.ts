/**
 * Finance Markets Service
 * Fetches all finance events from Polymarket Gamma API (tag_id=120), transforms to SSR-compatible format,
 * and bulk upserts into the finance_markets table. Auto-refreshes every 1 hour.
 * Reuses the same transformation logic as crypto markets.
 */

import { pool } from '../../config/database';
import { logger } from '../../config/logger';
import { polymarketClient } from '../polymarket/polymarket.client';
import { transformMarketToSSR } from '../crypto/crypto-markets.service';

// Gamma API tag ID for "Finance"
const FINANCE_TAG_ID = 120;
const PAGE_LIMIT = 100;
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const BATCH_SIZE = 500;

// Known timeframe tag slugs for finance categorization
const TIMEFRAME_TAGS = new Set([
  'daily', 'weekly', 'monthly', 'yearly',
]);

// Known asset/category tag slugs for finance categorization
const ASSET_TAGS = new Set([
  'stocks', 'earnings', 'indicies', 'indices', 'commodities', 'forex',
  'collectibles', 'acquisitions', 'earnings-calls', 'ipos', 'ipo',
  'fed-rates', 'prediction-markets', 'treasuries', 'treasures',
  'tech', 'big-tech', 'economy',
]);

// Types (same as crypto)
interface GammaTag {
  id: string;
  label: string;
  slug: string;
  [key: string]: any;
}

interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  [key: string]: any;
}

interface GammaEvent {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  description?: string;
  resolutionSource?: string;
  startDate?: string;
  creationDate?: string;
  endDate?: string;
  image?: string;
  icon?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  new?: boolean;
  featured?: boolean;
  restricted?: boolean;
  liquidity?: number;
  volume?: number;
  openInterest?: number;
  competitive?: number;
  enableOrderBook?: boolean;
  liquidityClob?: number;
  negRisk?: boolean;
  commentCount?: number;
  cyom?: boolean;
  showAllOutcomes?: boolean;
  showMarketImages?: boolean;
  automaticallyActive?: boolean;
  negRiskAugmented?: boolean;
  pendingDeployment?: boolean;
  deploying?: boolean;
  startTime?: string;
  seriesSlug?: string;
  markets?: GammaMarket[];
  series?: any[];
  tags?: GammaTag[];
  [key: string]: any;
}

interface FinanceMarketRow {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  description: string | null;
  resolution_source: string | null;
  start_date: string | null;
  end_date: string | null;
  image: string | null;
  image_raw: string | null;
  icon: string | null;
  active: boolean;
  closed: boolean;
  archived: boolean;
  new: boolean;
  featured: boolean;
  restricted: boolean;
  liquidity: number | null;
  volume: number | null;
  open_interest: number | null;
  competitive: number | null;
  enable_order_book: boolean;
  liquidity_clob: number | null;
  neg_risk: boolean;
  comment_count: number;
  cyom: boolean;
  show_all_outcomes: boolean;
  show_market_images: boolean;
  automatically_active: boolean;
  neg_risk_augmented: boolean;
  pending_deployment: boolean;
  deploying: boolean;
  is_live: boolean;
  start_time: string | null;
  series_slug: string | null;
  timeframe: string | null;
  asset: string | null;
  tags: string[];
  markets: any[];
  series: any[] | null;
  tags_data: any[] | null;
  raw_data: any;
  opening_price: number | null;
}

const COLUMN_COUNT = 43;

const INSERT_QUERY = `
  INSERT INTO finance_markets (
    id, ticker, slug, title, description, resolution_source,
    start_date, end_date, image, image_raw, icon,
    active, closed, archived, new, featured, restricted,
    liquidity, volume, open_interest, competitive,
    enable_order_book, liquidity_clob, neg_risk, comment_count,
    cyom, show_all_outcomes, show_market_images,
    automatically_active, neg_risk_augmented, pending_deployment, deploying,
    is_live, start_time, series_slug,
    timeframe, asset, tags,
    markets, series, tags_data, raw_data,
    opening_price,
    created_at, updated_at
  ) VALUES %PLACEHOLDERS%
  ON CONFLICT (id) DO UPDATE SET
    ticker = EXCLUDED.ticker, slug = EXCLUDED.slug, title = EXCLUDED.title,
    description = EXCLUDED.description, resolution_source = EXCLUDED.resolution_source,
    start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
    image = EXCLUDED.image, image_raw = EXCLUDED.image_raw, icon = EXCLUDED.icon,
    active = EXCLUDED.active, closed = EXCLUDED.closed, archived = EXCLUDED.archived,
    new = EXCLUDED.new, featured = EXCLUDED.featured, restricted = EXCLUDED.restricted,
    liquidity = EXCLUDED.liquidity, volume = EXCLUDED.volume,
    open_interest = EXCLUDED.open_interest, competitive = EXCLUDED.competitive,
    enable_order_book = EXCLUDED.enable_order_book, liquidity_clob = EXCLUDED.liquidity_clob,
    neg_risk = EXCLUDED.neg_risk, comment_count = EXCLUDED.comment_count,
    cyom = EXCLUDED.cyom, show_all_outcomes = EXCLUDED.show_all_outcomes,
    show_market_images = EXCLUDED.show_market_images,
    automatically_active = EXCLUDED.automatically_active,
    neg_risk_augmented = EXCLUDED.neg_risk_augmented,
    pending_deployment = EXCLUDED.pending_deployment, deploying = EXCLUDED.deploying,
    is_live = EXCLUDED.is_live, start_time = EXCLUDED.start_time,
    series_slug = EXCLUDED.series_slug,
    timeframe = EXCLUDED.timeframe, asset = EXCLUDED.asset, tags = EXCLUDED.tags,
    markets = EXCLUDED.markets, series = EXCLUDED.series,
    tags_data = EXCLUDED.tags_data, raw_data = EXCLUDED.raw_data,
    opening_price = COALESCE(finance_markets.opening_price, EXCLUDED.opening_price),
    price_high = COALESCE(finance_markets.price_high, EXCLUDED.price_high),
    price_low = COALESCE(finance_markets.price_low, EXCLUDED.price_low),
    odds_high = COALESCE(finance_markets.odds_high, EXCLUDED.odds_high),
    odds_low = COALESCE(finance_markets.odds_low, EXCLUDED.odds_low),
    updated_at = CURRENT_TIMESTAMP
`;

function extractTimeframe(tags: GammaTag[]): string | null {
  for (const tag of tags) {
    if (TIMEFRAME_TAGS.has(tag.slug)) return tag.slug;
    if (TIMEFRAME_TAGS.has(tag.label?.toLowerCase())) return tag.label.toLowerCase();
  }
  return null;
}

function extractAsset(tags: GammaTag[]): string | null {
  for (const tag of tags) {
    if (ASSET_TAGS.has(tag.slug)) return tag.slug;
  }
  return null;
}

export function transformToFinanceRow(event: GammaEvent): FinanceMarketRow {
  const tags = event.tags || [];
  const tagSlugs = tags.map(t => t.slug);
  const timeframe = extractTimeframe(tags);
  const asset = extractAsset(tags);

  const markets = (event.markets || []).map(transformMarketToSSR);

  return {
    id: event.id,
    ticker: event.ticker,
    slug: event.slug,
    title: event.title,
    description: event.description ?? null,
    resolution_source: event.resolutionSource ?? null,
    start_date: event.startDate ?? null,
    end_date: event.endDate ?? null,
    image: event.image ?? null,
    image_raw: event.image ?? null,
    icon: event.icon ?? null,
    active: event.active ?? true,
    closed: event.closed ?? false,
    archived: event.archived ?? false,
    new: event.new ?? false,
    featured: event.featured ?? false,
    restricted: event.restricted ?? false,
    liquidity: event.liquidity ?? null,
    volume: event.volume ?? null,
    open_interest: event.openInterest ?? null,
    competitive: event.competitive ?? null,
    enable_order_book: event.enableOrderBook ?? true,
    liquidity_clob: event.liquidityClob ?? null,
    neg_risk: event.negRisk ?? false,
    comment_count: event.commentCount ?? 0,
    cyom: event.cyom ?? false,
    show_all_outcomes: event.showAllOutcomes ?? true,
    show_market_images: event.showMarketImages ?? true,
    automatically_active: event.automaticallyActive ?? true,
    neg_risk_augmented: event.negRiskAugmented ?? false,
    pending_deployment: event.pendingDeployment ?? false,
    deploying: event.deploying ?? false,
    is_live: false,
    start_time: event.startTime ?? null,
    series_slug: event.seriesSlug ?? null,
    timeframe,
    asset,
    tags: tagSlugs,
    markets,
    series: event.series ?? null,
    tags_data: tags.length > 0 ? tags : null,
    raw_data: event,
    opening_price: null,
  };
}

async function fetchAllFinanceEvents(): Promise<GammaEvent[]> {
  const allEvents: GammaEvent[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await polymarketClient.get<{ data?: GammaEvent[] } | GammaEvent[]>(
      '/events/pagination',
      {
        tag_id: FINANCE_TAG_ID,
        active: true,
        closed: false,
        limit: PAGE_LIMIT,
        offset,
        order: 'volume24hr',
        ascending: false,
      },
    );

    const raw = response as { data?: GammaEvent[] } | GammaEvent[];
    const events: GammaEvent[] = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);

    if (events.length === 0) {
      hasMore = false;
    } else {
      allEvents.push(...events);
      offset += PAGE_LIMIT;
      if (events.length < PAGE_LIMIT) {
        hasMore = false;
      }
    }
  }

  return allEvents;
}

async function storeFinanceMarketsInDatabase(rows: FinanceMarketRow[]): Promise<void> {
  if (rows.length === 0) return;

  const byId = new Map<string, FinanceMarketRow>();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  const deduped = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));

  const batches: { values: any[]; placeholders: string }[] = [];

  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE);
    const values: any[] = [];
    const placeholderRows: string[] = [];
    let paramIndex = 1;

    for (const row of batch) {
      const rowPlaceholders: string[] = [];
      for (let j = 0; j < COLUMN_COUNT; j++) {
        rowPlaceholders.push(`$${paramIndex++}`);
      }
      rowPlaceholders.push('CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP');
      placeholderRows.push(`(${rowPlaceholders.join(', ')})`);

      values.push(
        row.id, row.ticker, row.slug, row.title, row.description, row.resolution_source,
        row.start_date, row.end_date, row.image, row.image_raw, row.icon,
        row.active, row.closed, row.archived, row.new, row.featured, row.restricted,
        row.liquidity, row.volume, row.open_interest, row.competitive,
        row.enable_order_book, row.liquidity_clob, row.neg_risk, row.comment_count,
        row.cyom, row.show_all_outcomes, row.show_market_images,
        row.automatically_active, row.neg_risk_augmented, row.pending_deployment, row.deploying,
        row.is_live, row.start_time, row.series_slug,
        row.timeframe, row.asset, row.tags,
        JSON.stringify(row.markets), JSON.stringify(row.series),
        JSON.stringify(row.tags_data), JSON.stringify(row.raw_data),
        row.opening_price,
      );
    }

    batches.push({
      values,
      placeholders: placeholderRows.join(', '),
    });
  }

  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { values, placeholders } of batches) {
        const query = INSERT_QUERY.replace('%PLACEHOLDERS%', placeholders);
        await client.query(query, values);
      }
      await client.query('COMMIT');
      return;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      lastError = error instanceof Error ? error : new Error(String(error));
      const isDeadlock = /deadlock detected/i.test(lastError.message);
      if (isDeadlock && attempt < maxRetries - 1) {
        const delayMs = 100 * Math.pow(2, attempt);
        logger.warn({
          message: 'Finance markets store deadlock, retrying',
          attempt: attempt + 1,
          maxRetries,
          delayMs,
        });
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw lastError;
      }
    } finally {
      client.release();
    }
  }

  throw lastError || new Error('Failed to store finance markets');
}

async function refreshFinanceMarkets(): Promise<void> {
  try {
    const events = await fetchAllFinanceEvents();

    if (events.length === 0) {
      return;
    }

    const rows = events.map(transformToFinanceRow);
    await storeFinanceMarketsInDatabase(rows);
    lastRefreshAt = new Date();
  } catch (error) {
    logger.error({
      message: 'Failed to refresh finance markets',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

let refreshInterval: NodeJS.Timeout | null = null;
let lastRefreshAt: Date | null = null;

async function getFinanceMarketsStatus(): Promise<{
  count: number;
  lastRefreshAt: string | null;
  refreshIntervalMs: number;
}> {
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv !== 'production') {
    return { count: 0, lastRefreshAt: null, refreshIntervalMs: REFRESH_INTERVAL_MS };
  }

  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT COUNT(*) as c FROM finance_markets WHERE active = true AND closed = false`
    );
    const count = parseInt(r.rows[0]?.c ?? '0', 10);
    return {
      count,
      lastRefreshAt: lastRefreshAt?.toISOString() ?? null,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
    };
  } finally {
    client.release();
  }
}

function start(): void {
  logger.info({ message: 'Starting finance markets service (4h refresh interval)' });

  refreshFinanceMarkets().catch(err => {
    logger.warn({
      message: 'Initial finance markets fetch failed',
      error: err instanceof Error ? err.message : String(err),
    });
  });

  refreshInterval = setInterval(() => {
    refreshFinanceMarkets().catch(err => {
      logger.error({
        message: 'Scheduled finance markets refresh failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, REFRESH_INTERVAL_MS);
}

function stop(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

export const financeMarketsService = {
  start,
  stop,
  refreshFinanceMarkets,
  getFinanceMarketsStatus,
};
