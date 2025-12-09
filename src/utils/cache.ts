/**
 * In-memory cache utilities
 * Simple cache implementation for development without Redis
 */

import { logger } from '../config/logger';

interface CacheEntry {
  value: string;
  expiry: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Get a value from cache
 */
export async function getCache(key: string): Promise<string | null> {
  const entry = cache.get(key);
  
  if (!entry) {
    return null;
  }
  
  if (Date.now() > entry.expiry) {
    cache.delete(key);
    return null;
  }
  
  return entry.value;
}

/**
 * Set a value in cache with TTL (in seconds)
 */
export async function setCache(key: string, value: string, ttlSeconds: number): Promise<void> {
  cache.set(key, {
    value,
    expiry: Date.now() + (ttlSeconds * 1000),
  });
}

/**
 * Delete a key from cache
 */
export async function deleteCache(key: string): Promise<void> {
  cache.delete(key);
}

/**
 * Get all keys matching a pattern (simple implementation)
 */
export async function getCacheKeys(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  const regex = new RegExp(pattern.replace('*', '.*'));
  
  for (const key of cache.keys()) {
    if (regex.test(key)) {
      keys.push(key);
    }
  }
  
  return keys;
}

/**
 * Clear all cache entries
 */
export async function clearCache(): Promise<void> {
  cache.clear();
}

// Periodically clean expired entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now > entry.expiry) {
      cache.delete(key);
    }
  }
}, 60000); // Clean every minute

