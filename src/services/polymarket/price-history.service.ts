/**
 * Price History Service
 * Fetches, stores, and retrieves price history data from Polymarket CLOB API
 */

import { pool } from '../../config/database';
import { logger } from '../../config/logger';
import { polymarketClient } from './polymarket.client';
import { PriceHistoryResponse, PriceHistoryPoint } from './polymarket.types';

export interface StoredPriceHistoryPoint {
  timestamp: number;
  price: number;
}

/**
 * Request coalescing: prevents multiple concurrent requests for the same token/interval
 * from hammering the database with duplicate writes
 */
const inFlightRequests = new Map<string, Promise<PriceHistoryResponse>>();

/**
 * Generate a cache key for request coalescing
 */
function getCacheKey(clobTokenId: string, interval: string): string {
  return `${clobTokenId}:${interval}`;
}

/**
 * Semaphore to limit concurrent database writes across ALL tokens
 * This prevents lock contention when many different tokens are requested simultaneously
 */
const MAX_CONCURRENT_DB_WRITES = 3;
let activeDbWrites = 0;
const dbWriteQueue: Array<() => void> = [];

async function acquireDbWriteLock(): Promise<void> {
  if (activeDbWrites < MAX_CONCURRENT_DB_WRITES) {
    activeDbWrites++;
    return;
  }
  
  // Wait in queue
  return new Promise<void>((resolve) => {
    dbWriteQueue.push(() => {
      activeDbWrites++;
      resolve();
    });
  });
}

function releaseDbWriteLock(): void {
  activeDbWrites--;
  
  // Process next in queue if any
  const next = dbWriteQueue.shift();
  if (next) {
    next();
  }
}

/**
 * Minimum fidelity requirements for each interval
 * Polymarket CLOB API enforces these minimums
 */
const MIN_FIDELITY_BY_INTERVAL: Record<string, number> = {
  '1h': 1,   // 1 minute minimum
  '6h': 1,   // 1 minute minimum
  '1d': 1,   // 1 minute minimum
  '1w': 5,   // 5 minutes minimum
  '1m': 60,  // 1 hour minimum (estimate, may need adjustment)
  'max': 60, // 1 hour minimum for max range (estimate)
};

/**
 * Get the minimum fidelity required for an interval
 * Returns undefined if no minimum is required
 */
function getMinFidelityForInterval(interval: string): number | undefined {
  return MIN_FIDELITY_BY_INTERVAL[interval];
}

/**
 * Fetch price history from Polymarket CLOB API and store in database
 * Uses request coalescing to prevent multiple concurrent requests for the same token
 * from causing database lock contention
 */
export async function fetchAndStorePriceHistory(
  clobTokenId: string,
  interval: string,
  fidelity?: number
): Promise<PriceHistoryResponse> {
  const cacheKey = getCacheKey(clobTokenId, interval);
  
  // Check if there's already an in-flight request for this token/interval
  const existingRequest = inFlightRequests.get(cacheKey);
  if (existingRequest) {
    logger.debug({
      message: 'Request coalescing: reusing in-flight request',
      clobTokenId,
      interval,
    });
    return existingRequest;
  }

  // Create the actual fetch promise
  const fetchPromise = doFetchAndStorePriceHistory(clobTokenId, interval, fidelity);
  
  // Store it so other concurrent requests can reuse it
  inFlightRequests.set(cacheKey, fetchPromise);
  
  try {
    const result = await fetchPromise;
    return result;
  } finally {
    // Always clean up after the request completes (success or failure)
    inFlightRequests.delete(cacheKey);
  }
}

/**
 * Check if we have cached price history in database for this token
 * Returns the cached data if available, null otherwise
 */
