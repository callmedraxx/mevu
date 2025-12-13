/**
 * Holders types for Polymarket holders API and database storage
 */

/**
 * Raw holder response from Polymarket data API
 */
export interface PolymarketHolder {
  proxyWallet: string;
  bio: string;
  asset: string;
  pseudonym: string;
  amount: number;
  displayUsernamePublic: boolean;
  outcomeIndex: number;
  name: string;
  profileImage: string;
  profileImageOptimized: string;
  verified: boolean;
}

/**
 * Polymarket API response structure
 */
export interface PolymarketHolderResponse {
  token: string;
  holders: PolymarketHolder[];
}

/**
 * Holder as stored in database
 */
export interface StoredHolder {
  id: number;
  token: string;
  proxyWallet: string;
  asset: string;
  amount: number;
  outcomeIndex: number | null;
  conditionId: string;
  marketId: string | null;
  gameId: string;
  name: string | null;
  pseudonym: string | null;
  bio: string | null;
  profileImage: string | null;
  profileImageOptimized: string | null;
  verified: boolean;
  displayUsernamePublic: boolean;
  createdAt: Date;
}

/**
 * Asset information for a holder position
 */
export interface HolderAsset {
  assetId: string;
  shortLabel: string;
  question: string; // Market question for context (e.g., "Over 220.5 Points")
  amount: number;
}

/**
 * Aggregated holder data (grouped by wallet)
 */
export interface AggregatedHolder {
  proxyWallet: string;
  totalAmount: number;
  assets: HolderAsset[];
}

/**
 * Transformed holder for frontend
 */
export interface TransformedHolder {
  id: string; // database id (comma-separated if multiple positions)
  rank: number;
  wallet: string;
  totalAmount: number;
  assets: HolderAsset[];
}
