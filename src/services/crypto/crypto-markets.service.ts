/**
 * Crypto Markets Service
 * Fetches all crypto events from Polymarket Gamma API, transforms to SSR-compatible format,
 * and bulk upserts into the crypto_markets table. Auto-refreshes every 1 hour.
 */

import { pool } from '../../config/database';
import { logger } from '../../config/logger';
import { polymarketClient } from '../polymarket/polymarket.client';

// Gamma API tag ID for "Crypto"
const CRYPTO_TAG_ID = 21;
const PAGE_LIMIT = 100;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BATCH_SIZE = 500;

// Known timeframe tag slugs for categorization
const TIMEFRAME_TAGS = new Set([
  '5M', '15M', '1H', '4h', 'daily', 'weekly', 'monthly', 'yearly', 'pre-market', 'etf',
]);

// Known asset tag slugs for categorization
const ASSET_TAGS = new Set([
  'bitcoin', 'ethereum', 'solana', 'xrp', 'dogecoin', 'microstrategy',
  'cardano', 'chainlink', 'polkadot', 'avalanche', 'polygon', 'litecoin',
  'uniswap', 'aave', 'sui', 'pepe', 'shiba-inu', 'tron', 'stellar',
  'hedera', 'near', 'aptos', 'arbitrum', 'optimism', 'cosmos',
  'filecoin', 'render', 'injective', 'bonk', 'floki', 'wif',
  'trump', 'melania', 'fartcoin', 'ai16z', 'virtual', 'griffain',
]);

// Null fields present in SSR but not in Gamma API
const SSR_NULL_FIELDS = {
  amm_type: null,
  denomination_token: null,
  lower_bound: null,
  lower_bound_date: null,
  market_type: null,
  upper_bound: null,
  upper_bound_date: null,
  wide_format: null,
  x_axis_value: null,
  y_axis_value: null,
};

// Types
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
  outcomes: string; // JSON string
  outcomePrices: string; // JSON string
  clobTokenIds: string; // JSON string
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

interface GammaPaginationResponse {
  data: GammaEvent[];
  count?: number;
  next_cursor?: string;
}

