/**
 * Kalshi Services Barrel Export
 * Export all Kalshi-related services and types
 */

// Services
export { kalshiService } from './kalshi.service';
export { kalshiMatcherService } from './kalshi-matcher.service';
export { kalshiActivityService } from './kalshi-activity.service';

// Client
export { fetchKalshiMarkets, fetchAllMarketsForSeries } from './kalshi.client';

// Config
export {
  KALSHI_SPORT_SERIES,
  getSportFromKalshiSeries,
  getSupportedKalshiSports,
  isKalshiSportSupported,
} from './kalshi.config';

// Types
export type {
  KalshiMarket,
  KalshiMarketsResponse,
  StoredKalshiMarket,
  KalshiPrices,
  KalshiMarketRow,
} from './kalshi.types';

// Team normalizer
export {
  normalizeTeamName,
  extractTeamAbbreviation,
  parseTeamsFromTitle,
  teamsMatch,
} from './team-normalizer';
