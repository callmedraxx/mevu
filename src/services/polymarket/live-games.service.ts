/**
 * Live Games Service
 * Fetches live games from Polymarket and filters by configured sports/leagues
 */

import axios, { AxiosResponse } from 'axios';
import { logger } from '../../config/logger';
import { pool } from '../../config/database';
import { getSeriesIdForSport, getAllSportsGamesConfig } from './sports-games.config';
import { getLeagueForSport } from './teams.config';
import { teamsService, Team } from './teams.service';
import { transformEvents } from './polymarket.transformer';
import { PolymarketEvent, TransformedEvent } from './polymarket.types';
import { recordProbabilitySnapshot, initializeProbabilityHistoryTable } from './probability-history.service';

// Build ID may change - we'll need to fetch it dynamically or update periodically
// Default build ID - will be updated when 404 is encountered
let currentBuildId = '6w0cVAj-lCsqW5cBTIuDH';

/**
 * Get the live endpoint URL with current build ID
 */
function getLiveEndpoint(): string {
  return `https://polymarket.com/_next/data/${currentBuildId}/sports/live.json?slug=live`;
}

const POLLING_INTERVAL = 20 * 60 * 1000; // 20 minutes in milliseconds

/**
 * Fast extraction of buildId from HTML response
 * Looks for "buildId":"..." pattern in script tags
 */
export function extractBuildIdFromHtml(html: string): string | null {
  // Fast regex to find buildId in script tags
  // Pattern: "buildId":"<value>"
  const buildIdRegex = /"buildId"\s*:\s*"([^"]+)"/;
  const match = html.match(buildIdRegex);
  
  if (match && match[1]) {
    return match[1];
  }
  
  return null;
}

/**
 * Fetch and extract buildId from polymarket.com root page
 * This is called when we get a 404 to update the build ID
 */
