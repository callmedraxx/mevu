/**
 * Sports Games Sync Service
 * Background service that syncs all upcoming sports games to the database every 20 minutes
 * The /api/polymarket/sports/all endpoint reads from DB with pagination support
 */

import { pool } from '../../config/database';
import { logger } from '../../config/logger';
import { polymarketClient } from './polymarket.client';
import { transformEvents } from './polymarket.transformer';
import { TransformedEvent } from './polymarket.types';
import { getTeamColor } from './market-detail-transformer.helpers';

/**
 * Generate abbreviation from team name
 */
function generateAbbr(name: string): string {
  if (!name || name === 'Home' || name === 'Away') {
    return name === 'Home' ? 'HOM' : 'AWY';
  }
  // For names like "Lakers", "Celtics" -> "LAK", "CEL"
  // For names like "Trail Blazers" -> "TBL"
  const words = name.trim().split(/\s+/);
  if (words.length === 1) {
    return words[0].substring(0, 3).toUpperCase();
  }
  // Multiple words - take first letter of each word (up to 3)
  return words.slice(0, 3).map(w => w[0]).join('').toUpperCase();
}

// Sync interval: 20 minutes
const SYNC_INTERVAL_MS = 20 * 60 * 1000;

// Timeout for fetching games
const GAMES_TIMEOUT_MS = 10000;

/**
 * Sport configuration
 */
interface SportConfig {
  seriesId: string;
  label: string;
}

// All sports with known series IDs
const SPORTS_CONFIG: Record<string, SportConfig> = {
  nfl: { seriesId: '10187', label: 'NFL' },
  nba: { seriesId: '10345', label: 'NBA' },
  nhl: { seriesId: '10346', label: 'NHL' },
  mlb: { seriesId: '3', label: 'MLB' },
  epl: { seriesId: '10188', label: 'English Premier League' },
  lal: { seriesId: '10193', label: 'La Liga' },
};

/**
 * Sports game record from database
 */
export interface SportsGameRecord {
  id: string;
  slug: string;
  title: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  image?: string;
  icon?: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  isResolved: boolean;
  restricted?: boolean;
  liquidity?: number;
  totalVolume: number;
  volume24hr: number;
  competitive?: number;
  sport: string;
  sportLabel: string;
  seriesId?: string;
  hasGroupItems?: boolean;
  isBinaryOutcome?: boolean;
  isMultiOutcome?: boolean;
  homeTeam?: any;
  awayTeam?: any;
  groupedOutcomes?: any[];
  markets?: any[];
  tags?: any[];
  transformedData: TransformedEvent;
  createdAt: Date;
  updatedAt: Date;
  syncedAt: Date;
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  limit?: number;
  offset?: number;
  sport?: string;
  orderBy?: 'start_date' | 'volume_24hr' | 'title';
  orderDir?: 'asc' | 'desc';
}

/**
 * Paginated response
 */
