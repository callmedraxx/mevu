/**
 * Live Stats Transformer
 * Transforms LiveGame data into LiveStats format for the live stats widget
 */

import { logger } from '../../config/logger';
import { LiveGame } from './live-games.service';
import { transformToFrontendGame } from './frontend-game.transformer';
import { LiveStats, FinalScore } from './live-stats.types';

/**
 * Parse score string (e.g., "0-2") into individual scores
 * Polymarket format: "away-home" (first number is AWAY team score, second is HOME team score)
 */
function parseScore(scoreStr: string | undefined): FinalScore | null {
  if (!scoreStr) return null;
  
  const parts = scoreStr.split('-').map(s => parseInt(s.trim(), 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    // Format is away-home: first number is away, second is home
    return { away: parts[0], home: parts[1] };
  }
  return null;
}

/**
 * Transform a LiveGame to LiveStats format
 * @param game - The LiveGame to transform
 */
export async function transformToLiveStats(game: LiveGame): Promise<LiveStats> {
  try {
    // Get team objects using existing transformer
    const frontendGame = await transformToFrontendGame(game);
    
    // Check if game has started (period !== "NS")
    const isNotStarted = !game.period || game.period === 'NS';
    
    // Extract period scores
    let periodScores = null;
    if (!isNotStarted && game.periodScores) {
      periodScores = game.periodScores;
    }
    
    // Extract final score
    let finalScore: FinalScore | null = null;
    if (!isNotStarted && game.score) {
      finalScore = parseScore(game.score);
    }
    
    return {
      homeTeam: frontendGame.homeTeam,
      awayTeam: frontendGame.awayTeam,
      periodScores,
      finalScore,
      currentPeriod: game.period || 'NS',
      isLive: game.live || false,
    };
  } catch (error) {
    logger.error({
      message: 'Error transforming game to live stats format',
      gameId: game.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    
    // Return minimal structure on error
    return {
      homeTeam: {
        abbr: 'HME',
        name: 'Home Team',
        record: '0-0',
        probability: 50,
        buyPrice: 50,
        sellPrice: 50,
      },
      awayTeam: {
        abbr: 'AWY',
        name: 'Away Team',
        record: '0-0',
        probability: 50,
        buyPrice: 50,
        sellPrice: 50,
      },
      periodScores: null,
      finalScore: null,
      currentPeriod: game.period || 'NS',
      isLive: false,
    };
  }
}
