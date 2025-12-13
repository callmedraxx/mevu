/**
 * Whale Trades Transformer
 * Transforms stored trades to whale trade format (amount >= $1000)
 */

import { logger } from '../../config/logger';
import { transformToFrontendGame } from './frontend-game.transformer';
import { LiveGame } from './live-games.service';
import { StoredTrade } from './trades.types';
import { WhaleTrade } from './whale-trades.types';

/**
 * Transform a single stored trade to whale trade format
 */
export async function transformWhaleTrade(trade: StoredTrade, game: LiveGame): Promise<WhaleTrade> {
  try {
    // Get frontend game to extract team information
    const frontendGame = await transformToFrontendGame(game);

    // Map side to lowercase type
    const type: 'buy' | 'sell' = trade.side === 'BUY' ? 'buy' : 'sell';

    // Calculate amount (size * price)
    const amount = Number((trade.size * trade.price).toFixed(2));

    // Format time as ISO string
    const time = trade.createdAt.toISOString();

    // Always use proxyWallet - if it's null/empty, use empty string
    const trader = trade.proxyWallet || '';

    // Price multiplied by 100 (e.g., 0.21 -> 21)
    const price = Math.round(trade.price * 100);

    return {
      id: String(trade.id),
      trader,
      type,
      team: {
        homeTeam: frontendGame.homeTeam,
        awayTeam: frontendGame.awayTeam,
      },
      amount,
      price,
      time,
      shares: trade.size,
    };
  } catch (error) {
    logger.error({
      message: 'Error transforming whale trade',
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Transform multiple trades to whale trade format
 */
export async function transformWhaleTrades(trades: StoredTrade[], game: LiveGame): Promise<WhaleTrade[]> {
  const results: WhaleTrade[] = [];

  for (const trade of trades) {
    try {
      const transformed = await transformWhaleTrade(trade, game);
      results.push(transformed);
    } catch (error) {
      logger.warn({
        message: 'Error transforming whale trade, skipping',
        tradeId: trade.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue with other trades
    }
  }

  return results;
}
