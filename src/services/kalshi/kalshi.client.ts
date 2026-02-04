/**
 * Kalshi API Client
 * Lightweight HTTP client for fetching market data from Kalshi
 * Uses unauthenticated endpoints only (markets/events are public)
 */

import axios from 'axios';
import { logger } from '../../config/logger';
import { KalshiMarketsResponse } from './kalshi.types';

const KALSHI_BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const REQUEST_TIMEOUT = 30000; // 30 seconds

export interface FetchMarketsParams {
  seriesTicker?: string;
  status?: string;
  minCloseTs?: number;
  limit?: number;
  cursor?: string;
}

/**
 * Fetch markets from Kalshi API
 * @param params - Query parameters for filtering markets
 * @returns Markets response with pagination cursor
 */
export async function fetchKalshiMarkets(params: FetchMarketsParams): Promise<KalshiMarketsResponse> {
  const url = new URL(`${KALSHI_BASE_URL}/markets`);

  if (params.seriesTicker) {
    url.searchParams.set('series_ticker', params.seriesTicker);
  }
  if (params.status) {
    url.searchParams.set('status', params.status);
  }
  if (params.minCloseTs) {
    url.searchParams.set('min_close_ts', params.minCloseTs.toString());
  }
  url.searchParams.set('limit', (params.limit || 200).toString());
  if (params.cursor) {
    url.searchParams.set('cursor', params.cursor);
  }

  try {
    const response = await axios.get<KalshiMarketsResponse>(url.toString(), {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'mevu-backend/1.0',
      },
    });

    return {
      markets: response.data.markets || [],
      cursor: response.data.cursor || null,
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      logger.error({
        message: 'Kalshi API request failed',
        url: url.toString(),
        status: error.response?.status,
        statusText: error.response?.statusText,
        error: error.message,
      });
    } else {
      logger.error({
        message: 'Kalshi API request failed with unknown error',
        url: url.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

/**
 * Fetch all pages of markets for a given series ticker
 * @param seriesTicker - Kalshi series ticker (e.g., "KXNBA")
 * @param minCloseTs - Minimum close timestamp (Unix seconds)
 * @returns All markets for the series
 */
export async function fetchAllMarketsForSeries(
  seriesTicker: string,
  minCloseTs: number
): Promise<KalshiMarketsResponse['markets']> {
  const allMarkets: KalshiMarketsResponse['markets'] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  const maxPages = 10; // Safety limit

  do {
    const response = await fetchKalshiMarkets({
      seriesTicker,
      status: 'open',
      minCloseTs,
      limit: 200,
      cursor: cursor || undefined,
    });

    allMarkets.push(...response.markets);
    cursor = response.cursor;
    pageCount++;

    if (pageCount >= maxPages) {
      logger.warn({
        message: 'Kalshi fetch hit max page limit',
        seriesTicker,
        pages: pageCount,
        totalMarkets: allMarkets.length,
      });
      break;
    }
  } while (cursor);

  return allMarkets;
}
