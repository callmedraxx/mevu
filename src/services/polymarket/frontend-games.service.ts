import { PoolClient } from 'pg';
import { pool, connectWithRetry } from '../../config/database';
import { logger } from '../../config/logger';
import { LiveGame } from './live-games.service';
import { FrontendGame, transformToFrontendGame, KalshiPriceData } from './frontend-game.transformer';
import { loadFromDatabase as loadUfcFighterRecords } from '../ufc/ufc-fighter-records.service';
import { publishCacheInvalidation, subscribeToGamesBroadcast, initRedisClusterBroadcast } from '../redis-cluster-broadcast.service';
import { kalshiService } from '../kalshi';

// In-memory cache for frontend games to handle burst traffic
// Cache key: JSON stringified options
// Cache TTL: 5 seconds
interface CacheEntry {
  data: FrontendGame[];
  timestamp: number;
}

const frontendGamesCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5000; // 5 seconds
const MAX_GAMES_LIMIT = 1000; // Maximum games to return per query

/**
 * Compute sort_timestamp for chronological ordering: date from slug + time from endDate.
 * Games are ordered by when they're played (soonest first).
 */
function computeSortTimestamp(fg: FrontendGame): Date | null {
  const slugDateMatch = fg.slug?.match(/(\d{4}-\d{2}-\d{2})$/);
  const slugDate = slugDateMatch ? slugDateMatch[1] : null;
  const endDateStr = fg.endDate;

  if (slugDate && endDateStr) {
    try {
      const endDate = new Date(endDateStr);
      if (!isNaN(endDate.getTime())) {
        const timePart = endDateStr.includes('T')
          ? endDateStr.split('T')[1]?.replace(/Z$/, '') || '00:00:00.000'
          : '00:00:00.000';
        const combined = new Date(slugDate + 'T' + timePart + 'Z');
        return isNaN(combined.getTime()) ? new Date(slugDate + 'T00:00:00.000Z') : combined;
      }
    } catch {
      /* fall through */
    }
  }
  if (slugDate) {
    return new Date(slugDate + 'T00:00:00.000Z');
  }
  if (endDateStr) {
    try {
      const d = new Date(endDateStr);
      return isNaN(d.getTime()) ? null : d;
    } catch {
      return null;
    }
  }
  return null;
}

/** Pending single-game upserts for batched flush (reduces lock contention) */
const pendingUpserts = new Map<string, FrontendGame>();
let upsertFlushTimer: NodeJS.Timeout | null = null;
const UPSERT_BATCH_DELAY_MS = 100;

