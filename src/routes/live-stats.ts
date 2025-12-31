import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { getLiveGameById, getLiveGameBySlug } from '../services/polymarket/live-games.service';
import { transformToLiveStats } from '../services/polymarket/live-stats.transformer';
import { fetchAndStorePlayerStats, getPlayerStats, fetchPeriodScores } from '../services/balldontlie/balldontlie.service';

const router = Router();

/**
 * @swagger
 * /api/live-stats/{gameIdentifier}:
 *   get:
 *     summary: Get live stats for a game by ID or slug
 *     description: Returns team objects, period scores, and final score for a game. For games with period "NS" (not started), returns empty/null values for period scores and final score.
 *     tags: [LiveStats]
 *     parameters:
 *       - in: path
 *         name: gameIdentifier
 *         required: true
 *         schema:
 *           type: string
 *         description: Game ID or slug
 *     responses:
 *       200:
 *         description: Live stats for the game
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stats:
 *                   $ref: '#/components/schemas/LiveStats'
 *       404:
 *         description: Game not found
 *       500:
 *         description: Failed to fetch live stats
 */
router.get('/:gameIdentifier', async (req: Request, res: Response) => {
  try {
    const { gameIdentifier } = req.params;

    // Try to find game by ID first, then by slug
    let game = await getLiveGameById(gameIdentifier);
    if (!game) {
      game = await getLiveGameBySlug(gameIdentifier);
    }

    if (!game) {
      return res.status(404).json({
        success: false,
        error: 'Game not found',
      });
    }

    // Transform to live stats format
    const stats = await transformToLiveStats(game);

    // For NBA, NFL, CBB, and soccer games, fetch fresh period scores from Ball Don't Lie API
    // NBA/NFL: quarter-by-quarter scores
    // CBB (NCAAB): half-by-half scores
    // Soccer: 1H/2H scores derived from goals
    const sport = game.sport?.toLowerCase() || '';
    const supportedPeriodScoreSports = ['nba', 'nfl', 'cbb', 'ncaab', 'epl', 'lal', 'laliga', 'ser', 'seriea', 'bund', 'bundesliga', 'lig', 'ligue1'];
    if (supportedPeriodScoreSports.includes(sport)) {
      try {
        const periodScores = await fetchPeriodScores(game);
        if (periodScores) {
          // Convert to the expected PeriodScores format (index signature compatible)
          const convertedScores: Record<string, { home: number; away: number }> = {};
          for (const [key, value] of Object.entries(periodScores)) {
            if (value && typeof value === 'object' && 'home' in value && 'away' in value) {
              convertedScores[key] = {
                home: value.home ?? 0,
                away: value.away ?? 0,
              };
            }
          }
          stats.periodScores = convertedScores;
          logger.info({
            message: 'Updated period scores from Ball Don\'t Lie',
            gameId: game.id,
            sport,
            periodScores: convertedScores,
          });
        }
      } catch (error) {
        logger.warn({
          message: 'Failed to fetch period scores from Ball Don\'t Lie (non-blocking)',
          gameId: game.id,
          sport,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with existing period scores from database
      }
    }

    // Fetch player stats - always call fetchAndStorePlayerStats which handles caching
    // The fetchAndStorePlayerStats function checks if stats are stale (> 5 minutes old)
    // and refreshes them if needed. We should NOT bypass this by just checking if stats exist.
    try {
      logger.info({
        message: 'Fetching player stats for game',
        gameId: game.id,
        sport: game.sport,
      });
      
      // Use a longer timeout for European soccer leagues which require extra API calls
      // (rosters endpoint for player names/positions)
      const isSoccerLeague = ['epl', 'lal', 'laliga', 'ser', 'seriea', 'bund', 'bundesliga', 'lig', 'ligue1'].includes(game.sport?.toLowerCase() || '');
      const timeoutMs = isSoccerLeague ? 15000 : 8000; // 15 seconds for soccer, 8 for others
      
      // Always call fetchAndStorePlayerStats - it handles 5-minute caching internally
      // This ensures live game stats are refreshed when they become stale
      const statsPromise = fetchAndStorePlayerStats(game);
      const timeoutPromise = new Promise<any[]>((resolve) => 
        setTimeout(() => {
          logger.warn({
            message: 'Player stats fetch timed out',
            gameId: game.id,
            timeoutMs,
          });
          resolve([]);
        }, timeoutMs)
      );
      
      let playerStats = await Promise.race([statsPromise, timeoutPromise]);
      
      // If the fetch timed out but might have stored data, check database
      if (playerStats.length === 0) {
        // Wait a moment for any in-flight storage to complete
        await new Promise(resolve => setTimeout(resolve, 500));
        playerStats = await getPlayerStats(game.id);
        
        if (playerStats.length > 0) {
          logger.info({
            message: 'Found player stats in database after timeout',
            gameId: game.id,
            statsCount: playerStats.length,
          });
        }
      }
      
      logger.info({
        message: 'Player stats fetch completed',
        gameId: game.id,
        statsCount: playerStats.length,
      });
      
      if (playerStats.length > 0) {
        stats.playerStats = playerStats;
      } else {
        logger.warn({
          message: 'No player stats returned',
          gameId: game.id,
        });
      }
    } catch (error) {
      // Log error but don't fail the request
      logger.error({
        message: 'Failed to fetch player stats (non-blocking)',
        gameId: game.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching live stats',
      gameIdentifier: req.params.gameIdentifier,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch live stats',
      details: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.message : String(error)) : undefined,
    });
  }
});

export default router;
