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

/**
 * Fetch the opening price for a market from Polymarket's SSR endpoint.
 * Returns the Chainlink-sourced openPrice or null if unavailable.
 */
export async function fetchOpeningPrice(slug: string): Promise<number | null> {
  const buildId = await getBuildId();
  if (!buildId) return null;

  let price = await fetchFromSSR(slug, buildId);

  // If 404, build ID may be stale — refresh once and retry
  if (price === undefined) {
    const newId = await refreshBuildId();
    if (newId && newId !== buildId) {
      price = await fetchFromSSR(slug, newId);
    }
  }

  return price ?? null;
}

/**
 * Internal: fetch openPrice from SSR. Returns number, null (no price in response), or undefined (request failed/404).
 */
async function fetchFromSSR(slug: string, buildId: string): Promise<number | null | undefined> {
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
        if (priceData && typeof priceData.openPrice === 'number') {
          return priceData.openPrice;
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
      message: '[Opening Price] SSR fetch failed',
      slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
