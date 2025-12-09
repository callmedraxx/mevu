/**
 * Script to pre-download logos for teams in a league
 * Usage: tsx src/scripts/download-logos.ts <league>
 * Example: tsx src/scripts/download-logos.ts nfl
 */

import { teamsService } from '../services/polymarket/teams.service';
import { logoMappingService } from '../services/espn/logo-mapping.service';
import { logger } from '../config/logger';

async function downloadLogosForLeague(league: string) {
  try {
    logger.info({
      message: 'Starting logo download for league',
      league,
    });

    // Initialize logo mapping service
    await logoMappingService.initialize();

    // Fetch teams from Polymarket
    const teams = await teamsService.fetchTeamsFromAPI(league);
    
    logger.info({
      message: 'Teams fetched from Polymarket',
      league,
      teamCount: teams.length,
    });

    // Prepare teams for logo download
    const teamsToDownload = teams.map(team => ({
      league: team.league,
      abbreviation: team.abbreviation,
    }));

    // Download logos
    const results = await logoMappingService.downloadLogosForTeams(teamsToDownload);

    logger.info({
      message: 'Logo download completed',
      league,
      total: teams.length,
      successful: results.size,
      failed: teams.length - results.size,
    });

    // Show some examples
    const exampleTeams = teams.slice(0, 5);
    console.log('\nExample logo URLs:');
    exampleTeams.forEach(team => {
      const logoUrl = logoMappingService.getLogoUrl(team.league, team.abbreviation);
      console.log(`  ${team.name} (${team.abbreviation}): ${logoUrl || 'Not found'}`);
    });

  } catch (error) {
    logger.error({
      message: 'Error downloading logos',
      league,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// Get league from command line args
const league = process.argv[2];

if (!league) {
  console.error('Usage: tsx src/scripts/download-logos.ts <league>');
  console.error('Example: tsx src/scripts/download-logos.ts nfl');
  process.exit(1);
}

downloadLogosForLeague(league)
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });

