/**
 * Positions Types
 * Type definitions for Polymarket positions and portfolio tracking
 */

/**
 * Position data from Polymarket Data API
 */
export interface PolymarketPosition {
  proxyWallet: string;
  asset: string; // Token ID (used as clobTokenId for selling)
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  percentRealizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  icon?: string;
  eventId: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string; // ISO date string
  negativeRisk: boolean;
}

/**
 * Stored position in database
 */
export interface UserPosition {
  id: string;
  privyUserId: string;
  proxyWalletAddress: string;
  asset: string;
  conditionId: string;
  size: string;
  avgPrice: string;
  initialValue: string;
  currentValue: string;
  cashPnl: string;
  percentPnl: string;
  curPrice: string;
  redeemable: boolean;
  mergeable: boolean;
  negativeRisk: boolean;
  title: string | null;
  slug: string | null;
  eventId: string | null;
  eventSlug: string | null;
  outcome: string | null;
  outcomeIndex: number | null;
  oppositeOutcome: string | null;
  oppositeAsset: string | null;
  endDate: string | null;
  totalBought: string | null;
  realizedPnl: string | null;
  percentRealizedPnl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Positions query parameters
 */
export interface PositionsQueryParams {
  limit?: number;
  offset?: number;
  sortBy?: 'TOKENS' | 'VALUE' | 'PNL' | 'PRICE';
  sortDirection?: 'ASC' | 'DESC';
}

/**
 * Portfolio summary
 */
export interface PortfolioSummary {
  portfolio: number; // Total current value
  totalPositions: number;
  totalPnl: number;
  totalPercentPnl: number;
  positions: UserPosition[];
}
