/**
 * UFC Fighter Records Service
 * Fetches fighter W-L-D records from Ball Don't Lie MMA API.
 * Persists to ufc_fighter_records table (bulk insert); loads from DB on init.
 * Used to enrich UFC frontend games before upserting to frontend_games.
 */

import axios from 'axios';
import { logger } from '../../config/logger';
import { pool, connectWithRetry } from '../../config/database';

const BALLDONTLIE_MMA_URL = 'https://api.balldontlie.io/mma/v1/fighters';
const REQUEST_TIMEOUT_MS = 5000;
const BULK_UPSERT_CHUNK_SIZE = 100;

/** In-memory cache: normalized fighter name -> record string (e.g. "22-6-0") */
const recordCache = new Map<string, string>();
/** In-memory cache: normalized fighter name -> display_name from Ball Don't Lie */
const displayNameCache = new Map<string, string>();
let dbLoaded = false;

function getApiKey(): string {
  return process.env.BALLDONTLIE_API_KEY || '';
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Normalize name for cache key (lowercase, trim, collapse spaces) */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Format record from API response */
function formatRecord(
  wins: number,
  losses: number,
  draws?: number,
  noContests?: number
): string {
  const w = wins ?? 0;
  const l = losses ?? 0;
  const d = draws ?? 0;
  const nc = noContests ?? 0;
  if (d > 0 || nc > 0) {
    return `${w}-${l}-${d}`;
  }
  return `${w}-${l}`;
}

/**
 * Fetch fighter record from Ball Don't Lie MMA API.
 * Returns { name, record } or null on error/no match.
 */
async function fetchFighterRecord(name: string): Promise<{ name: string; record: string } | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const search = name.trim();
  if (!search || search.length < 2) return null;

  try {
    const response = await axios.get(BALLDONTLIE_MMA_URL, {
      headers: { Authorization: apiKey },
      params: { search },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: (s) => s < 500,
    });

    const data = response.data?.data;
    if (!Array.isArray(data) || data.length === 0) return null;

    const searchLower = search.toLowerCase();
    const fighter =
      data.find((f: any) => (f.name || '').toLowerCase() === searchLower) ||
      data[0];

    const wins = fighter.record_wins;
    const losses = fighter.record_losses;
    if (wins == null || losses == null) return null;

    const record = formatRecord(
      wins,
      losses,
      fighter.record_draws,
      fighter.record_no_contests
    );
    return { name: fighter.name || search, record };
  } catch (error) {
    logger.debug({
      message: 'UFC fighter record fetch failed',
      name: search,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Get fighter record from cache. Returns '0-0' if not cached.
 * Sync, non-blocking.
 */
export function getFighterRecord(name: string): string {
  if (!name || !name.trim()) return '0-0';
  const key = normalizeName(name);
  return recordCache.get(key) ?? '0-0';
}

/**
 * Get fighter display name from DB cache (Ball Don't Lie canonical name).
 * Returns null if not found; caller should fallback to current method.
 * Sync, non-blocking.
 */
export function getFighterDisplayName(identifier: string): string | null {
  if (!identifier || !identifier.trim()) return null;
  const normId = normalizeName(identifier);
  const exact = displayNameCache.get(normId);
  if (exact) return exact;

  const abbrBase = normId.replace(/\d+$/, ''); // e.g. "jai3" -> "jai" for slug abbrevs

  for (const [norm, display] of displayNameCache) {
    if (norm === normId || norm.includes(normId) || normId.includes(norm)) return display;
    if (norm.endsWith(' ' + normId) || norm.split(/\s+/).pop() === normId) return display;
    const parts = display.split(/\s+/);
    for (const p of parts) {
      const pLower = p.toLowerCase();
      if (pLower.startsWith(normId) || pLower.startsWith(abbrBase)) return display;
    }
  }
  return null;
}

/**
 * Load fighter records from database into cache.
 * Called on init; safe to call in development (no-op).
 */
export async function loadFromDatabase(): Promise<void> {
  if (!isProduction() || dbLoaded) return;

  try {
    const result = await pool.query(
      'SELECT name_normalized, display_name, record FROM ufc_fighter_records'
    );
    for (const row of result.rows) {
      const key = row.name_normalized;
      const record = row.record;
      if (key && record) recordCache.set(key, record);
    }
    dbLoaded = true;
    logger.info({
      message: 'UFC fighter records loaded from database',
      count: result.rows.length,
    });
  } catch (error) {
    logger.warn({
      message: 'Could not load UFC fighter records from database',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Prefetch fighter records, update cache, and bulk upsert to database.
 * Single connection; all chunking done before connect.
 * Non-blocking: runs in background, does not block caller.
 */
export function prefetchAndPersistFighterRecords(names: string[]): void {
  const apiKey = getApiKey();
  if (!apiKey) return;

  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length === 0) return;

  (async () => {
    const concurrency = 3;
    const results: Array<{ nameNormalized: string; displayName: string; record: string }> = [];

    for (let i = 0; i < unique.length; i += concurrency) {
      const batch = unique.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        batch.map(async (name) => {
          const data = await fetchFighterRecord(name);
          if (data) {
            const key = normalizeName(data.name);
            recordCache.set(key, data.record);
            displayNameCache.set(key, data.name);
            return { nameNormalized: key, displayName: data.name, record: data.record };
          }
          return null;
        })
      );
      settled.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
        if (r.status === 'rejected') {
          logger.debug({
            message: 'UFC prefetch batch item failed',
            name: batch[idx],
            error: r.reason?.message,
          });
        }
      });
    }

    if (results.length === 0 || !isProduction()) return;

    // Deduplicate by name_normalized (ON CONFLICT cannot affect same row twice in one INSERT)
    const deduped = Array.from(
      new Map(results.map((r) => [r.nameNormalized, r])).values()
    );

    try {
      const client = await connectWithRetry(3, 50);
      try {
        for (let i = 0; i < deduped.length; i += BULK_UPSERT_CHUNK_SIZE) {
          const chunk = deduped.slice(i, i + BULK_UPSERT_CHUNK_SIZE);
          const valuesClauses: string[] = [];
          const values: unknown[] = [];
          chunk.forEach((r, idx) => {
            const base = idx * 3;
            valuesClauses.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
            values.push(r.nameNormalized, r.displayName, r.record);
          });
          const query = `
            INSERT INTO ufc_fighter_records (name_normalized, display_name, record)
            VALUES ${valuesClauses.join(', ')}
            ON CONFLICT (name_normalized) DO UPDATE SET
              display_name = EXCLUDED.display_name,
              record = EXCLUDED.record,
              updated_at = CURRENT_TIMESTAMP
          `;
          await client.query(query, values);
        }
        logger.debug({
          message: 'UFC fighter records bulk upserted',
          count: results.length,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      logger.warn({
        message: 'UFC fighter records bulk upsert failed',
        count: results.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })().catch((err) => {
    logger.warn({
      message: 'UFC fighter records prefetch error',
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Fire-and-forget prefetch (no DB persist). Kept for backward compat.
 * Prefer prefetchAndPersistFighterRecords when running from teams-refresh.
 */
export function prefetchFighterRecords(names: string[]): void {
  prefetchAndPersistFighterRecords(names);
}

export interface UfcFighterRecord {
  displayName: string;
  record: string;
  nameNormalized: string;
}

/**
 * Get all UFC fighter records from database for API (e.g. GET /api/teams?league=ufc).
 * Returns empty array in development or on error.
 */
export async function getAllUfcFighterRecordsFromDatabase(): Promise<UfcFighterRecord[]> {
  if (!isProduction()) return [];

  try {
    const result = await pool.query(
      'SELECT display_name, record, name_normalized FROM ufc_fighter_records ORDER BY display_name'
    );
    return result.rows.map((r: any) => ({
      displayName: r.display_name || '',
      record: r.record || '0-0',
      nameNormalized: r.name_normalized || '',
    }));
  } catch (error) {
    logger.warn({
      message: 'Could not fetch UFC fighter records from database',
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Find UFC fighter by abbreviation.
 * Matches abbreviation against start of first/last name or name_normalized.
 * Returns null if not found.
 */
export async function getUfcFighterByAbbreviation(abbreviation: string): Promise<UfcFighterRecord | null> {
  const fighters = await getAllUfcFighterRecordsFromDatabase();
  const abbr = abbreviation.toUpperCase().trim();
  if (!abbr) return null;

  for (const f of fighters) {
    const nameUpper = f.displayName.toUpperCase();
    const norm = f.nameNormalized.toLowerCase();
    const abbrLower = abbr.toLowerCase();
    const parts = f.displayName.split(/\s+/);
    const firstPart = parts[0]?.toUpperCase().substring(0, abbr.length) || '';
    const lastPart = parts[parts.length - 1]?.toUpperCase().substring(0, abbr.length) || '';
    if (firstPart === abbr || lastPart === abbr || nameUpper.startsWith(abbr) || norm.includes(abbrLower))
      return f;
  }
  return null;
}
