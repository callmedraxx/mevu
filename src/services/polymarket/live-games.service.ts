/**
 * Live Games Service
 * Fetches live games from Polymarket and filters by configured sports/leagues
 */

import axios from 'axios';
import { logger } from '../../config/logger';
import { pool } from '../../config/database';
import { getSeriesIdForSport, getAllSportsGamesConfig } from './sports-games.config';
import { getLeagueForSport } from './teams.config';
import { checkConfigSync } from './config-sync';
import { teamsService, Team } from './teams.service';
import { transformEvents } from './polymarket.transformer';
import { PolymarketEvent, TransformedEvent } from './polymarket.types';
import { PolymarketError, ErrorCode } from '../../utils/errors';

// Build ID may change - we'll need to fetch it dynamically or update periodically
const POLYMARKET_LIVE_ENDPOINT = 'https://polymarket.com/_next/data/ydeAKiopMLZxqGsdeVui4/sports/live.json?slug=live';
const POLLING_INTERVAL = 20 * 60 * 1000; // 20 minutes in milliseconds

// In-memory storage for development
const inMemoryGames: Map<string, LiveGame> = new Map();

export interface LiveGameEvent {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  description?: string;
  resolutionSource?: string;
  startDate: string;
  creationDate?: string;
  endDate: string;
  image?: string;
  icon?: string;
  active: boolean;
  closed: boolean;
  archived: boolean;
  new?: boolean;
  featured?: boolean;
  restricted?: boolean;
  liquidity?: number;
  volume?: number;
  openInterest?: number;
  createdAt?: string;
  updatedAt?: string;
  competitive?: number;
  volume24hr?: number;
  volume1wk?: number;
  volume1mo?: number;
  volume1yr?: number;
  enableOrderBook?: boolean;
  liquidityClob?: number;
  negRisk?: boolean;
  negRiskMarketID?: string;
  commentCount?: number;
  markets?: any[];
  // WebSocket update fields (from live games response)
  gameId?: number; // Maps to WebSocket gameId
  score?: string; // Current score
  period?: string; // Current period (e.g., "Q1", "2H", "HT")
  elapsed?: string; // Elapsed time
  live?: boolean; // Whether game is live
  ended?: boolean; // Whether game has ended
  [key: string]: any;
}

/**
 * Extended TransformedEvent with live game specific fields
 */
export interface LiveGame extends TransformedEvent {
  // Live game specific fields
  sport?: string;
  league?: string;
  seriesId?: string;
  
  // WebSocket update fields
  gameId?: number; // Maps to WebSocket gameId for updates
  score?: string; // Current score (e.g., "1-0", "2-1")
  period?: string; // Current period (e.g., "Q1", "2H", "HT")
  elapsed?: string; // Elapsed time (e.g., "0:42", "80")
  live?: boolean; // Whether the game is currently live
  ended?: boolean; // Whether the game has ended
  
  // Team data (enriched)
  homeTeam?: Team;
  awayTeam?: Team;
  teamIdentifiers?: {
    home?: string;
    away?: string;
  };
  
  // Storage metadata
  createdAt: Date;
  updatedAt: Date;
  rawData: LiveGameEvent;
}

interface LiveGamesApiResponse {
  pageProps: {
    dehydratedState: {
      queries: Array<{
        state: {
          data: {
            events?: Record<string, LiveGameEvent>;
          };
        };
      }>;
    };
  };
}

/**
 * Extract sport/league from game slug or title
 */
