/**
 * Redis configuration stub
 * This file provides a stub for Redis functionality
 * Using in-memory cache for development
 */

import { logger } from './logger';

// In-memory cache storage
const cache = new Map<string, { value: string; expiry: number }>();

// Stub redis client - not actually using Redis
const redisClient = {
  isOpen: false,
  connect: async () => {
    logger.info({ message: 'Redis stub: connect called (no-op)' });
  },
  disconnect: async () => {
    logger.info({ message: 'Redis stub: disconnect called (no-op)' });
  },
  get: async (key: string): Promise<string | null> => {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  },
  set: async (key: string, value: string, options?: { EX?: number }): Promise<void> => {
    const ttl = options?.EX || 3600; // Default 1 hour
    cache.set(key, {
      value,
      expiry: Date.now() + (ttl * 1000),
    });
  },
  del: async (key: string): Promise<void> => {
    cache.delete(key);
  },
  keys: async (pattern: string): Promise<string[]> => {
    const keys: string[] = [];
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    for (const key of cache.keys()) {
      if (regex.test(key)) {
        keys.push(key);
      }
    }
    return keys;
  },
};

export const redis = redisClient;

export async function getRedisClient() {
  return redisClient;
}

export default redis;
