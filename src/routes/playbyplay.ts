/**
 * Play-by-Play Routes
 * Endpoints for fetching live play-by-play data from Ball Don't Lie API
 * 
 * @swagger
 * components:
 *   schemas:
 *     NormalizedPlay:
 *       type: object
 *       description: A single play event for US sports (NBA, NFL, NHL, NCAAF, NCAAB)
 *       properties:
 *         order:
 *           type: integer
 *           description: Sequential order of the play
 *           example: 1
 *         type:
 *           type: string
 *           description: Type of play (e.g., "Jump Shot", "Dunk", "Foul", "Turnover")
 *           example: "Jump Shot"
 *         text:
 *           type: string
 *           description: Human-readable description of the play
 *           example: "LeBron James makes 26-foot three point jumper"
 *         homeScore:
 *           type: integer
 *           description: Home team score after this play
 *           example: 24
 *         awayScore:
 *           type: integer
 *           description: Away team score after this play
 *           example: 21
 *         period:
 *           type: integer
 *           description: Period number (1-4 for regulation, 5+ for OT)
 *           example: 1
 *         periodDisplay:
 *           type: string
 *           description: Human-readable period (e.g., "1st Quarter", "OT1")
 *           example: "1st Quarter"
 *         clock:
 *           type: string
 *           description: Game clock at time of play
 *           example: "5:32"
 *         scoringPlay:
 *           type: boolean
 *           description: Whether this is a scoring play
 *           example: true
 *         teamId:
 *           type: integer
 *           description: Team ID that made the play
 *           example: 14
 *         teamName:
 *           type: string
 *           description: Team name
 *           example: "Los Angeles Lakers"
 *         teamAbbreviation:
 *           type: string
 *           description: Team abbreviation
 *           example: "LAL"
 *         coordinateX:
 *           type: number
 *           nullable: true
 *           description: X coordinate on court/field (if available)
 *         coordinateY:
 *           type: number
 *           nullable: true
 *           description: Y coordinate on court/field (if available)
 *         timestamp:
 *           type: string
 *           format: date-time
 *           description: Real-world timestamp of the play
 *     NormalizedEvent:
 *       type: object
 *       description: A match event for soccer (EPL, La Liga, Serie A, Bundesliga, Ligue 1)
 *       properties:
 *         id:
 *           type: integer
 *           description: Event ID
 *           example: 12345
 *         eventType:
 *           type: string
 *           description: Type of event (goal, yellow_card, red_card, substitution, etc.)
 *           example: "goal"
 *         eventTime:
 *           type: integer
 *           nullable: true
 *           description: Time in minutes when the event occurred
 *           example: 45
 *         period:
 *           type: integer
 *           nullable: true
 *           description: Period/half when event occurred (1 or 2)
 *           example: 1
 *         teamId:
 *           type: integer
 *           nullable: true
 *           description: Team ID
 *         teamName:
 *           type: string
 *           description: Team name
 *           example: "Manchester United"
 *         playerName:
 *           type: string
 *           description: Primary player involved
 *           example: "Marcus Rashford"
 *         secondaryPlayerName:
 *           type: string
 *           description: Secondary player (assister, substitute coming in, etc.)
 *           example: "Bruno Fernandes"
 *         goalType:
 *           type: string
 *           nullable: true
 *           description: Type of goal (penalty, own_goal, etc.)
 *         cardType:
 *           type: string
 *           nullable: true
 *           description: Type of card if applicable
 *         description:
 *           type: string
 *           description: Formatted description of the event
 *           example: "45' ⚽ GOAL! Marcus Rashford - Assist: Bruno Fernandes"
 *     PlayByPlayResponse:
 *       type: object
 *       properties:
 *         success:
 *           type: boolean
 *           example: true
 *         sport:
 *           type: string
 *           description: Normalized sport name
 *           example: "nba"
 *         gameId:
 *           type: integer
 *           description: Ball Don't Lie game ID
 *           example: 12345
 *         dataType:
 *           type: string
 *           enum: [plays, events]
 *           description: Type of data returned (plays for US sports, events for soccer)
 *           example: "plays"
 *         data:
 *           type: array
 *           description: Array of plays or events
 *           items:
 *             oneOf:
 *               - $ref: '#/components/schemas/NormalizedPlay'
 *               - $ref: '#/components/schemas/NormalizedEvent'
 *         meta:
 *           type: object
 *           properties:
 *             totalPlays:
 *               type: integer
 *               description: Total number of plays/events
 *               example: 156
 *             lastUpdated:
 *               type: string
 *               format: date-time
 *               description: When data was fetched
 *         error:
 *           type: string
 *           description: Error message if request failed
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import {
  getPlayByPlay,
  getSupportedSports,
  supportsPlayByPlay,
  getPlayByPlayType,
} from '../services/balldontlie/playbyplay.service';
import { getLiveGameById, getLiveGameBySlug } from '../services/polymarket/live-games.service';
import { findAndMapBalldontlieGameId } from '../services/balldontlie/balldontlie.service';

const router = Router();

/**
 * Helper function to get Ball Don't Lie game ID from game identifier
 * Looks up the game by ID or slug, then gets/maps the Ball Don't Lie game ID
 */
