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
    seriesId: '38', // UFC series ID (Polymarket Gamma: series slug "ufc", id 38; 10500 returns NFLX)
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
  tennis: {
    // Tennis games use slugs like "atp-..." and "wta-...".
    // Polymarket has separate series for ATP (10365) and WTA (10366).
    // We use ATP series ID as the primary, and fetchSportsGamesForSport
    // will also fetch WTA games separately.
    // SeriesIdSyncService can override this at runtime if needed.
    seriesId: '10365', // ATP series ID
    label: 'Tennis',
  },
  cbb: {
    // NOTE: This series id is what Gamma uses for current NCAA CBB events.
    // We observed `cbb-toledo-umass-2026-01-20` belongs to series id 10470.
    seriesId: '10470', // NCAA CBB
    label: 'College Basketball',
  },
  cfb: {
    // Observed `cfb-2025` series id is 10210 (and it may change seasonally)
    seriesId: '10210', // College Football (fallback)
    label: 'College Football',
  },
  mwoh: {
    // Men's Winter Olympics Hockey (2026 Winter Olympics)
    // Slug format: mwoh-{team1}-{team2}-{date} e.g. mwoh-swi-fra-2026-02-12
    // Outcomes are full country names e.g. ["Switzerland", "France"]
    seriesId: '11136',
    label: "Men's Winter Olympics Hockey",
  },
};

// Runtime overrides (populated from Gamma /series at startup)
const SERIES_ID_OVERRIDES: Record<string, string> = {};

export function setSeriesIdOverride(sport: string, seriesId: string): void {
  const normalizedSport = sport.toLowerCase().trim();
  if (!normalizedSport) return;
  if (!seriesId) return;
  SERIES_ID_OVERRIDES[normalizedSport] = String(seriesId);
}

/**
 * Clear series ID override for a sport (reverts to static config)
 * @param sport - Sport name (e.g., 'ufc')
 */
export function clearSeriesIdOverride(sport: string): void {
  const normalizedSport = sport.toLowerCase().trim();
  if (!normalizedSport) return;
  delete SERIES_ID_OVERRIDES[normalizedSport];
}

/**
 * Get series_id for a sport category
 * @param sport - Sport name (e.g., 'nfl', 'nba')
 * @returns series_id string if sport exists, null otherwise
 */
export function getSeriesIdForSport(sport: string): string | null {
  const normalizedSport = sport.toLowerCase().trim();
  const override = SERIES_ID_OVERRIDES[normalizedSport];
  if (override) return override;
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

