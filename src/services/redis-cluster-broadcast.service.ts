/**
 * Redis Cluster Broadcast Service
 * Publishes messages to Redis so all cluster workers can broadcast to their local clients.
 * Fixes cluster mode where only the leader receives updates (Sports WS, CLOB, webhooks).
 *
 * Channels:
 * - games:broadcast - game_update, price_update, games_update
 * - deposits:progress - deposit progress events (depositProgressService)
 * - deposits:balance - Alchemy deposit/balance notifications
 */

import Redis from 'ioredis';
import cluster from 'cluster';
import { logger } from '../config/logger';

const GAMES_CHANNEL = 'games:broadcast';
const ACTIVITY_CHANNEL = 'activity:broadcast';
const DEPOSITS_PROGRESS_CHANNEL = 'deposits:progress';
const DEPOSITS_BALANCE_CHANNEL = 'deposits:balance';

let redisPub: Redis | null = null;
let redisSub: Redis | null = null;
const gamesCallbacks: Set<(msg: unknown) => void> = new Set();
const activityCallbacks: Set<(msg: unknown) => void> = new Set();
const depositsProgressCallbacks: Set<(msg: unknown) => void> = new Set();
const depositsBalanceCallbacks: Set<(msg: unknown) => void> = new Set();

/**
 * Initialize Redis connection. Idempotent - safe to call multiple times.
 * Returns true if Redis is available and we're in cluster mode.
 */
