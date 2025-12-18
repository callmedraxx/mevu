/**
 * Teams Service
 * Fetches and manages team data from Polymarket Gamma API
 * Supports PostgreSQL storage in production and in-memory storage in development
 */

import { logger } from '../../config/logger';
import { polymarketClient } from './polymarket.client';
import { pool } from '../../config/database';
import { getLeagueForSport, isValidLeague, getAvailableLeagues } from './teams.config';
import { ValidationError, PolymarketError, ErrorCode } from '../../utils/errors';
import { logoMappingService } from '../espn/logo-mapping.service';

/**
 * Team data structure from Polymarket API
 */
export interface Team {
  id: number;
  name: string;
  league: string;
  record: string;
  logo: string;
  abbreviation: string;
  alias: string;
  createdAt: string;
  updatedAt: string;
  providerId: number;
  color: string;
}

/**
 * In-memory storage for development
 * Map<league, Map<teamId, Team>>
 */
const inMemoryTeams: Map<string, Map<number, Team>> = new Map();

/**
 * Check if we should use database or in-memory storage
 */
const useDatabase = process.env.NODE_ENV === 'production';

/**
 * Teams Service
 */
export class TeamsService {
  /**
   * Fetch teams from Polymarket Gamma API
   * @param league - League name (e.g., 'nfl', 'nba')
   * @returns Array of teams
   */
  async fetchTeamsFromAPI(league: string): Promise<Team[]> {
    logger.info({
      message: 'Fetching teams from API',
      league,
    });

    try {
      const response = await polymarketClient.get<Team[]>(
        '/teams',
        {
          league,
          limit: 500,
          offset: 0,
        }
      );

      // Handle both array response and wrapped response
      let teams: Team[] = [];
      if (Array.isArray(response)) {
        teams = response;
      } else if (response && 'data' in response && Array.isArray((response as any).data)) {
        teams = (response as any).data;
      }

      logger.info({
        message: 'Teams fetched from API',
        league,
        teamCount: teams.length,
      });

      return teams;
    } catch (error) {
      logger.error({
        message: 'Error fetching teams from API',
        league,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (error instanceof PolymarketError) {
        throw error;
      }

      throw new PolymarketError(
        ErrorCode.POLYMARKET_FETCH_FAILED,
        `Failed to fetch teams for league ${league}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Replace Polymarket logo URLs with our server URLs based on abbreviation mapping
   * @param team - Team object
   * @returns Team with updated logo URL
   */
  private replaceLogoUrl(team: Team): Team {
    // Look up logo URL by abbreviation
    const logoUrl = logoMappingService.getLogoUrl(team.league, team.abbreviation);
    
    if (logoUrl) {
      return {
        ...team,
        logo: logoUrl,
      };
    }
    
    // If no mapped logo, return team as-is (will use Polymarket logo)
    logger.debug({
      message: 'No mapped logo found for team, using original',
      league: team.league,
      abbreviation: team.abbreviation,
    });
    
    return team;
  }

  /**
   * Upsert teams into database or in-memory storage
   * @param teams - Array of teams to upsert
   * @param league - League name
   */
  async upsertTeams(teams: Team[], league: string): Promise<void> {
    // Download ESPN logos for teams (by abbreviation)
    try {
      logger.info({
        message: 'Downloading ESPN logos for teams',
        league,
        teamCount: teams.length,
      });
      
      const teamsToDownload = teams.map(team => ({
        league: team.league,
        abbreviation: team.abbreviation,
      }));
      
      await logoMappingService.downloadLogosForTeams(teamsToDownload);
    } catch (error) {
      logger.warn({
        message: 'Error downloading ESPN logos, continuing with original logos',
        league,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Replace logo URLs before storing (lookup by abbreviation)
    const teamsWithReplacedLogos = teams.map(team => this.replaceLogoUrl(team));

    if (useDatabase) {
      await this.upsertTeamsToDatabase(teamsWithReplacedLogos, league);
    } else {
      this.upsertTeamsToMemory(teamsWithReplacedLogos, league);
    }
  }

  /**
   * Upsert teams to PostgreSQL database
   */
  private async upsertTeamsToDatabase(teams: Team[], league: string): Promise<void> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      for (const team of teams) {
        await client.query(
          `INSERT INTO teams (
            id, name, league, record, logo, abbreviation, alias, 
            provider_id, color, api_created_at, api_updated_at, db_updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            league = EXCLUDED.league,
            record = EXCLUDED.record,
            logo = EXCLUDED.logo,
            abbreviation = EXCLUDED.abbreviation,
            alias = EXCLUDED.alias,
            provider_id = EXCLUDED.provider_id,
            color = EXCLUDED.color,
            api_created_at = EXCLUDED.api_created_at,
            api_updated_at = EXCLUDED.api_updated_at,
            db_updated_at = CURRENT_TIMESTAMP`,
          [
            team.id,
            team.name,
            team.league,
            team.record,
            team.logo,
            team.abbreviation,
            team.alias,
            team.providerId,
            team.color,
            team.createdAt,
            team.updatedAt,
          ]
        );
      }

      await client.query('COMMIT');

      logger.info({
        message: 'Teams upserted to database',
        league,
        teamCount: teams.length,
      });
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error({
          message: 'Error during ROLLBACK in upsertTeamsToDatabase',
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      logger.error({
        message: 'Error upserting teams to database',
        league,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Upsert teams to in-memory storage
   */
  private upsertTeamsToMemory(teams: Team[], league: string): void {
    if (!inMemoryTeams.has(league)) {
      inMemoryTeams.set(league, new Map());
    }

    const leagueTeams = inMemoryTeams.get(league)!;
    for (const team of teams) {
      leagueTeams.set(team.id, team);
    }

    logger.info({
      message: 'Teams upserted to memory',
      league,
      teamCount: teams.length,
    });
  }

  /**
   * Get teams by league from database or memory
   * @param league - League name
   * @returns Array of teams
   */
  async getTeamsByLeague(league: string): Promise<Team[]> {
    if (useDatabase) {
      return this.getTeamsFromDatabase(league);
    } else {
      return this.getTeamsFromMemory(league);
    }
  }

  /**
   * Get teams from PostgreSQL database
   */
  private async getTeamsFromDatabase(league: string): Promise<Team[]> {
    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT 
          id, name, league, record, logo, abbreviation, alias,
          provider_id as "providerId", color,
          api_created_at as "createdAt", api_updated_at as "updatedAt"
        FROM teams 
        WHERE league = $1 
        ORDER BY name`,
        [league]
      );

      const teams: Team[] = result.rows.map((row: any) => {
        const team: Team = {
          id: row.id,
          name: row.name,
          league: row.league,
          record: row.record,
          logo: row.logo,
          abbreviation: row.abbreviation,
          alias: row.alias,
          providerId: row.providerId,
          color: row.color,
          createdAt: row.createdAt?.toISOString() || '',
          updatedAt: row.updatedAt?.toISOString() || '',
        };
        // Replace logo URL if it's still a Polymarket URL
        return this.replaceLogoUrl(team);
      });

      logger.info({
        message: 'Teams retrieved from database',
        league,
        teamCount: teams.length,
      });

      return teams;
    } catch (error) {
      logger.error({
        message: 'Error retrieving teams from database',
        league,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get teams from in-memory storage
   */
  private getTeamsFromMemory(league: string): Team[] {
    const leagueTeams = inMemoryTeams.get(league);
    if (!leagueTeams) {
      return [];
    }

    const teams = Array.from(leagueTeams.values());
    teams.sort((a, b) => a.name.localeCompare(b.name));

    // Replace logo URLs
    const teamsWithReplacedLogos = teams.map(team => this.replaceLogoUrl(team));

    logger.info({
      message: 'Teams retrieved from memory',
      league,
      teamCount: teamsWithReplacedLogos.length,
    });

    return teamsWithReplacedLogos;
  }

  /**
   * Get a specific team by ID
   * @param id - Team ID
   * @param league - Optional league filter
   * @returns Team or null if not found
   */
  async getTeamById(id: number, league?: string): Promise<Team | null> {
    if (useDatabase) {
      return this.getTeamFromDatabase(id, league);
    } else {
      return this.getTeamFromMemory(id, league);
    }
  }

  /**
   * Get team from PostgreSQL database
   */
  private async getTeamFromDatabase(id: number, league?: string): Promise<Team | null> {
    const client = await pool.connect();

    try {
      let query = `SELECT 
        id, name, league, record, logo, abbreviation, alias,
        provider_id as "providerId", color,
        api_created_at as "createdAt", api_updated_at as "updatedAt"
      FROM teams 
      WHERE id = $1`;
      const params: any[] = [id];

      if (league) {
        query += ' AND league = $2';
        params.push(league);
      }

      const result = await client.query(query, params);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      const team: Team = {
        id: row.id,
        name: row.name,
        league: row.league,
        record: row.record,
        logo: row.logo,
        abbreviation: row.abbreviation,
        alias: row.alias,
        providerId: row.providerId,
        color: row.color,
        createdAt: row.createdAt?.toISOString() || '',
        updatedAt: row.updatedAt?.toISOString() || '',
      };
      // Replace logo URL if it's still a Polymarket URL
      return this.replaceLogoUrl(team);
    } catch (error) {
      logger.error({
        message: 'Error retrieving team from database',
        id,
        league,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get team from in-memory storage
   */
  private getTeamFromMemory(id: number, league?: string): Team | null {
    let team: Team | null = null;
    
    if (league) {
      const leagueTeams = inMemoryTeams.get(league);
      team = leagueTeams?.get(id) || null;
    } else {
      // Search across all leagues
      const leagueTeamsArray = Array.from(inMemoryTeams.values());
      for (const leagueTeams of leagueTeamsArray) {
        const found = leagueTeams.get(id);
        if (found) {
          team = found;
          break;
        }
      }
    }

    if (team) {
      // Replace logo URL if it's still a Polymarket URL
      return this.replaceLogoUrl(team);
    }

    return null;
  }

  /**
   * Get team by abbreviation
   * @param league - League name
   * @param abbreviation - Team abbreviation (e.g., 'LAL', 'NYK')
   * @returns Team or null if not found
   */
  async getTeamByAbbreviation(league: string, abbreviation: string): Promise<Team | null> {
    if (useDatabase) {
      return this.getTeamByAbbreviationFromDatabase(league, abbreviation);
    } else {
      return this.getTeamByAbbreviationFromMemory(league, abbreviation);
    }
  }

  /**
   * Get team by abbreviation from database
   */
  private async getTeamByAbbreviationFromDatabase(league: string, abbreviation: string): Promise<Team | null> {
    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT id, name, league, record, logo, abbreviation, alias, 
                provider_id as "providerId", color, 
                api_created_at as "createdAt", api_updated_at as "updatedAt"
         FROM teams 
         WHERE LOWER(league) = LOWER($1) AND UPPER(abbreviation) = UPPER($2)
         LIMIT 1`,
        [league, abbreviation]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const team = result.rows[0] as Team;
      return this.replaceLogoUrl(team);
    } finally {
      client.release();
    }
  }

  /**
   * Get team by abbreviation from memory
   */
  private getTeamByAbbreviationFromMemory(league: string, abbreviation: string): Team | null {
    const leagueTeams = inMemoryTeams.get(league.toLowerCase());
    if (!leagueTeams) return null;

    const upperAbbr = abbreviation.toUpperCase();
    for (const team of leagueTeams.values()) {
      if (team.abbreviation.toUpperCase() === upperAbbr) {
        return this.replaceLogoUrl(team);
      }
    }

    return null;
  }

  /**
   * Refresh teams for a specific league
   * Fetches from API and updates storage
   * @param league - League name
   */
  async refreshLeague(league: string): Promise<void> {
    logger.info({
      message: 'Refreshing teams for league',
      league,
    });

    try {
      const teams = await this.fetchTeamsFromAPI(league);
      await this.upsertTeams(teams, league);

      logger.info({
        message: 'League teams refreshed successfully',
        league,
        teamCount: teams.length,
      });
    } catch (error) {
      logger.error({
        message: 'Error refreshing league teams',
        league,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Refresh teams for all configured leagues
   */
  async refreshAllLeagues(): Promise<void> {
    const leagues = getAvailableLeagues();
    logger.info({
      message: 'Refreshing teams for all leagues',
      leagueCount: leagues.length,
    });

    const results = await Promise.allSettled(
      leagues.map(async (sport) => {
        const league = getLeagueForSport(sport);
        if (league) {
          await this.refreshLeague(league);
        }
      })
    );

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    logger.info({
      message: 'All leagues refresh completed',
      total: leagues.length,
      successful,
      failed,
    });
  }

  /**
   * Get teams by sport name (maps to league)
   * @param sport - Sport name (e.g., 'nfl', 'nba')
   * @returns Array of teams
   */
  async getTeamsBySport(sport: string): Promise<Team[]> {
    // Validate sport
    if (!sport || typeof sport !== 'string' || sport.trim() === '') {
      throw new ValidationError(
        ErrorCode.BAD_REQUEST,
        'Sport parameter is required and must be a non-empty string'
      );
    }

    const normalizedSport = sport.toLowerCase().trim();

    // Check if sport is valid
    if (!isValidLeague(normalizedSport)) {
      const availableLeagues = getAvailableLeagues().join(', ');
      throw new ValidationError(
        ErrorCode.BAD_REQUEST,
        `Invalid sport: ${sport}. Available sports: ${availableLeagues}`
      );
    }

    // Get league for sport
    const league = getLeagueForSport(normalizedSport);
    if (!league) {
      throw new ValidationError(
        ErrorCode.BAD_REQUEST,
        `No league found for sport: ${sport}`
      );
    }

    return this.getTeamsByLeague(league);
  }
}

// Export singleton instance
export const teamsService = new TeamsService();

