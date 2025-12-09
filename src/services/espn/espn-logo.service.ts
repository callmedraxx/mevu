/**
 * ESPN Logo Service
 * Fetches and downloads team logos from ESPN API
 */

import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../config/logger';
import { Team } from '../polymarket/teams.service';

const LOGOS_DIR = path.join(process.cwd(), 'public', 'logos');
const ESPN_API_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

/**
 * ESPN league mappings
 * Maps our league names to ESPN API league paths
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
 * Get ESPN team ID from team abbreviation
 * ESPN API uses team abbreviations in URLs
 */
function getEspnTeamUrl(league: string, abbreviation: string): string {
  const espnLeague = ESPN_LEAGUE_MAP[league.toLowerCase()];
  if (!espnLeague) {
    throw new Error(`Unsupported league for ESPN: ${league}`);
  }

  // ESPN API endpoint for team info
  return `${ESPN_API_BASE}/${espnLeague}/teams/${abbreviation.toLowerCase()}`;
}

/**
 * Extract logo URL from ESPN team data
 */
function extractLogoUrl(teamData: any): string | null {
  try {
    // ESPN team data structure
    if (teamData?.team?.logos && Array.isArray(teamData.team.logos) && teamData.team.logos.length > 0) {
      // Prefer the first logo (usually the primary one)
      return teamData.team.logos[0].href;
    }
    
    // Alternative structure
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
 * Download logo image from URL
 */
async function downloadLogo(url: string, filePath: string): Promise<void> {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    await fs.writeFile(filePath, response.data);
    
    logger.info({
      message: 'Logo downloaded successfully',
      url,
      filePath,
    });
  } catch (error) {
    logger.error({
      message: 'Error downloading logo',
      url,
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Ensure logos directory exists
 */
async function ensureLogosDirectory(): Promise<void> {
  try {
    await fs.mkdir(LOGOS_DIR, { recursive: true });
  } catch (error) {
    logger.error({
      message: 'Error creating logos directory',
      directory: LOGOS_DIR,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Get local logo file path
 */
function getLocalLogoPath(league: string, teamId: number, extension: string = 'png'): string {
  return path.join(LOGOS_DIR, `${league}-${teamId}.${extension}`);
}

/**
 * Get logo URL for serving
 */
function getLogoUrl(league: string, teamId: number, extension: string = 'png'): string {
  const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
  return `${baseUrl}/api/logos/${league}/${teamId}.${extension}`;
}

/**
 * ESPN Logo Service
 */
export class EspnLogoService {
  /**
   * Fetch and download logo for a team
   * @param team - Team object with league and abbreviation
   * @returns Local logo URL or null if failed
   */
  async fetchAndDownloadLogo(team: Team): Promise<string | null> {
    try {
      // Check if logo already exists locally
      const localPath = getLocalLogoPath(team.league, team.id);
      try {
        await fs.access(localPath);
        // Logo already exists, return URL
        logger.debug({
          message: 'Logo already exists locally',
          teamId: team.id,
          league: team.league,
        });
        return getLogoUrl(team.league, team.id);
      } catch {
        // Logo doesn't exist, proceed to download
      }

      // Ensure directory exists
      await ensureLogosDirectory();

      // Get ESPN team URL
      const espnUrl = getEspnTeamUrl(team.league, team.abbreviation);
      
      logger.info({
        message: 'Fetching team data from ESPN',
        teamId: team.id,
        league: team.league,
        abbreviation: team.abbreviation,
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
          teamId: team.id,
          league: team.league,
          abbreviation: team.abbreviation,
        });
        return null;
      }

      // Determine file extension from URL
      const urlExtension = logoUrl.split('.').pop()?.split('?')[0] || 'png';
      const finalPath = getLocalLogoPath(team.league, team.id, urlExtension);

      // Download logo
      await downloadLogo(logoUrl, finalPath);

      // Return local URL
      return getLogoUrl(team.league, team.id, urlExtension);
    } catch (error) {
      logger.error({
        message: 'Error fetching ESPN logo',
        teamId: team.id,
        league: team.league,
        abbreviation: team.abbreviation,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Batch fetch and download logos for multiple teams
   * @param teams - Array of teams
   * @returns Map of team ID to logo URL
   */
  async fetchAndDownloadLogos(teams: Team[]): Promise<Map<number, string>> {
    const results = new Map<number, string>();

    logger.info({
      message: 'Starting batch logo download',
      teamCount: teams.length,
    });

    // Process teams in batches to avoid overwhelming the API
    const batchSize = 5;
    for (let i = 0; i < teams.length; i += batchSize) {
      const batch = teams.slice(i, i + batchSize);
      
      const batchResults = await Promise.allSettled(
        batch.map(async (team) => {
          const logoUrl = await this.fetchAndDownloadLogo(team);
          return { teamId: team.id, logoUrl };
        })
      );

      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value.logoUrl) {
          results.set(result.value.teamId, result.value.logoUrl);
        } else {
          logger.warn({
            message: 'Failed to fetch logo for team',
            teamId: batch[index].id,
            league: batch[index].league,
            error: result.status === 'rejected' ? result.reason?.message : 'Unknown error',
          });
        }
      });

      // Small delay between batches to be respectful
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
  }

  /**
   * Check if logo exists locally
   */
  async logoExists(league: string, teamId: number): Promise<boolean> {
    try {
      // Try common extensions
      const extensions = ['png', 'jpg', 'jpeg', 'svg'];
      for (const ext of extensions) {
        const logoPath = getLocalLogoPath(league, teamId, ext);
        try {
          await fs.access(logoPath);
          return true;
        } catch {
          // Continue to next extension
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Get local logo path (if exists)
   */
  async getLocalLogoPath(league: string, teamId: number): Promise<string | null> {
    const extensions = ['png', 'jpg', 'jpeg', 'svg'];
    for (const ext of extensions) {
      const logoPath = getLocalLogoPath(league, teamId, ext);
      try {
        await fs.access(logoPath);
        return logoPath;
      } catch {
        // Continue to next extension
      }
    }
    return null;
  }
}

// Export singleton instance
export const espnLogoService = new EspnLogoService();

