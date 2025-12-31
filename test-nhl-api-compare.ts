import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

interface PlayerStat {
  player_id: number;
  player_first_name: string;
  player_last_name: string;
  player_position: string;
  team_id: number;
  team_abbreviation: string;
  sport_stats: any;
  stats_updated_at: string;
}

// User's provided stats (subset for comparison)
const userProvidedStats: PlayerStat[] = [
  {
    player_id: 432,
    player_first_name: "Charlie",
    player_last_name: "Lindgren",
    player_position: "G",
    team_id: 36,
    team_abbreviation: "WSH",
    sport_stats: {
      saves: 1,
      time_on_ice: "05:41",
      shots_against: 1,
      sweater_number: 79,
    },
    stats_updated_at: "2025-12-31T17:48:37.987Z"
  },
  {
    player_id: 5,
    player_first_name: "Alex",
    player_last_name: "Ovechkin",
    player_position: "L",
    team_id: 36,
    team_abbreviation: "WSH",
    sport_stats: {
      goals: 0,
      assists: 0,
      points: 0,
      time_on_ice: "01:15",
      shots_on_goal: 1,
      blocked_shots: 1,
    },
    stats_updated_at: "2025-12-31T17:48:37.987Z"
  }
];

async function findNHLGame() {
  const apiKey = process.env.BALLDONTLIE_API_KEY;
  if (!apiKey) {
    throw new Error('BALLDONTLIE_API_KEY not set');
  }

  console.log('🔍 Searching for WSH vs NYR game on 2025-12-31...\n');

  // Get today's NHL games
  const today = new Date();
  const startDate = '2025-12-31';
  const endDate = '2025-12-31';
  
  const gamesResponse = await axios.get('https://api.balldontlie.io/nhl/v1/games', {
    headers: {
      'Authorization': apiKey,
    },
    params: {
      'dates[]': startDate,
    },
  });

  const games = gamesResponse.data.data || [];
  console.log(`📋 Found ${games.length} NHL games on ${startDate}:\n`);

  for (const game of games) {
    // NHL API may use different field names
    const homeTeam = game.home_team?.abbreviation || game.home_team?.tricode || game.homeTeam?.abbreviation || '';
    const awayTeam = game.visitor_team?.abbreviation || game.visitor_team?.tricode || game.awayTeam?.abbreviation || game.away_team?.abbreviation || '';
    console.log(`  ${awayTeam || '?'} @ ${homeTeam || '?'} - Game ID: ${game.id}, Status: ${game.status}`);
    console.log(`    Full game structure:`, JSON.stringify(game, null, 2).substring(0, 500));
  }

  // Find WSH vs NYR game - NHL API uses away_team not visitor_team
  const wshNyrGame = games.find((g: any) => {
    const home = (g.home_team?.tricode || g.home_team?.abbreviation || '').toUpperCase();
    const away = (g.away_team?.tricode || g.away_team?.abbreviation || '').toUpperCase();
    return (home === 'WSH' && away === 'NYR') || (home === 'NYR' && away === 'WSH');
  });

  if (!wshNyrGame) {
    console.log('\n❌ WSH vs NYR game not found for today');
    return null;
  }

  console.log(`\n✅ Found WSH vs NYR game: ID ${wshNyrGame.id}`);
  console.log(`   Full game data:`, JSON.stringify(wshNyrGame, null, 2));
  
  return wshNyrGame;
}

async function fetchBoxScores(gameId: number) {
  const apiKey = process.env.BALLDONTLIE_API_KEY;
  
  console.log(`\n📦 Fetching box scores for game ID ${gameId}...`);
  
  const response = await axios.get('https://api.balldontlie.io/nhl/v1/box_scores', {
    headers: {
      'Authorization': apiKey,
    },
    params: {
      'game_ids[]': gameId,
    },
  });

  const boxScores = response.data.data || [];
  console.log(`\n📊 Received ${boxScores.length} player stats from API`);
  
  return boxScores;
}