interface CryptoMarketRow {
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

// Column count for parameterized insert
const COLUMN_COUNT = 43;

const INSERT_QUERY = `
  INSERT INTO crypto_markets (
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
    opening_price = COALESCE(crypto_markets.opening_price, EXCLUDED.opening_price),
    updated_at = CURRENT_TIMESTAMP
`;

/**
 * Transform a Gamma market object to SSR-compatible format.
 * Parses JSON string fields (outcomes, outcomePrices, clobTokenIds) into arrays
 * and adds snake_case aliases + null SSR fields.
 */
export function transformMarketToSSR(market: GammaMarket): any {
  const transformed: any = { ...market };

  // Parse JSON string fields into arrays
  for (const field of ['outcomes', 'outcomePrices', 'clobTokenIds']) {
    if (typeof transformed[field] === 'string') {
      try {
        transformed[field] = JSON.parse(transformed[field]);
      } catch {
        // Keep as-is if parse fails
      }
    }
  }

  // Add snake_case aliases
  transformed.created_at = market.createdAt ?? null;
  transformed.end_date = market.endDate ?? null;
  transformed.resolution_source = market.resolutionSource ?? null;
  transformed.updated_at = market.updatedAt ?? null;
  transformed.liquidity_num = market.liquidityNum ?? null;
  transformed.volume_num = market.volumeNum ?? null;
  transformed.closed_time = market.closedTime ?? null;
  transformed.resolved_by = market.resolvedBy ?? null;

  // Add null fields present in SSR but not Gamma
  Object.assign(transformed, SSR_NULL_FIELDS);

  return transformed;
}

/**
 * Extract timeframe from event tags
 */
function extractTimeframe(tags: GammaTag[]): string | null {
  for (const tag of tags) {
    if (TIMEFRAME_TAGS.has(tag.slug)) return tag.slug;
    if (TIMEFRAME_TAGS.has(tag.label)) return tag.label;
  }
  return null;
}

/**
 * Extract asset from event tags
 */
function extractAsset(tags: GammaTag[]): string | null {
  for (const tag of tags) {
    if (ASSET_TAGS.has(tag.slug)) return tag.slug;
  }
  return null;
}

/**
 * Transform a Gamma event to a CryptoMarketRow for database storage
 */
export function transformToSSRFormat(event: GammaEvent): CryptoMarketRow {
  const tags = event.tags || [];
  const tagSlugs = tags.map(t => t.slug);
  const timeframe = extractTimeframe(tags);
  const asset = extractAsset(tags);

  // Transform markets to SSR format
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

/**
 * Fetch all crypto events from Gamma API with pagination
 */
export async function fetchAllCryptoEvents(): Promise<GammaEvent[]> {
  const allEvents: GammaEvent[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await polymarketClient.get<{ data?: GammaEvent[] } | GammaEvent[]>(
      '/events/pagination',
      {
        tag_id: CRYPTO_TAG_ID,
        active: true,
        closed: false,
        limit: PAGE_LIMIT,
        offset,
        order: 'volume24hr',
        ascending: false,
      },
    );

    // Gamma API returns { data: [...] } for /events/pagination
    const raw = response as { data?: GammaEvent[] } | GammaEvent[];
    const events: GammaEvent[] = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);

    if (events.length === 0) {
      hasMore = false;
    } else {
      allEvents.push(...events);
      offset += PAGE_LIMIT;

      // Safety: if we got less than PAGE_LIMIT, we've reached the end
      if (events.length < PAGE_LIMIT) {
        hasMore = false;
      }
    }
  }

  return allEvents;
}

/**
 * Bulk upsert crypto market rows into the database.
 * Deduplicates by id to avoid "ON CONFLICT DO UPDATE cannot affect row a second time" when Gamma returns same event multiple times.
 */
export async function storeCryptoMarketsInDatabase(rows: CryptoMarketRow[]): Promise<void> {
  if (rows.length === 0) return;

  // Dedupe by id (last occurrence wins) - Gamma can return same event in multiple pages
  const byId = new Map<string, CryptoMarketRow>();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  const deduped = Array.from(byId.values());

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
      // created_at and updated_at use CURRENT_TIMESTAMP
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

  // Connect only when ready to write
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const { values, placeholders } of batches) {
      const query = INSERT_QUERY.replace('%PLACEHOLDERS%', placeholders);
      await client.query(query, values);
    }

    await client.query('COMMIT');

    logger.info({
      message: 'Crypto markets stored in database',
      count: deduped.length,
      batches: batches.length,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Fetch, transform, and store all crypto markets
 */
export async function refreshCryptoMarkets(): Promise<void> {
  try {
    logger.info({ message: 'Refreshing crypto markets from Gamma API...' });

    const events = await fetchAllCryptoEvents();
    logger.info({ message: 'Fetched crypto events from Gamma API', count: events.length });

    if (events.length === 0) {
      logger.warn({ message: 'No crypto events fetched from Gamma API' });
      return;
    }

    const rows = events.map(transformToSSRFormat);
    await storeCryptoMarketsInDatabase(rows);

    lastRefreshAt = new Date();
    logger.info({ message: 'Crypto markets refresh complete', count: rows.length });
  } catch (error) {
    logger.error({
      message: 'Failed to refresh crypto markets',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

let refreshInterval: NodeJS.Timeout | null = null;
let lastRefreshAt: Date | null = null;

/**
 * Get crypto markets count from DB and service status
 */
export async function getCryptoMarketsStatus(): Promise<{
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
      `SELECT COUNT(*) as c FROM crypto_markets WHERE active = true AND closed = false`
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

/**
 * Start the crypto markets polling service
 */
function start(): void {
  logger.info({ message: 'Starting crypto markets service (1h refresh interval)' });

  // Initial fetch (non-blocking)
  refreshCryptoMarkets().catch(err => {
    logger.warn({
      message: 'Initial crypto markets fetch failed',
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Schedule periodic refresh
  refreshInterval = setInterval(() => {
    refreshCryptoMarkets().catch(err => {
      logger.error({
        message: 'Scheduled crypto markets refresh failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, REFRESH_INTERVAL_MS);
}

/**
 * Stop the crypto markets polling service
 */
function stop(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
    logger.info({ message: 'Crypto markets service stopped' });
  }
}

export const cryptoMarketsService = {
  start,
  stop,
  refreshCryptoMarkets,
  getCryptoMarketsStatus,
};
