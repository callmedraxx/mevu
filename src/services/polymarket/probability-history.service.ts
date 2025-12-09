/**
 * Probability History Service
 * Tracks probability changes over time for calculating percent change
 */

import { pool } from '../../config/database';
import { logger } from '../../config/logger';

export interface ProbabilitySnapshot {
  gameId: string;
  homeProbability: number;
  awayProbability: number;
  homeBuyPrice: number;
  awayBuyPrice: number;
  recordedAt: Date;
}

export interface ProbabilityChange {
  homeCurrentProb: number;
  homePastProb: number;
  homePercentChange: number;
  awayCurrentProb: number;
  awayPastProb: number;
  awayPercentChange: number;
}

// In-memory storage for development
const inMemoryHistory: Map<string, ProbabilitySnapshot[]> = new Map();

// Cache for recent probability lookups (reduce DB queries)
const probabilityCache: Map<string, { data: ProbabilityChange; timestamp: number }> = new Map();
const CACHE_TTL = 60000; // 1 minute cache

/**
 * Initialize the probability history table
 */
export async function initializeProbabilityHistoryTable(): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (!isProduction) {
    logger.info({ message: 'Skipping probability history table init in development' });
    return;
  }
  
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS game_probability_history (
        id SERIAL PRIMARY KEY,
        game_id VARCHAR(255) NOT NULL,
        home_probability DECIMAL(5, 2) NOT NULL,
        away_probability DECIMAL(5, 2) NOT NULL,
        home_buy_price INTEGER NOT NULL,
        away_buy_price INTEGER NOT NULL,
        recorded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_probability_history_game_time 
      ON game_probability_history(game_id, recorded_at DESC)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_probability_history_recorded_at 
      ON game_probability_history(recorded_at)
    `);
    
    logger.info({ message: 'Probability history table initialized' });
  } catch (error) {
    logger.error({
      message: 'Error initializing probability history table',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    client.release();
  }
}

/**
 * Record a probability snapshot for a game
 */
export async function recordProbabilitySnapshot(
  gameId: string,
  homeProbability: number,
  awayProbability: number,
  homeBuyPrice: number,
  awayBuyPrice: number
): Promise<void> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  const snapshot: ProbabilitySnapshot = {
    gameId,
    homeProbability,
    awayProbability,
    homeBuyPrice,
    awayBuyPrice,
    recordedAt: new Date(),
  };
  
  if (isProduction) {
    await recordSnapshotToDatabase(snapshot);
  } else {
    recordSnapshotToMemory(snapshot);
  }
}

/**
 * Record snapshot to database
 */
async function recordSnapshotToDatabase(snapshot: ProbabilitySnapshot): Promise<void> {
  const client = await pool.connect();
  try {
    // Check if we already have a recent snapshot (within last 5 minutes)
    // to avoid storing too many records
    const recentCheck = await client.query(
      `SELECT id FROM game_probability_history 
       WHERE game_id = $1 
       AND recorded_at > NOW() - INTERVAL '5 minutes'
       AND home_probability = $2
       AND away_probability = $3
       LIMIT 1`,
      [snapshot.gameId, snapshot.homeProbability, snapshot.awayProbability]
    );
    
    // Skip if we have a recent identical snapshot
    if (recentCheck.rows.length > 0) {
      return;
    }
    
    await client.query(
      `INSERT INTO game_probability_history 
       (game_id, home_probability, away_probability, home_buy_price, away_buy_price, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        snapshot.gameId,
        snapshot.homeProbability,
        snapshot.awayProbability,
        snapshot.homeBuyPrice,
        snapshot.awayBuyPrice,
        snapshot.recordedAt,
      ]
    );
    
    logger.debug({
      message: 'Recorded probability snapshot',
      gameId: snapshot.gameId,
      homeProb: snapshot.homeProbability,
      awayProb: snapshot.awayProbability,
    });
  } catch (error) {
    // Don't throw - probability tracking shouldn't break main flow
    logger.error({
      message: 'Error recording probability snapshot',
      gameId: snapshot.gameId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    client.release();
  }
}

/**
 * Record snapshot to in-memory storage (development)
 */
function recordSnapshotToMemory(snapshot: ProbabilitySnapshot): void {
  const history = inMemoryHistory.get(snapshot.gameId) || [];
  
  // Check for recent identical snapshot
  const lastSnapshot = history[history.length - 1];
  if (lastSnapshot) {
    const timeDiff = snapshot.recordedAt.getTime() - lastSnapshot.recordedAt.getTime();
    const probsSame = lastSnapshot.homeProbability === snapshot.homeProbability &&
                      lastSnapshot.awayProbability === snapshot.awayProbability;
    
    // Skip if identical within 5 minutes
    if (probsSame && timeDiff < 5 * 60 * 1000) {
      return;
    }
  }
  
  history.push(snapshot);
  
  // Keep only last 48 hours of data (assuming snapshots every 5 mins = ~576 records max)
  const cutoffTime = Date.now() - 48 * 60 * 60 * 1000;
  const filtered = history.filter(s => s.recordedAt.getTime() > cutoffTime);
  
  inMemoryHistory.set(snapshot.gameId, filtered);
  
  logger.debug({
    message: 'Recorded probability snapshot to memory',
    gameId: snapshot.gameId,
    homeProb: snapshot.homeProbability,
    historyLength: filtered.length,
  });
}

/**
 * Get probability from X hours ago
 */
export async function getProbabilityFromHoursAgo(
  gameId: string,
  hoursAgo: number = 24
): Promise<ProbabilitySnapshot | null> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (isProduction) {
    return getProbabilityFromDatabaseHoursAgo(gameId, hoursAgo);
  } else {
    return getProbabilityFromMemoryHoursAgo(gameId, hoursAgo);
  }
}

