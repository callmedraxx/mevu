/**
 * Series Summary Service
 * Fetches sports game series summaries from Polymarket Gamma API
 */

import { logger } from '../../config/logger';
import { polymarketClient } from './polymarket.client';
import { getSeriesIdForSport, isValidSport, getAvailableSports } from './sports-games.config';
import { ValidationError, PolymarketError, ErrorCode } from '../../utils/errors';

/**
 * Series Summary Response from Polymarket API
 */
export interface SeriesSummary {
  id: string;
  title: string;
  slug: string;
  eventDates: string[];
  eventWeeks: number[];
  earliest_open_week?: number;
  earliest_open_date?: string;
}

/**
 * Series Summary Service
 */
export class SeriesSummaryService {
  /**
   * Fetch series summary for a given series ID
   * @param seriesId - Series ID number (e.g., '10187')
   * @returns Series summary response
   */
  async getSeriesSummary(seriesId: string): Promise<SeriesSummary> {
    // Validate seriesId
    if (!seriesId || typeof seriesId !== 'string' || seriesId.trim() === '') {
      throw new ValidationError(
        ErrorCode.BAD_REQUEST,
        'Series ID is required and must be a non-empty string'
      );
    }

    const normalizedSeriesId = seriesId.trim();

    logger.info({
      message: 'Fetching series summary',
      seriesId: normalizedSeriesId,
    });

    try {
      // Fetch from API
      const response = await polymarketClient.get<SeriesSummary>(
        `/series-summary/${normalizedSeriesId}`
      );

      logger.info({
        message: 'Series summary fetched successfully',
        seriesId: normalizedSeriesId,
        title: response.title,
        eventDatesCount: response.eventDates?.length || 0,
        eventWeeksCount: response.eventWeeks?.length || 0,
      });

      return response;
    } catch (error) {
      logger.error({
        message: 'Error fetching series summary',
        seriesId: normalizedSeriesId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Re-throw validation errors
      if (error instanceof ValidationError) {
        throw error;
      }

      // Convert other errors to PolymarketError
      if (error instanceof PolymarketError) {
        throw error;
      }

      // Wrap unknown errors
      throw new PolymarketError(
        ErrorCode.POLYMARKET_FETCH_FAILED,
        `Failed to fetch series summary for series ${normalizedSeriesId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Fetch series summary for a given sport name
   * Uses the config to map sport name to series ID
   * @param sport - Sport category name (e.g., 'nfl', 'nba')
   * @returns Series summary response
   */
  async getSeriesSummaryBySport(sport: string): Promise<SeriesSummary> {
    // Validate sport
    if (!sport || typeof sport !== 'string' || sport.trim() === '') {
      throw new ValidationError(
        ErrorCode.BAD_REQUEST,
        'Sport parameter is required and must be a non-empty string'
      );
    }

    const normalizedSport = sport.toLowerCase().trim();

    // Check if sport is valid
    if (!isValidSport(normalizedSport)) {
      const availableSports = getAvailableSports().join(', ');
      throw new ValidationError(
        ErrorCode.BAD_REQUEST,
        `Invalid sport: ${sport}. Available sports: ${availableSports}`
      );
    }

    // Get series_id for sport
    const seriesId = getSeriesIdForSport(normalizedSport);
    if (!seriesId) {
      throw new ValidationError(
        ErrorCode.BAD_REQUEST,
        `No series ID found for sport: ${sport}. The sport may not have a series configured yet.`
      );
    }

    logger.info({
      message: 'Fetching series summary by sport',
      sport: normalizedSport,
      seriesId,
    });

    // Fetch using series ID
    return this.getSeriesSummary(seriesId);
  }
}

// Export singleton instance
export const seriesSummaryService = new SeriesSummaryService();

