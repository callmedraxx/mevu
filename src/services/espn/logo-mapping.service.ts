/**
 * Logo Mapping Service
 * Maps team abbreviations to logo URLs
 * Pre-downloads logos and stores mapping for fast lookup
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import { logger } from '../../config/logger';

const LOGOS_DIR = path.join(process.cwd(), 'public', 'logos');
const LOGO_MAPPING_FILE = path.join(process.cwd(), 'data', 'logo-mapping.json');

/**
 * ESPN league mappings
 */
const ESPN_LEAGUE_MAP: Record<string, string> = {
  nfl: 'football/nfl',
  nba: 'basketball/nba',
  mlb: 'baseball/mlb',
  nhl: 'hockey/nhl',
  epl: 'soccer/eng.1',
  lal: 'soccer/esp.1',
};

/**
 * Logo mapping structure
 * Key: "{league}-{abbreviation}" (e.g., "nfl-KC", "nba-LAL")
 * Value: logo file extension (e.g., "png", "jpg")
 */
type LogoMapping = Record<string, string>;

/**
 * In-memory logo mapping cache
 */
let logoMapping: LogoMapping = {};

/**
 * Get mapping key from league and abbreviation
 */
function getMappingKey(league: string, abbreviation: string): string {
  return `${league.toLowerCase()}-${abbreviation.toUpperCase()}`;
}

/**
 * Get logo URL for serving
 */
function getLogoUrl(league: string, abbreviation: string, extension: string): string {
  const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
  return `${baseUrl}/api/logos/${league}/${abbreviation.toUpperCase()}.${extension}`;
}

/**
 * Get local logo file path
 */
function getLocalLogoPath(league: string, abbreviation: string, extension: string): string {
  return path.join(LOGOS_DIR, `${league}-${abbreviation.toUpperCase()}.${extension}`);
}

/**
 * Ensure directories exist
 */
async function ensureDirectories(): Promise<void> {
  await fs.mkdir(LOGOS_DIR, { recursive: true });
  await fs.mkdir(path.dirname(LOGO_MAPPING_FILE), { recursive: true });
}

/**
 * Load logo mapping from file
 */
async function loadLogoMapping(): Promise<void> {
  try {
    const data = await fs.readFile(LOGO_MAPPING_FILE, 'utf-8');
    logoMapping = JSON.parse(data);
    // logger.info({
    //   message: 'Logo mapping loaded',
    //   count: Object.keys(logoMapping).length,
    // });
  } catch (error) {
    // File doesn't exist yet, start with empty mapping
    logoMapping = {};
    // logger.info({
    //   message: 'Logo mapping file not found, starting with empty mapping',
    // });
  }
}

/**
 * Save logo mapping to file
 */