function extractSportFromGame(game: LiveGameEvent): string | null {
  const slug = game.slug?.toLowerCase() || '';
  const title = game.title?.toLowerCase() || '';
  
  // Check against configured sports
  const sportsConfig = getAllSportsGamesConfig();
  
  for (const [sport, config] of Object.entries(sportsConfig)) {
    // Check if slug or title contains sport indicators
    const sportIndicators: Record<string, string[]> = {
      nfl: ['nfl', 'football'],
      nba: ['nba', 'basketball'],
      mlb: ['mlb', 'baseball'],
      nhl: ['nhl', 'hockey'],
      ufc: ['ufc', 'mma'],
      epl: ['epl', 'premier league', 'premier-league'],
      lal: ['lal', 'la liga', 'la-liga', 'laliga'],
    };
    
    const indicators = sportIndicators[sport] || [sport];
    for (const indicator of indicators) {
      if (slug.includes(indicator) || title.includes(indicator)) {
        return sport;
      }
    }
  }
  
  return null;
}

/**
 * Check if a game belongs to a configured sport/league
 */
function isGameInConfiguredSport(game: LiveGameEvent): boolean {
  const sport = extractSportFromGame(game);
  if (!sport) return false;
  
  const seriesId = getSeriesIdForSport(sport);
  return seriesId !== null && seriesId !== '';
}

/**
 * Convert LiveGameEvent to PolymarketEvent format for transformation
 */
function convertToPolymarketEvent(event: LiveGameEvent): PolymarketEvent {
  return {
    id: event.id,
    ticker: event.ticker,
    slug: event.slug,
    title: event.title,
    description: event.description,
    resolutionSource: event.resolutionSource,
    startDate: event.startDate,
    creationDate: event.creationDate,
    endDate: event.endDate,
    image: event.image,
    icon: event.icon,
    active: event.active,
    closed: event.closed,
    archived: event.archived,
    new: event.new,
    featured: event.featured,
    restricted: event.restricted,
    liquidity: event.liquidity,
    volume: event.volume,
    openInterest: event.openInterest,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    competitive: event.competitive,
    volume24hr: event.volume24hr,
    volume1wk: event.volume1wk,
    volume1mo: event.volume1mo,
    volume1yr: event.volume1yr,
    enableOrderBook: event.enableOrderBook,
    liquidityClob: event.liquidityClob,
    negRisk: event.negRisk,
    commentCount: event.commentCount,
    markets: event.markets || [],
  };
}

/**
 * Extract team identifiers from event (similar to game-events.service)
 */
function extractTeamsFromEvent(event: TransformedEvent): {
  home?: string;
  away?: string;
} {
  // Strategy 1: Parse from event title (e.g., "Texans vs. Colts")
  const title = event.title || '';
  const separators = [' vs. ', ' vs ', ' @ ', ' at ', ' - '];
  
  for (const separator of separators) {
    const parts = title.split(separator);
    if (parts.length === 2) {
      const team1 = parts[0].trim().replace(/\s*\(.*?\)\s*$/, '');
      const team2 = parts[1].trim().replace(/\s*\(.*?\)\s*$/, '');
      
      if (separator.includes('@') || separator.includes('at')) {
        return { away: team1, home: team2 };
      } else {
        return { home: team1, away: team2 };
      }
    }
  }
  
  // Strategy 2: Parse from slug (e.g., "nfl-hou-ind-2025-11-30")
  const slug = event.slug || '';
  const slugParts = slug.split('-');
  const teamAbbrevs: string[] = [];
  
  for (const part of slugParts) {
    if (/^\d+$/.test(part)) continue;
    if (part.length >= 2 && part.length <= 5 && /^[a-z]+$/i.test(part)) {
      teamAbbrevs.push(part.toUpperCase());
    }
  }
  
  if (teamAbbrevs.length >= 2) {
    return {
      away: teamAbbrevs[0],
      home: teamAbbrevs[1],
    };
  }
  
  return {};
}

/**
 * Match team using lookup maps (similar to game-events.service)
 */
