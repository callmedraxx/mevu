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
      poolInstance = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      });
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