async function flushPendingUpserts(): Promise<void> {
  if (pendingUpserts.size === 0) return;

  const games = Array.from(pendingUpserts.values());
  pendingUpserts.clear();

  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv !== 'production') return;

  // Build all chunks BEFORE connecting (no connection held during prep)
  const fallbackSort = new Date('2099-12-31T23:59:59.999Z');
  const BATCH_SIZE = 50; // Max rows per INSERT to keep query fast
  const chunks: { query: string; values: unknown[] }[] = [];

  for (let i = 0; i < games.length; i += BATCH_SIZE) {
    const chunk = games.slice(i, i + BATCH_SIZE);
    const valuesClauses: string[] = [];
    const values: unknown[] = [];
    chunk.forEach((game, idx) => {
      const sortTs = computeSortTimestamp(game) ?? fallbackSort;
      const base = idx * 8;
      valuesClauses.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, CURRENT_TIMESTAMP, $${base + 7}, $${base + 8})`
      );
      values.push(
        game.id,
        game.sport ? game.sport.toLowerCase() : null,
        game.league || null,
        game.slug || null,
        game.isLive ?? null,
        game.ended ?? null,
        JSON.stringify(game),
        sortTs
      );
    });
    // ALWAYS preserve existing Kalshi prices by merging them into new data
    // The COALESCE ensures we keep existing Kalshi prices if new data doesn't have them
    const query = `
      INSERT INTO frontend_games (id, sport, league, slug, live, ended, updated_at, frontend_data, sort_timestamp)
      VALUES ${valuesClauses.join(', ')}
      ON CONFLICT (id) DO UPDATE SET
        sport = EXCLUDED.sport,
        league = EXCLUDED.league,
        slug = EXCLUDED.slug,
        live = EXCLUDED.live,
        ended = EXCLUDED.ended,
        updated_at = CURRENT_TIMESTAMP,
        frontend_data = jsonb_set(
          jsonb_set(
            EXCLUDED.frontend_data,
            '{awayTeam}',
            COALESCE(EXCLUDED.frontend_data->'awayTeam', '{}'::jsonb) || 
              jsonb_build_object(
                'kalshiBuyPrice', COALESCE(
                  EXCLUDED.frontend_data->'awayTeam'->'kalshiBuyPrice',
                  frontend_games.frontend_data->'awayTeam'->'kalshiBuyPrice'
                ),
                'kalshiSellPrice', COALESCE(
                  EXCLUDED.frontend_data->'awayTeam'->'kalshiSellPrice',
                  frontend_games.frontend_data->'awayTeam'->'kalshiSellPrice'
                )
              )
          ),
          '{homeTeam}',
          COALESCE(EXCLUDED.frontend_data->'homeTeam', '{}'::jsonb) || 
            jsonb_build_object(
              'kalshiBuyPrice', COALESCE(
                EXCLUDED.frontend_data->'homeTeam'->'kalshiBuyPrice',
                frontend_games.frontend_data->'homeTeam'->'kalshiBuyPrice'
              ),
              'kalshiSellPrice', COALESCE(
                EXCLUDED.frontend_data->'homeTeam'->'kalshiSellPrice',
                frontend_games.frontend_data->'homeTeam'->'kalshiSellPrice'
              )
            )
        ),
        sort_timestamp = EXCLUDED.sort_timestamp
    `;
    chunks.push({ query, values });
  }

  if (chunks.length === 0) return;

  // Connect only when ready to write
  const client = await connectWithRetry();
  try {
    for (const { query, values } of chunks) {
      await client.query(query, values);
    }
    frontendGamesCache.clear();
  } catch (error) {
    logger.error({
      message: 'Error flushing batched frontend game upserts',
      count: games.length,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    client.release();
  }
}

/**
 * Upsert a single frontend game (batched to reduce lock contention).
 * Used when a game gets partial updates (live status, probability, etc.) from WebSocket/CLOB.
 */
export async function upsertFrontendGame(frontendGame: FrontendGame): Promise<void> {
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv !== 'production') return;

  pendingUpserts.set(frontendGame.id, frontendGame);

  if (!upsertFlushTimer) {
    upsertFlushTimer = setTimeout(() => {
      upsertFlushTimer = null;
      flushPendingUpserts().catch((err) =>
        logger.error({
          message: 'Error in flushPendingUpserts',
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }, UPSERT_BATCH_DELAY_MS);
  }
}

/** Clear the frontend games API cache (e.g. after batch upserts). */
export function clearFrontendGamesCache(): void {
  frontendGamesCache.clear();
  // Notify other workers to clear their caches too (Redis pub/sub)
  publishCacheInvalidation('frontend_games').catch(() => {});
}

/** Clear only local cache (called by Redis subscriber to avoid infinite loop) */
function clearLocalFrontendGamesCache(): void {
  frontendGamesCache.clear();
}

/**
 * Initialize Redis subscription for cache invalidation messages.
 * Call this once during app startup on all HTTP workers.
 */
export function initFrontendGamesCacheSync(): void {
  if (!initRedisClusterBroadcast()) return;
  
  subscribeToGamesBroadcast((msg) => {
    if ((msg as { type?: string }).type === 'cache_invalidate') {
      clearLocalFrontendGamesCache();
      logger.debug({ message: 'Frontend games cache cleared via Redis broadcast' });
    }
  });
  
  logger.info({ message: 'Frontend games cache sync initialized' });
}

/**
 * Bulk upsert frontend games using an existing client (for use within a transaction).
 * Does not release the client or clear the cache - caller must handle that.
 */
export async function bulkUpsertFrontendGamesWithClient(
  client: PoolClient,
  games: FrontendGame[]
): Promise<void> {
  if (games.length === 0) return;
  const fallbackSort = new Date('2099-12-31T23:59:59.999Z');
  const BATCH_SIZE = 50;
  for (let i = 0; i < games.length; i += BATCH_SIZE) {
    const chunk = games.slice(i, i + BATCH_SIZE);
    const valuesClauses: string[] = [];
    const values: unknown[] = [];
    chunk.forEach((game, idx) => {
      const sortTs = computeSortTimestamp(game) ?? fallbackSort;
      const base = idx * 8;
      valuesClauses.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, CURRENT_TIMESTAMP, $${base + 7}, $${base + 8})`
      );
      values.push(
        game.id,
        game.sport ? game.sport.toLowerCase() : null,
        game.league || null,
        game.slug || null,
        game.isLive ?? null,
        game.ended ?? null,
        JSON.stringify(game),
        sortTs
      );
    });
    // Merge frontend_data to preserve existing Kalshi prices that aren't in the new data
    // EXCLUDED.frontend_data is the new data, frontend_games.frontend_data is existing
    // We use jsonb || to merge, with special handling for nested team objects
    const query = `
      INSERT INTO frontend_games (id, sport, league, slug, live, ended, updated_at, frontend_data, sort_timestamp)
      VALUES ${valuesClauses.join(', ')}
      ON CONFLICT (id) DO UPDATE SET
        sport = EXCLUDED.sport,
        league = EXCLUDED.league,
        slug = EXCLUDED.slug,
        live = EXCLUDED.live,
        ended = EXCLUDED.ended,
        updated_at = CURRENT_TIMESTAMP,
        frontend_data = CASE
          -- If existing has Kalshi prices but new data doesn't, preserve them
          WHEN (frontend_games.frontend_data->'awayTeam'->>'kalshiBuyPrice') IS NOT NULL 
               AND (EXCLUDED.frontend_data->'awayTeam'->>'kalshiBuyPrice') IS NULL
          THEN jsonb_set(
            jsonb_set(
              EXCLUDED.frontend_data,
              '{awayTeam}',
              (EXCLUDED.frontend_data->'awayTeam') || 
                jsonb_build_object(
                  'kalshiBuyPrice', frontend_games.frontend_data->'awayTeam'->'kalshiBuyPrice',
                  'kalshiSellPrice', frontend_games.frontend_data->'awayTeam'->'kalshiSellPrice'
                )
            ),
            '{homeTeam}',
            (EXCLUDED.frontend_data->'homeTeam') || 
              jsonb_build_object(
                'kalshiBuyPrice', frontend_games.frontend_data->'homeTeam'->'kalshiBuyPrice',
                'kalshiSellPrice', frontend_games.frontend_data->'homeTeam'->'kalshiSellPrice'
              )
          )
          ELSE EXCLUDED.frontend_data
        END,
        sort_timestamp = EXCLUDED.sort_timestamp
    `;
    await client.query(query, values);
  }
}

