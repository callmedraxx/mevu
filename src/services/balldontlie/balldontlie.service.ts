/**
 * Ball Don't Lie API Service
 * Fetches player statistics and game data for multiple sports using the official SDK
 * Supports: NBA, NFL, MLB, NHL, EPL, NCAAF, NCAAB, Bundesliga, La Liga, Serie A, Ligue 1
 * Maps CFB → NCAAF and CBB → NCAAB for API compatibility
 * @see https://www.npmjs.com/package/@balldontlie/sdk
 * @see https://www.balldontlie.io/openapi.yml
 */

import { BalldontlieAPI } from '@balldontlie/sdk';
import { logger } from '../../config/logger';
import { pool } from '../../config/database';
import { getGameFromCacheById } from '../polymarket/live-games.service';
import { teamsService } from '../polymarket/teams.service';
import { getLeagueForSport } from '../polymarket/teams.config';

/**
 * Type for all supported Ball Don't Lie sports
 * Soccer leagues: EPL, La Liga, Serie A, Bundesliga, Ligue 1
 * Tennis: ATP (men's), WTA (women's)
 */
type BallDontLieSport = 'nba' | 'nfl' | 'mlb' | 'nhl' | 'epl' | 'ncaaf' | 'ncaab' | 
  'laliga' | 'seriea' | 'bundesliga' | 'ligue1' | 'atp' | 'wta';

/**
 * Check if a sport is a soccer/football league
 */
function isSoccerSport(sport: BallDontLieSport | null): boolean {
  return sport !== null && ['epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'].includes(sport);
}

/**
 * Check if a sport is tennis (ATP or WTA)
 */
function isTennisSport(sport: BallDontLieSport | null): boolean {
  return sport !== null && (sport === 'atp' || sport === 'wta');
}

/**
 * Convert a UTC date to the Ball Don't Lie API's expected timezone and extract the date string.
 * - For US sports (NBA, NFL, MLB, NHL, NCAAF, NCAAB): Use US Eastern timezone
 * - For European soccer leagues: Use Europe timezone based on league
 * 
 * The Ball Don't Lie API uses local dates for the `dates[]` query parameter,
 * not UTC dates. For example, a game at 2025-12-30T03:30:00Z (UTC) which is
 * 10:30 PM Eastern on Dec 29 should be queried with date=2025-12-29.
 * 
 * @param utcDate - Date object in UTC
 * @param sport - The sport to determine the appropriate timezone
 * @returns Date string in YYYY-MM-DD format in the API's expected timezone
 */
function convertToApiTimezone(utcDate: Date, sport: string): string {
  const bdSport = getBalldontlieSport(sport);
  
  // Determine timezone based on sport
  let timezone: string;
  if (isTennisSport(bdSport)) {
    // Tennis tournaments are global; use UTC for date extraction
    timezone = 'UTC';
  } else if (isSoccerSport(bdSport)) {
    // European soccer leagues use their respective timezones
    // Most use CET (Central European Time) or GMT
    switch (bdSport) {
      case 'epl':
        timezone = 'Europe/London'; // GMT/BST
        break;
      case 'laliga':
        timezone = 'Europe/Madrid'; // CET/CEST
        break;
      case 'seriea':
        timezone = 'Europe/Rome'; // CET/CEST
        break;
      case 'bundesliga':
        timezone = 'Europe/Berlin'; // CET/CEST
        break;
      case 'ligue1':
        timezone = 'Europe/Paris'; // CET/CEST
        break;
      default:
        timezone = 'Europe/London';
    }
  } else {
    // US sports use Eastern timezone (where most leagues are headquartered)
    timezone = 'America/New_York';
  }
  
  // Convert UTC to the target timezone and extract date
  // Using toLocaleDateString with the timezone option
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };
  
  // Format: MM/DD/YYYY -> convert to YYYY-MM-DD
  const localeDateStr = utcDate.toLocaleDateString('en-US', options);
  const [month, day, year] = localeDateStr.split('/');
  const apiDateStr = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  
  // logger.debug({
  //   message: 'Converted UTC date to API timezone',
  //   utcDate: utcDate.toISOString(),
  //   sport,
  //   timezone,
  //   apiDateStr,
  // });
  
  return apiDateStr;
}

/**
 * Sport mapping from our internal sport names to Ball Don't Lie API sport names
 * Maps CFB → NCAAF and CBB → NCAAB for Ball Don't Lie API compatibility
 * Supported sports: NBA, NFL, MLB, NHL, EPL, NCAAF, NCAAB, Bundesliga, La Liga, Serie A, Ligue 1
 */
const SPORT_MAPPING: Record<string, BallDontLieSport | null> = {
  nba: 'nba',
  nfl: 'nfl',
  mlb: 'mlb',
  nhl: 'nhl',
  epl: 'epl',
  // NCAA sports - map CFB/CBB to NCAAF/NCAAB
  cfb: 'ncaaf', // College Football → NCAA Football
  cbb: 'ncaab', // College Basketball → NCAA Basketball
  ncaaf: 'ncaaf',
  ncaab: 'ncaab',
  'college football': 'ncaaf',
  'college basketball': 'ncaab',
  'ncaa football': 'ncaaf',
  'ncaa basketball': 'ncaab',
  // European soccer leagues - all supported by Ball Don't Lie API
  bundesliga: 'bundesliga',
  bund: 'bundesliga',
  laliga: 'laliga',
  lal: 'laliga', // La Liga abbreviation used in slugs
  'la liga': 'laliga',
  seriea: 'seriea',
  ser: 'seriea', // Serie A abbreviation
  'serie a': 'seriea',
  ligue1: 'ligue1',
  lig: 'ligue1', // Ligue 1 abbreviation
  'ligue 1': 'ligue1',
  // UEFA Champions League
  ucl: 'ucl' as BallDontLieSport,
  // Tennis - ATP (men's) and WTA (women's)
  tennis: 'atp', // Default to ATP when sport is generic 'tennis'; slug (atp-*/wta-*) determines actual league
  atp: 'atp',
  wta: 'wta',
};

/**
 * Get API key from environment
 */
function getApiKey(): string {
  return process.env.BALLDONTLIE_API_KEY || '';
}

/**
 * Get Ball Don't Lie sport name from internal sport name
 */
function getBalldontlieSport(sport: string): BallDontLieSport | null {
  const normalized = sport.toLowerCase().trim();
  return SPORT_MAPPING[normalized] || null;
}

/**
 * Check if a sport is supported by Ball Don't Lie API
 */
export function isSportSupported(sport: string): boolean {
  return getBalldontlieSport(sport) !== null;
}

/**
 * Resolve effective sport for Ball Don't Lie when sport is generic 'tennis'.
 * Polymarket uses sport='tennis' for both ATP and WTA; slug (atp-*, wta-*) identifies the league.
 */
function getEffectiveTennisLeague(game: any): 'atp' | 'wta' {
  const slug = (game.slug || '').toLowerCase();
  return slug.startsWith('wta') ? 'wta' : 'atp';
}

/**
 * Ball Don't Lie API client using official SDK
 */
class BallDontLieClient {
  private api: BalldontlieAPI;

  constructor() {
    const apiKey = getApiKey();
    if (!apiKey) {
      logger.warn({
        message: 'BALLDONTLIE_API_KEY not set - API calls may fail',
      });
    }
    
    this.api = new BalldontlieAPI({
      apiKey: apiKey,
    });
  }

