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
 */
export async function fetchAndStorePriceHistory(
  clobTokenId: string,
  interval: string,
  fidelity?: number
): Promise<PriceHistoryResponse> {
  try {
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

    logger.info({
      message: 'Fetching price history from Polymarket',
      clobTokenId,
      interval,
      requestedFidelity: fidelity,
      effectiveFidelity,
    });

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

    // Store in database
    if (response.history && response.history.length > 0) {
      await storePriceHistory(clobTokenId, response.history);
    }

    logger.info({
      message: 'Price history fetched and stored',
      clobTokenId,
      interval,
      pointCount: response.history?.length || 0,
    });

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
 * Store price history points in database (upsert)
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

  // Deduplicate by timestamp - keep the last occurrence (most recent price for that timestamp)
  const deduped = new Map<number, PriceHistoryPoint>();
  for (const point of history) {
    deduped.set(point.t, point);
  }
  const uniqueHistory = Array.from(deduped.values());

  if (uniqueHistory.length !== history.length) {
    logger.debug({
      message: 'Deduplicated price history before storing',
      clobTokenId,
      originalCount: history.length,
      dedupedCount: uniqueHistory.length,
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Build bulk insert query with multiple VALUES
    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const point of uniqueHistory) {
      const rowPlaceholders: string[] = [];
      rowPlaceholders.push(`$${paramIndex++}`); // clob_token_id
      rowPlaceholders.push(`$${paramIndex++}`); // timestamp
      rowPlaceholders.push(`$${paramIndex++}`); // price
      rowPlaceholders.push('CURRENT_TIMESTAMP'); // created_at
      placeholders.push(`(${rowPlaceholders.join(', ')})`);

      values.push(clobTokenId, point.t, point.p);
    }

    const insertQuery = `
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

    await client.query(insertQuery, values);
    await client.query('COMMIT');

    logger.debug({
      message: 'Price history stored in database',
      clobTokenId,
      pointCount: uniqueHistory.length,
    });
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

