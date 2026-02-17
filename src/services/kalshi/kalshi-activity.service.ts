/**
 * Kalshi Activity Service
 * Returns Kalshi market data formatted for activity widget
 * Matches the ActivityWatcherGame interface but with Kalshi prices
 */

import { connectWithRetry } from '../../config/database';
import { logger } from '../../config/logger';
import { FrontendTeam } from '../polymarket/frontend-game.transformer';
import { ActivityWatcherGame, ActivityWatcherMarket } from '../polymarket/activity-watcher.transformer';
import { getLiveGameBySlug } from '../polymarket/live-games.service';
import { transformToFrontendGame } from '../polymarket/frontend-game.transformer';

export interface KalshiActivityGame extends ActivityWatcherGame {
  // Additional Kalshi-specific fields
  kalshiTicker?: string;
  platform: 'kalshi';
}

class KalshiActivityService {
  /**
   * Get activity data for a game slug with Kalshi prices
   * @param slug - Game slug (e.g., "nba-lal-bos-2025-01-15")
   * @param includeDebug - When true, add _debug field with kalshiRowCount to response
   * @returns Activity game data with Kalshi prices, or null if not found
   */
  async getActivityForSlug(slug: string, includeDebug = false): Promise<KalshiActivityGame | null> {
    const nodeEnv = process.env.NODE_ENV || 'development';

    // First, get the live game
    const game = await getLiveGameBySlug(slug);
    if (!game) {
      return null;
    }

    // Transform to frontend format (for team data)
    const frontendGame = await transformToFrontendGame(game);

    // In non-production, return without Kalshi data
    if (nodeEnv !== 'production') {
      const result = this.buildActivityGame(frontendGame, []);
      if (includeDebug) (result as any)._debug = { kalshiRowCount: 0, reason: 'NODE_ENV!==production' };
      return result;
    }

    // Get ALL Kalshi markets for this game (moneyline, spread, total)
    // Use same status filter as getKalshiPricesForGames: active, open, unopened, initialized
    const client = await connectWithRetry();
    try {
      const result = await client.query(
        `
        SELECT
          km.ticker,
          km.title,
          km.yes_bid,
          km.yes_ask,
          km.no_bid,
          km.no_ask,
          km.volume,
          km.status
        FROM kalshi_markets km
        JOIN live_games lg ON km.live_game_id = lg.id
        WHERE LOWER(lg.slug) = LOWER($1)
          AND km.status IN ('active', 'open', 'unopened', 'initialized')
        ORDER BY km.ticker
        `,
        [slug]
      );

      if (result.rows.length === 0) {
        // No Kalshi market found - return game without Kalshi data
        const emptyResult = this.buildActivityGame(frontendGame, []);
        if (includeDebug) (emptyResult as any)._debug = { kalshiRowCount: 0, reason: 'query returned 0 rows' };
        return emptyResult;
      }

      const built = this.buildActivityGame(frontendGame, result.rows);
      if (includeDebug) (built as any)._debug = { kalshiRowCount: result.rows.length };
      return built;
    } catch (error) {
      logger.error({
        message: 'Error fetching Kalshi activity data',
        slug,
        error: error instanceof Error ? error.message : String(error),
      });
      // Return game without Kalshi data on error
      const errResult = this.buildActivityGame(frontendGame, []);
      if (includeDebug) (errResult as any)._debug = { kalshiRowCount: 0, reason: 'exception', error: error instanceof Error ? error.message : String(error) };
      return errResult;
    } finally {
      client.release();
    }
  }

