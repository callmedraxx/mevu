/**
 * Kalshi Matcher Service
 * Uses PostgreSQL for efficient matching - no loops in Node.js
 * Matches Kalshi markets to Polymarket live_games using SQL
 */

import { pool } from '../../config/database';
import { logger } from '../../config/logger';

class KalshiMatcherService {
  /**
   * Match Kalshi markets to Polymarket live_games using SQL
   * Matching criteria:
   * 1. Same sport
   * 2. Same normalized team names (home/away)
   * 3. Same game date (within tolerance)
   *
   * Special handling for Super Bowl (KXSB) markets:
   * - Each team has its own market (KXSB-26-SEA, KXSB-26-NE)
   * - Match by team being either home or away in the game
   *
   * All matching logic runs in PostgreSQL for efficiency
   * @returns Number of markets matched
   */
  async matchAllUnmatched(): Promise<number> {
    const nodeEnv = process.env.NODE_ENV || 'development';
    if (nodeEnv !== 'production') {
      logger.debug({ message: 'Skipping Kalshi matching in non-production mode' });
      return 0;
    }

    const client = await pool.connect();
    try {
      // Match regular game markets (KXNBAGAME, etc.)
      const regularResult = await client.query(`
        WITH slug_parsed AS (
          SELECT
            lg.id,
            lg.slug,
            lg.sport,
            lg.ended,
            lg.closed,
            -- Extract away_abbr (2nd part of slug)
            LOWER(SPLIT_PART(lg.slug, '-', 2)) as slug_away_abbr,
            -- Extract home_abbr (3rd part of slug)
            LOWER(SPLIT_PART(lg.slug, '-', 3)) as slug_home_abbr,
            -- Extract date from slug (last 3 parts: YYYY-MM-DD)
            (SPLIT_PART(lg.slug, '-', 4) || '-' ||
             SPLIT_PART(lg.slug, '-', 5) || '-' ||
             SPLIT_PART(lg.slug, '-', 6))::date as slug_date
          FROM live_games lg
          WHERE lg.slug ~ '^[a-z]+-[a-z]+-[a-z]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        ),
        matches AS (
          SELECT DISTINCT ON (k.ticker)
            k.ticker,
            sp.id as live_game_id
          FROM kalshi_markets k
          JOIN slug_parsed sp ON (
            -- Sport must match
            LOWER(k.sport) = LOWER(sp.sport)
            -- Date must match
            AND k.game_date = sp.slug_date
            -- Team abbreviations must match (from Kalshi abbr to slug abbr)
            AND LOWER(k.home_team_abbr) = sp.slug_home_abbr
            AND LOWER(k.away_team_abbr) = sp.slug_away_abbr
          )
          WHERE k.live_game_id IS NULL
            AND k.status = 'active'
            AND UPPER(k.ticker) NOT LIKE 'KXSB-%'  -- Exclude Super Bowl (handled separately)
            AND sp.ended = false
            AND (sp.closed IS NULL OR sp.closed = false)
          ORDER BY k.ticker
        )
        UPDATE kalshi_markets k
        SET live_game_id = m.live_game_id, updated_at = NOW()
        FROM matches m
        WHERE k.ticker = m.ticker
        RETURNING k.ticker
      `);

      const regularMatchCount = regularResult.rowCount || 0;

      // Match Super Bowl markets (KXSB-YY-TEAM format)
      // These are per-team markets, so match if the team is either home or away
      const sbResult = await client.query(`
        WITH slug_parsed AS (
          SELECT
            lg.id,
            lg.slug,
            lg.sport,
            lg.ended,
            lg.closed,
            -- Extract away_abbr (2nd part of slug)
            LOWER(SPLIT_PART(lg.slug, '-', 2)) as slug_away_abbr,
            -- Extract home_abbr (3rd part of slug)
            LOWER(SPLIT_PART(lg.slug, '-', 3)) as slug_home_abbr,
            -- Extract date from slug (last 3 parts: YYYY-MM-DD)
            (SPLIT_PART(lg.slug, '-', 4) || '-' ||
             SPLIT_PART(lg.slug, '-', 5) || '-' ||
             SPLIT_PART(lg.slug, '-', 6))::date as slug_date
          FROM live_games lg
          WHERE lg.sport = 'nfl'
            AND lg.slug ~ '^[a-z]+-[a-z]+-[a-z]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        ),
        sb_matches AS (
          SELECT DISTINCT ON (k.ticker)
            k.ticker,
            sp.id as live_game_id
          FROM kalshi_markets k
          JOIN slug_parsed sp ON (
            -- Super Bowl is NFL
            LOWER(k.sport) = 'nfl'
            -- Date must match
            AND k.game_date = sp.slug_date
            -- Team must be either home or away in the game
            AND (
              LOWER(k.away_team_abbr) = sp.slug_home_abbr
              OR LOWER(k.away_team_abbr) = sp.slug_away_abbr
            )
          )
          WHERE k.live_game_id IS NULL
            AND k.status = 'active'
            AND UPPER(k.ticker) LIKE 'KXSB-%'  -- Only Super Bowl markets
            AND sp.ended = false
            AND (sp.closed IS NULL OR sp.closed = false)
          ORDER BY k.ticker
        )
        UPDATE kalshi_markets k
        SET live_game_id = m.live_game_id, updated_at = NOW()
        FROM sb_matches m
        WHERE k.ticker = m.ticker
        RETURNING k.ticker
      `);

      const sbMatchCount = sbResult.rowCount || 0;
      const totalMatchCount = regularMatchCount + sbMatchCount;

      if (totalMatchCount > 0) {
        logger.info({
          message: 'Kalshi markets matched to live games',
          matchedCount: totalMatchCount,
          regularMatches: regularMatchCount,
          superBowlMatches: sbMatchCount,
        });
      }

      return totalMatchCount;
    } catch (error) {
      logger.error({
        message: 'Error matching Kalshi markets',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Clear stale matches where the live game has ended
   * This allows Kalshi markets to potentially match new games
   * @returns Number of matches cleared
   */
  async clearStaleMatches(): Promise<number> {
    const nodeEnv = process.env.NODE_ENV || 'development';
    if (nodeEnv !== 'production') {
      return 0;
    }

    const client = await pool.connect();
    try {
      const result = await client.query(`
        UPDATE kalshi_markets k
        SET live_game_id = NULL, updated_at = NOW()
        FROM live_games lg
        WHERE k.live_game_id = lg.id
          AND (lg.ended = true OR lg.closed = true)
        RETURNING k.ticker
      `);

      const clearedCount = result.rowCount || 0;

      if (clearedCount > 0) {
        logger.info({
          message: 'Cleared stale Kalshi market matches',
          clearedCount,
        });
      }

      return clearedCount;
    } finally {
      client.release();
    }
  }

  /**
   * Get match statistics for monitoring
   */
  async getMatchStats(): Promise<{
    total: number;
    matched: number;
    unmatched: number;
    stale: number;
  }> {
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT
          COUNT(*) as total,
          COUNT(live_game_id) as matched,
          COUNT(*) FILTER (WHERE live_game_id IS NULL) as unmatched,
          COUNT(*) FILTER (WHERE live_game_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM live_games lg
            WHERE lg.id = kalshi_markets.live_game_id
            AND (lg.ended = true OR lg.closed = true)
          )) as stale
        FROM kalshi_markets
        WHERE status = 'active'
      `);

      const row = result.rows[0];
      return {
        total: parseInt(row.total, 10),
        matched: parseInt(row.matched, 10),
        unmatched: parseInt(row.unmatched, 10),
        stale: parseInt(row.stale, 10),
      };
    } finally {
      client.release();
    }
  }
}

export const kalshiMatcherService = new KalshiMatcherService();
