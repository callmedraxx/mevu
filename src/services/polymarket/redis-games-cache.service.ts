/**
 * Redis Games Cache Service
 * Shared cache for LiveGames across all cluster workers.
 * Uses Redis when REDIS_URL is set; falls back to in-memory when unavailable.
 */

import Redis from 'ioredis';
import { logger } from '../../config/logger';

const REDIS_KEY_GAMES = 'games:cache';
const REDIS_KEY_GID_TO_EID = 'games:gid2eid';
const REDIS_KEY_SLUG_TO_ID = 'games:slug2id';
const REDIS_KEY_TOKEN_PRICES = 'positions:token_prices';

/** Cross-worker coordination: pause CLOB flush during games refresh (prevents deadlock) */
const REDIS_KEY_GAMES_REFRESH = 'sync:games_refresh_in_progress';
/** Cross-worker coordination: pause crypto CLOB flush during crypto markets refresh */
const REDIS_KEY_CRYPTO_REFRESH = 'sync:crypto_refresh_in_progress';
const REFRESH_KEY_TTL_SEC = 300; // 5 min max — safety if process crashes

export interface LiveGameStored {
  id: string;
  slug?: string;
  gameId?: number;
  [key: string]: unknown;
}

let redisClient: Redis | null = null;
let redisDisabled = false; // Circuit breaker: true when Redis is unstable
const inMemoryGames = new Map<string, string>(); // id -> JSON
const inMemoryGidToEid = new Map<number, string>();
const inMemorySlugToId = new Map<string, string>();
const inMemoryTokenPrices = new Map<string, string>(); // clobTokenId -> JSON

// Track rapid reconnections to detect unstable connections
const RECONNECT_WINDOW_MS = 30_000; // 30 second window
const MAX_RECONNECTS_IN_WINDOW = 10; // Max reconnections before circuit-breaking
let reconnectTimestamps: number[] = [];

function reviveDates(json: Record<string, unknown>): void {
  if (json.createdAt && typeof json.createdAt === 'string') {
    json.createdAt = new Date(json.createdAt);
  }
  if (json.updatedAt && typeof json.updatedAt === 'string') {
    json.updatedAt = new Date(json.updatedAt);
  }
}

function parseGame(jsonStr: string): LiveGameStored {
  const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  reviveDates(parsed);
  return parsed as LiveGameStored;
}

function useRedis(): boolean {
  return redisClient !== null && !redisDisabled;
}

/**
 * Initialize Redis connection. Call early in app startup.
 * Returns true if Redis is connected and will be used.
 */
