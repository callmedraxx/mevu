/**
 * Test script for Ball Don't Lie API integration
 * Run with: npx ts-node test-balldontlie.ts
 */

import { ballDontLieClient, storePlayerStats, getPlayerStats } from './src/services/balldontlie/balldontlie.service';
import { logger } from './src/config/logger';

async function testBallDontLieAPI() {
  console.log('🧪 Testing Ball Don\'t Lie API Integration\n');

  // Set API key from environment or use provided one
  if (!process.env.BALLDONTLIE_API_KEY) {
    process.env.BALLDONTLIE_API_KEY = '1167d69e-a043-4d0d-ba19-0c558121f096';
  }

  try {
    // Test 1: Get games for a recent date (completed games have stats)
    console.log('1️⃣ Testing getGamesByDate with completed game...');
    const testDate = '2024-12-10'; // Use a date with completed games
    console.log(`   Fetching games for: ${testDate}`);
    
    try {
      const games = await ballDontLieClient.getGamesByDate(testDate);
      console.log(`   ✅ Found ${games.length} games`);
      
      // Find a completed game (status contains "Final" or has scores)
      const completedGame = games.find(g => 
        g.status?.toLowerCase().includes('final') || 
        (g.home_team_score > 0 || g.visitor_team_score > 0)
      ) || games[0];
      
      if (completedGame) {
        console.log(`   📊 Selected game:`);
        console.log(`      ID: ${completedGame.id}`);
        console.log(`      ${completedGame.visitor_team.full_name} @ ${completedGame.home_team.full_name}`);
        console.log(`      Status: ${completedGame.status}`);
        console.log(`      Score: ${completedGame.visitor_team_score} - ${completedGame.home_team_score}`);
        
        // Test 2: Get player stats for this game
        console.log('\n2️⃣ Testing getPlayerStats...');
        console.log(`   Fetching stats for game ID: ${completedGame.id}`);
        
        try {
          const stats = await ballDontLieClient.getPlayerStats([completedGame.id]);
          console.log(`   ✅ Found ${stats.length} player stat records`);
          
          if (stats.length > 0) {
            const topScorer = stats.reduce((prev, current) => 
              (current.pts > prev.pts) ? current : prev
            );
            console.log(`   🏀 Top scorer:`);
            console.log(`      ${topScorer.player.first_name} ${topScorer.player.last_name} (${topScorer.team.abbreviation})`);
            console.log(`      ${topScorer.pts} PTS, ${topScorer.reb} REB, ${topScorer.ast} AST`);
            
            // Show top 5 players
            console.log(`\n   📊 Top 5 players by points:`);
            const topPlayers = [...stats].sort((a, b) => b.pts - a.pts).slice(0, 5);
            topPlayers.forEach((stat, idx) => {
              console.log(`      ${idx + 1}. ${stat.player.first_name} ${stat.player.last_name} (${stat.team.abbreviation}): ${stat.pts} PTS, ${stat.reb} REB, ${stat.ast} AST`);
            });
            
            // Show sample of stats structure
            console.log(`\n   📋 Sample stat structure (first player):`);
            const sample = stats[0];
            console.log(`      Player: ${sample.player.first_name} ${sample.player.last_name}`);
            console.log(`      Team: ${sample.team.abbreviation} (${sample.team.full_name})`);
            console.log(`      Position: ${sample.player.position}`);
            console.log(`      Stats: ${JSON.stringify({
              pts: sample.pts,
              reb: sample.reb,
              ast: sample.ast,
              stl: sample.stl,
              blk: sample.blk,
              fg: `${sample.fgm}/${sample.fga} (${(sample.fg_pct * 100).toFixed(1)}%)`,
              fg3: `${sample.fg3m}/${sample.fg3a} (${(sample.fg3_pct * 100).toFixed(1)}%)`,
              min: sample.min
            }, null, 6)}`);
            
            console.log(`\n   ✅ API integration working! Player stats successfully retrieved.`);
          } else {
            console.log(`   ⚠️  No stats found (game may not have stats available yet)`);
          }
        } catch (statsError) {
          console.log(`   ❌ Error fetching stats: ${statsError instanceof Error ? statsError.message : String(statsError)}`);
          if (statsError instanceof Error) {
            console.log(`   Error details:`, statsError);
          }
        }
      } else {
        console.log(`   ⚠️  No games found for ${testDate}`);
      }
    } catch (gamesError) {
      console.log(`   ❌ Error fetching games: ${gamesError instanceof Error ? gamesError.message : String(gamesError)}`);
    }

    console.log('\n✅ API integration test completed!');
    console.log('\n📝 Next steps:');
    console.log('   1. Set BALLDONTLIE_API_KEY environment variable if needed');
    console.log('   2. Run database migration: migrations/015_add_game_player_stats.sql');
    console.log('   3. Create mapping service to link Polymarket games to Ball Don\'t Lie games');
    console.log('   4. Set up polling service to fetch stats for live games');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  }
}

// Run the test
testBallDontLieAPI().catch(console.error);

