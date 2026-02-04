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
      // Single SQL query does all matching - let Postgres do the work
      // We match on:
      // 1. Sport must match
      // 2. Game date must match (DATE comparison)
      // 3. Team names must match (using normalized columns or abbreviations)
      const result = await client.query(`
        WITH matches AS (
          SELECT DISTINCT ON (k.ticker)
            k.ticker,
            lg.id as live_game_id
          FROM kalshi_markets k
          JOIN live_games lg ON (
            -- Sport must match
            LOWER(k.sport) = LOWER(lg.sport)
            -- Date must match (compare just the date portion)
            AND k.game_date = DATE(lg.start_date)
            AND (
              -- Try normalized name match
              (
                LOWER(k.home_team) = LOWER(COALESCE(lg.home_team_normalized, ''))
                AND LOWER(k.away_team) = LOWER(COALESCE(lg.away_team_normalized, ''))
              )
              OR
              -- Try abbreviation match
              (
                UPPER(k.home_team_abbr) = UPPER(COALESCE(lg.home_abbr, ''))
                AND UPPER(k.away_team_abbr) = UPPER(COALESCE(lg.away_abbr, ''))
                AND k.home_team_abbr IS NOT NULL
                AND k.away_team_abbr IS NOT NULL
                AND lg.home_abbr IS NOT NULL
                AND lg.away_abbr IS NOT NULL
              )
              OR
              -- Fuzzy match: team name contains normalized or vice versa
              (
                (
                  LOWER(k.home_team) LIKE '%' || LOWER(COALESCE(lg.home_team_normalized, 'NOMATCH')) || '%'
                  OR LOWER(COALESCE(lg.home_team_normalized, '')) LIKE '%' || LOWER(k.home_team) || '%'
                )
                AND (
                  LOWER(k.away_team) LIKE '%' || LOWER(COALESCE(lg.away_team_normalized, 'NOMATCH')) || '%'
                  OR LOWER(COALESCE(lg.away_team_normalized, '')) LIKE '%' || LOWER(k.away_team) || '%'
                )
                AND LENGTH(k.home_team) >= 4
                AND LENGTH(k.away_team) >= 4
              )
            )
          )
          WHERE k.live_game_id IS NULL
            AND k.status = 'open'
            AND lg.ended = false
            AND (lg.closed IS NULL OR lg.closed = false)
          ORDER BY k.ticker, lg.updated_at DESC
        )
        UPDATE kalshi_markets k
        SET live_game_id = m.live_game_id, updated_at = NOW()
        FROM matches m
        WHERE k.ticker = m.ticker
        RETURNING k.ticker
      `);

      const matchCount = result.rowCount || 0;

      if (matchCount > 0) {
        logger.info({
          message: 'Kalshi markets matched to live games',
          matchedCount: matchCount,
        });
      }

      return matchCount;
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
        WHERE status = 'open'
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
