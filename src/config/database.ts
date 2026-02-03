/**
 * Database configuration
 * In development: uses in-memory storage
 * In production: uses PostgreSQL
 */

import { Pool } from 'pg';

export interface DatabaseConfig {
  type: 'memory' | 'postgres';
  connectionString?: string;
}

export const getDatabaseConfig = (): DatabaseConfig => {
  const nodeEnv = process.env.NODE_ENV || 'development';
  
  if (nodeEnv === 'production') {
    return {
      type: 'postgres',
      connectionString: process.env.DATABASE_URL,
    };
  }
  
  // Development: use in-memory storage
  return {
    type: 'memory',
  };
};

// PostgreSQL connection pool (only created in production)
let poolInstance: Pool | null = null;

export const pool: Pool = (() => {
  const nodeEnv = process.env.NODE_ENV || 'development';
  
  if (nodeEnv === 'production') {
    if (!poolInstance) {
      // Parse connection string to ensure no statement_timeout is in it
      const connectionString = process.env.DATABASE_URL || '';
      
      poolInstance = new Pool({
        connectionString,
        // Per-worker pool size. 4 workers × 25 = 100 connections to PgBouncer.
        // Reduced from 200 to prevent connection pool exhaustion and PgBouncer timeout issues.
        max: Number(process.env.DATABASE_POOL_MAX) || 25,
        min: Number(process.env.DATABASE_POOL_MIN) || 2,
        // Idle timeout MUST be shorter than PgBouncer's client_idle_timeout (usually 300s).
        // Set to 10 seconds to release connections quickly and avoid stale connection errors.
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 15000,  // Increased for high load
        allowExitOnIdle: false,
        keepAlive: true,
        // Send keepalive every 5 seconds to prevent PgBouncer from closing the connection.
        // This must be shorter than PgBouncer's client_idle_timeout.
        keepAliveInitialDelayMillis: 5000,
        // Limit connection reuse to prevent issues with long-lived connections
        maxUses: 5000,
        // Note: statement_timeout removed from Pool config - PgBouncer doesn't support it as a startup parameter
        // We set it via SQL query after connection instead (see poolInstance.on('connect') below)
        // Also ensure no options object is passed that might include statement_timeout
      });
      
      // Handle pool errors
      // PgBouncer sends client_idle_timeout errors when connections are idle too long.
      // These are expected and the pool will create new connections as needed.
      poolInstance.on('error', (err: Error & { code?: string }) => {
        const isIdleTimeout = err.message?.includes('client_idle_timeout') || err.code === '08P01';
        if (isIdleTimeout) {
          // This is expected with PgBouncer - the connection was idle and got closed.
          // The pool will create a new connection when needed. No action required.
          console.log('PgBouncer closed idle connection (expected behavior)');
        } else {
          console.error('Unexpected error on idle client error:', err.message || err);
        }
      });
      
      poolInstance.on('connect', async (client) => {
        // console.log('Database connection established');
        // Set statement timeout on each new connection to prevent stuck transactions
        try {
          await client.query('SET statement_timeout = 30000'); // 30 seconds
        } catch (err) {
          console.error('Failed to set statement timeout on connection', err);
        }
      });
      
      // poolInstance.on('acquire', () => {
      //   console.log('Database connection acquired from pool');
      // });
      
      // poolInstance.on('remove', () => {
      //   console.log('Database connection removed from pool');
      // });
    }
    return poolInstance;
  }
  
  // In development, return a mock pool that throws errors
  // This ensures code doesn't break but makes it clear we're using in-memory storage
  return {
    connect: async () => {
      throw new Error('Database pool not available in development mode. Use in-memory storage instead.');
    },
  } as unknown as Pool;
})();

// In-memory storage for development
export const memoryStore = new Map<string, any>();

/**
 * Wrapper around pool.connect() with retry logic and exponential backoff
 * This prevents connection pool exhaustion during startup when many services
 * try to connect simultaneously
 */
export async function connectWithRetry(
  maxRetries: number = 3,
  initialDelay: number = 100
): Promise<any> {
  const nodeEnv = process.env.NODE_ENV || 'development';
  
  if (nodeEnv !== 'production') {
    throw new Error('Database pool not available in development mode. Use in-memory storage instead.');
  }
  
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Exponential backoff: 100ms, 200ms, 400ms
        const delay = initialDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      return await pool.connect();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Don't retry on non-retryable errors
      const errorMessage = lastError.message.toLowerCase();
      if (errorMessage.includes('password') || 
          errorMessage.includes('authentication') ||
          errorMessage.includes('permission denied')) {
        throw lastError;
      }
      
      // If this was the last attempt, throw the error
      if (attempt === maxRetries) {
        throw lastError;
      }
    }
  }
  
  throw lastError || new Error('Failed to connect to database after retries');
}

