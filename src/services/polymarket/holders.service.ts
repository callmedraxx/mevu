/**
 * Holders Service
 * Fetches top holders from Polymarket data API and stores them in database
 */

import axios from 'axios';
import { logger } from '../../config/logger';
import { pool } from '../../config/database';
import { LiveGame } from './live-games.service';
import {
  PolymarketHolderResponse,
  StoredHolder,
  AggregatedHolder,
  HolderAsset,
} from './holders.types';

const DATA_API_BASE_URL = 'https://data-api.polymarket.com';

/**
 * Extract all market conditionIds from a game
 */
export function extractAllMarketConditionIds(game: LiveGame): string[] {
  if (!game.markets || game.markets.length === 0) {
    return [];
  }

  const conditionIds: string[] = [];

  for (const market of game.markets) {
    if (market.conditionId) {
      conditionIds.push(market.conditionId);
    }
  }

  return conditionIds;
}

/**
 * Fetch holders from Polymarket data API
 * Builds query string with multiple market parameters
 */
export async function fetchHoldersFromPolymarket(
  conditionIds: string[]
): Promise<PolymarketHolderResponse[]> {
  if (conditionIds.length === 0) {
    return [];
  }

  try {
    const url = `${DATA_API_BASE_URL}/holders`;
    
    // Build query params with multiple market parameters
    // Use URLSearchParams to properly handle multiple values for same key
    const searchParams = new URLSearchParams();
    searchParams.append('limit', '1000');
    searchParams.append('minBalance', '1');
    for (const conditionId of conditionIds) {
      searchParams.append('market', conditionId);
    }

    const fullUrl = `${url}?${searchParams.toString()}`;

    logger.info({
      message: 'Fetching holders from Polymarket data API',
      conditionIdsCount: conditionIds.length,
      url: fullUrl,
    });

    const response = await axios.get<PolymarketHolderResponse[]>(fullUrl, {
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
      },
    });

    logger.info({
      message: 'Holders fetched successfully',
      conditionIdsCount: conditionIds.length,
      responseCount: response.data.length,
    });

    return response.data;
  } catch (error) {
    logger.error({
      message: 'Error fetching holders from Polymarket',
      conditionIdsCount: conditionIds.length,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Store holders in database
 */
export async function storeHolders(
  holders: PolymarketHolderResponse[],
  game: LiveGame
): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    logger.warn({
      message: 'storeHolders called in development mode - holders not persisted',
      gameId: game.id,
      holdersCount: holders.length,
    });
    return;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Delete existing holders for this game to refresh data
    await client.query('DELETE FROM holders WHERE game_id = $1', [game.id]);

    const insertQuery = `
      INSERT INTO holders (
        token, proxy_wallet, asset, amount, outcome_index,
        condition_id, market_id, game_id, name, pseudonym, bio,
        profile_image, profile_image_optimized, verified, display_username_public,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP
      )
    `;

    let insertedCount = 0;

    // Create a map of clobTokenId to conditionId and marketId for lookup
    // The API returns token = clobTokenId, NOT conditionId
    const clobTokenIdToConditionId = new Map<string, string>();
    const clobTokenIdToMarketId = new Map<string, string>();
    
    for (const market of game.markets || []) {
      if (market.structuredOutcomes) {
        for (const outcome of market.structuredOutcomes) {
          if (outcome.clobTokenId) {
            clobTokenIdToConditionId.set(outcome.clobTokenId, market.conditionId || '');
            clobTokenIdToMarketId.set(outcome.clobTokenId, market.id || '');
          }
        }
      }
    }

    for (const response of holders) {
      // response.token is the clobTokenId (asset ID), NOT the conditionId
      const clobTokenId = response.token;
      const conditionId = clobTokenIdToConditionId.get(clobTokenId) || '';
      const marketId = clobTokenIdToMarketId.get(clobTokenId) || null;

      for (const holder of response.holders) {
        await client.query(insertQuery, [
          response.token, // This is the clobTokenId
          holder.proxyWallet,
          holder.asset,
          holder.amount,
          holder.outcomeIndex,
          conditionId, // Now correctly looked up from game markets
          marketId,
          game.id,
          holder.name,
          holder.pseudonym,
          holder.bio,
          holder.profileImage,
          holder.profileImageOptimized,
          holder.verified,
          holder.displayUsernamePublic,
        ]);

        insertedCount++;
      }
    }

    await client.query('COMMIT');

    logger.info({
      message: 'Holders stored in database',
      gameId: game.id,
      totalHolders: insertedCount,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({
      message: 'Error storing holders in database',
      gameId: game.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get holders by game ID from database
 */
export async function getHoldersByGameId(gameId: string): Promise<StoredHolder[]> {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    logger.warn({
      message: 'getHoldersByGameId called in development mode - returning empty array',
      gameId,
    });
    return [];
  }

  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT 
        id, token, proxy_wallet as "proxyWallet", asset, amount, outcome_index as "outcomeIndex",
        condition_id as "conditionId", market_id as "marketId", game_id as "gameId",
        name, pseudonym, bio, profile_image as "profileImage",
        profile_image_optimized as "profileImageOptimized", verified, display_username_public as "displayUsernamePublic",
        created_at as "createdAt"
      FROM holders
      WHERE game_id = $1
      ORDER BY proxy_wallet, amount DESC`,
      [gameId]
    );

    return result.rows.map(row => ({
      id: row.id,
      token: row.token,
      proxyWallet: row.proxyWallet,
      asset: row.asset,
      amount: Number(row.amount),
      outcomeIndex: row.outcomeIndex,
      conditionId: row.conditionId,
      marketId: row.marketId,
      gameId: row.gameId,
      name: row.name,
      pseudonym: row.pseudonym,
      bio: row.bio,
      profileImage: row.profileImage,
      profileImageOptimized: row.profileImageOptimized,
      verified: row.verified,
      displayUsernamePublic: row.displayUsernamePublic,
      createdAt: new Date(row.createdAt),
    }));
  } catch (error) {
    logger.error({
      message: 'Error fetching holders from database',
      gameId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Aggregate holders by wallet, sum amounts, and match assets to shortLabels
 */
export function aggregateHoldersByWallet(
  holders: StoredHolder[],
  game: LiveGame
): AggregatedHolder[] {
  // Get all markets from the game
  const allMarkets = game.markets || [];
  
  // Build maps of clobTokenId -> shortLabel and clobTokenId -> question for fast lookups
  const clobTokenIdToShortLabel = new Map<string, string>();
  const clobTokenIdToQuestion = new Map<string, string>();
  
  for (const market of allMarkets) {
    if (market.structuredOutcomes) {
      for (const outcome of market.structuredOutcomes) {
        if (outcome.clobTokenId) {
          const tokenKey = String(outcome.clobTokenId).trim();
          const label = outcome.shortLabel || outcome.label;
          if (label) {
            clobTokenIdToShortLabel.set(tokenKey, label);
          }
          // Store the market question for this asset
          if (market.question) {
            clobTokenIdToQuestion.set(tokenKey, market.question);
          }
        }
      }
    }
  }


  // Group holders by proxyWallet
  const walletMap = new Map<string, { holders: StoredHolder[]; totalAmount: number }>();

  for (const holder of holders) {
    const wallet = holder.proxyWallet;
    
    if (!walletMap.has(wallet)) {
      walletMap.set(wallet, { holders: [], totalAmount: 0 });
    }

    const walletData = walletMap.get(wallet)!;
    walletData.holders.push(holder);
    walletData.totalAmount += holder.amount;
  }

  // Convert to AggregatedHolder array and match assets to shortLabels
  const aggregated: AggregatedHolder[] = [];

  for (const [wallet, data] of walletMap.entries()) {
    const assets: HolderAsset[] = [];

    for (const holder of data.holders) {
      // Look up shortLabel and question from the pre-built maps
      const assetKey = String(holder.asset || '').trim();
      const shortLabel = clobTokenIdToShortLabel.get(assetKey) || holder.asset;
      const question = clobTokenIdToQuestion.get(assetKey) || '';

      assets.push({
        assetId: holder.asset,
        shortLabel,
        question,
        amount: holder.amount,
      });
    }

    aggregated.push({
      proxyWallet: wallet,
      totalAmount: data.totalAmount,
      assets,
    });
  }

  // Sort by totalAmount descending
  aggregated.sort((a, b) => b.totalAmount - a.totalAmount);

  return aggregated;
}
