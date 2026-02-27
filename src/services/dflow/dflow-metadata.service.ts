/**
 * DFlow Metadata Service
 * Maps Kalshi tickers to DFlow SPL outcome token mints.
 *
 * On-demand: when a user tries to trade a Kalshi market, we look up its
 * mints via GET /api/v1/market/{ticker} (direct ticker lookup).
 * Kalshi tickers map 1:1 to DFlow market IDs. Results are cached in Redis + Postgres
 * so subsequent trades for the same ticker are instant.
 */

import axios, { AxiosInstance } from 'axios';
import { pool, getDatabaseConfig } from '../../config/database';
import { logger } from '../../config/logger';
import { getCache, setCache } from '../../utils/cache';
import { SOLANA_USDC_MINT } from './dflow-order-validation';

/** Market returned by DFlow POST /api/v1/markets/batch */
export interface DFlowMarketBatchItem {
  ticker?: string;
  title?: string;
  status?: string;
  result?: string;
  accounts?: Record<string, DFlowAccountInfo>;
}

/** Account info for a settlement mint (e.g. USDC) */
export interface DFlowAccountInfo {
  yesMint?: string;
  noMint?: string;
  marketLedger?: string;
  isInitialized?: boolean;
  redemptionStatus?: 'open' | 'closed' | string;
  scalarOutcomePct?: number;
}

const DFLOW_METADATA_API_URL =
  process.env.DFLOW_METADATA_API_URL || 'https://d.prediction-markets-api.dflow.net';
const REDIS_TICKER_PREFIX = 'dflow:ticker_to_mint:';
const CACHE_TTL = 3600;

/** Redis key for caching "not found on DFlow" to avoid repeated API scans */
const NOT_FOUND_PREFIX = 'dflow:not_found:';
const NOT_FOUND_TTL = 300; // 5 min — re-check after this

export interface DFlowMarketMapping {
  kalshiTicker: string;
  yesMint: string;
  noMint: string;
  settlementMint: string;
  marketLedger?: string;
}

type AccountInfo = { marketLedger?: string; yesMint?: string; noMint?: string; isInitialized?: boolean; redemptionStatus?: string };

class DFlowMetadataService {
  private client: AxiosInstance;
  private enabled: boolean;

