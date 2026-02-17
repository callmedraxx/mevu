import { logger } from '../../config/logger';
import { FrontendTeam, transformToFrontendGame } from './frontend-game.transformer';
import { LiveGame } from './live-games.service';
import { TransformedMarket, TransformedOutcome } from './polymarket.types';

export interface ActivityWatcherOutcome {
  label: string;
  shortLabel?: string;
  price: number;
  probability: number;
  buyPrice?: number; // Best ask price for buying this outcome
  sellPrice?: number; // Best bid price for selling this outcome
  // Trading fields (Polymarket)
  clobTokenId?: string; // Required for executing trades
  // Trading fields (Kalshi)
  kalshiTicker?: string; // Kalshi market ticker for this outcome
  kalshiOutcome?: 'YES' | 'NO'; // Kalshi side for this outcome
  /** Kalshi moneyline only: team abbr from ticker (e.g. CHA, HOU) so frontend can show "Yes (CHA)" */
  teamAbbr?: string;
}

export interface ActivityWatcherMarket {
  id: string;
  title: string;
  question: string; // Full market question for trading context
  volume: string;
  liquidity: string;
  outcomes: ActivityWatcherOutcome[];
  // Trading fields
  conditionId?: string; // Market condition ID for trading contract
  clobTokenIds?: string[]; // Token IDs for all outcomes
  negRisk?: boolean; // If true, uses negative risk trading
  negRiskMarketId?: string; // Negative risk market ID (required if negRisk is true)
}

export interface ActivityWatcherGame {
  id: string;
  slug?: string;
  sport?: string;
  league?: string;
  homeTeam: FrontendTeam;
  awayTeam: FrontendTeam;
  markets: ActivityWatcherMarket[];
}

function formatCurrency(value: number | string | undefined | null): string {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return '$0';

  if (numeric >= 1000000) {
    return `$${(numeric / 1000000).toFixed(2)}M`;
  }
  if (numeric >= 1000) {
    return `$${(numeric / 1000).toFixed(1)}k`;
  }
  return `$${numeric.toFixed(0)}`;
}

function deriveProbability(outcome: TransformedOutcome): number {
  // Use probability if available
  if (outcome.probability !== undefined && outcome.probability !== null) {
    return Number(outcome.probability.toFixed(2));
  }

  // Fall back to price if probability not available
  if (outcome.price !== undefined && outcome.price !== null) {
    const price = Number(outcome.price);
    if (Number.isFinite(price)) {
      return Number(price.toFixed(2));
    }
  }

  return 0;
}

function transformOutcome(outcome: TransformedOutcome): ActivityWatcherOutcome {
  const probability = deriveProbability(outcome);
  const price = Number(outcome.price || probability);
  
  // buyPrice from best_ask (what you pay to BUY)
  const buyPrice = outcome.buyPrice !== undefined ? Number(outcome.buyPrice) : undefined;
  // sellPrice from best_bid (what you GET when you SELL)
  // Use actual sellPrice from outcome if available, otherwise fallback to 100 - buyPrice
  let sellPrice: number | undefined;
  if (outcome.sellPrice !== undefined) {
    sellPrice = Number(outcome.sellPrice);
  } else if (buyPrice !== undefined) {
    sellPrice = Math.ceil(100 - buyPrice); // fallback
  }

  return {
    label: outcome.label || 'Unknown',
    shortLabel: outcome.shortLabel,
    price: Number(price.toFixed(2)),
    probability,
    buyPrice,
    sellPrice,
    // Trading fields
    clobTokenId: outcome.clobTokenId,
  };
}

function simplifyMarket(market: TransformedMarket): ActivityWatcherMarket | null {
  if (!market.structuredOutcomes || market.structuredOutcomes.length === 0) {
    logger.warn({
      message: 'Market has no structured outcomes',
      marketId: market.id,
    });
    return null;
  }

  try {
    const outcomes = market.structuredOutcomes.map(transformOutcome);

    return {
      id: market.id,
      title: market.question || market.slug || market.id,
      question: market.question || market.slug || market.id,
      volume: formatCurrency(market.volume || market.volume24Hr || 0),
      liquidity: formatCurrency(market.liquidity ?? 0),
      outcomes,
      // Trading fields
      conditionId: market.conditionId,
      clobTokenIds: market.clobTokenIds,
      negRisk: market.negRisk,
      negRiskMarketId: market.negRiskMarketId,
    };
  } catch (error) {
    logger.warn({
      message: 'Failed to simplify market for activity watcher',
      marketId: market.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function transformToActivityWatcherGame(game: LiveGame): Promise<ActivityWatcherGame> {
  const frontendGame = await transformToFrontendGame(game);
  const markets = (game.markets || [])
    .map(simplifyMarket)
    .filter((m): m is ActivityWatcherMarket => m !== null);

  return {
    id: game.id,
    slug: game.slug,
    sport: game.sport,
    league: game.league,
    homeTeam: frontendGame.homeTeam,
    awayTeam: frontendGame.awayTeam,
    markets,
  };
}
