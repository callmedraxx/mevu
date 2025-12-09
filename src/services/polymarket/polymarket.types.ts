/**
 * TypeScript interfaces for Polymarket Gamma API responses and transformed data
 */

/**
 * Raw API response types from Polymarket Gamma API
 */
export interface PolymarketMarket {
  id: string;
  question: string;
  conditionId?: string;
  slug?: string;
  resolutionSource?: string;
  endDate?: string;
  startDate?: string;
  image?: string;
  icon?: string;
  description?: string;
  outcomes?: string[];
  outcomePrices?: string[];
  volume?: string | number;
  volumeNum?: number;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  marketMakerAddress?: string;
  createdAt?: string;
  updatedAt?: string;
  closedTime?: string;
  new?: boolean;
  featured?: boolean;
  submitted_by?: string;
  resolvedBy?: string;
  restricted?: boolean;
  groupItemTitle?: string;
  groupItemThreshold?: string;
  questionID?: string;
  umaEndDate?: string;
  enableOrderBook?: boolean;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  umaResolutionStatus?: string;
  endDateIso?: string;
  startDateIso?: string;
  hasReviewedDates?: boolean;
  volume1wk?: number;
  volume1mo?: number;
  volume1yr?: number;
  volume24hr?: number;
  clobTokenIds?: string[];
  umaBond?: string;
  umaReward?: string;
  volume1wkClob?: number;
  volume1moClob?: number;
  volume1yrClob?: number;
  volumeClob?: number;
  acceptingOrders?: boolean;
  negRisk?: boolean;
  negRiskRequestID?: string;
  ready?: boolean;
  funded?: boolean;
  acceptingOrdersTimestamp?: string;
  cyom?: boolean;
  pagerDutyNotificationEnabled?: boolean;
  approved?: boolean;
  clobRewards?: any[];
  rewardsMinSize?: number;
  rewardsMaxSpread?: number;
  spread?: number;
  automaticallyResolved?: boolean;
  oneDayPriceChange?: number;
  oneWeekPriceChange?: number;
  oneMonthPriceChange?: number;
  lastTradePrice?: number;
  bestBid?: number;
  bestAsk?: number;
  automaticallyActive?: boolean;
  clearBookOnStart?: boolean;
  seriesColor?: string;
  showGmpSeries?: boolean;
  showGmpOutcome?: boolean;
  manualActivation?: boolean;
  negRiskOther?: boolean;
  umaResolutionStatuses?: string[];
  pendingDeployment?: boolean;
  deploying?: boolean;
  deployingTimestamp?: string;
  rfqEnabled?: boolean;
  holdingRewardsEnabled?: boolean;
  feesEnabled?: boolean;
  competitive?: number;
  liquidity?: string | number;
  liquidityNum?: number;
  openInterest?: number;
  volume24hrAmm?: number;
  volume1wkAmm?: number;
  volume1moAmm?: number;
  volume1yrAmm?: number;
  volumeAmm?: number;
  liquidityAmm?: number;
  liquidityClob?: number;
  customLiveness?: number;
  negRiskMarketID?: string;
}

export interface PolymarketTag {
  id: string;
  label: string;
  slug: string;
  forceShow?: boolean;
  createdAt?: string;
  publishedAt?: string;
  createdBy?: number;
  updatedBy?: number;
  updatedAt?: string;
  isCarousel?: boolean;
}

export interface PolymarketEvent {
  id: string;
  ticker?: string;
  slug: string;
  title: string;
  description?: string;
  resolutionSource?: string;
  startDate?: string;
  creationDate?: string;
  endDate?: string;
  image?: string;
  icon?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  new?: boolean;
  featured?: boolean;
  restricted?: boolean;
  liquidity?: string | number;
  volume?: string | number;
  openInterest?: number;
  createdAt?: string;
  updatedAt?: string;
  competitive?: number;
  volume24hr?: number;
  volume1wk?: number;
  volume1mo?: number;
  volume1yr?: number;
  enableOrderBook?: boolean;
  liquidityClob?: number;
  negRisk?: boolean;
  commentCount?: number;
  markets?: PolymarketMarket[];
  tags?: PolymarketTag[];
  cyom?: boolean;
  showAllOutcomes?: boolean;
  showMarketImages?: boolean;
  enableNegRisk?: boolean;
  automaticallyActive?: boolean;
  startTime?: string;
  gmpChartMode?: string;
  negRiskAugmented?: boolean;
  countryName?: string;
  electionType?: string;
  pendingDeployment?: boolean;
  deploying?: boolean;
  deployingTimestamp?: string;
}

