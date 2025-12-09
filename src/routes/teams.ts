/**
 * Teams Routes
 * Endpoints for team data and logo management
 */

import { Router, Request, Response } from 'express';
import { teamsService } from '../services/polymarket/teams.service';
import { getAvailableLeagues } from '../services/polymarket/teams.config';
import { logger } from '../config/logger';

const router = Router();

/**
 * @swagger
 * /api/teams:
 *   get:
 *     summary: Get teams by league
 *     description: Returns all teams for a specific league
 *     tags: [Teams]
 *     parameters:
 *       - in: query
 *         name: league
 *         required: true
 *         schema:
 *           type: string
 *         description: League name (e.g., nba, nfl, mlb, nhl)
 *     responses:
 *       200:
 *         description: List of teams
 *       400:
 *         description: Invalid or missing league parameter
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { league } = req.query;
    
    if (!league || typeof league !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'League parameter is required',
        availableLeagues: getAvailableLeagues(),
      });
    }
    
    const teams = await teamsService.getTeamsByLeague(league.toLowerCase());
    
    res.json({
      success: true,
      league: league.toLowerCase(),
      count: teams.length,
      teams,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching teams',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch teams',
    });
  }
});

/**
 * @swagger
 * /api/teams/refresh:
 *   post:
 *     summary: Refresh teams data from API
 *     description: Fetches fresh team data from Polymarket and downloads ESPN logos
 *     tags: [Teams]
 *     parameters:
 *       - in: query
 *         name: league
 *         schema:
 *           type: string
 *         description: Specific league to refresh (optional, refreshes all if not provided)
 *     responses:
 *       200:
 *         description: Refresh completed
 */
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { league } = req.query;
    
    if (league && typeof league === 'string') {
      // Refresh specific league
      logger.info({ message: 'Refreshing teams for league', league });
      
      const teams = await teamsService.fetchTeamsFromAPI(league.toLowerCase());
      await teamsService.upsertTeams(teams, league.toLowerCase());
      
      res.json({
        success: true,
        message: `Successfully refreshed ${teams.length} teams for ${league}`,
        count: teams.length,
      });
    } else {
      // Refresh all leagues
      const leagues = getAvailableLeagues();
      const results: Record<string, number> = {};
      
      logger.info({ message: 'Refreshing teams for all leagues', leagues });
      
      for (const leagueName of leagues) {
        try {
          const teams = await teamsService.fetchTeamsFromAPI(leagueName);
          await teamsService.upsertTeams(teams, leagueName);
          results[leagueName] = teams.length;
        } catch (error) {
          logger.error({
            message: 'Error refreshing teams for league',
            league: leagueName,
            error: error instanceof Error ? error.message : String(error),
          });
          results[leagueName] = 0;
        }
      }
      
      res.json({
        success: true,
        message: 'Teams refresh completed',
        results,
      });
    }
  } catch (error) {
    logger.error({
      message: 'Error refreshing teams',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to refresh teams',
    });
  }
});

/**
 * @swagger
 * /api/teams/leagues:
 *   get:
 *     summary: Get available leagues
 *     tags: [Teams]
 *     responses:
 *       200:
 *         description: List of available leagues
 */
router.get('/leagues', (req: Request, res: Response) => {
  const leagues = getAvailableLeagues();
  
  res.json({
    success: true,
    leagues,
  });
});

/**
 * @swagger
 * /api/teams/{league}/{abbreviation}:
 *   get:
 *     summary: Get a specific team by league and abbreviation
 *     tags: [Teams]
 *     parameters:
 *       - in: path
 *         name: league
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: abbreviation
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Team details
 *       404:
 *         description: Team not found
 */
router.get('/:league/:abbreviation', async (req: Request, res: Response) => {
  try {
    const { league, abbreviation } = req.params;
    const team = await teamsService.getTeamByAbbreviation(league.toLowerCase(), abbreviation.toUpperCase());
    
    if (!team) {
      return res.status(404).json({
        success: false,
        error: 'Team not found',
      });
    }
    
    res.json({
      success: true,
      team,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching team',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch team',
    });
  }
});

export default router;