export function initRedisGamesCache(): boolean {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return false;
  if (redisClient) return true;

  try {
    redisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      connectTimeout: 10000,
      commandTimeout: 15000,
      enableOfflineQueue: true,
      retryStrategy: (times) => {
        if (times > 10) {
          logger.error({ message: 'Redis games cache max retries reached, giving up' });
          return null;
        }
        const delay = Math.min(times * 500, 5000);
        logger.info({ message: 'Redis games cache retrying connection', attempt: times, delayMs: delay });
        return delay;
      },
      // Only reconnect on READONLY (Redis cluster failover). TCP-level errors
      // (ECONNRESET, ETIMEDOUT, ECONNREFUSED) are handled by retryStrategy.
      reconnectOnError: (err) => {
        return err.message.includes('READONLY');
      },
    });

    // Prevent MaxListenersExceeded warning during reconnection cycles
    redisClient.setMaxListeners(20);

    redisClient.on('error', (err) =>
      logger.warn({ message: 'Redis games cache error', error: err.message })
    );

    redisClient.on('connect', () =>
      logger.info({ message: 'Redis games cache connected' })
    );

    redisClient.on('ready', () => {
      logger.info({ message: 'Redis games cache ready' });
      // Connection stabilized — re-enable Redis if it was circuit-broken
      if (redisDisabled) {
        redisDisabled = false;
        reconnectTimestamps = [];
        logger.info({ message: 'Redis games cache re-enabled after stable connection' });
      }
    });

    redisClient.on('close', () => {
      // Track rapid reconnection cycles to detect unstable connections
      const now = Date.now();
      reconnectTimestamps.push(now);
      // Keep only timestamps within the window
      reconnectTimestamps = reconnectTimestamps.filter(t => now - t < RECONNECT_WINDOW_MS);

      if (reconnectTimestamps.length >= MAX_RECONNECTS_IN_WINDOW && !redisDisabled) {
        redisDisabled = true;
        logger.error({
          message: 'Redis games cache circuit breaker triggered — too many rapid reconnections, falling back to in-memory',
          reconnectsInWindow: reconnectTimestamps.length,
          windowMs: RECONNECT_WINDOW_MS,
        });
      }
    });

    redisClient.on('reconnecting', () =>
      logger.info({ message: 'Redis games cache reconnecting' })
    );

    return true;
  } catch (error) {
    logger.warn({
      message: 'Redis games cache init failed, using in-memory fallback',
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function shutdownRedisGamesCache(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
  inMemoryGames.clear();
  inMemoryGidToEid.clear();
  inMemorySlugToId.clear();
  inMemoryTokenPrices.clear();
}

/**
 * Clear all games and mappings from cache
 * Call this before a full cache refresh to prevent stale mappings
 */
export async function clearAllGamesCaches(): Promise<void> {
  if (useRedis() && redisClient) {
    await redisClient.del(REDIS_KEY_GAMES, REDIS_KEY_GID_TO_EID, REDIS_KEY_SLUG_TO_ID, REDIS_KEY_TOKEN_PRICES);
  }
  inMemoryGames.clear();
  inMemoryGidToEid.clear();
  inMemorySlugToId.clear();
  inMemoryTokenPrices.clear();

  logger.info({ message: 'All games caches cleared (games, gid2eid, slug2id, token_prices)' });
}

/**
 * Cross-worker coordination for games refresh (sports + live games).
 * Sports worker sets when refresh starts; CLOB worker checks before flush.
 * Prevents deadlock between storeGames (live_games) and CLOB flush (live_games).
 */
export async function setGamesRefreshInProgress(): Promise<void> {
  if (useRedis() && redisClient) {
    await redisClient.set(REDIS_KEY_GAMES_REFRESH, '1', 'EX', REFRESH_KEY_TTL_SEC);
  }
}

export async function clearGamesRefreshInProgress(): Promise<void> {
  if (useRedis() && redisClient) {
    await redisClient.del(REDIS_KEY_GAMES_REFRESH);
  }
}

export async function isGamesRefreshInProgress(): Promise<boolean> {
  if (!useRedis() || !redisClient) return false;
  const v = await redisClient.get(REDIS_KEY_GAMES_REFRESH);
  return v === '1';
}

/**
 * Cross-worker coordination for crypto markets refresh.
 * Sports worker sets when crypto refresh starts; CLOB worker (cryptoClobPriceService) checks before flush.
 * Prevents deadlock between storeCryptoMarketsInDatabase and crypto CLOB flush.
 */
export async function setCryptoRefreshInProgress(): Promise<void> {
  if (useRedis() && redisClient) {
    await redisClient.set(REDIS_KEY_CRYPTO_REFRESH, '1', 'EX', REFRESH_KEY_TTL_SEC);
  }
}

export async function clearCryptoRefreshInProgress(): Promise<void> {
  if (useRedis() && redisClient) {
    await redisClient.del(REDIS_KEY_CRYPTO_REFRESH);
  }
}

export async function isCryptoRefreshInProgress(): Promise<boolean> {
  if (!useRedis() || !redisClient) return false;
  const v = await redisClient.get(REDIS_KEY_CRYPTO_REFRESH);
  return v === '1';
}

/** Set a single game in cache */
export async function setGameInCache(game: LiveGameStored): Promise<void> {
  const json = JSON.stringify(game);
  if (useRedis() && redisClient) {
    await redisClient.hset(REDIS_KEY_GAMES, game.id, json);
    if (game.gameId != null) {
      await redisClient.hset(REDIS_KEY_GID_TO_EID, String(game.gameId), game.id);
    }
    if (game.slug) {
      await redisClient.hset(REDIS_KEY_SLUG_TO_ID, (game.slug as string).toLowerCase(), game.id);
    }
    const ticker = (game as any).ticker;
    if (ticker) {
      await redisClient.hset(REDIS_KEY_SLUG_TO_ID, String(ticker).toLowerCase(), game.id);
    }
  } else {
    inMemoryGames.set(game.id, json);
    if (game.gameId != null) {
      inMemoryGidToEid.set(game.gameId, game.id);
    }
    if (game.slug) {
      inMemorySlugToId.set((game.slug as string).toLowerCase(), game.id);
    }
    const ticker = (game as any).ticker;
    if (ticker) {
      inMemorySlugToId.set(String(ticker).toLowerCase(), game.id);
    }
  }
}

/** Set multiple games in cache (batch) */
export async function setGamesInCacheBatch(games: LiveGameStored[]): Promise<void> {
  if (games.length === 0) return;

  if (useRedis() && redisClient) {
    const pipeline = redisClient.pipeline();
    for (const game of games) {
      pipeline.hset(REDIS_KEY_GAMES, game.id, JSON.stringify(game));
      if (game.gameId != null) {
        pipeline.hset(REDIS_KEY_GID_TO_EID, String(game.gameId), game.id);
      }
      if (game.slug) {
        pipeline.hset(REDIS_KEY_SLUG_TO_ID, (game.slug as string).toLowerCase(), game.id);
      }
      const ticker = (game as any).ticker;
      if (ticker) {
        pipeline.hset(REDIS_KEY_SLUG_TO_ID, String(ticker).toLowerCase(), game.id);
      }
    }
    await pipeline.exec();
  } else {
    for (const game of games) {
      inMemoryGames.set(game.id, JSON.stringify(game));
      if (game.gameId != null) {
        inMemoryGidToEid.set(game.gameId, game.id);
      }
      if (game.slug) {
        inMemorySlugToId.set((game.slug as string).toLowerCase(), game.id);
      }
      const ticker = (game as any).ticker;
      if (ticker) {
        inMemorySlugToId.set(String(ticker).toLowerCase(), game.id);
      }
    }
  }
}

/** Get a single game by id */
export async function getGameFromCache(id: string): Promise<LiveGameStored | null> {
  let jsonStr: string | null;
  if (useRedis() && redisClient) {
    jsonStr = await redisClient.hget(REDIS_KEY_GAMES, id);
  } else {
    jsonStr = inMemoryGames.get(id) ?? null;
  }
  if (!jsonStr) return null;
  return parseGame(jsonStr);
}

/** Get eventId by numeric gameId */
export async function getEventIdByGameId(gameId: number): Promise<string | null> {
  if (useRedis() && redisClient) {
    return redisClient.hget(REDIS_KEY_GID_TO_EID, String(gameId));
  }
  return inMemoryGidToEid.get(gameId) ?? null;
}

/** Get game id by slug */
export async function getGameIdBySlug(slug: string): Promise<string | null> {
  const key = slug.toLowerCase();
  if (useRedis() && redisClient) {
    return redisClient.hget(REDIS_KEY_SLUG_TO_ID, key);
  }
  return inMemorySlugToId.get(key) ?? null;
}

/** Get all games from cache */
export async function getAllGamesFromCache(): Promise<LiveGameStored[]> {
  let entries: [string, string][];
  if (useRedis() && redisClient) {
    const data = await redisClient.hgetall(REDIS_KEY_GAMES);
    entries = Object.entries(data);
  } else {
    entries = Array.from(inMemoryGames.entries());
  }
  return entries.map(([, json]) => parseGame(json));
}

/** Get all games as Map (for iteration by gameId when eventId unknown) */
export async function getGamesByGameIdFromCache(gameId: number): Promise<LiveGameStored | null> {
  const eventId = await getEventIdByGameId(gameId);
  if (eventId) return getGameFromCache(eventId);
  // Fallback: scan all games
  const all = await getAllGamesFromCache();
  return all.find((g) => g.gameId === gameId) ?? null;
}

/** Check if cache has any games (for cache-first logic) */
export async function hasGamesInCache(): Promise<boolean> {
  if (useRedis() && redisClient) {
    const count = await redisClient.hlen(REDIS_KEY_GAMES);
    return count > 0;
  }
  return inMemoryGames.size > 0;
}

/** Remove a game from cache by eventId */
export async function removeGameFromCache(eventId: string): Promise<void> {
  if (useRedis() && redisClient) {
    // Get the game first to find its gameId and slug for cleanup
    const jsonStr = await redisClient.hget(REDIS_KEY_GAMES, eventId);
    if (jsonStr) {
      const game = parseGame(jsonStr);
      const pipeline = redisClient.pipeline();
      pipeline.hdel(REDIS_KEY_GAMES, eventId);
      if (game.gameId != null) {
        pipeline.hdel(REDIS_KEY_GID_TO_EID, String(game.gameId));
      }
      if (game.slug) {
        pipeline.hdel(REDIS_KEY_SLUG_TO_ID, (game.slug as string).toLowerCase());
      }
      const ticker = (game as any).ticker;
      if (ticker) {
        pipeline.hdel(REDIS_KEY_SLUG_TO_ID, String(ticker).toLowerCase());
      }
      await pipeline.exec();
    }
  } else {
    const jsonStr = inMemoryGames.get(eventId);
    if (jsonStr) {
      const game = parseGame(jsonStr);
      inMemoryGames.delete(eventId);
      if (game.gameId != null) {
        inMemoryGidToEid.delete(game.gameId);
      }
      if (game.slug) {
        inMemorySlugToId.delete((game.slug as string).toLowerCase());
      }
      const ticker = (game as any).ticker;
      if (ticker) {
        inMemorySlugToId.delete(String(ticker).toLowerCase());
      }
    }
  }
}

/**
 * Clean up stale mappings that point to non-existent games
 * This removes orphaned entries from gid2eid and slug2id
 */
export async function cleanupStaleMappings(): Promise<{ removedGidMappings: number; removedSlugMappings: number }> {
  let removedGidMappings = 0;
  let removedSlugMappings = 0;

  if (useRedis() && redisClient) {
    // Get all current game IDs
    const gameIds = await redisClient.hkeys(REDIS_KEY_GAMES);
    const validEventIds = new Set(gameIds);

    // Check gid2eid mappings
    const gidMappings = await redisClient.hgetall(REDIS_KEY_GID_TO_EID);
    const staleGids: string[] = [];
    for (const [gid, eventId] of Object.entries(gidMappings)) {
      if (!validEventIds.has(eventId)) {
        staleGids.push(gid);
      }
    }
    if (staleGids.length > 0) {
      await redisClient.hdel(REDIS_KEY_GID_TO_EID, ...staleGids);
      removedGidMappings = staleGids.length;
    }

    // Check slug2id mappings
    const slugMappings = await redisClient.hgetall(REDIS_KEY_SLUG_TO_ID);
    const staleSlugs: string[] = [];
    for (const [slug, eventId] of Object.entries(slugMappings)) {
      if (!validEventIds.has(eventId)) {
        staleSlugs.push(slug);
      }
    }
    if (staleSlugs.length > 0) {
      await redisClient.hdel(REDIS_KEY_SLUG_TO_ID, ...staleSlugs);
      removedSlugMappings = staleSlugs.length;
    }
  } else {
    // In-memory cleanup
    const validEventIds = new Set(inMemoryGames.keys());

    for (const [gid, eventId] of inMemoryGidToEid.entries()) {
      if (!validEventIds.has(eventId)) {
        inMemoryGidToEid.delete(gid);
        removedGidMappings++;
      }
    }

    for (const [slug, eventId] of inMemorySlugToId.entries()) {
      if (!validEventIds.has(eventId)) {
        inMemorySlugToId.delete(slug);
        removedSlugMappings++;
      }
    }
  }

  if (removedGidMappings > 0 || removedSlugMappings > 0) {
    logger.info({
      message: 'Cleaned up stale cache mappings',
      removedGidMappings,
      removedSlugMappings,
    });
  }

  return { removedGidMappings, removedSlugMappings };
}

/**
 * Token prices cache for fast position enrichment.
 * Populated by ClobPriceUpdateService on price changes; read by positions service via HMGET.
 * Avoids slow getAllGamesFromCache when we only need prices for a user's N positions.
 */
export interface TokenPriceEntry {
  buyPrice: number;
  sellPrice: number;
  isEnded?: boolean;
}

/** Set token prices (called when CLOB price changes) */
export async function setTokenPricesForPositions(
  updates: Array<{ clobTokenId: string; buyPrice: number; sellPrice: number; isEnded?: boolean }>
): Promise<void> {
  if (updates.length === 0) return;

  const entries = updates.map((u) => [
    u.clobTokenId,
    JSON.stringify({ buyPrice: u.buyPrice, sellPrice: u.sellPrice, isEnded: u.isEnded ?? false }),
  ] as [string, string]);

  if (useRedis() && redisClient) {
    const pipeline = redisClient.pipeline();
    for (const [k, v] of entries) {
      pipeline.hset(REDIS_KEY_TOKEN_PRICES, k, v);
    }
    await pipeline.exec();
  } else {
    for (const [k, v] of entries) {
      inMemoryTokenPrices.set(k as string, v as string);
    }
  }
}

/** Get token prices for specific assets (fast path - HMGET instead of full games scan) */
export async function getTokenPricesForPositions(
  assetIds: string[]
): Promise<{ priceMap: Map<string, { buyPrice: number; sellPrice: number }>; endedAssets: Set<string> }> {
  const priceMap = new Map<string, { buyPrice: number; sellPrice: number }>();
  const endedAssets = new Set<string>();

  if (assetIds.length === 0) return { priceMap, endedAssets };

  let values: (string | null)[];
  if (useRedis() && redisClient) {
    values = await redisClient.hmget(REDIS_KEY_TOKEN_PRICES, ...assetIds);
  } else {
    values = assetIds.map((id) => inMemoryTokenPrices.get(id) ?? null);
  }

  for (let i = 0; i < assetIds.length; i++) {
    const json = values[i];
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as TokenPriceEntry;
      if (parsed.isEnded) {
        endedAssets.add(assetIds[i]);
      } else if (parsed.buyPrice > 0 || parsed.sellPrice > 0) {
        priceMap.set(assetIds[i], {
          buyPrice: parsed.buyPrice / 100,
          sellPrice: parsed.sellPrice / 100,
        });
      }
    } catch {
      // skip invalid entries
    }
  }

  return { priceMap, endedAssets };
}

/** Check if token prices cache has enough data to use (avoids full scan when cache is cold) */
export async function hasTokenPricesInCache(): Promise<boolean> {
  if (useRedis() && redisClient) {
    const len = await redisClient.hlen(REDIS_KEY_TOKEN_PRICES);
    return len >= 50;
  }
  return inMemoryTokenPrices.size >= 50;
}

/**
 * Get cache statistics for monitoring
 */
export async function getCacheStats(): Promise<{
  gamesCount: number;
  gidMappingsCount: number;
  slugMappingsCount: number;
}> {
  if (useRedis() && redisClient) {
    const [gamesCount, gidMappingsCount, slugMappingsCount] = await Promise.all([
      redisClient.hlen(REDIS_KEY_GAMES),
      redisClient.hlen(REDIS_KEY_GID_TO_EID),
      redisClient.hlen(REDIS_KEY_SLUG_TO_ID),
    ]);
    return { gamesCount, gidMappingsCount, slugMappingsCount };
  }
  return {
    gamesCount: inMemoryGames.size,
    gidMappingsCount: inMemoryGidToEid.size,
    slugMappingsCount: inMemorySlugToId.size,
  };
}
