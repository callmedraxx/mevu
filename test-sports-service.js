/**
 * Test the sports games service end-to-end
 */

const { Pool } = require('pg');
require('dotenv').config();

// Import the sports games service functions
// We'll need to test this manually since we can't easily import TypeScript

async function checkService() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/mevu',
  });

  try {
    const client = await pool.connect();
    
    // Check when sports games were last added
    const lastSportsGames = await client.query(
      `SELECT MAX(updated_at) as last_update, COUNT(*) as count 
       FROM live_games 
       WHERE data_source = 'sports_games'`
    );
    
    console.log('\n=== Sports Games Service Status ===');
    console.log(`Total games with data_source='sports_games': ${lastSportsGames.rows[0].count}`);
    console.log(`Last update: ${lastSportsGames.rows[0].last_update || 'Never'}`);
    
    // Check recent games to see if they're from live_games or sports_games
    const recentGames = await client.query(
      `SELECT slug, title, data_source, sport, start_date, updated_at 
       FROM live_games 
       WHERE slug LIKE '%2026-01-10%' OR slug LIKE '%2026-01-11%'
       ORDER BY updated_at DESC 
       LIMIT 20`
    );
    
    console.log(`\n=== Recent Games (Jan 10-11) ===`);
    console.log(`Found ${recentGames.rows.length} games:\n`);
    recentGames.rows.forEach((row, i) => {
      console.log(`${i + 1}. ${row.slug}`);
      console.log(`   Source: ${row.data_source || 'NULL'}`);
      console.log(`   Sport: ${row.sport || 'NULL'}`);
      console.log(`   Updated: ${row.updated_at}`);
      console.log('');
    });
    
    // Check if nfl-gb-chi-2026-01-10 exists
    const targetGame = await client.query(
      `SELECT id, slug, title, data_source, sport, start_date, updated_at 
       FROM live_games 
       WHERE slug = 'nfl-gb-chi-2026-01-10'`
    );
    
    console.log(`\n=== Target Game: nfl-gb-chi-2026-01-10 ===`);
    if (targetGame.rows.length > 0) {
      const game = targetGame.rows[0];
      console.log(`✓ Found in database!`);
      console.log(`  ID: ${game.id}`);
      console.log(`  Title: ${game.title}`);
      console.log(`  Data Source: ${game.data_source || 'NULL'}`);
      console.log(`  Sport: ${game.sport || 'NULL'}`);
      console.log(`  Start Date: ${game.start_date}`);
      console.log(`  Last Updated: ${game.updated_at}`);
    } else {
      console.log('✗ NOT found in database');
    }
    
    // Check if migrations have run
    const migrations = await client.query(
      `SELECT version, filename, applied_at 
       FROM schema_migrations 
       WHERE version = 25 
       ORDER BY applied_at DESC 
       LIMIT 1`
    );
    
    console.log(`\n=== Migration 025 Status ===`);
    if (migrations.rows.length > 0) {
      console.log('✓ Migration 025 has been applied');
      console.log(`  Filename: ${migrations.rows[0].filename}`);
      console.log(`  Applied at: ${migrations.rows[0].applied_at}`);
    } else {
      console.log('✗ Migration 025 has NOT been applied!');
    }
    
    client.release();
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

checkService().catch(console.error);

