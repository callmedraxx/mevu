/**
 * Config Sync Utility
 * Ensures sports-games.config.ts and teams.config.ts stay in sync
 * Validates that all sports in sports-games.config have corresponding entries in teams.config
 */

import { getAllSportsGamesConfig } from './sports-games.config';
import { getAllLeaguesConfig, getLeagueForSport } from './teams.config';
import { logger } from '../../config/logger';

/**
 * Validate that all sports in sports-games.config have entries in teams.config
 * @returns Array of sports missing from teams.config
 */
export function validateConfigSync(): string[] {
  const sportsConfig = getAllSportsGamesConfig();
  const teamsConfig = getAllLeaguesConfig();
  
  const missingSports: string[] = [];
  
  for (const sport of Object.keys(sportsConfig)) {
    if (!teamsConfig[sport]) {
      missingSports.push(sport);
    }
  }
  
  return missingSports;
}

/**
 * Check if configs are in sync and log warnings
 * Call this on service startup to detect configuration issues
 */
export function checkConfigSync(): void {
  const missingSports = validateConfigSync();
  
  if (missingSports.length > 0) {
    logger.warn({
      message: 'Config sync warning: Sports in sports-games.config missing from teams.config',
      missingSports,
      suggestion: `Add these sports to teams.config.ts to enable team enrichment: ${missingSports.join(', ')}`,
    });
  } else {
    logger.info({
      message: 'Config sync check passed: All sports have team config entries',
    });
  }
}

/**
 * Get suggested teams.config entry for a sport
 * @param sport - Sport name
 * @returns Suggested league config entry
 */
export function getSuggestedTeamConfig(sport: string): { league: string; label: string } | null {
  const sportsConfig = getAllSportsGamesConfig();
  const sportConfig = sportsConfig[sport];
  
  if (!sportConfig) {
    return null;
  }
  
  // Default: use sport name as league name, and label from sports config
  return {
    league: sport.toLowerCase(),
    label: sportConfig.label,
  };
}