function matchTeamUsingLookup(
  identifier: string,
  teamsByAbbreviation: Map<string, Team>,
  teamsByName: Map<string, Team>,
  teamsByAlias: Map<string, Team>,
  teams: Team[]
): Team | null {
  if (!identifier || teams.length === 0) {
    return null;
  }

  const normalizedIdentifier = identifier.trim().toLowerCase();

  // Strategy 1: Exact match on abbreviation
  const abbrevMatch = teamsByAbbreviation.get(normalizedIdentifier);
  if (abbrevMatch) {
    return abbrevMatch;
  }

  // Strategy 2: Exact match on name
  const nameMatch = teamsByName.get(normalizedIdentifier);
  if (nameMatch) {
    return nameMatch;
  }

  // Strategy 3: Exact match on alias
  const aliasMatch = teamsByAlias.get(normalizedIdentifier);
  if (aliasMatch) {
    return aliasMatch;
  }

  // Strategy 4: Partial/fuzzy match
  for (const team of teams) {
    const teamNameLower = team.name.toLowerCase();
    const teamAbbrevLower = team.abbreviation?.toLowerCase() || '';
    
    if (
      teamNameLower.includes(normalizedIdentifier) ||
      normalizedIdentifier.includes(teamNameLower) ||
      (teamAbbrevLower && (
        teamAbbrevLower.includes(normalizedIdentifier) ||
        normalizedIdentifier.includes(teamAbbrevLower)
      ))
    ) {
      return team;
    }
  }

  return null;
}

/**
 * Enrich transformed events with team details
 */
async function enrichEventsWithTeams(
  events: TransformedEvent[],
  sport: string
): Promise<LiveGame[]> {
  // Get league for sport
  const league = getLeagueForSport(sport);
  if (!league) {
    logger.warn({
      message: 'No league found for sport, skipping team enrichment',
      sport,
    });
    return events.map((e) => ({ ...e, createdAt: new Date(), updatedAt: new Date(), rawData: {} as LiveGameEvent }));
  }

  // Fetch all teams for the league
  let teams: Team[] = [];
  try {
    teams = await teamsService.getTeamsByLeague(league);
    logger.debug({
      message: 'Teams fetched for enrichment',
      sport,
      league,
      teamCount: teams.length,
    });
  } catch (error) {
    logger.warn({
      message: 'Failed to fetch teams, continuing without team enrichment',
      sport,
      league,
      error: error instanceof Error ? error.message : String(error),
    });
    return events.map((e) => ({ ...e, createdAt: new Date(), updatedAt: new Date(), rawData: {} as LiveGameEvent }));
  }

  // Create lookup maps
  const teamsByAbbreviation = new Map<string, Team>();
  const teamsByName = new Map<string, Team>();
  const teamsByAlias = new Map<string, Team>();

  for (const team of teams) {
    if (team.abbreviation) {
      teamsByAbbreviation.set(team.abbreviation.toLowerCase(), team);
    }
    if (team.name) {
      teamsByName.set(team.name.toLowerCase(), team);
    }
    if (team.alias) {
      teamsByAlias.set(team.alias.toLowerCase(), team);
    }
  }

  // Enrich each event
  return events.map((event) => {
    const liveGame: LiveGame = { ...event, createdAt: new Date(), updatedAt: new Date(), rawData: {} as LiveGameEvent };
    
    const teamIdentifiers = extractTeamsFromEvent(event);
    
    if (teamIdentifiers.home || teamIdentifiers.away) {
      liveGame.teamIdentifiers = teamIdentifiers;
      
      if (teamIdentifiers.home) {
        const homeTeam = matchTeamUsingLookup(
          teamIdentifiers.home,
          teamsByAbbreviation,
          teamsByName,
          teamsByAlias,
          teams
        );
        if (homeTeam) {
          liveGame.homeTeam = homeTeam;
        }
      }
      
      if (teamIdentifiers.away) {
        const awayTeam = matchTeamUsingLookup(
          teamIdentifiers.away,
          teamsByAbbreviation,
          teamsByName,
          teamsByAlias,
          teams
        );
        if (awayTeam) {
          liveGame.awayTeam = awayTeam;
        }
      }
    }
    
    return liveGame;
  });
}

