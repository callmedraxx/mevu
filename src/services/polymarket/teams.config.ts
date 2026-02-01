/**
 * Teams Configuration
 * Maps sport category names to their Polymarket Gamma API league names for teams endpoint
 */

export interface LeagueConfig {
  league: string;
  label: string;
}

export interface TeamsConfig {
  [sport: string]: LeagueConfig;
}

/**
 * Teams configuration
 * Maps sport names to their league names for fetching teams from the Gamma API
 * 
 * Note: League names must match exactly what the Gamma API expects
 * To add a new sport, add an entry here with the correct league name
 * 
 * Example: NFL uses league 'nfl', NBA uses league 'nba'
 */
const TEAMS_CONFIG: TeamsConfig = {
  nfl: {
    league: 'nfl',
    label: 'NFL',
  },
  nba: {
    league: 'nba',
    label: 'NBA',
  },
  mlb: {
    league: 'mlb',
    label: 'MLB',
  },
  nhl: {
    league: 'nhl',
    label: 'NHL',
  },
  ufc: {
    league: 'ufc',
    label: 'UFC',
  },
  cbb: {
    // College basketball teams (NCAA). Gamma's /teams endpoint accepts
    // "cbb" as the league identifier, and each team row includes a
    // season record string that we surface in the frontend.
    league: 'cbb',
    label: 'College Basketball',
  },
  epl: {
    league: 'epl',
    label: 'English Premier League',
  },
  'lal': {
    league: 'lal',
    label: 'La Liga',
  },
};

/**
 * Get league name for a sport category
 * @param sport - Sport name (e.g., 'nfl', 'nba')
 * @returns league name string if sport exists, null otherwise
 */
export function getLeagueForSport(sport: string): string | null {
  const normalizedSport = sport.toLowerCase().trim();
  const config = TEAMS_CONFIG[normalizedSport];
  return config ? config.league : null;
}

/**
 * Get full config for a sport category
 * @param sport - Sport name (e.g., 'nfl', 'nba')
 * @returns LeagueConfig if sport exists, null otherwise
 */
export function getLeagueConfig(sport: string): LeagueConfig | null {
  const normalizedSport = sport.toLowerCase().trim();
  return TEAMS_CONFIG[normalizedSport] || null;
}

/**
 * Check if a sport/league is valid
 * @param sport - Sport name to validate
 * @returns true if sport exists in config
 */
export function isValidLeague(sport: string): boolean {
  const normalizedSport = sport.toLowerCase().trim();
  return normalizedSport in TEAMS_CONFIG;
}

/**
 * Get all available leagues
 * @returns Array of sport names
 */
export function getAvailableLeagues(): string[] {
  return Object.keys(TEAMS_CONFIG);
}

/**
 * Get all league configurations
 * @returns TeamsConfig object
 */
export function getAllLeaguesConfig(): TeamsConfig {
  return TEAMS_CONFIG;
}