export interface PolymarketPagination {
  hasMore: boolean;
  totalResults: number;
}

export interface PolymarketApiResponse {
  data: PolymarketEvent[];
  pagination?: PolymarketPagination;
}

/**
 * Transformed data types for frontend
 */
export interface TransformedOutcome {
  label: string;
  shortLabel: string;
  price: string; // Price in cents, e.g., "18.5"
  probability: number; // 0-100
  volume: number; // Individual outcome volume
  icon?: string; // Outcome image
  clobTokenId?: string; // For trading
  conditionId?: string;
  groupItemThreshold?: string; // Threshold for group items
  isWinner?: boolean; // True if this outcome won (for resolved markets)
}

export interface TransformedMarket {
  id: string;
  question: string;
  slug?: string;
  conditionId?: string;
  volume: number;
  volume24Hr?: number;
  volume1Wk?: number;
  volume1Mo?: number;
  volume1Yr?: number;
  active: boolean;
  closed: boolean;
  archived: boolean;
  image?: string;
  icon?: string;
  description?: string;
  outcomes?: string[]; // Deprecated: use structuredOutcomes instead
  outcomePrices?: string[]; // Deprecated: use structuredOutcomes instead
  structuredOutcomes?: TransformedOutcome[]; // Structured outcomes array
  isGroupItem?: boolean; // Indicates if this is part of a group
  groupItemTitle?: string;
  groupItemThreshold?: string;
  clobTokenIds?: string[]; // Token IDs for trading
  endDate?: string;
  startDate?: string;
  lastTradePrice?: number;
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  competitive?: number;
  liquidity?: number;
  createdAt?: string;
  updatedAt?: string;
  // Resolution fields (for resolved markets)
  closedTime?: string;
  resolvedBy?: string;
  resolutionSource?: string;
  umaResolutionStatus?: string;
  automaticallyResolved?: boolean;
}

export interface TransformedEvent {
  id: string;
  title: string;
  slug: string;
  description?: string;
  image?: string;
  icon?: string;
  totalVolume: number;
  volume24Hr: number;
  volume1Wk?: number;
  volume1Mo?: number;
  volume1Yr?: number;
  liquidity?: number;
  openInterest?: number;
  competitive?: number;
  active: boolean;
  closed: boolean;
  archived: boolean;
  restricted?: boolean;
  featured?: boolean;
  commentCount?: number;
  markets: TransformedMarket[];
  tags?: TransformedTag[];
  startDate?: string;
  endDate?: string;
  createdAt?: string;
  updatedAt?: string;
  hasGroupItems?: boolean; // Indicates if event has group items
  groupedOutcomes?: TransformedOutcome[]; // Aggregated outcomes from group items or best market
  // Resolution fields (for resolved events)
  closedTime?: string;
  isResolved?: boolean; // Computed: true if event or all markets are resolved
}

export interface TransformedTag {
  id: string;
  label: string;
  slug: string;
}

export interface TransformedPagination {
  hasMore: boolean;
  totalResults: number;
  offset: number;
  limit: number;
}

export interface TransformedEventsResponse {
  events: TransformedEvent[];
  pagination: TransformedPagination;
}

/**
 * API request parameters
 */
export type Category = 'trending' | 'politics' | 'crypto' | 'finance' | 'sports';

export type OrderBy = 'volume24hr' | 'volume' | 'featuredOrder';

