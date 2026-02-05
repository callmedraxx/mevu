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
   * @returns Activity game data with Kalshi prices, or null if not found
   */
  async getActivityForSlug(slug: string): Promise<KalshiActivityGame | null> {
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
      return this.buildActivityGame(frontendGame, []);
    }

    // Get ALL Kalshi markets for this game (moneyline, spread, total)
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
          AND km.status = 'active'
        ORDER BY km.ticker
        `,
        [slug]
      );

      if (result.rows.length === 0) {
        // No Kalshi market found - return game without Kalshi data
        return this.buildActivityGame(frontendGame, []);
      }

      return this.buildActivityGame(frontendGame, result.rows);
    } catch (error) {
      logger.error({
        message: 'Error fetching Kalshi activity data',
        slug,
        error: error instanceof Error ? error.message : String(error),
      });
      // Return game without Kalshi data on error
      return this.buildActivityGame(frontendGame, []);
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

    const homeMoneyline = kalshiRows.find(r =>
      r.ticker.includes('GAME-') && r.ticker.endsWith(`-${homeAbbr}`)
    );
    const awayMoneyline = kalshiRows.find(r =>
      r.ticker.includes('GAME-') && r.ticker.endsWith(`-${awayAbbr}`)
    );

    // Set team Kalshi prices from moneyline markets
    if (homeMoneyline) {
      homeTeam.kalshiBuyPrice = homeMoneyline.yes_ask;
      homeTeam.kalshiSellPrice = homeMoneyline.yes_bid;
    }
    if (awayMoneyline) {
      awayTeam.kalshiBuyPrice = awayMoneyline.yes_ask;
      awayTeam.kalshiSellPrice = awayMoneyline.yes_bid;
    }

    // Build markets array - group by market type
    const markets: ActivityWatcherMarket[] = [];

    // Group markets by type based on ticker pattern
    const marketGroups = this.groupMarketsByType(kalshiRows);

    // Add moneyline market
    if (marketGroups.moneyline.length > 0) {
      const mlMarkets = marketGroups.moneyline;
      markets.push({
        id: 'moneyline',
        title: 'Winner',
        question: mlMarkets[0]?.title || 'Who will win?',
        volume: this.formatVolume(mlMarkets.reduce((sum, m) => sum + (m.volume || 0), 0)),
        liquidity: '$0',
        outcomes: mlMarkets.map(m => ({
          label: this.extractTeamFromTicker(m.ticker) || m.title,
          price: m.yes_ask,
          probability: m.yes_ask,
          buyPrice: m.yes_ask,
          sellPrice: m.yes_bid,
        })),
      });
    }

    // Add spread markets - group by point value and pair teams
    if (marketGroups.spread.length > 0) {
      const spreadMarkets = this.buildSpreadMarkets(marketGroups.spread, homeAbbr, awayAbbr);
      markets.push(...spreadMarkets);
    }

    // Add total markets - each total value becomes a market with Over/Under outcomes
    if (marketGroups.total.length > 0) {
      const totalMarkets = this.buildTotalMarkets(marketGroups.total);
      markets.push(...totalMarkets);
    }

    // Add team total markets
    if (marketGroups.teamTotal.length > 0) {
      markets.push({
        id: 'teamTotal',
        title: 'Team Totals',
        question: 'Team Total Points',
        volume: this.formatVolume(marketGroups.teamTotal.reduce((sum, m) => sum + (m.volume || 0), 0)),
        liquidity: '$0',
        outcomes: marketGroups.teamTotal.map(m => ({
          label: m.title,
          price: m.yes_ask,
          probability: m.yes_ask,
          buyPrice: m.yes_ask,
          sellPrice: m.yes_bid,
        })),
      });
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
      if (ticker.includes('GAME-')) {
        groups.moneyline.push(row);
      } else if (ticker.includes('SPREAD-')) {
        groups.spread.push(row);
      } else if (ticker.includes('TEAMTOTAL-')) {
        groups.teamTotal.push(row);
      } else if (ticker.includes('TOTAL-')) {
        groups.total.push(row);
      } else {
        groups.other.push(row);
      }
    }

    return groups;
  }

  /**
   * Extract team name/abbr from ticker
   */
  private extractTeamFromTicker(ticker: string): string {
    const match = ticker.match(/-([A-Z]{2,4})$/);
    return match ? match[1] : '';
  }

  /**
   * Extract point value from spread title (e.g., "Houston wins by over 3.5 Points?" -> 3.5)
   */
  private extractSpreadPoints(title: string): number | null {
    const match = title.match(/wins by over (\d+\.?\d*) Points/i);
    return match ? parseFloat(match[1]) : null;
  }

  /**
   * Extract team name from spread title (e.g., "Houston wins by over 3.5 Points?" -> "Houston")
   */
  private extractTeamFromSpreadTitle(title: string): string | null {
    const match = title.match(/^(\w+) wins by over/i);
    return match ? match[1] : null;
  }

  /**
   * Extract total value from ticker (e.g., "KXNBATOTAL-26FEB05CHAHOU-220" -> 220.5)
   */
  private extractTotalFromTicker(ticker: string): number | null {
    const match = ticker.match(/-(\d+)$/);
    return match ? parseFloat(match[1]) + 0.5 : null;
  }

  /**
   * Format volume for display
   */
  private formatVolume(value: number | null | undefined): string {
    if (value == null || isNaN(value)) {
      return '$0';
    }
    if (value >= 1000000) {
      return `$${(value / 1000000).toFixed(2)}M`;
    }
    if (value >= 1000) {
      return `$${(value / 1000).toFixed(1)}k`;
    }
    return `$${value.toFixed(0)}`;
  }

  /**
   * Build spread markets grouped by point value with paired team outcomes
   * For each spread value (e.g., 3.5), creates a market with:
   * - Away team +X.5 (underdog covering)
   * - Home team -X.5 (favorite covering)
   */
  private buildSpreadMarkets(
    spreadRows: Array<{ ticker: string; title: string; yes_bid: number; yes_ask: number; no_bid: number; no_ask: number; volume: number }>,
    homeAbbr: string | undefined,
    awayAbbr: string | undefined
  ): ActivityWatcherMarket[] {
    // Group spread markets by point value
    const spreadByPoints = new Map<number, typeof spreadRows>();
    
    for (const row of spreadRows) {
      const points = this.extractSpreadPoints(row.title);
      if (points !== null) {
        const existing = spreadByPoints.get(points) || [];
        existing.push(row);
        spreadByPoints.set(points, existing);
      }
    }

    // Sort by point value (ascending) and create markets
    const sortedPoints = Array.from(spreadByPoints.keys()).sort((a, b) => a - b);
    const markets: ActivityWatcherMarket[] = [];

    for (const points of sortedPoints) {
      const rows = spreadByPoints.get(points) || [];
      
      // Find home and away team spread markets for this point value
      let homeSpread: typeof rows[0] | undefined;
      let awaySpread: typeof rows[0] | undefined;
      
      for (const row of rows) {
        const teamName = this.extractTeamFromSpreadTitle(row.title);
        if (!teamName) continue;
        
        const teamNameUpper = teamName.toUpperCase();
        // Match by abbreviation in title or ticker
        if (homeAbbr && (teamNameUpper.includes(homeAbbr) || row.ticker.toUpperCase().includes(`-${homeAbbr}`))) {
          homeSpread = row;
        } else if (awayAbbr && (teamNameUpper.includes(awayAbbr) || row.ticker.toUpperCase().includes(`-${awayAbbr}`))) {
          awaySpread = row;
        } else {
          // Fallback: first unassigned goes to away, second to home
          if (!awaySpread) {
            awaySpread = row;
          } else if (!homeSpread) {
            homeSpread = row;
          }
        }
      }

      // Create market with both outcomes
      // Away team gets "+" (they need to win or lose by less than X)
      // Home team gets "-" (they need to win by more than X)
      const outcomes = [];
      
      if (awaySpread) {
        const awayTeamName = this.extractTeamFromSpreadTitle(awaySpread.title) || awayAbbr || 'Away';
        outcomes.push({
          label: `${awayTeamName} +${points}`,
          price: awaySpread.yes_ask,
          probability: awaySpread.yes_ask,
          buyPrice: awaySpread.yes_ask,
          sellPrice: awaySpread.yes_bid,
        });
      }
      
      if (homeSpread) {
        const homeTeamName = this.extractTeamFromSpreadTitle(homeSpread.title) || homeAbbr || 'Home';
        outcomes.push({
          label: `${homeTeamName} -${points}`,
          price: homeSpread.yes_ask,
          probability: homeSpread.yes_ask,
          buyPrice: homeSpread.yes_ask,
          sellPrice: homeSpread.yes_bid,
        });
      }

      // Only add market if we have at least one outcome
      if (outcomes.length > 0) {
        const totalVolume = rows.reduce((sum, m) => sum + (m.volume || 0), 0);
        markets.push({
          id: `spread-${points}`,
          title: 'Spread',
          question: `Point Spread ${points}`,
          volume: this.formatVolume(totalVolume),
          liquidity: '$0',
          outcomes,
        });
      }
    }

    return markets;
  }

  /**
   * Build total markets with Over/Under outcomes
   * For each total value (e.g., 217.5), creates a market with:
   * - Over X.5 (Yes side)
   * - Under X.5 (No side)
   */
  private buildTotalMarkets(
    totalRows: Array<{ ticker: string; title: string; yes_bid: number; yes_ask: number; no_bid: number; no_ask: number; volume: number }>
  ): ActivityWatcherMarket[] {
    // Sort by total value (ascending)
    const sortedRows = [...totalRows].sort((a, b) => {
      const totalA = this.extractTotalFromTicker(a.ticker) || 0;
      const totalB = this.extractTotalFromTicker(b.ticker) || 0;
      return totalA - totalB;
    });

    const markets: ActivityWatcherMarket[] = [];

    for (const row of sortedRows) {
      const totalValue = this.extractTotalFromTicker(row.ticker);
      if (totalValue === null) continue;

      markets.push({
        id: `total-${totalValue}`,
        title: 'Total Points',
        question: `Total Points ${totalValue}`,
        volume: this.formatVolume(row.volume || 0),
        liquidity: '$0',
        outcomes: [
          {
            label: `Over ${totalValue}`,
            price: row.yes_ask,
            probability: row.yes_ask,
            buyPrice: row.yes_ask,
            sellPrice: row.yes_bid,
          },
          {
            label: `Under ${totalValue}`,
            price: row.no_ask,
            probability: row.no_ask,
            buyPrice: row.no_ask,
            sellPrice: row.no_bid,
          },
        ],
      });
    }

    return markets;
  }
}

export const kalshiActivityService = new KalshiActivityService();