  /**
   * Build activity game response with Kalshi data
   */
  private buildActivityGame(
    frontendGame: {
      id: string;
      slug?: string;
      sport?: string;
      league?: string;
      homeTeam: FrontendTeam;
      awayTeam: FrontendTeam;
    },
    kalshiRows: Array<{
      ticker: string;
      title: string;
      yes_bid: number;
      yes_ask: number;
      no_bid: number;
      no_ask: number;
      volume: number;
    }>
  ): KalshiActivityGame {
    // Build Kalshi-enhanced teams
    const homeTeam: FrontendTeam = {
      ...frontendGame.homeTeam,
    };

    const awayTeam: FrontendTeam = {
      ...frontendGame.awayTeam,
    };

    // Find moneyline market for team prices (ticker ends with team abbr like -HOU or -CHA)
    // The home team market has YES = home wins
    const homeAbbr = homeTeam.abbr?.toUpperCase();
    const awayAbbr = awayTeam.abbr?.toUpperCase();
    
    // Check if this is a single-market sport (tennis, UFC, mwoh) or multi-market sport (NBA, NFL, etc.)
    const isSingleMarketSport = kalshiRows.some(r => {
      const tickerUpper = r.ticker.toUpperCase();
      return tickerUpper.startsWith('KXWTAMATCH-') ||
             tickerUpper.startsWith('KXATPMATCH-') ||
             tickerUpper.startsWith('KXUFCFIGHT-') ||
             tickerUpper.startsWith('KXWOMHOCKEY-');
    });

    let homeMoneyline = null;
    let awayMoneyline = null;
    
    if (isSingleMarketSport) {
      // Tennis/UFC/mwoh: single market per match (YES = away wins, NO = home wins)
      // Use the same market for both teams, but invert prices for home team
      const singleMarket = kalshiRows.find(r => {
        const tickerUpper = r.ticker.toUpperCase();
        return tickerUpper.startsWith('KXWTAMATCH-') ||
               tickerUpper.startsWith('KXATPMATCH-') ||
               tickerUpper.startsWith('KXUFCFIGHT-') ||
               tickerUpper.startsWith('KXWOMHOCKEY-');
      });
      
      if (singleMarket) {
        // For single-market sports: YES = away wins, so away team gets YES prices
        awayMoneyline = singleMarket;
        // Home team gets NO prices (inverted)
        homeMoneyline = {
          ...singleMarket,
          // Swap YES/NO for home team
          yes_bid: singleMarket.no_bid ?? (100 - singleMarket.yes_ask),
          yes_ask: singleMarket.no_ask ?? (100 - singleMarket.yes_bid),
        };
      }
    } else {
      // Multi-market sports (NBA, NFL, etc.): separate markets per team
      homeMoneyline = kalshiRows.find(r =>
        r.ticker.includes('GAME-') && r.ticker.endsWith(`-${homeAbbr}`)
      );
      awayMoneyline = kalshiRows.find(r =>
        r.ticker.includes('GAME-') && r.ticker.endsWith(`-${awayAbbr}`)
      );
    }

    // Set team Kalshi prices from moneyline markets
    if (homeMoneyline) {
      homeTeam.kalshiBuyPrice = homeMoneyline.yes_ask;
      homeTeam.kalshiSellPrice = homeMoneyline.yes_bid;
    }
    if (awayMoneyline) {
      awayTeam.kalshiBuyPrice = awayMoneyline.yes_ask;
      awayTeam.kalshiSellPrice = awayMoneyline.yes_bid;
    }

    // Build markets: one per Kalshi row, with actual question and Yes/No outcomes (matching Kalshi)
    const markets: ActivityWatcherMarket[] = [];
    const marketGroups = this.groupMarketsByType(kalshiRows);

    // Single-market sports (tennis, UFC, mwoh): one market with Yes/No for away/home
    if (isSingleMarketSport && marketGroups.moneyline.length === 1) {
      const m = marketGroups.moneyline[0];
      markets.push(this.rowToYesNoMarket(m, 'Winner', m.title || 'Who will win?', [
        { label: 'Yes', kalshiOutcome: 'YES' as const, teamAbbr: awayAbbr },
        { label: 'No', kalshiOutcome: 'NO' as const, useNoPrices: true, teamAbbr: homeAbbr },
      ]));
    } else {
      // All other markets: one market per Kalshi row with Yes/No outcomes
      for (const row of kalshiRows) {
        const marketType = this.getMarketType(row.ticker);
        // Moneyline (GAME) only: add teamAbbr so frontend can show "Yes (CHA)" etc.
        const marketTeamAbbr = row.ticker.toUpperCase().includes('GAME-')
          ? this.extractTeamFromTicker(row.ticker)
          : undefined;
        markets.push(this.rowToYesNoMarket(row, marketType, row.title || 'Unknown', [
          { label: 'Yes', kalshiOutcome: 'YES' as const },
          { label: 'No', kalshiOutcome: 'NO' as const, useNoPrices: true },
        ], marketTeamAbbr));
      }
    }

    return {
      id: frontendGame.id,
      slug: frontendGame.slug,
      sport: frontendGame.sport,
      league: frontendGame.league,
      homeTeam,
      awayTeam,
      markets,
      kalshiTicker: kalshiRows[0]?.ticker,
      platform: 'kalshi',
    };
  }