/**
 * Transform and enrich live game events
 * Optimized to batch enrichment by sport for better performance
 */
async function transformAndEnrichGames(
  events: LiveGameEvent[]
): Promise<LiveGame[]> {
  // Convert to PolymarketEvent format
  const polymarketEvents = events.map(convertToPolymarketEvent);
  
  // Transform using existing transformer
  const transformedEvents = transformEvents(polymarketEvents);
  
  // Group events by sport for batch enrichment
  const eventsBySport = new Map<string, { transformed: TransformedEvent; raw: LiveGameEvent }[]>();
  
  for (const transformedEvent of transformedEvents) {
    const rawEvent = events.find(e => e.id === transformedEvent.id);
    if (!rawEvent) continue;
    
    const sport = extractSportFromGame(rawEvent);
    if (!sport) continue;
    
    if (!eventsBySport.has(sport)) {
      eventsBySport.set(sport, []);
    }
    eventsBySport.get(sport)!.push({ transformed: transformedEvent, raw: rawEvent });
  }
  
  // Enrich all events for each sport in parallel
  const enrichmentPromises = Array.from(eventsBySport.entries()).map(async ([sport, eventPairs]) => {
    const transformedEventsForSport = eventPairs.map(p => p.transformed);
    
    // Batch enrich all events for this sport
    const enriched = await enrichEventsWithTeams(transformedEventsForSport, sport);
    
    // Map enriched events back to their raw data
    return enriched.map((enrichedGame, index) => {
      const rawEvent = eventPairs[index].raw;
      
      // Add live game specific fields from raw event
      enrichedGame.sport = sport;
      enrichedGame.league = sport;
      enrichedGame.seriesId = getSeriesIdForSport(sport) || undefined;
      enrichedGame.gameId = rawEvent.gameId;
      enrichedGame.score = rawEvent.score;
      enrichedGame.period = rawEvent.period;
      enrichedGame.elapsed = rawEvent.elapsed;
      enrichedGame.live = rawEvent.live;
      enrichedGame.ended = rawEvent.ended;
      enrichedGame.rawData = rawEvent;
      
      return enrichedGame;
    });
  });
  
  // Wait for all sport enrichments to complete
  const enrichedBySport = await Promise.all(enrichmentPromises);
  
  // Flatten the results
  return enrichedBySport.flat();
}

/**
 * Fetch live games from Polymarket endpoint
 */
