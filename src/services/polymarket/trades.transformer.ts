/**
 * Trades Transformer
 * Transforms stored trades to frontend format
 */

import { logger } from '../../config/logger';
import { transformToFrontendGame } from './frontend-game.transformer';
import { LiveGame } from './live-games.service';
import { StoredTrade, TransformedTrade } from './trades.types';

/**
 * Transform a single stored trade to frontend format
 */
export async function transformTrade(trade: StoredTrade, game: LiveGame): Promise<TransformedTrade> {
  try {
    // Get frontend game to extract team information
    const frontendGame = await transformToFrontendGame(game);

    // Map side to type
    const type: 'Buy' | 'Sell' = trade.side === 'BUY' ? 'Buy' : 'Sell';

    // Calculate amount (size * price)
    const amount = Number((trade.size * trade.price).toFixed(2));

    // Format time as ISO string
    const time = trade.createdAt.toISOString();

    // Always use proxyWallet - if it's null/empty, use empty string (never fall back to name)
    const trader = trade.proxyWallet || '';

    // Price multiplied by 100 (e.g., 0.21 -> 21)
    const price = Math.round(trade.price * 100);

    return {
      type,
      amount,
      shares: trade.size,
      price,
      trader,
      traderAvatar: '', // Empty for now
      outcome: trade.outcome || '',
      awayTeam: frontendGame.awayTeam,
      homeTeam: frontendGame.homeTeam,
      time,
    };
  } catch (error) {
    logger.error({
      message: 'Error transforming trade',
      tradeId: trade.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Transform multiple trades to frontend format
 */
export async function transformTrades(trades: StoredTrade[], game: LiveGame): Promise<TransformedTrade[]> {
  const results: TransformedTrade[] = [];

  for (const trade of trades) {
    try {
      const transformed = await transformTrade(trade, game);
      results.push(transformed);
    } catch (error) {
      logger.warn({
        message: 'Error transforming trade, skipping',
        tradeId: trade.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue with other trades
    }
  }

  return results;
}
