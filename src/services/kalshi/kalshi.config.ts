/**
 * Kalshi Configuration
 * Maps our sports to Kalshi series_ticker patterns
 */

// Map our sports to Kalshi series_ticker patterns
// Kalshi uses series_ticker like "KXNBA" for NBA
export const KALSHI_SPORT_SERIES: Record<string, string[]> = {
  nba: ['KXNBAGAME', 'KXNBASPREAD', 'KXNBATOTAL', 'KXNBATEAMTOTAL'],
  nfl: ['KXNFLGAME', 'KXNFLSPREAD', 'KXNFLTOTAL', 'KXSB'],  // KXSB = Super Bowl
  nhl: ['KXNHLGAME', 'KXNHLSPREAD', 'KXNHLTOTAL'],
  epl: ['KXEPLGAME'],
  lal: ['KXLALIGAGAME'],
  ufc: ['KXUFCFIGHT'],
  tennis: ['KXATPMATCH', 'KXWTAMATCH'],
  cbb: ['KXNCAAMBGAME', 'KXNCAAWBGAME'],
  // Note: CFB does not have individual game markets on Kalshi
  // Men's Winter Olympics Hockey (2026 Milan-Cortina)
  // Single binary market per game: YES = first team (away) wins, NO = second team (home) wins
  // Kalshi uses ISO 3166-1 alpha-3 codes (CHE, DEU, LVA…); our slugs use common abbrs (SWI, GER, LAT…)
  mwoh: ['KXWOMHOCKEY'],
};

// Reverse mapping: series ticker -> our sport identifier
const SERIES_TO_SPORT: Record<string, string> = {};
for (const [sport, seriesTickers] of Object.entries(KALSHI_SPORT_SERIES)) {
  for (const ticker of seriesTickers) {
    SERIES_TO_SPORT[ticker.toUpperCase()] = sport;
  }
}

/**
 * Get our sport identifier from a Kalshi series ticker
 * @param seriesTicker - Kalshi series ticker (e.g., "KXNBA")
 * @returns Our sport identifier (e.g., "nba") or null if not supported
 */
export function getSportFromKalshiSeries(seriesTicker: string): string | null {
  if (!seriesTicker) return null;
  return SERIES_TO_SPORT[seriesTicker.toUpperCase()] || null;
}

/**
 * Get all supported sports for Kalshi integration
 */
export function getSupportedKalshiSports(): string[] {
  return Object.keys(KALSHI_SPORT_SERIES);
}

/**
 * Check if a sport is supported for Kalshi integration
 */
export function isKalshiSportSupported(sport: string): boolean {
  return sport.toLowerCase() in KALSHI_SPORT_SERIES;
}