  /**
   * Extract team abbr from GAME ticker suffix (e.g. KXNBAGAME-26FEB19HOUCHA-CHA -> CHA)
   */
  private extractTeamFromTicker(ticker: string): string | undefined {
    const match = ticker.match(/-([A-Z]{2,4})$/);
    return match ? match[1] : undefined;
  }

  /**
   * Convert a Kalshi row to one market with Yes/No outcomes (matches Kalshi display)
   */
  private rowToYesNoMarket(
    row: { ticker: string; title: string; yes_bid: number; yes_ask: number; no_bid: number; no_ask: number; volume: number },
    titleShort: string,
    question: string,
    outcomeSpecs: Array<{ label: string; kalshiOutcome: 'YES' | 'NO'; useNoPrices?: boolean; teamAbbr?: string }>,
    marketTeamAbbr?: string
  ): ActivityWatcherMarket {
    const outcomes = outcomeSpecs.map(spec => {
      const teamAbbr = spec.teamAbbr ?? marketTeamAbbr;
      const base = {
        label: spec.label,
        kalshiTicker: row.ticker,
        kalshiOutcome: spec.kalshiOutcome as 'YES' | 'NO',
        ...(teamAbbr && { teamAbbr }),
      };
      if (spec.useNoPrices) {
        return {
          ...base,
          price: row.no_ask,
          probability: row.no_ask,
          buyPrice: row.no_ask,
          sellPrice: row.no_bid,
        };
      }
      return {
        ...base,
        price: row.yes_ask,
        probability: row.yes_ask,
        buyPrice: row.yes_ask,
        sellPrice: row.yes_bid,
      };
    });
    return {
      id: row.ticker,
      title: titleShort,
      question,
      volume: this.formatVolume(Number(row.volume) || 0),
      liquidity: '$0',
      outcomes,
    };
  }

  /**
   * Derive short title from ticker type for grouping display
   */
  private getMarketType(ticker: string): string {
    const t = ticker.toUpperCase();
    if (t.includes('GAME-')) return 'Winner';
    if (t.includes('SPREAD')) return 'Spread';
    if (t.includes('TOTAL-') && !t.includes('TEAMTOTAL')) return 'Total Points';
    if (t.includes('TEAMTOTAL')) return 'Team Total';
    return 'Market';
  }

  /**
   * Group markets by type based on ticker pattern
   */
  private groupMarketsByType(rows: Array<{ ticker: string; title: string; yes_bid: number; yes_ask: number; no_bid: number; no_ask: number; volume: number }>) {
    const groups = {
      moneyline: [] as typeof rows,
      spread: [] as typeof rows,
      total: [] as typeof rows,
      teamTotal: [] as typeof rows,
      other: [] as typeof rows,
    };

    for (const row of rows) {
      const ticker = row.ticker.toUpperCase();
      
      // Moneyline markets: regular GAME markets, tennis MATCH markets, UFC FIGHT markets, mwoh HOCKEY markets
      if (ticker.includes('GAME-') ||
          ticker.startsWith('KXWTAMATCH-') ||
          ticker.startsWith('KXATPMATCH-') ||
          ticker.startsWith('KXUFCFIGHT-') ||
          ticker.startsWith('KXWOMHOCKEY-')) {
        groups.moneyline.push(row);
      } else if (ticker.includes('SPREAD-') || ticker.includes('SPREAD')) {
        groups.spread.push(row);
      } else if (ticker.includes('TEAMTOTAL-')) {
        groups.teamTotal.push(row);
      } else if (ticker.includes('TOTAL-') || ticker.includes('TOTAL')) {
        groups.total.push(row);
      } else {
        groups.other.push(row);
      }
    }

    return groups;
  }

  /**
   * Format volume for display
   * PostgreSQL returns numeric as string — coerce to number before toFixed
   */
  private formatVolume(value: number | string | null | undefined): string {
    const num = Number(value);
    if (value == null || value === undefined || isNaN(num)) {
      return '$0';
    }
    if (num >= 1000000) {
      return `$${(num / 1000000).toFixed(2)}M`;
    }
    if (num >= 1000) {
      return `$${(num / 1000).toFixed(1)}k`;
    }
    return `$${num.toFixed(0)}`;
  }

}

export const kalshiActivityService = new KalshiActivityService();