  constructor() {
    const apiKey = process.env.DFLOW_API_KEY || '';
    this.client = axios.create({
      baseURL: DFLOW_METADATA_API_URL,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { 'x-api-key': apiKey }),
      },
    });
    this.enabled = !!apiKey;
  }

  async getOutcomeMint(
    kalshiTicker: string,
    outcome: 'YES' | 'NO'
  ): Promise<string | null> {
    const mapping = await this.getMapping(kalshiTicker);
    if (!mapping) return null;
    return outcome === 'YES' ? mapping.yesMint : mapping.noMint;
  }

  /**
   * Get the DFlow mapping for a Kalshi ticker.
   * Lookup order: Redis cache → Postgres DB → DFlow API (on-demand).
   * If found on DFlow, persists to DB + Redis for future lookups.
   */
  async getMapping(kalshiTicker: string): Promise<DFlowMarketMapping | null> {
    // 1. Redis cache hit
    const cacheKey = `${REDIS_TICKER_PREFIX}${kalshiTicker}`;
    const cached = await getCache(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as DFlowMarketMapping;
      } catch {
        // ignore corrupt cache
      }
    }

    // 2. Postgres DB hit
    const dbMapping = await this.getMappingFromDb(kalshiTicker);
    if (dbMapping) {
      await setCache(cacheKey, JSON.stringify(dbMapping), CACHE_TTL);
      return dbMapping;
    }

    // 3. On-demand: search DFlow API
    if (!this.enabled) return null;

    // Short-circuit if we recently confirmed this ticker doesn't exist on DFlow
    const notFoundKey = `${NOT_FOUND_PREFIX}${kalshiTicker}`;
    const recentlyNotFound = await getCache(notFoundKey);
    if (recentlyNotFound) return null;

    const mapping = await this.fetchMappingFromApi(kalshiTicker);
    if (mapping) {
      // Persist to DB + Redis
      await this.upsertMapping(mapping);
      await setCache(cacheKey, JSON.stringify(mapping), CACHE_TTL);
      return mapping;
    }

    // Cache the miss to avoid re-scanning the API on every request
    await setCache(notFoundKey, '1', NOT_FOUND_TTL);
    return null;
  }

  /**
   * Fetch market mapping from DFlow metadata API by ticker.
   * Uses direct lookup: GET /api/v1/market/{ticker}
   * Kalshi tickers map directly to DFlow market IDs.
   */
  private async fetchMappingFromApi(kalshiTicker: string): Promise<DFlowMarketMapping | null> {
    try {
      const response = await this.client.get<{
        ticker?: string;
        status?: string;
        accounts?: Record<string, AccountInfo>;
      }>(`/api/v1/market/${encodeURIComponent(kalshiTicker)}`);

      const usdcAccount = response.data?.accounts?.[SOLANA_USDC_MINT];
      if (usdcAccount?.yesMint && usdcAccount?.noMint) {
        logger.info({
          message: 'DFlow mapping found by ticker',
          kalshiTicker,
          isInitialized: usdcAccount.isInitialized,
        });
        return {
          kalshiTicker,
          yesMint: usdcAccount.yesMint,
          noMint: usdcAccount.noMint,
          settlementMint: SOLANA_USDC_MINT,
          marketLedger: usdcAccount.marketLedger,
        };
      }

      // No USDC account or missing yes/no mints
      logger.info({
        message: 'DFlow ticker found but no USDC yes/no mints',
        kalshiTicker,
        status: response.data?.status,
      });
      return null;
    } catch (error: unknown) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (status === 400 || status === 404 || code === 'not_found') {
        logger.info({
          message: 'DFlow ticker not found',
          kalshiTicker,
        });
        return null;
      }
      logger.error({
        message: 'DFlow ticker lookup failed',
        kalshiTicker,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async getMappingFromDb(kalshiTicker: string): Promise<DFlowMarketMapping | null> {
    const dbConfig = getDatabaseConfig();
    if (dbConfig.type !== 'postgres') return null;

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT kalshi_ticker, yes_mint, no_mint, settlement_mint, market_ledger
         FROM dflow_market_mappings WHERE kalshi_ticker = $1 AND status = 'active'`,
        [kalshiTicker]
      );
      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return {
        kalshiTicker: row.kalshi_ticker,
        yesMint: row.yes_mint,
        noMint: row.no_mint,
        settlementMint: row.settlement_mint,
        marketLedger: row.market_ledger,
      };
    } finally {
      client.release();
    }
  }

  private async upsertMapping(mapping: DFlowMarketMapping): Promise<void> {
    const dbConfig = getDatabaseConfig();
    if (dbConfig.type !== 'postgres') return;

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO dflow_market_mappings (kalshi_ticker, yes_mint, no_mint, settlement_mint, market_ledger, status, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, 'active', NOW())
         ON CONFLICT (kalshi_ticker) DO UPDATE SET
           yes_mint = EXCLUDED.yes_mint,
           no_mint = EXCLUDED.no_mint,
           settlement_mint = EXCLUDED.settlement_mint,
           market_ledger = EXCLUDED.market_ledger,
           last_synced_at = NOW()`,
        [
          mapping.kalshiTicker,
          mapping.yesMint,
          mapping.noMint,
          mapping.settlementMint,
          mapping.marketLedger ?? null,
        ]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Filter wallet mint addresses down to prediction market outcome mints.
   * POST /api/v1/filter_outcome_mints — max 200 addresses.
   */
  async filterOutcomeMints(addresses: string[]): Promise<string[]> {
    if (addresses.length === 0) return [];
    if (addresses.length > 200) {
      logger.warn({ message: 'filterOutcomeMints: truncating to 200 addresses', count: addresses.length });
      addresses = addresses.slice(0, 200);
    }
    if (!this.enabled) return [];

    try {
      const response = await this.client.post<{ outcomeMints?: string[] }>(
        '/api/v1/filter_outcome_mints',
        { addresses }
      );
      return response.data?.outcomeMints ?? [];
    } catch (error) {
      logger.error({
        message: 'DFlow filterOutcomeMints failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Fetch full market details by outcome mint.
   * GET /api/v1/market/by-mint/{mint} — returns status, result, redemptionStatus for redemption checks.
   */
  async getMarketByMint(outcomeMint: string): Promise<{
    status?: string;
    result?: string;
    redemptionStatus?: string;
    ticker?: string;
    title?: string;
    accounts?: Record<string, DFlowAccountInfo>;
  } | null> {
    if (!this.enabled) return null;
    try {
      const response = await this.client.get<{
        status?: string;
        result?: string;
        ticker?: string;
        title?: string;
        settlementMint?: string;
        accounts?: Record<string, DFlowAccountInfo>;
      }>(`/api/v1/market/by-mint/${outcomeMint}`);

      const data = response.data;
      if (!data) return null;

      const settlementMint = data.settlementMint ?? SOLANA_USDC_MINT;
      const usdcAccount = data.accounts?.[settlementMint] ?? data.accounts?.[SOLANA_USDC_MINT];

      return {
        status: data.status,
        result: data.result,
        redemptionStatus: usdcAccount?.redemptionStatus,
        ticker: data.ticker,
        title: data.title,
        accounts: data.accounts,
      };
    } catch (error) {
      if ((error as any)?.response?.status === 404) return null;
      logger.warn({
        message: 'DFlow getMarketByMint failed',
        outcomeMint,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Check if an outcome mint is redeemable (market determined/finalized, redemption open, user holds winning outcome).
   */
  async isOutcomeRedeemable(outcomeMint: string): Promise<boolean> {
    const market = await this.getMarketByMint(outcomeMint);
    if (!market) return false;
    if (market.status !== 'determined' && market.status !== 'finalized') return false;
    if (market.redemptionStatus !== 'open') return false;

    const usdcAccount = market.accounts?.[SOLANA_USDC_MINT];
    if (!usdcAccount) return false;

    const result = (market.result ?? '').toLowerCase();
    if (result === 'yes' && usdcAccount.yesMint === outcomeMint) return true;
    if (result === 'no' && usdcAccount.noMint === outcomeMint) return true;
    if (result === '' && usdcAccount.scalarOutcomePct != null) return true; // Scalar: both redeemable

    return false;
  }

  /**
   * Fetch market metadata for outcome mints.
   * POST /api/v1/markets/batch — returns markets with ticker, title, accounts (yesMint, noMint).
   */
  async getMarketsBatch(mints: string[]): Promise<DFlowMarketBatchItem[]> {
    if (mints.length === 0) return [];
    if (!this.enabled) return [];

    try {
      const response = await this.client.post<{ markets?: DFlowMarketBatchItem[] }>(
        '/api/v1/markets/batch',
        { mints }
      );
      return response.data?.markets ?? [];
    } catch (error) {
      logger.error({
        message: 'DFlow getMarketsBatch failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Returns tickers that have been cached in the DB (from past on-demand lookups). */
  async listCachedTickers(): Promise<string[]> {
    const dbConfig = getDatabaseConfig();
    if (dbConfig.type !== 'postgres') return [];
    const client = await pool.connect();
    try {
      const r = await client.query<{ kalshi_ticker: string }>(
        `SELECT kalshi_ticker FROM dflow_market_mappings WHERE status = 'active' ORDER BY kalshi_ticker`
      );
      return r.rows.map((row) => row.kalshi_ticker);
    } finally {
      client.release();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export const dflowMetadataService = new DFlowMetadataService();