async function getBalldontlieGameIdFromIdentifier(gameIdentifier: string): Promise<{ balldontlieGameId: number; game: any } | null> {
  // Try to find game by ID first, then by slug
  let game = await getLiveGameById(gameIdentifier);
  if (!game) {
    game = await getLiveGameBySlug(gameIdentifier);
  }

  if (!game) {
    return null;
  }

  // Get Ball Don't Lie game ID (map if needed)
  let balldontlieGameId = (game as any).balldontlie_game_id;
  if (!balldontlieGameId) {
    balldontlieGameId = await findAndMapBalldontlieGameId(game);
    if (!balldontlieGameId) {
      return null;
    }
  }

  return { balldontlieGameId, game };
}

/**
 * @swagger
 * /api/playbyplay/sports:
 *   get:
 *     summary: Get supported sports for play-by-play
 *     description: Returns which sports support play-by-play data and what type of data they provide
 *     tags: [PlayByPlay]
 *     responses:
 *       200:
 *         description: List of supported sports
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 sports:
 *                   type: object
 *                   properties:
 *                     plays:
 *                       type: array
 *                       items:
 *                         type: string
 *                       description: Sports with play-by-play data
 *                       example: ["nba", "nfl", "nhl", "ncaaf", "ncaab", "wnba"]
 *                     events:
 *                       type: array
 *                       items:
 *                         type: string
 *                       description: Soccer leagues with match events
 *                       example: ["epl", "laliga", "seriea", "bundesliga", "ligue1"]
 *                     unsupported:
 *                       type: array
 *                       items:
 *                         type: string
 *                       description: Sports without play-by-play support
 *                       example: ["mlb"]
 */
router.get('/sports', (req: Request, res: Response) => {
  const sports = getSupportedSports();
  
  return res.status(200).json({
    success: true,
    sports,
  });
});