async function getCachedPriceHistory(
  clobTokenId: string,
  interval: string
): Promise<PriceHistoryResponse | null> {
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) {
    return null;
  }

  // Calculate the time range based on interval
  const now = Math.floor(Date.now() / 1000);
  let startTs: number;
  
  switch (interval) {
    case '1h':
      startTs = now - 3600;
      break;
    case '6h':
      startTs = now - 6 * 3600;
      break;
    case '1d':
      startTs = now - 24 * 3600;
      break;
    case '1w':
      startTs = now - 7 * 24 * 3600;
      break;
    case '1m':
      startTs = now - 30 * 24 * 3600;
      break;
    case 'max':
      startTs = 0; // All time
      break;
    default:
      startTs = now - 24 * 3600; // Default to 1 day
  }

  const client = await pool.connect();
  try {
    // Check if we have data for this token in the requested time range
    const countResult = await client.query(
      `SELECT COUNT(*) as count FROM clob_price_history 
       WHERE clob_token_id = $1 AND timestamp >= $2`,
      [clobTokenId, startTs]
    );
    
    const count = parseInt(countResult.rows[0].count, 10);
    
    // If we have at least some data points, use cached data
    // For 1d interval with 1-minute fidelity, we expect ~1440 points
    // Accept if we have at least 10% of expected data
    const minPointsRequired = interval === '1h' ? 6 : interval === '6h' ? 36 : 144;
    
    if (count >= minPointsRequired) {
      // Fetch the cached data
      const result = await client.query(
        `SELECT timestamp, price FROM clob_price_history 
         WHERE clob_token_id = $1 AND timestamp >= $2
         ORDER BY timestamp ASC`,
        [clobTokenId, startTs]
      );
      
      logger.debug({
        message: 'Returning cached price history from database',
        clobTokenId,
        interval,
        pointCount: result.rows.length,
      });
      
      return {
        history: result.rows.map(row => ({
          t: parseInt(row.timestamp, 10),
          p: parseFloat(row.price),
        })),
      };
    }
    
    return null;
  } catch (error) {
    logger.error({
      message: 'Error checking cached price history',
      clobTokenId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null; // On error, proceed to fetch from Polymarket
  } finally {
    client.release();
  }
}

/**
 * Internal implementation of fetch and store
 * This is called only once per token/interval even if multiple requests come in concurrently
 * 
 * Flow:
 * 1. Check if we have cached data in DB -> return it if available
 * 2. If no cache, fetch from Polymarket
 * 3. Prepare data for storage (before acquiring DB connection)
 * 4. Store in database
 */
async function doFetchAndStorePriceHistory(
  clobTokenId: string,
  interval: string,
  fidelity?: number
): Promise<PriceHistoryResponse> {
  try {
    // Step 1: Check for cached data in database first
    const cachedData = await getCachedPriceHistory(clobTokenId, interval);
    if (cachedData) {
      return cachedData;
    }

    // Step 2: No cache, fetch from Polymarket
    // Determine effective fidelity - use provided value or minimum required
    const minFidelity = getMinFidelityForInterval(interval);
    let effectiveFidelity = fidelity;
    
    // If no fidelity provided and interval has a minimum, use the minimum
    if (effectiveFidelity === undefined && minFidelity !== undefined) {
      effectiveFidelity = minFidelity;
    }
    
    // If fidelity provided but less than minimum, use minimum
    if (effectiveFidelity !== undefined && minFidelity !== undefined && effectiveFidelity < minFidelity) {
      logger.warn({
        message: 'Requested fidelity below minimum, using minimum',
        requestedFidelity: fidelity,
        minFidelity,
        interval,
      });
      effectiveFidelity = minFidelity;
    }

    // Prepare params
    const params: {
      interval: string;
      fidelity?: number;
    } = {
      interval,
    };

    if (effectiveFidelity !== undefined) {
      params.fidelity = effectiveFidelity;
    }

    // Fetch from Polymarket CLOB API
    const response = await polymarketClient.getClobPriceHistory(clobTokenId, params);

    // Step 3: Store in database (only if we got data)
    if (response.history && response.history.length > 0) {
      await storePriceHistory(clobTokenId, response.history);
    }

    return response;
  } catch (error) {
    logger.error({
      message: 'Error fetching price history from Polymarket',
      clobTokenId,
      interval,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Pre-built batch structure for database insertion
 */
interface PreparedBatch {
  query: string;
  values: any[];
}

/**
 * Prepare all batches for insertion BEFORE acquiring any database resources
 * This minimizes the time we hold the connection and locks
 */
function prepareBatchesForInsert(
  clobTokenId: string,
  history: PriceHistoryPoint[]
): PreparedBatch[] {
  // Deduplicate by timestamp - keep the last occurrence (most recent price for that timestamp)
  const deduped = new Map<number, PriceHistoryPoint>();
  for (const point of history) {
    deduped.set(point.t, point);
  }
  const uniqueHistory = Array.from(deduped.values());

  const BATCH_SIZE = 500;
  const batches: PreparedBatch[] = [];

  for (let i = 0; i < uniqueHistory.length; i += BATCH_SIZE) {
    const batch = uniqueHistory.slice(i, i + BATCH_SIZE);
    
    // Build bulk insert query with multiple VALUES
    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const point of batch) {
      const rowPlaceholders: string[] = [];
      rowPlaceholders.push(`$${paramIndex++}`); // clob_token_id
      rowPlaceholders.push(`$${paramIndex++}`); // timestamp
      rowPlaceholders.push(`$${paramIndex++}`); // price
      rowPlaceholders.push('CURRENT_TIMESTAMP'); // created_at
      placeholders.push(`(${rowPlaceholders.join(', ')})`);

      values.push(clobTokenId, point.t, point.p);
    }

    const query = `
      INSERT INTO clob_price_history (
        clob_token_id,
        timestamp,
        price,
        created_at
      )
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (clob_token_id, timestamp) DO UPDATE SET
        price = EXCLUDED.price,
        created_at = EXCLUDED.created_at
    `;

    batches.push({ query, values });
  }

  return batches;
}

/**
 * Store price history points in database (upsert)
 * Uses a semaphore to limit concurrent writes and prevent lock contention
 * 
 * Optimization: All data preparation happens BEFORE acquiring pool connection
 */
async function storePriceHistory(
  clobTokenId: string,
  history: PriceHistoryPoint[]
): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    logger.warn({
      message: 'storePriceHistory called in development mode - data not persisted',
      clobTokenId,
      pointCount: history.length,
    });
    return;
  }

  if (history.length === 0) {
    return;
  }

  // STEP 1: Prepare all batches BEFORE acquiring any resources
  const batches = prepareBatchesForInsert(clobTokenId, history);
  
  if (batches.length === 0) {
    return;
  }

  // STEP 2: Acquire semaphore - limits concurrent DB writes across all tokens
  await acquireDbWriteLock();

  // STEP 3: Now acquire pool connection (only when ready to write)
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Execute pre-built batches
    for (const batch of batches) {
      await client.query(batch.query, batch.values);
    }
    
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error({
        message: 'Error during ROLLBACK in storePriceHistory',
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
    logger.error({
      message: 'Error storing price history in database',
      clobTokenId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  } finally {
    client.release();
    releaseDbWriteLock(); // Always release the semaphore
  }
}

/**
 * Get price history from database by clobTokenId
 * Optional startTs and endTs for filtering by time range
 */
export async function getPriceHistoryFromDatabase(
  clobTokenId: string,
  startTs?: number,
  endTs?: number
): Promise<StoredPriceHistoryPoint[]> {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    logger.warn({
      message: 'getPriceHistoryFromDatabase called in development mode - returning empty array',
      clobTokenId,
    });
    return [];
  }

  const client = await pool.connect();

  try {
    let query = `
      SELECT timestamp, price
      FROM clob_price_history
      WHERE clob_token_id = $1
    `;
    const params: any[] = [clobTokenId];
    let paramIndex = 2;

    if (startTs !== undefined) {
      query += ` AND timestamp >= $${paramIndex++}`;
      params.push(startTs);
    }

    if (endTs !== undefined) {
      query += ` AND timestamp <= $${paramIndex++}`;
      params.push(endTs);
    }

    query += ` ORDER BY timestamp ASC`;

    const result = await client.query(query, params);

    return result.rows.map((row) => ({
      timestamp: parseInt(row.timestamp, 10),
      price: parseFloat(row.price),
    }));
  } catch (error) {
    logger.error({
      message: 'Error getting price history from database',
      clobTokenId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

