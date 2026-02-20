/**
 * Crypto Opening Price Service
 * Fetches opening prices on-demand from Polymarket's SSR endpoint.
 * Uses the same Chainlink data source that Polymarket's frontend displays.
 */

import axios from 'axios';
import { logger } from '../../config/logger';
import { extractBuildIdFromHtml } from '../polymarket/live-games.service';

let currentBuildId: string | null = null;
let buildIdFetchedAt = 0;
const BUILD_ID_MAX_AGE_MS = 5 * 60 * 1000; // Refresh build ID at most every 5 minutes

/**
 * Fetch and cache the Polymarket Next.js build ID from their homepage.
 */
async function refreshBuildId(): Promise<string | null> {
  try {
    const response = await axios.get<string>('https://polymarket.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      timeout: 15000,
      responseType: 'text',
    });

    const buildId = extractBuildIdFromHtml(response.data);
    if (buildId) {
      currentBuildId = buildId;
      buildIdFetchedAt = Date.now();
      return buildId;
    }
    return null;
  } catch {
    return null;
  }
}

async function getBuildId(): Promise<string | null> {
  if (currentBuildId && (Date.now() - buildIdFetchedAt) < BUILD_ID_MAX_AGE_MS) {
    return currentBuildId;
  }
  return refreshBuildId();
}

/** Shape of the crypto-prices data from Polymarket SSR. */
export interface SSRPriceData {
  openPrice: number | null;
  closePrice: number | null;
}

/**
 * Fetch the opening price for a market from Polymarket's SSR endpoint.
 * Returns the Chainlink-sourced openPrice or null if unavailable.
 */
export async function fetchOpeningPrice(slug: string): Promise<number | null> {
  const data = await fetchPriceData(slug);
  return data?.openPrice ?? null;
}

/**
 * Fetch the closing price for a market from Polymarket's SSR endpoint.
 * Returns the Chainlink-sourced closePrice / endPrice or null if unavailable.
 */
export async function fetchClosingPrice(slug: string): Promise<number | null> {
  const data = await fetchPriceData(slug);
  return data?.closePrice ?? null;
}

/**
 * Fetch all available price data (open + close) from Polymarket SSR.
 */
export async function fetchPriceData(slug: string): Promise<SSRPriceData | null> {
  const buildId = await getBuildId();
  if (!buildId) return null;

  let result = await fetchFromSSR(slug, buildId);

  // If 404, build ID may be stale — refresh once and retry
  if (result === undefined) {
    const newId = await refreshBuildId();
    if (newId && newId !== buildId) {
      result = await fetchFromSSR(slug, newId);
    }
  }

  return result ?? null;
}

/**
 * Internal: fetch price data from SSR.
 * Returns SSRPriceData, null (no price in response), or undefined (request failed/404).
 */
async function fetchFromSSR(slug: string, buildId: string): Promise<SSRPriceData | null | undefined> {
  try {
    const url = `https://polymarket.com/_next/data/${buildId}/en/event/${slug}.json`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      },
      timeout: 15000,
    });

    const queries = response.data?.pageProps?.dehydratedState?.queries;
    if (!Array.isArray(queries)) return null;

    for (const q of queries) {
      const key = q?.queryKey;
      if (Array.isArray(key) && key[0] === 'crypto-prices' && key[1] === 'price') {
        const priceData = q?.state?.data;
        if (priceData) {
          const openPrice = typeof priceData.openPrice === 'number' ? priceData.openPrice : null;
          // Polymarket uses closePrice or endPrice for settled markets
          const closePrice = typeof priceData.closePrice === 'number' ? priceData.closePrice
            : typeof priceData.endPrice === 'number' ? priceData.endPrice
            : typeof priceData.currentPrice === 'number' ? priceData.currentPrice
            : null;

          if (openPrice != null || closePrice != null) {
            // Log discovered fields for diagnostics (helps identify correct field names)
            logger.debug({
              message: '[SSR Price] Extracted price data',
              slug,
              availableKeys: Object.keys(priceData),
              openPrice,
              closePrice,
            });
            return { openPrice, closePrice };
          }
        }
      }
    }

    // crypto-prices query not present (e.g., future market) — no price available
    return null;
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return undefined; // signal to caller to refresh build ID
    }
    logger.warn({
      message: '[SSR Price] Fetch failed',
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
