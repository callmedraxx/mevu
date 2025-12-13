/**
 * Whale Trade types for whale watcher widget
 */

import { FrontendTeam } from './frontend-game.transformer';

/**
 * Whale Trade interface for frontend
 * Represents trades with amount >= $1000
 */
export interface WhaleTrade {
  id: string;                    // Database ID as string
  trader: string;                 // Proxy wallet address
  type: 'buy' | 'sell';          // Trade type (from side field, lowercase)
  team: {                         // Both team objects
    homeTeam: FrontendTeam;
    awayTeam: FrontendTeam;
  };
  amount: number;                 // Trade amount in dollars (price * size)
  price: number;                  // Price in cents (price * 100)
  time: string;                   // ISO timestamp from created_at
  shares: number;                 // Number of shares (size field)
}
