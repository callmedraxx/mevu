/**
 * Quick script to check if sports games are in the database
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/mevu',
});

async function checkGames() {
  const client = await pool.connect();
  
  try {
    // Check if the game exists
    const gameSlug = 'nfl-gb-chi-2026-01-10';
    const result = await client.query(
      `SELECT id, slug, title, data_source, sport, start_date, active, closed, archived 
       FROM live_games 
       WHERE slug LIKE '%gb-chi%' OR slug LIKE 'nfl-gb-chi%'
       ORDER BY start_date 
       LIMIT 10`
    );
    
    console.log(`\n=== Games matching 'gb-chi' ===`);
    console.log(`Found ${result.rows.length} games:\n`);
    result.rows.forEach((row, i) => {
      console.log(`${i + 1}. ${row.slug}`);
      console.log(`   Title: ${row.title}`);
      console.log(`   Data Source: ${row.data_source || 'NULL'}`);
      console.log(`   Sport: ${row.sport || 'NULL'}`);
      console.log(`   Start Date: ${row.start_date || 'NULL'}`);
      console.log(`   Active: ${row.active}, Closed: ${row.closed}, Archived: ${row.archived}`);
      console.log('');
    });
    
    // Check all NFL games from 2026-01-10
    const jan10Result = await client.query(
      `SELECT id, slug, title, data_source, sport, start_date 
       FROM live_games 
       WHERE slug LIKE '%2026-01-10%' OR start_date::text LIKE '2026-01-10%'
       ORDER BY start_date 
       LIMIT 20`
    );
    
    console.log(`\n=== Games on 2026-01-10 ===`);
    console.log(`Found ${jan10Result.rows.length} games:\n`);
    jan10Result.rows.forEach((row, i) => {
      console.log(`${i + 1}. ${row.slug} (source: ${row.data_source || 'NULL'}, sport: ${row.sport || 'NULL'})`);
    });
    
    // Check total games count by data_source
    const countResult = await client.query(
      `SELECT data_source, COUNT(*) as count 
       FROM live_games 
       GROUP BY data_source 
       ORDER BY data_source`
    );
    
    console.log(`\n=== Games by Data Source ===`);
    countResult.rows.forEach(row => {
      console.log(`${row.data_source || 'NULL'}: ${row.count} games`);
    });
    
    // Check if data_source column exists
    const columnCheck = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'live_games' AND column_name = 'data_source'
    `);
    
    console.log(`\n=== Schema Check ===`);
    if (columnCheck.rows.length > 0) {
      console.log('✓ data_source column exists');
    } else {
      console.log('✗ data_source column does NOT exist - migration may not have run!');
    }
    
  } catch (error) {
    console.error('Error querying database:', error.message);
    if (error.message.includes('column "data_source" does not exist')) {
      console.error('\n⚠️  The data_source column does not exist! The migration needs to be run.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

checkGames().catch(console.error);

