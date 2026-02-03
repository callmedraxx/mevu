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

export interface LiveGameStored {
  id: string;
  slug?: string;
  gameId?: number;
  [key: string]: unknown;
}

let redisClient: Redis | null = null;
const inMemoryGames = new Map<string, string>(); // id -> JSON
const inMemoryGidToEid = new Map<number, string>();
const inMemorySlugToId = new Map<string, string>();

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
  return redisClient !== null;
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
      commandTimeout: 15000,  // Increased for high throughput
      enableOfflineQueue: true,  // Queue commands when disconnected
      retryStrategy: (times) => {
        if (times > 10) {
          logger.error({ message: 'Redis games cache max retries reached, giving up' });
          return null; // Stop retrying
        }
        const delay = Math.min(times * 500, 5000);
        logger.info({ message: 'Redis games cache reconnecting', attempt: times, delayMs: delay });
        return delay;
      },
      reconnectOnError: (err) => {
        // Reconnect on connection reset or timeout errors
        const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'];
        return targetErrors.some((e) => err.message.includes(e));
      },
    });

    redisClient.on('error', (err) =>
      logger.warn({ message: 'Redis games cache error', error: err.message })
    );

    redisClient.on('connect', () =>
      logger.info({ message: 'Redis games cache connected' })
    );

    redisClient.on('ready', () =>
      logger.info({ message: 'Redis games cache ready' })
    );

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
}

/**
 * Clear all games and mappings from cache
 * Call this before a full cache refresh to prevent stale mappings
 */
export async function clearAllGamesCaches(): Promise<void> {
  if (useRedis() && redisClient) {
    await redisClient.del(REDIS_KEY_GAMES, REDIS_KEY_GID_TO_EID, REDIS_KEY_SLUG_TO_ID);
  }
  inMemoryGames.clear();
  inMemoryGidToEid.clear();
  inMemorySlugToId.clear();
  
  logger.info({ message: 'All games caches cleared (games, gid2eid, slug2id)' });
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