export async function fetchLiveGames(): Promise<LiveGameEvent[]> {
  try {
    logger.info({
      message: 'Fetching live games from Polymarket',
      endpoint: POLYMARKET_LIVE_ENDPOINT,
    });

    const response = await axios.get<LiveGamesApiResponse>(POLYMARKET_LIVE_ENDPOINT, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      timeout: 30000,
    });

    // Extract events from the response
    const queries = response.data?.pageProps?.dehydratedState?.queries || [];
    let events: Record<string, LiveGameEvent> = {};
    
    for (const query of queries) {
      const data = query.state?.data;
      if (data && typeof data === 'object' && 'events' in data) {
        events = { ...events, ...(data.events || {}) };
      }
    }

    const eventArray = Object.values(events);
    
    logger.info({
      message: 'Live games fetched successfully',
      totalGames: eventArray.length,
    });

    return eventArray;
  } catch (error) {
    logger.error({
      message: 'Error fetching live games',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    
    throw new PolymarketError(
      ErrorCode.POLYMARKET_FETCH_FAILED,
      `Failed to fetch live games: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Filter games by configured sports
 */
export function filterGamesBySports(games: LiveGameEvent[]): LiveGameEvent[] {
  return games.filter(isGameInConfiguredSport);
}

/**
 * Store games in database (production) or in-memory (development)
 */
export async function storeGames(games: LiveGame[]): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  logger.debug({
    message: 'Storing games',
    count: games.length,
    storageType: isProduction ? 'database' : 'in-memory',
    nodeEnv: process.env.NODE_ENV || 'development',
  });
  
  if (isProduction) {
    await storeGamesInDatabase(games);
  } else {
    storeGamesInMemory(games);
  }
}

/**
 * Store games in PostgreSQL
 */
async function storeGamesInDatabase(games: LiveGame[]): Promise<void> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    for (const game of games) {
      await client.query(
        `INSERT INTO live_games (
          id, ticker, slug, title, description, resolution_source,
          start_date, end_date, image, icon, active, closed, archived,
          restricted, liquidity, volume, volume_24hr, competitive,
          sport, league, series_id, game_id, score, period, elapsed, live, ended,
          transformed_data, raw_data, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
        ON CONFLICT (id) DO UPDATE SET
          ticker = EXCLUDED.ticker,
          slug = EXCLUDED.slug,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          resolution_source = EXCLUDED.resolution_source,
          start_date = EXCLUDED.start_date,
          end_date = EXCLUDED.end_date,
          image = EXCLUDED.image,
          icon = EXCLUDED.icon,
          active = EXCLUDED.active,
          closed = EXCLUDED.closed,
          archived = EXCLUDED.archived,
          restricted = EXCLUDED.restricted,
          liquidity = EXCLUDED.liquidity,
          volume = EXCLUDED.volume,
          volume_24hr = EXCLUDED.volume_24hr,
          competitive = EXCLUDED.competitive,
          sport = EXCLUDED.sport,
          league = EXCLUDED.league,
          series_id = EXCLUDED.series_id,
          game_id = EXCLUDED.game_id,
          score = EXCLUDED.score,
          period = EXCLUDED.period,
          elapsed = EXCLUDED.elapsed,
          live = EXCLUDED.live,
          ended = EXCLUDED.ended,
          transformed_data = EXCLUDED.transformed_data,
          raw_data = EXCLUDED.raw_data,
          updated_at = CURRENT_TIMESTAMP`,
        [
          game.id,
          game.ticker,
          game.slug,
          game.title,
          game.description,
          game.resolutionSource,
          game.startDate,
          game.endDate,
          game.image,
          game.icon,
          game.active,
          game.closed,
          game.archived,
          game.restricted,
          game.liquidity,
          game.volume,
          game.volume24hr,
          game.competitive,
          game.sport,
          game.league,
          game.seriesId,
          game.gameId,
          game.score,
          game.period,
          game.elapsed,
          game.live,
          game.ended,
          JSON.stringify(game), // Store full transformed data
          JSON.stringify(game.rawData),
          game.createdAt,
          game.updatedAt,
        ]
      );
    }
    
    await client.query('COMMIT');
    
    logger.info({
      message: 'Games stored in database',
      count: games.length,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({
      message: 'Error storing games in database',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Store games in memory (development)
 */
function storeGamesInMemory(games: LiveGame[]): void {
  for (const game of games) {
    inMemoryGames.set(game.id, game);
  }
  
  logger.info({
    message: 'Games stored in memory',
    count: games.length,
    totalInMemory: inMemoryGames.size,
  });
}

/**
 * Get all live games from storage
 * If storage is empty, fetches from API first
 */
export async function getAllLiveGames(): Promise<LiveGame[]> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (isProduction) {
    const games = await getAllLiveGamesFromDatabase();
    
    // If database is empty, fetch from API
    if (games.length === 0) {
      logger.info({
        message: 'Database is empty, fetching live games from API',
      });
      await refreshLiveGames();
      return await getAllLiveGamesFromDatabase();
    }
    
    return games;
  } else {
    const games = Array.from(inMemoryGames.values());
    
    // If in-memory is empty, fetch from API
    if (games.length === 0) {
      logger.info({
        message: 'In-memory storage is empty, fetching live games from API',
      });
      await refreshLiveGames();
      return Array.from(inMemoryGames.values());
    }
    
    logger.debug({
      message: 'Retrieved games from in-memory storage',
      count: games.length,
    });
    return games;
  }
}

/**
 * Get in-memory storage stats (for debugging)
 */
export function getInMemoryStats(): { count: number; games: LiveGame[] } {
  return {
    count: inMemoryGames.size,
    games: Array.from(inMemoryGames.values()),
  };
}

/**
 * Get all live games from database
 */
async function getAllLiveGamesFromDatabase(): Promise<LiveGame[]> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT 
        transformed_data, raw_data
      FROM live_games
      WHERE active = true AND closed = false
      ORDER BY volume_24hr DESC NULLS LAST, created_at DESC`
    );
    
    // Return transformed data if available, otherwise reconstruct from raw
    return result.rows.map((row) => {
      if (row.transformed_data) {
        const game = typeof row.transformed_data === 'string' 
          ? JSON.parse(row.transformed_data) 
          : row.transformed_data;
        // Ensure dates are Date objects
        if (game.createdAt && typeof game.createdAt === 'string') {
          game.createdAt = new Date(game.createdAt);
        }
        if (game.updatedAt && typeof game.updatedAt === 'string') {
          game.updatedAt = new Date(game.updatedAt);
        }
        return game as LiveGame;
      }
      
      // Fallback: reconstruct from raw data (shouldn't happen in normal flow)
      const rawData = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
      return {
        ...rawData,
        createdAt: new Date(),
        updatedAt: new Date(),
        rawData,
      } as LiveGame;
    });
  } finally {
    client.release();
  }
}

/**
 * Update a single game by event ID (for WebSocket updates)
 */
export async function updateGame(gameUpdate: Partial<LiveGame> & { id: string }): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (isProduction) {
    await updateGameInDatabase(gameUpdate);
  } else {
    updateGameInMemory(gameUpdate);
  }
}

/**
 * Update a single game by gameId (for WebSocket updates)
 */
export async function updateGameByGameId(gameId: number, updates: Partial<LiveGame>): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (isProduction) {
    await updateGameByGameIdInDatabase(gameId, updates);
  } else {
    updateGameByGameIdInMemory(gameId, updates);
  }
}