function compareStats(apiStats: any[], userStats: PlayerStat[]) {
  console.log('\n🔄 Comparing API response with user-provided stats...\n');
  
  // Find matching players
  for (const userStat of userStats) {
    const apiStat = apiStats.find((s: any) => 
      s.player?.id === userStat.player_id ||
      (s.player?.first_name === userStat.player_first_name && 
       s.player?.last_name === userStat.player_last_name)
    );
    
    if (apiStat) {
      console.log(`✅ Found ${userStat.player_first_name} ${userStat.player_last_name}:`);
      console.log(`   API Raw Data:`, JSON.stringify(apiStat, null, 2));
      console.log(`   User Stored:`, JSON.stringify(userStat.sport_stats, null, 2));
      
      // Compare key fields
      const differences: string[] = [];
      
      if (apiStat.goals !== userStat.sport_stats.goals && apiStat.goals !== undefined) {
        differences.push(`Goals: API=${apiStat.goals}, Stored=${userStat.sport_stats.goals}`);
      }
      if (apiStat.assists !== userStat.sport_stats.assists && apiStat.assists !== undefined) {
        differences.push(`Assists: API=${apiStat.assists}, Stored=${userStat.sport_stats.assists}`);
      }
      if (apiStat.saves !== userStat.sport_stats.saves && apiStat.saves !== undefined) {
        differences.push(`Saves: API=${apiStat.saves}, Stored=${userStat.sport_stats.saves}`);
      }
      if (apiStat.time_on_ice !== userStat.sport_stats.time_on_ice) {
        differences.push(`TOI: API=${apiStat.time_on_ice}, Stored=${userStat.sport_stats.time_on_ice}`);
      }
      
      if (differences.length > 0) {
        console.log(`   ⚠️  DIFFERENCES:`);
        differences.forEach(d => console.log(`      - ${d}`));
      } else {
        console.log(`   ✓ No differences found`);
      }
      console.log('');
    } else {
      console.log(`❌ Player ${userStat.player_first_name} ${userStat.player_last_name} (ID: ${userStat.player_id}) not found in API response\n`);
    }
  }
}

async function main() {
  try {
    console.log('========================================');
    console.log('NHL Ball Don\'t Lie API Comparison Test');
    console.log('========================================\n');
    
    // Step 1: Find the game
    const game = await findNHLGame();
    
    if (!game) {
      console.log('\nCannot proceed without game ID');
      return;
    }
    
    // Step 2: Fetch box scores
    const apiStats = await fetchBoxScores(game.id);
    
    if (apiStats.length === 0) {
      console.log('\n⚠️  No box scores returned from API');
      console.log('This could mean:');
      console.log('  1. Game hasn\'t started yet');
      console.log('  2. Stats are not yet available');
      console.log('  3. API endpoint issue');
      return;
    }
    
    // Show first few stats structure
    console.log('\n📋 Sample API response structure (first 2 players):');
    apiStats.slice(0, 2).forEach((stat: any, idx: number) => {
      console.log(`\nPlayer ${idx + 1}:`, JSON.stringify(stat, null, 2));
    });
    
    // Step 3: Compare with user's data
    compareStats(apiStats, userProvidedStats);
    
    // Step 4: Show summary
    console.log('\n========================================');
    console.log('Summary');
    console.log('========================================');
    console.log(`Total API Players: ${apiStats.length}`);
    console.log(`User Provided Players: ${userProvidedStats.length} (sample)`);
    
    // Show WSH players only
    const wshApiPlayers = apiStats.filter((s: any) => 
      s.team?.tricode?.toUpperCase() === 'WSH' || 
      s.team?.abbreviation?.toUpperCase() === 'WSH'
    );
    console.log(`\nWSH Players in API: ${wshApiPlayers.length}`);
    
    // Show NYR players only  
    const nyrApiPlayers = apiStats.filter((s: any) => 
      s.team?.tricode?.toUpperCase() === 'NYR' || 
      s.team?.abbreviation?.toUpperCase() === 'NYR'
    );
    console.log(`NYR Players in API: ${nyrApiPlayers.length}`);
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

main();