/**
 * Upsert a single frontend game using an existing client (for batching in a transaction).
 * Does not release the client or clear the cache - caller must handle that.
 */
export async function upsertFrontendGameWithClient(
  client: PoolClient,
  frontendGame: FrontendGame
): Promise<void> {
  const sortTs = computeSortTimestamp(frontendGame) ?? new Date('2099-12-31T23:59:59.999Z');
  // ALWAYS preserve existing Kalshi prices by merging them into new data
  await client.query(
    `INSERT INTO frontend_games (id, sport, league, slug, live, ended, updated_at, frontend_data, sort_timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       sport          = EXCLUDED.sport,
       league         = EXCLUDED.league,
       slug           = EXCLUDED.slug,
       live           = EXCLUDED.live,
       ended          = EXCLUDED.ended,
       updated_at     = CURRENT_TIMESTAMP,
       frontend_data  = jsonb_set(
         jsonb_set(
           EXCLUDED.frontend_data,
           '{awayTeam}',
           COALESCE(EXCLUDED.frontend_data->'awayTeam', '{}'::jsonb) || 
             jsonb_build_object(
               'kalshiBuyPrice', COALESCE(
                 EXCLUDED.frontend_data->'awayTeam'->'kalshiBuyPrice',
                 frontend_games.frontend_data->'awayTeam'->'kalshiBuyPrice'
               ),
               'kalshiSellPrice', COALESCE(
                 EXCLUDED.frontend_data->'awayTeam'->'kalshiSellPrice',
                 frontend_games.frontend_data->'awayTeam'->'kalshiSellPrice'
               )
             )
         ),
         '{homeTeam}',
         COALESCE(EXCLUDED.frontend_data->'homeTeam', '{}'::jsonb) || 
           jsonb_build_object(
             'kalshiBuyPrice', COALESCE(
               EXCLUDED.frontend_data->'homeTeam'->'kalshiBuyPrice',
               frontend_games.frontend_data->'homeTeam'->'kalshiBuyPrice'
             ),
             'kalshiSellPrice', COALESCE(
               EXCLUDED.frontend_data->'homeTeam'->'kalshiSellPrice',
               frontend_games.frontend_data->'homeTeam'->'kalshiSellPrice'
             )
           )
       ),
       sort_timestamp = EXCLUDED.sort_timestamp`,
    [
      frontendGame.id,
      frontendGame.sport ? frontendGame.sport.toLowerCase() : null,
      frontendGame.league || null,
      frontendGame.slug || null,
      frontendGame.isLive ?? null,
      frontendGame.ended ?? null,
      frontendGame,
      sortTs,
    ]
  );
}

