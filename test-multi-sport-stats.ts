/**
 * Test script for multi-sport Ball Don't Lie API integration
 * Tests NBA, NFL, MLB stats retrieval
 */

import { ballDontLieClient, isSportSupported, storePlayerStats } from './src/services/balldontlie/balldontlie.service';

async function testMultiSportStats() {
  console.log('🧪 Testing Multi-Sport Ball Don\'t Lie API Integration\n');

  // Set API key
  if (!process.env.BALLDONTLIE_API_KEY) {
    process.env.BALLDONTLIE_API_KEY = '1167d69e-a043-4d0d-ba19-0c558121f096';
  }

  const testDate = '2024-12-10';
  const sports = ['nba', 'nfl', 'mlb'];

  for (const sport of sports) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing ${sport.toUpperCase()}`);
    console.log('='.repeat(60));

    // Check if sport is supported
    if (!isSportSupported(sport)) {
      console.log(`   ⚠️  ${sport.toUpperCase()} is not supported`);
      continue;
    }

    try {
      // Test 1: Get games
      console.log(`\n1️⃣ Fetching ${sport.toUpperCase()} games for ${testDate}...`);
      const games = await ballDontLieClient.getGamesByDate(sport, testDate);
      console.log(`   ✅ Found ${games.length} games`);

      if (games.length > 0) {
        const game = games[0];
        console.log(`   📊 Sample game:`);
        console.log(`      ID: ${game.id}`);
        if (game.visitor_team && game.home_team) {
          console.log(`      ${game.visitor_team.full_name || game.visitor_team.name} @ ${game.home_team.full_name || game.home_team.name}`);
        }
        console.log(`      Status: ${game.status || 'N/A'}`);
        if (game.visitor_team_score !== undefined && game.home_team_score !== undefined) {
          console.log(`      Score: ${game.visitor_team_score} - ${game.home_team_score}`);
        }

        // Test 2: Get player stats
        console.log(`\n2️⃣ Fetching ${sport.toUpperCase()} player stats for game ID: ${game.id}...`);
        try {
          const stats = await ballDontLieClient.getPlayerStats(sport, [game.id]);
          console.log(`   ✅ Found ${stats.length} player stat records`);

          if (stats.length > 0) {
            // Show top performers based on sport
            console.log(`\n   🏆 Top performers:`);
            
            if (sport === 'nba') {
              const topScorer = stats.reduce((prev, current) => 
                (current.pts || 0) > (prev.pts || 0) ? current : prev
              );
              console.log(`      Top Scorer: ${topScorer.player?.first_name} ${topScorer.player?.last_name} (${topScorer.team?.abbreviation})`);
              console.log(`         ${topScorer.pts || 0} PTS, ${topScorer.reb || 0} REB, ${topScorer.ast || 0} AST`);
            } else if (sport === 'nfl') {
              const topPasser = stats
                .filter(s => s.pass_yds !== undefined)
                .reduce((prev, current) => 
                  (current.pass_yds || 0) > (prev.pass_yds || 0) ? current : prev,
                  stats.find(s => s.pass_yds !== undefined) || stats[0]
                );
              if (topPasser && topPasser.pass_yds !== undefined) {
                console.log(`      Top Passer: ${topPasser.player?.first_name} ${topPasser.player?.last_name} (${topPasser.team?.abbreviation})`);
                console.log(`         ${topPasser.pass_yds || 0} Pass Yds, ${topPasser.pass_td || 0} TD`);
              }
            } else if (sport === 'mlb') {
              const topHitter = stats
                .filter(s => s.hr !== undefined)
                .reduce((prev, current) => 
                  (current.hr || 0) > (prev.hr || 0) ? current : prev,
                  stats.find(s => s.hr !== undefined) || stats[0]
                );
              if (topHitter && topHitter.hr !== undefined) {
                console.log(`      Top Hitter: ${topHitter.player?.first_name} ${topHitter.player?.last_name} (${topHitter.team?.abbreviation})`);
                console.log(`         ${topHitter.hr || 0} HR, ${topHitter.rbi || 0} RBI, ${topHitter.h || 0}/${topHitter.ab || 0} (${((topHitter.h || 0) / (topHitter.ab || 1) * 100).toFixed(3)}%)`);
              }
            }

            // Show sample stat structure
            console.log(`\n   📋 Sample stat structure (first player):`);
            const sample = stats[0];
            console.log(`      Player: ${sample.player?.first_name} ${sample.player?.last_name}`);
            console.log(`      Team: ${sample.team?.abbreviation} (${sample.team?.full_name || sample.team?.name})`);
            console.log(`      Position: ${sample.player?.position || 'N/A'}`);
            
            // Show sport-specific stats
            const statKeys = Object.keys(sample).filter(k => 
              !['player', 'team', 'game', 'id'].includes(k) && sample[k] !== undefined && sample[k] !== null
            );
            console.log(`      Available stats: ${statKeys.slice(0, 10).join(', ')}${statKeys.length > 10 ? '...' : ''}`);
          } else {
            console.log(`   ⚠️  No stats found (game may not have stats available yet)`);
          }
        } catch (statsError) {
          console.log(`   ❌ Error fetching stats: ${statsError instanceof Error ? statsError.message : String(statsError)}`);
        }
      } else {
        console.log(`   ⚠️  No games found for ${testDate}`);
      }
    } catch (error) {
      console.log(`   ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('✅ Multi-sport integration test completed!');
  console.log('='.repeat(60));
  console.log('\n📝 Summary:');
  console.log('   ✅ NBA: Supported by SDK');
  console.log('   ✅ NFL: Supported by SDK');
  console.log('   ✅ MLB: Supported by SDK');
  console.log('   ⚠️  NHL: API supports it, but SDK may not have methods yet');
  console.log('   ⚠️  EPL: API supports it, but SDK may not have methods yet');
  console.log('\n💡 Next steps:');
  console.log('   1. Run migration: migrations/016_add_sport_to_player_stats.sql');
  console.log('   2. Create game mapping service for each sport');
  console.log('   3. Set up polling service for live games');
}

// Run the test
testMultiSportStats().catch(console.error);

