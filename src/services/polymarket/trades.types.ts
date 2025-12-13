/**
 * Trade types for Polymarket trades API and database storage
 */

import { FrontendTeam } from './frontend-game.transformer';

/**
 * Raw trade response from Polymarket data API
 */
export interface PolymarketTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  name: string;
  pseudonym: string;
  bio: string;
  profileImage: string;
  profileImageOptimized: string;
  transactionHash: string;
}

/**
 * Trade as stored in database (includes game_id and created_at)
 */
export interface StoredTrade {
  id: number;
  proxyWallet: string | null;
  side: 'BUY' | 'SELL';
  asset: string | null;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string | null;
  slug: string | null;
  icon: string | null;
  eventSlug: string | null;
  outcome: string | null;
  outcomeIndex: number | null;
  name: string | null;
  pseudonym: string | null;
  bio: string | null;
  profileImage: string | null;
  profileImageOptimized: string | null;
  transactionHash: string;
  gameId: string;
  createdAt: Date;
}

/**
 * Transformed trade for frontend
 */
export interface TransformedTrade {
  type: 'Buy' | 'Sell';
  amount: number;        // Dollar amount (size * price)
  shares: number;        // Number of shares (size)
  price: number;         // Price multiplied by 100 (e.g., 0.21 -> 21)
  trader: string;        // Trader proxy wallet address
  traderAvatar: string;  // Emoji avatar (empty for now)
  outcome: string;       // Outcome from API
  awayTeam: FrontendTeam;
  homeTeam: FrontendTeam;
  time: string;          // ISO timestamp from created_at
}