export interface EventsQueryParams {
  category?: Category;
  limit?: number;
  offset?: number;
  order?: OrderBy;
  tag_slug?: string;
  tag_id?: string;
  active?: boolean;
  archived?: boolean;
  closed?: boolean;
  ascending?: boolean;
  end_date_min?: string;
  // Additional filters from search endpoint
  events_status?: EventsStatus; // "active" or "resolved"
  sort?: SearchSort; // All sort options from search
  recurrence?: Recurrence; // "daily", "weekly", or "monthly"
}

/**
 * Endpoint configuration
 */
export interface EndpointConfig {
  path: string;
  params: Record<string, string | number | boolean | undefined>;
  pollingPath?: string;
  pollingParams?: Record<string, string | number | boolean | undefined>;
  pollingInterval?: number;
}

/**
 * Search query parameters
 */
export type SearchSort = 'volume_24hr' | 'end_date' | 'start_date' | 'volume' | 'liquidity' | 'closed_time' | 'competitive';
export type SearchType = 'events' | 'markets';
export type EventsStatus = 'active' | 'resolved';
export type Recurrence = 'daily' | 'weekly' | 'monthly';

export interface SearchQueryParams {
  q?: string; // Search query string (optional if tag_slug or recurrence is provided)
  page?: number; // Pagination page number (default: 1)
  limit_per_type?: number; // Results per type (default: 20)
  type?: SearchType; // Search type - "events" (default) or "markets"
  events_status?: EventsStatus; // "active" (default) or "resolved"
  sort?: SearchSort; // Sort option (default: "volume_24hr")
  ascending?: boolean; // Sort direction (default: false)
  presets?: string[]; // Preset filters (EventsTitle, Events)
  recurrence?: Recurrence; // Recurrence filter: "daily", "weekly", or "monthly"
  tag_slug?: string; // Category filter (e.g., "politics", "crypto", "sports")
}

/**
 * Search API response from Polymarket
 */
export interface SearchApiResponse {
  events: PolymarketEvent[];
  pagination: {
    hasMore: boolean;
    totalResults: number;
  };
}

/**
 * Market Clarification types
 */
export interface MarketClarification {
  id?: string;
  marketId?: string;
  text?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: any; // Allow for additional fields from API
}

/**
 * Raw API response for market clarifications (array of clarifications)
 */
export type MarketClarificationsResponse = MarketClarification[];

/**
 * Result for a single market's clarifications request
 */
export interface MarketClarificationResult {
  marketId: string;
  clarifications: MarketClarification[];
  status: 'success' | 'error';
  error?: string;
}

/**
 * Response format for multiple market clarifications
 */
export interface MarketClarificationsResults {
  results: MarketClarificationResult[];
}

/**
 * Price History types for CLOB API
 */
export type PriceHistoryInterval = '1h' | '6h' | '1d' | '1w' | '1m';

export interface PriceHistoryQueryParams {
  clobTokenId: string;
  startDate?: string; // ISO date string
  interval?: PriceHistoryInterval;
  fidelity?: number;
}

export interface PriceHistoryPoint {
  t: number; // Unix timestamp in seconds
  p: number; // Probability percentage (0-100), transformed from decimal (0.0-1.0)
}

export interface PriceHistoryResponse {
  history: PriceHistoryPoint[];
}

/**
 * CLOB WebSocket Order Book Types
 */
export interface ClobOrderBookEntry {
  price: string; // Price as string (e.g., "0.35")
  size: string;  // Size/quantity as string (e.g., "15018")
}

export interface ClobOrderBookUpdate {
  market: string; // Market address/ID (e.g., "0xf7742406d5edcdaf4449833f64f2d9ec32da27cb0a0f05ce057447dcbd5f85d3")
  asset_id: string; // Token ID (e.g., "79582254082838461298332796975720054327136374562196770992070812664072096367481")
  timestamp: string; // Timestamp as string (e.g., "1764527934271")
  hash: string; // Hash identifier
  bids: ClobOrderBookEntry[]; // Array of bid orders (buy orders)
  asks: ClobOrderBookEntry[]; // Array of ask orders (sell orders)
  event_type: 'book' | string; // Event type, typically "book" for order book updates
  last_trade_price?: string; // Last trade price as string
}

