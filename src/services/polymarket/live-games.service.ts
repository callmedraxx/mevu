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
import { recordProbabilitySnapshotsBulk, initializeProbabilityHistoryTable } from './probability-history.service';
import type { ProbabilitySnapshot } from './probability-history.service';
import { upsertFrontendGamesForLiveGames, upsertFrontendGameForLiveGame, bulkUpsertFrontendGamesWithClient, clearFrontendGamesCache } from './frontend-games.service';
import { transformToFrontendGame } from './frontend-game.transformer';

// Build ID may change - we'll need to fetch it dynamically or update periodically
// Default build ID - will be updated when 404 is encountered
let currentBuildId = '6w0cVAj-lCsqW5cBTIuDH';

/**
 * Get the live endpoint URL with current build ID
 */
function getLiveEndpoint(): string {
  return `https://polymarket.com/_next/data/${currentBuildId}/sports/live.json?slug=live`;
}

const POLLING_INTERVAL = 60 * 60 * 1000; // 20 minutes in milliseconds

/** Callbacks invoked when live_games is refreshed (live or sports pipeline) */
const onGamesRefreshedCallbacks: Set<() => void> = new Set();

/** Callbacks invoked when refresh starts (pause CLOB flush) */
const onRefreshStartingCallbacks: Set<() => void> = new Set();
/** Callbacks invoked when refresh ends (unpause CLOB flush) */
const onRefreshEndedCallbacks: Set<() => void> = new Set();
let refreshInProgressCount = 0;

export function registerOnGamesRefreshed(callback: () => void): () => void {
  onGamesRefreshedCallbacks.add(callback);
  return () => onGamesRefreshedCallbacks.delete(callback);
}

export function registerOnRefreshStarting(callback: () => void): () => void {
  onRefreshStartingCallbacks.add(callback);
  return () => onRefreshStartingCallbacks.delete(callback);
}

export function registerOnRefreshEnded(callback: () => void): () => void {
  onRefreshEndedCallbacks.add(callback);
  return () => onRefreshEndedCallbacks.delete(callback);
}

