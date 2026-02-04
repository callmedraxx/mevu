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
      return this.buildActivityGame(frontendGame, null);
    }

    // Get Kalshi data for this game
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
          AND km.status = 'open'
        LIMIT 1
        `,
        [slug]
      );

      if (result.rows.length === 0) {
        // No Kalshi market found - return game without Kalshi data
        return this.buildActivityGame(frontendGame, null);
      }

      const kalshiRow = result.rows[0];
      return this.buildActivityGame(frontendGame, kalshiRow);
    } catch (error) {
      logger.error({
        message: 'Error fetching Kalshi activity data',
        slug,
        error: error instanceof Error ? error.message : String(error),
      });
      // Return game without Kalshi data on error
      return this.buildActivityGame(frontendGame, null);
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
    kalshiRow: {
      ticker: string;
      title: string;
      yes_bid: number;
      yes_ask: number;
      no_bid: number;
      no_ask: number;
      volume: number;
    } | null
  ): KalshiActivityGame {
    // Build Kalshi-enhanced teams
    const homeTeam: FrontendTeam = {
      ...frontendGame.homeTeam,
    };

    const awayTeam: FrontendTeam = {
      ...frontendGame.awayTeam,
    };

    // If we have Kalshi data, add the prices
    // Kalshi YES = away team wins, NO = home team wins
    if (kalshiRow) {
      awayTeam.kalshiBuyPrice = kalshiRow.yes_ask; // Buy YES for away
      awayTeam.kalshiSellPrice = kalshiRow.yes_bid; // Sell YES for away
      homeTeam.kalshiBuyPrice = kalshiRow.no_ask; // Buy NO for home
      homeTeam.kalshiSellPrice = kalshiRow.no_bid; // Sell NO for home
    }

    // Build Kalshi market representation
    const markets: ActivityWatcherMarket[] = [];

    if (kalshiRow) {
      const kalshiMarket: ActivityWatcherMarket = {
        id: kalshiRow.ticker,
        title: kalshiRow.title,
        question: kalshiRow.title,
        volume: this.formatVolume(kalshiRow.volume),
        liquidity: '$0', // Kalshi doesn't expose liquidity the same way
        outcomes: [
          {
            label: awayTeam.name,
            price: kalshiRow.yes_ask,
            probability: kalshiRow.yes_ask, // Use ask as probability approximation
            buyPrice: kalshiRow.yes_ask,
            sellPrice: kalshiRow.yes_bid,
          },
          {
            label: homeTeam.name,
            price: kalshiRow.no_ask,
            probability: kalshiRow.no_ask,
            buyPrice: kalshiRow.no_ask,
            sellPrice: kalshiRow.no_bid,
          },
        ],
      };
      markets.push(kalshiMarket);
    }

    return {
      id: frontendGame.id,
      slug: frontendGame.slug,
      sport: frontendGame.sport,
      league: frontendGame.league,
      homeTeam,
      awayTeam,
      markets,
      kalshiTicker: kalshiRow?.ticker,
      platform: 'kalshi',
    };
  }

  /**
   * Format volume for display
   */
  private formatVolume(value: number): string {
    if (value >= 1000000) {
      return `$${(value / 1000000).toFixed(2)}M`;
    }
    if (value >= 1000) {
      return `$${(value / 1000).toFixed(1)}k`;
    }
    return `$${value.toFixed(0)}`;
  }
}

export const kalshiActivityService = new KalshiActivityService();
