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
      // Parse team names from title
      const teams = parseTeamsFromTitle(market.title);
      if (!teams) {
        // Skip markets we can't parse teams from
        logger.debug({
          message: 'Could not parse teams from Kalshi market title',
          ticker: market.ticker,
          title: market.title,
        });
        return null;
      }

      // Extract game date from close_time
      const closeTs = new Date(market.close_time);
      const gameDate = new Date(closeTs);
      gameDate.setHours(0, 0, 0, 0); // Normalize to date only

      // Normalize team names for matching
      const homeTeamNormalized = normalizeTeamName(teams.homeTeam);
      const awayTeamNormalized = normalizeTeamName(teams.awayTeam);

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
        homeTeamAbbr: extractTeamAbbreviation(teams.homeTeam),
        awayTeamAbbr: extractTeamAbbreviation(teams.awayTeam),
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
          yes_bid, yes_ask, no_bid, no_ask, updated_at
        )
        VALUES ${valuesClauses.join(', ')}
        ON CONFLICT (ticker) DO UPDATE SET
          event_ticker = EXCLUDED.event_ticker,
          title = EXCLUDED.title,
          subtitle = EXCLUDED.subtitle,
          status = EXCLUDED.status,
          close_ts = EXCLUDED.close_ts,
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
      const result = await client.query(
        `
        SELECT live_game_id, yes_bid, yes_ask, no_bid, no_ask, ticker
        FROM kalshi_markets
        WHERE live_game_id = ANY($1::text[])
          AND status = 'open'
        `,
        [gameIds]
      );

      const map = new Map<
        string,
        { yesBid: number; yesAsk: number; noBid: number; noAsk: number; ticker: string }
      >();

      for (const row of result.rows) {
        map.set(row.live_game_id, {
          yesBid: row.yes_bid,
          yesAsk: row.yes_ask,
          noBid: row.no_bid,
          noAsk: row.no_ask,
          ticker: row.ticker,
        });
      }

      return map;
    } finally {
      client.release();
    }
  }

  /**
   * Get Kalshi prices for a single game by slug
   * Used by activity watcher endpoint
   */
  async getKalshiPricesForSlug(
    slug: string
  ): Promise<{ yesBid: number; yesAsk: number; noBid: number; noAsk: number; ticker: string } | null> {
    const nodeEnv = process.env.NODE_ENV || 'development';
    if (nodeEnv !== 'production') {
      return null;
    }

    const client = await connectWithRetry();
    try {
      const result = await client.query(
        `
        SELECT km.yes_bid, km.yes_ask, km.no_bid, km.no_ask, km.ticker
        FROM kalshi_markets km
        JOIN live_games lg ON km.live_game_id = lg.id
        WHERE LOWER(lg.slug) = LOWER($1)
          AND km.status = 'open'
        LIMIT 1
        `,
        [slug]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        yesBid: row.yes_bid,
        yesAsk: row.yes_ask,
        noBid: row.no_bid,
        noAsk: row.no_ask,
        ticker: row.ticker,
      };
    } finally {
      client.release();
    }
  }
}

export const kalshiService = new KalshiService();