/**
 * @swagger
 * /api/playbyplay/{sport}/{gameIdentifier}:
 *   get:
 *     summary: Get play-by-play data for a game
 *     description: |
 *       Fetches live play-by-play data directly from Ball Don't Lie API.
 *       
 *       **US Sports (NBA, NFL, NHL, NCAAF, NCAAB):** Returns detailed play-by-play data including
 *       shot attempts, turnovers, fouls, scoring plays with game clock and period info.
 *       
 *       **Soccer (EPL, La Liga, Serie A, Bundesliga, Ligue 1):** Returns match events including
 *       goals, cards, substitutions with timestamps.
 *       
 *       **Note:** MLB is not supported (no play-by-play endpoint in Ball Don't Lie API).
 *       
 *       Data is fetched in real-time and not cached. For live games, call this endpoint
 *       periodically to get the latest plays.
 *       
 *       The endpoint accepts your internal game ID or slug, and automatically maps it to the
 *       corresponding Ball Don't Lie game ID.
 *     tags: [PlayByPlay]
 *     parameters:
 *       - in: path
 *         name: sport
 *         required: true
 *         schema:
 *           type: string
 *           enum: [nba, nfl, nhl, ncaaf, ncaab, cfb, cbb, epl, laliga, seriea, bundesliga, ligue1]
 *         description: |
 *           Sport name. Aliases supported:
 *           - cfb → ncaaf (College Football)
 *           - cbb → ncaab (College Basketball)
 *           - lal → laliga
 *           - ser → seriea
 *           - bund → bundesliga
 *           - lig → ligue1
 *         example: nba
 *       - in: path
 *         name: gameIdentifier
 *         required: true
 *         schema:
 *           type: string
 *         description: Internal game ID or slug (will be mapped to Ball Don't Lie game ID)
 *         example: "evt_abc123"
 *     responses:
 *       200:
 *         description: Play-by-play data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlayByPlayResponse'
 *             examples:
 *               nba:
 *                 summary: NBA play-by-play example
 *                 value:
 *                   success: true
 *                   sport: nba
 *                   gameId: 12345
 *                   dataType: plays
 *                   data:
 *                     - order: 1
 *                       type: "Jump Ball"
 *                       text: "Jump Ball Anthony Davis vs. Giannis Antetokounmpo"
 *                       homeScore: 0
 *                       awayScore: 0
 *                       period: 1
 *                       periodDisplay: "1st Quarter"
 *                       clock: "12:00"
 *                       scoringPlay: false
 *                       teamName: "Los Angeles Lakers"
 *                       teamAbbreviation: "LAL"
 *                     - order: 2
 *                       type: "3PT Made"
 *                       text: "LeBron James makes 26-foot three point jumper"
 *                       homeScore: 3
 *                       awayScore: 0
 *                       period: 1
 *                       periodDisplay: "1st Quarter"
 *                       clock: "11:45"
 *                       scoringPlay: true
 *                       teamName: "Los Angeles Lakers"
 *                       teamAbbreviation: "LAL"
 *                   meta:
 *                     totalPlays: 156
 *                     lastUpdated: "2025-12-31T18:30:00.000Z"
 *               soccer:
 *                 summary: Soccer match events example
 *                 value:
 *                   success: true
 *                   sport: epl
 *                   gameId: 67890
 *                   dataType: events
 *                   data:
 *                     - id: 1
 *                       eventType: "goal"
 *                       eventTime: 23
 *                       period: 1
 *                       playerName: "Marcus Rashford"
 *                       secondaryPlayerName: "Bruno Fernandes"
 *                       description: "23' ⚽ GOAL! Marcus Rashford - Assist: Bruno Fernandes"
 *                     - id: 2
 *                       eventType: "yellow_card"
 *                       eventTime: 34
 *                       period: 1
 *                       playerName: "Casemiro"
 *                       description: "34' 🟨 Yellow Card - Casemiro"
 *                   meta:
 *                     totalPlays: 8
 *                     lastUpdated: "2025-12-31T18:30:00.000Z"
 *       400:
 *         description: Invalid sport or game ID
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Sport 'mlb' does not support play-by-play data"
 *       500:
 *         description: Internal server error
 */