/**
 * Update game in database by gameId
 */
async function updateGameByGameIdInDatabase(gameId: number, updates: Partial<LiveGame>): Promise<void> {
  const client = await pool.connect();
  
  try {
    // First find the game by gameId
    const findResult = await client.query('SELECT id, transformed_data FROM live_games WHERE game_id = $1', [gameId]);
    
    if (findResult.rows.length === 0) {
      logger.debug({
        message: 'Game not found by gameId, skipping update',
        gameId,
      });
      return;
    }
    
    const eventId = findResult.rows[0].id;
    const current = findResult.rows[0].transformed_data 
      ? (typeof findResult.rows[0].transformed_data === 'string' 
          ? JSON.parse(findResult.rows[0].transformed_data) 
          : findResult.rows[0].transformed_data)
      : {};
    
    // Merge updates
    const updated = { ...current, ...updates, updatedAt: new Date() };
    
    // Build update query
    const updateFields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (updates.score !== undefined) {
      updateFields.push(`score = $${paramIndex++}`);
      values.push(updates.score);
    }
    if (updates.period !== undefined) {
      updateFields.push(`period = $${paramIndex++}`);
      values.push(updates.period);
    }
    if (updates.elapsed !== undefined) {
      updateFields.push(`elapsed = $${paramIndex++}`);
      values.push(updates.elapsed);
    }
    if (updates.live !== undefined) {
      updateFields.push(`live = $${paramIndex++}`);
      values.push(updates.live);
    }
    if (updates.ended !== undefined) {
      updateFields.push(`ended = $${paramIndex++}`);
      values.push(updates.ended);
    }
    if (updates.active !== undefined) {
      updateFields.push(`active = $${paramIndex++}`);
      values.push(updates.active);
    }
    if (updates.closed !== undefined) {
      updateFields.push(`closed = $${paramIndex++}`);
      values.push(updates.closed);
    }
    
    updateFields.push(`transformed_data = $${paramIndex++}`);
    values.push(JSON.stringify(updated));
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(eventId);
    
    await client.query(
      `UPDATE live_games SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
    
    // Broadcast update
    const allGames = await getAllLiveGamesFromDatabase();
    if (liveGamesService) {
      liveGamesService.broadcastUpdate(allGames);
    }
    
    logger.debug({
      message: 'Game updated in database by gameId',
      gameId,
      eventId,
    });
  } finally {
    client.release();
  }
}

/**
 * Update game in memory by gameId
 */
function updateGameByGameIdInMemory(gameId: number, updates: Partial<LiveGame>): void {
  // Find game by gameId
  for (const [eventId, game] of inMemoryGames.entries()) {
    if (game.gameId === gameId) {
      inMemoryGames.set(eventId, {
        ...game,
        ...updates,
        updatedAt: new Date(),
      });
      
      // Broadcast update
      const allGames = Array.from(inMemoryGames.values());
      if (liveGamesService) {
        liveGamesService.broadcastUpdate(allGames);
      }
      return;
    }
  }
  
  logger.debug({
    message: 'Game not found in memory by gameId',
    gameId,
  });
}

/**
 * Update game in database
 */
async function updateGameInDatabase(gameUpdate: Partial<LiveGame> & { id: string }): Promise<void> {
  const client = await pool.connect();
  
  try {
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (gameUpdate.active !== undefined) {
      updates.push(`active = $${paramIndex++}`);
      values.push(gameUpdate.active);
    }
    if (gameUpdate.closed !== undefined) {
      updates.push(`closed = $${paramIndex++}`);
      values.push(gameUpdate.closed);
    }
    if (gameUpdate.liquidity !== undefined) {
      updates.push(`liquidity = $${paramIndex++}`);
      values.push(gameUpdate.liquidity);
    }
    if (gameUpdate.volume !== undefined) {
      updates.push(`volume = $${paramIndex++}`);
      values.push(gameUpdate.volume);
    }
    if (gameUpdate.volume24hr !== undefined) {
      updates.push(`volume_24hr = $${paramIndex++}`);
      values.push(gameUpdate.volume24hr);
    }
    // WebSocket update fields
    if (gameUpdate.score !== undefined) {
      updates.push(`score = $${paramIndex++}`);
      values.push(gameUpdate.score);
    }
    if (gameUpdate.period !== undefined) {
      updates.push(`period = $${paramIndex++}`);
      values.push(gameUpdate.period);
    }
    if (gameUpdate.elapsed !== undefined) {
      updates.push(`elapsed = $${paramIndex++}`);
      values.push(gameUpdate.elapsed);
    }
    if (gameUpdate.live !== undefined) {
      updates.push(`live = $${paramIndex++}`);
      values.push(gameUpdate.live);
    }
    if (gameUpdate.ended !== undefined) {
      updates.push(`ended = $${paramIndex++}`);
      values.push(gameUpdate.ended);
    }
    if (gameUpdate.rawData) {
      updates.push(`raw_data = $${paramIndex++}`);
      values.push(JSON.stringify(gameUpdate.rawData));
    }
    // Update transformed_data if full game object provided
    if (gameUpdate.id && Object.keys(gameUpdate).length > 1) {
      // Fetch current game to merge updates
      const currentResult = await client.query('SELECT transformed_data FROM live_games WHERE id = $1', [gameUpdate.id]);
      if (currentResult.rows.length > 0 && currentResult.rows[0].transformed_data) {
        const current = typeof currentResult.rows[0].transformed_data === 'string'
          ? JSON.parse(currentResult.rows[0].transformed_data)
          : currentResult.rows[0].transformed_data;
        const updated = { ...current, ...gameUpdate, updatedAt: new Date() };
        updates.push(`transformed_data = $${paramIndex++}`);
        values.push(JSON.stringify(updated));
      }
    }
    
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(gameUpdate.id);
    
    await client.query(
      `UPDATE live_games SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
    
    // Broadcast update
    const allGames = await getAllLiveGamesFromDatabase();
    if (liveGamesService) {
      liveGamesService.broadcastUpdate(allGames);
    }
    
    logger.debug({
      message: 'Game updated in database',
      gameId: gameUpdate.id,
    });
  } finally {
    client.release();
  }
}

/**
 * Update game in memory
 */
function updateGameInMemory(gameUpdate: Partial<LiveGame> & { id: string }): void {
  const existing = inMemoryGames.get(gameUpdate.id);
  if (existing) {
    inMemoryGames.set(gameUpdate.id, {
      ...existing,
      ...gameUpdate,
      updatedAt: new Date(),
    });
    
    // Broadcast update
    const allGames = Array.from(inMemoryGames.values());
    if (liveGamesService) {
      liveGamesService.broadcastUpdate(allGames);
    }
  }
}

/**
 * Fetch, filter, and store live games
 */
export async function refreshLiveGames(): Promise<number> {
  try {
    logger.info({
      message: 'Refreshing live games',
    });

    // Fetch all games
    const allGames = await fetchLiveGames();
    
    // Filter by configured sports
    const filteredGames = filterGamesBySports(allGames);
    
    // Transform and enrich with team data
    const liveGames = await transformAndEnrichGames(filteredGames);
    
    // Store games
    await storeGames(liveGames);
    
    // Broadcast update via SSE
    const allStoredGames = await getAllLiveGames();
    if (liveGamesService) {
      liveGamesService.broadcastUpdate(allStoredGames);
    }
    
    logger.info({
      message: 'Live games refreshed',
      totalFetched: allGames.length,
      filtered: filteredGames.length,
      stored: liveGames.length,
    });
    
    return liveGames.length;
  } catch (error) {
    logger.error({
      message: 'Error refreshing live games',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Live Games Service
 */
export class LiveGamesService {
  private pollingInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private sseBroadcastCallback: ((games: LiveGame[]) => void) | null = null;

  /**
   * Start polling for live games
   */
  start(): void {
    if (this.isRunning) {
      logger.warn({
        message: 'Live games polling already running',
      });
      return;
    }

    this.isRunning = true;
    
    // Check config sync on startup
    checkConfigSync();
    
    // Initial fetch
    refreshLiveGames().catch((error) => {
      logger.error({
        message: 'Error in initial live games fetch',
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Set up polling interval
    this.pollingInterval = setInterval(() => {
      refreshLiveGames().catch((error) => {
        logger.error({
          message: 'Error in live games polling',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, POLLING_INTERVAL);

    logger.info({
      message: 'Live games polling started',
      intervalMinutes: POLLING_INTERVAL / 60000,
    });
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    this.isRunning = false;
    
    logger.info({
      message: 'Live games polling stopped',
    });
  }

  /**
   * Set SSE broadcast callback
   */
  setSSEBroadcastCallback(callback: (games: LiveGame[]) => void): void {
    this.sseBroadcastCallback = callback;
  }

  /**
   * Get status
   */
  getStatus(): { isRunning: boolean; intervalMinutes: number } {
    return {
      isRunning: this.isRunning,
      intervalMinutes: POLLING_INTERVAL / 60000,
    };
  }

  /**
   * Broadcast games update via SSE
   */
  broadcastUpdate(games: LiveGame[]): void {
    if (this.sseBroadcastCallback) {
      this.sseBroadcastCallback(games);
    }
  }
}

// Export singleton instance
export const liveGamesService = new LiveGamesService();

