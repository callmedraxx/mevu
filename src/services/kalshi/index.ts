/**
 * Kalshi Services Barrel Export
 * Export all Kalshi-related services and types
 */

// Services
export { kalshiService } from './kalshi.service';
export { kalshiMatcherService } from './kalshi-matcher.service';
export { kalshiActivityService } from './kalshi-activity.service';
export { kalshiPriceUpdateService, getKalshiPriceUpdateService } from './kalshi-price-update.service';

// WebSocket client
export { getKalshiWebSocketClient, KalshiWebSocketClient } from './kalshi-websocket.client';
export type { KalshiTickerMessage } from './kalshi-websocket.client';

// Ticker mapper
export { getKalshiTickerMapper, KalshiTickerMapper } from './kalshi-ticker-mapper';
export type { TickerMapping } from './kalshi-ticker-mapper';

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

export type {
  KalshiPriceUpdate,
  KalshiPriceMessage,
} from './kalshi-price-update.service';

// Team normalizer
export {
  normalizeTeamName,
  extractTeamAbbreviation,
  parseTeamsFromTitle,
  teamsMatch,
} from './team-normalizer';
