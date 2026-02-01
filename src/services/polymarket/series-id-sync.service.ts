import axios from 'axios';
import { logger } from '../../config/logger';
import { setSeriesIdOverride, clearSeriesIdOverride } from './sports-games.config';

type GammaSportsResponse = Array<{
  id: number;
  sport: string;
  series: string;
  image?: string;
  resolution?: string;
  ordering?: string;
  tags?: string;
  createdAt?: string;
}>;

const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';

/**
 * Map internal sport names to Polymarket /sports endpoint sport names
 * Some sports have different names in the /sports endpoint (e.g., "ufc" -> "mma")
 */
function mapSportToPolymarketSport(sport: string): string[] {
  const normalized = sport.toLowerCase().trim();
  
  switch (normalized) {
    case 'ufc':
      // UFC is listed as "mma" in the /sports endpoint
      return ['mma'];
    case 'tennis':
      // Tennis has separate entries for "atp" and "wta" in /sports
      // We'll handle both separately in refreshOnce
      return ['atp', 'wta'];
    case 'cbb':
      // CBB exists in /sports endpoint (series 10470)
      // "ncaab" also exists but is for March Madness (series 39)
      return ['cbb', 'ncaab']; // Prefer "cbb" for regular season
    default:
      // Most sports match directly
      return [normalized];
  }
}

export class SeriesIdSyncService {
  private initialized = false;
  private pollingInterval: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * Fetch sports data from Gamma /sports endpoint
   * This endpoint provides the authoritative list of current series IDs for each sport
   */
  async fetchSportsFromGamma(): Promise<GammaSportsResponse> {
    const url = `${GAMMA_BASE_URL}/sports`;
    const res = await axios.get<GammaSportsResponse>(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
      timeout: 30000,
      validateStatus: (s) => s < 500,
    });

    if (res.status !== 200) {
      throw new Error(`Failed to fetch sports from Gamma: ${res.status}`);
    }

    return Array.isArray(res.data) ? res.data : [];
  }

  /**
   * Resolve and apply seriesId overrides from Gamma /sports endpoint.
   * This is more reliable than querying by slug, as it provides the authoritative
   * current series IDs directly from Polymarket.
   * Safe: on failure, we keep the static config as fallback.
   */
  async refreshOnce(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      // Fetch all sports from the /sports endpoint
      const sportsData = await this.fetchSportsFromGamma();
      
      // Create a map of Polymarket sport -> series ID
      const sportToSeriesMap = new Map<string, string>();
      for (const sportEntry of sportsData) {
        if (sportEntry.sport && sportEntry.series && sportEntry.series !== 'TBD') {
          sportToSeriesMap.set(sportEntry.sport.toLowerCase(), sportEntry.series);
        }
      }

      const sportsToSync = ['cbb', 'cfb', 'nfl', 'nba', 'nhl', 'epl', 'ufc', 'tennis'];

      for (const sport of sportsToSync) {
        const polymarketSports = mapSportToPolymarketSport(sport);
        
        if (sport === 'tennis') {
          // Special handling for tennis: we use ATP series ID as primary
          // WTA is fetched separately in fetchSportsGamesForSport
          const atpSeriesId = sportToSeriesMap.get('atp');
          if (atpSeriesId) {
            setSeriesIdOverride('tennis', atpSeriesId);
            // logger.info({
            //   message: '[SERIES-ID] Synced tennis series id from /sports endpoint',
            //   sport: 'tennis',
            //   seriesId: atpSeriesId,
            //   source: 'atp',
            // });
          } else {
            logger.warn({
              message: '[SERIES-ID] ATP series ID not found in /sports endpoint',
              sport: 'tennis',
            });
          }
        } else if (sport === 'ufc') {
          // Exception for UFC: Use series ID 38 (Polymarket series slug "ufc"), NOT 10500
          // The "mma" series ID (10500) from /sports returns NFLX games, not UFC games
          setSeriesIdOverride('ufc', '38');
        } else {
          // For other sports, find the matching Polymarket sport
          let found = false;
          for (const pmSport of polymarketSports) {
            const seriesId = sportToSeriesMap.get(pmSport);
            if (seriesId) {
              setSeriesIdOverride(sport, seriesId);
              // logger.info({
              //   message: '[SERIES-ID] Synced series id from /sports endpoint',
              //   sport,
              //   polymarketSport: pmSport,
              //   seriesId,
              // });
              found = true;
              break;
            }
          }
          
          if (!found) {
            logger.warn({
              message: '[SERIES-ID] No series id found in /sports endpoint (using static config)',
              sport,
              polymarketSports,
            });
          }
        }
      }
    } catch (error) {
      logger.error({
        message: '[SERIES-ID] Error syncing series IDs from /sports endpoint',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Start daily refresh (and run once immediately).
   * This keeps series IDs up-to-date without requiring restarts.
   */
  async start(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    await this.refreshOnce();

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    this.pollingInterval = setInterval(() => {
      this.refreshOnce().catch((error) => {
        logger.warn({
          message: '[SERIES-ID] Daily refresh failed (will retry next interval)',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, ONE_DAY_MS);

    // logger.info({
    //   message: '[SERIES-ID] Daily series id refresh scheduled',
    //   intervalHours: 24,
    // });
  }
}

export const seriesIdSyncService = new SeriesIdSyncService();