export interface PaginatedSportsGames {
  games: SportsGameRecord[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  sports: {
    [sport: string]: {
      sport: string;
      sportLabel: string;
      eventCount: number;
    };
  };
}

// Sync state
let syncTimer: NodeJS.Timeout | null = null;
let isSyncing = false;
let lastSyncTime: Date | null = null;
let lastSyncStats: { total: number; sports: Record<string, number> } | null = null;

/**
 * Fetch with timeout helper
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

/**
 * Check if a game is upcoming (not finished)
 */
function isUpcomingGame(event: TransformedEvent): boolean {
  const now = new Date();
  
  if (event.closed === true) return false;
  if (event.isResolved === true) return false;
  if (event.archived === true) return false;
  if (event.active === false) return false;
  
  // Check if all markets are closed
  if (event.markets && event.markets.length > 0) {
    const allMarketsClosed = event.markets.every(m => m.closed === true);
    if (allMarketsClosed) return false;
    
    const hasActiveMarket = event.markets.some(m => m.active === true && m.closed === false);
    if (!hasActiveMarket) return false;
  }
  
  // Check end date
  if (event.endDate) {
    const endDate = new Date(event.endDate);
    if (endDate < now) return false;
  }
  
  return true;
}

/**
 * Extract team data from game title and slug
 * Title format: "Lakers vs. Spurs" or "Arsenal FC vs. Chelsea FC"
 * Slug format: "nba-lal-sas-2026-01-07"
 */
function extractTeamDataFromGame(game: TransformedEvent): { homeTeam: any; awayTeam: any } {
  const title = game.title || '';
  const slug = game.slug || '';
  
  // Extract team names from title (format: "Team A vs. Team B")
  const titleMatch = title.match(/^(.+?)\s+vs\.?\s+(.+?)$/i);
  let homeTeamName = titleMatch ? titleMatch[1].trim() : '';
  let awayTeamName = titleMatch ? titleMatch[2].trim() : '';
  
  // Extract abbreviations from slug (format: "league-home-away-date")
  const slugParts = slug.split('-');
  let homeAbbr = slugParts[1]?.toUpperCase() || '';
  let awayAbbr = slugParts[2]?.toUpperCase() || '';
  
  // If no title match, use slug abbreviations as names
  if (!homeTeamName && homeAbbr) homeTeamName = homeAbbr;
  if (!awayTeamName && awayAbbr) awayTeamName = awayAbbr;
  
  // Generate abbreviations if not from slug
  if (!homeAbbr && homeTeamName) homeAbbr = generateAbbr(homeTeamName);
  if (!awayAbbr && awayTeamName) awayAbbr = generateAbbr(awayTeamName);
  
  // Get team colors - try name first, then abbreviation
  const homeColor = getTeamColor(homeTeamName) || getTeamColor(homeAbbr) || '#374151';
  const awayColor = getTeamColor(awayTeamName) || getTeamColor(awayAbbr) || '#6B7280';
  
  return {
    homeTeam: homeTeamName ? {
      name: homeTeamName,
      alias: homeTeamName.split(' ').pop() || homeTeamName, // Last word for US sports
      abbreviation: homeAbbr,
      color: homeColor,
    } : null,
    awayTeam: awayTeamName ? {
      name: awayTeamName,
      alias: awayTeamName.split(' ').pop() || awayTeamName,
      abbreviation: awayAbbr,
      color: awayColor,
    } : null,
  };
}

/**
 * Fetch games for a single sport
 */
async function fetchSportGames(sport: string, config: SportConfig): Promise<TransformedEvent[]> {
  try {
    const params: Record<string, string | number | boolean> = {
      series_id: config.seriesId,
      limit: 100,
      order: 'startTime',
      ascending: true,
      include_chat: false,
      closed: false,
      active: true,
    };

    const response = await withTimeout(
      polymarketClient.get<TransformedEvent[]>('/events', params),
      GAMES_TIMEOUT_MS,
      null
    );

    if (!response) {
      logger.warn({ message: 'Timeout fetching sport games', sport });
      return [];
    }

    let events: TransformedEvent[] = [];
    if (Array.isArray(response)) {
      events = response;
    } else if (response && 'data' in response && Array.isArray((response as any).data)) {
      events = (response as any).data;
    }

    const transformed = transformEvents(events);
    const upcoming = transformed.filter(isUpcomingGame);

    // logger.info({
    //   message: 'Fetched sport games',
    //   sport,
    //   rawCount: events.length,
    //   upcomingCount: upcoming.length,
    // });

    return upcoming;
  } catch (error) {
    logger.error({
      message: 'Error fetching sport games',
      sport,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Upsert games to database
 */
async function upsertGamesToDatabase(games: TransformedEvent[], sport: string, sportLabel: string): Promise<number> {
  if (games.length === 0) return 0;

  const client = await pool.connect();
  let upsertedCount = 0;

  try {
    await client.query('BEGIN');

    for (const game of games) {
      try {
        // Extract team data from title/slug (with team colors)
        const { homeTeam, awayTeam } = extractTeamDataFromGame(game);
        
        await client.query(`
          INSERT INTO sports_games (
            id, slug, title, description, start_date, end_date,
            image, icon, active, closed, archived, is_resolved, restricted,
            liquidity, total_volume, volume_24hr, competitive,
            sport, sport_label, series_id, has_group_items,
            is_binary_outcome, is_multi_outcome,
            home_team, away_team, grouped_outcomes, markets, tags,
            transformed_data, synced_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17,
            $18, $19, $20, $21,
            $22, $23,
            $24, $25, $26, $27, $28,
            $29, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
          ON CONFLICT (id) DO UPDATE SET
            slug = EXCLUDED.slug,
            title = EXCLUDED.title,
            description = EXCLUDED.description,
            start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date,
            image = EXCLUDED.image,
            icon = EXCLUDED.icon,
            active = EXCLUDED.active,
            closed = EXCLUDED.closed,
            archived = EXCLUDED.archived,
            is_resolved = EXCLUDED.is_resolved,
            restricted = EXCLUDED.restricted,
            liquidity = EXCLUDED.liquidity,
            total_volume = EXCLUDED.total_volume,
            volume_24hr = EXCLUDED.volume_24hr,
            competitive = EXCLUDED.competitive,
            sport = EXCLUDED.sport,
            sport_label = EXCLUDED.sport_label,
            series_id = EXCLUDED.series_id,
            has_group_items = EXCLUDED.has_group_items,
            is_binary_outcome = EXCLUDED.is_binary_outcome,
            is_multi_outcome = EXCLUDED.is_multi_outcome,
            home_team = EXCLUDED.home_team,
            away_team = EXCLUDED.away_team,
            grouped_outcomes = EXCLUDED.grouped_outcomes,
            markets = EXCLUDED.markets,
            tags = EXCLUDED.tags,
            transformed_data = EXCLUDED.transformed_data,
            synced_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        `, [
          game.id,
          game.slug,
          game.title,
          game.description,
          game.startDate ? new Date(game.startDate) : null,
          game.endDate ? new Date(game.endDate) : null,
          game.image,
          game.icon,
          game.active,
          game.closed,
          game.archived,
          game.isResolved || false,
          game.restricted,
          game.liquidity,
          game.totalVolume,
          game.volume24Hr,
          game.competitive,
          sport,
          sportLabel,
          SPORTS_CONFIG[sport]?.seriesId,
          game.hasGroupItems,
          game.isBinaryOutcome,
          game.isMultiOutcome,
          JSON.stringify(homeTeam),
          JSON.stringify(awayTeam),
          JSON.stringify(game.groupedOutcomes || []),
          JSON.stringify(game.markets || []),
          JSON.stringify(game.tags || []),
          JSON.stringify(game),
        ]);

        upsertedCount++;
      } catch (error) {
        logger.error({
          message: 'Error upserting game',
          gameId: game.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({
      message: 'Error in upsert transaction',
      sport,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    client.release();
  }

  return upsertedCount;
}

/**
 * Mark old games as closed/resolved
 * Games that are no longer returned by the API are likely finished
 */
// async function markStaleGames(): Promise<number> {
//   const client = await pool.connect();
//   try {
//     // Mark games as resolved if:
//     // 1. They haven't been synced in the last hour
//     // 2. Their end_date is in the past
//     const result = await client.query(`
//       UPDATE sports_games
//       SET 
//         is_resolved = true,
//         active = false,
//         updated_at = CURRENT_TIMESTAMP
//       WHERE 
//         is_resolved = false
//         AND (
//           (end_date IS NOT NULL AND end_date < CURRENT_TIMESTAMP)
//           OR (synced_at < CURRENT_TIMESTAMP - INTERVAL '1 hour' AND active = true)
//         )
//       RETURNING id
//     `);
    
//     return result.rowCount || 0;
//   } finally {
//     client.release();
//   }
// }

/**
 * Sync all sports games to database
 */
export async function syncAllSportsGames(): Promise<{ total: number; sports: Record<string, number> }> {
  if (isSyncing) {
    logger.warn({ message: 'Sync already in progress, skipping' });
    return lastSyncStats || { total: 0, sports: {} };
  }

  isSyncing = true;
  // const startTime = Date.now();
  const stats: Record<string, number> = {};
  let totalGames = 0;

  try {
    // logger.info({ message: 'Starting sports games sync' });

    // Fetch all sports in parallel
    const sportEntries = Object.entries(SPORTS_CONFIG);
    const results = await Promise.all(
      sportEntries.map(async ([sport, config]) => {
        const games = await fetchSportGames(sport, config);
        const upserted = await upsertGamesToDatabase(games, sport, config.label);
        return { sport, count: upserted };
      })
    );

    // Aggregate results
    for (const result of results) {
      stats[result.sport] = result.count;
      totalGames += result.count;
    }

    // // Mark stale games as resolved
    // const staleCount = await markStaleGames();

    // const latencyMs = Date.now() - startTime;
    lastSyncTime = new Date();
    lastSyncStats = { total: totalGames, sports: stats };

    // logger.info({
    //   message: 'Sports games sync completed',
    //   totalGames,
    //   staleMarked: staleCount,
    //   sports: stats,
    //   latencyMs,
    // });

    return { total: totalGames, sports: stats };
  } catch (error) {
    logger.error({
      message: 'Error syncing sports games',
      error: error instanceof Error ? error.message : String(error),
    });
    return { total: 0, sports: {} };
  } finally {
    isSyncing = false;
  }
}

/**
 * Get sports games from database with pagination
 */
export async function getSportsGamesFromDB(options: PaginationOptions = {}): Promise<PaginatedSportsGames> {
  const {
    limit = 20,
    offset = 0,
    sport,
    orderBy = 'start_date',
    orderDir = 'asc',
  } = options;

  const client = await pool.connect();
  
  try {
    // Build WHERE clause
    // Filter out ended games: active, not closed, not resolved, and end_date not in the past (with 3 hour grace period)
    const conditions: string[] = [
      'active = true', 
      'closed = false', 
      'is_resolved = false',
      '(end_date IS NULL OR end_date >= CURRENT_TIMESTAMP - INTERVAL \'3 hours\')' // Exclude games that ended more than 3 hours ago
    ];
    const params: any[] = [];
    let paramIndex = 1;

    if (sport && sport !== 'all') {
      conditions.push(`sport = $${paramIndex}`);
      params.push(sport.toLowerCase());
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Map orderBy to column names
    const orderColumn = orderBy === 'volume_24hr' ? 'volume_24hr' : 
                        orderBy === 'title' ? 'title' : 'start_date';
    const orderDirection = orderDir.toUpperCase() === 'DESC' ? 'DESC NULLS LAST' : 'ASC NULLS LAST';

    // Get total count
    const countResult = await client.query(
      `SELECT COUNT(*) as total FROM sports_games ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.total || '0', 10);

    // Get paginated games
    const gamesResult = await client.query(
      `SELECT 
        id, slug, title, description, 
        start_date as "startDate", end_date as "endDate",
        image, icon, active, closed, archived, is_resolved as "isResolved",
        restricted, liquidity, total_volume as "totalVolume", 
        volume_24hr as "volume24hr", competitive,
        sport, sport_label as "sportLabel", series_id as "seriesId",
        has_group_items as "hasGroupItems", 
        is_binary_outcome as "isBinaryOutcome",
        is_multi_outcome as "isMultiOutcome",
        home_team as "homeTeam", away_team as "awayTeam",
        grouped_outcomes as "groupedOutcomes",
        markets, tags, transformed_data as "transformedData",
        created_at as "createdAt", updated_at as "updatedAt", 
        synced_at as "syncedAt"
      FROM sports_games 
      ${whereClause}
      ORDER BY ${orderColumn} ${orderDirection}, id ASC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    // Get sport counts (using same filters as main query)
    const sportCountsResult = await client.query(`
      SELECT sport, sport_label, COUNT(*) as count
      FROM sports_games
      WHERE active = true 
        AND closed = false 
        AND is_resolved = false
        AND (end_date IS NULL OR end_date >= CURRENT_TIMESTAMP - INTERVAL '3 hours')
      GROUP BY sport, sport_label
    `);

    const sports: PaginatedSportsGames['sports'] = {};
    for (const row of sportCountsResult.rows) {
      sports[row.sport] = {
        sport: row.sport,
        sportLabel: row.sport_label,
        eventCount: parseInt(row.count, 10),
      };
    }

    return {
      games: gamesResult.rows,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
      sports,
    };
  } finally {
    client.release();
  }
}

/**
 * Get sync status
 */
export function getSyncStatus() {
  return {
    isSyncing,
    lastSyncTime: lastSyncTime?.toISOString() || null,
    lastSyncStats,
    nextSyncIn: syncTimer ? SYNC_INTERVAL_MS : null,
  };
}

/**
 * Start background sync
 */
export function startBackgroundSync(): void {
  if (syncTimer) {
    logger.warn({ message: 'Background sync already running' });
    return;
  }

  // logger.info({ 
  //   message: 'Starting sports games background sync',
  //   intervalMs: SYNC_INTERVAL_MS,
  //   intervalMinutes: SYNC_INTERVAL_MS / 60000,
  // });

  // Run initial sync
  syncAllSportsGames().catch((error) => {
    logger.error({
      message: 'Initial sync failed',
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Schedule recurring syncs
  syncTimer = setInterval(() => {
    syncAllSportsGames().catch((error) => {
      logger.error({
        message: 'Scheduled sync failed',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, SYNC_INTERVAL_MS);
}

/**
 * Stop background sync
 */
export function stopBackgroundSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    logger.info({ message: 'Sports games background sync stopped' });
  }
}

/**
 * Force a manual sync
 */
export async function forceSyncNow(): Promise<{ total: number; sports: Record<string, number> }> {
  return syncAllSportsGames();
}

/**
 * Get a sports game by slug from the database
 */
export async function getSportsGameBySlug(slug: string): Promise<SportsGameRecord | null> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT 
        id, slug, title, description, 
        start_date as "startDate", end_date as "endDate",
        image, icon, active, closed, archived, is_resolved as "isResolved",
        restricted, liquidity, total_volume as "totalVolume", 
        volume_24hr as "volume24hr", competitive,
        sport, sport_label as "sportLabel", series_id as "seriesId",
        has_group_items as "hasGroupItems", 
        is_binary_outcome as "isBinaryOutcome",
        is_multi_outcome as "isMultiOutcome",
        home_team as "homeTeam", away_team as "awayTeam",
        grouped_outcomes as "groupedOutcomes",
        markets, tags, transformed_data as "transformedData",
        created_at as "createdAt", updated_at as "updatedAt", 
        synced_at as "syncedAt"
      FROM sports_games 
      WHERE slug = $1
      LIMIT 1`,
      [slug]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  } finally {
    client.release();
  }
}

