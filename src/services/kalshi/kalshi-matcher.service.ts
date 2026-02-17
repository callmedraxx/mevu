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
            -- Extract away_abbr (2nd part of slug); allow alphanumeric for UFC (e.g. mic1, mar14)
            LOWER(SPLIT_PART(lg.slug, '-', 2)) as slug_away_abbr,
            LOWER(SPLIT_PART(lg.slug, '-', 3)) as slug_home_abbr,
            (SPLIT_PART(lg.slug, '-', 4) || '-' ||
             SPLIT_PART(lg.slug, '-', 5) || '-' ||
             SPLIT_PART(lg.slug, '-', 6))::date as slug_date,
            lg.away_team_normalized,
            lg.home_team_normalized
          FROM live_games lg
          WHERE lg.slug ~ '^[a-z]+-[a-z0-9]+-[a-z0-9]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        ),
        matches AS (
          SELECT DISTINCT ON (k.ticker)
            k.ticker,
            sp.id as live_game_id
          FROM kalshi_markets k
          JOIN slug_parsed sp ON (
            LOWER(k.sport) = LOWER(sp.sport)
            AND k.game_date = sp.slug_date
            AND LOWER(k.home_team_abbr) = sp.slug_home_abbr
            AND LOWER(k.away_team_abbr) = sp.slug_away_abbr
          )
          WHERE k.live_game_id IS NULL
            AND k.status IN ('active', 'open', 'unopened', 'initialized')
            AND UPPER(k.ticker) NOT LIKE 'KXSB-%'
            AND UPPER(k.ticker) NOT LIKE 'KXUFCFIGHT-%'
            AND UPPER(k.ticker) NOT LIKE 'KXWTAMATCH-%'
            AND UPPER(k.ticker) NOT LIKE 'KXATPMATCH-%'
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

      // Date tolerance fallback (±2 days): Polymarket and Kalshi sometimes use different dates
      // for the same match. Applies to all sports with standard slug format (NBA, NHL, NFL, La Liga, EPL, CBB, etc.).
      // Excludes special formats (Super Bowl, UFC, Tennis) which have their own matchers.
      const dateToleranceResult = await client.query(`
        WITH slug_parsed AS (
          SELECT
            lg.id,
            lg.slug,
            lg.sport,
            LOWER(SPLIT_PART(lg.slug, '-', 2)) as slug_away_abbr,
            LOWER(SPLIT_PART(lg.slug, '-', 3)) as slug_home_abbr,
            (SPLIT_PART(lg.slug, '-', 4) || '-' ||
             SPLIT_PART(lg.slug, '-', 5) || '-' ||
             SPLIT_PART(lg.slug, '-', 6))::date as slug_date
          FROM live_games lg
          WHERE lg.slug ~ '^[a-z]+-[a-z0-9]+-[a-z0-9]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            AND lg.ended = false
            AND (lg.closed IS NULL OR lg.closed = false)
        ),
        matches AS (
          SELECT DISTINCT ON (k.ticker)
            k.ticker,
            sp.id as live_game_id
          FROM kalshi_markets k
          JOIN slug_parsed sp ON (
            LOWER(k.sport) = LOWER(sp.sport)
            AND k.game_date BETWEEN (sp.slug_date - 2) AND (sp.slug_date + 2)
            AND LOWER(k.home_team_abbr) = sp.slug_home_abbr
            AND LOWER(k.away_team_abbr) = sp.slug_away_abbr
          )
          WHERE k.live_game_id IS NULL
            AND k.status IN ('active', 'open', 'unopened', 'initialized')
            AND UPPER(k.ticker) NOT LIKE 'KXSB-%'
            AND UPPER(k.ticker) NOT LIKE 'KXUFCFIGHT-%'
            AND UPPER(k.ticker) NOT LIKE 'KXWTAMATCH-%'
            AND UPPER(k.ticker) NOT LIKE 'KXATPMATCH-%'
          ORDER BY k.ticker, ABS(k.game_date - sp.slug_date)
        )
        UPDATE kalshi_markets k
        SET live_game_id = m.live_game_id, updated_at = NOW()
        FROM matches m
        WHERE k.ticker = m.ticker
        RETURNING k.ticker
      `);

      const dateToleranceCount = dateToleranceResult.rowCount || 0;

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

      // Match UFC markets (KXUFCFIGHT): one market per fight; match by date + title tokens vs normalized team names
      const ufcResult = await client.query(`
        WITH slug_parsed_ufc AS (
          SELECT
            lg.id,
            lg.slug,
            lg.sport,
            lg.ended,
            lg.closed,
            (SPLIT_PART(lg.slug, '-', 4) || '-' || SPLIT_PART(lg.slug, '-', 5) || '-' || SPLIT_PART(lg.slug, '-', 6))::date as slug_date,
            LOWER(COALESCE(lg.away_team_normalized, '')) as away_norm,
            LOWER(COALESCE(lg.home_team_normalized, '')) as home_norm
          FROM live_games lg
          WHERE lg.sport = 'ufc'
            AND lg.slug ~ '^[a-z]+-[a-z0-9]+-[a-z0-9]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        ),
        ufc_title_tokens AS (
          SELECT
            k.ticker,
            k.title,
            k.game_date,
            LOWER(TRIM(SPLIT_PART(k.title, ' vs ', 1))) as token1,
            LOWER(TRIM(SPLIT_PART(SPLIT_PART(k.title, ' vs ', 2), ' ', 1))) as token2
          FROM kalshi_markets k
          WHERE k.live_game_id IS NULL
            AND k.status IN ('active', 'open', 'unopened')
            AND UPPER(k.ticker) LIKE 'KXUFCFIGHT-%'
            AND k.sport = 'ufc'
            AND k.title LIKE '% vs %'
        ),
        ufc_matches AS (
          SELECT DISTINCT ON (u.ticker)
            u.ticker,
            sp.id as live_game_id
          FROM ufc_title_tokens u
          JOIN slug_parsed_ufc sp ON (
            sp.slug_date = u.game_date
            AND sp.ended = false
            AND (sp.closed IS NULL OR sp.closed = false)
            AND (
              (sp.away_norm LIKE '%' || u.token1 || '%' AND sp.home_norm LIKE '%' || u.token2 || '%')
              OR (sp.away_norm LIKE '%' || u.token2 || '%' AND sp.home_norm LIKE '%' || u.token1 || '%')
            )
          )
          ORDER BY u.ticker
        )
        UPDATE kalshi_markets k
        SET live_game_id = m.live_game_id, updated_at = NOW()
        FROM ufc_matches m
        WHERE k.ticker = m.ticker
        RETURNING k.ticker
      `);

      const ufcMatchCount = ufcResult.rowCount || 0;

      // Match Tennis markets (KXWTAMATCH, KXATPMATCH): match by date + player name prefix
      // Tennis tickers use first 3 letters of each player's last name (e.g., KXWTAMATCH-26FEB06ZARBIR = ZAR + BIR)
      // Our slugs use abbreviated player names (e.g., wta-zarazua-birrell-2026-02-06)
      // Try BOTH orderings (Kalshi game code may be away+home or home+away); then normalize away_team_abbr/home_team_abbr
      // from our slug so price updates always use our canonical away/home and never swap.
      const tennisResult = await client.query(`
        WITH slug_parsed_tennis AS (
          SELECT
            lg.id,
            lg.slug,
            lg.sport,
            lg.ended,
            lg.closed,
            LOWER(SPLIT_PART(lg.slug, '-', 2)) as slug_away_name,
            LOWER(SPLIT_PART(lg.slug, '-', 3)) as slug_home_name,
            UPPER(LEFT(SPLIT_PART(lg.slug, '-', 2), 3)) as slug_away_abbr,
            UPPER(LEFT(SPLIT_PART(lg.slug, '-', 3), 3)) as slug_home_abbr,
            (SPLIT_PART(lg.slug, '-', 4) || '-' ||
             SPLIT_PART(lg.slug, '-', 5) || '-' ||
             SPLIT_PART(lg.slug, '-', 6))::date as slug_date
          FROM live_games lg
          WHERE lg.sport = 'tennis'
            AND lg.slug ~ '^[a-z]+-[a-z]+-[a-z]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        ),
        tennis_matches AS (
          SELECT DISTINCT ON (k.ticker)
            k.ticker,
            sp.id as live_game_id,
            sp.slug_away_abbr,
            sp.slug_home_abbr
          FROM kalshi_markets k
          JOIN slug_parsed_tennis sp ON (
            k.game_date = sp.slug_date
            AND (
              (sp.slug_away_name LIKE LOWER(k.away_team_abbr) || '%' AND sp.slug_home_name LIKE LOWER(k.home_team_abbr) || '%')
              OR (sp.slug_away_name LIKE LOWER(k.home_team_abbr) || '%' AND sp.slug_home_name LIKE LOWER(k.away_team_abbr) || '%')
            )
          )
          WHERE k.live_game_id IS NULL
            AND k.status IN ('active', 'open', 'unopened')
            AND (UPPER(k.ticker) LIKE 'KXWTAMATCH-%' OR UPPER(k.ticker) LIKE 'KXATPMATCH-%')
            AND k.sport = 'tennis'
            AND sp.ended = false
            AND (sp.closed IS NULL OR sp.closed = false)
          ORDER BY k.ticker
        )
        UPDATE kalshi_markets k
        SET live_game_id = m.live_game_id,
            away_team_abbr = m.slug_away_abbr,
            home_team_abbr = m.slug_home_abbr,
            updated_at = NOW()
        FROM tennis_matches m
        WHERE k.ticker = m.ticker
        RETURNING k.ticker
      `);

      const tennisMatchCount = tennisResult.rowCount || 0;

      // Normalize away_team_abbr/home_team_abbr for already-matched tennis markets from slug (fixes any prior swap)
      await client.query(`
        WITH slug_parsed_tennis AS (
          SELECT
            lg.id,
            UPPER(LEFT(SPLIT_PART(lg.slug, '-', 2), 3)) as slug_away_abbr,
            UPPER(LEFT(SPLIT_PART(lg.slug, '-', 3), 3)) as slug_home_abbr
          FROM live_games lg
          WHERE lg.sport = 'tennis'
            AND lg.slug ~ '^[a-z]+-[a-z]+-[a-z]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        )
        UPDATE kalshi_markets k
        SET away_team_abbr = sp.slug_away_abbr,
            home_team_abbr = sp.slug_home_abbr,
            updated_at = NOW()
        FROM slug_parsed_tennis sp
        WHERE k.live_game_id = sp.id
          AND k.sport = 'tennis'
          AND (UPPER(k.ticker) LIKE 'KXWTAMATCH-%' OR UPPER(k.ticker) LIKE 'KXATPMATCH-%')
      `);

      const totalMatchCount = regularMatchCount + dateToleranceCount + sbMatchCount + ufcMatchCount + tennisMatchCount;

      if (totalMatchCount > 0) {
        logger.info({
          message: 'Kalshi markets matched to live games',
          matchedCount: totalMatchCount,
          regularMatches: regularMatchCount,
          dateToleranceMatches: dateToleranceCount,
          superBowlMatches: sbMatchCount,
          ufcMatches: ufcMatchCount,
          tennisMatches: tennisMatchCount,
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
