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
 * Match trade outcome to home or away team
 * Returns 'home', 'away', or null if unable to determine
 */
function matchTradeOutcomeToTeam(
  tradeOutcome: string | null,
  game: LiveGame
): 'home' | 'away' | null {
  if (!tradeOutcome) return null;

  const normalizedOutcome = tradeOutcome.toLowerCase().trim();

  // Get team identifiers
  const homeTeamName = game.homeTeam?.name?.toLowerCase() || game.teamIdentifiers?.home?.toLowerCase() || '';
  const awayTeamName = game.awayTeam?.name?.toLowerCase() || game.teamIdentifiers?.away?.toLowerCase() || '';
  const homeAbbr = game.homeTeam?.abbreviation?.toLowerCase() || '';
  const awayAbbr = game.awayTeam?.abbreviation?.toLowerCase() || '';

  // Try to find moneyline market to get outcome labels
  if (!game.markets || game.markets.length === 0) {
    // Fallback: try direct name/abbreviation matching
    if (homeTeamName && (normalizedOutcome.includes(homeTeamName) || homeTeamName.includes(normalizedOutcome))) {
      return 'home';
    }
    if (awayTeamName && (normalizedOutcome.includes(awayTeamName) || awayTeamName.includes(normalizedOutcome))) {
      return 'away';
    }
    if (homeAbbr && normalizedOutcome === homeAbbr) {
      return 'home';
    }
    if (awayAbbr && normalizedOutcome === awayAbbr) {
      return 'away';
    }
    return null;
  }

  // Look for moneyline market (team vs team market)
  for (const market of game.markets) {
    // Skip Over/Under markets
    const question = (market.question || '').toLowerCase();
    if (question.includes('over') || question.includes('under') || question.includes('o/u')) {
      continue;
    }

    // Get outcomes from market
    let outcomes: any[] = [];
    
    if (market.outcomes && Array.isArray(market.outcomes)) {
      // Use raw outcomes
      outcomes = market.outcomes.map((label: string, i: number) => ({
        label: String(label || ''),
        price: market.outcomePrices?.[i] ? parseFloat(String(market.outcomePrices[i])) * 100 : 50,
      }));
    } else if (market.structuredOutcomes) {
      // Use structured outcomes
      outcomes = market.structuredOutcomes.map((o: any) => ({
        label: String(o.label || ''),
        price: parseFloat(String(o.price || '50')),
      }));
    }

    if (outcomes.length !== 2) continue;

    // Check if outcomes contain "yes"/"no" (binary market, not team market)
    const labels = outcomes.map((o: any) => String(o.label || '').toLowerCase());
    if (labels.some(l => l === 'yes' || l === 'no')) {
      continue;
    }

    // Try to match trade outcome to one of the market outcomes
    for (const outcome of outcomes) {
      const outcomeLabel = String(outcome.label || '').toLowerCase();
      
      // Exact match
      if (outcomeLabel === normalizedOutcome) {
        // Determine if this outcome is home or away
        if (homeTeamName && (outcomeLabel.includes(homeTeamName) || homeTeamName.includes(outcomeLabel))) {
          return 'home';
        }
        if (awayTeamName && (outcomeLabel.includes(awayTeamName) || awayTeamName.includes(outcomeLabel))) {
          return 'away';
        }
        if (homeAbbr && outcomeLabel === homeAbbr) {
          return 'home';
        }
        if (awayAbbr && outcomeLabel === awayAbbr) {
          return 'away';
        }
      }
      
      // Partial match
      if (outcomeLabel.includes(normalizedOutcome) || normalizedOutcome.includes(outcomeLabel)) {
        if (homeTeamName && (outcomeLabel.includes(homeTeamName) || homeTeamName.includes(outcomeLabel))) {
          return 'home';
        }
        if (awayTeamName && (outcomeLabel.includes(awayTeamName) || awayTeamName.includes(outcomeLabel))) {
          return 'away';
        }
      }
    }

    // If trade outcome matches one of the market outcomes directly, try to determine team
    // by matching the outcome label to team names/abbreviations
    for (const outcome of outcomes) {
      const outcomeLabel = String(outcome.label || '').toLowerCase();
      
      if (outcomeLabel === normalizedOutcome || 
          outcomeLabel.includes(normalizedOutcome) || 
          normalizedOutcome.includes(outcomeLabel)) {
        // Match outcome label to home team
        if (homeTeamName && (outcomeLabel.includes(homeTeamName) || homeTeamName.includes(outcomeLabel))) {
          return 'home';
        }
        if (homeAbbr && (outcomeLabel === homeAbbr || outcomeLabel.includes(homeAbbr) || homeAbbr.includes(outcomeLabel))) {
          return 'home';
        }
        
        // Match outcome label to away team
        if (awayTeamName && (outcomeLabel.includes(awayTeamName) || awayTeamName.includes(outcomeLabel))) {
          return 'away';
        }
        if (awayAbbr && (outcomeLabel === awayAbbr || outcomeLabel.includes(awayAbbr) || awayAbbr.includes(outcomeLabel))) {
          return 'away';
        }
      }
    }
  }

  // Final fallback: direct name/abbreviation matching
  if (homeTeamName && (normalizedOutcome.includes(homeTeamName) || homeTeamName.includes(normalizedOutcome))) {
    return 'home';
  }
  if (awayTeamName && (normalizedOutcome.includes(awayTeamName) || awayTeamName.includes(normalizedOutcome))) {
    return 'away';
  }
  if (homeAbbr && normalizedOutcome === homeAbbr) {
    return 'home';
  }
  if (awayAbbr && normalizedOutcome === awayAbbr) {
    return 'away';
  }

  return null;
}

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

    // Match trade outcome to determine which team this trade was for
    const teamFor = matchTradeOutcomeToTeam(trade.outcome, game);

    return {
      id: String(trade.id),
      trader,
      type,
      team: {
        homeTeam: frontendGame.homeTeam,
        awayTeam: frontendGame.awayTeam,
      },
      teamFor,
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