export function initRedisClusterBroadcast(): boolean {
  const redisUrl = process.env.REDIS_URL;
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isClusterWorker = cluster.isWorker && nodeEnv === 'production';

  if (!redisUrl || !isClusterWorker) return false;
  if (redisPub && redisSub) return true;

  try {
    const redisOptions = {
      maxRetriesPerRequest: 3,
      connectTimeout: 10000,
      commandTimeout: 15000,  // Increased from 5s to 15s for high throughput
      enableOfflineQueue: true,  // Queue commands when disconnected
      retryStrategy: (times: number) => {
        if (times > 10) return null;
        return Math.min(times * 500, 5000);
      },
      reconnectOnError: (err: Error) => {
        const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'];
        return targetErrors.some((e) => err.message.includes(e));
      },
    };

    redisPub = new Redis(redisUrl, redisOptions);
    redisSub = new Redis(redisUrl, redisOptions);

    redisPub.on('error', (err) =>
      logger.warn({ message: 'Redis cluster broadcast (pub) error', error: err.message })
    );
    redisSub.on('error', (err) =>
      logger.warn({ message: 'Redis cluster broadcast (sub) error', error: err.message })
    );
    redisPub.on('ready', () =>
      logger.info({ message: 'Redis cluster broadcast (pub) ready', workerId: cluster.worker?.id })
    );
    redisSub.on('ready', () =>
      logger.info({ message: 'Redis cluster broadcast (sub) ready', workerId: cluster.worker?.id })
    );

    redisSub.on('message', (channel: string, message: string) => {
      try {
        const parsed = JSON.parse(message);
        if (channel === GAMES_CHANNEL) {
          gamesCallbacks.forEach((cb) => { try { cb(parsed); } catch (e) { /* ignore */ } });
        } else if (channel === ACTIVITY_CHANNEL) {
          activityCallbacks.forEach((cb) => { try { cb(parsed); } catch (e) { /* ignore */ } });
        } else if (channel === DEPOSITS_PROGRESS_CHANNEL) {
          depositsProgressCallbacks.forEach((cb) => { try { cb(parsed); } catch (e) { /* ignore */ } });
        } else if (channel === DEPOSITS_BALANCE_CHANNEL) {
          depositsBalanceCallbacks.forEach((cb) => { try { cb(parsed); } catch (e) { /* ignore */ } });
        }
      } catch (err) {
        logger.warn({
          message: 'Redis cluster broadcast parse error',
          channel,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    redisSub.subscribe(GAMES_CHANNEL, ACTIVITY_CHANNEL, DEPOSITS_PROGRESS_CHANNEL, DEPOSITS_BALANCE_CHANNEL);
    return true;
  } catch (error) {
    logger.warn({
      message: 'Redis cluster broadcast init failed',
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function publish(channel: string, payload: unknown): void {
  if (!redisPub) return;
  // Skip if Redis is not ready (connecting, reconnecting, etc.)
  if (redisPub.status !== 'ready') {
    return;
  }
  redisPub.publish(channel, JSON.stringify(payload)).catch((err) =>
    logger.warn({ message: 'Redis cluster broadcast publish failed', channel, error: err.message })
  );
}

// --- Games (for games-websocket and games SSE) ---
export interface GamesBroadcastMessage {
  type: 'games_update' | 'game_update' | 'price_update';
  payload: string;
}

/** Batch games messages to reduce Redis publish rate and prevent ENOBUFS (50ms = imperceptible) */
const GAMES_BATCH_DELAY_MS = 50;
let gamesBatchTimer: NodeJS.Timeout | null = null;
const gamesPendingByKey = new Map<string, GamesBroadcastMessage>();

function flushGamesBatch(): void {
  gamesBatchTimer = null;
  if (gamesPendingByKey.size === 0) return;
  const messages = Array.from(gamesPendingByKey.values());
  gamesPendingByKey.clear();
  if (messages.length === 1) {
    publish(GAMES_CHANNEL, messages[0]);
  } else {
    const parsed = messages.map((m) => JSON.parse(m.payload));
    publish(GAMES_CHANNEL, { type: 'batch', payload: JSON.stringify(parsed) });
  }
}

function scheduleGamesFlush(): void {
  if (gamesBatchTimer) return;
  gamesBatchTimer = setTimeout(flushGamesBatch, GAMES_BATCH_DELAY_MS);
}

export function subscribeToGamesBroadcast(callback: (msg: GamesBroadcastMessage) => void): () => void {
  const wrapped = (msg: unknown) => callback(msg as GamesBroadcastMessage);
  gamesCallbacks.add(wrapped);
  return () => gamesCallbacks.delete(wrapped);
}

export async function publishGamesBroadcast(message: GamesBroadcastMessage): Promise<void> {
  if (!redisPub) return;
  let key: string;
  if (message.type === 'games_update') {
    key = '__full__';
  } else {
    try {
      const parsed = JSON.parse(message.payload) as { game?: { id?: string } };
      key = parsed?.game?.id ?? `_${message.type}_${gamesPendingByKey.size}`;
    } catch {
      key = `_${message.type}_${Date.now()}`;
    }
  }
  gamesPendingByKey.set(key, message);
  scheduleGamesFlush();
}

export function isRedisGamesBroadcastReady(): boolean {
  return redisPub !== null;
}

/**
 * Publish a cache invalidation message to all workers.
 * Used when frontend_games table is updated so all HTTP workers clear their local cache.
 */
export async function publishCacheInvalidation(cacheType: 'frontend_games'): Promise<void> {
  if (!redisPub) return;
  // Publish immediately (no batching for cache invalidation - it's critical)
  await publish(GAMES_CHANNEL, { type: 'cache_invalidate', payload: cacheType });
}

// --- Activity watcher WebSocket ---
export interface ActivityBroadcastMessage {
  slugs: string[];
  message: { type: string; game: unknown; timestamp: string };
}

/** Batch activity messages to reduce Redis publish rate (50ms = imperceptible to humans) */
const ACTIVITY_BATCH_DELAY_MS = 50;
let activityBatchTimer: NodeJS.Timeout | null = null;
// Key by game ID to dedupe rapid updates for the same game
const activityPendingByGameId = new Map<string, ActivityBroadcastMessage>();

function flushActivityBatch(): void {
  activityBatchTimer = null;
  if (activityPendingByGameId.size === 0) return;
  const messages = Array.from(activityPendingByGameId.values());
  activityPendingByGameId.clear();

  if (messages.length === 1) {
    publish(ACTIVITY_CHANNEL, messages[0]);
  } else {
    // Send as batch - receiver will unpack
    publish(ACTIVITY_CHANNEL, { type: 'batch', items: messages });
  }
}

function scheduleActivityFlush(): void {
  if (activityBatchTimer) return;
  activityBatchTimer = setTimeout(flushActivityBatch, ACTIVITY_BATCH_DELAY_MS);
}

export function subscribeToActivityBroadcast(callback: (msg: ActivityBroadcastMessage) => void): () => void {
  const wrapped = (msg: unknown) => {
    const m = msg as any;
    if (m.type === 'batch' && Array.isArray(m.items)) {
      // Unpack batch
      for (const item of m.items) {
        callback(item as ActivityBroadcastMessage);
      }
    } else {
      callback(msg as ActivityBroadcastMessage);
    }
  };
  activityCallbacks.add(wrapped);
  return () => activityCallbacks.delete(wrapped);
}

export function publishActivityBroadcast(slugs: string[], message: { type: string; game: unknown; timestamp: string }): void {
  if (!redisPub) return;

  // Extract game ID for deduplication
  const gameId = (message.game as any)?.id ?? slugs[0] ?? `_activity_${Date.now()}`;
  activityPendingByGameId.set(gameId, { slugs, message });
  scheduleActivityFlush();
}

// --- Deposits progress (depositProgressService) ---
export function subscribeToDepositsProgress(callback: (msg: { privyUserId: string; event: unknown }) => void): () => void {
  depositsProgressCallbacks.add(callback as (msg: unknown) => void);
  return () => depositsProgressCallbacks.delete(callback as (msg: unknown) => void);
}

export function publishDepositsProgress(privyUserId: string, event: unknown): void {
  publish(DEPOSITS_PROGRESS_CHANNEL, { privyUserId, event });
}

// --- Deposits balance (Alchemy webhook notifications) ---
export function subscribeToDepositsBalance(callback: (msg: unknown) => void): () => void {
  depositsBalanceCallbacks.add(callback);
  return () => depositsBalanceCallbacks.delete(callback);
}

export function publishDepositsBalance(notification: unknown): void {
  publish(DEPOSITS_BALANCE_CHANNEL, notification);
}

export function isRedisClusterBroadcastReady(): boolean {
  return redisPub !== null;
}

export async function shutdownRedisClusterBroadcast(): Promise<void> {
  if (redisPub) {
    await redisPub.quit();
    redisPub = null;
  }
  if (redisSub) {
    await redisSub.quit();
    redisSub = null;
  }
  gamesCallbacks.clear();
  activityCallbacks.clear();
  depositsProgressCallbacks.clear();
  depositsBalanceCallbacks.clear();
}