/**
 * Get probability from database X hours ago
 */
async function getProbabilityFromDatabaseHoursAgo(
  gameId: string,
  hoursAgo: number
): Promise<ProbabilitySnapshot | null> {
  const client = await pool.connect();
  try {
    // Get the oldest snapshot that's at least hoursAgo old
    // Or the first snapshot if game is newer than hoursAgo
    const result = await client.query(
      `SELECT 
        game_id, home_probability, away_probability, 
        home_buy_price, away_buy_price, recorded_at
       FROM game_probability_history
       WHERE game_id = $1
       AND recorded_at <= NOW() - INTERVAL '${hoursAgo} hours'
       ORDER BY recorded_at DESC
       LIMIT 1`,
      [gameId]
    );
    
    // If no snapshot from X hours ago, get the first recorded snapshot
    if (result.rows.length === 0) {
      const firstResult = await client.query(
        `SELECT 
          game_id, home_probability, away_probability, 
          home_buy_price, away_buy_price, recorded_at
         FROM game_probability_history
         WHERE game_id = $1
         ORDER BY recorded_at ASC
         LIMIT 1`,
        [gameId]
      );
      
      if (firstResult.rows.length === 0) {
        return null;
      }
      
      const row = firstResult.rows[0];
      return {
        gameId: row.game_id,
        homeProbability: parseFloat(row.home_probability),
        awayProbability: parseFloat(row.away_probability),
        homeBuyPrice: row.home_buy_price,
        awayBuyPrice: row.away_buy_price,
        recordedAt: new Date(row.recorded_at),
      };
    }
    
    const row = result.rows[0];
    return {
      gameId: row.game_id,
      homeProbability: parseFloat(row.home_probability),
      awayProbability: parseFloat(row.away_probability),
      homeBuyPrice: row.home_buy_price,
      awayBuyPrice: row.away_buy_price,
      recordedAt: new Date(row.recorded_at),
    };
  } catch (error) {
    logger.error({
      message: 'Error getting probability from database',
      gameId,
      hoursAgo,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    client.release();
  }
}

/**
 * Get probability from memory X hours ago
 */
function getProbabilityFromMemoryHoursAgo(
  gameId: string,
  hoursAgo: number
): ProbabilitySnapshot | null {
  const history = inMemoryHistory.get(gameId);
  if (!history || history.length === 0) {
    return null;
  }
  
  const targetTime = Date.now() - hoursAgo * 60 * 60 * 1000;
  
  // Find the snapshot closest to hoursAgo
  let closestSnapshot: ProbabilitySnapshot | null = null;
  let closestDiff = Infinity;
  
  for (const snapshot of history) {
    const diff = Math.abs(snapshot.recordedAt.getTime() - targetTime);
    if (snapshot.recordedAt.getTime() <= targetTime && diff < closestDiff) {
      closestDiff = diff;
      closestSnapshot = snapshot;
    }
  }
  
  // If no snapshot from X hours ago, return the first snapshot
  if (!closestSnapshot && history.length > 0) {
    closestSnapshot = history[0];
  }
  
  return closestSnapshot;
}

/**
 * Calculate probability change for a game
 */
export async function calculateProbabilityChange(
  gameId: string,
  currentHomeProb: number,
  currentAwayProb: number,
  hoursAgo: number = 24
): Promise<ProbabilityChange> {
  // Check cache first
  const cacheKey = `${gameId}-${hoursAgo}`;
  const cached = probabilityCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    // Update current values in cached result
    return {
      ...cached.data,
      homeCurrentProb: currentHomeProb,
      awayCurrentProb: currentAwayProb,
      homePercentChange: calculatePercentDiff(cached.data.homePastProb, currentHomeProb),
      awayPercentChange: calculatePercentDiff(cached.data.awayPastProb, currentAwayProb),
    };
  }
  
  const pastSnapshot = await getProbabilityFromHoursAgo(gameId, hoursAgo);
  
  let homePastProb = currentHomeProb;
  let awayPastProb = currentAwayProb;
  
  if (pastSnapshot) {
    homePastProb = pastSnapshot.homeProbability;
    awayPastProb = pastSnapshot.awayProbability;
  }
  
  const result: ProbabilityChange = {
    homeCurrentProb: currentHomeProb,
    homePastProb,
    homePercentChange: calculatePercentDiff(homePastProb, currentHomeProb),
    awayCurrentProb: currentAwayProb,
    awayPastProb,
    awayPercentChange: calculatePercentDiff(awayPastProb, currentAwayProb),
  };
  
  // Cache the result
  probabilityCache.set(cacheKey, { data: result, timestamp: Date.now() });
  
  return result;
}

/**
 * Calculate percent difference between two values
 */
function calculatePercentDiff(oldValue: number, newValue: number): number {
  if (oldValue === 0) return 0;
  const diff = ((newValue - oldValue) / oldValue) * 100;
  return Number(diff.toFixed(1));
}

/**
 * Cleanup old probability history records
 * Call this periodically to prevent unbounded growth
 */
export async function cleanupOldProbabilityHistory(daysToKeep: number = 7): Promise<number> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (!isProduction) {
    // Clean up in-memory storage
    const cutoffTime = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    let removedCount = 0;
    
    for (const [gameId, history] of inMemoryHistory.entries()) {
      const before = history.length;
      const filtered = history.filter(s => s.recordedAt.getTime() > cutoffTime);
      inMemoryHistory.set(gameId, filtered);
      removedCount += before - filtered.length;
    }
    
    return removedCount;
  }
  
  const client = await pool.connect();
  try {
    const result = await client.query(
      `DELETE FROM game_probability_history 
       WHERE recorded_at < NOW() - INTERVAL '${daysToKeep} days'`
    );
    
    const removedCount = result.rowCount || 0;
    
    if (removedCount > 0) {
      logger.info({
        message: 'Cleaned up old probability history',
        removedCount,
        daysToKeep,
      });
    }
    
    return removedCount;
  } catch (error) {
    logger.error({
      message: 'Error cleaning up probability history',
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  } finally {
    client.release();
  }
}

/**
 * Get statistics about probability history
 */
export async function getProbabilityHistoryStats(): Promise<{
  totalRecords: number;
  uniqueGames: number;
  oldestRecord: Date | null;
}> {
  const isProduction = process.env.NODE_ENV === 'production';
  
  if (!isProduction) {
    let totalRecords = 0;
    let oldestRecord: Date | null = null;
    
    for (const history of inMemoryHistory.values()) {
      totalRecords += history.length;
      for (const snapshot of history) {
        if (!oldestRecord || snapshot.recordedAt < oldestRecord) {
          oldestRecord = snapshot.recordedAt;
        }
      }
    }
    
    return {
      totalRecords,
      uniqueGames: inMemoryHistory.size,
      oldestRecord,
    };
  }
  
  const client = await pool.connect();
  try {
    const statsResult = await client.query(`
      SELECT 
        COUNT(*) as total_records,
        COUNT(DISTINCT game_id) as unique_games,
        MIN(recorded_at) as oldest_record
      FROM game_probability_history
    `);
    
    const row = statsResult.rows[0];
    return {
      totalRecords: parseInt(row.total_records, 10),
      uniqueGames: parseInt(row.unique_games, 10),
      oldestRecord: row.oldest_record ? new Date(row.oldest_record) : null,
    };
  } catch (error) {
    logger.error({
      message: 'Error getting probability history stats',
      error: error instanceof Error ? error.message : String(error),
    });
    return { totalRecords: 0, uniqueGames: 0, oldestRecord: null };
  } finally {
    client.release();
  }
}

// Export for use in other services
export const probabilityHistoryService = {
  initialize: initializeProbabilityHistoryTable,
  recordSnapshot: recordProbabilitySnapshot,
  getProbabilityFromHoursAgo,
  calculateChange: calculateProbabilityChange,
  cleanup: cleanupOldProbabilityHistory,
  getStats: getProbabilityHistoryStats,
};

