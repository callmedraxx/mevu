/**
 * Sports Games Configuration
 * Maps sport category names to their Polymarket series numbers for games markets
 */

export interface SportGameConfig {
  seriesId: string;
  label: string;
}

export interface SportsGamesConfig {
  [sport: string]: SportGameConfig;
}

/**
 * Sports games configuration
 * Maps sport names to their series numbers for fetching game series summaries
 * 
 * Note: Series IDs can be found by inspecting Polymarket API responses or network requests
 * To add a new sport, add an entry here with the correct series_id
 * 
 * Example: NFL 2025 has series_id 10187
 */
const SPORTS_GAMES_CONFIG: SportsGamesConfig = {
  nfl: {
    seriesId: '10187',
    label: 'NFL',
  },
  nba: {
    seriesId: '10345', // TODO: Add NBA series ID when available
    label: 'NBA',
  },
  mlb: {
    seriesId: '3', // TODO: Add MLB series ID when available
    label: 'MLB',
  },
  nhl: {
    seriesId: '10346', // TODO: Add NHL series ID when available
    label: 'NHL',
  },
  ufc: {
    seriesId: '', // TODO: Add UFC series ID when available
    label: 'UFC',
  },
  epl: {
    seriesId: '10188', // TODO: Add EPL series ID when available
    label: 'English Premier League',
  },
  'lal': {
    seriesId: '10193', // TODO: Add La Liga series ID when available
    label: 'La Liga',
  },
  valorant: {
    seriesId: 'valorant', // Esports - Valorant
    label: 'Valorant',
  },
  cbb: {
    seriesId: '10347', // College Basketball
    label: 'College Basketball',
  },
  cfb: {
    seriesId: '10348', // College Football
    label: 'College Football',
  },
};

/**
 * Get series_id for a sport category
 * @param sport - Sport name (e.g., 'nfl', 'nba')
 * @returns series_id string if sport exists, null otherwise
 */
export function getSeriesIdForSport(sport: string): string | null {
  const normalizedSport = sport.toLowerCase().trim();
  const config = SPORTS_GAMES_CONFIG[normalizedSport];
  return config && config.seriesId ? config.seriesId : null;
}

/**
 * Get full config for a sport category
 * @param sport - Sport name (e.g., 'nfl', 'nba')
 * @returns SportGameConfig if sport exists, null otherwise
 */
export function getSportGameConfig(sport: string): SportGameConfig | null {
  const normalizedSport = sport.toLowerCase().trim();
  return SPORTS_GAMES_CONFIG[normalizedSport] || null;
}

/**
 * Check if a sport is valid
 * @param sport - Sport name to validate
 * @returns true if sport exists in config
 */
export function isValidSport(sport: string): boolean {
  const normalizedSport = sport.toLowerCase().trim();
  return normalizedSport in SPORTS_GAMES_CONFIG;
}

/**
 * Get all available sports
 * @returns Array of sport names
 */
export function getAvailableSports(): string[] {
  return Object.keys(SPORTS_GAMES_CONFIG);
}

/**
 * Get all sport game configurations
 * @returns SportsGamesConfig object
 */
export function getAllSportsGamesConfig(): SportsGamesConfig {
  return SPORTS_GAMES_CONFIG;
}

