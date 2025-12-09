/**
 * Test script to verify teams are being fetched correctly
 * Usage: tsx src/scripts/test-teams.ts <league>
 * Example: tsx src/scripts/test-teams.ts nfl
 */

import dotenv from 'dotenv';
import { teamsService } from '../services/polymarket/teams.service';
import { logoMappingService } from '../services/espn/logo-mapping.service';
import { logger } from '../config/logger';

// Load environment variables
dotenv.config();

async function testTeamsFetching(league: string) {
  try {
    console.log(`\n=== Testing Teams Fetching for ${league.toUpperCase()} ===\n`);

    // Initialize logo mapping service
    await logoMappingService.initialize();
    console.log('✓ Logo mapping service initialized\n');

    // Test 1: Fetch teams from API
    console.log('1. Fetching teams from Polymarket API...');
    const teams = await teamsService.fetchTeamsFromAPI(league);
    console.log(`✓ Fetched ${teams.length} teams from API\n`);

    // Display first 5 teams
    console.log('Sample teams:');
    teams.slice(0, 5).forEach((team, index) => {
      console.log(`  ${index + 1}. ${team.name} (${team.abbreviation}) - ID: ${team.id}`);
      console.log(`     Logo: ${team.logo}`);
      console.log(`     League: ${team.league}, Record: ${team.record || 'N/A'}`);
    });

    // Test 2: Upsert teams (this will download logos)
    console.log('\n2. Upserting teams (this will download ESPN logos)...');
    await teamsService.upsertTeams(teams, league);
    console.log('✓ Teams upserted successfully\n');

    // Test 3: Retrieve teams from storage
    console.log('3. Retrieving teams from storage...');
    const storedTeams = await teamsService.getTeamsByLeague(league);
    console.log(`✓ Retrieved ${storedTeams.length} teams from storage\n`);

    // Check logo URLs
    console.log('Logo URLs after mapping:');
    storedTeams.slice(0, 5).forEach((team, index) => {
      const hasMappedLogo = team.logo.includes('/api/logos/');
      const status = hasMappedLogo ? '✓' : '✗';
      console.log(`  ${status} ${team.name}: ${team.logo}`);
    });

    // Test 4: Get single team by ID
    if (storedTeams.length > 0) {
      const firstTeam = storedTeams[0];
      console.log(`\n4. Getting team by ID (${firstTeam.id})...`);
      const teamById = await teamsService.getTeamById(firstTeam.id, league);
      if (teamById) {
        console.log(`✓ Found team: ${teamById.name}`);
        console.log(`  Logo: ${teamById.logo}`);
      } else {
        console.log('✗ Team not found');
      }
    }

    // Summary
    console.log('\n=== Summary ===');
    console.log(`Total teams: ${storedTeams.length}`);
    const mappedLogos = storedTeams.filter(t => t.logo.includes('/api/logos/')).length;
    console.log(`Teams with mapped logos: ${mappedLogos}/${storedTeams.length}`);
    console.log(`Teams with original logos: ${storedTeams.length - mappedLogos}/${storedTeams.length}`);

    console.log('\n✓ All tests completed successfully!\n');
  } catch (error) {
    logger.error({
      message: 'Error testing teams fetching',
      league,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    console.error('\n✗ Error:', error);
    process.exit(1);
  }
}

// Get league from command line args
const league = process.argv[2];

if (!league) {
  console.error('Usage: tsx src/scripts/test-teams.ts <league>');
  console.error('Example: tsx src/scripts/test-teams.ts nfl');
  console.error('\nAvailable leagues: nfl, nba, mlb, nhl, epl, lal');
  process.exit(1);
}

testTeamsFetching(league)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

