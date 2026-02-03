/**
 * Sports Games Service
 * Fetches upcoming sports games from Polymarket Gamma API /events endpoint
 * and merges them into the live_games table with proper data source tracking
 */

import axios, { AxiosResponse } from 'axios';
import { logger } from '../../config/logger';
import { getAllSportsGamesConfig, getSeriesIdForSport } from './sports-games.config';
import { 
  LiveGameEvent, 
  LiveGame,
  transformAndEnrichGames,
  filterGamesBySports,
  storeGames,
  isMoreMarketsSlug,
  notifyGamesRefreshed,
  notifyGamesRefreshStarting,
  notifyGamesRefreshEnded,
} from './live-games.service';

const API_BASE_URL = 'https://gamma-api.polymarket.com';
const TIMEOUT_MS = 30000; // 30 seconds per request
const POLLING_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours - upcoming games don't change often

/**
 * Sports Games API Response - can be array or wrapped object
 */
type SportsGamesApiResponse = LiveGameEvent[] | { data: LiveGameEvent[] } | { events: LiveGameEvent[] };

/**
 * Fetch sports games with timeout
 */
async function fetchWithTimeout(url: string, timeout: number = TIMEOUT_MS): Promise<any> {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      timeout,
      validateStatus: (status) => status < 500,
    });
    
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        throw new Error('Request timeout');
      }
      if (error.response?.status) {
        throw new Error(`API error: ${error.response.status} ${error.response.statusText}`);
      }
    }
    throw error;
  }
}

/**
 * Check if an event is an upcoming or recent game (not resolved, not archived, endDate within last 7 days or in future)
 * Note: We store games that ended within the last 7 days to ensure recent games are visible.
 * We don't filter by closed=true because Polymarket marks games as closed even for upcoming games
 * when markets are closed for trading. We rely on endDate + grace period instead.
 */
function isUpcomingGame(event: any): boolean {
  const now = Date.now();
  const gracePeriod = 3 * 60 * 60 * 1000; // 3 hours grace period
  const recentWindow = 7 * 24 * 60 * 60 * 1000; // 7 days - store recent past games
  
  // Resolved (game finished)
  if (event.isResolved === true) return false;
  
  // Archived
  if (event.archived === true) return false;
  
  // Not active (completely inactive games)
  if (event.active === false) return false;
  
  // Check endDate - primary indicator of whether game is upcoming or recent
  // Store games that ended within the last 7 days OR are in the future
  if (event.endDate) {
    const endDate = new Date(event.endDate).getTime();
    if (!isNaN(endDate)) {
      const endDateWithGrace = endDate + gracePeriod;
      // If endDate + grace period was more than 7 days ago, exclude it
      // BUT: If endDate is in the future (upcoming game), always include it
      if (endDate > now) {
        // Future game - always include
        return true;
      }
      if (endDateWithGrace + recentWindow < now) {
        return false; // Game ended more than 7 days ago
      }
      // Otherwise, include it (recent past game)
    }
  } else if (event.startDate) {
    // No endDate - check startDate
    const startDate = new Date(event.startDate).getTime();
    if (!isNaN(startDate)) {
      // If startDate is in the future, always include
      if (startDate > now) {
        return true;
      }
      // If startDate was more than 7 days ago and no endDate, likely old/ended
      if (startDate + recentWindow < now) {
        return false;
      }
    }
  }
  
  // All markets closed AND resolved - game definitely finished (but might be recent)
  // This check is less strict - we still include if within recent window
  if (event.markets && event.markets.length > 0) {
    const allMarketsClosed = event.markets.every((m: any) => m.closed === true);
    const allMarketsResolved = event.markets.every((m: any) => m.umaResolutionStatus === 'resolved');
    
    // If all markets are closed AND resolved, check if it's recent
    if (allMarketsClosed && allMarketsResolved) {
      // Still include if endDate is within recent window
      if (event.endDate) {
        const endDate = new Date(event.endDate).getTime();
        if (!isNaN(endDate) && endDate + recentWindow < now) {
          return false; // Too old
        }
      } else {
        return false; // No endDate and all resolved - exclude
      }
    }
  }
  
  // Note: We don't filter by event.closed=true because Polymarket marks games as closed
  // even for upcoming games when markets are closed for trading (e.g., before game starts)
  
  return true;
}

