/**
 * Polymarket Comments Service
 * Fetches comments from Gamma API for a market/event by slug.
 * Uses Promise coalescing: concurrent requests for the same slug share a single fetch to Polymarket.
 */

import { connectWithRetry, getDatabaseConfig } from '../../config/database';
import { polymarketClient } from './polymarket.client';
import { logger } from '../../config/logger';

// ─── Types ───

/** Raw comment from Polymarket Gamma API */
export interface PolymarketCommentRaw {
  id: string | number;
  body: string;
  parentEntityType?: string;
  parentEntityID?: number;
  parentCommentID?: string | number | null;
  userAddress?: string;
  profile?: {
    name?: string;
    pseudonym?: string;
    profileImage?: string;
  };
  reactions?: Record<string, unknown>;
  reactionCount?: number;
  reportCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** Normalized comment for frontend */
export interface Comment {
  id: string | number;
  body: string;
  user: string;
  userImage?: string;
  time: string;
  likes: number;
}

// ─── Request coalescing ───

/** In-flight fetch promises keyed by slug. When multiple users request comments for the same slug
 *  at the same time, they all await the same Promise — only one request goes to Polymarket. */
const inFlight = new Map<string, Promise<Comment[]>>();

function formatRelativeTime(isoTime: string): string {
  const diffMs = Date.now() - new Date(isoTime).getTime();
  if (diffMs < 0) return 'just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function toComment(raw: PolymarketCommentRaw): Comment {
  const profile = raw.profile;
  const userName =
    (profile?.pseudonym as string) || (profile?.name as string) || 'Anonymous';
  return {
    id: raw.id,
    body: raw.body || '',
    user: userName,
    userImage: profile?.profileImage as string | undefined,
    time: raw.createdAt ? formatRelativeTime(raw.createdAt) : '—',
    likes: raw.reactionCount ?? 0,
  };
}

/** Resolve Polymarket event ID from slug. Tries crypto_markets DB first, then Gamma API. */
async function resolveEventId(slug: string): Promise<number | null> {
  // 1. Try crypto_markets (we have event id stored)
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type === 'postgres' && process.env.DATABASE_URL) {
    const client = await connectWithRetry();
    try {
      const res = await client.query(
        'SELECT id FROM crypto_markets WHERE LOWER(slug) = LOWER($1) LIMIT 1',
        [slug]
      );
      if (res.rows.length > 0) {
        const id = (res.rows[0] as { id: string }).id;
        const num = parseInt(id, 10);
        if (!Number.isNaN(num)) return num;
      }
    } finally {
      client.release();
    }
  }

  // 2. Fallback: Gamma API events/slug/{slug}
  try {
    const event = await polymarketClient.get<{ id?: string | number }>(
      `/events/slug/${encodeURIComponent(slug)}`
    );
    if (event && (event as any).id != null) {
      const id = (event as any).id;
      const num = typeof id === 'number' ? id : parseInt(String(id), 10);
      if (!Number.isNaN(num)) return num;
    }
  } catch (err) {
    logger.warn({
      message: 'Failed to resolve event id from Gamma API',
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return null;
}

/** Internal: perform the actual fetch from Polymarket. */
async function fetchCommentsFromPolymarket(slug: string): Promise<Comment[]> {
  const eventId = await resolveEventId(slug);
  if (eventId == null) {
    return [];
  }

  const data = await polymarketClient.get<PolymarketCommentRaw[] | { data?: PolymarketCommentRaw[] }>(
    '/comments',
    {
      parent_entity_type: 'Event',
      parent_entity_id: eventId,
      limit: 50,
      offset: 0,
      order: 'createdAt',
      ascending: false,
    } as any
  );

  const rawList = Array.isArray(data) ? data : (data as { data?: PolymarketCommentRaw[] })?.data ?? [];
  return rawList.map(toComment);
}

/**
 * Get comments for a market by slug.
 * Concurrent requests for the same slug share one Polymarket fetch.
 */
export async function getCommentsBySlug(slug: string): Promise<Comment[]> {
  if (!slug || typeof slug !== 'string') return [];

  const key = slug.toLowerCase().trim();
  let promise = inFlight.get(key);

  if (!promise) {
    promise = (async () => {
      try {
        return await fetchCommentsFromPolymarket(slug);
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, promise);
  }

  return promise;
}
