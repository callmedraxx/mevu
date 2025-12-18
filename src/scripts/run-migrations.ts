/**
 * Database migration runner
 * Runs all SQL migration files in order
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { pool } from '../config/database';
import { logger } from '../config/logger';

const MIGRATIONS_DIR = join(__dirname, '../../migrations');

interface Migration {
  filename: string;
  number: number;
  sql: string;
}

async function getMigrations(): Promise<Migration[]> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(file => file.endsWith('.sql'))
    .sort(); // Sort alphabetically to ensure order

  return files.map(filename => {
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf-8');
    // Extract number from filename (e.g., "001_create_teams_table.sql" -> 1)
    const match = filename.match(/^(\d+)_/);
    const number = match ? parseInt(match[1], 10) : 0;
    
    return { filename, number, sql };
  }).sort((a, b) => a.number - b.number);
}

async function createMigrationsTable(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } finally {
    client.release();
  }
}

async function getAppliedMigrations(): Promise<number[]> {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    return result.rows.map(row => row.version);
  } catch (error) {
    // Table doesn't exist yet, return empty array
    return [];
  } finally {
    client.release();
  }
}

async function recordMigration(version: number, filename: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO schema_migrations (version, filename) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
      [version, filename]
    );
  } finally {
    client.release();
  }
}

async function runMigration(migration: Migration): Promise<void> {
  const client = await pool.connect();
  try {
    logger.info({
      message: 'Running migration',
      filename: migration.filename,
      version: migration.number,
    });

    // Run the migration SQL
    await client.query(migration.sql);

    // Record that this migration was applied
    await recordMigration(migration.number, migration.filename);

    logger.info({
      message: 'Migration completed',
      filename: migration.filename,
      version: migration.number,
    });
  } catch (error) {
    logger.error({
      message: 'Migration failed',
      filename: migration.filename,
      version: migration.number,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

async function runMigrations(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV || 'development';
  
  if (nodeEnv !== 'production') {
    logger.warn({
      message: 'Migrations only run in production mode',
      nodeEnv,
    });
    return;
  }

  try {
    logger.info({ message: 'Starting database migrations' });

    // Create migrations tracking table
    await createMigrationsTable();

    // Get all migrations and applied migrations
    const migrations = await getMigrations();
    const applied = await getAppliedMigrations();

    logger.info({
      message: 'Migration status',
      totalMigrations: migrations.length,
      appliedMigrations: applied.length,
    });

    // Run pending migrations
    for (const migration of migrations) {
      if (!applied.includes(migration.number)) {
        await runMigration(migration);
      } else {
        logger.info({
          message: 'Migration already applied, skipping',
          filename: migration.filename,
          version: migration.number,
        });
      }
    }

    logger.info({ message: 'All migrations completed' });
  } catch (error) {
    logger.error({
      message: 'Migration process failed',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (require.main === module) {
      // Only exit if running as standalone script
      process.exit(1);
    } else {
      // If called from another module, just throw
      throw error;
    }
  }
  // Don't close the pool if called from another module (like index.ts)
  if (require.main === module) {
    await pool.end();
  }
}

// Run migrations if this script is executed directly
if (require.main === module) {
  runMigrations()
    .then(() => {
      logger.info({ message: 'Migration script completed successfully' });
      process.exit(0);
    })
    .catch((error) => {
      logger.error({
        message: 'Migration script failed',
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
}

export { runMigrations };