/**
 * Transform sports games API response to LiveGameEvent format
 * Handles different response structures (array, {data: Array}, {events: Array})
 */
function transformSportsGameToLiveGameEvent(event: any): LiveGameEvent {
  // The Gamma API /events endpoint returns events that are similar to LiveGameEvent
  // but may have slightly different field names or structures
  return {
    id: event.id,
    ticker: event.ticker || event.slug || event.id,
    slug: event.slug,
    title: event.title,
    description: event.description,
    resolutionSource: event.resolutionSource || event.resolution_source,
    startDate: event.startDate || event.start_date,
    creationDate: event.creationDate || event.createdAt || event.created_at,
    endDate: event.endDate || event.end_date,
    image: event.image,
    icon: event.icon,
    active: event.active ?? true,
    closed: event.closed ?? false,
    archived: event.archived ?? false,
    new: event.new,
    featured: event.featured,
    restricted: event.restricted,
    liquidity: event.liquidity,
    volume: event.volume,
    openInterest: event.openInterest || event.open_interest,
    createdAt: event.createdAt || event.created_at || event.creationDate,
    updatedAt: event.updatedAt || event.updated_at,
    competitive: event.competitive,
    volume24hr: event.volume24hr || event.volume_24hr,
    volume1wk: event.volume1wk || event.volume_1wk,
    volume1mo: event.volume1mo || event.volume_1mo,
    volume1yr: event.volume1yr || event.volume_1yr,
    enableOrderBook: event.enableOrderBook || event.enable_order_book,
    liquidityClob: event.liquidityClob || event.liquidity_clob,
    negRisk: event.negRisk || event.neg_risk,
    negRiskMarketID: event.negRiskMarketID || event.neg_risk_market_id,
    commentCount: event.commentCount || event.comment_count,
    markets: event.markets || [],
    gameId: event.gameId || event.game_id,
    score: event.score,
    period: event.period,
    elapsed: event.elapsed,
    live: event.live ?? false, // Upcoming games are not live yet
    ended: event.ended ?? false, // Upcoming games are not ended
  };
}

/**
 * Process sports games API response and extract events
 * Filters for upcoming games (not closed, not ended, startDate in future or within grace period)
 */
function processSportsGamesResponse(response: SportsGamesApiResponse): LiveGameEvent[] {
  let events: any[] = [];
  
  // Handle different response formats
  if (Array.isArray(response)) {
    events = response;
  } else if (response && typeof response === 'object') {
    if ('data' in response && Array.isArray(response.data)) {
      events = response.data;
    } else if ('events' in response && Array.isArray(response.events)) {
      events = response.events;
    }
  }
  
  // Transform all events (no filtering here - we'll filter by sport and upcoming status later)
  const transformedEvents = events.map(transformSportsGameToLiveGameEvent);
  
  // logger.debug({
  //   message: 'Processed sports games API response',
  //   totalFetched: events.length,
  //   transformedCount: transformedEvents.length,
  // });
  
  return transformedEvents;
}

/**
 * Extract raw events array from Gamma response
 */
function extractSportsEventsArray(response: SportsGamesApiResponse): any[] {
  if (Array.isArray(response)) return response;
  if (response && typeof response === 'object') {
    if ('data' in response && Array.isArray((response as any).data)) return (response as any).data;
    if ('events' in response && Array.isArray((response as any).events)) return (response as any).events;
  }
  return [];
}

/**
 * Fetch games for a specific sport by series ID.
 *
 * IMPORTANT for CBB: There can be >200 games in a short time window, so we must paginate
 * (offset) or we will miss games like `cbb-toledo-umass-2026-01-20`.
 *
 * We do NOT force `closed=false` here because Polymarket can mark upcoming games as closed
 * even before tipoff (markets closed for trading). We rely on endDate windowing instead.
 *
 * For tennis: Some games have series_id=null, so we also fetch games matching slug patterns
 * (atp-*, wta-*) that don't have a series_id, ensuring we capture all tennis games.
 */