/**
 * Upsert a single LiveGame to frontend_games (transforms first).
 * Used when Sports WebSocket sends live/ended/score/period updates.
 * Fetches Kalshi data to preserve pricing info during live updates.
 */
export async function upsertFrontendGameForLiveGame(liveGame: LiveGame): Promise<void> {
  try {
    // Fetch Kalshi prices for this game to preserve pricing during live updates
    let kalshiData: KalshiPriceData | undefined;
    try {
      const kalshiPricesMap = await kalshiService.getKalshiPricesForGames([liveGame.id]);
      kalshiData = kalshiPricesMap.get(liveGame.id);
    } catch (error) {
      // Continue without Kalshi data if fetch fails
      logger.debug({
        message: 'Failed to fetch Kalshi prices for single game update',
        gameId: liveGame.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    
    const frontendGame = await transformToFrontendGame(liveGame, undefined, kalshiData);
    await upsertFrontendGame(frontendGame);
  } catch (error) {
    logger.error({
      message: 'Error upserting frontend game for live game update',
      gameId: liveGame.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 8 params/row × 500 = 4k params, well under 65k limit */
const BULK_UPSERT_CHUNK_SIZE = 500;

// ALWAYS preserve existing Kalshi prices by merging them into new data using COALESCE
const FRONTEND_UPSERT_QUERY = `
  INSERT INTO frontend_games (id, sport, league, slug, live, ended, updated_at, frontend_data, sort_timestamp)
  VALUES %PLACEHOLDERS%
  ON CONFLICT (id) DO UPDATE SET
    sport = EXCLUDED.sport,
    league = EXCLUDED.league,
    slug = EXCLUDED.slug,
    live = EXCLUDED.live,
    ended = EXCLUDED.ended,
    updated_at = CURRENT_TIMESTAMP,
    frontend_data = jsonb_set(
      jsonb_set(
        EXCLUDED.frontend_data,
        '{awayTeam}',
        COALESCE(EXCLUDED.frontend_data->'awayTeam', '{}'::jsonb) || 
          jsonb_build_object(
            'kalshiBuyPrice', COALESCE(EXCLUDED.frontend_data->'awayTeam'->'kalshiBuyPrice', frontend_games.frontend_data->'awayTeam'->'kalshiBuyPrice'),
            'kalshiSellPrice', COALESCE(EXCLUDED.frontend_data->'awayTeam'->'kalshiSellPrice', frontend_games.frontend_data->'awayTeam'->'kalshiSellPrice')
          )
      ),
      '{homeTeam}',
      COALESCE(EXCLUDED.frontend_data->'homeTeam', '{}'::jsonb) || 
        jsonb_build_object(
          'kalshiBuyPrice', COALESCE(EXCLUDED.frontend_data->'homeTeam'->'kalshiBuyPrice', frontend_games.frontend_data->'homeTeam'->'kalshiBuyPrice'),
          'kalshiSellPrice', COALESCE(EXCLUDED.frontend_data->'homeTeam'->'kalshiSellPrice', frontend_games.frontend_data->'homeTeam'->'kalshiSellPrice')
        )
    ),
    sort_timestamp = EXCLUDED.sort_timestamp
`;

/**
 * Upsert a batch of transformed frontend games into the frontend_games table.
 * Uses bulk INSERT instead of sequential inserts to minimize lock duration.
 * Connection acquired only when ready to write.
 */
export async function upsertFrontendGamesForLiveGames(games: LiveGame[]): Promise<void> {
  if (!games || games.length === 0) return;

  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv !== 'production') return;

  // Ensure UFC fighter record cache is warm from DB before transforming
  const hasUfc = games.some(
    (g) =>
      (g.sport?.toLowerCase() === 'ufc' || g.league?.toLowerCase() === 'ufc')
  );
  if (hasUfc) {
    await loadUfcFighterRecords();
  }

  // Batch-fetch Kalshi prices for all games (single DB query)
  const gameIds = games.map(g => g.id);
  let kalshiPricesMap: Map<string, KalshiPriceData> = new Map();
  try {
    kalshiPricesMap = await kalshiService.getKalshiPricesForGames(gameIds);
    if (kalshiPricesMap.size > 0) {
      logger.debug({
        message: 'Fetched Kalshi prices for games batch',
        matchedCount: kalshiPricesMap.size,
        totalGames: games.length,
      });
    }
  } catch (error) {
    logger.warn({
      message: 'Error fetching Kalshi prices for games (continuing without)',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Transform all games with Kalshi data (no connection held)
  const transformed: FrontendGame[] = [];
  for (const game of games) {
    try {
      const kalshiData = kalshiPricesMap.get(game.id);
      const fg = await transformToFrontendGame(game, undefined, kalshiData);
      transformed.push(fg);
    } catch (error) {
      logger.error({
        message: 'Error transforming game to frontend format for upsert',
        gameId: game.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (transformed.length === 0) return;

  // Build all chunks before connecting (no connection held)
  const fallbackSort = new Date('2099-12-31T23:59:59.999Z');
  const chunks: { query: string; values: unknown[] }[] = [];

  for (let i = 0; i < transformed.length; i += BULK_UPSERT_CHUNK_SIZE) {
    const chunk = transformed.slice(i, i + BULK_UPSERT_CHUNK_SIZE);
    const valuesClauses: string[] = [];
    const values: unknown[] = [];

    chunk.forEach((game, idx) => {
      const sortTs = computeSortTimestamp(game) ?? fallbackSort;
      const base = idx * 8;
      valuesClauses.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, CURRENT_TIMESTAMP, $${base + 7}, $${base + 8})`
      );
      values.push(
        game.id,
        game.sport ? game.sport.toLowerCase() : null,
        game.league || null,
        game.slug || null,
        game.isLive ?? null,
        game.ended ?? null,
        JSON.stringify(game),
        sortTs
      );
    });

    chunks.push({
      query: FRONTEND_UPSERT_QUERY.replace('%PLACEHOLDERS%', valuesClauses.join(', ')),
      values,
    });
  }

  // Connect only when ready to write
  const client = await connectWithRetry();
  try {
    for (const { query, values } of chunks) {
      await client.query(query, values);
    }
    frontendGamesCache.clear();
    logger.info({
      message: 'Bulk upserted frontend games to database',
      count: transformed.length,
    });
  } catch (error) {
    logger.error({
      message: 'Error bulk upserting frontend games to database',
      error: error instanceof Error ? error.message : String(error),
      gameCount: transformed.length,
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Fetch precomputed frontend games from the frontend_games table with optional filters and pagination.
 * This is used by /api/games/frontend to avoid per-request transformation.
 * Includes in-memory caching to handle burst traffic efficiently.
 */
export interface PaginatedGamesResult {
  games: FrontendGame[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Get a single frontend game by ID from the frontend_games table.
 * Returns null if not found.
 */
export async function getFrontendGameByIdFromDatabase(id: string): Promise<FrontendGame | null> {
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv !== 'production') {
    return null;
  }

  const client = await connectWithRetry();
  try {
    const result = await client.query(
      `SELECT frontend_data FROM frontend_games WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return null;
    }
    return result.rows[0].frontend_data as FrontendGame;
  } finally {
    client.release();
  }
}

/**
 * Get a single frontend game by slug from the frontend_games table.
 * Returns null if not found.
 */
export async function getFrontendGameBySlugFromDatabase(slug: string): Promise<FrontendGame | null> {
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv !== 'production') {
    return null;
  }

  const client = await connectWithRetry();
  try {
    const result = await client.query(
      `SELECT frontend_data FROM frontend_games WHERE LOWER(slug) = LOWER($1)`,
      [slug]
    );
    if (result.rows.length === 0) {
      return null;
    }
    return result.rows[0].frontend_data as FrontendGame;
  } finally {
    client.release();
  }
}

export async function getFrontendGamesFromDatabase(options: {
  sport?: string | null;
  live?: 'true' | 'false' | null;
  includeEnded?: 'true' | 'false' | null;
  page?: number;
  limit?: number;
}): Promise<PaginatedGamesResult> {
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv !== 'production') {
    // In development, fallback to empty to avoid accidental DB usage
    return {
      games: [],
      total: 0,
      page: 1,
      limit: 50,
      hasMore: false,
    };
  }

  const { sport, live, includeEnded, page = 1, limit = 50 } = options;
  const offset = (page - 1) * limit;

  // Check cache first (only for unfiltered queries without pagination to maximize cache hit rate)
  // Don't cache paginated queries as they're less common
  const isUnfilteredUnpaginated = !sport && !live && includeEnded !== 'true' && page === 1 && limit === 50;
  const cacheKey = JSON.stringify(options);
  const cached = frontendGamesCache.get(cacheKey);
  const now = Date.now();
  
  if (isUnfilteredUnpaginated && cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return {
      games: cached.data,
      total: cached.data.length,
      page: 1,
      limit: 50,
      hasMore: cached.data.length >= limit,
    };
  }

  const client = await connectWithRetry();

  try {
    const params: any[] = [];
    const where: string[] = [];

    // Sport filter: "soccer" means EPL + LAL; otherwise single sport
    if (sport) {
      const sportLower = sport.toLowerCase();
      if (sportLower === 'soccer') {
        where.push(`sport IN ('epl', 'lal')`);
      } else {
        params.push(sportLower);
        where.push(`sport = $${params.length}`);
      }
    }

    if (live === 'true') {
      params.push(true);
      where.push(`live = $${params.length}`);
    } else if (live === 'false') {
      params.push(false);
      where.push(`live = $${params.length}`);
    }

    if (includeEnded !== 'true') {
      // Default: exclude ended games (stored ended flag + past endDate+grace so stale rows are excluded)
      where.push(`(ended = false OR ended IS NULL)`);
      // Exclude games past endDate + 5h grace (handles stale ended=false, e.g. tennis games not yet updated)
      where.push(`(
        frontend_data->>'endDate' IS NULL
        OR (frontend_data->>'endDate')::timestamptz + interval '5 hours' >= now()
      )`);
    }

    // Exclude duplicate -more-markets entries (same game, placeholder odds)
    where.push(`(slug IS NULL OR slug NOT LIKE '%-more-markets')`);

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // First, get total count for pagination metadata
    const countQuery = `
      SELECT COUNT(*) as total
      FROM frontend_games
      ${whereClause}
    `;
    const countParams = params.slice(); // Copy params for count query
    const countResult = await client.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total, 10);

    // Then fetch paginated results
    params.push(limit);
    params.push(offset);
    const limitParamIndex = params.length - 1;
    const offsetParamIndex = params.length;
    const query = `
      SELECT frontend_data
      FROM frontend_games
      ${whereClause}
      ORDER BY sort_timestamp ASC NULLS LAST
      LIMIT $${limitParamIndex}
      OFFSET $${offsetParamIndex}
    `;

    const result = await client.query(query, params);

    const games = result.rows.map((row: any) => row.frontend_data as FrontendGame);
    const hasMore = offset + games.length < total;
    
    // Cache the result (only cache unfiltered, unpaginated queries)
    if (isUnfilteredUnpaginated) {
      frontendGamesCache.set(cacheKey, {
        data: games,
        timestamp: now,
      });
      
      // Clean up old cache entries periodically
      if (frontendGamesCache.size > 10) {
        for (const [key, entry] of frontendGamesCache.entries()) {
          if (now - entry.timestamp >= CACHE_TTL_MS) {
            frontendGamesCache.delete(key);
          }
        }
      }
    }

    return {
      games,
      total,
      page,
      limit,
      hasMore,
    };
  } finally {
    client.release();
  }
}

