/**
 * Test NHL game stats retrieval
 * Tests the specific game: nhl-sea-ana-2025-12-22
 */

import { getLiveGameBySlug } from './src/services/polymarket/live-games.service';
import { ballDontLieClient, storePlayerStats, getPlayerStats } from './src/services/balldontlie/balldontlie.service';
import { logger } from './src/config/logger';
import axios from 'axios';

async function testNHLGameStats() {
  console.log('🧪 Testing NHL Game Stats Retrieval\n');
  console.log('Game slug: nhl-sea-ana-2025-12-22\n');

  // Set API key
  if (!process.env.BALLDONTLIE_API_KEY) {
    process.env.BALLDONTLIE_API_KEY = '1167d69e-a043-4d0d-ba19-0c558121f096';
  }

  try {
    // Step 1: Find the game in our database
    console.log('1️⃣ Finding game in database...');
    const game = await getLiveGameBySlug('nhl-sea-ana-2025-12-22');
    
    if (!game) {
      console.log('   ⚠️  Game not found in database');
      console.log('   💡 Game may need to be fetched from Polymarket first');
      return;
    }

    console.log('   ✅ Game found:');
    console.log(`      ID: ${game.id}`);
    console.log(`      Title: ${game.title}`);
    console.log(`      Sport: ${game.sport}`);
    console.log(`      Score: ${game.score || 'N/A'}`);
    console.log(`      Period: ${game.period || 'N/A'}`);
    console.log(`      Live: ${game.live}`);
    console.log(`      Ended: ${game.ended}`);
    console.log(`      Ball Don't Lie Game ID: ${(game as any).balldontlie_game_id || 'Not mapped yet'}`);

    // Step 2: Find NHL game in Ball Don't Lie API
    console.log('\n2️⃣ Finding NHL game in Ball Don\'t Lie API...');
    
    // Check if SDK supports NHL
    const { BalldontlieAPI } = require('@balldontlie/sdk');
    const api = new BalldontlieAPI({ apiKey: process.env.BALLDONTLIE_API_KEY });
    
    let balldontlieGameId: number | null = null;
    let balldontlieGame: any = null;

    // Try SDK first (if NHL is supported)
    try {
      if (api.nhl && typeof api.nhl.getGames === 'function') {
        console.log('   Using SDK for NHL...');
        const gamesResponse = await api.nhl.getGames({ dates: ['2025-12-22'] });
        const games = gamesResponse.data || [];
        console.log(`   ✅ Found ${games.length} NHL games via SDK`);
        
        // Find game matching Seattle (SEA) vs Anaheim (ANA)
        balldontlieGame = games.find((g: any) => {
          const visitorTricode = g.away_team?.tricode?.toLowerCase() || '';
          const visitorName = g.away_team?.full_name?.toLowerCase() || '';
          const homeTricode = g.home_team?.tricode?.toLowerCase() || '';
          const homeName = g.home_team?.full_name?.toLowerCase() || '';
          return (visitorTricode === 'sea' || visitorName.includes('seattle') || visitorName.includes('kraken')) && 
                 (homeTricode === 'ana' || homeName.includes('anaheim') || homeName.includes('ducks'));
        });
        
        if (balldontlieGame) {
          balldontlieGameId = balldontlieGame.id;
          console.log(`   ✅ Found matching game: ${balldontlieGame.visitor_team?.full_name} @ ${balldontlieGame.home_team?.full_name}`);
          console.log(`      Game ID: ${balldontlieGameId}`);
        }
      }
    } catch (sdkError) {
      console.log(`   ⚠️  SDK doesn't support NHL yet, trying direct API call...`);
    }

    // If SDK doesn't work, try direct API call
    if (!balldontlieGameId) {
      try {
        console.log('   Using direct API call for NHL...');
        const response = await axios.get('https://api.balldontlie.io/nhl/v1/games', {
          headers: {
            'Authorization': `Bearer ${process.env.BALLDONTLIE_API_KEY}`,
          },
          params: {
            'dates[]': '2025-12-22',
          },
        });

        const games = response.data.data || [];
        console.log(`   ✅ Found ${games.length} NHL games via direct API`);
        
        // Find game matching Seattle vs Anaheim
        balldontlieGame = games.find((g: any) => {
          const visitorTricode = g.away_team?.tricode?.toLowerCase() || '';
          const visitorName = g.away_team?.full_name?.toLowerCase() || '';
          const homeTricode = g.home_team?.tricode?.toLowerCase() || '';
          const homeName = g.home_team?.full_name?.toLowerCase() || '';
          return (visitorTricode === 'sea' || visitorName.includes('seattle') || visitorName.includes('kraken')) && 
                 (homeTricode === 'ana' || homeName.includes('anaheim') || homeName.includes('ducks'));
        });
        
        if (balldontlieGame) {
          balldontlieGameId = balldontlieGame.id;
          console.log(`   ✅ Found matching game: ${balldontlieGame.away_team?.full_name} @ ${balldontlieGame.home_team?.full_name}`);
          console.log(`      Game ID: ${balldontlieGameId}`);
          console.log(`      Status: ${balldontlieGame.game_state || balldontlieGame.status}`);
          console.log(`      Score: ${balldontlieGame.away_score} - ${balldontlieGame.home_score}`);
        }
      } catch (apiError: any) {
        console.log(`   ❌ Direct API call failed: ${apiError.message}`);
        if (apiError.response) {
          console.log(`      Status: ${apiError.response.status}`);
          console.log(`      Response: ${JSON.stringify(apiError.response.data)}`);
        }
      }
    }

    if (!balldontlieGameId) {
      console.log('\n   ⚠️  Could not find NHL game in Ball Don\'t Lie API');
      console.log('   💡 Game may not be available yet or teams may not match');
      return;
    }

    // Step 3: Fetch player stats
    console.log(`\n3️⃣ Fetching player stats for game ID: ${balldontlieGameId}...`);
    
    let stats: any[] = [];
    
    // Try SDK first
    try {
      if (api.nhl && typeof api.nhl.getStats === 'function') {
        console.log('   Using SDK for stats...');
        const statsResponse = await api.nhl.getStats({ game_ids: [balldontlieGameId] });
        stats = statsResponse.data || [];
        console.log(`   ✅ Found ${stats.length} player stats via SDK`);
      }
    } catch (sdkError) {
      console.log(`   ⚠️  SDK doesn't support NHL stats, trying direct API call...`);
    }

    // If SDK doesn't work, try direct API call
    // NHL uses /box_scores endpoint instead of /stats
    if (stats.length === 0) {
      try {
        console.log('   Using direct API call for stats (box_scores endpoint)...');
        const statsResponse = await axios.get('https://api.balldontlie.io/nhl/v1/box_scores', {
          headers: {
            'Authorization': `Bearer ${process.env.BALLDONTLIE_API_KEY}`,
          },
          params: {
            'game_ids[]': balldontlieGameId,
          },
        });

        stats = statsResponse.data.data || [];
        console.log(`   ✅ Found ${stats.length} player stats via direct API`);
      } catch (apiError: any) {
        console.log(`   ❌ Failed to fetch stats: ${apiError.message}`);
        if (apiError.response) {
          console.log(`      Status: ${apiError.response.status}`);
          console.log(`      Response: ${JSON.stringify(apiError.response.data)}`);
        }
        return;
      }
    }

    if (stats.length === 0) {
      console.log('   ⚠️  No player stats found');
      console.log('   💡 Stats may not be available yet for this game');
      return;
    }

    // Step 4: Display stats
    console.log(`\n4️⃣ Player Stats Summary:`);
    console.log(`   Total players: ${stats.length}`);
    
    // Group by team
    const homeStats = stats.filter((s: any) => {
      const teamTricode = s.team?.tricode?.toLowerCase() || '';
      const teamName = s.team?.full_name?.toLowerCase() || '';
      return teamTricode === 'ana' || teamName.includes('anaheim') || teamName.includes('ducks');
    });
    const awayStats = stats.filter((s: any) => {
      const teamTricode = s.team?.tricode?.toLowerCase() || '';
      const teamName = s.team?.full_name?.toLowerCase() || '';
      return teamTricode === 'sea' || teamName.includes('seattle') || teamName.includes('kraken');
    });

    console.log(`   Home team (Anaheim): ${homeStats.length} players`);
    console.log(`   Away team (Seattle): ${awayStats.length} players`);

    // Show top scorers
    const topScorers = [...stats]
      .filter((s: any) => s.goals !== undefined && s.goals > 0)
      .sort((a: any, b: any) => (b.goals || 0) - (a.goals || 0))
      .slice(0, 5);

    if (topScorers.length > 0) {
      console.log(`\n   🏒 Top Goal Scorers:`);
      topScorers.forEach((stat: any, idx: number) => {
        console.log(`      ${idx + 1}. ${stat.player?.first_name} ${stat.player?.last_name} (${stat.team?.abbreviation}): ${stat.goals} G, ${stat.assists || 0} A, ${stat.points || 0} PTS`);
      });
    }

    // Show top point getters
    const topPointGetters = [...stats]
      .filter((s: any) => s.points !== undefined)
      .sort((a: any, b: any) => (b.points || 0) - (a.points || 0))
      .slice(0, 5);

    if (topPointGetters.length > 0) {
      console.log(`\n   ⭐ Top Point Getters:`);
      topPointGetters.forEach((stat: any, idx: number) => {
        console.log(`      ${idx + 1}. ${stat.player?.first_name} ${stat.player?.last_name} (${stat.team?.abbreviation}): ${stat.points} PTS (${stat.goals || 0}G, ${stat.assists || 0}A)`);
      });
    }

    // Show sample stat structure
    if (stats.length > 0) {
      console.log(`\n   📋 Sample stat structure (first player):`);
      const sample = stats[0];
      console.log(`      Player: ${sample.player?.first_name} ${sample.player?.last_name}`);
      console.log(`      Team: ${sample.team?.abbreviation} (${sample.team?.full_name || sample.team?.name})`);
      console.log(`      Position: ${sample.player?.position || 'N/A'}`);
      console.log(`      Stats: ${JSON.stringify({
        goals: sample.goals,
        assists: sample.assists,
        points: sample.points,
        shots: sample.shots,
        hits: sample.hits,
        pim: sample.pim,
        plus_minus: sample.plus_minus,
      }, null, 6)}`);
    }

    // Step 5: Test storing stats
    console.log(`\n5️⃣ Testing stats storage...`);
    try {
      await storePlayerStats(game.id, 'nhl', balldontlieGameId, stats);
      console.log(`   ✅ Stats stored successfully!`);
      
      // Verify retrieval
      const storedStats = await getPlayerStats(game.id);
      console.log(`   ✅ Retrieved ${storedStats.length} stats from database`);
      
      if (storedStats.length > 0) {
        console.log(`   📊 Sample stored stat:`);
        const sample = storedStats[0];
        console.log(`      ${sample.player_first_name} ${sample.player_last_name} (${sample.team_abbreviation})`);
        console.log(`      Sport: ${sample.sport}`);
        console.log(`      Sport Stats: ${JSON.stringify(sample.sport_stats, null, 2)}`);
      }
    } catch (storeError) {
      console.log(`   ❌ Error storing stats: ${storeError instanceof Error ? storeError.message : String(storeError)}`);
    }

    console.log(`\n✅ Test completed successfully!`);

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    if (error instanceof Error) {
      console.error('   Error:', error.message);
      console.error('   Stack:', error.stack);
    }
    process.exit(1);
  }
}

// Run the test
testNHLGameStats().catch(console.error);