  /**
   * Get player stats for specific games
   * @param sport - Sport name (nba, nfl, mlb, nhl, epl, ncaaf, ncaab)
   * @param gameIds - Array of Ball Don't Lie game IDs
   * @returns Player stats array
   */
  async getPlayerStats(sport: string, gameIds: number[]): Promise<any[]> {
    if (gameIds.length === 0) {
      return [];
    }

    const balldontlieSport = getBalldontlieSport(sport);
    if (!balldontlieSport) {
      throw new Error(`Sport ${sport} is not supported by Ball Don't Lie API`);
    }

    try {
      let response;
      
      switch (balldontlieSport) {
        case 'nba':
          response = await this.api.nba.getStats({ game_ids: gameIds });
          return response.data || [];
        case 'nfl':
          response = await this.api.nfl.getStats({ game_ids: gameIds });
          return response.data || [];
        case 'mlb':
          response = await this.api.mlb.getStats({ game_ids: gameIds });
          return response.data || [];
        case 'nhl':
          // NHL not in SDK yet, use direct API call
          return await this.getNHLStatsDirect(gameIds);
        case 'epl':
        case 'bundesliga':
        case 'laliga':
        case 'seriea':
        case 'ligue1':
          // Soccer leagues use /player_match_stats with match_ids[] parameter
          return await this.getSoccerStatsDirect(balldontlieSport, gameIds);
        case 'ncaaf':
          // NCAAF not in SDK yet, use direct API call
          return await this.getNCAAFStatsDirect(gameIds);
        case 'ncaab':
          // NCAAB not in SDK yet, use direct API call
          return await this.getNCAABStatsDirect(gameIds);
        case 'atp':
        case 'wta':
          // Tennis uses /match_stats with match_ids[] parameter
          return await this.getTennisMatchStatsDirect(balldontlieSport, gameIds);
        default:
          throw new Error(`Unsupported sport: ${sport}`);
      }
    } catch (error) {
      logger.error({
        message: 'Error fetching player stats from Ball Don\'t Lie API',
        sport,
        gameIds,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get NHL stats via direct API call (SDK doesn't support NHL yet)
   * NHL uses /box_scores endpoint instead of /stats
   */
  private async getNHLStatsDirect(gameIds: number[]): Promise<any[]> {
    const axios = require('axios');
    const apiKey = getApiKey();
    
    const params = new URLSearchParams();
    gameIds.forEach(id => {
      params.append('game_ids[]', id.toString());
    });

    const response = await axios.get('https://api.balldontlie.io/nhl/v1/box_scores', {
      headers: {
        'Authorization': apiKey,
      },
      params,
    });

    return response.data.data || [];
  }

  /**
   * Get soccer/football player stats via direct API call
   * Note: EPL player stats endpoint may not be available for all subscription tiers
   * Supports: EPL, Bundesliga, La Liga, Serie A, Ligue 1
   */
  private async getSoccerStatsDirect(sport: string, gameIds: number[]): Promise<any[]> {
    const axios = require('axios');
    const apiKey = getApiKey();
    
    // Filter out invalid game IDs (e.g., 0, 1, or negative)
    const validGameIds = gameIds.filter(id => id && id > 1);
    if (validGameIds.length === 0) {
      // logger.warn({
      //   message: `No valid ${sport.toUpperCase()} game IDs provided`,
      //   originalGameIds: gameIds,
      // });
      return [];
    }
    
    const isEpl = sport === 'epl';
    
    // EPL uses path parameters: /games/{id}/player_stats and /games/{id}/lineups
    // Other soccer leagues use query parameters: /player_match_stats?match_ids[]=xxx
    if (isEpl) {
      return await this.getEplPlayerStatsDirect(validGameIds, apiKey);
    }
    
    // Non-EPL soccer leagues use query parameter format
    const endpointVariants = [
      `https://api.balldontlie.io/${sport}/v1/player_match_stats`,
      `https://api.balldontlie.io/${sport}/v1/player_stats`,
      `https://api.balldontlie.io/${sport}/v1/stats`,
    ];

    for (const endpoint of endpointVariants) {
      try {
    const params = new URLSearchParams();
        const paramName = endpoint.includes('player_match_stats') ? 'match_ids[]' : 'game_ids[]';
    validGameIds.forEach(id => {
          params.append(paramName, id.toString());
        });

        // logger.info({
        //   message: `Trying ${sport.toUpperCase()} player stats endpoint`,
        //   endpoint,
        //   gameIds: validGameIds,
        // });

        const response = await axios.get(endpoint, {
        headers: {
            'Authorization': apiKey,
        },
        params,
      });

        let stats = response.data.data || [];
        
        if (stats.length > 0) {
          // logger.info({
          //   message: `${sport.toUpperCase()} player stats found`,
          //   endpoint,
          //   statsCount: stats.length,
          //   sampleStat: stats[0],
          //   sampleStatKeys: Object.keys(stats[0]),
          // });
          
          // Stats only have player_id and team_id - need to enrich with names
          if (stats[0].player_id && !stats[0].player) {
            stats = await this.enrichSoccerStatsWithPlayerData(sport, stats, apiKey);
          }
          
          return stats;
        }
        
        // If no stats but request succeeded, return empty array
        // logger.info({
        //   message: `${sport.toUpperCase()} player stats endpoint responded but no data`,
        //   endpoint,
        //   gameIds: validGameIds,
        // });
        return [];
        
    } catch (error: any) {
        // 404 means this endpoint doesn't exist, try next variant
      if (error.response?.status === 404) {
          // logger.debug({
          //   message: `${sport.toUpperCase()} endpoint not found, trying next variant`,
          //   endpoint,
          //   status: 404,
          // });
          continue;
        }
        
        // 403/401 means subscription tier doesn't include this
        if (error.response?.status === 403 || error.response?.status === 401) {
        // logger.warn({
        //     message: `${sport.toUpperCase()} player stats not available (subscription tier limit)`,
        //     endpoint,
        //     status: error.response?.status,
        //     note: 'Player stats may require a higher subscription tier',
        //   });
          return [];
        }
        
        logger.error({
          message: `Error fetching ${sport.toUpperCase()} player stats`,
          endpoint,
          gameIds: validGameIds,
          status: error.response?.status,
          error: error.message,
        });
      }
    }
    
    // No endpoint worked
    // logger.warn({
    //   message: `${sport.toUpperCase()} player stats not available from any endpoint`,
    //   gameIds: validGameIds,
    //   note: 'Player stats may not be available for this league or subscription tier',
    //     });
        return [];
      }

  /**
   * Get EPL player stats using path parameter format
   * EPL API uses: /games/{id}/player_stats and /games/{id}/lineups
   */
  private async getEplPlayerStatsDirect(gameIds: number[], apiKey: string): Promise<any[]> {
    const axios = require('axios');
    const allStats: any[] = [];
    
    // Fetch teams first to get team names
    const teamsMap = new Map<number, any>();
    try {
      const dateObj = new Date();
      const month = dateObj.getMonth() + 1;
      const year = dateObj.getFullYear();
      const season = month >= 8 ? year : year - 1;
      
      const teamsResponse = await axios.get(
        'https://api.balldontlie.io/epl/v1/teams',
        { 
          headers: { 'Authorization': apiKey },
          params: { season },
        }
      );
      
      const teams = teamsResponse.data?.data || [];
      teams.forEach((t: any) => {
        teamsMap.set(t.id, {
          name: t.name,
          short_name: t.short_name,
          abbreviation: t.abbr,
        });
      });
      
      // logger.info({
      //   message: 'EPL teams fetched for enrichment',
      //   teamCount: teams.length,
      // });
    } catch (error: any) {
      logger.warn({
        message: 'Failed to fetch EPL teams',
        error: error.message,
      });
    }
    
    for (const gameId of gameIds) {
      try {
        // logger.info({
        //   message: 'Fetching EPL player stats',
        //   gameId,
        //   endpoint: `/epl/v1/games/${gameId}/player_stats`,
        // });
        
        // Fetch player stats for this game
        const statsResponse = await axios.get(
          `https://api.balldontlie.io/epl/v1/games/${gameId}/player_stats`,
          { headers: { 'Authorization': apiKey } }
        );
        
        const playerStats = statsResponse.data?.data?.players || [];
        
        if (playerStats.length === 0) {
          // logger.info({
          //   message: 'EPL game has no player stats yet',
          //   gameId,
          // });
          continue;
        }
        
        // Fetch lineups to get player names and positions
        const lineupsResponse = await axios.get(
          `https://api.balldontlie.io/epl/v1/games/${gameId}/lineups`,
          { headers: { 'Authorization': apiKey } }
        );
        
        const lineups = lineupsResponse.data?.data || [];
        
        // Create a map of player_id -> player info from lineups
        const playerInfoMap = new Map<number, any>();
        lineups.forEach((lineup: any) => {
          const player = lineup.player;
          if (player && player.id) {
            playerInfoMap.set(player.id, {
              first_name: player.first_name,
              last_name: player.last_name,
              name: player.name,
              position: lineup.position || player.position,
              team_id: lineup.team_id,
            });
          }
        });
        
        // logger.info({
        //   message: 'EPL lineups fetched for player enrichment',
        //   gameId,
        //   lineupsCount: lineups.length,
        //   playerInfoMapSize: playerInfoMap.size,
        // });
        
        // Transform EPL stats format to normalized format
        // EPL returns: { player_id, team_id, stats: [{name, value}] }
        // We need: { player_id, team_id, player: {...}, team: {...}, ...stat_fields }
        for (const playerStat of playerStats) {
          const playerInfo = playerInfoMap.get(playerStat.player_id);
          const teamInfo = teamsMap.get(playerStat.team_id);
          
          // Convert stats array to object with normalized names
          const statsObj: Record<string, any> = {};
          if (playerStat.stats && Array.isArray(playerStat.stats)) {
            playerStat.stats.forEach((stat: any) => {
              // Normalize stat names - EPL uses prefixes like top_stats_, attack_, defense_, duels_
              // Convert to cleaner names: top_stats_goals -> goals, defense_clearances -> clearances
              const normalizedName = stat.name
                .replace('top_stats_', '')
                .replace('attack_', '')
                .replace('defense_', '')
                .replace('duels_', '')
                .replace('matchstats.headers.', '');
              
              statsObj[normalizedName] = stat.value;
            });
          }
          
          allStats.push({
            game_id: gameId,
            player_id: playerStat.player_id,
            team_id: playerStat.team_id,
            player: {
              id: playerStat.player_id,
              first_name: playerInfo?.first_name || null,
              last_name: playerInfo?.last_name || null,
              position: playerInfo?.position || null,
            },
            team: {
              id: playerStat.team_id,
              name: teamInfo?.name || null,
              full_name: teamInfo?.name || null,
              abbreviation: teamInfo?.abbreviation || teamInfo?.short_name || null,
            },
            // Include key stats at top level for easier access
            goals: statsObj.goals || 0,
            assists: statsObj.assists || 0,
            minutes_played: statsObj.minutes_played || 0,
            // Store all normalized stats at top level for extractSportStats
            ...statsObj,
          });
        }
        
        // logger.info({
        //   message: 'EPL player stats processed',
        //   gameId,
        //   statsCount: playerStats.length,
        //   samplePlayer: allStats.length > 0 ? {
        //     player_id: allStats[allStats.length - 1].player_id,
        //     player_name: `${allStats[allStats.length - 1].player?.first_name} ${allStats[allStats.length - 1].player?.last_name}`,
        //     team_name: allStats[allStats.length - 1].team?.name,
        //     goals: allStats[allStats.length - 1].goals,
        //   } : null,
        // });
        
      } catch (error: any) {
        logger.error({
          message: 'Error fetching EPL player stats for game',
          gameId,
          status: error.response?.status,
          error: error.message,
        });
      }
    }
    
    return allStats;
  }

  /**
   * Enrich soccer player stats with player names and team info
   * For non-EPL leagues (La Liga, Bundesliga, Serie A, Ligue 1), the player_match_stats endpoint
   * only returns IDs. We need to fetch player and team data separately.
   */
  private async enrichSoccerStatsWithPlayerData(sport: string, stats: any[], apiKey: string): Promise<any[]> {
    const axios = require('axios');
    
    // Get unique player and team IDs
    const playerIds = new Set(stats.map(s => s.player_id).filter(Boolean));
    const teamIds = [...new Set(stats.map(s => s.team_id).filter(Boolean))];
    
    // logger.info({
    //   message: `Enriching ${sport.toUpperCase()} stats with player/team data`,
    //   playerCount: playerIds.size,
    //   teamCount: teamIds.length,
    // });
    
    // Fetch teams first
    const teamsMap = new Map<number, any>();
    try {
      // Get current season teams
      const dateObj = new Date();
      const month = dateObj.getMonth() + 1;
      const year = dateObj.getFullYear();
      const season = month >= 8 ? year : year - 1;
      
      const response = await axios.get(`https://api.balldontlie.io/${sport}/v1/teams`, {
        headers: { 'Authorization': apiKey },
        params: { season },
      });
      
      const teams = response.data.data || [];
      teams.forEach((t: any) => {
        teamsMap.set(t.id, {
          name: t.name,
          short_name: t.short_name,
          abbreviation: t.abbreviation,
        });
      });
      
      // logger.info({
      //   message: `Fetched ${sport.toUpperCase()} teams`,
      //   teamCount: teams.length,
      // });
    } catch (error: any) {
      logger.warn({
        message: `Failed to fetch ${sport.toUpperCase()} team data`,
        error: error.message,
      });
    }
    
    // Fetch player data from rosters endpoint (includes position info)
    // The players endpoint doesn't include position, but rosters does
    const playersMap = new Map<number, any>();
    
    // Get current season
    const dateObj = new Date();
    const month = dateObj.getMonth() + 1;
    const year = dateObj.getFullYear();
    const season = month >= 8 ? year : year - 1;
    
    for (const teamId of teamIds) {
      try {
        // Fetch roster for this team (includes player info + position)
        let cursor: number | null = null;
        let pageCount = 0;
        const maxPages = 3;
        
        do {
          const params: any = { 
            team_id: teamId,
            season: season,
            per_page: 100,
          };
          if (cursor) params.cursor = cursor;
          
          const response = await axios.get(`https://api.balldontlie.io/${sport}/v1/rosters`, {
            headers: { 'Authorization': apiKey },
            params,
          });
          
          const rosters = response.data.data || [];
          rosters.forEach((r: any) => {
            // Only store if this player is in our stats
            const playerId = r.player?.id;
            if (playerId && playerIds.has(playerId)) {
              playersMap.set(playerId, {
                first_name: r.player?.first_name,
                last_name: r.player?.last_name,
                display_name: r.player?.display_name,
                position: r.position || r.position_abbreviation || null,
                jersey_number: r.jersey_number,
              });
            }
          });
          
          cursor = response.data.meta?.next_cursor || null;
          pageCount++;
          
          // Stop if we found all players we need
          if (playersMap.size === playerIds.size) break;
          
        } while (cursor && pageCount < maxPages);
        
        // logger.debug({
        //   message: `Fetched ${sport.toUpperCase()} roster for team`,
        //   teamId,
        //   playersFound: playersMap.size,
        // });
        
      } catch (error: any) {
        logger.warn({
          message: `Failed to fetch ${sport.toUpperCase()} roster for team`,
          teamId,
          error: error.message,
        });
      }
    }
    
    // Enrich stats with player and team data
    const enrichedStats = stats.map(stat => {
      const player = playersMap.get(stat.player_id);
      const team = teamsMap.get(stat.team_id);
      
      return {
        ...stat,
        // Add player object for compatibility with existing code
        player: player ? {
          id: stat.player_id,
          first_name: player.first_name,
          last_name: player.last_name,
          position: player.position,
        } : { id: stat.player_id },
        // Add team object for compatibility with existing code
        team: team ? {
          id: stat.team_id,
          name: team.name,
          full_name: team.name,
          abbreviation: team.abbreviation || team.short_name,
        } : { id: stat.team_id },
      };
    });
    
    // logger.info({
    //   message: `Enriched ${sport.toUpperCase()} stats`,
    //   totalStats: enrichedStats.length,
    //   playersNeeded: playerIds.size,
    //   playersFound: playersMap.size,
    //   teamsFound: teamsMap.size,
    //   sampleEnriched: enrichedStats[0] ? {
    //     player_id: enrichedStats[0].player?.id,
    //     player_name: `${enrichedStats[0].player?.first_name} ${enrichedStats[0].player?.last_name}`,
    //     team_name: enrichedStats[0].team?.name,
    //   } : null,
    // });
    
    return enrichedStats;
  }

  /**
   * Get NCAAF stats via direct API call (SDK doesn't support NCAAF yet)
   */
  private async getNCAAFStatsDirect(gameIds: number[]): Promise<any[]> {
    const axios = require('axios');
    const apiKey = getApiKey();
    
    const params = new URLSearchParams();
    gameIds.forEach(id => {
      params.append('game_ids[]', id.toString());
    });

    try {
      const response = await axios.get('https://api.balldontlie.io/ncaaf/v1/player_stats', {
      headers: {
          'Authorization': apiKey,
      },
      params,
    });

    return response.data.data || [];
    } catch (error: any) {
      // Handle 404 gracefully - game might not exist or no stats available
      if (error.response?.status === 404) {
        // logger.warn({
        //   message: 'NCAAF game not found in Ball Don\'t Lie API (404)',
        //   gameIds,
        //   note: 'Game may not exist or stats may not be available yet',
        // });
        return [];
      }
      throw error;
    }
  }

  /**
   * Get NCAAB stats via direct API call (SDK doesn't support NCAAB yet)
   */
  private async getNCAABStatsDirect(gameIds: number[]): Promise<any[]> {
    const axios = require('axios');
    const apiKey = getApiKey();
    
    const params = new URLSearchParams();
    gameIds.forEach(id => {
      params.append('game_ids[]', id.toString());
    });

    try {
      const response = await axios.get('https://api.balldontlie.io/ncaab/v1/player_stats', {
      headers: {
          'Authorization': apiKey,
      },
      params,
    });

    return response.data.data || [];
    } catch (error: any) {
      // Handle 404 gracefully - game might not exist or no stats available
      if (error.response?.status === 404) {
        // logger.warn({
        //   message: 'NCAAB game not found in Ball Don\'t Lie API (404)',
        //   gameIds,
        //   note: 'Game may not exist or stats may not be available yet',
        // });
        return [];
      }
      throw error;
    }
  }

  /**
   * Get tennis match stats via direct API call
   * ATP/WTA use /match_stats endpoint with match_ids[] parameter
   */
  private async getTennisMatchStatsDirect(league: 'atp' | 'wta', matchIds: number[]): Promise<any[]> {
    const axios = require('axios');
    const apiKey = getApiKey();

    const params = new URLSearchParams();
    matchIds.forEach((id) => {
      params.append('match_ids[]', id.toString());
    });

    try {
      const response = await axios.get(`https://api.balldontlie.io/${league}/v1/match_stats`, {
        headers: { Authorization: apiKey },
        params,
      });
      return response.data.data || [];
    } catch (error: any) {
      if (error.response?.status === 404) {
        // logger.warn({
        //   message: `${league.toUpperCase()} match not found in Ball Don't Lie API (404)`,
        //   matchIds,
        //   note: 'Match may not exist or stats may not be available yet',
        // });
        return [];
      }
      throw error;
    }
  }

  /**
   * Get tennis matches for mapping - public method used by findAndMapBalldontlieGameId
   * Fetches live matches when isLive, else matches for the given date
   */
  async getTennisMatchesForMapping(league: 'atp' | 'wta', date: string, isLive: boolean): Promise<any[]> {
    const axios = require('axios');
    const apiKey = getApiKey();

    const params = new URLSearchParams();
    if (isLive) {
      params.append('is_live', 'true');
    } else {
      const year = new Date(date + 'T00:00:00Z').getFullYear();
      params.append('season', year.toString());
    }

    try {
      const response = await axios.get(`https://api.balldontlie.io/${league}/v1/matches`, {
        headers: { Authorization: apiKey },
        params,
      });
      const matches = response.data.data || [];

      if (!isLive && date) {
        const targetDate = date.split('T')[0];
        return matches.filter((m: any) => {
          const matchDate = m.date || m.start_date;
          if (!matchDate) return true;
          const d = new Date(matchDate).toISOString().split('T')[0];
          return d === targetDate;
        });
      }
      return matches;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get tennis matches for a date (used by getGamesByDate)
   * Fetches by season and filters by date
   */
  private async getTennisMatchesDirect(league: 'atp' | 'wta', date: string): Promise<any[]> {
    return this.getTennisMatchesForMapping(league, date, false);
  }

  /**
   * Get games for a specific date
   * @param sport - Sport name (nba, nfl, mlb, nhl, epl, ncaaf, ncaab)
   * @param date - Date string (YYYY-MM-DD)
   * @returns Games array
   */
  async getGamesByDate(sport: string, date: string): Promise<any[]> {
    const balldontlieSport = getBalldontlieSport(sport);
    if (!balldontlieSport) {
      throw new Error(`Sport ${sport} is not supported by Ball Don't Lie API`);
    }

    try {
      let response;
      
      switch (balldontlieSport) {
        case 'nba':
          response = await this.api.nba.getGames({ dates: [date] });
          return response.data || [];
        case 'nfl':
          response = await this.api.nfl.getGames({ dates: [date] });
          return response.data || [];
        case 'mlb':
          response = await this.api.mlb.getGames({ dates: [date] });
          return response.data || [];
        case 'nhl':
          // NHL not in SDK yet, use direct API call
          return await this.getNHLGamesDirect(date);
        case 'epl':
        case 'bundesliga':
        case 'laliga':
        case 'seriea':
        case 'ligue1':
          // Soccer leagues use /matches endpoint with dates[] parameter
          return await this.getSoccerMatchesDirect(balldontlieSport, date);
        case 'ncaaf':
          // NCAAF not in SDK yet, use direct API call
          return await this.getNCAAFGamesDirect(date);
        case 'ncaab':
          // NCAAB not in SDK yet, use direct API call
          return await this.getNCAABGamesDirect(date);
        case 'atp':
        case 'wta':
          // Tennis uses /matches - we fetch live matches or by season+date
          return await this.getTennisMatchesDirect(balldontlieSport, date);
        default:
          throw new Error(`Unsupported sport: ${sport}`);
      }
    } catch (error) {
      logger.error({
        message: 'Error fetching games from Ball Don\'t Lie API',
        sport,
        date,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get NHL games via direct API call (SDK doesn't support NHL yet)
   */
  private async getNHLGamesDirect(date: string): Promise<any[]> {
    const axios = require('axios');
    const apiKey = getApiKey();
    
    const params = new URLSearchParams();
    params.append('dates[]', date);

    const response = await axios.get('https://api.balldontlie.io/nhl/v1/games', {
      headers: {
        'Authorization': apiKey,
      },
      params,
    });

    return response.data.data || [];
  }

  /**
   * Get soccer/football games via direct API call
   * EPL uses /games endpoint, other soccer leagues use /matches endpoint
   * Supports: EPL, Bundesliga, La Liga, Serie A, Ligue 1
   */
  private async getSoccerMatchesDirect(sport: string, date: string): Promise<any[]> {
    const axios = require('axios');
    const apiKey = getApiKey();
    
    // Determine season from date (soccer season runs Aug-May)
    // e.g., 2025-12-20 is in the 2025-26 season, so season=2025
    const dateObj = new Date(date);
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth() + 1; // 0-indexed
    // If month is Jan-Jul, it's the previous year's season
    const season = month >= 8 ? year : year - 1;

    // EPL uses /games endpoint, other soccer leagues use /matches endpoint
    const endpointType = sport === 'epl' ? 'games' : 'matches';
    const endpoint = `https://api.balldontlie.io/${sport}/v1/${endpointType}`;

    try {
      // logger.info({
      //   message: `Fetching ${sport.toUpperCase()} games for date`,
      //   endpoint,
      //   endpointType,
      //   date,
      //   season,
      // });

      // For non-EPL soccer leagues, use dates[] parameter directly (more efficient)
      // For EPL, use season + pagination and filter by kickoff date
      if (endpointType === 'matches') {
        // La Liga, Serie A, Bundesliga, Ligue 1 - use dates[] parameter
        // Also query adjacent days to handle timezone differences
        const targetDate = new Date(date + 'T00:00:00Z');
        const prevDate = new Date(targetDate);
        prevDate.setDate(prevDate.getDate() - 1);
        const nextDate = new Date(targetDate);
        nextDate.setDate(nextDate.getDate() + 1);
    
    const params = new URLSearchParams();
        params.append('dates[]', prevDate.toISOString().split('T')[0]);
    params.append('dates[]', date);
        params.append('dates[]', nextDate.toISOString().split('T')[0]);
        params.append('per_page', '50');

        const response = await axios.get(endpoint, {
        headers: {
            'Authorization': apiKey,
        },
        params,
      });

      const games = response.data.data || [];
      
        // logger.info({
        //   message: `${sport.toUpperCase()} matches found`,
        //   date,
        //   gamesCount: games.length,
        //   sampleGame: games[0] ? { id: games[0].id, name: games[0].name, date: games[0].date } : null,
        // });
      
      return games;
      }
      
      // EPL uses /games endpoint with season parameter and pagination
      // Collect all games for the season (with pagination)
      let allGames: any[] = [];
      let cursor: number | null = null;
      let pageCount = 0;
      const maxPages = 10; // Safety limit
      
      do {
        const params: any = {
          season: season,
          per_page: 100,
        };
        if (cursor) {
          params.cursor = cursor;
        }

        const response = await axios.get(endpoint, {
        headers: {
            'Authorization': apiKey,
        },
        params,
      });

      const games = response.data.data || [];
        allGames = allGames.concat(games);
        
        // Check if we found games for our target date
        const targetGames = games.filter((g: any) => {
          const kickoffDate = g.kickoff ? new Date(g.kickoff).toISOString().split('T')[0] : null;
          return kickoffDate === date;
        });
        
        if (targetGames.length > 0) {
        // logger.info({
        //     message: `Found ${sport.toUpperCase()} games for target date`,
        //   date,
        //     season,
        //     targetGamesCount: targetGames.length,
        //     sampleGame: targetGames[0],
        //   });
          return targetGames; // Return only games for the target date
        }
        
        cursor = response.data.meta?.next_cursor || null;
        pageCount++;
        
        // // Log progress
        // logger.debug({
        //   message: `${sport.toUpperCase()} games pagination`,
        //   page: pageCount,
        //   gamesInPage: games.length,
        //   totalGames: allGames.length,
        //   cursor,
        // });
        
      } while (cursor && pageCount < maxPages);
      
      // Filter all collected games by date
      const matchingGames = allGames.filter((g: any) => {
        const kickoffDate = g.kickoff ? new Date(g.kickoff).toISOString().split('T')[0] : null;
        return kickoffDate === date;
      });
      
      // if (matchingGames.length > 0) {
      //   logger.info({
      //     message: `${sport.toUpperCase()} games found after pagination`,
      //     date,
      //     matchingGamesCount: matchingGames.length,
      //     sampleMatch: matchingGames[0],
      //   });
      // } else {
      //   logger.warn({
      //     message: `No ${sport.toUpperCase()} games found for date after ${pageCount} pages`,
      //     date,
      //     season,
      //     totalGamesChecked: allGames.length,
      //   });
      // }
      
      return matchingGames;
    } catch (error: any) {
      logger.error({
        message: `Error fetching ${sport.toUpperCase()} games from API`,
        endpoint,
        date,
        error: error instanceof Error ? error.message : String(error),
        status: error.response?.status,
      });
      throw error;
    }
  }

  /**
   * Get soccer teams for a given sport and season
   * Used for matching games by team abbreviation/name
   */
  async getSoccerTeams(sport: string, season: number): Promise<Map<number, { name: string; short_name: string; abbr: string }>> {
    const axios = require('axios');
    const apiKey = getApiKey();
    
    const endpoint = `https://api.balldontlie.io/${sport}/v1/teams`;
    
    try {
      const response = await axios.get(endpoint, {
        headers: {
          'Authorization': apiKey,
        },
        params: {
          season: season,
          per_page: 100,
        },
      });

      const teams = response.data.data || [];
      const teamsMap = new Map<number, { name: string; short_name: string; abbr: string }>();
      
      for (const team of teams) {
        teamsMap.set(team.id, {
          name: (team.name || '').toLowerCase(),
          short_name: (team.short_name || '').toLowerCase(),
          abbr: (team.abbr || '').toLowerCase(),
        });
      }
      
      // logger.info({
      //   message: `Fetched ${sport.toUpperCase()} teams`,
      //   season,
      //   teamCount: teamsMap.size,
      // });
      
      return teamsMap;
    } catch (error: any) {
      // logger.warn({
      //   message: `Error fetching ${sport.toUpperCase()} teams`,
      //   endpoint,
      //   season,
      //   error: error.message,
      //   status: error.response?.status,
      // });
      return new Map();
    }
  }

  /**
   * Get NCAAF games via direct API call (SDK doesn't support NCAAF yet)
   * Also queries adjacent dates to handle timezone differences (e.g., 8:30 PM EST = next day UTC)
   */
  private async getNCAAFGamesDirect(date: string): Promise<any[]> {
    const axios = require('axios');
    const apiKey = getApiKey();
    
    // Query adjacent dates to handle timezone differences
    const targetDate = new Date(date + 'T00:00:00Z');
    const prevDate = new Date(targetDate);
    prevDate.setDate(prevDate.getDate() - 1);
    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);
    
    const params = new URLSearchParams();
    params.append('dates[]', prevDate.toISOString().split('T')[0]);
    params.append('dates[]', date);
    params.append('dates[]', nextDate.toISOString().split('T')[0]);

    try {
    const response = await axios.get('https://api.balldontlie.io/ncaaf/v1/games', {
      headers: {
          'Authorization': apiKey,
      },
      params,
    });

    return response.data.data || [];
    } catch (error: any) {
      logger.error({
        message: 'Error fetching NCAAF games from API',
        date,
        error: error instanceof Error ? error.message : String(error),
        status: error.response?.status,
      });
      throw error;
    }
  }

  /**
   * Get NCAAB games via direct API call (SDK doesn't support NCAAB yet)
   * Also queries adjacent dates to handle timezone differences (e.g., 8:30 PM EST = next day UTC)
   */
  private async getNCAABGamesDirect(date: string): Promise<any[]> {
    const axios = require('axios');
    const apiKey = getApiKey();
    
    // Query adjacent dates to handle timezone differences
    const targetDate = new Date(date + 'T00:00:00Z');
    const prevDate = new Date(targetDate);
    prevDate.setDate(prevDate.getDate() - 1);
    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);
    
    const params = new URLSearchParams();
    params.append('dates[]', prevDate.toISOString().split('T')[0]);
    params.append('dates[]', date);
    params.append('dates[]', nextDate.toISOString().split('T')[0]);

    try {
    const response = await axios.get('https://api.balldontlie.io/ncaab/v1/games', {
      headers: {
          'Authorization': apiKey,
      },
      params,
    });

    return response.data.data || [];
    } catch (error: any) {
      logger.error({
        message: 'Error fetching NCAAB games from API',
        date,
        error: error instanceof Error ? error.message : String(error),
        status: error.response?.status,
      });
      throw error;
    }
  }
}

// Re-export SDK types for convenience
export type BallDontLiePlayerStat = any; // SDK returns typed data
export type BallDontLieGame = any; // SDK returns typed data

// Export singleton instance
export const ballDontLieClient = new BallDontLieClient();

/**
 * Store player stats in database (supports multiple sports)
 * Uses gamesCache when available; only connects to pool when writing.
 * @param gameId - Polymarket game ID (live_games.id)
 * @param sport - Sport name (nba, nfl, mlb, nhl, epl)
 * @param balldontlieGameId - Ball Don't Lie game ID
 * @param stats - Array of player stats
 */
export async function storePlayerStats(
  gameId: string,
  sport: string,
  balldontlieGameId: number,
  stats: BallDontLiePlayerStat[]
): Promise<void> {
  // 1. Get game data from cache or DB (pool.query auto-releases, no connection held)
  let game: Record<string, any>;
  let gameSlug: string;

  const cachedGame = await getGameFromCacheById(gameId);
  if (cachedGame) {
    game = cachedGame as unknown as Record<string, any>;
    gameSlug = cachedGame.slug || '';
  } else {
    const result = await pool.query(
      'SELECT transformed_data, slug FROM live_games WHERE id = $1',
      [gameId]
    );
    if (result.rows.length === 0) {
      throw new Error(`Game not found: ${gameId}`);
    }
    const row = result.rows[0];
    const transformedData = row.transformed_data;
    game = typeof transformedData === 'string' ? JSON.parse(transformedData) : transformedData;
    gameSlug = row.slug || '';
  }

  // 2. All prep work before acquiring a connection
  const slugAbbrevs = extractAbbrevsFromSlug(gameSlug);
  const homeTeamAbbr = (game.homeTeam?.abbreviation || game.teamIdentifiers?.home || slugAbbrevs.home || '').toLowerCase();
  const awayTeamAbbr = (game.awayTeam?.abbreviation || game.teamIdentifiers?.away || slugAbbrevs.away || '').toLowerCase();
  const title = game.title || '';
  const titleMatch = title.match(/^(.+?)\s+vs\.?\s+(.+?)$/i);
  const awayTeamNameFromTitle = titleMatch ? titleMatch[1].toLowerCase().trim() : '';
  const homeTeamNameFromTitle = titleMatch ? titleMatch[2].toLowerCase().trim() : '';
  const isNba = sport.toLowerCase() === 'nba';
  const isTennis = sport.toLowerCase() === 'atp' || sport.toLowerCase() === 'wta';

  const normalizeAbbr = (abbr: string) => abbr.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const normalizedHomeAbbr = normalizeAbbr(homeTeamAbbr);
  const normalizedAwayAbbr = normalizeAbbr(awayTeamAbbr);

  // Build all rows to insert (no DB connection)
  const rows: unknown[] = [];
  for (const stat of stats) {
    const statTeamAbbr = (stat.team?.tricode || stat.team?.abbreviation || '').toLowerCase();
    const statTeamName = (stat.team?.full_name || stat.team?.name || '').toLowerCase();
    const normalizedStatAbbr = normalizeAbbr(statTeamAbbr);

    let isHome: boolean | null = null;
    if (isTennis && stat.match) {
      // Tennis: player1 = away (isHome false), player2 = home (isHome true)
      const playerId = stat.player?.id ?? stat.player_id;
      const p1Id = stat.match?.player1_id ?? stat.match?.player1?.id;
      const p2Id = stat.match?.player2_id ?? stat.match?.player2?.id;
      if (playerId === p2Id) isHome = true;
      else if (playerId === p1Id) isHome = false;
    } else if (normalizedStatAbbr || statTeamName) {
      const matchesHome =
        normalizedStatAbbr === normalizedHomeAbbr ||
        (normalizedHomeAbbr && normalizedStatAbbr.includes(normalizedHomeAbbr)) ||
        (normalizedHomeAbbr && normalizedHomeAbbr.includes(normalizedStatAbbr)) ||
        (homeTeamNameFromTitle && statTeamName.includes(homeTeamNameFromTitle)) ||
        (homeTeamNameFromTitle && homeTeamNameFromTitle.split(' ').some((word: string) => word.length > 2 && statTeamName.includes(word)));
      const matchesAway =
        normalizedStatAbbr === normalizedAwayAbbr ||
        (normalizedAwayAbbr && normalizedStatAbbr.includes(normalizedAwayAbbr)) ||
        (normalizedAwayAbbr && normalizedAwayAbbr.includes(normalizedStatAbbr)) ||
        (awayTeamNameFromTitle && statTeamName.includes(awayTeamNameFromTitle)) ||
        (awayTeamNameFromTitle && awayTeamNameFromTitle.split(' ').some((word: string) => word.length > 2 && statTeamName.includes(word)));
      if (matchesHome) isHome = true;
      else if (matchesAway) isHome = false;
    }

    const sportStats = extractSportStats(sport, stat);
    rows.push([
      gameId,
      balldontlieGameId,
      stat.player?.id || stat.player_id,
      stat.player?.first_name || null,
      stat.player?.last_name || null,
      (stat.player?.position || stat.position)?.substring(0, 50) || null,
      (isTennis ? null : (stat.team?.id || stat.team_id)),
      (isTennis ? null : (stat.team?.tricode || stat.team?.abbreviation)?.substring(0, 50)),
      (isTennis ? null : (stat.team?.full_name || stat.team?.name)),
      isHome,
      isNba ? (stat.min ?? null) : null,
      isNba ? (stat.fgm ?? null) : null,
      isNba ? (stat.fga ?? null) : null,
      isNba ? (stat.fg_pct ?? null) : null,
      isNba ? (stat.fg3m ?? null) : null,
      isNba ? (stat.fg3a ?? null) : null,
      isNba ? (stat.fg3_pct ?? null) : null,
      isNba ? (stat.ftm ?? null) : null,
      isNba ? (stat.fta ?? null) : null,
      isNba ? (stat.ft_pct ?? null) : null,
      isNba ? (stat.oreb ?? null) : null,
      isNba ? (stat.dreb ?? null) : null,
      isNba ? (stat.reb ?? null) : null,
      isNba ? (stat.ast ?? null) : null,
      isNba ? (stat.stl ?? null) : null,
      isNba ? (stat.blk ?? null) : null,
      isNba ? (stat.turnover ?? null) : null,
      isNba ? (stat.pf ?? null) : null,
      stat.pts !== undefined ? stat.pts : null,
      sport,
      JSON.stringify(sportStats),
    ]);
  }

  if (rows.length === 0) return;

  // 3. Connect only when ready to write
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertSql = `
      INSERT INTO game_player_stats (
        game_id, balldontlie_game_id, player_id, player_first_name, player_last_name,
        player_position, team_id, team_abbreviation, team_name, is_home,
        min, fgm, fga, fg_pct, fg3m, fg3a, fg3_pct, ftm, fta, ft_pct,
        oreb, dreb, reb, ast, stl, blk, turnover, pf, pts,
        sport, sport_stats,
        stats_updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29,
        $30, $31,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (game_id, player_id, sport)
      DO UPDATE SET
        balldontlie_game_id = EXCLUDED.balldontlie_game_id,
        player_first_name = EXCLUDED.player_first_name,
        player_last_name = EXCLUDED.player_last_name,
        player_position = EXCLUDED.player_position,
        team_id = EXCLUDED.team_id,
        team_abbreviation = EXCLUDED.team_abbreviation,
        team_name = EXCLUDED.team_name,
        is_home = EXCLUDED.is_home,
        min = EXCLUDED.min, fgm = EXCLUDED.fgm, fga = EXCLUDED.fga, fg_pct = EXCLUDED.fg_pct,
        fg3m = EXCLUDED.fg3m, fg3a = EXCLUDED.fg3a, fg3_pct = EXCLUDED.fg3_pct,
        ftm = EXCLUDED.ftm, fta = EXCLUDED.fta, ft_pct = EXCLUDED.ft_pct,
        oreb = EXCLUDED.oreb, dreb = EXCLUDED.dreb, reb = EXCLUDED.reb,
        ast = EXCLUDED.ast, stl = EXCLUDED.stl, blk = EXCLUDED.blk,
        turnover = EXCLUDED.turnover, pf = EXCLUDED.pf, pts = EXCLUDED.pts,
        sport = EXCLUDED.sport, sport_stats = EXCLUDED.sport_stats,
        stats_updated_at = CURRENT_TIMESTAMP
    `;
    for (const r of rows as unknown[][]) {
      await client.query(insertSql, r);
    }
    await client.query('COMMIT');
    // logger.info({
    //   message: 'Player stats stored successfully',
    //   gameId,
    //   sport,
    //   balldontlieGameId,
    //   statsCount: stats.length,
    // });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({
      message: 'Error storing player stats',
      gameId,
      sport,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Extract team abbreviations from slug (format: sport-away-home-date)
 * Returns { away: 'MIA', home: 'TXAM' } for slug like 'cfb-mia-txam-2025-12-20'
 */
function extractAbbrevsFromSlug(slug: string | undefined): { away?: string; home?: string } {
  if (!slug) return {};
  
  const slugParts = slug.split('-');
  const teamAbbrevs: string[] = [];
  
  // Common sport identifiers to skip
  const sportIdentifiers = new Set(['nhl', 'nba', 'nfl', 'mlb', 'epl', 'cbb', 'cfb', 'lal', 'ser', 'bund', 'lig1', 'mls', 'ncaaf', 'ncaab']);
  
  for (let i = 0; i < slugParts.length; i++) {
    const part = slugParts[i];
    const partLower = part.toLowerCase();
    
    // Skip numbers (dates)
    if (/^\d+$/.test(part)) continue;
    
    // Skip the first part if it's a sport identifier
    if (i === 0 && sportIdentifiers.has(partLower)) {
      continue;
    }
    
    // Match team abbreviations (2-10 letters)
    if (part.length >= 2 && part.length <= 10 && /^[a-z]+$/i.test(part)) {
      teamAbbrevs.push(part.toUpperCase());
    }
  }
  
  if (teamAbbrevs.length >= 2) {
    // Slug format: sport-away-home-date, so first team is away, second is home
    return { away: teamAbbrevs[0], home: teamAbbrevs[1] };
  }
  
  return {};
}

/**
 * Extract sport-specific stats from stat object
 * Different sports have different stat fields
 */
function extractSportStats(sport: string, stat: any): Record<string, any> {
  const normalizedSport = sport.toLowerCase();
  const sportStats: Record<string, any> = {};

  // Each sport case defines its own expected fields with null defaults
  // This ensures frontend always gets the same structure per sport

  switch (normalizedSport) {
    case 'nba':
      // NBA-specific stats - include all fields with null defaults
      sportStats.min = stat.min ?? null;
      sportStats.pts = stat.pts ?? null;
      sportStats.fgm = stat.fgm ?? null;
      sportStats.fga = stat.fga ?? null;
      sportStats.fg_pct = stat.fg_pct ?? null;
      sportStats.fg3m = stat.fg3m ?? null;
      sportStats.fg3a = stat.fg3a ?? null;
      sportStats.fg3_pct = stat.fg3_pct ?? null;
      sportStats.ftm = stat.ftm ?? null;
      sportStats.fta = stat.fta ?? null;
      sportStats.ft_pct = stat.ft_pct ?? null;
      sportStats.oreb = stat.oreb ?? null;
      sportStats.dreb = stat.dreb ?? null;
      sportStats.reb = stat.reb ?? null;
      sportStats.ast = stat.ast ?? null;
      sportStats.stl = stat.stl ?? null;
      sportStats.blk = stat.blk ?? null;
      sportStats.turnover = stat.turnover ?? null;
      sportStats.pf = stat.pf ?? null;
      sportStats.plus_minus = stat.plus_minus ?? null;
      break;

    case 'nfl':
      // NFL-specific stats - try multiple field name variations
      
      // Passing stats - check multiple variations
      sportStats.pass_yds = stat.pass_yds ?? stat.passing_yds ?? stat.pass_yards ?? stat.passing_yards ?? 
                            stat.pass_yards_gained ?? stat.passing_yards_gained ?? null;
      sportStats.pass_td = stat.pass_td ?? stat.passing_td ?? stat.pass_touchdowns ?? stat.passing_touchdowns ?? null;
      sportStats.pass_int = stat.pass_int ?? stat.passing_int ?? stat.pass_interceptions ?? stat.passing_interceptions ?? null;
      sportStats.pass_att = stat.pass_att ?? stat.passing_att ?? stat.pass_attempts ?? stat.passing_attempts ?? null;
      sportStats.pass_comp = stat.pass_comp ?? stat.passing_comp ?? stat.pass_completions ?? stat.passing_completions ?? null;
      
      // Rushing stats
      sportStats.rush_yds = stat.rush_yds ?? stat.rushing_yds ?? stat.rush_yards ?? stat.rushing_yards ?? 
                            stat.rush_yards_gained ?? stat.rushing_yards_gained ?? null;
      sportStats.rush_td = stat.rush_td ?? stat.rushing_td ?? stat.rush_touchdowns ?? stat.rushing_touchdowns ?? null;
      sportStats.rush_att = stat.rush_att ?? stat.rushing_att ?? stat.rush_attempts ?? stat.rushing_attempts ?? null;
      
      // Receiving stats
      sportStats.rec = stat.rec ?? stat.receptions ?? stat.catches ?? null;
      sportStats.rec_yds = stat.rec_yds ?? stat.receiving_yds ?? stat.rec_yards ?? stat.receiving_yards ?? 
                           stat.receiving_yards_gained ?? null;
      sportStats.rec_td = stat.rec_td ?? stat.receiving_td ?? stat.rec_touchdowns ?? stat.receiving_touchdowns ?? null;
      sportStats.rec_targets = stat.rec_targets ?? stat.targets ?? stat.receiving_targets ?? null;
      
      // Fumbles
      sportStats.fumbles = stat.fumbles ?? stat.fumble ?? null;
      sportStats.fumbles_lost = stat.fumbles_lost ?? stat.fumble_lost ?? null;
      
      // Touchdowns (total)
      sportStats.td = stat.td ?? stat.touchdowns ?? null;
      
      // Additional common NFL stats
      sportStats.sacks = stat.sacks ?? stat.sack ?? null;
      sportStats.tackles = stat.tackles ?? stat.tackle ?? stat.total_tackles ?? null;
      sportStats.interceptions = stat.interceptions ?? stat.int ?? stat.ints ?? null;
      
      // Fallback: Check for any remaining stat fields that aren't player/team/game metadata
      // This catches any stats we might have missed or that use non-standard names
      const excludedKeys = ['player', 'team', 'game', 'id', 'min', 'pts', 'fgm', 'fga', 'fg_pct', 
        'fg3m', 'fg3a', 'fg3_pct', 'ftm', 'fta', 'ft_pct', 'oreb', 'dreb', 'reb', 
        'ast', 'stl', 'blk', 'turnover', 'pf'];
      Object.keys(stat).forEach(key => {
        const keyLower = key.toLowerCase();
        if (!excludedKeys.includes(keyLower) && 
            !sportStats.hasOwnProperty(key) && 
            stat[key] !== null && 
            stat[key] !== undefined &&
            typeof stat[key] !== 'object') {
          // Found a stat field we haven't extracted yet
          sportStats[key] = stat[key];
        }
      });
      break;

    case 'mlb':
      // MLB-specific stats - include all fields with null defaults
      sportStats.ab = stat.ab ?? null;
      sportStats.h = stat.h ?? null;
      sportStats.avg = stat.avg ?? null;
      sportStats.hr = stat.hr ?? null;
      sportStats.rbi = stat.rbi ?? null;
      sportStats.r = stat.r ?? null;
      sportStats.sb = stat.sb ?? null;
      sportStats.bb = stat.bb ?? null;
      sportStats.so = stat.so ?? null;
      sportStats.era = stat.era ?? null;
      sportStats.w = stat.w ?? null;
      sportStats.l = stat.l ?? null;
      sportStats.sv = stat.sv ?? null;
      sportStats.ip = stat.ip ?? null;
      sportStats.h_allowed = stat.h_allowed ?? null;
      sportStats.er = stat.er ?? null;
      sportStats.k = stat.k ?? null;
      break;

    case 'nhl':
      // NHL-specific stats (from box_scores endpoint) - include all fields with null defaults
      sportStats.goals = stat.goals ?? null;
      sportStats.assists = stat.assists ?? null;
      sportStats.points = stat.points ?? null;
      sportStats.plus_minus = stat.plus_minus ?? null;
      sportStats.penalty_minutes = stat.penalty_minutes ?? null;
      sportStats.power_play_goals = stat.power_play_goals ?? null;
      sportStats.shots_on_goal = stat.shots_on_goal ?? null;
      sportStats.faceoff_winning_pctg = stat.faceoff_winning_pctg ?? null;
      sportStats.time_on_ice = stat.time_on_ice ?? null;
      sportStats.blocked_shots = stat.blocked_shots ?? null;
      sportStats.hits = stat.hits ?? null;
      sportStats.shifts = stat.shifts ?? null;
      sportStats.giveaways = stat.giveaways ?? null;
      sportStats.takeaways = stat.takeaways ?? null;
      sportStats.sweater_number = stat.sweater_number ?? null;
      // Goalie stats
      sportStats.wins = stat.wins ?? null;
      sportStats.losses = stat.losses ?? null;
      sportStats.saves = stat.saves ?? null;
      sportStats.shots_against = stat.shots_against ?? null;
      sportStats.save_percentage = stat.save_percentage ?? null;
      break;

    case 'epl':
    case 'bundesliga':
    case 'laliga':
    case 'lal':  // La Liga alternate abbreviation
    case 'seriea':
    case 'ser':  // Serie A alternate abbreviation
    case 'ligue1':
    case 'lig':  // Ligue 1 alternate abbreviation
    case 'bund': // Bundesliga alternate abbreviation
      // Soccer/Football-specific stats - include all fields with null defaults
      // Core stats (normalize names)
      sportStats.goals = stat.goals ?? stat.top_stats_goals ?? null;
      sportStats.assists = stat.assists ?? stat.top_stats_assists ?? null;
      sportStats.minutes_played = stat.minutes_played ?? stat.top_stats_minutes_played ?? stat.minutes ?? null;
      
      // Shooting stats
      sportStats.shots = stat.shots ?? stat.shots_total ?? stat.top_stats_total_shots ?? stat.total_shots ?? null;
      sportStats.shots_on_target = stat.shots_on_target ?? null;
      sportStats.expected_goals = stat.expected_goals ?? stat.xg ?? null;
      sportStats.expected_assists = stat.expected_assists ?? stat.top_stats_expected_assists ?? null;
      sportStats.xg_and_xa = stat.xg_and_xa ?? stat.top_stats_xg_and_xa ?? null;
      
      // Passing stats
      sportStats.passes = stat.passes ?? stat.accurate_passes ?? stat.top_stats_accurate_passes ?? null;
      sportStats.pass_accuracy = stat.pass_accuracy ?? null;
      sportStats.key_passes = stat.key_passes ?? stat.chances_created ?? stat.top_stats_chances_created ?? null;
      sportStats.passes_into_final_third = stat.passes_into_final_third ?? null;
      sportStats.long_balls_accurate = stat.long_balls_accurate ?? null;
      sportStats.crosses = stat.crosses ?? null;
      sportStats.corners = stat.corners ?? null;
      
      // Defensive stats
      sportStats.tackles = stat.tackles ?? stat.matchstats_headers_tackles ?? null;
      sportStats.interceptions = stat.interceptions ?? null;
      sportStats.clearances = stat.clearances ?? null;
      sportStats.shot_blocks = stat.shot_blocks ?? null;
      sportStats.recoveries = stat.recoveries ?? null;
      sportStats.defensive_actions = stat.defensive_actions ?? stat.top_stats_defensive_actions ?? null;
      
      // Duels
      sportStats.duels_won = stat.duels_won ?? stat.duel_won ?? null;
      sportStats.duels_lost = stat.duels_lost ?? stat.duel_lost ?? null;
      sportStats.aerial_duels_won = stat.aerial_duels_won ?? stat.aerials_won ?? null;
      sportStats.ground_duels_won = stat.ground_duels_won ?? null;
      
      // Dribbling & touches
      sportStats.dribbles = stat.dribbles ?? stat.dribbles_succeeded ?? null;
      sportStats.touches = stat.touches ?? null;
      sportStats.touches_opp_box = stat.touches_opp_box ?? null;
      sportStats.dispossessed = stat.dispossessed ?? null;
      sportStats.dribbled_past = stat.dribbled_past ?? null;
      
      // Cards & fouls
      sportStats.yellow_cards = stat.yellow_cards ?? null;
      sportStats.red_cards = stat.red_cards ?? null;
      sportStats.fouls_committed = stat.fouls_committed ?? stat.fouls ?? null;
      sportStats.fouls_suffered = stat.fouls_suffered ?? stat.was_fouled ?? null;
      sportStats.offsides = stat.offsides ?? null;
      
      // Goalkeeper
      sportStats.saves = stat.saves ?? null;
      
      // Misc
      sportStats.own_goals = stat.own_goals ?? null;
      sportStats.appearances = stat.appearances ?? null;
      sportStats.rating = stat.rating ?? stat.rating_title ?? null;
      sportStats.fantasy_points = stat.fantasy_points ?? stat.top_stats_fantasy_points ?? null;
      
      // Fallback: capture any remaining stats not explicitly mapped
      const soccerExcludedKeys = ['player', 'team', 'game', 'player_id', 'team_id', 'game_id', 'match_id'];
      Object.keys(stat).forEach(key => {
        if (!soccerExcludedKeys.includes(key) && 
            !sportStats.hasOwnProperty(key) && 
            stat[key] !== null && 
            stat[key] !== undefined &&
            typeof stat[key] !== 'object') {
          sportStats[key] = stat[key];
        }
      });
      break;

    case 'cbb':
    case 'ncaab':
      // College Basketball stats - same as NBA but with all expected fields
      // Include all fields so frontend knows what to expect
      sportStats.min = stat.min ?? null;
      sportStats.pts = stat.pts ?? null;
      sportStats.fgm = stat.fgm ?? null;
      sportStats.fga = stat.fga ?? null;
      sportStats.fg3m = stat.fg3m ?? null;
      sportStats.fg3a = stat.fg3a ?? null;
      sportStats.ftm = stat.ftm ?? null;
      sportStats.fta = stat.fta ?? null;
      sportStats.oreb = stat.oreb ?? null;
      sportStats.dreb = stat.dreb ?? null;
      sportStats.reb = stat.reb ?? null;
      sportStats.ast = stat.ast ?? null;
      sportStats.stl = stat.stl ?? null;
      sportStats.blk = stat.blk ?? null;
      sportStats.turnover = stat.turnover ?? null;
      sportStats.pf = stat.pf ?? null;
      break;

    case 'cfb':
    case 'ncaaf':
      // College Football stats - include all expected fields
      // Passing
      sportStats.passing_yards = stat.passing_yards ?? null;
      sportStats.passing_attempts = stat.passing_attempts ?? null;
      sportStats.passing_completions = stat.passing_completions ?? null;
      sportStats.passing_touchdowns = stat.passing_touchdowns ?? null;
      sportStats.passing_interceptions = stat.passing_interceptions ?? null;
      sportStats.passing_rating = stat.passing_rating ?? null;
      sportStats.passing_qbr = stat.passing_qbr ?? null;
      // Rushing
      sportStats.rushing_yards = stat.rushing_yards ?? null;
      sportStats.rushing_attempts = stat.rushing_attempts ?? null;
      sportStats.rushing_touchdowns = stat.rushing_touchdowns ?? null;
      sportStats.rushing_long = stat.rushing_long ?? null;
      // Receiving
      sportStats.receptions = stat.receptions ?? null;
      sportStats.receiving_yards = stat.receiving_yards ?? null;
      sportStats.receiving_touchdowns = stat.receiving_touchdowns ?? null;
      sportStats.receiving_targets = stat.receiving_targets ?? null;
      sportStats.receiving_long = stat.receiving_long ?? null;
      // Defense
      sportStats.total_tackles = stat.total_tackles ?? null;
      sportStats.solo_tackles = stat.solo_tackles ?? null;
      sportStats.tackles_for_loss = stat.tackles_for_loss ?? null;
      sportStats.sacks = stat.sacks ?? null;
      sportStats.interceptions = stat.interceptions ?? null;
      sportStats.passes_defended = stat.passes_defended ?? null;
      break;

    case 'atp':
    case 'wta':
      // Tennis match stats (ATP/WTA)
      sportStats.serve_rating = stat.serve_rating ?? null;
      sportStats.aces = stat.aces ?? null;
      sportStats.double_faults = stat.double_faults ?? null;
      sportStats.first_serve_pct = stat.first_serve_pct ?? null;
      sportStats.first_serve_points_won_pct = stat.first_serve_points_won_pct ?? null;
      sportStats.second_serve_points_won_pct = stat.second_serve_points_won_pct ?? null;
      sportStats.break_points_saved_pct = stat.break_points_saved_pct ?? null;
      sportStats.return_rating = stat.return_rating ?? null;
      sportStats.first_return_won_pct = stat.first_return_won_pct ?? null;
      sportStats.second_return_won_pct = stat.second_return_won_pct ?? null;
      sportStats.break_points_converted_pct = stat.break_points_converted_pct ?? null;
      sportStats.total_service_points_won_pct = stat.total_service_points_won_pct ?? null;
      sportStats.total_return_points_won_pct = stat.total_return_points_won_pct ?? null;
      sportStats.total_points_won_pct = stat.total_points_won_pct ?? null;
      sportStats.set_number = stat.set_number ?? null;
      break;

    default:
      // Store all available stats for unknown sports
      Object.keys(stat).forEach(key => {
        if (!['player', 'team', 'game'].includes(key)) {
          sportStats[key] = stat[key];
        }
      });
  }

  // Return all fields including nulls - frontend needs consistent structure per sport
  return sportStats;
}

/**
 * Get player stats for a game
 * @param gameId - Polymarket game ID (live_games.id)
 * @returns Array of player stats
 */
export async function getPlayerStats(gameId: string): Promise<any[]> {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT 
        player_id, player_first_name, player_last_name, player_position,
        team_id, team_abbreviation, team_name, is_home,
        min, fgm, fga, fg_pct, fg3m, fg3a, fg3_pct, ftm, fta, ft_pct,
        oreb, dreb, reb, ast, stl, blk, turnover, pf, pts,
        sport, sport_stats,
        stats_updated_at
      FROM game_player_stats
      WHERE game_id = $1
      ORDER BY is_home DESC, pts DESC NULLS LAST, reb DESC NULLS LAST, ast DESC NULLS LAST`,
      [gameId]
    );


    // Transform response to filter out null NBA columns for non-NBA sports
    const transformedRows = result.rows.map((row: any) => {
      const rowSport = row.sport?.toLowerCase();
      const isNba = rowSport === 'nba';
      
      // If not NBA, remove NBA-specific columns that are null
      if (!isNba) {
        const cleanedRow = { ...row };
        // List of NBA-specific columns
        const nbaColumns = [
          'min', 'fgm', 'fga', 'fg_pct', 'fg3m', 'fg3a', 'fg3_pct',
          'ftm', 'fta', 'ft_pct', 'oreb', 'dreb', 'reb',
          'ast', 'stl', 'blk', 'turnover', 'pf'
        ];
        
        // Only remove if null (points might exist in other sports)
        nbaColumns.forEach(col => {
          if (cleanedRow[col] === null || cleanedRow[col] === undefined) {
            delete cleanedRow[col];
          }
        });
        
        
        return cleanedRow;
      }
      
      return row;
    });

    return transformedRows;
  } catch (error) {
    logger.error({
      message: 'Error fetching player stats',
      gameId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Period scores structure returned by fetchPeriodScores
 */
export interface PeriodScores {
  // NBA/NFL quarters
  q1?: { home: number | null; away: number | null };
  q2?: { home: number | null; away: number | null };
  q3?: { home: number | null; away: number | null };
  q4?: { home: number | null; away: number | null };
  // Overtime (NBA/NFL)
  ot1?: { home: number | null; away: number | null };
  ot2?: { home: number | null; away: number | null };
  ot3?: { home: number | null; away: number | null };
  // NCAAB halves
  h1?: { home: number | null; away: number | null };
  h2?: { home: number | null; away: number | null };
  // Soccer halves (1H/2H notation)
  '1h'?: { home: number | null; away: number | null };
  '2h'?: { home: number | null; away: number | null };
  // Halftime/Final totals
  ht?: { home: number | null; away: number | null };
  ft?: { home: number | null; away: number | null };
  // Verification totals
  vft?: { home: number | null; away: number | null };
}

/**
 * Fetch period scores from Ball Don't Lie API
 * - NBA/NFL: Returns quarter-by-quarter scores directly from game endpoint
 * - Soccer (EPL, La Liga, etc.): Returns 1H/2H scores derived from goals endpoint
 * @param game - LiveGame object with balldontlie_game_id
 * @returns PeriodScores object with individual period scores
 */
export async function fetchPeriodScores(game: any): Promise<PeriodScores | null> {
  const axios = require('axios');
  const apiKey = getApiKey();
  const sport = game.sport?.toLowerCase();
  const bdSport = getBalldontlieSport(sport || '');
  
  // Supported sports for period scores
  const supportedSports = ['nba', 'nfl', 'ncaab', 'epl', 'laliga', 'bundesliga', 'seriea', 'ligue1'];
  if (!bdSport || !supportedSports.includes(bdSport)) {
    // logger.debug({
    //   message: 'Period scores not available for sport',
    //   sport,
    //   note: 'Period scores supported for: NBA, NFL, NCAAB, EPL, La Liga, Bundesliga, Serie A, Ligue 1',
    // });
    return null;
  }
  
  // Get Ball Don't Lie game ID
  let balldontlieGameId = game.balldontlie_game_id;
  if (!balldontlieGameId) {
    balldontlieGameId = await findAndMapBalldontlieGameId(game);
    if (!balldontlieGameId) {
      logger.warn({
        message: 'Could not find Ball Don\'t Lie game ID for period scores',
        gameId: game.id,
        sport,
      });
      return null;
    }
  }
  
  try {
    // Soccer leagues use goals/events endpoint to derive 1H/2H scores
    if (isSoccerSport(bdSport)) {
      return await fetchSoccerPeriodScores(game, bdSport, balldontlieGameId, apiKey);
    }
    
    // Determine API endpoint based on sport (NBA/NFL/NCAAB)
    let endpoint: string;
    if (bdSport === 'nba') {
      endpoint = `https://api.balldontlie.io/v1/games/${balldontlieGameId}`;
    } else if (bdSport === 'ncaab') {
      endpoint = `https://api.balldontlie.io/ncaab/v1/games/${balldontlieGameId}`;
    } else {
      endpoint = `https://api.balldontlie.io/nfl/v1/games/${balldontlieGameId}`;
    }
    
    // logger.info({
    //   message: 'Fetching period scores from Ball Don\'t Lie',
    //   gameId: game.id,
    //   balldontlieGameId,
    //   sport: bdSport,
    //   endpoint,
    // });
    
    const response = await axios.get(endpoint, {
      headers: { 'Authorization': apiKey },
    });
    
    const gameData = response.data?.data || response.data;
    
    if (!gameData) {
      logger.warn({
        message: 'No game data returned for period scores',
        balldontlieGameId,
      });
      return null;
    }
    
    let periodScores: PeriodScores = {};
    
    if (bdSport === 'nba') {
      // NBA uses: home_q1, home_q2, home_q3, home_q4, visitor_q1, etc.
      periodScores = {
        q1: { home: gameData.home_q1 ?? null, away: gameData.visitor_q1 ?? null },
        q2: { home: gameData.home_q2 ?? null, away: gameData.visitor_q2 ?? null },
        q3: { home: gameData.home_q3 ?? null, away: gameData.visitor_q3 ?? null },
        q4: { home: gameData.home_q4 ?? null, away: gameData.visitor_q4 ?? null },
        // Overtime periods
        ot1: gameData.home_ot1 != null || gameData.visitor_ot1 != null 
          ? { home: gameData.home_ot1 ?? null, away: gameData.visitor_ot1 ?? null } 
          : undefined,
        ot2: gameData.home_ot2 != null || gameData.visitor_ot2 != null 
          ? { home: gameData.home_ot2 ?? null, away: gameData.visitor_ot2 ?? null } 
          : undefined,
        ot3: gameData.home_ot3 != null || gameData.visitor_ot3 != null 
          ? { home: gameData.home_ot3 ?? null, away: gameData.visitor_ot3 ?? null } 
          : undefined,
        // Halftime = Q1 + Q2
        ht: {
          home: (gameData.home_q1 ?? 0) + (gameData.home_q2 ?? 0),
          away: (gameData.visitor_q1 ?? 0) + (gameData.visitor_q2 ?? 0),
        },
        // Final score
        ft: {
          home: gameData.home_team_score ?? null,
          away: gameData.visitor_team_score ?? null,
        },
        // Verification final (same as ft)
        vft: {
          home: gameData.home_team_score ?? null,
          away: gameData.visitor_team_score ?? null,
        },
      };
    } else if (bdSport === 'nfl') {
      // NFL uses: home_team_q1, home_team_q2, etc.
      periodScores = {
        q1: { home: gameData.home_team_q1 ?? null, away: gameData.visitor_team_q1 ?? null },
        q2: { home: gameData.home_team_q2 ?? null, away: gameData.visitor_team_q2 ?? null },
        q3: { home: gameData.home_team_q3 ?? null, away: gameData.visitor_team_q3 ?? null },
        q4: { home: gameData.home_team_q4 ?? null, away: gameData.visitor_team_q4 ?? null },
        // Overtime
        ot1: gameData.home_team_ot != null || gameData.visitor_team_ot != null 
          ? { home: gameData.home_team_ot ?? null, away: gameData.visitor_team_ot ?? null } 
          : undefined,
        // Halftime = Q1 + Q2
        ht: {
          home: (gameData.home_team_q1 ?? 0) + (gameData.home_team_q2 ?? 0),
          away: (gameData.visitor_team_q1 ?? 0) + (gameData.visitor_team_q2 ?? 0),
        },
        // Final score
        ft: {
          home: gameData.home_team_score ?? null,
          away: gameData.visitor_team_score ?? null,
        },
        vft: {
          home: gameData.home_team_score ?? null,
          away: gameData.visitor_team_score ?? null,
        },
      };
    } else if (bdSport === 'ncaab') {
      // NCAAB uses halves: home_score_h1, home_score_h2, away_score_h1, away_score_h2
      periodScores = {
        // First half
        h1: { 
          home: gameData.home_score_h1 ?? null, 
          away: gameData.away_score_h1 ?? null 
        },
        // Second half
        h2: { 
          home: gameData.home_score_h2 ?? null, 
          away: gameData.away_score_h2 ?? null 
        },
        // Overtime (if exists)
        ot1: gameData.home_score_ot != null || gameData.away_score_ot != null 
          ? { home: gameData.home_score_ot ?? null, away: gameData.away_score_ot ?? null } 
          : undefined,
        // Halftime (same as h1 for basketball)
        ht: {
          home: gameData.home_score_h1 ?? null,
          away: gameData.away_score_h1 ?? null,
        },
        // Final score
        ft: {
          home: gameData.home_score ?? null,
          away: gameData.away_score ?? null,
        },
        vft: {
          home: gameData.home_score ?? null,
          away: gameData.away_score ?? null,
        },
      };
    }
    
    // Remove undefined keys
    Object.keys(periodScores).forEach(key => {
      if (periodScores[key as keyof PeriodScores] === undefined) {
        delete periodScores[key as keyof PeriodScores];
      }
    });
    
    // logger.info({
    //   message: 'Period scores fetched successfully',
    //   gameId: game.id,
    //   sport: bdSport,
    //   periodScores,
    // });
    
    return periodScores;
    
  } catch (error: any) {
    logger.error({
      message: 'Error fetching period scores',
      gameId: game.id,
      balldontlieGameId,
      sport: bdSport,
      error: error.message,
      status: error.response?.status,
    });
    return null;
  }
}

/**
 * Fetch period scores for soccer leagues (EPL, La Liga, Bundesliga, Serie A, Ligue 1)
 * Derives 1H/2H scores from goals endpoint
 */
async function fetchSoccerPeriodScores(
  game: any, 
  bdSport: string, 
  balldontlieGameId: number, 
  apiKey: string
): Promise<PeriodScores | null> {
  const axios = require('axios');
  
  try {
    let goals: any[] = [];
    let homeTeamId: number | null = null;
    let awayTeamId: number | null = null;
    let homeScore: number | null = null;
    let awayScore: number | null = null;
    
    if (bdSport === 'epl') {
      // EPL uses /games/{id}/goals endpoint - but goals don't have team_id
      // We need to cross-reference with lineups to get player-to-team mapping
      const [goalsResponse, lineupsResponse] = await Promise.all([
        axios.get(
          `https://api.balldontlie.io/epl/v1/games/${balldontlieGameId}/goals`,
          { headers: { 'Authorization': apiKey } }
        ),
        axios.get(
          `https://api.balldontlie.io/epl/v1/games/${balldontlieGameId}/lineups`,
          { headers: { 'Authorization': apiKey } }
        ),
      ]);
      
      const rawGoals = goalsResponse.data?.data || [];
      const lineups = lineupsResponse.data?.data || [];
      
      // Build player_id -> team_id mapping from lineups
      const playerTeamMap = new Map<number, number>();
      lineups.forEach((lineup: any) => {
        if (lineup.player?.id && lineup.team_id) {
          playerTeamMap.set(lineup.player.id, lineup.team_id);
        }
      });
      
      // Enrich goals with team_id from lineups
      goals = rawGoals.map((goal: any) => ({
        ...goal,
        team_id: goal.scorer?.id ? playerTeamMap.get(goal.scorer.id) : null,
      }));
      
      // Get team IDs from the game object's transformed_data
      // The game object contains homeTeam/awayTeam info from Polymarket
      const transformedData = game.transformed_data || game.transformedData;
      const gameHomeTeam = transformedData?.homeTeam || transformedData?.home_team;
      const gameAwayTeam = transformedData?.awayTeam || transformedData?.away_team;
      
      // Use abbreviations to match with Ball Don't Lie team IDs
      const homeAbbr = (gameHomeTeam?.abbreviation || '').toLowerCase();
      const awayAbbr = (gameAwayTeam?.abbreviation || '').toLowerCase();
      
      // Extract unique team IDs from lineups
      const teamIdsFromLineups = [...new Set(lineups.map((l: any) => l.team_id))].filter(Boolean) as number[];
      
      // Build a map of team_id -> team_info by fetching from multiple seasons
      const teamInfoMap = new Map<number, any>();
      const dateObj = new Date();
      const month = dateObj.getMonth() + 1;
      const year = dateObj.getFullYear();
      const currentSeason = month >= 8 ? year : year - 1;
      
      // Only fetch teams that are actually in the game
      for (const seasonYear of [currentSeason, currentSeason - 1, currentSeason - 2]) {
        if (teamIdsFromLineups.every(id => teamInfoMap.has(id))) break;
        
        try {
          const teamsResponse = await axios.get(
            `https://api.balldontlie.io/epl/v1/teams?season=${seasonYear}`,
            { headers: { 'Authorization': apiKey } }
          );
          const teams = teamsResponse.data?.data || [];
          
          for (const team of teams) {
            // Only add teams that are in our lineup
            if (teamIdsFromLineups.includes(team.id) && !teamInfoMap.has(team.id)) {
              teamInfoMap.set(team.id, team);
            }
          }
        } catch (err) {
          // Continue to next season
        }
      }
      
      // Now match team abbreviations to the lineup team IDs
      for (const [teamId, team] of teamInfoMap.entries()) {
        const teamAbbr = (team.abbr || team.abbreviation || '').toLowerCase();
        const teamNameLower = (team.name || '').toLowerCase();
        
        // Exact match on abbreviation
        if (teamAbbr === homeAbbr) {
          homeTeamId = teamId;
        }
        if (teamAbbr === awayAbbr) {
          awayTeamId = teamId;
        }
        
        // Fallback: check if name contains our abbreviation
        if (!homeTeamId && (teamNameLower.includes(homeAbbr) || homeAbbr === teamAbbr.substring(0, 3))) {
          homeTeamId = teamId;
        }
        if (!awayTeamId && (teamNameLower.includes(awayAbbr) || awayAbbr === teamAbbr.substring(0, 3))) {
          awayTeamId = teamId;
        }
      }
      
      // If still missing team IDs (team not found in any season), use lineup order
      // In EPL lineups, home team usually comes first
      if ((!homeTeamId || !awayTeamId) && teamIdsFromLineups.length === 2) {
        if (!homeTeamId && !awayTeamId) {
          // Assume first team in lineups is home
          homeTeamId = teamIdsFromLineups[0];
          awayTeamId = teamIdsFromLineups[1];
        } else if (homeTeamId && !awayTeamId) {
          awayTeamId = teamIdsFromLineups.find(id => id !== homeTeamId) || null;
        } else if (awayTeamId && !homeTeamId) {
          homeTeamId = teamIdsFromLineups.find(id => id !== awayTeamId) || null;
        }
      }
      
      // Get final score from game data if available
      if (transformedData) {
        // Try to extract final score from game.score (format: "away-home")
        const scoreStr = game.score;
        if (scoreStr && typeof scoreStr === 'string') {
          const parts = scoreStr.split('-').map((s: string) => parseInt(s.trim(), 10));
          if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            awayScore = parts[0];
            homeScore = parts[1];
          }
        }
      }
      
      // logger.info({
      //   message: 'Fetched EPL goals for period scores',
      //   gameId: game.id,
      //   balldontlieGameId,
      //   goalsCount: goals.length,
      //   homeTeamId,
      //   awayTeamId,
      //   homeAbbr,
      //   awayAbbr,
      //   teamIdsFromLineups,
      //   playerTeamMapSize: playerTeamMap.size,
      // });
      
    } else {
      // Other soccer leagues (La Liga, Bundesliga, Serie A, Ligue 1) use /match_events
      const eventsResponse = await axios.get(
        `https://api.balldontlie.io/${bdSport}/v1/match_events`,
        { 
          headers: { 'Authorization': apiKey },
          params: { 'match_ids[]': balldontlieGameId, per_page: 100 },
        }
      );
      const events = eventsResponse.data?.data || [];
      goals = events.filter((e: any) => e.event_type === 'goal');
      
      // Get match info for team IDs and final score
      const matchesResponse = await axios.get(
        `https://api.balldontlie.io/${bdSport}/v1/matches`,
        { 
          headers: { 'Authorization': apiKey },
          params: { per_page: 100 },
        }
      );
      const matchData = (matchesResponse.data?.data || []).find((m: any) => m.id === balldontlieGameId);
      if (matchData) {
        homeTeamId = matchData.home_team_id;
        awayTeamId = matchData.away_team_id;
        homeScore = matchData.home_score;
        awayScore = matchData.away_score;
      }
      
      // logger.info({
      //   message: `Fetched ${bdSport.toUpperCase()} goals for period scores`,
      //   gameId: game.id,
      //   balldontlieGameId,
      //   goalsCount: goals.length,
      //   homeTeamId,
      //   awayTeamId,
      // });
    }
    
    // Calculate 1H and 2H scores from goals
    let home1H = 0, home2H = 0, away1H = 0, away2H = 0;
    
    for (const goal of goals) {
      // Skip own goals scored by home team (counts for away) and vice versa
      const isOwnGoal = goal.is_own_goal || goal.type === 'OwnGoal';
      const scoringTeamId = goal.team_id;
      
      // Determine if it's a first or second half goal
      let isFirstHalf = false;
      if (bdSport === 'epl') {
        // EPL uses phase: "FirstHalf" or "SecondHalf"
        isFirstHalf = goal.phase === 'FirstHalf';
      } else {
        // Other leagues use period: 1 or 2
        isFirstHalf = goal.period === 1;
      }
      
      // Determine which team scored
      const isHomeGoal = isOwnGoal 
        ? scoringTeamId === awayTeamId  // Own goal by away team = home goal
        : scoringTeamId === homeTeamId;
      
      if (isHomeGoal) {
        if (isFirstHalf) home1H++;
        else home2H++;
      } else {
        if (isFirstHalf) away1H++;
        else away2H++;
      }
    }
    
    const periodScores: PeriodScores = {
      '1h': { home: home1H, away: away1H },
      '2h': { home: home2H, away: away2H },
      ht: { home: home1H, away: away1H },  // Half-time = 1H
      ft: { home: homeScore ?? (home1H + home2H), away: awayScore ?? (away1H + away2H) },
      vft: { home: homeScore ?? (home1H + home2H), away: awayScore ?? (away1H + away2H) },
    };
    
    // logger.info({
    //   message: 'Soccer period scores calculated',
    //   gameId: game.id,
    //   sport: bdSport,
    //   periodScores,
    // });
    
    return periodScores;
    
  } catch (error: any) {
    logger.error({
      message: 'Error fetching soccer period scores',
      gameId: game.id,
      balldontlieGameId,
      sport: bdSport,
      error: error.message,
      status: error.response?.status,
    });
    return null;
  }
}

/**
 * Check if two names match by last name (for tennis player matching)
 * "Carlos Alcaraz" matches "alcaraz", "Alcaraz" matches "Carlos Alcaraz"
 */
function lastNameMatch(ourName: string, bdlName: string): boolean {
  if (!ourName || !bdlName) return false;
  const ourParts = ourName.split(/\s+/).filter(Boolean);
  const bdlParts = bdlName.split(/\s+/).filter(Boolean);
  const ourLast = ourParts[ourParts.length - 1];
  const bdlLast = bdlParts[bdlParts.length - 1];
  if (!ourLast || !bdlLast) return false;
  return ourLast === bdlLast || ourLast.includes(bdlLast) || bdlLast.includes(ourLast);
}

/** Transient network errors that warrant a retry */
const TRANSIENT_ERROR_PATTERNS = [
  'socket hang up',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'network',
  'timeout',
];

function isTransientNetworkError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return TRANSIENT_ERROR_PATTERNS.some((p) => msg.toLowerCase().includes(p.toLowerCase()));
}

/**
 * Extract team abbreviation from slug
 * Format: sport-away-home-YYYY-MM-DD (e.g., nhl-sea-ana-2025-12-22)
 */
function extractTeamFromSlug(slug: string | undefined, position: 'home' | 'away'): string | null {
  if (!slug) return null;
  
  const parts = slug.split('-');
  if (parts.length < 4) return null;
  
  // Format: sport-away-home-date
  // Index 1 = away, Index 2 = home
  if (position === 'away' && parts.length > 1) {
    return parts[1].toLowerCase();
  }
  if (position === 'home' && parts.length > 2) {
    return parts[2].toLowerCase();
  }
  
  return null;
}

/**
 * Find and map Ball Don't Lie game ID for a Polymarket game
 * @param game - LiveGame object from Polymarket
 * @returns Ball Don't Lie game ID or null if not found
 */
export async function findAndMapBalldontlieGameId(game: any): Promise<number | null> {
  // Check if already mapped
  if (game.balldontlie_game_id) {
    // Validate the stored game ID
    if (game.balldontlie_game_id <= 1) {
      logger.warn({
        message: 'Invalid stored Ball Don\'t Lie game ID, will attempt to remap',
        gameId: game.id,
        storedGameId: game.balldontlie_game_id,
        sport: game.sport,
      });
      // Continue to remap instead of using invalid ID
    } else {
      return game.balldontlie_game_id;
    }
  }

  // Check database for existing mapping
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT balldontlie_game_id FROM live_games WHERE id = $1',
        [game.id]
      );
      
      if (result.rows.length > 0 && result.rows[0].balldontlie_game_id) {
        const storedGameId = result.rows[0].balldontlie_game_id;
        
        // Validate stored game ID
        if (storedGameId <= 1) {
          logger.warn({
            message: 'Invalid Ball Don\'t Lie game ID in database, will attempt to remap',
            gameId: game.id,
            storedGameId,
            sport: game.sport,
          });
          // Continue to remap instead of using invalid ID
        } else {
          // logger.info({
          //   message: 'Found existing Ball Don\'t Lie game ID mapping',
          //   gameId: game.id,
          //   balldontlieGameId: storedGameId,
          // });
          return storedGameId;
        }
      }
    } finally {
      client.release();
    }
  } catch (dbError: any) {
    // Database might not be available in some environments
    logger.debug({
      message: 'Database not available for game mapping check, will try API lookup',
      gameId: game.id,
      error: dbError.message,
    });
  }

  // If not mapped, try to find the game in Ball Don't Lie API
  if (!game.sport) {
    // logger.warn({
    //   message: 'Cannot map game - missing sport',
    //   gameId: game.id,
    //   sport: game.sport,
    // });
    return null;
  }

  try {
    // Extract date for Ball Don't Lie API query
    // IMPORTANT: The Ball Don't Lie API uses LOCAL dates (US Eastern for US sports,
    // European timezones for soccer) not UTC dates. We must convert properly.
    let dateStr: string | null = null;
    
    // Use endDate (game time) as primary source since it's the actual scheduled time
    if (game.endDate) {
      const endDate = new Date(game.endDate);
      // Convert from UTC to the API's expected timezone
      dateStr = convertToApiTimezone(endDate, game.sport);
    }
    
    // Fallback to slug date if no endDate
    // The slug date is already in local time (US for US sports), so we can use it directly
    if (!dateStr && game.slug) {
      const dateMatch = game.slug.match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        dateStr = dateMatch[1];
      }
    }
    
    // Final fallback to startDate (convert to API timezone)
    if (!dateStr && game.startDate) {
      const startDate = new Date(game.startDate);
      dateStr = convertToApiTimezone(startDate, game.sport);
    }
    
    if (!dateStr) {
      // logger.warn({
      //   message: 'Cannot extract date from slug, endDate, or startDate',
      //   gameId: game.id,
      //   slug: game.slug,
      //   startDate: game.startDate,
      //   endDate: game.endDate,
      // });
      return null;
    }

    // logger.info({
    //   message: 'Extracted date for game mapping (converted to API timezone)',
    //   gameId: game.id,
    //   dateStr,
    //   slug: game.slug,
    //   startDate: game.startDate,
    //   endDate: game.endDate,
    //   sport: game.sport,
    // });

    // Resolve effective sport (tennis -> atp/wta from slug)
    const effectiveSport = game.sport?.toLowerCase() === 'tennis'
      ? getEffectiveTennisLeague(game)
      : game.sport;
    const bdSport = getBalldontlieSport(effectiveSport);

    let balldontlieGames: any[];
    if (isTennisSport(bdSport)) {
      // Tennis: fetch live matches when game is live, else by date
      const isLive = !!game.live;
      balldontlieGames = await ballDontLieClient.getTennisMatchesForMapping(bdSport as 'atp' | 'wta', dateStr, isLive);
    } else {
      balldontlieGames = await ballDontLieClient.getGamesByDate(effectiveSport, dateStr);
    }
    
    // // If no games found, this might be a timezone edge case or the game isn't scheduled yet
    // if (balldontlieGames.length === 0) {
    //   logger.info({
    //     message: 'No games found for converted date',
    //     gameId: game.id,
    //     dateStr,
    //     sport: game.sport,
    //   });
    // }
    
    // Soccer leagues return matches with kickoff timestamp - filter by exact date if needed
    if (isSoccerSport(bdSport) && dateStr && balldontlieGames.length > 0) {
      const filteredGames = balldontlieGames.filter((g: any) => {
        // Soccer matches use 'date' or 'kickoff' field for the match date
        const matchDate = g.date || g.kickoff;
        if (!matchDate) return true; // Keep if no date field
        const gameDate = new Date(matchDate).toISOString().split('T')[0];
        return gameDate === dateStr;
      });
      
      if (filteredGames.length !== balldontlieGames.length) {
        // logger.info({
        //   message: `Filtered ${bdSport?.toUpperCase()} matches by exact date`,
        //   originalCount: balldontlieGames.length,
        //   filteredCount: filteredGames.length,
        //   dateStr,
        // });
        balldontlieGames = filteredGames;
      }
    }

    // Log game/match structure for first result to understand API response format
    // if (balldontlieGames.length > 0) {
    //   logger.info({
    //     message: `${bdSport?.toUpperCase()} API response structure (sample)`,
    //     gameId: game.id,
    //     sampleGame: balldontlieGames[0],
    //     sampleGameKeys: Object.keys(balldontlieGames[0]),
    //   });
    // }
    
    // logger.info({
    //   message: 'Found Ball Don\'t Lie games/matches for date',
    //   gameId: game.id,
    //   sport: bdSport,
    //   dateStr,
    //   gamesCount: balldontlieGames.length,
    //   availableGames: balldontlieGames.slice(0, 5).map((g: any) => {
    //     // NCAAB/NCAAF use visitor_team instead of away_team
    //     const awayTeam = g.away_team || g.visitor_team;
    //     return {
    //     id: g.id,
    //       // Soccer matches have home_team/away_team objects with name/short_name
    //       home: g.home_team?.short_name || g.home_team?.abbreviation || g.home_team?.name || g.home_team?.full_name,
    //       away: awayTeam?.short_name || awayTeam?.abbreviation || awayTeam?.name || awayTeam?.full_name,
    //       homeTeamId: g.home_team?.id || g.home_team_id,
    //       awayTeamId: awayTeam?.id || g.away_team_id,
    //       date: g.date || g.kickoff,
    //     season: g.season,
    //     };
    //   }),
    //   note: isSoccerSport(bdSport) ? 'Soccer matches use home_team/away_team objects with name/short_name' : 'Other sports use team objects',
    // });

    // Match by team/player identifiers - try multiple sources
    const homeTeamAbbr = game.homeTeam?.abbreviation?.toLowerCase() || 
                         game.teamIdentifiers?.home?.toLowerCase() || 
                         extractTeamFromSlug(game.slug, 'home') || '';
    const awayTeamAbbr = game.awayTeam?.abbreviation?.toLowerCase() || 
                         game.teamIdentifiers?.away?.toLowerCase() || 
                         extractTeamFromSlug(game.slug, 'away') || '';
    
    // Get full team/player names (for tennis, these are player names)
    const homeTeamName = (game.homeTeam?.name || game.title?.split(/\s+vs\.?\s+/i)?.[1]?.trim() || '').toLowerCase();
    const awayTeamName = (game.awayTeam?.name || game.title?.split(/\s+vs\.?\s+/i)?.[0]?.trim() || '').toLowerCase();
    
    // logger.info({
    //   message: 'Team identifiers for matching',
    //   gameId: game.id,
    //   sport: bdSport,
    //   homeTeamAbbr,
    //   awayTeamAbbr,
    //   homeTeamName,
    //   awayTeamName,
    //   slug: game.slug,
    // });

    // Validate that we found games
    if (balldontlieGames.length === 0) {
      // logger.warn({
      //   message: 'No Ball Don\'t Lie games found for date',
      //   gameId: game.id,
      //   sport: game.sport,
      //   dateStr,
      //   homeTeamAbbr,
      //   awayTeamAbbr,
      // });
      return null;
    }

    // For soccer leagues, fetch teams to map team IDs to names/abbreviations
    let soccerTeamsMap: Map<number, { name: string; short_name: string; abbr: string }> = new Map();
    if (isSoccerSport(bdSport) && bdSport) {
      // Determine season from date
      const dateObj = new Date(dateStr);
      const year = dateObj.getFullYear();
      const month = dateObj.getMonth() + 1;
      const season = month >= 8 ? year : year - 1;
      
      soccerTeamsMap = await ballDontLieClient.getSoccerTeams(bdSport, season);
      
      // logger.info({
      //   message: 'Fetched soccer teams for matching',
      //   sport: bdSport,
      //   season,
      //   teamCount: soccerTeamsMap.size,
      // });
    }

    // Find matching game/match
    const matchedGame = balldontlieGames.find((bdGame: any) => {
      // Tennis: match by player names (player1/player2)
      if (isTennisSport(bdSport)) {
        const p1 = bdGame.player1;
        const p2 = bdGame.player2;
        const bdP1Name = (p1?.full_name || `${p1?.first_name || ''} ${p1?.last_name || ''}`.trim()).toLowerCase();
        const bdP2Name = (p2?.full_name || `${p2?.first_name || ''} ${p2?.last_name || ''}`.trim()).toLowerCase();

        const normalizeName = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const awayNorm = normalizeName(awayTeamName);
        const homeNorm = normalizeName(homeTeamName);

        const awayMatchesP1 = awayNorm && bdP1Name && (bdP1Name.includes(awayNorm) || awayNorm.includes(bdP1Name) || lastNameMatch(awayNorm, bdP1Name));
        const awayMatchesP2 = awayNorm && bdP2Name && (bdP2Name.includes(awayNorm) || awayNorm.includes(bdP2Name) || lastNameMatch(awayNorm, bdP2Name));
        const homeMatchesP1 = homeNorm && bdP1Name && (bdP1Name.includes(homeNorm) || homeNorm.includes(bdP1Name) || lastNameMatch(homeNorm, bdP1Name));
        const homeMatchesP2 = homeNorm && bdP2Name && (bdP2Name.includes(homeNorm) || homeNorm.includes(bdP2Name) || lastNameMatch(homeNorm, bdP2Name));

        return (awayMatchesP1 && homeMatchesP2) || (awayMatchesP2 && homeMatchesP1);
      }

      // Soccer leagues: EPL has home_team_id/away_team_id (not objects)
      if (isSoccerSport(bdSport)) {
        // Get team info from the teams map using the IDs
        const homeTeamId = bdGame.home_team_id || bdGame.home_team?.id;
        const awayTeamId = bdGame.away_team_id || bdGame.away_team?.id;
        
        // Look up team info from the fetched teams map
        const bdHomeTeam = soccerTeamsMap.get(homeTeamId);
        const bdAwayTeam = soccerTeamsMap.get(awayTeamId);
        
        // Also check if team objects are embedded in the game
        const bdHomeShort = bdHomeTeam?.short_name || (bdGame.home_team?.short_name || '').toLowerCase();
        const bdAwayShort = bdAwayTeam?.short_name || (bdGame.away_team?.short_name || '').toLowerCase();
        const bdHomeName = bdHomeTeam?.name || (bdGame.home_team?.name || '').toLowerCase();
        const bdAwayName = bdAwayTeam?.name || (bdGame.away_team?.name || '').toLowerCase();
        const bdHomeAbbr = bdHomeTeam?.abbr || (bdGame.home_team?.abbr || '').toLowerCase();
        const bdAwayAbbr = bdAwayTeam?.abbr || (bdGame.away_team?.abbr || '').toLowerCase();
        
        // Skip matches without team data
        if (!bdHomeShort && !bdHomeName && !bdHomeAbbr && !bdAwayShort && !bdAwayName && !bdAwayAbbr) {
          // logger.debug({
          //   message: 'Skipping game - no team info available',
          //   gameId: bdGame.id,
          //   homeTeamId,
          //   awayTeamId,
          // });
          return false;
        }
        
        // Common abbreviation mappings for soccer teams
        const soccerTeamAbbreviations: Record<string, string[]> = {
          'che': ['chelsea', 'che'],
          'new': ['newcastle', 'new', 'newcastle united'],
          'ars': ['arsenal', 'ars'],
          'liv': ['liverpool', 'liv'],
          'mci': ['manchester city', 'man city', 'mci'],
          'mun': ['manchester united', 'man utd', 'man united', 'mun'],
          'tot': ['tottenham', 'spurs', 'tot', 'tottenham hotspur'],
          'bri': ['brighton', 'bri', 'brighton & hove albion'],
          'whu': ['west ham', 'whu', 'west ham united'],
          'eve': ['everton', 'eve'],
          'lei': ['leicester', 'lei', 'leicester city'],
          'avl': ['aston villa', 'avl', 'villa'],
          'cry': ['crystal palace', 'cry', 'palace'],
          'ful': ['fulham', 'ful'],
          'sou': ['southampton', 'sou'],
          'wol': ['wolves', 'wolverhampton', 'wol'],
          'bou': ['bournemouth', 'bou', 'afc bournemouth'],
          'bre': ['brentford', 'bre'],
          'for': ['nottingham forest', 'for', 'forest'],
          'ips': ['ipswich', 'ips', 'ipswich town'],
          // Bundesliga
          'bay': ['bayern', 'bayern munich', 'bayern münchen', 'fcb'],
          'dor': ['dortmund', 'borussia dortmund', 'bvb'],
          'rbl': ['rb leipzig', 'leipzig', 'rbl'],
          'lev': ['leverkusen', 'bayer leverkusen', 'b04'],
          // La Liga
          'rma': ['real madrid', 'madrid', 'rma'],
          'fcb': ['barcelona', 'barca', 'fcb'],
          'atm': ['atletico madrid', 'atletico', 'atm'],
          'sev': ['sevilla', 'sev'],
          // Serie A
          'juv': ['juventus', 'juve', 'juv'],
          'int': ['inter', 'inter milan', 'internazionale'],
          'mil': ['ac milan', 'milan', 'mil'],
          'nap': ['napoli', 'nap'],
          'rom': ['roma', 'as roma', 'rom'],
          // Ligue 1
          'psg': ['paris saint-germain', 'paris', 'psg'],
          'mon': ['monaco', 'as monaco', 'mon'],
          'lyo': ['lyon', 'olympique lyonnais', 'ol'],
          'mar': ['marseille', 'olympique de marseille', 'om'],
        };
        
        // Helper function to check if team matches
        const teamMatches = (ourAbbr: string, ourName: string, bdShort: string, bdName: string, bdAbbr: string): boolean => {
          if (!ourAbbr && !ourName) return false;
          if (!bdShort && !bdName && !bdAbbr) return false;
          
          // Direct match on abbreviation
          if (ourAbbr && bdAbbr && ourAbbr === bdAbbr) {
            return true;
          }
          
          // Direct match on abbreviation/short_name
          if (ourAbbr && bdShort && (ourAbbr === bdShort || bdShort.includes(ourAbbr) || ourAbbr.includes(bdShort))) {
            return true;
          }
          
          // Check against known abbreviation mappings
          const abbr = ourAbbr.toLowerCase();
          if (soccerTeamAbbreviations[abbr]) {
            const aliases = soccerTeamAbbreviations[abbr];
            if (aliases.some(alias => 
              bdShort.includes(alias) || 
              bdName.includes(alias) || 
              (bdAbbr && bdAbbr.includes(alias)) ||
              alias.includes(bdShort) || 
              alias.includes(bdName) ||
              (bdAbbr && alias.includes(bdAbbr))
            )) {
              return true;
            }
          }
          
          // Check if our abbreviation is contained in their name
          if (ourAbbr && bdName && (bdName.includes(ourAbbr) || ourAbbr.includes(bdName.substring(0, 3)))) {
            return true;
          }
          
          // Check if our full name matches their name
          if (ourName && bdName && (bdName.includes(ourName) || ourName.includes(bdName))) {
          return true;
        }
        
        return false;
        };
        
        const homeMatch = teamMatches(homeTeamAbbr, homeTeamName, bdHomeShort, bdHomeName, bdHomeAbbr);
        const awayMatch = teamMatches(awayTeamAbbr, awayTeamName, bdAwayShort, bdAwayName, bdAwayAbbr);
        
        // Also check swapped (in case home/away are reversed)
        const homeMatchSwapped = teamMatches(homeTeamAbbr, homeTeamName, bdAwayShort, bdAwayName, bdAwayAbbr);
        const awayMatchSwapped = teamMatches(awayTeamAbbr, awayTeamName, bdHomeShort, bdHomeName, bdHomeAbbr);
        
        const fullMatch = (homeMatch && awayMatch) || (homeMatchSwapped && awayMatchSwapped);
        
        if (fullMatch || homeMatch || awayMatch) {
          logger.info({
            message: `${bdSport?.toUpperCase()} match candidate`,
            bdMatchId: bdGame.id,
            bdHomeAbbr,
            bdAwayAbbr,
            bdHomeShort,
            bdAwayShort,
            bdHomeName,
            bdAwayName,
            ourHomeAbbr: homeTeamAbbr,
            ourAwayAbbr: awayTeamAbbr,
            homeMatch,
            awayMatch,
            swapped: homeMatchSwapped && awayMatchSwapped,
            fullMatch,
          });
        }
        
        return fullMatch;
      }
      
      // NHL uses tricode, other sports use abbreviation
      // NCAAB/NCAAF use visitor_team instead of away_team
      const awayTeamObj = bdGame.away_team || bdGame.visitor_team;
      const bdHomeAbbr = (bdGame.home_team?.tricode || bdGame.home_team?.abbreviation || '').toLowerCase();
      const bdAwayAbbr = (awayTeamObj?.tricode || awayTeamObj?.abbreviation || '').toLowerCase();
      const bdHomeName = (bdGame.home_team?.full_name || bdGame.home_team?.name || '').toLowerCase();
      const bdAwayName = (awayTeamObj?.full_name || awayTeamObj?.name || '').toLowerCase();
      // Also get college name for matching (NCAAF/NCAAB have this)
      const bdHomeCollege = (bdGame.home_team?.college || '').toLowerCase();
      const bdAwayCollege = (awayTeamObj?.college || '').toLowerCase();

      // Skip games without team data - can't match without team information
      if (!bdHomeAbbr && !bdAwayAbbr && !bdHomeName && !bdAwayName) {
        return false;
      }

      // College abbreviation aliases (our slug abbr -> possible API abbrs)
      // The key is the slug abbreviation, values are possible Ball Don't Lie abbreviations
      const collegeAbbreviations: Record<string, string[]> = {
        // CFB/CBB slug abbreviations -> Ball Don't Lie API abbreviations
        'jmad': ['jmu', 'james madison', 'jmad'],
        'ore': ['ore', 'oregon', 'oreg'],
        'ala': ['ala', 'bama', 'alabama'],
        'txam': ['ta&m', 'tam', 'texas a&m', 'tamu'],
        'mia': ['mia', 'miami'],
        'miss': ['miss', 'ole miss', 'mississippi'],
        'tuln': ['tuln', 'tulane'],
        'mtst': ['mtst', 'montana state'],
        'mont': ['mont', 'montana'],
        'hou': ['hou', 'houston'],
        'ark': ['ark', 'arkansas'],
        'osu': ['osu', 'ohio state', 'ohiost', 'ohio st'],
        'ohiost': ['osu', 'ohio state', 'ohiost'],
        'unc': ['unc', 'north carolina'],
        'msu': ['msu', 'michigan state'],
        'uk': ['uk', 'kentucky'],
        'pur': ['pur', 'purdue'],
        'aub': ['aub', 'auburn'],
        'lsu': ['lsu', 'louisiana state'],
        'fsu': ['fsu', 'florida state'],
        'byu': ['byu', 'brigham young'],
        'ucf': ['ucf', 'central florida'],
        'usc': ['usc', 'southern california'],
        'ucla': ['ucla'],
        // Penn State - both psu and pennst can appear in slugs
        'psu': ['psu', 'penn state', 'pennst'],
        'pennst': ['psu', 'penn state', 'pennst'],
        // Clemson - both clem and clmsn can appear in slugs
        'clem': ['clem', 'clemson', 'clmsn'],
        'clmsn': ['clem', 'clemson', 'clmsn'],
        // Georgia Tech
        'gtech': ['gtech', 'gt', 'georgia tech'],
        'gt': ['gtech', 'gt', 'georgia tech'],
        // Georgia
        'uga': ['uga', 'georgia', 'ga'],
        // NC Central
        'ncc': ['nccu', 'nc central', 'north carolina central'],
        // Pittsburgh
        'pitt': ['pitt', 'pittsburgh'],
        // Duke
        'duke': ['duke'],
        // Wake Forest
        'wakef': ['wake', 'wake forest', 'wf'],
        // Syracuse
        'syr': ['syr', 'cuse', 'syracuse'],
        // NC State
        'ncst': ['ncsu', 'nc state', 'ncst'],
        // Arizona State
        'arzst': ['asu', 'arizona state', 'ariz st'],
        // Iowa
        'iowa': ['iowa'],
        // Vanderbilt
        'vand': ['vand', 'vandy', 'vanderbilt'],
        // Nebraska
        'nebr': ['neb', 'nebr', 'nebraska'],
        // Utah
        'utah': ['utah'],
        // Coastal Carolina
        'coast': ['ccu', 'coastal', 'coastal carolina'],
        // Louisiana Tech
        'loutch': ['lat', 'la tech', 'louisiana tech'],
        // Memphis
        'mem': ['mem', 'memphis'],
        // North Texas
        'ntex': ['unt', 'north texas'],
      };
      
      // Helper to check if abbreviations match
      const abbrMatches = (ourAbbr: string, bdAbbr: string, bdName: string, bdCollege: string): boolean => {
        if (!ourAbbr) return false;
        
        // Direct match
        if (bdAbbr && ourAbbr === bdAbbr) return true;
        
        // Check aliases
        const aliases = collegeAbbreviations[ourAbbr];
        if (aliases) {
          if (bdAbbr && aliases.includes(bdAbbr)) return true;
          if (bdCollege && aliases.some(a => bdCollege.includes(a) || a.includes(bdCollege))) return true;
          if (bdName && aliases.some(a => bdName.includes(a))) return true;
        }
        
        // Partial match on name/college
        if (bdName && bdName.includes(ourAbbr)) return true;
        if (bdCollege && bdCollege.includes(ourAbbr)) return true;
        if (bdAbbr && ourAbbr.includes(bdAbbr)) return true;
        
        return false;
      };

      // More flexible matching - check exact match first, then partial
      const homeMatch = abbrMatches(homeTeamAbbr, bdHomeAbbr, bdHomeName, bdHomeCollege) ||
                        abbrMatches(homeTeamAbbr, bdAwayAbbr, bdAwayName, bdAwayCollege); // Sometimes teams are swapped
      
      const awayMatch = abbrMatches(awayTeamAbbr, bdAwayAbbr, bdAwayName, bdAwayCollege) ||
                        abbrMatches(awayTeamAbbr, bdHomeAbbr, bdHomeName, bdHomeCollege); // Sometimes teams are swapped

      // // Log for debugging when there's a potential match
      // if ((homeMatch || awayMatch) && homeTeamAbbr && awayTeamAbbr) {
      //   logger.info({
      //     message: 'Potential game match found',
      //     bdGameId: bdGame.id,
      //     bdHomeAbbr,
      //     bdAwayAbbr,
      //     bdHomeName: bdGame.home_team?.full_name || bdGame.home_team?.name,
      //     bdAwayName: awayTeamObj?.full_name || awayTeamObj?.name,
      //     homeTeamAbbr,
      //     awayTeamAbbr,
      //     homeMatch,
      //     awayMatch,
      //     fullMatch: homeMatch && awayMatch,
      //   });
      // }

      return homeMatch && awayMatch;
    });

    if (matchedGame) {
      // Validate game ID before storing
      if (!matchedGame.id || matchedGame.id <= 1) {
        // logger.warn({
        //   message: 'Invalid Ball Don\'t Lie game ID found',
        //   polymarketGameId: game.id,
        //   balldontlieGameId: matchedGame.id,
        //   sport: game.sport,
        //   note: 'Game ID appears to be invalid, skipping mapping',
        // });
        return null;
      }
      
      // Store the mapping in database
      const updateClient = await pool.connect();
      try {
        await updateClient.query(
          'UPDATE live_games SET balldontlie_game_id = $1 WHERE id = $2',
          [matchedGame.id, game.id]
        );
        
        // logger.info({
        //   message: 'Mapped Ball Don\'t Lie game ID',
        //   polymarketGameId: game.id,
        //   balldontlieGameId: matchedGame.id,
        //   sport: game.sport,
        // });
        
        return matchedGame.id;
      } finally {
        updateClient.release();
      }
    } else {
      // logger.warn({
      //   message: 'Could not find matching Ball Don\'t Lie game',
      //   polymarketGameId: game.id,
      //   sport: game.sport,
      //   date: dateStr,
      //   homeTeamAbbr,
      //   awayTeamAbbr,
      //   availableGames: isTennisSport(bdSport)
      //     ? balldontlieGames.map((g: any) => ({
      //         id: g.id,
      //         player1: g.player1?.full_name,
      //         player2: g.player2?.full_name,
      //       }))
      //     : balldontlieGames.map((g: any) => {
      //         const awayTeam = g.away_team || g.visitor_team;
      //         return {
      //           id: g.id,
      //           home: g.home_team?.abbreviation || g.home_team?.name,
      //           away: awayTeam?.abbreviation || awayTeam?.name,
      //         };
      //       }),
      // });
      return null;
    }
  } catch (error) {
    const retries = (game as any).__bdlRetries ?? 0;
    if (isTransientNetworkError(error) && retries < 2) {
      (game as any).__bdlRetries = retries + 1;
      // logger.warn({
      //   message: 'Retrying after transient Ball Don\'t Lie API error',
      //   gameId: game.id,
      //   sport: game.sport,
      //   attempt: retries + 1,
      //   error: error instanceof Error ? error.message : String(error),
      // });
      await new Promise((r) => setTimeout(r, 600 * (retries + 1)));
      try {
        return await findAndMapBalldontlieGameId(game);
      } finally {
        delete (game as any).__bdlRetries;
      }
    }
    delete (game as any).__bdlRetries;
    logger.error({
      message: 'Error finding Ball Don\'t Lie game',
      gameId: game.id,
      sport: game.sport,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Automatically fetch and store player stats for a game
 * This function is called when a game is requested via the live stats endpoint
 * @param game - LiveGame object from Polymarket
 * @returns Array of player stats (from database, not API)
 */
export async function fetchAndStorePlayerStats(game: any): Promise<any[]> {
  // Resolve effective sport (tennis -> atp/wta from slug)
  const effectiveSport = game.sport?.toLowerCase() === 'tennis'
    ? getEffectiveTennisLeague(game)
    : game.sport;

  // Check if sport is supported
  if (!isSportSupported(effectiveSport)) {
    // logger.warn({
    //   message: 'Sport not supported by Ball Don\'t Lie API',
    //   gameId: game.id,
    //   sport: game.sport,
    //   effectiveSport,
    //   note: `Ball Don't Lie API supports: NBA, NFL, MLB, NHL, EPL, NCAAF, NCAAB, ATP, WTA.`,
    // });
    return [];
  }

  // For tennis (ATP/WTA), only fetch match stats when game is live
  if (getBalldontlieSport(effectiveSport) === 'atp' || getBalldontlieSport(effectiveSport) === 'wta') {
    if (!game.live) {
      // logger.debug({
      //   message: 'Skipping tennis match stats fetch - game is not live',
      //   gameId: game.id,
      //   sport: effectiveSport,
      // });
      return [];
    }
  }

  try {
    // Find or map Ball Don't Lie game ID
    // logger.info({
    //   message: 'Finding/mapping Ball Don\'t Lie game ID',
    //   gameId: game.id,
    //   sport: game.sport,
    // });
    
    const balldontlieGameId = await findAndMapBalldontlieGameId(game);
    
    if (!balldontlieGameId) {
      logger.warn({
        message: 'Could not map Ball Don\'t Lie game ID, skipping stats fetch',
        gameId: game.id,
        sport: game.sport,
      });
      return [];
    }

    // logger.info({
    //   message: 'Mapped to Ball Don\'t Lie game ID',
    //   gameId: game.id,
    //   balldontlieGameId,
    // });

    // Check if stats were recently fetched (within last 5 minutes)
    const client = await pool.connect();
    try {
      const recentStats = await client.query(
        `SELECT COUNT(*) as count FROM game_player_stats 
         WHERE game_id = $1 AND stats_updated_at > NOW() - INTERVAL '10 seconds'`,
        [game.id]
      );

      if (parseInt(recentStats.rows[0].count) > 0) {
        // // Stats were recently fetched, return from database
        // logger.info({
        //   message: 'Using cached player stats',
        //   gameId: game.id,
        // });
        const cachedStats = await getPlayerStats(game.id);
        // logger.info({
        //   message: 'Returning cached stats',
        //   gameId: game.id,
        //   statsCount: cachedStats.length,
        // });
        return cachedStats;
      }
    } finally {
      client.release();
    }

    // Fetch stats from API
    // logger.info({
    //   message: 'Fetching player stats from Ball Don\'t Lie API',
    //   gameId: game.id,
    //   sport: game.sport,
    //   balldontlieGameId,
    // });

    const stats = await ballDontLieClient.getPlayerStats(game.sport, [balldontlieGameId]);


    // logger.info({
    //   message: 'Received stats from API',
    //   gameId: game.id,
    //   statsCount: stats.length,
    // });

    if (stats.length === 0) {
      logger.warn({
        message: 'No player stats available yet',
        gameId: game.id,
        balldontlieGameId,
      });
      return [];
    }

    // // Store stats in database
    // logger.info({
    //   message: 'Storing player stats in database',
    //   gameId: game.id,
    //   statsCount: stats.length,
    // });
    
    await storePlayerStats(game.id, effectiveSport, balldontlieGameId, stats);

    // Return stats from database (ensures consistent format)
    const dbStats = await getPlayerStats(game.id);
    // logger.info({
    //   message: 'Returning stats from database',
    //   gameId: game.id,
    //   statsCount: dbStats.length,
    // });
    
    return dbStats;
  } catch (error) {
    logger.error({
      message: 'Error fetching and storing player stats',
      gameId: game.id,
      sport: game.sport,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    // Don't throw - return empty array so endpoint still works
    return [];
  }
}
