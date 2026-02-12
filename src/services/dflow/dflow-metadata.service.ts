/**
 * DFlow Metadata Service
 * Maps Kalshi tickers to DFlow SPL outcome token mints
 */

import axios, { AxiosInstance } from 'axios';
import { pool, getDatabaseConfig } from '../../config/database';
import { logger } from '../../config/logger';
import { getCache, setCache } from '../../utils/cache';

const DFLOW_METADATA_API_URL =
  process.env.DFLOW_METADATA_API_URL || 'https://dev-prediction-markets-api.dflow.net';
const REDIS_TICKER_PREFIX = 'dflow:ticker_to_mint:';
const CACHE_TTL = 3600;

export interface DFlowMarketMapping {
  kalshiTicker: string;
  yesMint: string;
  noMint: string;
  settlementMint: string;
  marketLedger?: string;
}

class DFlowMetadataService {
  private client: AxiosInstance;
  private enabled: boolean;

  constructor() {
    this.client = axios.create({
      baseURL: DFLOW_METADATA_API_URL,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });
    this.enabled = !!process.env.DFLOW_API_KEY;
  }

  async getOutcomeMint(
    kalshiTicker: string,
    outcome: 'YES' | 'NO'
  ): Promise<string | null> {
    const mapping = await this.getMapping(kalshiTicker);
    if (!mapping) return null;
    return outcome === 'YES' ? mapping.yesMint : mapping.noMint;
  }

  async getMapping(kalshiTicker: string): Promise<DFlowMarketMapping | null> {
    const cacheKey = `${REDIS_TICKER_PREFIX}${kalshiTicker}`;
    const cached = await getCache(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as DFlowMarketMapping;
      } catch {
        // ignore
      }
    }

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
      const mapping: DFlowMarketMapping = {
        kalshiTicker: row.kalshi_ticker,
        yesMint: row.yes_mint,
        noMint: row.no_mint,
        settlementMint: row.settlement_mint,
        marketLedger: row.market_ledger,
      };
      await setCache(cacheKey, JSON.stringify(mapping), CACHE_TTL);
      return mapping;
    } finally {
      client.release();
    }
  }

  async upsertMapping(mapping: DFlowMarketMapping): Promise<void> {
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

  async syncMarkets(): Promise<number> {
    if (!this.enabled) return 0;
    try {
      const response = await this.client.get<{ markets?: Array<{
        ticker?: string;
        yesMint?: string;
        noMint?: string;
        settlementMint?: string;
        marketLedger?: string;
      }> }>('/api/v1/markets');
      const markets = response.data?.markets ?? [];
      let count = 0;
      for (const m of markets) {
        if (m.ticker && m.yesMint && m.noMint && m.settlementMint) {
          await this.upsertMapping({
            kalshiTicker: m.ticker,
            yesMint: m.yesMint,
            noMint: m.noMint,
            settlementMint: m.settlementMint,
            marketLedger: m.marketLedger,
          });
          count++;
        }
      }
      logger.info({ message: 'DFlow metadata synced', count, total: markets.length });
      return count;
    } catch (error) {
      logger.error({
        message: 'DFlow metadata sync failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export const dflowMetadataService = new DFlowMetadataService();
