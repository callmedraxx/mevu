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
        // With PgBouncer, we can have more client connections since PgBouncer pools server connections
        max: 50, // Increased since PgBouncer handles the actual PostgreSQL connections
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000, // 10 seconds
        // Add retry logic and better error handling
        allowExitOnIdle: false,
        // Keep connections alive
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
        // Note: statement_timeout removed from Pool config - PgBouncer doesn't support it as a startup parameter
        // We set it via SQL query after connection instead (see poolInstance.on('connect') below)
        // Also ensure no options object is passed that might include statement_timeout
      });
      
      // Handle pool errors
      poolInstance.on('error', (err) => {
        console.error('Unexpected error on idle client', err);
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

