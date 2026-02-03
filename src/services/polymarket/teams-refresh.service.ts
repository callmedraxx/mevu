/**
 * Teams Refresh Service
 * Refreshes team data and UFC fighter records when live games or sports games refresh.
 * Event-driven: runs on registerOnGamesRefreshed callback, not on a fixed interval.
 */

import { logger } from '../../config/logger';
import { teamsService } from './teams.service';
import { getAllLiveGamesFromCache, registerOnGamesRefreshed } from './live-games.service';
import { getUfcFighterNamesFromGame } from './frontend-game.transformer';
import {
  prefetchAndPersistFighterRecords,
  loadFromDatabase as loadUfcFighterRecords,
} from '../ufc/ufc-fighter-records.service';

/**
 * Teams Refresh Service
 */
export class TeamsRefreshService {
  private unregister: (() => void) | null = null;
  private isRunning: boolean = false;

  /**
   * Start the teams refresh service.
   * Registers for games-refresh callback; runs on every live/sports games refresh.
   */
  start(): void {
    if (this.isRunning) {
      logger.warn({ message: 'Teams refresh service already running' });
      return;
    }

    this.isRunning = true;
    logger.info({ message: 'Starting teams refresh service (event-driven)' });

    // Load UFC fighter records from DB into cache
    loadUfcFighterRecords().catch((err) => {
      logger.warn({
        message: 'UFC fighter records load failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Delay initial teams refresh to prevent connection pool exhaustion during startup
    setTimeout(() => {
      this.refreshAll().catch((err) =>
        logger.error({
          message: 'Initial teams refresh failed',
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }, 3000);

    // Run on every live/sports games refresh
    this.unregister = registerOnGamesRefreshed(() => {
      this.refreshAll().catch((err) =>
        logger.error({
          message: 'Teams refresh (on games refreshed) failed',
          error: err instanceof Error ? err.message : String(err),
        })
      );
    });
  }

  /**
   * Stop the teams refresh service
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.unregister) {
      this.unregister();
      this.unregister = null;
    }
    logger.info({ message: 'Stopping teams refresh service' });
  }

  /**
   * Refresh teams and UFC fighter records.
   * UFC games are pulled from gamesCache (not DB).
   */
  private async refreshAll(): Promise<void> {
    try {
      await teamsService.refreshAllLeagues();
    } catch (error) {
      logger.error({
        message: 'Error during teams refresh',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // UFC fighter records: pull from cache, fetch from API, bulk persist
    const allGames = await getAllLiveGamesFromCache();
    const ufcGames = allGames.filter(
      (g) =>
        (g.sport && g.sport.toLowerCase() === 'ufc') ||
        (g.league && g.league.toLowerCase() === 'ufc')
    );

    if (ufcGames.length > 0) {
      const names: string[] = [];
      for (const game of ufcGames) {
        const n = getUfcFighterNamesFromGame(game);
        if (n) {
          names.push(n.away, n.home);
        }
      }
      if (names.length > 0) {
        prefetchAndPersistFighterRecords(names);
      }
    }
  }

  /**
   * Manually trigger a refresh
   */
  async triggerRefresh(): Promise<void> {
    logger.info({ message: 'Manual teams refresh triggered' });
    await this.refreshAll();
  }

  isActive(): boolean {
    return this.isRunning;
  }
}

export const teamsRefreshService = new TeamsRefreshService();