async function fetchSportsGamesForSport(sport: string, seriesId: string): Promise<LiveGameEvent[]> {
  try {
    const limit = 200;
    const maxPages = sport === 'cbb' ? 25 : sport === 'ufc' ? 20 : 5; // CBB and UFC need more pages
    const now = Date.now();
    const gracePeriod = 3 * 60 * 60 * 1000; // 3 hours
    const recentWindow = 7 * 24 * 60 * 60 * 1000; // 7 days
    const oldestAllowed = now - recentWindow - gracePeriod;

    const collected: LiveGameEvent[] = [];
    const collectedSlugs = new Set<string>();

    // Fetch games with the series_id (skip if seriesId is empty, e.g., tennis without series_id)
    // UFC uses series_id=38 (Polymarket series slug "ufc"); 10500 returns NFLX
    if (seriesId && seriesId !== '') {
      for (let page = 0; page < maxPages; page++) {
        const offset = page * limit;
        const url =
          `${API_BASE_URL}/events?` +
          `series_id=${seriesId}&` +
          `limit=${limit}&` +
          `offset=${offset}&` +
          `order=endDate&` +
          `ascending=false&` +
          `include_chat=false&` +
          `active=true`;

        const response = await fetchWithTimeout(url);
        const rawEvents = extractSportsEventsArray(response);

        // Filter raw events to keep payload small and focused on relevant time window
        const filteredRaw = rawEvents.filter((e) => {
          if (!isUpcomingGame(e)) return false;
          const end = e?.endDate || e?.end_date;
          if (!end) return true; // keep if missing endDate
          const t = new Date(end).getTime();
          if (Number.isNaN(t)) return true;
          return t >= oldestAllowed;
        });

        const pageEvents = filteredRaw.map(transformSportsGameToLiveGameEvent);
        collected.push(...pageEvents);
        pageEvents.forEach(e => {
          if (e.slug) collectedSlugs.add(e.slug);
        });

        // Determine if we can stop paginating (we're past the recent window)
        const pageEndDates = rawEvents
          .map((e) => e?.endDate || e?.end_date)
          .filter(Boolean)
          .map((d) => new Date(d).getTime())
          .filter((t) => !Number.isNaN(t));

        const oldestInPage = pageEndDates.length ? Math.min(...pageEndDates) : Infinity;

        // logger.info({
        //   message: 'Sports games fetched page',
        //   sport,
        //   seriesId,
        //   page,
        //   offset,
        //   fetched: rawEvents.length,
        //   kept: pageEvents.length,
        //   oldestEndDateMs: oldestInPage === Infinity ? null : oldestInPage,
        // });

        // Stop conditions:
        // - fewer than limit returned (no more pages)
        // - oldest endDate in this page is older than our retention window
        if (rawEvents.length < limit) break;
        if (oldestInPage !== Infinity && oldestInPage < oldestAllowed) break;
      }
    }

    // For tennis, also fetch WTA games (series_id=10366) since we use ATP series_id (10365) as primary
    // Polymarket has separate series for ATP and WTA, but we normalize both to "tennis" sport
    if (sport === 'tennis') {
      try {
        // Fetch WTA games using WTA series ID (10366) with pagination
        const wtaSeriesId = '10366';
        const wtaMaxPages = 5; // Same as other sports
        
        for (let page = 0; page < wtaMaxPages; page++) {
          const offset = page * limit;
          const wtaUrl =
            `${API_BASE_URL}/events?` +
            `series_id=${wtaSeriesId}&` +
            `limit=${limit}&` +
            `offset=${offset}&` +
            `order=endDate&` +
            `ascending=false&` +
            `include_chat=false&` +
            `active=true`;

          const wtaResponse = await fetchWithTimeout(wtaUrl);
          const wtaRawEvents = extractSportsEventsArray(wtaResponse);

          // Filter WTA events
          const filteredWta = wtaRawEvents.filter((e) => {
            const slug = e?.slug?.toLowerCase() || '';
            if (!slug.startsWith('wta-')) return false;
            
            // Check if already collected
            if (e?.slug && collectedSlugs.has(e.slug)) return false;
            
            if (!isUpcomingGame(e)) return false;
            const end = e?.endDate || e?.end_date;
            if (!end) return true;
            const t = new Date(end).getTime();
            if (Number.isNaN(t)) return true;
            return t >= oldestAllowed;
          });

          const wtaEvents = filteredWta.map(transformSportsGameToLiveGameEvent);
          collected.push(...wtaEvents);
          
          // Track collected slugs to avoid duplicates
          wtaEvents.forEach(e => {
            if (e.slug) collectedSlugs.add(e.slug);
          });

          // logger.info({
          //   message: 'Fetched WTA games page for tennis',
          //   sport,
          //   wtaSeriesId,
          //   page,
          //   offset,
          //   fetched: wtaRawEvents.length,
          //   kept: filteredWta.length,
          // });

          // Stop if we got fewer than limit (no more pages)
          if (wtaRawEvents.length < limit) break;
        }
      } catch (error) {
        logger.warn({
          message: 'Error fetching WTA games for tennis',
          sport,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return collected;
  } catch (error) {
    logger.error({
      message: 'Error fetching sports games for sport',
      sport,
      seriesId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Fetch sports games for all configured sports
 * Matches sportgamecode.ts approach: fetch per sport with series_id, then combine
 */
export async function fetchSportsGames(): Promise<LiveGameEvent[]> {
  const startTime = Date.now();
  const sportsConfig = getAllSportsGamesConfig();
  const sports = Object.keys(sportsConfig);
  
  // Fetch all sports in parallel (matching sportgamecode.ts approach)
  const results = await Promise.allSettled(
    sports.map(async (sport) => {
      const config = sportsConfig[sport];
      const effectiveSeriesId = getSeriesIdForSport(sport);

      // For tennis and UFC, we still fetch even without series_id (games with null series_id or wrong series_id)
      // For other sports, skip if no series ID
      if ((!effectiveSeriesId || effectiveSeriesId === '') && sport !== 'tennis' && sport !== 'ufc') {
        logger.warn({
          message: 'Skipping sport with no series ID',
          sport,
          label: config.label,
        });
        return {
          sport,
          sportLabel: config.label,
          seriesId: effectiveSeriesId || config.seriesId,
          events: [],
        };
      }
      
      // For tennis and UFC without series_id, use empty string (fetchSportsGamesForSport handles this)
      // For other sports, we already checked they have a series_id above
      const seriesIdToUse = effectiveSeriesId || (sport === 'tennis' || sport === 'ufc' ? '' : '');
      
      const events = await fetchSportsGamesForSport(sport, seriesIdToUse);
      
      return {
        sport,
        sportLabel: config.label,
        seriesId: effectiveSeriesId || seriesIdToUse,
        events,
      };
    })
  );
  
  // Process results and combine all events
  const allEvents: LiveGameEvent[] = [];
  let sportsProcessed = 0;
  let sportsFailed = 0;
  const sportCounts: Record<string, number> = {};
  
  results.forEach((result, index) => {
    const sport = sports[index];
    
    if (result.status === 'fulfilled' && result.value.events.length > 0) {
      sportsProcessed++;
      allEvents.push(...result.value.events);
      sportCounts[sport] = result.value.events.length;
    } else {
      sportsFailed++;
      if (result.status === 'rejected') {
        logger.error({
          message: 'Failed to fetch sports games for sport',
          sport,
          error: result.reason?.message || 'Unknown error',
        });
      }
    }
  });
  
  // Sort by start time (soonest first)
  allEvents.sort((a, b) => {
    const aTime = a.startDate ? new Date(a.startDate).getTime() : Infinity;
    const bTime = b.startDate ? new Date(b.startDate).getTime() : Infinity;
    return aTime - bTime;
  });
  
  const latencyMs = Date.now() - startTime;
  
  // logger.info({
  //   message: 'Sports games fetched',
  //   totalEvents: allEvents.length,
  //   sportsProcessed,
  //   sportsFailed,
  //   sportCounts,
  //   latencyMs,
  // });
  
  return allEvents;
}

/**
 * Extract sport from slug (e.g., "nfl-buf-den-2026-01-17" -> "nfl")
 */
function extractSportFromSlug(slug: string, configuredSports: Set<string>): string | null {
  if (!slug) return null;
  
  const parts = slug.split('-');
  if (parts.length === 0) return null;
  
  const firstPart = parts[0].toLowerCase();
  
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
  
  // If first slug part is in blacklist, reject immediately
  if (NON_SPORTS_BLACKLIST.has(firstPart)) {
    return null;
  }
  
  // Check if first part matches a configured sport
  if (configuredSports.has(firstPart)) {
    return firstPart;
  }
  
  // Check sport indicators
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
  };
  
  for (const [sport, indicators] of Object.entries(sportIndicators)) {
    if (configuredSports.has(sport)) {
      for (const indicator of indicators) {
        if (firstPart === indicator) {
          return sport;
        }
      }
    }
  }
  
  return null;
}

/**
 * Refresh sports games: fetch, transform, enrich, and store with data_source='sports_games'
 * Runs per-sport sequentially to reduce live_games lock contention and deadlocks
 */
export async function refreshSportsGames(): Promise<number> {
  notifyGamesRefreshStarting();
  try {
    // logger.info({ message: 'Refreshing sports games' });

    const sportsConfig = getAllSportsGamesConfig();
    const sports = Object.keys(sportsConfig);

    // Fetch, transform, enrich, and store per sport sequentially
    const results: PromiseSettledResult<{ sport: string; count: number }>[] = [];
    for (const sport of sports) {
      try {
        const effectiveSeriesId = getSeriesIdForSport(sport);

        // For tennis and UFC, we still fetch even without series_id (games with null series_id or wrong series_id)
        // For other sports, skip if no series ID
        if ((!effectiveSeriesId || effectiveSeriesId === '') && sport !== 'tennis' && sport !== 'ufc') {
          results.push({ status: 'fulfilled', value: { sport, count: 0 } });
          continue;
        }

        // For tennis and UFC without series_id, use empty string (fetchSportsGamesForSport handles this)
        const seriesIdToUse = effectiveSeriesId || (sport === 'tennis' || sport === 'ufc' ? '' : '');

        // Fetch games for this sport
        const events = await fetchSportsGamesForSport(sport, seriesIdToUse);

        if (events.length === 0) {
          results.push({ status: 'fulfilled', value: { sport, count: 0 } });
          continue;
        }

        // Transform and enrich games
        const liveGames = await transformAndEnrichGames(events);

        // Exclude -more-markets games (duplicate/placeholder entries)
        const toStore = liveGames.filter((g) => !isMoreMarketsSlug(g.slug));

        // Store games with data_source='sports_games'
        await storeGames(toStore, 'sports_games');

        results.push({ status: 'fulfilled', value: { sport, count: toStore.length } });
      } catch (error) {
        results.push({
          status: 'rejected',
          reason: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    
    // Aggregate results
    let totalStored = 0;
    const sportCounts: Record<string, number> = {};
    let sportsProcessed = 0;
    let sportsFailed = 0;
    
    results.forEach((result, index) => {
      const sport = sports[index];
      
      if (result.status === 'fulfilled') {
        sportsProcessed++;
        totalStored += result.value.count;
        if (result.value.count > 0) {
          sportCounts[sport] = result.value.count;
        }
      } else {
        sportsFailed++;
        logger.error({
          message: 'Failed to refresh sports games for sport',
          sport,
          error: result.reason?.message || 'Unknown error',
        });
      }
    });
    
    // logger.info({
    //   message: 'Sports games refreshed',
    //   totalStored,
    //   sportsProcessed,
    //   sportsFailed,
    //   sportCounts,
    // });

    notifyGamesRefreshed();

    return totalStored;
  } catch (error) {
    logger.error({
      message: 'Error refreshing sports games',
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  } finally {
    notifyGamesRefreshEnded();
  }
}

/**
 * Sports Games Service Class
 * Manages polling for sports games updates
 */
export class SportsGamesService {
  private pollingInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  start(): void {
    if (this.isRunning) {
      logger.warn({ message: 'Sports games service already running' });
      return;
    }

    this.isRunning = true;
    
    // Delay initial refresh to prevent connection pool exhaustion during startup
    // Wait 3 seconds to allow other services to initialize first
    setTimeout(() => {
      refreshSportsGames().catch((error) => {
        logger.error({
          message: 'Error in initial sports games fetch',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 3000);

    // Set up polling interval (45 minutes)
    this.pollingInterval = setInterval(() => {
      refreshSportsGames().catch((error) => {
        logger.error({
          message: 'Error in sports games polling',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, POLLING_INTERVAL);

    // logger.info({ 
    //   message: 'Sports games polling started', 
    //   intervalMinutes: POLLING_INTERVAL / 60000 
    // });
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    // logger.info({ message: 'Sports games polling stopped' });
  }

  isRunningService(): boolean {
    return this.isRunning;
  }
}

// Export singleton instance
export const sportsGamesService = new SportsGamesService();

