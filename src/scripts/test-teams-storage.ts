/**
 * Test script to verify teams are fetched and stored correctly
 * Tests both development (in-memory) and production (PostgreSQL) modes
 * 
 * Usage:
 *   Development: NODE_ENV=development tsx src/scripts/test-teams-storage.ts nfl
 *   Production:  NODE_ENV=production tsx src/scripts/test-teams-storage.ts nfl
 */

import dotenv from 'dotenv';
import { teamsService } from '../services/polymarket/teams.service';
import { logoMappingService } from '../services/espn/logo-mapping.service';
import { logger } from '../config/logger';
import { getDatabaseConfig } from '../config/database';

// Load environment variables
dotenv.config();

async function testTeamsStorage(league: string) {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const dbConfig = getDatabaseConfig();
  
  console.log('\n' + '='.repeat(60));
  console.log(`Testing Teams Storage - ${nodeEnv.toUpperCase()} Mode`);
  console.log(`Database Type: ${dbConfig.type}`);
  if (dbConfig.connectionString) {
    console.log(`Connection: ${dbConfig.connectionString.replace(/:[^:@]+@/, ':****@')}`);
  }
  console.log('='.repeat(60) + '\n');

  try {
    // Initialize logo mapping service
    console.log('1. Initializing logo mapping service...');
    await logoMappingService.initialize();
    console.log('   ✓ Logo mapping service initialized\n');

    // Test 1: Fetch teams from Polymarket API
    console.log('2. Fetching teams from Polymarket API...');
    const fetchedTeams = await teamsService.fetchTeamsFromAPI(league);
    console.log(`   ✓ Fetched ${fetchedTeams.length} teams from API`);
    
    if (fetchedTeams.length === 0) {
      console.log('   ⚠ Warning: No teams fetched from API');
      return;
    }

    // Display sample teams
    console.log('\n   Sample teams from API:');
    fetchedTeams.slice(0, 3).forEach((team, index) => {
      console.log(`     ${index + 1}. ${team.name} (${team.abbreviation}) - ID: ${team.id}`);
    });

    // Test 2: Upsert teams (this will store them)
    console.log('\n3. Upserting teams to storage...');
    await teamsService.upsertTeams(fetchedTeams, league);
    console.log(`   ✓ Upserted ${fetchedTeams.length} teams`);

    // Test 3: Retrieve teams from storage
    console.log('\n4. Retrieving teams from storage...');
    const storedTeams = await teamsService.getTeamsByLeague(league);
    console.log(`   ✓ Retrieved ${storedTeams.length} teams from storage`);

    if (storedTeams.length === 0) {
      console.log('   ✗ Error: No teams retrieved from storage!');
      process.exit(1);
    }

    // Verify data integrity
    console.log('\n5. Verifying data integrity...');
    const sampleTeam = storedTeams[0];
    console.log(`   Sample team: ${sampleTeam.name}`);
    console.log(`     - ID: ${sampleTeam.id}`);
    console.log(`     - League: ${sampleTeam.league}`);
    console.log(`     - Abbreviation: ${sampleTeam.abbreviation}`);
    console.log(`     - Logo: ${sampleTeam.logo}`);
    console.log(`     - Name: ${sampleTeam.name}`);
    console.log(`     - Record: ${sampleTeam.record || 'N/A'}`);

    // Check logo mapping
    const hasMappedLogo = sampleTeam.logo.includes('/api/logos/');
    console.log(`     - Logo mapped: ${hasMappedLogo ? '✓' : '✗'}`);

    // Test 4: Get single team by ID
    console.log('\n6. Testing getTeamById...');
    const teamById = await teamsService.getTeamById(sampleTeam.id, league);
    if (teamById) {
      console.log(`   ✓ Found team by ID: ${teamById.name}`);
      if (teamById.id !== sampleTeam.id || teamById.name !== sampleTeam.name) {
        console.log('   ✗ Error: Team data mismatch!');
        process.exit(1);
      }
    } else {
      console.log('   ✗ Error: Team not found by ID!');
      process.exit(1);
    }

    // Test 5: Verify all teams have required fields
    console.log('\n7. Verifying all teams have required fields...');
    const teamsWithMissingFields = storedTeams.filter(team => 
      !team.id || !team.name || !team.league || !team.abbreviation
    );
    
    if (teamsWithMissingFields.length > 0) {
      console.log(`   ✗ Error: ${teamsWithMissingFields.length} teams missing required fields`);
      teamsWithMissingFields.slice(0, 3).forEach(team => {
        console.log(`     - Team ID ${team.id}: missing fields`);
      });
      process.exit(1);
    } else {
      console.log(`   ✓ All ${storedTeams.length} teams have required fields`);
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`Environment: ${nodeEnv}`);
    console.log(`Storage Type: ${dbConfig.type}`);
    console.log(`Teams Fetched: ${fetchedTeams.length}`);
    console.log(`Teams Stored: ${storedTeams.length}`);
    console.log(`Teams Retrieved: ${storedTeams.length}`);
    
    const mappedLogos = storedTeams.filter(t => t.logo.includes('/api/logos/')).length;
    console.log(`Teams with Mapped Logos: ${mappedLogos}/${storedTeams.length}`);
    
    // Verify counts match
    if (fetchedTeams.length !== storedTeams.length) {
      console.log(`\n⚠ Warning: Fetched (${fetchedTeams.length}) != Stored (${storedTeams.length})`);
    } else {
      console.log('\n✓ All tests passed! Teams are being stored correctly.');
    }
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    logger.error({
      message: 'Error testing teams storage',
      league,
      nodeEnv,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    console.error('\n✗ Error:', error);
    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Get league from command line args
const league = process.argv[2];

if (!league) {
  console.error('Usage: tsx src/scripts/test-teams-storage.ts <league>');
  console.error('Example: tsx src/scripts/test-teams-storage.ts nfl');
  console.error('\nAvailable leagues: nfl, nba, mlb, nhl, epl, lal');
  console.error('\nSet NODE_ENV to test different modes:');
  console.error('  NODE_ENV=development tsx src/scripts/test-teams-storage.ts nfl');
  console.error('  NODE_ENV=production tsx src/scripts/test-teams-storage.ts nfl');
  process.exit(1);
}

testTeamsStorage(league)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