async function fetchAndUpdateBuildId(): Promise<boolean> {
  try {
    logger.info({
      message: 'Fetching build ID from polymarket.com root page',
    });

    const response = await axios.get<string>('https://polymarket.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      },
      timeout: 30000,
      maxContentLength: 10 * 1024 * 1024, // 10MB max
      responseType: 'text',
    });

    const buildId = extractBuildIdFromHtml(response.data);
    
    if (buildId) {
      const oldBuildId = currentBuildId;
      currentBuildId = buildId;
      
      logger.info({
        message: 'Build ID updated successfully',
        oldBuildId,
        newBuildId: buildId,
        endpoint: getLiveEndpoint(),
      });
      
      return true;
    } else {
      logger.warn({
        message: 'Could not extract build ID from HTML response',
        htmlLength: response.data.length,
      });
      return false;
    }
  } catch (error) {
    logger.error({
      message: 'Error fetching build ID from polymarket.com',
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// In-memory storage for development
const inMemoryGames: Map<string, LiveGame> = new Map();

// In-memory cache for production (to avoid fetching all games on every update)
const gamesCache: Map<string, LiveGame> = new Map();

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
  gameId?: number;
  score?: string;
  period?: string;
  elapsed?: string;
  live?: boolean;
  ended?: boolean;
  [key: string]: any;
}

/**
 * Extended TransformedEvent with live game specific fields
 */
export interface LiveGame extends Omit<TransformedEvent, 'createdAt' | 'updatedAt'> {
  createdAt: Date;
  updatedAt: Date;
  ticker?: string;
  resolutionSource?: string;
  volume?: number;
  volume24hr?: number;
  sport?: string;
  league?: string;
  seriesId?: string;
  gameId?: number;
  score?: string;
  period?: string;
  elapsed?: string;
  live?: boolean;
  ended?: boolean;
  periodScores?: Record<string, { home: number; away: number }>;
  homeTeam?: Team;
  awayTeam?: Team;
  teamIdentifiers?: {
    home?: string;
    away?: string;
  };
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
  
  const sportsConfig = getAllSportsGamesConfig();
  
  for (const [sport] of Object.entries(sportsConfig)) {
    const sportIndicators: Record<string, string[]> = {
      nfl: ['nfl', 'football'],
      nba: ['nba', 'basketball'],
      mlb: ['mlb', 'baseball'],
      nhl: ['nhl', 'hockey'],
      ufc: ['ufc', 'mma'],
      epl: ['epl', 'premier league', 'premier-league'],
      lal: ['lal', 'la liga', 'la-liga', 'laliga'],
      valorant: ['valorant', 'val', 'vct'],
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

const STANDARD_LEAGUES = new Set(['nfl', 'nba', 'mlb', 'nhl', 'ufc', 'epl', 'lal', 'valorant', 'val']);

function extractLeagueFromSlug(slug: string): string | null {
  if (!slug) return null;
  const parts = slug.toLowerCase().split('-');
  if (parts.length > 0) {
    return parts[0];
  }
  return null;
}

function isStandardLeague(league: string | null): boolean {
  if (!league) return false;
  return STANDARD_LEAGUES.has(league.toLowerCase());
}

function isGameInConfiguredSport(game: LiveGameEvent): boolean {
  const sport = extractSportFromGame(game);
  if (!sport) return false;
  
  const seriesId = getSeriesIdForSport(sport);
  if (seriesId === null || seriesId === '') {
    return false;
  }
  
  const league = extractLeagueFromSlug(game.slug);
  if (!isStandardLeague(league)) {
    return false;
  }
  
  return true;
}

function convertToPolymarketEvent(event: LiveGameEvent): PolymarketEvent {
  return {
    id: event.id,
    ticker: event.ticker || event.slug || event.id,
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

function extractTeamsFromEvent(event: TransformedEvent): { home?: string; away?: string } {
  const title = event.title || '';
  const separators = [' vs. ', ' vs ', ' @ ', ' at ', ' - '];
  
  for (const separator of separators) {
    const parts = title.split(separator);
    if (parts.length === 2) {
      const team1 = parts[0].trim().replace(/\s*\(.*?\)\s*$/, '');
      const team2 = parts[1].trim().replace(/\s*\(.*?\)\s*$/, '');
      
      if (separator.includes('@') || separator.includes('at')) {
        // "@" format: "Away @ Home" -> team1 is away, team2 is home
        return { away: team1, home: team2 };
      } else {
        // "vs" format: "Away vs Home" -> team1 is away, team2 is home
        // This matches the slug format: sport-away-home-date
        return { away: team1, home: team2 };
      }
    }
  }
  
  const slug = event.slug || '';
  const slugParts = slug.split('-');
  const teamAbbrevs: string[] = [];
  
  // Common sport identifiers to skip
  const sportIdentifiers = new Set(['nhl', 'nba', 'nfl', 'mlb', 'epl', 'lal', 'ser', 'bund', 'lig1', 'mls']);
  
  for (const part of slugParts) {
    // Skip numbers
    if (/^\d+$/.test(part)) continue;
    // Skip sport identifier (first part is usually sport)
    if (slugParts.indexOf(part) === 0 && sportIdentifiers.has(part.toLowerCase())) continue;
    // Match team abbreviations (2-5 letters)
    if (part.length >= 2 && part.length <= 5 && /^[a-z]+$/i.test(part)) {
      teamAbbrevs.push(part.toUpperCase());
    }
  }
  
  if (teamAbbrevs.length >= 2) {
    // Slug format: sport-away-home-date, so first team is away, second is home
    return { away: teamAbbrevs[0], home: teamAbbrevs[1] };
  }
  
  return {};
}

function normalizeForMatching(str: string): string {
  return str.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').trim();
}

function matchTeamUsingLookup(
  identifier: string,
  teamsByAbbreviation: Map<string, Team>,
  teamsByName: Map<string, Team>,
  teamsByAlias: Map<string, Team>,
  teams: Team[]
): Team | null {
  if (!identifier || teams.length === 0) return null;

  const normalizedIdentifier = normalizeForMatching(identifier);

  // Exact match on abbreviation
  const abbrevMatch = teamsByAbbreviation.get(normalizedIdentifier);
  if (abbrevMatch) return abbrevMatch;

  // Exact match on name
  const nameMatch = teamsByName.get(normalizedIdentifier);
  if (nameMatch) return nameMatch;

  // Exact match on alias
  const aliasMatch = teamsByAlias.get(normalizedIdentifier);
  if (aliasMatch) return aliasMatch;

  // Partial matching for longer identifiers
  if (normalizedIdentifier.length >= 5) {
  for (const team of teams) {
      const teamNameNormalized = normalizeForMatching(team.name);
      const teamAliasNormalized = team.alias ? normalizeForMatching(team.alias) : '';
      
      if (teamNameNormalized.includes(normalizedIdentifier) || 
          normalizedIdentifier.includes(teamNameNormalized) ||
          (teamAliasNormalized && (teamAliasNormalized.includes(normalizedIdentifier) || 
           normalizedIdentifier.includes(teamAliasNormalized)))) {
      return team;
      }
    }
  }

  return null;
}

async function enrichEventsWithTeams(events: TransformedEvent[], sport: string): Promise<LiveGame[]> {
  const league = getLeagueForSport(sport);
  if (!league) {
    return events.map((e) => ({ ...e, createdAt: new Date(), updatedAt: new Date(), rawData: {} as LiveGameEvent }));
  }

  let teams: Team[] = [];
  try {
    teams = await teamsService.getTeamsByLeague(league);
  } catch (error) {
    logger.warn({
      message: 'Failed to fetch teams, continuing without team enrichment',
      sport, league,
      error: error instanceof Error ? error.message : String(error),
    });
    return events.map((e) => ({ ...e, createdAt: new Date(), updatedAt: new Date(), rawData: {} as LiveGameEvent }));
  }

  const teamsByAbbreviation = new Map<string, Team>();
  const teamsByName = new Map<string, Team>();
  const teamsByAlias = new Map<string, Team>();

  for (const team of teams) {
    if (team.abbreviation) teamsByAbbreviation.set(normalizeForMatching(team.abbreviation), team);
    if (team.name) teamsByName.set(normalizeForMatching(team.name), team);
    if (team.alias) teamsByAlias.set(normalizeForMatching(team.alias), team);
  }

  return events.map((event) => {
    const liveGame: LiveGame = { ...event, createdAt: new Date(), updatedAt: new Date(), rawData: {} as LiveGameEvent };
    const teamIdentifiers = extractTeamsFromEvent(event);
    
    if (teamIdentifiers.home || teamIdentifiers.away) {
      liveGame.teamIdentifiers = teamIdentifiers;
      
      if (teamIdentifiers.home) {
        const homeTeam = matchTeamUsingLookup(teamIdentifiers.home, teamsByAbbreviation, teamsByName, teamsByAlias, teams);
        if (homeTeam) liveGame.homeTeam = homeTeam;
      }
      
      if (teamIdentifiers.away) {
        const awayTeam = matchTeamUsingLookup(teamIdentifiers.away, teamsByAbbreviation, teamsByName, teamsByAlias, teams);
        if (awayTeam) liveGame.awayTeam = awayTeam;
      }
    }
    
    return liveGame;
  });
}

async function transformAndEnrichGames(events: LiveGameEvent[]): Promise<LiveGame[]> {
  const polymarketEvents = events.map(convertToPolymarketEvent);
  const transformedEvents = transformEvents(polymarketEvents);
  
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
  
  const enrichmentPromises = Array.from(eventsBySport.entries()).map(async ([sport, eventPairs]) => {
    const transformedEventsForSport = eventPairs.map(p => p.transformed);
    const rawEventsForSport = eventPairs.map(p => p.raw);
    
    const enriched = await enrichEventsWithTeams(transformedEventsForSport, sport);
    
    return enriched.map((enrichedGame, index) => {
      const rawEvent = rawEventsForSport[index];
      
      enrichedGame.sport = sport;
      enrichedGame.league = sport;
      enrichedGame.seriesId = getSeriesIdForSport(sport) || undefined;
      enrichedGame.gameId = rawEvent.gameId;
      enrichedGame.score = rawEvent.score;
      enrichedGame.period = rawEvent.period;
      enrichedGame.elapsed = rawEvent.elapsed;
      enrichedGame.live = rawEvent.live;
      enrichedGame.ended = rawEvent.ended;
      enrichedGame.ticker = rawEvent.ticker || rawEvent.slug || rawEvent.id || 'UNKNOWN';
      enrichedGame.rawData = rawEvent;
      
      return enrichedGame;
    });
  });
  
  const enrichedBySport = await Promise.all(enrichmentPromises);
  return enrichedBySport.flat();
}

/**
 * Process live games API response and extract events
 */
function processLiveGamesResponse(response: AxiosResponse<LiveGamesApiResponse>): LiveGameEvent[] {
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
}

/**
 * Fetch live games from Polymarket endpoint
 * Automatically updates build ID on 404 errors
 */
export async function fetchLiveGames(): Promise<LiveGameEvent[]> {
  const endpoint = getLiveEndpoint();
  
  try {
    // logger.info({
    //   message: 'Fetching live games from Polymarket',
    //   endpoint,
    // });

    const response = await axios.get<LiveGamesApiResponse>(endpoint, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      timeout: 30000,
      validateStatus: (status) => status < 500,
    });

    // Check for 404 - build ID may be outdated
    if (response.status === 404) {
      logger.warn({
        message: 'Live games endpoint returned 404 - attempting to refresh build ID',
        endpoint,
      });
      
      const buildIdUpdated = await fetchAndUpdateBuildId();
      
      if (buildIdUpdated) {
        const newEndpoint = getLiveEndpoint();
        logger.info({
          message: 'Retrying live games fetch with updated build ID',
          newEndpoint,
        });
        
        const retryResponse = await axios.get<LiveGamesApiResponse>(newEndpoint, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
            'Accept': 'application/json',
          },
          timeout: 30000,
          validateStatus: (status) => status < 500,
        });
        
        if (retryResponse.status === 404) {
          logger.warn({ message: 'Live games endpoint still returned 404 after build ID update' });
          return [];
        }
        
        if (retryResponse.status >= 400) {
          logger.warn({ message: 'Live games endpoint returned error status after retry', status: retryResponse.status });
          return [];
        }
        
        return processLiveGamesResponse(retryResponse);
      } else {
        logger.warn({ message: 'Could not update build ID, returning empty array' });
        return [];
      }
    }

    if (response.status >= 400) {
      logger.warn({ message: 'Live games endpoint returned error status', status: response.status });
      return [];
    }

    return processLiveGamesResponse(response);

  } catch (error) {
    const isAxiosError = error && typeof error === 'object' && 'response' in error;
    const status = isAxiosError && (error as any).response?.status;
    
    if (status === 404) {
      logger.warn({ message: '404 error - attempting to refresh build ID' });
      
      const buildIdUpdated = await fetchAndUpdateBuildId();
      
      if (buildIdUpdated) {
        try {
          const newEndpoint = getLiveEndpoint();
          const retryResponse = await axios.get<LiveGamesApiResponse>(newEndpoint, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
              'Accept': 'application/json',
            },
            timeout: 30000,
            validateStatus: (status) => status < 500,
          });
          
          if (retryResponse.status < 400) {
            return processLiveGamesResponse(retryResponse);
          }
        } catch (retryError) {
          logger.error({
            message: 'Error in retry after build ID update',
            error: retryError instanceof Error ? retryError.message : String(retryError),
          });
        }
      }
    }
    
    logger.error({
      message: 'Error fetching live games',
      error: error instanceof Error ? error.message : String(error),
    });
    
    return [];
  }
}

function isGameEnded(game: LiveGameEvent): boolean {
  // Check explicit ended/closed flags
  if (game.ended === true) return true;
  if (game.closed === true) return true;
  
  // Check if all markets are closed
  if (game.markets && game.markets.length > 0) {
    const allMarketsClosed = game.markets.every((m: any) => m.closed === true);
    if (allMarketsClosed) return true;
  }

  // Check if end_date + 3 hour grace period has passed
  if (game.endDate) {
    const endDate = new Date(game.endDate);
    const now = new Date();
    const graceTime = 3 * 60 * 60 * 1000; // 3 hours
    if ((endDate.getTime() + graceTime) < now.getTime()) return true;
  }

  return false;
}

export function filterGamesBySports(games: LiveGameEvent[]): LiveGameEvent[] {
  return games.filter(isGameInConfiguredSport);
}

export function filterOutEndedGames(games: LiveGameEvent[]): LiveGameEvent[] {
  return games.filter(game => !isGameEnded(game));
}

async function cleanupEndedGames(): Promise<number> {
  const isProduction = process.env.NODE_ENV === 'production';
  const GRACE_PERIOD_HOURS = 3; // 3 hour grace period after end_date
  
  if (!isProduction) {
    let removedCount = 0;
    const now = new Date();
    
    for (const [id, game] of inMemoryGames.entries()) {
      // Check explicit ended/closed flags first
      let isEnded = game.ended === true || game.closed === true;
      
      // Check if end_date + grace period has passed
      if (!isEnded && game.endDate) {
        const endDate = new Date(game.endDate);
        const graceTime = GRACE_PERIOD_HOURS * 60 * 60 * 1000;
        isEnded = (endDate.getTime() + graceTime) < now.getTime();
      }
      
      if (isEnded) {
        inMemoryGames.delete(id);
        gamesCache.delete(id);
        removedCount++;
      }
    }
    
    return removedCount;
  }
  
  const client = await pool.connect();
  
  try {
    // Delete games that are:
    // 1. Marked as ended
    // 2. Marked as closed (market closed)
    // 3. End date + 3 hours has passed (grace period for games that didn't update properly)
    const result = await client.query(`
      DELETE FROM live_games 
      WHERE ended = true 
         OR closed = true 
         OR (end_date IS NOT NULL AND end_date + INTERVAL '3 hours' < NOW())
    `);
    
    const removedCount = result.rowCount || 0;
    if (removedCount > 0) {
      logger.info({
        message: 'Cleaned up ended games from database',
        removedCount,
      });
      gamesCache.clear();
    }
    
    return removedCount;
  } catch (error) {
    logger.error({
      message: 'Error cleaning up ended games from database',
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  } finally {
    client.release();
  }
}

/**
 * Extract probabilities from a game's moneyline market
 */
function extractGameProbabilities(game: LiveGame): { homeProb: number; awayProb: number; homeBuy: number; awayBuy: number } | null {
  if (!game.markets || game.markets.length === 0) {
    return null;
  }
  
  // Find moneyline market (first market with team outcomes, not Over/Under)
  for (const market of game.markets) {
    const outcomes = market.structuredOutcomes;
    if (!outcomes || outcomes.length !== 2) continue;
    
    const labels = outcomes.map((o: any) => String(o.label || '').toLowerCase());
    
    // Skip Over/Under markets
    if (labels.some(l => l.includes('over') || l.includes('under') || l.includes('o/u'))) {
      continue;
    }
    
    // Found team market
    const o1 = outcomes[0];
    const o2 = outcomes[1];
    const price1 = parseFloat(String(o1.price || '50'));
    const price2 = parseFloat(String(o2.price || '50'));
    
    // Determine home/away based on team matching or title order
    const titleLower = (game.title || '').toLowerCase();
    const o1Label = String(o1.label || '').toLowerCase();
    const o2Label = String(o2.label || '').toLowerCase();
    const o1Pos = titleLower.indexOf(o1Label);
    const o2Pos = titleLower.indexOf(o2Label);
    
    let homeProb: number, awayProb: number;
    
    if (o1Pos !== -1 && o2Pos !== -1 && o1Pos < o2Pos) {
      // o1 is home (appears first in title)
      homeProb = price1;
      awayProb = price2;
    } else {
      // o2 is home or can't determine - use position in outcomes
      homeProb = price2;
      awayProb = price1;
    }
    
    return {
      homeProb: Number(homeProb.toFixed(1)),
      awayProb: Number(awayProb.toFixed(1)),
      homeBuy: Math.ceil(homeProb),
      awayBuy: Math.ceil(awayProb),
    };
  }
  
  return null;
}

export async function storeGames(games: LiveGame[]): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (isProduction) {
    await storeGamesInDatabase(games);
  } else {
    storeGamesInMemory(games);
  }
  
  // Record probability snapshots for all games (async, non-blocking)
  recordProbabilitySnapshots(games).catch(error => {
    logger.warn({
      message: 'Error recording probability snapshots (non-blocking)',
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Record probability snapshots for multiple games
 */
async function recordProbabilitySnapshots(games: LiveGame[]): Promise<void> {
  for (const game of games) {
    const probs = extractGameProbabilities(game);
    if (probs) {
      await recordProbabilitySnapshot(
        game.id,
        probs.homeProb,
        probs.awayProb,
        probs.homeBuy,
        probs.awayBuy
      );
    }
  }
}

async function storeGamesInDatabase(games: LiveGame[]): Promise<void> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    if (games.length === 0) {
      await client.query('COMMIT');
      return;
    }

    // Build bulk insert query
    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const game of games) {
      const ticker = game.ticker || game.slug || game.id || 'UNKNOWN';
      const rowPlaceholders: string[] = [];
      
      // 29 parameters + 2 CURRENT_TIMESTAMP = 31 total (matching 31 columns)
      for (let i = 0; i < 29; i++) {
        rowPlaceholders.push(`$${paramIndex++}`);
      }
      rowPlaceholders.push('CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP');
      placeholders.push(`(${rowPlaceholders.join(', ')})`);
      
      values.push(
        game.id, ticker, game.slug, game.title, game.description, game.resolutionSource,
        game.startDate, game.endDate, game.image, game.icon, game.active, game.closed,
        game.archived, game.restricted, game.liquidity, game.volume, game.volume24hr,
        game.competitive, game.sport, game.league, game.seriesId, game.gameId,
        game.score, game.period, game.elapsed, game.live, game.ended,
        JSON.stringify(game), JSON.stringify(game.rawData)
      );
    }

    const insertQuery = `
      INSERT INTO live_games (
        id, ticker, slug, title, description, resolution_source,
        start_date, end_date, image, icon, active, closed, archived,
        restricted, liquidity, volume, volume_24hr, competitive,
        sport, league, series_id, game_id, score, period, elapsed, live, ended,
        transformed_data, raw_data, created_at, updated_at
      ) VALUES ${placeholders.join(', ')}
      ON CONFLICT (id) DO UPDATE SET
        ticker = EXCLUDED.ticker, slug = EXCLUDED.slug, title = EXCLUDED.title,
        description = EXCLUDED.description, resolution_source = EXCLUDED.resolution_source,
        start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
        image = EXCLUDED.image, icon = EXCLUDED.icon, active = EXCLUDED.active,
        closed = EXCLUDED.closed, archived = EXCLUDED.archived, restricted = EXCLUDED.restricted,
        liquidity = EXCLUDED.liquidity, volume = EXCLUDED.volume, volume_24hr = EXCLUDED.volume_24hr,
        competitive = EXCLUDED.competitive, sport = EXCLUDED.sport, league = EXCLUDED.league,
        series_id = EXCLUDED.series_id, game_id = EXCLUDED.game_id, score = EXCLUDED.score,
        period = EXCLUDED.period, elapsed = EXCLUDED.elapsed, live = EXCLUDED.live,
        ended = EXCLUDED.ended, transformed_data = EXCLUDED.transformed_data,
        raw_data = EXCLUDED.raw_data, updated_at = CURRENT_TIMESTAMP
    `;

    await client.query(insertQuery, values);
    await client.query('COMMIT');
    
    for (const game of games) {
      gamesCache.set(game.id, game);
    }
    
    logger.info({ message: 'Games stored in database', count: games.length });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error({
        message: 'Error during ROLLBACK in storeGamesInDatabase',
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
    logger.error({
      message: 'Error storing games in database',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

function storeGamesInMemory(games: LiveGame[]): void {
  for (const game of games) {
    inMemoryGames.set(game.id, game);
  }
  logger.info({ message: 'Games stored in memory', count: games.length, totalInMemory: inMemoryGames.size });
}

export async function getAllLiveGames(): Promise<LiveGame[]> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (isProduction) {
    if (gamesCache.size > 0) {
      return Array.from(gamesCache.values());
    }
    
    const games = await getAllLiveGamesFromDatabase();
    for (const game of games) {
      gamesCache.set(game.id, game);
    }
    
    if (games.length === 0) {
      logger.info({ message: 'Database is empty, fetching live games from API' });
      await refreshLiveGames();
      const refreshedGames = await getAllLiveGamesFromDatabase();
      gamesCache.clear();
      for (const game of refreshedGames) {
        gamesCache.set(game.id, game);
      }
      return refreshedGames;
    }
    
    return games;
  } else {
    const games = Array.from(inMemoryGames.values());
    
    if (games.length === 0) {
      logger.info({ message: 'In-memory storage is empty, fetching live games from API' });
      await refreshLiveGames();
      return Array.from(inMemoryGames.values());
    }
    
    return games;
  }
}

export async function getLiveGameById(id: string): Promise<LiveGame | null> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (isProduction) {
    // Check cache first
    if (gamesCache.has(id)) {
      return gamesCache.get(id) || null;
    }
    return await getLiveGameByIdFromDatabase(id);
  } else {
    return inMemoryGames.get(id) || null;
  }
}

export async function getLiveGameBySlug(slug: string): Promise<LiveGame | null> {
  if (!slug) return null;
  const target = slug.toLowerCase();
  const games = await getAllLiveGames();
  
  return games.find((game) => {
    const slugMatch = game.slug && game.slug.toLowerCase() === target;
    const tickerMatch = game.ticker && game.ticker.toLowerCase() === target;
    const idMatch = game.id.toLowerCase() === target;
    const rawSlugMatch = game.rawData?.slug && String(game.rawData.slug).toLowerCase() === target;
    return slugMatch || tickerMatch || idMatch || rawSlugMatch;
  }) || null;
}

async function getLiveGameByIdFromDatabase(id: string): Promise<LiveGame | null> {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      `SELECT transformed_data, raw_data, period_scores FROM live_games WHERE id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) return null;
    
    const row = result.rows[0];
    if (row.transformed_data) {
      const game = typeof row.transformed_data === 'string' 
        ? JSON.parse(row.transformed_data) 
        : row.transformed_data;
      if (game.createdAt && typeof game.createdAt === 'string') game.createdAt = new Date(game.createdAt);
      if (game.updatedAt && typeof game.updatedAt === 'string') game.updatedAt = new Date(game.updatedAt);
      
      // Add period_scores from database if available
      if (row.period_scores) {
        game.periodScores = typeof row.period_scores === 'string'
          ? JSON.parse(row.period_scores)
          : row.period_scores;
      }
      
      return game as LiveGame;
    }
    
    const rawData = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
    const game = { ...rawData, createdAt: new Date(), updatedAt: new Date(), rawData } as LiveGame;
    
    // Add period_scores from database if available
    if (row.period_scores) {
      game.periodScores = typeof row.period_scores === 'string'
        ? JSON.parse(row.period_scores)
        : row.period_scores;
    }
    
    return game;
  } finally {
    client.release();
  }
}

async function getAllLiveGamesFromDatabase(): Promise<LiveGame[]> {
  const client = await pool.connect();
  
  try {
    // Include games that are:
    // 1. Active and not closed/ended
    // 2. End date is today or in the future
    // Note: Don't filter by live here - let the route handler filter by live parameter
    const result = await client.query(
      `SELECT transformed_data, raw_data, period_scores FROM live_games
       WHERE active = true AND closed = false AND (ended = false OR ended IS NULL)
         AND (end_date IS NULL OR DATE(end_date) >= CURRENT_DATE)
      ORDER BY 
        CASE WHEN live = true THEN 0 ELSE 1 END,
        volume_24hr DESC NULLS LAST, 
        created_at DESC`
    );
    
    return result.rows.map((row) => {
      if (row.transformed_data) {
        const game = typeof row.transformed_data === 'string' 
          ? JSON.parse(row.transformed_data) 
          : row.transformed_data;
        if (game.createdAt && typeof game.createdAt === 'string') game.createdAt = new Date(game.createdAt);
        if (game.updatedAt && typeof game.updatedAt === 'string') game.updatedAt = new Date(game.updatedAt);
        
        // Add period_scores from database if available
        if (row.period_scores) {
          game.periodScores = typeof row.period_scores === 'string'
            ? JSON.parse(row.period_scores)
            : row.period_scores;
        }
        
        return game as LiveGame;
      }
      
      const rawData = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
      const game = { ...rawData, createdAt: new Date(), updatedAt: new Date(), rawData } as LiveGame;
      
      // Add period_scores from database if available
      if (row.period_scores) {
        game.periodScores = typeof row.period_scores === 'string'
          ? JSON.parse(row.period_scores)
          : row.period_scores;
      }
      
      return game;
    });
  } catch (error) {
    // If table doesn't exist, return empty array to trigger auto-population
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('does not exist') || (errorMessage.includes('relation') && errorMessage.includes('live_games'))) {
      logger.warn({
        message: 'live_games table does not exist, will trigger auto-population',
        error: errorMessage,
      });
      return [];
    }
    // Re-throw other errors
    throw error;
  } finally {
    client.release();
  }
}

export async function updateGame(gameUpdate: Partial<LiveGame> & { id: string }): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (isProduction) {
    await updateGameInDatabase(gameUpdate);
  } else {
    updateGameInMemory(gameUpdate);
  }
}

/**
 * Update game in cache only (for real-time price updates that already wrote to DB)
 */
export function updateGameInCache(gameId: string, updatedGame: LiveGame): void {
  gamesCache.set(gameId, updatedGame);
}

export async function updateGameByGameId(gameId: number, updates: Partial<LiveGame>): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (isProduction) {
    await updateGameByGameIdInDatabase(gameId, updates);
  } else {
    updateGameByGameIdInMemory(gameId, updates);
  }
}

/**
 * Normalize period string to a consistent key format
 * Q1, Q2, Q3, Q4 -> q1, q2, q3, q4
 * P1, P2, P3 -> p1, p2, p3
 * 1H, 2H -> 1h, 2h
 * OT -> ot
 */
function normalizePeriodKey(period: string | undefined): string | null {
  if (!period) return null;
  
  const periodLower = period.toLowerCase().trim();
  
  // Handle quarters (NBA, NFL)
  if (periodLower === 'q1' || periodLower === '1q' || periodLower === '1st') return 'q1';
  if (periodLower === 'q2' || periodLower === '2q' || periodLower === '2nd') return 'q2';
  if (periodLower === 'q3' || periodLower === '3q' || periodLower === '3rd') return 'q3';
  if (periodLower === 'q4' || periodLower === '4q' || periodLower === '4th') return 'q4';
  
  // Handle periods (NHL)
  if (periodLower === 'p1' || periodLower === '1p' || periodLower === 'period 1') return 'p1';
  if (periodLower === 'p2' || periodLower === '2p' || periodLower === 'period 2') return 'p2';
  if (periodLower === 'p3' || periodLower === '3p' || periodLower === 'period 3') return 'p3';
  
  // Handle halves (Soccer)
  if (periodLower === '1h' || periodLower === '1st half' || periodLower === 'first half') return '1h';
  if (periodLower === '2h' || periodLower === '2nd half' || periodLower === 'second half') return '2h';
  
  // Handle overtime
  if (periodLower === 'ot' || periodLower === 'overtime') return 'ot';
  
  // Return lowercase version if no match
  return periodLower;
}

/**
 * Parse score string (e.g., "0-2") into individual scores
 * Polymarket format: "away-home" (first number is AWAY team score, second is HOME team score)
 */
function parseScoreString(scoreStr: string | undefined): { home: number; away: number } | null {
  if (!scoreStr) return null;
  
  const parts = scoreStr.split('-').map(s => parseInt(s.trim(), 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    // Format is away-home: first number is away, second is home
    return { away: parts[0], home: parts[1] };
  }
  return null;
}

/**
 * Calculate period scores from current total and previous period scores
 */
function calculatePeriodScores(
  currentScore: { home: number; away: number },
  currentPeriod: string,
  previousPeriodScores: Record<string, { home: number; away: number }> | null
): Record<string, { home: number; away: number }> {
  const periodKey = normalizePeriodKey(currentPeriod);
  if (!periodKey) return previousPeriodScores || {};
  
  // If period already exists, don't recalculate (period score is final when period ends)
  if (previousPeriodScores && previousPeriodScores[periodKey]) {
    return previousPeriodScores;
  }
  
  // Calculate sum of previous periods
  let previousHomeTotal = 0;
  let previousAwayTotal = 0;
  
  if (previousPeriodScores) {
    for (const periodScore of Object.values(previousPeriodScores)) {
      previousHomeTotal += periodScore.home;
      previousAwayTotal += periodScore.away;
    }
  }
  
  // Current period score = current total - sum of previous periods
  const periodScore = {
    home: currentScore.home - previousHomeTotal,
    away: currentScore.away - previousAwayTotal,
  };
  
  // Only add if scores are non-negative (sanity check)
  if (periodScore.home >= 0 && periodScore.away >= 0) {
    return {
      ...(previousPeriodScores || {}),
      [periodKey]: periodScore,
    };
  }
  
  return previousPeriodScores || {};
}

async function updateGameByGameIdInDatabase(gameId: number, updates: Partial<LiveGame>): Promise<void> {
  const client = await pool.connect();
  
  try {
    const findResult = await client.query(
      'SELECT id, transformed_data, period, score, period_scores FROM live_games WHERE game_id = $1',
      [gameId]
    );
    
    if (findResult.rows.length === 0) {
      // Game doesn't exist - log for debugging (might be NFL or other missing game)
      logger.warn({
        message: 'Websocket update received for game not in database - may need refresh',
        gameId,
        live: updates.live,
        score: updates.score,
        period: updates.period,
      });
      return;
    }
    
    const eventId = findResult.rows[0].id;
    const current = findResult.rows[0].transformed_data 
      ? (typeof findResult.rows[0].transformed_data === 'string' 
          ? JSON.parse(findResult.rows[0].transformed_data) 
          : findResult.rows[0].transformed_data)
      : {};
    
    const previousPeriod = findResult.rows[0].period;
    const previousScore = findResult.rows[0].score;
    const previousPeriodScores = findResult.rows[0].period_scores 
      ? (typeof findResult.rows[0].period_scores === 'string'
          ? JSON.parse(findResult.rows[0].period_scores)
          : findResult.rows[0].period_scores)
      : null;
    
    // Check if period changed
    const periodChanged = updates.period !== undefined && updates.period !== previousPeriod;
    const scoreChanged = updates.score !== undefined && updates.score !== previousScore;
    
    // Calculate period scores if period or score changed
    let newPeriodScores = previousPeriodScores;
    if ((periodChanged || scoreChanged) && updates.score && updates.period && updates.period !== 'NS') {
      const currentScore = parseScoreString(updates.score);
      if (currentScore) {
        newPeriodScores = calculatePeriodScores(
          currentScore,
          updates.period,
          previousPeriodScores
        );
        updates.periodScores = newPeriodScores;
      }
    }
    
    // Build atomic JSONB updates to avoid race conditions with CLOB price updates
    // Each field is updated independently without reading/rewriting the whole object
    const updateFields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    // Column updates (separate from JSONB)
    if (updates.score !== undefined) { updateFields.push(`score = $${paramIndex++}`); values.push(updates.score); }
    if (updates.period !== undefined) { updateFields.push(`period = $${paramIndex++}`); values.push(updates.period); }
    if (updates.elapsed !== undefined) { updateFields.push(`elapsed = $${paramIndex++}`); values.push(updates.elapsed); }
    if (updates.live !== undefined) { updateFields.push(`live = $${paramIndex++}`); values.push(updates.live); }
    if (updates.ended !== undefined) { updateFields.push(`ended = $${paramIndex++}`); values.push(updates.ended); }
    if (updates.active !== undefined) { updateFields.push(`active = $${paramIndex++}`); values.push(updates.active); }
    if (updates.closed !== undefined) { updateFields.push(`closed = $${paramIndex++}`); values.push(updates.closed); }
    if (newPeriodScores !== null) {
      updateFields.push(`period_scores = $${paramIndex++}`);
      values.push(JSON.stringify(newPeriodScores));
    }
    
    // Build atomic JSONB set operations for transformed_data
    // This preserves existing fields (like markets) while updating only specific fields
    let jsonbUpdate = 'COALESCE(transformed_data, \'{}\'::jsonb)';
    
    if (updates.score !== undefined) {
      jsonbUpdate = `jsonb_set(${jsonbUpdate}, '{score}', to_jsonb($${paramIndex++}::text))`;
      values.push(updates.score);
    }
    if (updates.period !== undefined) {
      jsonbUpdate = `jsonb_set(${jsonbUpdate}, '{period}', to_jsonb($${paramIndex++}::text))`;
      values.push(updates.period);
    }
    if (updates.elapsed !== undefined) {
      jsonbUpdate = `jsonb_set(${jsonbUpdate}, '{elapsed}', to_jsonb($${paramIndex++}::text))`;
      values.push(updates.elapsed);
    }
    if (updates.live !== undefined) {
      jsonbUpdate = `jsonb_set(${jsonbUpdate}, '{live}', to_jsonb($${paramIndex++}::boolean))`;
      values.push(updates.live);
    }
    if (updates.ended !== undefined) {
      jsonbUpdate = `jsonb_set(${jsonbUpdate}, '{ended}', to_jsonb($${paramIndex++}::boolean))`;
      values.push(updates.ended);
    }
    if (updates.active !== undefined) {
      jsonbUpdate = `jsonb_set(${jsonbUpdate}, '{active}', to_jsonb($${paramIndex++}::boolean))`;
      values.push(updates.active);
    }
    if (updates.closed !== undefined) {
      jsonbUpdate = `jsonb_set(${jsonbUpdate}, '{closed}', to_jsonb($${paramIndex++}::boolean))`;
      values.push(updates.closed);
    }
    if (newPeriodScores !== null) {
      jsonbUpdate = `jsonb_set(${jsonbUpdate}, '{periodScores}', $${paramIndex++}::jsonb)`;
      values.push(JSON.stringify(newPeriodScores));
    }
    // Always update timestamp
    jsonbUpdate = `jsonb_set(${jsonbUpdate}, '{updatedAt}', to_jsonb($${paramIndex++}::text))`;
    values.push(new Date().toISOString());
    
    updateFields.push(`transformed_data = ${jsonbUpdate}`);
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(eventId);
    
    await client.query(`UPDATE live_games SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`, values);
    
    // Build updated game from current + updates for broadcasting
    const updatedGame = { ...current, ...updates, updatedAt: new Date() } as LiveGame;
    if (newPeriodScores) {
      updatedGame.periodScores = newPeriodScores;
    }
    gamesCache.set(eventId, updatedGame);
    
    if (liveGamesService) {
      liveGamesService.broadcastPartialUpdate(updatedGame);
    }
  } finally {
    client.release();
  }
}

function updateGameByGameIdInMemory(gameId: number, updates: Partial<LiveGame>): void {
  for (const [eventId, game] of inMemoryGames.entries()) {
    if (game.gameId === gameId) {
      // Check if period changed
      const periodChanged = updates.period !== undefined && updates.period !== game.period;
      const scoreChanged = updates.score !== undefined && updates.score !== game.score;
      
      // Calculate period scores if period or score changed
      let newPeriodScores = game.periodScores;
      if ((periodChanged || scoreChanged) && updates.score && updates.period && updates.period !== 'NS') {
        const currentScore = parseScoreString(updates.score);
        if (currentScore) {
          newPeriodScores = calculatePeriodScores(
            currentScore,
            updates.period,
            game.periodScores || null
          );
          updates.periodScores = newPeriodScores;
        }
      }
      
      const updatedGame = { ...game, ...updates, updatedAt: new Date() };
      inMemoryGames.set(eventId, updatedGame);
      
      if (liveGamesService) {
        liveGamesService.broadcastPartialUpdate(updatedGame);
      }
      return;
    }
  }
}

async function updateGameInDatabase(gameUpdate: Partial<LiveGame> & { id: string }): Promise<void> {
  const client = await pool.connect();
  
  try {
    // Get current game data if markets need updating
    let current: any = null;
    if (gameUpdate.markets !== undefined) {
      const findResult = await client.query(
        'SELECT transformed_data FROM live_games WHERE id = $1',
        [gameUpdate.id]
      );
      
      if (findResult.rows.length === 0) {
        logger.warn({ message: 'Game not found for update', gameId: gameUpdate.id });
        return;
      }
      
      current = findResult.rows[0].transformed_data 
        ? (typeof findResult.rows[0].transformed_data === 'string' 
            ? JSON.parse(findResult.rows[0].transformed_data) 
            : findResult.rows[0].transformed_data)
        : {};
    }
    
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (gameUpdate.score !== undefined) { updates.push(`score = $${paramIndex++}`); values.push(gameUpdate.score); }
    if (gameUpdate.period !== undefined) { updates.push(`period = $${paramIndex++}`); values.push(gameUpdate.period); }
    if (gameUpdate.elapsed !== undefined) { updates.push(`elapsed = $${paramIndex++}`); values.push(gameUpdate.elapsed); }
    if (gameUpdate.live !== undefined) { updates.push(`live = $${paramIndex++}`); values.push(gameUpdate.live); }
    if (gameUpdate.ended !== undefined) { updates.push(`ended = $${paramIndex++}`); values.push(gameUpdate.ended); }
    
    // Update transformed_data if markets changed
    if (gameUpdate.markets !== undefined && current) {
      const updated = { ...current, ...gameUpdate, updatedAt: new Date() };
      updates.push(`transformed_data = $${paramIndex++}`);
      values.push(JSON.stringify(updated));
    }
    
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(gameUpdate.id);
    
    await client.query(`UPDATE live_games SET ${updates.join(', ')} WHERE id = $${paramIndex}`, values);
    
    // Update cache and broadcast - ALWAYS broadcast even if not in cache
    const cached = gamesCache.get(gameUpdate.id);
    const updatedGame = cached 
      ? { ...cached, ...gameUpdate, updatedAt: new Date() }
      : gameUpdate as LiveGame;
    
    if (cached) {
      gamesCache.set(gameUpdate.id, updatedGame);
    }
    
    // Always broadcast updates
    if (liveGamesService) {
      logger.info({
        message: 'Broadcasting game update',
        gameId: gameUpdate.id,
        inCache: !!cached,
      });
      liveGamesService.broadcastPartialUpdate(updatedGame);
    }
  } finally {
    client.release();
  }
}

function updateGameInMemory(gameUpdate: Partial<LiveGame> & { id: string }): void {
  const existing = inMemoryGames.get(gameUpdate.id);
  if (existing) {
    const updatedGame = { ...existing, ...gameUpdate, updatedAt: new Date() };
    inMemoryGames.set(gameUpdate.id, updatedGame);
    
    if (liveGamesService) {
      liveGamesService.broadcastPartialUpdate(updatedGame);
    }
  }
}

export async function refreshLiveGames(): Promise<number> {
  try {
    logger.info({ message: 'Refreshing live games' });

    const allGames = await fetchLiveGames();
    
    if (allGames.length === 0) {
      logger.warn({ message: 'No games fetched from API - endpoint may be unavailable' });
      const existingGames = await getAllLiveGames();
      return existingGames.length;
    }
    
    const filteredGames = filterGamesBySports(allGames);
    
    // Log filtering stats for debugging
    const nflGames = allGames.filter(g => {
      const slug = g.slug?.toLowerCase() || '';
      const title = g.title?.toLowerCase() || '';
      return slug.includes('nfl') || slug.includes('football') || title.includes('nfl') || title.includes('football');
    });
    
    if (nflGames.length > 0) {
      logger.info({
        message: 'NFL games found in API response',
        totalNfl: nflGames.length,
        nflSlugs: nflGames.map(g => g.slug).slice(0, 5),
      });
    }

    if (filteredGames.length === 0) {
      const existingGames = await getAllLiveGames();
      return existingGames.length;
    }
    
    const activeGames = filterOutEndedGames(filteredGames);
    
    if (activeGames.length === 0) {
      const existingGames = await getAllLiveGames();
      return existingGames.length;
    }
    
    const liveGames = await transformAndEnrichGames(activeGames);
    await storeGames(liveGames);
    
    const removedCount = await cleanupEndedGames();
    
    const allStoredGames = await getAllLiveGames();
    if (liveGamesService) {
      liveGamesService.broadcastUpdate(allStoredGames);
    }
    
    logger.info({
      message: 'Live games refreshed',
      totalFetched: allGames.length,
      afterSportFilter: filteredGames.length,
      afterEndedFilter: activeGames.length,
      stored: liveGames.length,
      removedEnded: removedCount,
    });
    
    return liveGames.length;
  } catch (error) {
    logger.error({
      message: 'Error refreshing live games',
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      const existingGames = await getAllLiveGames();
      return existingGames.length;
    } catch {
      return 0;
    }
  }
}

export function getInMemoryStats(): { count: number; games: LiveGame[] } {
  return { count: inMemoryGames.size, games: Array.from(inMemoryGames.values()) };
}

export class LiveGamesService {
  private pollingInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private sseBroadcastCallbacks: Set<(games: LiveGame[]) => void> = new Set();
  private ssePartialBroadcastCallbacks: Set<(game: LiveGame) => void> = new Set();

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    
    refreshLiveGames().catch((error) => {
      logger.error({
        message: 'Error in initial live games fetch',
        error: error instanceof Error ? error.message : String(error),
      });
    });

    this.pollingInterval = setInterval(() => {
      refreshLiveGames().catch((error) => {
        logger.error({
          message: 'Error in live games polling',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, POLLING_INTERVAL);

    logger.info({ message: 'Live games polling started', intervalMinutes: POLLING_INTERVAL / 60000 });
  }

  stop(): void {
    if (!this.isRunning) return;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    this.isRunning = false;
    logger.info({ message: 'Live games polling stopped' });
  }

  setSSEBroadcastCallback(callback: (games: LiveGame[]) => void): void {
    this.sseBroadcastCallbacks.add(callback);
  }

  addSSEBroadcastCallback(callback: (games: LiveGame[]) => void): void {
    this.sseBroadcastCallbacks.add(callback);
  }

  setSSEPartialBroadcastCallback(callback: (game: LiveGame) => void): void {
    this.ssePartialBroadcastCallbacks.add(callback);
  }

  addSSEPartialBroadcastCallback(callback: (game: LiveGame) => void): void {
    this.ssePartialBroadcastCallbacks.add(callback);
  }

  getStatus(): { isRunning: boolean; intervalMinutes: number } {
    return { isRunning: this.isRunning, intervalMinutes: POLLING_INTERVAL / 60000 };
  }

  broadcastUpdate(games: LiveGame[]): void {
    for (const callback of this.sseBroadcastCallbacks) {
      try {
        callback(games);
      } catch (error) {
        logger.warn({
          message: 'Error in SSE broadcast callback',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  broadcastPartialUpdate(game: LiveGame): void {
    logger.info({
      message: 'Broadcasting partial update to callbacks',
      gameId: game.id,
      slug: game.slug,
      callbackCount: this.ssePartialBroadcastCallbacks.size,
    });

    for (const callback of this.ssePartialBroadcastCallbacks) {
      try {
        callback(game);
      } catch (error) {
        logger.warn({
          message: 'Error in SSE partial broadcast callback',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export const liveGamesService = new LiveGamesService();