async function saveLogoMapping(): Promise<void> {
  try {
    await ensureDirectories();
    await fs.writeFile(LOGO_MAPPING_FILE, JSON.stringify(logoMapping, null, 2));
    // logger.info({
    //   message: 'Logo mapping saved',
    //   count: Object.keys(logoMapping).length,
    // });
  } catch (error) {
    logger.error({
      message: 'Error saving logo mapping',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get ESPN team URL
 */
function getEspnTeamUrl(league: string, abbreviation: string): string {
  const espnLeague = ESPN_LEAGUE_MAP[league.toLowerCase()];
  if (!espnLeague) {
    throw new Error(`Unsupported league for ESPN: ${league}`);
  }
  return `https://site.api.espn.com/apis/site/v2/sports/${espnLeague}/teams/${abbreviation.toLowerCase()}`;
}

/**
 * Extract logo URL from ESPN team data
 */
function extractLogoUrl(teamData: any): string | null {
  try {
    if (teamData?.team?.logos && Array.isArray(teamData.team.logos) && teamData.team.logos.length > 0) {
      return teamData.team.logos[0].href;
    }
    if (teamData?.logos && Array.isArray(teamData.logos) && teamData.logos.length > 0) {
      return teamData.logos[0].href;
    }
  } catch (error) {
    logger.warn({
      message: 'Error extracting logo URL from ESPN data',
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

/**
 * Download logo image
 */
async function downloadLogo(url: string, filePath: string): Promise<void> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 10000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
  });
  await fs.writeFile(filePath, response.data);
}

/**
 * Logo Mapping Service
 */
export class LogoMappingService {
  /**
   * Initialize service - load mapping from file
   */
  async initialize(): Promise<void> {
    await ensureDirectories();
    await loadLogoMapping();
  }

  /**
   * Get logo URL for a team by abbreviation
   * @param league - League name (e.g., 'nfl', 'nba')
   * @param abbreviation - Team abbreviation (e.g., 'KC', 'LAL')
   * @returns Logo URL or null if not found
   */
  getLogoUrl(league: string, abbreviation: string): string | null {
    const key = getMappingKey(league, abbreviation);
    const extension = logoMapping[key];
    
    if (!extension) {
      return null;
    }

    return getLogoUrl(league, abbreviation, extension);
  }

  /**
   * Check if logo exists for a team
   */
  hasLogo(league: string, abbreviation: string): boolean {
    const key = getMappingKey(league, abbreviation);
    return key in logoMapping;
  }

  /**
   * Download and map logo for a team
   * @param league - League name
   * @param abbreviation - Team abbreviation
   * @returns Logo URL if successful, null otherwise
   */
  async downloadAndMapLogo(league: string, abbreviation: string): Promise<string | null> {
    // Logo downloading is disabled
    return null;
    /* DISABLED
    try {
      // Check if already mapped
      if (this.hasLogo(league, abbreviation)) {
        return this.getLogoUrl(league, abbreviation);
      }

      await ensureDirectories();

      // Get ESPN team URL
      const espnUrl = getEspnTeamUrl(league, abbreviation);
      
      logger.info({
        message: 'Fetching logo from ESPN',
        league,
        abbreviation,
        espnUrl,
      });

      // Fetch team data from ESPN
      const response = await axios.get(espnUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });

      // Extract logo URL
      const logoUrl = extractLogoUrl(response.data);
      
      if (!logoUrl) {
        logger.warn({
          message: 'No logo URL found in ESPN response',
          league,
          abbreviation,
        });
        return null;
      }

      // Determine file extension
      const urlExtension = logoUrl.split('.').pop()?.split('?')[0] || 'png';
      const finalPath = getLocalLogoPath(league, abbreviation, urlExtension);

      // Download logo
      await downloadLogo(logoUrl, finalPath);

      // Update mapping
      const key = getMappingKey(league, abbreviation);
      logoMapping[key] = urlExtension;
      await saveLogoMapping();

      logger.info({
        message: 'Logo downloaded and mapped',
        league,
        abbreviation,
        extension: urlExtension,
      });

      return getLogoUrl(league, abbreviation, urlExtension);
    } catch (error) {
      logger.error({
        message: 'Error downloading logo',
        league,
        abbreviation,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    */
  }

  /**
   * Batch download logos for multiple teams
   * @param teams - Array of {league, abbreviation} objects
   */
  async downloadLogosForTeams(
    teams: Array<{ league: string; abbreviation: string }>
  ): Promise<Map<string, string>> {
    // Logo downloading is disabled
    return new Map<string, string>();
    /* DISABLED
    const results = new Map<string, string>();

    logger.info({
      message: 'Starting batch logo download',
      teamCount: teams.length,
    });

    // Process in batches
    const batchSize = 5;
    for (let i = 0; i < teams.length; i += batchSize) {
      const batch = teams.slice(i, i + batchSize);
      
      const batchResults = await Promise.allSettled(
        batch.map(async (team) => {
          const logoUrl = await this.downloadAndMapLogo(team.league, team.abbreviation);
          return { key: getMappingKey(team.league, team.abbreviation), logoUrl };
        })
      );

      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value.logoUrl) {
          results.set(result.value.key, result.value.logoUrl);
        } else {
          logger.warn({
            message: 'Failed to download logo',
            league: batch[index].league,
            abbreviation: batch[index].abbreviation,
            error: result.status === 'rejected' ? result.reason?.message : 'Unknown error',
          });
        }
      });

      // Small delay between batches
      if (i + batchSize < teams.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    logger.info({
      message: 'Batch logo download completed',
      total: teams.length,
      successful: results.size,
      failed: teams.length - results.size,
    });

    return results;
    */
  }

  /**
   * Get all mappings
   */
  getAllMappings(): LogoMapping {
    return { ...logoMapping };
  }

  /**
   * Get logo file path for serving
   */
  getLogoFilePath(league: string, abbreviation: string): string | null {
    const key = getMappingKey(league, abbreviation);
    const extension = logoMapping[key];
    
    if (!extension) {
      return null;
    }

    return getLocalLogoPath(league, abbreviation, extension);
  }
}

// Export singleton instance
export const logoMappingService = new LogoMappingService();