export interface ClobPriceChange {
  asset_id: string; // Token ID
  best_ask: string; // Best ask price
  best_bid: string; // Best bid price
  hash: string; // Hash identifier
  price: string; // Trade price
  side: 'BUY' | 'SELL'; // Trade side
  size: string; // Trade size
}

export interface ClobPriceChangeUpdate {
  event_type: 'price_change';
  market: string; // Market address/ID
  price_changes: ClobPriceChange[]; // Array of price changes (typically 2 for binary markets - Yes/No)
  timestamp: string; // Timestamp as string
}

/**
 * Sports WebSocket Types
 */
export interface SportsGameUpdate {
  gameId: number; // Unique game identifier
  score: string; // Current score (e.g., "0-7", "2-0", "000-000|1-2|Bo3" for esports)
  elapsed?: string; // Elapsed time (e.g., "0:42", "80", "15:50", "3:48")
  period: string; // Current period (e.g., "Q1", "2H", "Q1", "3/3", "P2")
  live: boolean; // Whether the game is currently live
  ended: boolean; // Whether the game has ended
  leagueAbbreviation: string; // League abbreviation (e.g., "nfl", "cbb", "dota2", "val", "lal", "es2")
  homeTeam?: string; // Home team abbreviation (e.g., "MIA", "STJOE")
  awayTeam?: string; // Away team abbreviation (e.g., "NO", "PRNCE")
  turn?: string; // Team with current possession/turn (e.g., "mia", "no")
  turnProviderId?: number; // Provider ID for turn tracking
  status?: string; // Game status (e.g., "InProgress", "finished", "running", "HT")
}

/**
 * Live Data WebSocket Types
 */
export interface LiveDataOrdersMatched {
  asset: string; // Asset/token ID
  bio?: string; // User bio
  conditionId: string; // Condition ID for the market
  eventSlug: string; // Event slug (e.g., "nfl-hou-ind-2025-11-30")
  icon?: string; // Event icon URL
  name?: string; // User name
  outcome: string; // Outcome name (e.g., "Colts", "Texans")
  outcomeIndex: number; // Index of the outcome (0, 1, etc.)
  price: number; // Price at which the order was matched (0-1)
  profileImage?: string; // User profile image URL
  proxyWallet: string; // User's proxy wallet address
  pseudonym?: string; // User pseudonym
  side: 'BUY' | 'SELL'; // Order side
  size: number; // Order size
  slug: string; // Event slug (same as eventSlug)
  timestamp: number; // Unix timestamp
  title: string; // Event title (e.g., "Texans vs. Colts")
  transactionHash: string; // Blockchain transaction hash
}

export interface ClobWebSocketMessage {
  type?: string;
  event?: string;
  channel?: string;
  data?: any;
  [key: string]: any;
}

/**
 * Orderbook Types for CLOB REST API
 */
export interface OrderBookEntry {
  price: string; // Price as string (e.g., "0.35")
  size: string; // Size/quantity as string (e.g., "2670")
}

export interface OrderBookResponse {
  market: string; // Market address/ID (e.g., "0xfb271be1fd36d39df248526573b47db09a806722fe1712f27d35279af149f1ff")
  asset_id: string; // Token ID (e.g., "114782618692864822179421796791260116822757553171286093337624870274191590938528")
  timestamp: string; // Timestamp as string (e.g., "1764572247055")
  hash: string; // Hash identifier (e.g., "3b03e419e89e1ed4389e86d5a0a7541dc1740325")
  bids: OrderBookEntry[]; // Array of bid orders (buy orders)
  asks: OrderBookEntry[]; // Array of ask orders (sell orders)
  min_order_size: string; // Minimum order size (e.g., "5")
  tick_size: string; // Price tick size (e.g., "0.01")
  neg_risk: boolean; // Whether negative risk is enabled
}

export interface OrderBookRequest {
  token_id: string; // Token ID to fetch orderbook for
}