router.get('/:sport/:gameIdentifier', async (req: Request, res: Response) => {
  try {
    const { sport, gameIdentifier } = req.params;

    // Check if sport is supported
    if (!supportsPlayByPlay(sport)) {
      const supported = getSupportedSports();
      return res.status(400).json({
        success: false,
        error: `Sport '${sport}' does not support play-by-play data.`,
        supportedSports: {
          plays: supported.plays,
          events: supported.events,
        },
        unsupported: supported.unsupported,
      });
    }

    // Get Ball Don't Lie game ID from game identifier
    const mapping = await getBalldontlieGameIdFromIdentifier(gameIdentifier);
    if (!mapping) {
      return res.status(404).json({
        success: false,
        error: 'Game not found or could not map to Ball Don\'t Lie game ID',
      });
    }

    const { balldontlieGameId, game } = mapping;

    // Verify sport matches
    const gameSport = game.sport?.toLowerCase();
    if (gameSport && gameSport !== sport.toLowerCase()) {
      logger.warn({
        message: 'Sport mismatch in play-by-play request',
        requestedSport: sport,
        gameSport,
        gameId: game.id,
      });
    }

    logger.info({
      message: 'Play-by-play request received',
      sport,
      gameIdentifier,
      internalGameId: game.id,
      balldontlieGameId,
      dataType: getPlayByPlayType(sport),
    });

    const result = await getPlayByPlay(sport, balldontlieGameId);

    if (!result.success) {
      return res.status(400).json(result);
    }

    return res.status(200).json(result);
  } catch (error) {
    logger.error({
      message: 'Error in play-by-play endpoint',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * @swagger
 * /api/playbyplay/{sport}/{gameIdentifier}/scoring:
 *   get:
 *     summary: Get only scoring plays for a game
 *     description: |
 *       Returns only scoring plays/goal events for a game. Useful for showing key moments.
 *       For US sports, filters plays where scoringPlay=true.
 *       For soccer, filters events where eventType='goal'.
 *       
 *       The endpoint accepts your internal game ID or slug, and automatically maps it to the
 *       corresponding Ball Don't Lie game ID.
 *     tags: [PlayByPlay]
 *     parameters:
 *       - in: path
 *         name: sport
 *         required: true
 *         schema:
 *           type: string
 *         description: Sport name
 *         example: nba
 *       - in: path
 *         name: gameIdentifier
 *         required: true
 *         schema:
 *           type: string
 *         description: Internal game ID or slug (will be mapped to Ball Don't Lie game ID)
 *         example: "evt_abc123"
 *     responses:
 *       200:
 *         description: Scoring plays retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlayByPlayResponse'
 *       400:
 *         description: Invalid sport or game ID
 *       500:
 *         description: Internal server error
 */
router.get('/:sport/:gameIdentifier/scoring', async (req: Request, res: Response) => {
  try {
    const { sport, gameIdentifier } = req.params;

    if (!supportsPlayByPlay(sport)) {
      return res.status(400).json({
        success: false,
        error: `Sport '${sport}' does not support play-by-play data.`,
      });
    }

    // Get Ball Don't Lie game ID from game identifier
    const mapping = await getBalldontlieGameIdFromIdentifier(gameIdentifier);
    if (!mapping) {
      return res.status(404).json({
        success: false,
        error: 'Game not found or could not map to Ball Don\'t Lie game ID',
      });
    }

    const { balldontlieGameId } = mapping;

    const result = await getPlayByPlay(sport, balldontlieGameId);

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Filter to scoring plays only
    let scoringData: any[];
    
    if (result.dataType === 'plays') {
      scoringData = (result.data as any[]).filter(play => play.scoringPlay === true);
    } else {
      // For soccer, filter to goals only
      scoringData = (result.data as any[]).filter(event => 
        event.eventType === 'goal' || 
        event.eventType === 'penalty' || 
        event.eventType === 'own_goal'
      );
    }

    return res.status(200).json({
      ...result,
      data: scoringData,
      meta: {
        ...result.meta,
        totalPlays: scoringData.length,
        filterApplied: 'scoring_only',
      },
    });
  } catch (error) {
    logger.error({
      message: 'Error in scoring plays endpoint',
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

/**
 * @swagger
 * /api/playbyplay/{sport}/{gameIdentifier}/recent:
 *   get:
 *     summary: Get most recent plays for a game
 *     description: |
 *       Returns the most recent N plays/events for a game. Useful for live updates.
 *       Default limit is 10, max is 50.
 *       
 *       The endpoint accepts your internal game ID or slug, and automatically maps it to the
 *       corresponding Ball Don't Lie game ID.
 *     tags: [PlayByPlay]
 *     parameters:
 *       - in: path
 *         name: sport
 *         required: true
 *         schema:
 *           type: string
 *         description: Sport name
 *         example: nba
 *       - in: path
 *         name: gameIdentifier
 *         required: true
 *         schema:
 *           type: string
 *         description: Internal game ID or slug (will be mapped to Ball Don't Lie game ID)
 *         example: "evt_abc123"
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *           minimum: 1
 *           maximum: 50
 *         description: Number of recent plays to return
 *     responses:
 *       200:
 *         description: Recent plays retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PlayByPlayResponse'
 *       400:
 *         description: Invalid sport or game ID
 *       500:
 *         description: Internal server error
 */
router.get('/:sport/:gameIdentifier/recent', async (req: Request, res: Response) => {
  try {
    const { sport, gameIdentifier } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 10, 1), 50);

    if (!supportsPlayByPlay(sport)) {
      return res.status(400).json({
        success: false,
        error: `Sport '${sport}' does not support play-by-play data.`,
      });
    }

    // Get Ball Don't Lie game ID from game identifier
    const mapping = await getBalldontlieGameIdFromIdentifier(gameIdentifier);
    if (!mapping) {
      return res.status(404).json({
        success: false,
        error: 'Game not found or could not map to Ball Don\'t Lie game ID',
      });
    }

    const { balldontlieGameId } = mapping;

    const result = await getPlayByPlay(sport, balldontlieGameId);

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Get most recent plays (last N items)
    const recentData = (result.data as any[]).slice(-limit);

    return res.status(200).json({
      ...result,
      data: recentData,
      meta: {
        ...result.meta,
        totalPlays: recentData.length,
        filterApplied: `recent_${limit}`,
      },
    });
  } catch (error) {
    logger.error({
      message: 'Error in recent plays endpoint',
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

export default router;
