/**
 * Teams Refresh Service
 * Background service that periodically refreshes team data for all leagues
 */

import { logger } from '../../config/logger';
import { teamsService } from './teams.service';

const TEAMS_REFRESH_INTERVAL = parseInt(
  process.env.TEAMS_REFRESH_INTERVAL_SECONDS || '3600',
  10
); // Default: 1 hour

/**
 * Teams Refresh Service
 */
export class TeamsRefreshService {
  private interval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  /**
   * Start the teams refresh service
   */
  start(): void {
    if (this.isRunning) {
      logger.warn({
        message: 'Teams refresh service already running',
      });
      return;
    }

    this.isRunning = true;
    logger.info({
      message: 'Starting teams refresh service',
      intervalSeconds: TEAMS_REFRESH_INTERVAL,
    });

    // Delay initial refresh to prevent connection pool exhaustion during startup
    // Wait 3 seconds to allow other services to initialize first
    setTimeout(() => {
      this.refreshAllTeams();
    }, 3000);

    // Then refresh at interval
    this.interval = setInterval(() => {
      this.refreshAllTeams();
    }, TEAMS_REFRESH_INTERVAL * 1000);
  }

  /**
   * Stop the teams refresh service
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    logger.info({
      message: 'Stopping teams refresh service',
    });

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Refresh all teams for all leagues
   */
  private async refreshAllTeams(): Promise<void> {
    logger.info({
      message: 'Starting teams refresh for all leagues',
    });

    try {
      await teamsService.refreshAllLeagues();
      logger.info({
        message: 'Teams refresh completed successfully',
      });
    } catch (error) {
      logger.error({
        message: 'Error during teams refresh',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Manually trigger a refresh (useful for testing or manual updates)
   */
  async triggerRefresh(): Promise<void> {
    logger.info({
      message: 'Manual teams refresh triggered',
    });
    await this.refreshAllTeams();
  }

  /**
   * Check if the service is running
   */
  isActive(): boolean {
    return this.isRunning;
  }
}

// Export singleton instance
export const teamsRefreshService = new TeamsRefreshService();

