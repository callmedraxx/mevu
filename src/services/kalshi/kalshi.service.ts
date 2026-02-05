/**
 * Kalshi Markets Service
 * - Fetches markets from Kalshi API for configured sports
 * - Runs in parallel with live_games/sports_games refresh
 * - Stores in kalshi_markets table
 * - Triggers matching after store
 */

import { connectWithRetry } from '../../config/database';
import { logger } from '../../config/logger';
import { KALSHI_SPORT_SERIES } from './kalshi.config';
import { fetchAllMarketsForSeries } from './kalshi.client';
import { KalshiMarket, StoredKalshiMarket } from './kalshi.types';
import { normalizeTeamName, extractTeamAbbreviation, parseTeamsFromTitle } from './team-normalizer';
import { kalshiMatcherService } from './kalshi-matcher.service';

class KalshiService {
  private isRunning = false;
  private lastRefreshTime: Date | null = null;
  private lastRefreshCount = 0;
  private lastError: string | null = null;

  /**
   * Called by live-games.service during refresh cycle
   * Runs in parallel (non-blocking) with Polymarket fetch
   */
  async refreshKalshiMarkets(): Promise<void> {
    if (this.isRunning) {
      logger.debug({ message: 'Kalshi refresh already in progress, skipping' });
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      const nowTs = Math.floor(Date.now() / 1000);
      const allMarkets: (KalshiMarket & { _sport: string })[] = [];

      // Fetch all sports in parallel
      const sportFetches = Object.entries(KALSHI_SPORT_SERIES).map(
        async ([sport, seriesTickers]) => {
          const sportMarkets: (KalshiMarket & { _sport: string })[] = [];

          for (const seriesTicker of seriesTickers) {
            try {
              const markets = await fetchAllMarketsForSeries(seriesTicker, nowTs);
              markets.forEach(m => sportMarkets.push({ ...m, _sport: sport }));
            } catch (error) {
              logger.warn({
                message: 'Failed to fetch Kalshi markets for series',
                seriesTicker,
                sport,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          return sportMarkets;
        }
      );

      const results = await Promise.all(sportFetches);
      results.forEach(markets => allMarkets.push(...markets));

      if (allMarkets.length === 0) {
        logger.info({ message: 'No Kalshi markets found' });
        this.lastRefreshCount = 0;
        this.lastRefreshTime = new Date();
        return;
      }

      // Transform and batch upsert
      const transformed = allMarkets
        .map(m => this.transformMarket(m))
        .filter((m): m is StoredKalshiMarket => m !== null);

      if (transformed.length > 0) {
        await this.batchUpsertMarkets(transformed);
      }

      // Trigger matching (database-driven)
      await kalshiMatcherService.matchAllUnmatched();

      this.lastRefreshTime = new Date();
      this.lastRefreshCount = transformed.length;
      this.lastError = null;

      logger.info({
        message: 'Kalshi markets refresh completed',
        totalFetched: allMarkets.length,
        transformed: transformed.length,
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.error({
        message: 'Error refreshing Kalshi markets',
        error: this.lastError,
        durationMs: Date.now() - startTime,
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Transform a raw Kalshi market to our stored format
   */
  private transformMarket(market: KalshiMarket & { _sport: string }): StoredKalshiMarket | null {
    try {
      const upperTicker = market.ticker.toUpperCase();
      const isSuperBowl = upperTicker.startsWith('KXSB-');
      
      // Extract game date from ticker (format: KXSPORT-YYMONDD... e.g., KXNBAGAME-26FEB05CHAHOU)
      // For Super Bowl, use ticker year + close_time month/day (Kalshi has wrong year in close_time)
      let gameDate = this.extractGameDateFromTicker(market.ticker);
      if (!gameDate && isSuperBowl) {
        // Super Bowl: extract year from ticker (KXSB-26-SEA -> 26 = 2026)
        // Use month/day from close_time but correct the year
        const sbYearMatch = upperTicker.match(/KXSB-(\d{2})-/);
        if (sbYearMatch) {
          const tickerYear = 2000 + parseInt(sbYearMatch[1], 10); // 26 -> 2026
          const closeTs = new Date(market.close_time);
          // Super Bowl is typically in early February, use that
          gameDate = new Date(tickerYear, closeTs.getMonth(), closeTs.getDate());
          gameDate.setHours(0, 0, 0, 0);
        } else {
          // Fallback to close_time if can't extract year
          const closeTs = new Date(market.close_time);
          gameDate = new Date(closeTs.getFullYear(), closeTs.getMonth(), closeTs.getDate());
          gameDate.setHours(0, 0, 0, 0);
        }
      }
      
      if (!gameDate) {
        logger.debug({
          message: 'Could not extract game date from ticker',
          ticker: market.ticker,
        });
        return null;
      }

      // Extract team abbreviations from ticker (e.g., CHAHOU -> CHA, HOU)
      const tickerTeams = this.extractTeamsFromTicker(market.ticker);
      if (!tickerTeams) {
        logger.debug({
          message: 'Could not extract teams from ticker',
          ticker: market.ticker,
        });
        return null;
      }

      // Also try to parse from title for normalization
      const teams = parseTeamsFromTitle(market.title);

      const closeTs = new Date(market.close_time);

      // Use ticker abbreviations for matching, title for display names
      // For Super Bowl, homeAbbr is empty, so use awayAbbr for both
      const homeTeamNormalized = teams ? normalizeTeamName(teams.homeTeam) : (tickerTeams.homeAbbr || tickerTeams.awayAbbr).toLowerCase();
      const awayTeamNormalized = teams ? normalizeTeamName(teams.awayTeam) : tickerTeams.awayAbbr.toLowerCase();

      return {
        ticker: market.ticker,
        eventTicker: market.event_ticker,
        title: market.title,
        subtitle: market.subtitle || null,
        status: market.status,
        closeTs,
        sport: market._sport,
        league: market._sport, // Use same as sport for now
        homeTeam: homeTeamNormalized,
        awayTeam: awayTeamNormalized,
        homeTeamAbbr: tickerTeams.homeAbbr || tickerTeams.awayAbbr, // For Super Bowl, use awayAbbr as fallback
        awayTeamAbbr: tickerTeams.awayAbbr,
        gameDate,
        liveGameId: null, // Will be set by matcher
        yesBid: market.yes_bid || 0,
        yesAsk: market.yes_ask || 0,
        noBid: market.no_bid || 0,
        noAsk: market.no_ask || 0,
        volume: market.volume || 0,
        openInterest: market.open_interest || 0,
        rawData: market,
      };
    } catch (error) {
      logger.warn({
        message: 'Error transforming Kalshi market',
        ticker: market.ticker,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Extract game date from Kalshi ticker
   * Format: KXSPORT-YYMONDDTEAMS (e.g., KXNBAGAME-26FEB05CHAHOU-HOU)
   * Special case: KXSB-YY-TEAM (Super Bowl) - returns null, handled separately
   */
  private extractGameDateFromTicker(ticker: string): Date | null {
    // Super Bowl format (KXSB-26-SEA) doesn't have date in ticker
    if (ticker.toUpperCase().startsWith('KXSB-')) {
      return null; // Will use close_time instead for Super Bowl
    }

    // Match pattern like 26FEB05, 26JAN15, etc.
    const match = ticker.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i);
    if (!match) return null;

    const year = 2000 + parseInt(match[1], 10);
    const monthMap: Record<string, number> = {
      JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
      JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
    };
    const month = monthMap[match[2].toUpperCase()];
    const day = parseInt(match[3], 10);

    if (month === undefined || isNaN(day) || isNaN(year)) return null;

    const date = new Date(year, month, day);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  /**
   * Normalize Kalshi team abbreviation to match our live_games slug format
   * Kalshi sometimes uses different abbreviations than our slugs
   */
  private normalizeKalshiTeamAbbr(abbr: string): string {
    const upperAbbr = abbr.toUpperCase();
    
    // NHL abbreviation mappings (Kalshi -> our slugs)
    const NHL_ABBR_MAP: Record<string, string> = {
      'VGK': 'LAS',   // Vegas Golden Knights -> las (Las Vegas)
      'LA': 'LAK',    // LA Kings -> lak
      'CGY': 'CAL',   // Calgary Flames -> cal
      'MTL': 'MON',   // Montreal Canadiens -> mon (if we use this)
      'UTA': 'UTAH',  // Utah Hockey Club -> utah
      'SJ': 'SJS',    // San Jose Sharks -> sjs (if we use 3 chars)
      // Add more mappings as needed
    };
    
    return NHL_ABBR_MAP[upperAbbr] || upperAbbr;
  }

  /**
   * Extract team abbreviations from Kalshi ticker
   * Ticker formats:
   * - KXNBAGAME-26FEB05CHAHOU-HOU (game code CHAHOU = CHA + HOU)
   * - KXNBASPREAD-26FEB05CHAHOU-HOU9
   * - KXNBATOTAL-26FEB05CHAHOU-220
   * - KXNHLGAME-26FEB05FLATB-FLA (game code FLATB = FLA + TB, 5 chars for NHL)
   * - KXNHLGAME-26FEB05LAVGK-LA (game code LAVGK = LA + VGK, 5 chars for NHL)
   * - KXSB-26-SEA (Super Bowl - single team per market)
   * Returns { awayAbbr, homeAbbr } or null if can't parse
   */
  private extractTeamsFromTicker(ticker: string): { awayAbbr: string; homeAbbr: string } | null {
    const upperTicker = ticker.toUpperCase();
    
    // Super Bowl format: KXSB-YY-TEAM (e.g., KXSB-26-SEA)
    // Each team has its own market, so we store the team as "away" and leave home empty
    // The matcher will pair these based on the game date
    if (upperTicker.startsWith('KXSB-')) {
      const sbMatch = upperTicker.match(/KXSB-\d{2}-([A-Z]{2,4})$/);
      if (sbMatch) {
        return {
          awayAbbr: this.normalizeKalshiTeamAbbr(sbMatch[1]), // Store the team as away (will be matched to actual game)
          homeAbbr: '', // Empty - Super Bowl markets are per-team, not head-to-head
        };
      }
      return null;
    }
    
    // Match pattern: date (YYMONDD) followed by game code
    // Game codes vary in length based on team abbreviations:
    // - 6 chars: 3+3 (e.g., CHAHOU = CHA + HOU for NBA)
    // - 5 chars: 3+2 (e.g., FLATB = FLA + TB for NHL) or 2+3 (e.g., LAVGK = LA + VGK)
    // - 7 chars: 3+4 (some edge cases)
    
    // First try 6-char game code (most common: 3+3)
    const match6 = ticker.match(/\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}([A-Z]{6})/i);
    if (match6) {
      const gameCode = match6[1].toUpperCase();
      // First 3 chars = away team, last 3 chars = home team
      return {
        awayAbbr: this.normalizeKalshiTeamAbbr(gameCode.substring(0, 3)),
        homeAbbr: this.normalizeKalshiTeamAbbr(gameCode.substring(3, 6)),
      };
    }
    
    // Try 5-char game code for NHL teams with 2-char abbreviations
    // Could be 3+2 (e.g., FLATB = FLA + TB, NYINJ = NYI + NJ) or 2+3 (e.g., LAVGK = LA + VGK)
    const match5 = ticker.match(/\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}([A-Z]{5})/i);
    if (match5) {
      const gameCode = match5[1].toUpperCase();
      
      // Known 2-char teams that appear at START of game code (away team with 2 chars)
      // Note: Don't include 'NY' here because 'NYI' and 'NYR' are valid 3-char teams
      const twoCharAwayTeams = ['LA', 'SJ']; // LA Kings, San Jose
      
      // Known 2-char teams that appear at END of game code (home team with 2 chars)
      const twoCharHomeTeams = ['TB', 'NJ']; // Tampa Bay, New Jersey
      
      // Check if last 2 chars match a known 2-char home team (3+2 format: e.g., FLATB, NYINJ)
      if (twoCharHomeTeams.includes(gameCode.substring(3, 5))) {
        return {
          awayAbbr: this.normalizeKalshiTeamAbbr(gameCode.substring(0, 3)),
          homeAbbr: this.normalizeKalshiTeamAbbr(gameCode.substring(3, 5)),
        };
      }
      
      // Check if first 2 chars match a known 2-char away team (2+3 format: e.g., LAVGK)
      if (twoCharAwayTeams.includes(gameCode.substring(0, 2))) {
        return {
          awayAbbr: this.normalizeKalshiTeamAbbr(gameCode.substring(0, 2)),
          homeAbbr: this.normalizeKalshiTeamAbbr(gameCode.substring(2, 5)),
        };
      }
      
      // Default: assume 3+2 format (most common for NHL 5-char codes)
      return {
        awayAbbr: this.normalizeKalshiTeamAbbr(gameCode.substring(0, 3)),
        homeAbbr: this.normalizeKalshiTeamAbbr(gameCode.substring(3, 5)),
      };
    }
    
    // Try 7-char game code (3+4, some edge cases)
    const match7 = ticker.match(/\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}([A-Z]{7})/i);
    if (match7) {
      const gameCode = match7[1].toUpperCase();
      return {
        awayAbbr: this.normalizeKalshiTeamAbbr(gameCode.substring(0, 3)),
        homeAbbr: this.normalizeKalshiTeamAbbr(gameCode.substring(3, 7)),
      };
    }
    
    // Try 4-char game code (2+2, rare but possible)
    const match4 = ticker.match(/\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\d{2}([A-Z]{4})/i);
    if (match4) {
      const gameCode = match4[1].toUpperCase();
      return {
        awayAbbr: this.normalizeKalshiTeamAbbr(gameCode.substring(0, 2)),
        homeAbbr: this.normalizeKalshiTeamAbbr(gameCode.substring(2, 4)),
      };
    }
    
    return null;
  }

  /**
   * Batch upsert markets to database
   * Prepares all data BEFORE getting connection (minimizes connection hold time)
   */
  private async batchUpsertMarkets(markets: StoredKalshiMarket[]): Promise<void> {
    if (markets.length === 0) return;

    const nodeEnv = process.env.NODE_ENV || 'development';
    if (nodeEnv !== 'production') {
      logger.debug({
        message: 'Skipping Kalshi DB upsert in non-production',
        count: markets.length,
      });
      return;
    }

    // Prepare all data BEFORE getting connection
    const BATCH_SIZE = 100;
    const chunks: { query: string; values: unknown[] }[] = [];

    for (let i = 0; i < markets.length; i += BATCH_SIZE) {
      const chunk = markets.slice(i, i + BATCH_SIZE);
      const valuesClauses: string[] = [];
      const values: unknown[] = [];

      chunk.forEach((m, idx) => {
        const base = idx * 17;
        valuesClauses.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}, $${base + 17})`
        );
        values.push(
          m.ticker,
          m.eventTicker,
          m.title,
          m.subtitle,
          m.status,
          m.closeTs,
          m.sport,
          m.league,
          m.homeTeam,
          m.awayTeam,
          m.homeTeamAbbr,
          m.awayTeamAbbr,
          m.gameDate,
          m.yesBid,
          m.yesAsk,
          m.noBid,
          m.noAsk
        );
      });

      const query = `
        INSERT INTO kalshi_markets (
          ticker, event_ticker, title, subtitle, status, close_ts,
          sport, league, home_team, away_team, home_team_abbr, away_team_abbr, game_date,
          yes_bid, yes_ask, no_bid, no_ask
        )
        VALUES ${valuesClauses.join(', ')}
        ON CONFLICT (ticker) DO UPDATE SET
          event_ticker = EXCLUDED.event_ticker,
          title = EXCLUDED.title,
          subtitle = EXCLUDED.subtitle,
          status = EXCLUDED.status,
          close_ts = EXCLUDED.close_ts,
          game_date = EXCLUDED.game_date,
          home_team_abbr = EXCLUDED.home_team_abbr,
          away_team_abbr = EXCLUDED.away_team_abbr,
          yes_bid = EXCLUDED.yes_bid,
          yes_ask = EXCLUDED.yes_ask,
          no_bid = EXCLUDED.no_bid,
          no_ask = EXCLUDED.no_ask,
          updated_at = NOW()
      `.replace(/\$(\d+)/g, (_, n) => `$${n}`);

      chunks.push({ query, values });
    }

    // Single connection, execute all chunks
    const client = await connectWithRetry();
    try {
      for (const { query, values } of chunks) {
        await client.query(query, values);
      }

      logger.debug({
        message: 'Kalshi markets upserted to database',
        count: markets.length,
        chunks: chunks.length,
      });
    } catch (error) {
      logger.error({
        message: 'Error upserting Kalshi markets',
        error: error instanceof Error ? error.message : String(error),
        count: markets.length,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get service status for monitoring
   */
  getStatus(): {
    isRunning: boolean;
    lastRefreshTime: Date | null;
    lastRefreshCount: number;
    lastError: string | null;
  } {
    return {
      isRunning: this.isRunning,
      lastRefreshTime: this.lastRefreshTime,
      lastRefreshCount: this.lastRefreshCount,
      lastError: this.lastError,
    };
  }

  /**
   * Get Kalshi prices for a list of live game IDs
   * Used by frontend-games transformation
   * 
   * IMPORTANT: Returns MONEYLINE (GAME) markets with proper away/home price mapping
   * 
   * Kalshi has separate markets for each team:
   * - KXNBAGAME-26FEB05BKNORL-BKN: Brooklyn (away) market, YES = Brooklyn wins
   * - KXNBAGAME-26FEB05BKNORL-ORL: Orlando (home) market, YES = Orlando wins
   * - KXSB-26-SEA: Super Bowl - Seattle market, YES = Seattle wins
   * 
   * We return prices where:
   * - yesBid/yesAsk = away team prices (from away team's market)
   * - noBid/noAsk = home team prices (from home team's market)
   */
  async getKalshiPricesForGames(
    gameIds: string[]
  ): Promise<Map<string, { yesBid: number; yesAsk: number; noBid: number; noAsk: number; ticker: string }>> {
    if (gameIds.length === 0) {
      return new Map();
    }

    const nodeEnv = process.env.NODE_ENV || 'development';
    if (nodeEnv !== 'production') {
      return new Map();
    }

    const client = await connectWithRetry();
    try {
      // Fetch moneyline markets for each game, including live game slug for team matching
      // - Regular games: KXNBAGAME, KXNFLGAME, etc. (ticker contains 'GAME-')
      // - Super Bowl: KXSB-YY-TEAM format
      // Exclude TIE outcomes
      const result = await client.query(
        `
        SELECT 
          km.live_game_id, 
          km.yes_bid, 
          km.yes_ask, 
          km.no_bid, 
          km.no_ask, 
          km.ticker,
          km.away_team_abbr,
          km.home_team_abbr,
          lg.slug as game_slug
        FROM kalshi_markets km
        JOIN live_games lg ON km.live_game_id = lg.id
        WHERE km.live_game_id = ANY($1::text[])
          AND km.status = 'active'
          AND (
            (UPPER(km.ticker) LIKE '%GAME-%' AND UPPER(km.ticker) NOT LIKE '%-TIE')
            OR UPPER(km.ticker) LIKE 'KXSB-%'
          )
        ORDER BY km.live_game_id, km.ticker
        `,
        [gameIds]
      );

      const map = new Map<
        string,
        { yesBid: number; yesAsk: number; noBid: number; noAsk: number; ticker: string }
      >();

      // Group markets by game ID, then combine away and home team markets
      const gameMarkets = new Map<string, typeof result.rows>();
      for (const row of result.rows) {
        const existing = gameMarkets.get(row.live_game_id) || [];
        existing.push(row);
        gameMarkets.set(row.live_game_id, existing);
      }

      for (const [gameId, markets] of gameMarkets) {
        if (markets.length === 0) continue;

        // Extract actual away/home teams from slug: sport-away-home-date (e.g., nfl-sea-ne-2026-02-08)
        const firstMarket = markets[0];
        const gameSlug = firstMarket?.game_slug || '';
        const slugParts = gameSlug.split('-');
        const gameAwayAbbr = slugParts[1]?.toUpperCase() || ''; // lak -> LAK
        const gameHomeAbbr = slugParts[2]?.toUpperCase() || ''; // las -> LAS

        // Find away and home team markets
        // Match based on the normalized team abbreviations stored in the database
        let awayMarket = null;
        let homeMarket = null;
        
        for (const market of markets) {
          const tickerUpper = market.ticker.toUpperCase();
          const marketAwayAbbr = market.away_team_abbr?.toUpperCase(); // Normalized: LAK
          const marketHomeAbbr = market.home_team_abbr?.toUpperCase(); // Normalized: LAS
          
          // For Super Bowl (KXSB-YY-TEAM), match based on the team in the ticker vs game teams
          if (tickerUpper.startsWith('KXSB-')) {
            const sbMatch = tickerUpper.match(/KXSB-\d{2}-([A-Z]{2,4})$/);
            if (sbMatch) {
              const sbTeam = sbMatch[1];
              // Match against the actual game's away/home teams from slug
              if (sbTeam === gameAwayAbbr) {
                awayMarket = market;
              } else if (sbTeam === gameHomeAbbr) {
                homeMarket = market;
              }
            }
            continue;
          }
          
          // For regular GAME markets, extract the team suffix from ticker
          // Ticker format: KXSPORT-DATE+TEAMS-TEAM (e.g., KXNHLGAME-26FEB05LAVGK-LA)
          const tickerSuffixMatch = tickerUpper.match(/-([A-Z]{2,4})$/);
          if (!tickerSuffixMatch) continue;
          const tickerTeam = tickerSuffixMatch[1]; // e.g., "LA" or "VGK"
          
          // Normalize the ticker team to match our slug format
          const normalizedTickerTeam = this.normalizeKalshiTeamAbbr(tickerTeam);
          
          // Match against game's away/home teams
          if (normalizedTickerTeam === gameAwayAbbr) {
            awayMarket = market;
          } else if (normalizedTickerTeam === gameHomeAbbr) {
            homeMarket = market;
          }
        }

        // Build combined price data
        // yesBid/yesAsk = away team win prices (from away market's YES)
        // noBid/noAsk = home team win prices (from home market's YES)
        if (awayMarket || homeMarket) {
          map.set(gameId, {
            // Away team prices (YES from away team's market)
            yesBid: awayMarket?.yes_bid ?? 0,
            yesAsk: awayMarket?.yes_ask ?? 0,
            // Home team prices (YES from home team's market, stored as NO to match interface)
            noBid: homeMarket?.yes_bid ?? 0,
            noAsk: homeMarket?.yes_ask ?? 0,
            ticker: awayMarket?.ticker || homeMarket?.ticker || '',
          });
        }
      }

      return map;
    } finally {
      client.release();
    }
  }

  /**
   * Get Kalshi prices for a single game by slug
   * Used by activity watcher endpoint
   * 
   * IMPORTANT: Returns MONEYLINE (GAME) markets with proper away/home price mapping
   */
  async getKalshiPricesForSlug(
    slug: string
  ): Promise<{ yesBid: number; yesAsk: number; noBid: number; noAsk: number; ticker: string } | null> {
    const nodeEnv = process.env.NODE_ENV || 'development';
    if (nodeEnv !== 'production') {
      return null;
    }

    // Extract away/home teams from slug: sport-away-home-date (e.g., nfl-sea-ne-2026-02-08)
    const slugParts = slug.split('-');
    const gameAwayAbbr = slugParts[1]?.toUpperCase() || ''; // sea -> SEA
    const gameHomeAbbr = slugParts[2]?.toUpperCase() || ''; // ne -> NE

    const client = await connectWithRetry();
    try {
      // Fetch moneyline markets:
      // - Regular games: KXNBAGAME, KXNFLGAME, etc. (ticker contains 'GAME-')
      // - Super Bowl: KXSB-YY-TEAM format
      const result = await client.query(
        `
        SELECT 
          km.yes_bid, 
          km.yes_ask, 
          km.no_bid, 
          km.no_ask, 
          km.ticker,
          km.away_team_abbr,
          km.home_team_abbr
        FROM kalshi_markets km
        JOIN live_games lg ON km.live_game_id = lg.id
        WHERE LOWER(lg.slug) = LOWER($1)
          AND km.status = 'active'
          AND (
            (UPPER(km.ticker) LIKE '%GAME-%' AND UPPER(km.ticker) NOT LIKE '%-TIE')
            OR UPPER(km.ticker) LIKE 'KXSB-%'
          )
        ORDER BY km.ticker
        `,
        [slug]
      );

      if (result.rows.length === 0) {
        return null;
      }

      // Find away and home team markets
      let awayMarket = null;
      let homeMarket = null;
      
      for (const market of result.rows) {
        const tickerUpper = market.ticker.toUpperCase();
        
        // For Super Bowl (KXSB-YY-TEAM), match based on the team in the ticker vs game teams
        if (tickerUpper.startsWith('KXSB-')) {
          const sbMatch = tickerUpper.match(/KXSB-\d{2}-([A-Z]{2,4})$/);
          if (sbMatch) {
            const sbTeam = sbMatch[1];
            // Match against the actual game's away/home teams from slug
            if (sbTeam === gameAwayAbbr) {
              awayMarket = market;
            } else if (sbTeam === gameHomeAbbr) {
              homeMarket = market;
            }
          }
          continue;
        }
        
        // For regular GAME markets, extract the team suffix from ticker
        const tickerSuffixMatch = tickerUpper.match(/-([A-Z]{2,4})$/);
        if (!tickerSuffixMatch) continue;
        const tickerTeam = tickerSuffixMatch[1];
        
        // Normalize the ticker team to match our slug format
        const normalizedTickerTeam = this.normalizeKalshiTeamAbbr(tickerTeam);
        
        // Match against game's away/home teams
        if (normalizedTickerTeam === gameAwayAbbr) {
          awayMarket = market;
        } else if (normalizedTickerTeam === gameHomeAbbr) {
          homeMarket = market;
        }
      }

      if (!awayMarket && !homeMarket) {
        return null;
      }

      // Build combined price data
      return {
        // Away team prices (YES from away team's market)
        yesBid: awayMarket?.yes_bid ?? 0,
        yesAsk: awayMarket?.yes_ask ?? 0,
        // Home team prices (YES from home team's market)
        noBid: homeMarket?.yes_bid ?? 0,
        noAsk: homeMarket?.yes_ask ?? 0,
        ticker: awayMarket?.ticker || homeMarket?.ticker || '',
      };
    } finally {
      client.release();
    }
  }
}

export const kalshiService = new KalshiService();
