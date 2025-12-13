/**
 * Holders Transformer
 * Transforms aggregated holders to frontend format
 */

import { logger } from '../../config/logger';
import {
  AggregatedHolder,
  StoredHolder,
  TransformedHolder,
} from './holders.types';

/**
 * Transform aggregated holders to frontend format
 * Assigns ranks and combines holder IDs
 */
export function transformHolders(
  aggregatedHolders: AggregatedHolder[],
  storedHolders: StoredHolder[]
): TransformedHolder[] {
  // Create a map of wallet to holder IDs for quick lookup
  const walletToIds = new Map<string, number[]>();
  for (const holder of storedHolders) {
    if (!walletToIds.has(holder.proxyWallet)) {
      walletToIds.set(holder.proxyWallet, []);
    }
    walletToIds.get(holder.proxyWallet)!.push(holder.id);
  }

  const transformed: TransformedHolder[] = [];

  for (let i = 0; i < aggregatedHolders.length; i++) {
    const aggregated = aggregatedHolders[i];
    const holderIds = walletToIds.get(aggregated.proxyWallet) || [];
    
    // Combine holder IDs as comma-separated string
    const id = holderIds.join(',');

    transformed.push({
      id,
      rank: i + 1, // Rank starts at 1
      wallet: aggregated.proxyWallet,
      totalAmount: aggregated.totalAmount,
      assets: aggregated.assets,
    });
  }

  return transformed;
}
