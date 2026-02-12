/**
 * Geo Region Utility
 * Maps country codes to trading regions for Kalshi (US) vs Polymarket (international)
 */

export type TradingRegion = 'us' | 'international';

/** US country code (ISO 3166-1 alpha-2) */
const US_COUNTRY_CODE = 'US';

/**
 * Maps a country code to trading region.
 * US users get Kalshi/Solana flow; others get Polymarket/Polygon flow.
 *
 * @param countryCode - ISO 3166-1 alpha-2 country code (e.g. 'US', 'GB')
 * @returns 'us' for United States, 'international' for all other countries
 */
export function getRegionFromCountryCode(countryCode: string | undefined | null): TradingRegion {
  if (!countryCode || typeof countryCode !== 'string') {
    return 'international';
  }
  const normalized = countryCode.trim().toUpperCase();
  return normalized === US_COUNTRY_CODE ? 'us' : 'international';
}

/**
 * Checks if the region allows Kalshi trading (US only).
 */
export function isKalshiRegion(region: TradingRegion): boolean {
  return region === 'us';
}

/**
 * Checks if the region allows Polymarket trading (non-US).
 */
export function isPolymarketRegion(region: TradingRegion): boolean {
  return region === 'international';
}
