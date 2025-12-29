/**
 * Script to check period_scores for a specific game
 * Usage: NODE_ENV=production ts-node scripts/check-period-scores.ts <game-slug>
 * Example: NODE_ENV=production ts-node scripts/check-period-scores.ts nba-cle-nyk-2025-12-25
 */

import { pool } from '../src/config/database';

async function checkPeriodScores(gameSlug: string) {
  const client = await pool.connect();
  
  try {
    // Query by slug (case-insensitive)
    const result = await client.query(
      `SELECT 
        id,
        slug,
        title,
        period,
        score,
        period_scores,
        updated_at
      FROM live_games 
      WHERE LOWER(slug) = LOWER($1)`,
      [gameSlug]
    );
    
    if (result.rows.length === 0) {
      console.log(`Game not found: ${gameSlug}`);
      return;
    }
    
    const game = result.rows[0];
    console.log('\n=== Game Information ===');
    console.log(`ID: ${game.id}`);
    console.log(`Slug: ${game.slug}`);
    console.log(`Title: ${game.title}`);
    console.log(`Current Period: ${game.period}`);
    console.log(`Current Score: ${game.score}`);
    console.log(`Last Updated: ${game.updated_at}`);
    
    console.log('\n=== Period Scores (from database) ===');
    if (game.period_scores) {
      const periodScores = typeof game.period_scores === 'string' 
        ? JSON.parse(game.period_scores)
        : game.period_scores;
      
      console.log(JSON.stringify(periodScores, null, 2));
      
      // Analyze what's missing
      console.log('\n=== Analysis ===');
      const expectedPeriods = ['q1', 'q2', 'ht', 'q3', 'q4', 'final'];
      const presentPeriods = Object.keys(periodScores);
      const missingPeriods = expectedPeriods.filter(p => !presentPeriods.includes(p));
      
      console.log(`Present periods: ${presentPeriods.join(', ') || 'none'}`);
      console.log(`Missing periods: ${missingPeriods.join(', ') || 'none'}`);
      
      if (missingPeriods.length > 0) {
        console.log('\n⚠️  Missing periods likely weren\'t captured before the fix was deployed.');
        console.log('   The fix ensures future period transitions will be captured correctly.');
      }
      
      // Check if current period is in period_scores
      const currentPeriodLower = (game.period || '').toLowerCase();
      let currentPeriodKey = currentPeriodLower;
      if (currentPeriodLower.startsWith('end ')) {
        currentPeriodKey = currentPeriodLower.replace(/^end\s+/, '').trim();
      }
      if (currentPeriodKey === 'q1' || currentPeriodKey === '1q' || currentPeriodKey === '1st') currentPeriodKey = 'q1';
      if (currentPeriodKey === 'q2' || currentPeriodKey === '2q' || currentPeriodKey === '2nd') currentPeriodKey = 'q2';
      if (currentPeriodKey === 'q3' || currentPeriodKey === '3q' || currentPeriodKey === '3rd') currentPeriodKey = 'q3';
      if (currentPeriodKey === 'q4' || currentPeriodKey === '4q' || currentPeriodKey === '4th') currentPeriodKey = 'q4';
      if (currentPeriodKey === 'ht' || currentPeriodKey === 'halftime' || currentPeriodKey === 'half') currentPeriodKey = 'ht';
      
      if (presentPeriods.includes(currentPeriodKey)) {
        console.log(`\n✓ Current period (${currentPeriodKey}) is tracked in period_scores`);
      } else if (game.period && game.period !== 'NS') {
        console.log(`\n⚠️  Current period (${currentPeriodKey}) is NOT in period_scores yet`);
        console.log('   This is expected if the period is ongoing - it will be snapshotted when the period changes.');
      }
    } else {
      console.log('No period_scores stored yet');
      console.log('\n=== Analysis ===');
      console.log('Period scores will be calculated when:');
      console.log('  1. Period or score changes via WebSocket update');
      console.log('  2. Or when the game is initially stored with score/period data');
    }
    
  } catch (error) {
    console.error('Error checking period scores:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Get game slug from command line
const gameSlug = process.argv[2];

if (!gameSlug) {
  console.error('Usage: NODE_ENV=production ts-node scripts/check-period-scores.ts <game-slug>');
  console.error('Example: NODE_ENV=production ts-node scripts/check-period-scores.ts nba-cle-nyk-2025-12-25');
  process.exit(1);
}

checkPeriodScores(gameSlug)
  .then(() => {
    console.log('\n✓ Check complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });

