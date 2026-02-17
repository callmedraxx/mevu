/**
 * Crypto Trading Data Service
 * Fetches trades/holders from Polymarket for crypto markets, caches in DB.
 * Uses cooldown-based fetching: first request fetches from Polymarket + stores,
 * subsequent requests within the cooldown window return DB data.
 */

import { pool, getDatabaseConfig } from '../../config/database';
import { logger } from '../../config/logger';

// Cooldown: don't re-fetch from Polymarket more than once per 30 seconds per market
const FETCH_COOLDOWN_MS = 30_000;

// Polymarket data API base URL
const POLYMARKET_DATA_API = 'https://data-api.polymarket.com';

// ─── Types ───

export interface CryptoTrade {
  id: number;
  side: 'Buy' | 'Sell';
  amount: number;
  shares: number;
  price: number;
  outcome: string;
  trader: string;
  time: string;
}

export interface CryptoHolder {
  id: string;
  rank: number;
  wallet: string;
  totalAmount: number;
  assets: { assetId: string; shortLabel: string; question?: string; amount: number }[];
}

export interface CryptoWhaleTrade extends CryptoTrade {
  type: 'buy' | 'sell';
  team: {
    homeTeam: { abbr: string; name: string; buyPrice: number; sellPrice: number };
    awayTeam: { abbr: string; name: string; buyPrice: number; sellPrice: number };
  };
  teamFor: 'home' | 'away' | null;
}

// ─── Helper: get conditionId and outcomes from crypto_markets ───

interface CryptoMarketMeta {
  id: string;
  conditionId: string;
  outcomes: string[];
  outcomePrices: string[];
  clobTokenIds: string[];
  question: string;
}

async function getCryptoMarketMeta(slug: string): Promise<CryptoMarketMeta | null> {
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return null;

  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT id, markets->0->>'conditionId' AS condition_id,
              markets->0->'outcomes' AS outcomes,
              markets->0->'outcomePrices' AS outcome_prices,
              markets->0->'clobTokenIds' AS clob_token_ids,
              markets->0->>'question' AS question
       FROM crypto_markets WHERE LOWER(slug) = $1 LIMIT 1`,
      [slug.toLowerCase()]
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      id: row.id,
      conditionId: row.condition_id || '',
      outcomes: Array.isArray(row.outcomes) ? row.outcomes : ['Up', 'Down'],
      outcomePrices: Array.isArray(row.outcome_prices) ? row.outcome_prices : [],
      clobTokenIds: Array.isArray(row.clob_token_ids) ? row.clob_token_ids : [],
      question: row.question || '',
    };
  } finally {
    client.release();
  }
}

// ─── Helper: check if we should re-fetch from Polymarket ───

async function shouldFetchFromPolymarket(
  client: any,
  cryptoMarketId: string,
  fetchType: 'trades' | 'holders'
): Promise<boolean> {
  const r = await client.query(
    `SELECT last_fetched_at FROM crypto_market_fetch_log
     WHERE crypto_market_id = $1 AND fetch_type = $2`,
    [cryptoMarketId, fetchType]
  );
  if (r.rows.length === 0) return true;
  const lastFetched = new Date(r.rows[0].last_fetched_at).getTime();
  return Date.now() - lastFetched > FETCH_COOLDOWN_MS;
}

async function markFetched(client: any, cryptoMarketId: string, fetchType: 'trades' | 'holders'): Promise<void> {
  await client.query(
    `INSERT INTO crypto_market_fetch_log (crypto_market_id, fetch_type, last_fetched_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (crypto_market_id, fetch_type)
     DO UPDATE SET last_fetched_at = NOW()`,
    [cryptoMarketId, fetchType]
  );
}

// ─── Polymarket API fetchers (no DB connection needed) ───

interface RawPolyTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  outcome: string;
  outcomeIndex: number;
  timestamp: number;
  transactionHash: string;
  conditionId: string;
  name?: string;
  pseudonym?: string;
  profileImage?: string;
}

async function fetchTradesFromPolymarket(conditionId: string): Promise<RawPolyTrade[]> {
  try {
    const url = `${POLYMARKET_DATA_API}/trades?market=${encodeURIComponent(conditionId)}&limit=500`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn({
      message: 'Failed to fetch crypto trades from Polymarket',
      conditionId: conditionId.slice(0, 16),
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

interface RawPolyHolderResponse {
  token: string;
  holders: {
    proxyWallet: string;
    asset: string;
    amount: number;
    outcomeIndex: number;
    name?: string;
    pseudonym?: string;
    profileImage?: string;
    verified?: boolean;
  }[];
}

async function fetchHoldersFromPolymarket(conditionId: string): Promise<RawPolyHolderResponse[]> {
  try {
    const url = `${POLYMARKET_DATA_API}/holders?market=${encodeURIComponent(conditionId)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.warn({
      message: 'Failed to fetch crypto holders from Polymarket',
      conditionId: conditionId.slice(0, 16),
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ─── Public: Get Trades ───

export async function getCryptoTrades(slug: string, limit: number = 100): Promise<{ trades: CryptoTrade[]; count: number } | null> {
  const meta = await getCryptoMarketMeta(slug);
  if (!meta || !meta.conditionId) return null;

  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return { trades: [], count: 0 };

  const client = await pool.connect();
  try {
    const needsFetch = await shouldFetchFromPolymarket(client, meta.id, 'trades');

    if (needsFetch) {
      // Fetch from Polymarket API (done before heavy DB ops)
      const rawTrades = await fetchTradesFromPolymarket(meta.conditionId);

      if (rawTrades.length > 0) {
        // Bulk upsert trades
        const values: any[] = [];
        const placeholders: string[] = [];
        let idx = 1;
        for (const t of rawTrades) {
          placeholders.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6}, $${idx+7}, $${idx+8}, $${idx+9}, $${idx+10})`);
          values.push(
            meta.id, meta.conditionId, t.proxyWallet || '', t.side,
            t.size, t.price, t.outcome || '', t.outcomeIndex ?? null,
            t.timestamp, t.transactionHash || '', t.name || null
          );
          idx += 11;
        }

        await client.query(
          `INSERT INTO crypto_trades (crypto_market_id, condition_id, proxy_wallet, side, size, price, outcome, outcome_index, timestamp, transaction_hash, name)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (transaction_hash) WHERE transaction_hash IS NOT NULL AND transaction_hash != '' DO NOTHING`,
          values
        );

        await markFetched(client, meta.id, 'trades');
      }
    }

    // Read from DB — let Postgres sort and limit
    const r = await client.query(
      `SELECT id, side, size, price, outcome, proxy_wallet, timestamp
       FROM crypto_trades
       WHERE crypto_market_id = $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [meta.id, limit]
    );

    const trades: CryptoTrade[] = r.rows.map((row: any) => ({
      id: row.id,
      side: row.side === 'BUY' ? 'Buy' as const : 'Sell' as const,
      amount: Number((row.size * row.price).toFixed(2)),
      shares: Number(row.size),
      price: Math.round(row.price * 100),
      outcome: row.outcome || '',
      trader: row.proxy_wallet || '',
      time: new Date(row.timestamp * 1000).toISOString(),
    }));

    return { trades, count: trades.length };
  } catch (err) {
    logger.error({
      message: 'Error in getCryptoTrades',
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return { trades: [], count: 0 };
  } finally {
    client.release();
  }
}

// ─── Public: Get Holders ───

export async function getCryptoHolders(slug: string): Promise<{ holders: CryptoHolder[]; count: number } | null> {
  const meta = await getCryptoMarketMeta(slug);
  if (!meta || !meta.conditionId) return null;

  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return { holders: [], count: 0 };

  // Build outcome label map: clobTokenId → label
  const tokenToLabel = new Map<string, string>();
  meta.clobTokenIds.forEach((tid, idx) => {
    tokenToLabel.set(tid, meta.outcomes[idx] || `Outcome ${idx}`);
  });

  const client = await pool.connect();
  try {
    const needsFetch = await shouldFetchFromPolymarket(client, meta.id, 'holders');

    if (needsFetch) {
      const rawHolders = await fetchHoldersFromPolymarket(meta.conditionId);

      if (rawHolders.length > 0) {
        // Flatten all holders from all token responses
        const allHolders: { token: string; h: any }[] = [];
        for (const resp of rawHolders) {
          for (const h of resp.holders || []) {
            allHolders.push({ token: resp.token, h });
          }
        }

        if (allHolders.length > 0) {
          // Clear old holders and insert fresh (simpler than complex upsert)
          await client.query('DELETE FROM crypto_holders WHERE crypto_market_id = $1', [meta.id]);

          const values: any[] = [];
          const placeholders: string[] = [];
          let idx = 1;
          for (const { token, h } of allHolders) {
            placeholders.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6}, $${idx+7}, $${idx+8}, $${idx+9})`);
            values.push(
              meta.id, meta.conditionId, token, h.proxyWallet || '',
              h.asset || '', h.amount || 0, h.outcomeIndex ?? null,
              h.name || null, h.pseudonym || null, h.verified || false
            );
            idx += 10;
          }

          await client.query(
            `INSERT INTO crypto_holders (crypto_market_id, condition_id, token, proxy_wallet, asset, amount, outcome_index, name, pseudonym, verified)
             VALUES ${placeholders.join(', ')}`,
            values
          );

          await markFetched(client, meta.id, 'holders');
        }
      }
    }

    // Read from DB — aggregate by wallet, let Postgres rank them
    const r = await client.query(
      `SELECT proxy_wallet, asset, amount, outcome_index
       FROM crypto_holders
       WHERE crypto_market_id = $1
       ORDER BY amount DESC`,
      [meta.id]
    );

    // Aggregate by wallet in application
    const walletMap = new Map<string, { totalAmount: number; assets: { assetId: string; shortLabel: string; question: string; amount: number }[] }>();
    for (const row of r.rows) {
      const wallet = row.proxy_wallet;
      if (!walletMap.has(wallet)) {
        walletMap.set(wallet, { totalAmount: 0, assets: [] });
      }
      const entry = walletMap.get(wallet)!;
      const amount = Number(row.amount);
      const dollarAmount = amount * (meta.outcomePrices[row.outcome_index] ? parseFloat(meta.outcomePrices[row.outcome_index]) : 0.5);
      entry.totalAmount += dollarAmount;
      const label = tokenToLabel.get(row.asset) || meta.outcomes[row.outcome_index] || 'Unknown';
      entry.assets.push({
        assetId: row.asset || '',
        shortLabel: label,
        question: meta.question,
        amount: dollarAmount,
      });
    }

    // Sort by total amount and rank
    const sorted = [...walletMap.entries()]
      .sort(([, a], [, b]) => b.totalAmount - a.totalAmount)
      .slice(0, 50);

    const holders: CryptoHolder[] = sorted.map(([wallet, data], idx) => ({
      id: `${meta.id}-${wallet.slice(0, 8)}`,
      rank: idx + 1,
      wallet,
      totalAmount: Number(data.totalAmount.toFixed(2)),
      assets: data.assets,
    }));

    return { holders, count: holders.length };
  } catch (err) {
    logger.error({
      message: 'Error in getCryptoHolders',
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return { holders: [], count: 0 };
  } finally {
    client.release();
  }
}

// ─── Public: Get Whale Trades (trades >= $1000) ───

export async function getCryptoWhales(slug: string, limit: number = 100): Promise<{ trades: CryptoTrade[]; count: number } | null> {
  const meta = await getCryptoMarketMeta(slug);
  if (!meta || !meta.conditionId) return null;

  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return { trades: [], count: 0 };

  const client = await pool.connect();
  try {
    // Ensure trades are fresh (reuse the trades fetch cooldown)
    const needsFetch = await shouldFetchFromPolymarket(client, meta.id, 'trades');
    if (needsFetch) {
      // Trigger a trade fetch to populate data
      client.release();
      await getCryptoTrades(slug, 500);
      // Re-acquire for whale query
      const client2 = await pool.connect();
      try {
        const r = await client2.query(
          `SELECT id, side, size, price, outcome, proxy_wallet, timestamp
           FROM crypto_trades
           WHERE crypto_market_id = $1 AND (size * price) >= 1000
           ORDER BY timestamp DESC
           LIMIT $2`,
          [meta.id, limit]
        );

        const trades: CryptoTrade[] = r.rows.map((row: any) => ({
          id: row.id,
          side: row.side === 'BUY' ? 'Buy' as const : 'Sell' as const,
          amount: Number((row.size * row.price).toFixed(2)),
          shares: Number(row.size),
          price: Math.round(row.price * 100),
          outcome: row.outcome || '',
          trader: row.proxy_wallet || '',
          time: new Date(row.timestamp * 1000).toISOString(),
        }));

        return { trades, count: trades.length };
      } finally {
        client2.release();
      }
    }

    // Read whale trades from DB
    const r = await client.query(
      `SELECT id, side, size, price, outcome, proxy_wallet, timestamp
       FROM crypto_trades
       WHERE crypto_market_id = $1 AND (size * price) >= 1000
       ORDER BY timestamp DESC
       LIMIT $2`,
      [meta.id, limit]
    );

    const trades: CryptoTrade[] = r.rows.map((row: any) => ({
      id: row.id,
      side: row.side === 'BUY' ? 'Buy' as const : 'Sell' as const,
      amount: Number((row.size * row.price).toFixed(2)),
      shares: Number(row.size),
      price: Math.round(row.price * 100),
      outcome: row.outcome || '',
      trader: row.proxy_wallet || '',
      time: new Date(row.timestamp * 1000).toISOString(),
    }));

    return { trades, count: trades.length };
  } catch (err) {
    logger.error({
      message: 'Error in getCryptoWhales',
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return { trades: [], count: 0 };
  } finally {
    // client may already be released if needsFetch was true
    try { client.release(); } catch {}
  }
}