export function notifyGamesRefreshStarting(): void {
  refreshInProgressCount++;
  if (refreshInProgressCount === 1) {
    for (const cb of onRefreshStartingCallbacks) {
      try {
        cb();
      } catch (err) {
        logger.warn({
          message: 'Error in onRefreshStarting callback',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

export function notifyGamesRefreshEnded(): void {
  if (refreshInProgressCount <= 0) return;
  refreshInProgressCount--;
  if (refreshInProgressCount === 0) {
    for (const cb of onRefreshEndedCallbacks) {
      try {
        cb();
      } catch (err) {
        logger.warn({
          message: 'Error in onRefreshEnded callback',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

export function notifyGamesRefreshed(): void {
  for (const cb of onGamesRefreshedCallbacks) {
    try {
      cb();
    } catch (err) {
      logger.warn({
        message: 'Error in onGamesRefreshed callback',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Write mutex for live_games table. Serializes all writers to prevent lock contention.
 */
const liveGamesWriteLockQueue: Array<() => void> = [];
let liveGamesWriteLockHeld = false;

export async function acquireLiveGamesWriteLock(): Promise<void> {
  if (!liveGamesWriteLockHeld) {
    liveGamesWriteLockHeld = true;
    return;
  }
  await new Promise<void>((resolve) => liveGamesWriteLockQueue.push(resolve));
}

export function releaseLiveGamesWriteLock(): void {
  if (liveGamesWriteLockQueue.length > 0) {
    const next = liveGamesWriteLockQueue.shift()!;
    next();
  } else {
    liveGamesWriteLockHeld = false;
  }
}

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
    // logger.info({
    //   message: 'Fetching build ID from polymarket.com root page',
    // });

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
      
      // logger.info({
      //   message: 'Build ID updated successfully',
      //   oldBuildId,
      //   newBuildId: buildId,
      //   endpoint: getLiveEndpoint(),
      // });
      
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
export const gamesCache: Map<string, LiveGame> = new Map();

// Map gameId (numeric, from Sports WS) -> eventId (Polymarket id) for fast sports update lookups
const gameIdToEventId: Map<number, string> = new Map();

function addGameToCache(game: LiveGame): void {
  gamesCache.set(game.id, game);
  if (game.gameId != null) {
    gameIdToEventId.set(game.gameId, game.id);
  }
}

// Single-flight promise to avoid hammering the database with duplicate
// "load all games" queries under concurrent load.
let loadingAllLiveGamesPromise: Promise<LiveGame[]> | null = null;

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
  dataSource?: string; // 'live_games' or 'sports_games'
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
  
  // Blacklist: Known non-sports slugs that should never be classified as sports
  // These are financial/stock market games or other non-sports markets
  const NON_SPORTS_BLACKLIST = new Set([
    'nflx', // Netflix stock, not NFL
    'tsla', // Tesla stock
    'aapl', // Apple stock
    'spy',  // S&P 500 ETF
    'qqq',  // NASDAQ ETF
    'dow',  // Dow Jones
    'crypto', // Cryptocurrency markets
    'btc',  // Bitcoin
    'eth',  // Ethereum
  ]);
  
  const sportsConfig = getAllSportsGamesConfig();
  
  // PRIORITY 1: Check the first part of the slug as the sport identifier
  // Slug format is: sport-away-home-date, so the first part is always the sport
  const firstSlugPart = slug.split('-')[0];
  
  // If first slug part is in blacklist, reject immediately
  if (firstSlugPart && NON_SPORTS_BLACKLIST.has(firstSlugPart)) {
    return null;
  }
  
  // Check if first slug part matches a sport directly
  if (firstSlugPart && firstSlugPart in sportsConfig) {
    return firstSlugPart;
  }
  
  // PRIORITY 2: Check sport indicators with first slug part priority
  const sportIndicators: Record<string, string[]> = {
    nfl: ['nfl', 'football'],
    nba: ['nba', 'basketball'],
    mlb: ['mlb', 'baseball'],
    nhl: ['nhl', 'hockey'],
    ufc: ['ufc', 'mma'],
    epl: ['epl', 'premier league', 'premier-league'],
    lal: ['lal', 'la liga', 'la-liga', 'laliga'],
    cbb: ['cbb', 'college basketball', 'ncaa basketball', 'ncaab'],
    cfb: ['cfb', 'college football', 'ncaa football', 'ncaaf'],
    // Tennis games are listed under ATP/WTA tours in Polymarket slugs.
    // We normalize both into a single "tennis" sport internally.
    tennis: ['tennis', 'atp', 'wta'],
  };
  
  // First, check if first slug part matches any sport's indicators
  for (const [sport] of Object.entries(sportsConfig)) {
    const indicators = sportIndicators[sport] || [sport];
    for (const indicator of indicators) {
      if (firstSlugPart === indicator) {
        return sport;
      }
    }
  }
  
  // PRIORITY 3: Fallback to word-boundary matching in slug/title (for non-standard formats)
  // Use word boundaries to avoid false matches like "nflx" matching "nfl"
  for (const [sport] of Object.entries(sportsConfig)) {
    const indicators = sportIndicators[sport] || [sport];
    for (const indicator of indicators) {
      // Use word boundary regex to ensure exact word matches
      // This prevents "nflx" from matching "nfl"
      const slugWordBoundaryRegex = new RegExp(`\\b${indicator}\\b`, 'i');
      const titleWordBoundaryRegex = new RegExp(`\\b${indicator}\\b`, 'i');
      
      const slugMatch = slugWordBoundaryRegex.test(slug);
      const titleMatch = titleWordBoundaryRegex.test(title);
      
      if (slugMatch || titleMatch) {
        return sport;
      }
    }
  }
  
  return null;
}

// STANDARD_LEAGUES controls which slug prefixes are treated as "standard" sports
// for live-games filtering. For tennis, game slugs use "atp-..." and "wta-...",
// but we normalize the sport to "tennis" via the indicators above.
const STANDARD_LEAGUES = new Set([
  'nfl',
  'nba',
  'mlb',
  'nhl',
  'ufc',
  'epl',
  'lal',
  'cbb',
  'cfb',
  'tennis',
  'atp',
  'wta',
]);

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

function extractTeamsFromEvent(event: TransformedEvent, sport?: string): { home?: string; away?: string } {
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
  
  // Common sport identifiers (first segment in slug)
  const sportIdentifiers = new Set([
    'nhl',
    'nba',
    'nfl',
    'mlb',
    'epl',
    'cbb',
    'cfb',
    'lal',
    'ser',
    'bund',
    'lig1',
    'mls',
    'ufc',
    'tennis',
    'atp',
    'wta',
  ]);
  
  for (let i = 0; i < slugParts.length; i++) {
    const part = slugParts[i];
    const partLower = part.toLowerCase();
    
    // Skip numbers
    if (/^\d+$/.test(part)) continue;
    
    // Always skip the first part if it's a sport identifier (that's the actual sport in the slug)
    if (i === 0 && sportIdentifiers.has(partLower)) {
      continue;
    }
    
    // For other positions: only skip if it matches the game's actual sport
    // This prevents skipping team abbreviations that happen to match sport identifiers
    // (e.g., "nfl" in "cbb-colmb-nfl-2025-12-28" is "North Florida", not "National Football League")
    if (i > 0 && sport && partLower === sport.toLowerCase() && sportIdentifiers.has(partLower)) {
      continue;
    }
    
    // Match team abbreviations (2-10 letters to handle longer team names like HARVRD, BALLST)
    if (part.length >= 2 && part.length <= 10 && /^[a-z]+$/i.test(part)) {
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
  
  // Even if no league is configured, still extract team identifiers from slugs/titles
  // so they can be used as fallback team names
  if (!league) {
    return events.map((event) => {
      const liveGame: LiveGame = { ...event, createdAt: new Date(), updatedAt: new Date(), rawData: {} as LiveGameEvent };
      const teamIdentifiers = extractTeamsFromEvent(event, sport);
      if (teamIdentifiers.home || teamIdentifiers.away) {
        liveGame.teamIdentifiers = teamIdentifiers;
      }
      return liveGame;
    });
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
    // Still extract team identifiers even if team fetching fails
    return events.map((event) => {
      const liveGame: LiveGame = { ...event, createdAt: new Date(), updatedAt: new Date(), rawData: {} as LiveGameEvent };
      const teamIdentifiers = extractTeamsFromEvent(event, sport);
      if (teamIdentifiers.home || teamIdentifiers.away) {
        liveGame.teamIdentifiers = teamIdentifiers;
      }
      return liveGame;
    });
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
    const teamIdentifiers = extractTeamsFromEvent(event, sport);
    
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

export async function transformAndEnrichGames(events: LiveGameEvent[]): Promise<LiveGame[]> {
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
      // End-date override: if endDate + 3h grace has passed, force ended=true and live=false,
      // even if upstream still reports live=true (stale live flags happen occasionally).
      if (hasEndDateGracePassed(rawEvent.endDate)) {
        enrichedGame.live = false;
        enrichedGame.ended = true;
      } else if (rawEvent.live === true) {
        // If live is true, ended should be false unless game is explicitly closed
        enrichedGame.ended = rawEvent.closed === true ? true : false;
      } else {
        // If live is false, use the ended value from the API
        enrichedGame.ended = rawEvent.ended || false;
      }
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
  
  // logger.info({
  //   message: 'Live games fetched successfully',
  //   totalGames: eventArray.length,
  // });

  return eventArray;
}

function hasEndDateGracePassed(endDate: string | undefined): boolean {
  if (!endDate) return false;
  const t = new Date(endDate).getTime();
  if (Number.isNaN(t)) return false;
  const graceTime = 3 * 60 * 60 * 1000; // 3 hours
  return (t + graceTime) < Date.now();
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
      // logger.warn({
      //   message: 'Live games endpoint returned 404 - attempting to refresh build ID',
      //   endpoint,
      // });
      
      const buildIdUpdated = await fetchAndUpdateBuildId();
      
      if (buildIdUpdated) {
        const newEndpoint = getLiveEndpoint();
        // logger.info({
        //   message: 'Retrying live games fetch with updated build ID',
        //   newEndpoint,
        // });
        
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
  // If game is live, it cannot be ended (even if ended flag is set incorrectly)
  if (game.live === true) return false;
  
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

/**
 * Ensure consistency between live and ended flags
 * If game is live, ended should be false (unless explicitly closed)
 */
function ensureLiveEndedConsistency(game: LiveGame): void {
  // End-date override: if endDate + 3h grace has passed, force ended=true and live=false.
  if (hasEndDateGracePassed(game.endDate)) {
    game.live = false;
    game.ended = true;
    return;
  }

  // Otherwise maintain consistency: if live is true, ended should be false unless explicitly closed.
  if (game.live === true && game.ended === true && game.closed !== true) {
    game.ended = false;
  }
}

/**
 * Check if a LiveGame is ended/closed
 */
export function isLiveGameEnded(game: LiveGame): boolean {
  // End-date override first (handles stale live=true flags)
  if (hasEndDateGracePassed(game.endDate)) return true;
  
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
    const graceTime = 3 * 60 * 60 * 1000; // 3 hours
    if ((endDate.getTime() + graceTime) < Date.now()) {
      return true;
    }
  }

  return false;
}

/**
 * Filter out ended/closed LiveGames
 */
export function filterOutEndedLiveGames(games: LiveGame[]): LiveGame[] {
  return games.filter(game => !isLiveGameEnded(game));
}

// async function cleanupEndedGames(): Promise<number> {
//   const isProduction = process.env.NODE_ENV === 'production';
//   const GRACE_PERIOD_HOURS = 3; // 3 hour grace period after end_date
  
//   if (!isProduction) {
//     let removedCount = 0;
//     const now = new Date();
    
//     for (const [id, game] of inMemoryGames.entries()) {
//       // Check explicit ended/closed flags first
//       let isEnded = game.ended === true || game.closed === true;
      
//       // Check if end_date + grace period has passed
//       if (!isEnded && game.endDate) {
//         const endDate = new Date(game.endDate);
//         const graceTime = GRACE_PERIOD_HOURS * 60 * 60 * 1000;
//         isEnded = (endDate.getTime() + graceTime) < now.getTime();
//       }
      
//       if (isEnded) {
//         inMemoryGames.delete(id);
//         gamesCache.delete(id);
//         removedCount++;
//       }
//     }
    
//     return removedCount;
//   }
  
//   const client = await pool.connect();
  
//   try {
//     // Delete games that are:
//     // 1. Marked as ended
//     // 2. Marked as closed (market closed)
//     // 3. End date + 3 hours has passed (grace period for games that didn't update properly)
//     const result = await client.query(`
//       DELETE FROM live_games 
//       WHERE ended = true 
//          OR closed = true 
//          OR (end_date IS NOT NULL AND end_date + INTERVAL '3 hours' < NOW())
//     `);
    
//     const removedCount = result.rowCount || 0;
//     if (removedCount > 0) {
//       // logger.info({
//       //   message: 'Cleaned up ended games from database',
//       //   removedCount,
//       // });
//       gamesCache.clear();
//     }
    
//     return removedCount;
//   } catch (error) {
//     logger.error({
//       message: 'Error cleaning up ended games from database',
//       error: error instanceof Error ? error.message : String(error),
//     });
//     return 0;
//   } finally {
//     client.release();
//   }
// }

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

/** Excluded from storage so we don't duplicate games with placeholder -more-markets slugs */
export function isMoreMarketsSlug(slug: string | null | undefined): boolean {
  return !!(slug && slug.includes('-more-markets'));
}

export async function storeGames(games: LiveGame[], dataSource?: string): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';

  // Exclude -more-markets games (duplicate/placeholder entries)
  const toStore = games.filter((g) => !isMoreMarketsSlug(g.slug));

  // If dataSource is provided, set it on all games
  if (dataSource) {
    for (const game of toStore) {
      game.dataSource = dataSource;
    }
  }

  if (isProduction) {
    await storeGamesInDatabase(toStore);
    for (const game of toStore) {
      gamesCache.set(game.id, game);
    }
  } else {
    storeGamesInMemory(toStore);
  }

  // Record probability snapshots for all games (async, non-blocking)
  recordProbabilitySnapshots(toStore).catch(error => {
    logger.warn({
      message: 'Error recording probability snapshots (non-blocking)',
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Record probability snapshots for multiple games (bulk, single connection)
 */
async function recordProbabilitySnapshots(games: LiveGame[]): Promise<void> {
  const snapshots: ProbabilitySnapshot[] = [];
  for (const game of games) {
    const probs = extractGameProbabilities(game);
    if (probs) {
      snapshots.push({
        gameId: game.id,
        homeProbability: probs.homeProb,
        awayProbability: probs.awayProb,
        homeBuyPrice: probs.homeBuy,
        awayBuyPrice: probs.awayBuy,
        recordedAt: new Date(),
      });
    }
  }
  if (snapshots.length > 0) {
    await recordProbabilitySnapshotsBulk(snapshots);
  }
}

const INSERT_QUERY = `
  INSERT INTO live_games (
    id, ticker, slug, title, description, resolution_source,
    start_date, end_date, image, icon, active, closed, archived,
    restricted, liquidity, volume, volume_24hr, competitive,
    sport, league, series_id, game_id, score, period, elapsed, live, ended,
    period_scores, transformed_data, raw_data, created_at, updated_at
  ) VALUES %PLACEHOLDERS%
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
    ended = EXCLUDED.ended,
    period_scores = COALESCE(EXCLUDED.period_scores, live_games.period_scores),
    transformed_data = EXCLUDED.transformed_data,
    raw_data = EXCLUDED.raw_data, updated_at = CURRENT_TIMESTAMP
`;

async function storeGamesInDatabase(games: LiveGame[]): Promise<void> {
  if (games.length === 0) return;

  // Do ALL prep work before acquiring a connection (no connection held during calc)
  // Keep batch small to avoid "could not determine data type of parameter $1" (PostgreSQL limit)
  const BATCH_SIZE = 500; // 30 params × 100 = 3000 per batch
  const batches: { values: any[]; placeholders: string }[] = [];

  for (let i = 0; i < games.length; i += BATCH_SIZE) {
    const batch = games.slice(i, i + BATCH_SIZE);
    const values: any[] = [];
    const placeholderRows: string[] = [];
    let paramIndex = 1; // Reset per batch: each query expects $1, $2, ... $N

    for (const game of batch) {
      const ticker = game.ticker || game.slug || game.id || 'UNKNOWN';
      const rowPlaceholders: string[] = [];

      let periodScores = game.periodScores || null;
      if (!periodScores && game.score && game.period && game.period !== 'NS') {
        const currentScore = parseScoreString(game.score);
        if (currentScore) {
          periodScores = calculatePeriodScores(
            currentScore,
            game.period,
            null,
            undefined,
            null,
            false
          );
          game.periodScores = periodScores;
        }
      }

      for (let j = 0; j < 30; j++) {
        rowPlaceholders.push(`$${paramIndex++}`);
      }
      rowPlaceholders.push('CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP');
      placeholderRows.push(`(${rowPlaceholders.join(', ')})`);

      values.push(
        game.id, ticker, game.slug, game.title, game.description, game.resolutionSource,
        game.startDate, game.endDate, game.image, game.icon, game.active, game.closed,
        game.archived, game.restricted, game.liquidity, game.volume, game.volume24hr,
        game.competitive, game.sport, game.league, game.seriesId, game.gameId,
        game.score, game.period, game.elapsed, game.live, game.ended,
        periodScores ? JSON.stringify(periodScores) : null,
        JSON.stringify(game), JSON.stringify(game.rawData)
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

    for (const game of games) {
      addGameToCache(game);
    }

    // logger.info({ 
    //   message: 'Games stored in database', 
    //   count: games.length,
    //   batches: batches.length 
    // });

    // Also update precomputed frontend games so that /api/games/frontend
    // can serve data without doing heavy transformation per request.
    try {
      await upsertFrontendGamesForLiveGames(games);
    } catch (error) {
      logger.error({
        message: 'Error upserting frontend games after storing live games',
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
      gameCount: games.length,
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
  // logger.info({ message: 'Games stored in memory', count: games.length, totalInMemory: inMemoryGames.size });
}

/** Fast count without loading all rows (for early-exit returns) */
async function getLiveGamesCount(): Promise<number> {
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction) {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT COUNT(*)::int as count FROM live_games');
      return result.rows[0]?.count ?? 0;
    } finally {
      client.release();
    }
  }
  return inMemoryGames.size;
}

function sortGamesForGetAll(games: LiveGame[]): LiveGame[] {
  return [...games].sort((a, b) => {
    const aLive = a.live === true ? 0 : 1;
    const bLive = b.live === true ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;
    const aVol = (a as any).volume24hr ?? (a as any).volume ?? 0;
    const bVol = (b as any).volume24hr ?? (b as any).volume ?? 0;
    if (bVol !== aVol) return bVol - aVol;
    const aCreated = (a as any).createdAt ? new Date((a as any).createdAt).getTime() : 0;
    const bCreated = (b as any).createdAt ? new Date((b as any).createdAt).getTime() : 0;
    return bCreated - aCreated;
  });
}

/** Get cached games for broadcast (avoids DB fetch after storeGames) */
function getCachedGamesForBroadcast(): LiveGame[] {
  const isProduction = process.env.NODE_ENV === 'production';
  const games = isProduction
    ? Array.from(gamesCache.values())
    : Array.from(inMemoryGames.values());
  games.forEach(ensureLiveEndedConsistency);
  return games;
}

export async function getAllLiveGames(): Promise<LiveGame[]> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (isProduction) {
    // If a load is already in progress, wait for it instead of starting
    // another expensive full-table query. This avoids hammering Postgres
    // when many requests arrive at the same time, but we do NOT cache the
    // results between calls so we can still observe real DB behavior.
    if (loadingAllLiveGamesPromise) {
      return loadingAllLiveGamesPromise;
    }

    // Single-flight loader: only one full DB scan at a time
    loadingAllLiveGamesPromise = (async () => {
      try {
        const games = await getAllLiveGamesFromDatabase();

        // Only trigger upstream refresh if truly empty
        // if (games.length === 0) {
        //   logger.info({ message: 'Database is empty, fetching live games from API' });
        //   await refreshLiveGames();
        //   const refreshed = await getAllLiveGamesFromDatabase();
        //   return refreshed;
        // }

        return games;
      } finally {
        // Always clear the single-flight promise so future calls can reload
        loadingAllLiveGamesPromise = null;
      }
    })();

    return loadingAllLiveGamesPromise;
  } else {
    // Development mode
    let games = Array.from(inMemoryGames.values());
    
    if (games.length === 0) {
      //logger.info({ message: 'In-memory storage is empty, fetching live games from API' });
      await refreshLiveGames();
      games = Array.from(inMemoryGames.values());
    }
    
    // Only apply consistency to in-memory games
    games.forEach(ensureLiveEndedConsistency);
    return games;
  }
}

export async function getLiveGameById(id: string): Promise<LiveGame | null> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (isProduction) {
    // Check cache first
    if (gamesCache.has(id)) {
      const game = gamesCache.get(id);
      if (game) {
        ensureLiveEndedConsistency(game);
        addGameToCache(game);
        return game;
      }
      return null;
    }
    const game = await getLiveGameByIdFromDatabase(id);
    if (game) {
      addGameToCache(game);
    }
    return game;
  } else {
    const game = inMemoryGames.get(id);
    if (game) {
      ensureLiveEndedConsistency(game);
      // Update in-memory storage with fixed game object
      inMemoryGames.set(id, game);
      return game;
    }
    return null;
  }
}

export async function getLiveGameBySlug(slug: string): Promise<LiveGame | null> {
  if (!slug) return null;
  const target = slug.toLowerCase();

  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    // Check cache first (avoids DB when game is already cached)
    for (const game of gamesCache.values()) {
      const slugMatch = game.slug?.toLowerCase() === target;
      const tickerMatch = game.ticker?.toLowerCase() === target;
      const idMatch = game.id?.toLowerCase() === target;
      const rawSlugMatch = game.rawData?.slug && String(game.rawData.slug).toLowerCase() === target;
      if (slugMatch || tickerMatch || idMatch || rawSlugMatch) {
        ensureLiveEndedConsistency(game);
        return game;
      }
    }
    const game = await getLiveGameBySlugFromDatabase(target);
    if (game) {
      gamesCache.set(game.id, game);
      return game;
    }
    return null;
  }

  const games = Array.from(inMemoryGames.values());
  const game = games.find((g) => {
    const slugMatch = g.slug?.toLowerCase() === target;
    const tickerMatch = g.ticker?.toLowerCase() === target;
    const idMatch = g.id?.toLowerCase() === target;
    const rawSlugMatch = g.rawData?.slug && String(g.rawData.slug).toLowerCase() === target;
    return slugMatch || tickerMatch || idMatch || rawSlugMatch;
  }) || null;
  if (game) ensureLiveEndedConsistency(game);
  return game;
}

async function getLiveGameBySlugFromDatabase(slug: string): Promise<LiveGame | null> {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT 
        COALESCE(
          transformed_data,
          jsonb_set(
            jsonb_set(
              raw_data,
              '{createdAt}',
              to_jsonb(CURRENT_TIMESTAMP)
            ),
            '{updatedAt}',
            to_jsonb(CURRENT_TIMESTAMP)
          )
        ) as game_data,
        period_scores,
        balldontlie_game_id,
        CASE 
          WHEN end_date IS NOT NULL 
            AND end_date + INTERVAL '3 hours' < NOW() 
          THEN true 
          ELSE false 
        END as grace_passed
       FROM live_games 
       WHERE LOWER(slug) = $1 OR LOWER(ticker) = $1 OR LOWER(id) = $1
       LIMIT 1`,
      [slug]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const game = row.game_data as LiveGame;

    if (row.period_scores) {
      game.periodScores = row.period_scores;
    }
    if (row.balldontlie_game_id) {
      (game as any).balldontlie_game_id = row.balldontlie_game_id;
    }

    if (row.grace_passed) {
      game.live = false;
      game.ended = true;
    } else if (game.live === true && game.ended === true && game.closed !== true) {
      game.ended = false;
    }

    return game;
  } catch (error) {
    logger.error({
      message: 'Error fetching game by slug from database',
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    client.release();
  }
}

async function getLiveGameByIdFromDatabase(id: string): Promise<LiveGame | null> {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT 
        COALESCE(
          transformed_data,
          jsonb_set(
            jsonb_set(
              raw_data,
              '{createdAt}',
              to_jsonb(CURRENT_TIMESTAMP)
            ),
            '{updatedAt}',
            to_jsonb(CURRENT_TIMESTAMP)
          )
        ) as game_data,
        period_scores,
        balldontlie_game_id,
        CASE 
          WHEN end_date IS NOT NULL 
            AND end_date + INTERVAL '3 hours' < NOW() 
          THEN true 
          ELSE false 
        END as grace_passed
       FROM live_games 
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const game = row.game_data as LiveGame;

    if (row.period_scores) {
      game.periodScores = row.period_scores;
    }
    if (row.balldontlie_game_id) {
      (game as any).balldontlie_game_id = row.balldontlie_game_id;
    }

    if (row.grace_passed) {
      game.live = false;
      game.ended = true;
    } else if (game.live === true && game.ended === true && game.closed !== true) {
      game.ended = false;
    }

    return game;
  } finally {
    client.release();
  }
}

async function getAllLiveGamesFromDatabase(): Promise<LiveGame[]> {
  const client = await pool.connect();
  
  try {
    // Let PostgreSQL do ALL the transformation work
    const result = await client.query(`
      SELECT 
        COALESCE(
          transformed_data,
          jsonb_set(
            jsonb_set(
              raw_data,
              '{createdAt}',
              to_jsonb(CURRENT_TIMESTAMP)
            ),
            '{updatedAt}',
            to_jsonb(CURRENT_TIMESTAMP)
          )
        ) as game_data,
        period_scores,
        balldontlie_game_id,
        -- Pre-calculate the grace period check in SQL
        CASE 
          WHEN end_date IS NOT NULL 
            AND end_date + INTERVAL '3 hours' < NOW() 
          THEN true 
          ELSE false 
        END as grace_passed
      FROM live_games
      ORDER BY 
        CASE WHEN live = true THEN 0 ELSE 1 END,
        volume_24hr DESC NULLS LAST, 
        created_at DESC
    `);
    
    // Fast path: minimal processing in Node.js
    return result.rows.map((row) => {
      const game = row.game_data as LiveGame;
      
      // Only parse what's needed
      if (row.period_scores) {
        game.periodScores = row.period_scores;
      }
      if (row.balldontlie_game_id) {
        (game as any).balldontlie_game_id = row.balldontlie_game_id;
      }
      
      // Fast consistency check using pre-calculated flag
      if (row.grace_passed) {
        game.live = false;
        game.ended = true;
      } else if (game.live === true && game.ended === true && game.closed !== true) {
        game.ended = false;
      }
      
      return game;
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('does not exist') || 
        (errorMessage.includes('relation') && errorMessage.includes('live_games'))) {
      logger.warn({
        message: 'live_games table does not exist, will trigger auto-population',
        error: errorMessage,
      });
      return [];
    }
    throw error;
  } finally {
    client.release();
  }
}

// export async function updateGame(gameUpdate: Partial<LiveGame> & { id: string }): Promise<void> {
//   const isProduction = process.env.NODE_ENV === 'production';
  
//   if (isProduction) {
//     await updateGameInDatabase(gameUpdate);
//   } else {
//     updateGameInMemory(gameUpdate);
//   }
// }

/**
 * Update game in cache only (for real-time price updates that already wrote to DB)
 */
export function updateGameInCache(gameId: string, updatedGame: LiveGame): void {
  addGameToCache(updatedGame);
}

/** Sports updates queue for batched DB flush (1s interval, one connection) */
const sportsGameUpdateQueue = new Map<number, Partial<LiveGame>>();
let sportsGameUpdateFlushTimer: NodeJS.Timeout | null = null;
const SPORTS_UPDATE_FLUSH_MS = 1000;

/** Merge sports updates into game, compute period scores, ensure consistency */
function applySportsUpdateToGame(game: LiveGame, updates: Partial<LiveGame>): LiveGame {
  const periodChanged = updates.period !== undefined && updates.period !== game.period;
  const scoreChanged = updates.score !== undefined && updates.score !== game.score;
  let newPeriodScores = game.periodScores;
  const hasScoreAndPeriod = updates.score && updates.period && updates.period !== 'NS';
  const shouldCalculate =
    (periodChanged || scoreChanged || !game.periodScores) && hasScoreAndPeriod;

  if (shouldCalculate && updates.score && updates.period) {
    const currentScore = parseScoreString(updates.score);
    const previousScoreParsed = game.score ? parseScoreString(game.score) : null;
    if (currentScore) {
      newPeriodScores = calculatePeriodScores(
        currentScore,
        updates.period,
        game.periodScores || null,
        game.period,
        previousScoreParsed,
        periodChanged
      );
    }
  }

  const merged = { ...game, ...updates, updatedAt: new Date() } as LiveGame;
  if (newPeriodScores) merged.periodScores = newPeriodScores;

  const isLive = updates.live !== undefined ? updates.live : game.live;
  if (isLive === true && merged.ended === true && merged.closed !== true) {
    merged.ended = false;
  }
  return merged;
}

/**
 * Apply sports game update: update cache, broadcast immediately, queue for batched DB flush.
 * Frontend gets real-time updates via WebSocket; DB is written in bulk every 1s.
 */
export function applySportsGameUpdate(gameId: number, updates: Partial<LiveGame>): void {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    updateGameByGameIdInMemory(gameId, updates);
    return;
  }

  // Merge into queue (overwrite = keep latest)
  const existing = sportsGameUpdateQueue.get(gameId);
  sportsGameUpdateQueue.set(gameId, { ...existing, ...updates });

  // Update cache and broadcast immediately (no DB yet)
  let eventId = gameIdToEventId.get(gameId);
  let game = eventId ? gamesCache.get(eventId) : null;
  if (!game) {
    for (const g of gamesCache.values()) {
      if (g.gameId === gameId) {
        game = g;
        eventId = g.id;
        break;
      }
    }
  }

  if (game) {
    const merged = applySportsUpdateToGame(game, updates);
    addGameToCache(merged);
    if (liveGamesService) {
      liveGamesService.broadcastPartialUpdate(merged);
    }
  }

  // Schedule batched flush
  if (!sportsGameUpdateFlushTimer) {
    sportsGameUpdateFlushTimer = setTimeout(() => {
      sportsGameUpdateFlushTimer = null;
      flushSportsGameUpdates().catch((err) =>
        logger.warn({
          message: 'Error flushing sports game updates',
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }, SPORTS_UPDATE_FLUSH_MS);
  }
}

export async function updateGameByGameId(gameId: number, updates: Partial<LiveGame>): Promise<void> {
  applySportsGameUpdate(gameId, updates);
}

/** Flush queued sports updates to DB. Prep everything before connect, hold connection only for writes. */
async function flushSportsGameUpdates(): Promise<void> {
  const pending = new Map(sportsGameUpdateQueue);
  sportsGameUpdateQueue.clear();
  if (pending.size === 0) return;

  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv !== 'production') return;

  // 1. Build updates from CACHE (no connection) - cache has merged state from applySportsGameUpdate
  const toWrite: { eventId: string; game: LiveGame }[] = [];

  for (const [gameId] of pending) {
    let eventId = gameIdToEventId.get(gameId);
    let game = eventId ? gamesCache.get(eventId) : null;
    if (!game) {
      for (const g of gamesCache.values()) {
        if (g.gameId === gameId) {
          game = g;
          eventId = g.id;
          break;
        }
      }
    }
    if (!game || !eventId) continue;
    toWrite.push({ eventId, game });
  }

  if (toWrite.length === 0) return;

  // Sort by eventId so all writers acquire row locks in same order (prevents deadlock)
  toWrite.sort((a, b) => a.eventId.localeCompare(b.eventId));

  // 2. Build single bulk UPDATE (VALUES + UPDATE ... FROM)
  const valueRows: string[] = [];
  const allValues: unknown[] = [];
  let paramIndex = 1;

  for (const { eventId, game } of toWrite) {
    const score = game.score ?? null;
    const period = game.period ?? null;
    const elapsed = game.elapsed ?? null;
    const live = game.live ?? null;
    const ended = game.ended ?? null;
    const active = game.active ?? null;
    const closed = game.closed ?? null;
    const periodScores = game.periodScores != null ? JSON.stringify(game.periodScores) : null;
    const transformedData = JSON.stringify(game);
    const updatedAt = new Date().toISOString();

    const placeholders = [
      `$${paramIndex++}`,
      `$${paramIndex++}`,
      `$${paramIndex++}`,
      `$${paramIndex++}`,
      `$${paramIndex++}::boolean`,
      `$${paramIndex++}::boolean`,
      `$${paramIndex++}::boolean`,
      `$${paramIndex++}::boolean`,
      `$${paramIndex++}::jsonb`,
      `$${paramIndex++}::jsonb`,
      `$${paramIndex++}::timestamptz`,
    ].join(', ');
    valueRows.push(`(${placeholders})`);
    allValues.push(eventId, score, period, elapsed, live, ended, active, closed, periodScores, transformedData, updatedAt);
  }

  const bulkUpdateQuery = `
    UPDATE live_games lg SET
      score = COALESCE(v.score, lg.score),
      period = COALESCE(v.period, lg.period),
      elapsed = COALESCE(v.elapsed, lg.elapsed),
      live = COALESCE(v.live, lg.live),
      ended = COALESCE(v.ended, lg.ended),
      active = COALESCE(v.active, lg.active),
      closed = COALESCE(v.closed, lg.closed),
      period_scores = COALESCE(v.period_scores, lg.period_scores),
      transformed_data = COALESCE(v.transformed_data, lg.transformed_data),
      updated_at = v.updated_at
    FROM (VALUES ${valueRows.join(', ')}) AS v(id, score, period, elapsed, live, ended, active, closed, period_scores, transformed_data, updated_at)
    WHERE lg.id = v.id
  `;

  // 3. Transform to frontend games BEFORE connect (uses pool internally for prob history)
  const frontendGames = await Promise.all(
    toWrite.map(({ game }) => transformToFrontendGame(game))
  );

  // 4. Acquire write lock (serializes with CLOB flush - prevents deadlock)
  await acquireLiveGamesWriteLock();
  const client = await pool.connect();

  try {
    await client.query(bulkUpdateQuery, allValues);
    await bulkUpsertFrontendGamesWithClient(client, frontendGames);
    clearFrontendGamesCache();
  } catch (error) {
    const isDeadlock = error instanceof Error && /deadlock detected/i.test(error.message);
    logger.error({
      message: 'Error flushing sports game updates',
      error: error instanceof Error ? error.message : String(error),
      isDeadlock,
    });
    for (const [gameId, data] of pending) {
      if (!sportsGameUpdateQueue.has(gameId)) {
        sportsGameUpdateQueue.set(gameId, data);
      }
    }
    if (isDeadlock && pending.size > 0 && !sportsGameUpdateFlushTimer) {
      sportsGameUpdateFlushTimer = setTimeout(() => {
        sportsGameUpdateFlushTimer = null;
        flushSportsGameUpdates().catch((err) =>
          logger.warn({
            message: 'Error retrying sports game flush',
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }, 500);
    }
  } finally {
    client.release();
    releaseLiveGamesWriteLock();
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
  
  // Handle "End Q1", "End Q2", etc. - normalize to "q1", "q2", etc.
  if (periodLower.startsWith('end ')) {
    const periodWithoutEnd = periodLower.replace(/^end\s+/, '').trim();
    // Recursively call with the period without "end" prefix
    return normalizePeriodKey(periodWithoutEnd);
  }
  
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
  
  // Handle halftime (transition period)
  if (periodLower === 'ht' || periodLower === 'halftime' || periodLower === 'half') return 'ht';
  
  // Handle overtime
  if (periodLower === 'ot' || periodLower === 'overtime') return 'ot';
  
  // Handle final/finished
  if (periodLower === 'final' || periodLower === 'vft' || periodLower === 'finished') return 'final';
  
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
 * Calculate period scores - snapshots cumulative scores when periods change
 * When period changes (e.g., Q1 → Q2), snapshots the PREVIOUS period's cumulative score
 * When period doesn't change but score changes, updates the current period's cumulative score
 * IMPORTANT: Period scores are only final when the period ends (e.g., "End Q2")
 * While a period is ongoing (e.g., "Q2"), the score should be updated with live score changes
 */
function calculatePeriodScores(
  currentScore: { home: number; away: number },
  currentPeriod: string,
  previousPeriodScores: Record<string, { home: number; away: number }> | null,
  previousPeriod: string | undefined,
  previousScore: { home: number; away: number } | null,
  periodChanged: boolean
): Record<string, { home: number; away: number }> {
  const currentPeriodKey = normalizePeriodKey(currentPeriod);
  if (!currentPeriodKey) return previousPeriodScores || {};
  
  // Always preserve all existing period scores - never remove them
  const result = { ...(previousPeriodScores || {}) };
  
  // Check if current period is an "end of period" state
  // This includes: "End Q2", "HT" (halftime), "Final", "VFT" (verified final)
  const currentPeriodLower = currentPeriod.toLowerCase().trim();
  const isPeriodEnded = 
    currentPeriodLower.startsWith('end ') ||
    currentPeriodLower === 'ht' ||
    currentPeriodLower === 'halftime' ||
    currentPeriodLower === 'half' ||
    currentPeriodLower === 'final' ||
    currentPeriodLower === 'vft' ||
    currentPeriodLower === 'finished';
  
  // If period changed, snapshot the PREVIOUS period's cumulative score
  // This ensures we capture the score at the end of the previous period before transitioning
  if (periodChanged && previousPeriod && previousScore) {
    const previousPeriodKey = normalizePeriodKey(previousPeriod);
    if (previousPeriodKey && previousPeriodKey !== currentPeriodKey) {
      // Snapshot the previous period's score if it hasn't been stored yet
      // Once stored, never overwrite (period ended, score is final)
      // This is critical for transitions like Q2 → HT, where Q2 needs to be snapshotted
      if (!result[previousPeriodKey]) {
        result[previousPeriodKey] = {
          home: previousScore.home,
          away: previousScore.away,
        };
      }
    }
  }
  
  // Update or set the current period's cumulative score
  // If period has ended (e.g., "End Q2", "HT"), only set if it doesn't exist yet (score is final)
  // If period is ongoing (e.g., "Q2"), always update (live score changes)
  if (!isPeriodEnded) {
    // Period is ongoing, update the score (even if it already exists)
    // This allows live score updates during an active period
    result[currentPeriodKey] = {
      home: currentScore.home,
      away: currentScore.away,
    };
  } else {
    // Period has ended (e.g., "End Q2", "HT"), only set if it doesn't exist yet
    // Once set, never overwrite (period ended, score is final)
    // Note: HT (halftime) is a transition period, but we still store its score
    if (!result[currentPeriodKey]) {
      result[currentPeriodKey] = {
        home: currentScore.home,
        away: currentScore.away,
      };
    }
  }
  
  return result;
}

function updateGameByGameIdInMemory(gameId: number, updates: Partial<LiveGame>): void {
  for (const [eventId, game] of inMemoryGames.entries()) {
    if (game.gameId === gameId) {
      // Check if period changed
      const periodChanged = updates.period !== undefined && updates.period !== game.period;
      const scoreChanged = updates.score !== undefined && updates.score !== game.score;
      
      // Calculate period scores if:
      // 1. Period or score changed, OR
      // 2. We have score/period but no previous period scores (initializing)
      let newPeriodScores = game.periodScores;
      const hasScoreAndPeriod = updates.score && updates.period && updates.period !== 'NS';
      const shouldCalculatePeriodScores = (periodChanged || scoreChanged || !game.periodScores) && hasScoreAndPeriod;
      
      if (shouldCalculatePeriodScores && updates.score && updates.period) {
        const currentScore = parseScoreString(updates.score);
        const previousScoreParsed = game.score ? parseScoreString(game.score) : null;
        
        if (currentScore) {
          newPeriodScores = calculatePeriodScores(
            currentScore,
            updates.period,
            game.periodScores || null,
            game.period,
            previousScoreParsed,
            periodChanged
          );
          updates.periodScores = newPeriodScores;
        }
      }
      
      // Ensure consistency: if game is live, it cannot be ended
      // Use the live value from updates if provided, otherwise use current value
      const isLive = updates.live !== undefined ? updates.live : game.live;
      if (isLive === true && updates.ended === true) {
        // If live is true, ended should be false unless game is explicitly closed
        if (updates.closed !== true && game.closed !== true) {
          updates.ended = false;
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

// async function updateGameInDatabase(gameUpdate: Partial<LiveGame> & { id: string }): Promise<void> {
//   const client = await pool.connect();

//   try {
//     // Get current game data if markets need updating
//     let current: any = null;
//     if (gameUpdate.markets !== undefined) {
//       const findResult = await client.query(
//         'SELECT transformed_data FROM live_games WHERE id = $1',
//         [gameUpdate.id]
//       );
      
//       if (findResult.rows.length === 0) {
//         logger.warn({ message: 'Game not found for update', gameId: gameUpdate.id });
//         return;
//       }
      
//       current = findResult.rows[0].transformed_data 
//         ? (typeof findResult.rows[0].transformed_data === 'string' 
//             ? JSON.parse(findResult.rows[0].transformed_data) 
//             : findResult.rows[0].transformed_data)
//         : {};
//     }
    
//     const updates: string[] = [];
//     const values: any[] = [];
//     let paramIndex = 1;
    
//     if (gameUpdate.score !== undefined) { updates.push(`score = $${paramIndex++}`); values.push(gameUpdate.score); }
//     if (gameUpdate.period !== undefined) { updates.push(`period = $${paramIndex++}`); values.push(gameUpdate.period); }
//     if (gameUpdate.elapsed !== undefined) { updates.push(`elapsed = $${paramIndex++}`); values.push(gameUpdate.elapsed); }
//     if (gameUpdate.live !== undefined) { updates.push(`live = $${paramIndex++}`); values.push(gameUpdate.live); }
//     if (gameUpdate.ended !== undefined) { updates.push(`ended = $${paramIndex++}`); values.push(gameUpdate.ended); }
    
//     // Update transformed_data if markets changed
//     if (gameUpdate.markets !== undefined && current) {
//       const updated = { ...current, ...gameUpdate, updatedAt: new Date() };
//       updates.push(`transformed_data = $${paramIndex++}`);
//       values.push(JSON.stringify(updated));
//     }
    
//     updates.push(`updated_at = CURRENT_TIMESTAMP`);
//     values.push(gameUpdate.id);
    
//     await client.query(`UPDATE live_games SET ${updates.join(', ')} WHERE id = $${paramIndex}`, values);
    
//     // Update cache and broadcast - ALWAYS broadcast even if not in cache
//     const cached = gamesCache.get(gameUpdate.id);
//     const updatedGame = cached 
//       ? { ...cached, ...gameUpdate, updatedAt: new Date() }
//       : gameUpdate as LiveGame;
    
//     if (cached) {
//       addGameToCache(updatedGame);
//     }
    
//     // Always broadcast updates
//     if (liveGamesService) {
//       liveGamesService.broadcastPartialUpdate(updatedGame);
//     }

//     // Update frontend_games so /api/games/frontend returns current status
//     upsertFrontendGameForLiveGame(updatedGame).catch((err) => {
//       logger.warn({
//         message: 'Failed to upsert frontend game after updateGame',
//         gameId: gameUpdate.id,
//         error: err instanceof Error ? err.message : String(err),
//       });
//     });
//   } finally {
//     client.release();
//   }
// }

// function updateGameInMemory(gameUpdate: Partial<LiveGame> & { id: string }): void {
//   const existing = inMemoryGames.get(gameUpdate.id);
//   if (existing) {
//     const updatedGame = { ...existing, ...gameUpdate, updatedAt: new Date() };
//     inMemoryGames.set(gameUpdate.id, updatedGame);
    
//     if (liveGamesService) {
//       liveGamesService.broadcastPartialUpdate(updatedGame);
//     }
//   }
// }

export async function refreshLiveGames(): Promise<number> {
  notifyGamesRefreshStarting();
  try {
    //logger.info({ message: 'Refreshing live games' });

    const allGames = await fetchLiveGames();
    
    if (allGames.length === 0) {
      logger.warn({ message: 'No games fetched from API - endpoint may be unavailable' });
      return await getLiveGamesCount();
    }

    const filteredGames = filterGamesBySports(allGames);
    
    // Log filtering stats for debugging
    // const nflGames = allGames.filter(g => {
    //   const slug = g.slug?.toLowerCase() || '';
    //   const title = g.title?.toLowerCase() || '';
    //   return slug.includes('nfl') || slug.includes('football') || title.includes('nfl') || title.includes('football');
    // });
    
    // if (nflGames.length > 0) {
    //   logger.info({
    //     message: 'NFL games found in API response',
    //     totalNfl: nflGames.length,
    //     nflSlugs: nflGames.map(g => g.slug).slice(0, 5),
    //   });
    // }

    if (filteredGames.length === 0) {
      return await getLiveGamesCount();
    }
    
    // No longer filter out ended games - store all games from Polymarket
    // Ended/closed games can be filtered at the API layer instead
    const liveGames = await transformAndEnrichGames(filteredGames);
    await storeGames(liveGames);
    
    // No longer cleanup ended games from database
    // They remain available for fetching by ID/slug
    
    const allStoredGames = getCachedGamesForBroadcast();
    if (liveGamesService) {
      liveGamesService.broadcastUpdate(allStoredGames);
    }
    notifyGamesRefreshed();

    // logger.info({
    //   message: 'Live games refreshed',
    //   totalFetched: allGames.length,
    //   afterSportFilter: filteredGames.length,
    //   stored: liveGames.length,
    // });
    
    return liveGames.length;
  } catch (error) {
    logger.error({
      message: 'Error refreshing live games',
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      return await getLiveGamesCount();
    } catch {
      return 0;
    }
  } finally {
    notifyGamesRefreshEnded();
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
    
    // Delay initial refresh to prevent connection pool exhaustion during startup
    // Wait 2 seconds to allow other services to initialize first
    setTimeout(() => {
      refreshLiveGames().catch((error) => {
        logger.error({
          message: 'Error in initial live games fetch',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 2000);

    this.pollingInterval = setInterval(() => {
      refreshLiveGames().catch((error) => {
        logger.error({
          message: 'Error in live games polling',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, POLLING_INTERVAL);

    //logger.info({ message: 'Live games polling started', intervalMinutes: POLLING_INTERVAL / 60000 });
  }

  stop(): void {
    if (!this.isRunning) return;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    this.isRunning = false;
    //logger.info({ message: 'Live games polling stopped' });
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
    // logger.info({
    //   message: 'Broadcasting partial update to callbacks',
    //   gameId: game.id,
    //   slug: game.slug,
    //   callbackCount: this.ssePartialBroadcastCallbacks.size,
    // });

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
