/**
 * Crypto Opening/Closing Price Cron Service
 * Proactively fetches and stores opening/closing prices for short-term crypto markets.
 *
 * - Ended markets: fetch closing_price (and opening_price if missing) immediately when they end
 * - New markets: fetch opening_price just after they start
 *
 * Runs every 1 minute so 5m/15m windows are picked up quickly.
 */

import { pool } from '../../config/database';
import { logger } from '../../config/logger';
import { fetchPriceData } from './crypto-opening-price.service';

const RUN_INTERVAL_MS = 60 * 1000; // 1 minute
const RECENTLY_STARTED_WINDOW_MS = 5 * 60 * 1000; // Consider "just started" if within 5 min of start_time
const ENDED_GRACE_MS = 2 * 60 * 1000; // Consider ended if end_date was at least 2 min ago (let Polymarket settle)
const MAX_PER_RUN = 20; // Limit fetches per run to avoid rate limits
const DELAY_BETWEEN_FETCHES_MS = 500; // Throttle Polymarket SSR requests

let cronTimer: ReturnType<typeof setInterval> | null = null;

async function runCron(): Promise<void> {
  if (!process.env.DATABASE_URL) return;

  const client = await pool.connect();
  try {
    const now = new Date();
    const nowMs = now.getTime();
    const endedCutoff = new Date(nowMs - ENDED_GRACE_MS);
    const startedCutoff = new Date(nowMs - RECENTLY_STARTED_WINDOW_MS);

    // 1. Ended markets without closing_price (or opening_price) — fetch both, store
    const endedRes = await client.query(
      `SELECT id, slug FROM crypto_markets
       WHERE end_date <= $1
         AND (closing_price IS NULL OR opening_price IS NULL)
         AND active = true
       ORDER BY end_date DESC
       LIMIT $2`,
      [endedCutoff, MAX_PER_RUN]
    );

    // 2. Markets that recently started without opening_price (next window in series)
    const startedRes = await client.query(
      `SELECT id, slug FROM crypto_markets
       WHERE start_time IS NOT NULL
         AND start_time <= $1
         AND start_time >= $2
         AND end_date > $1
         AND opening_price IS NULL
         AND active = true
       ORDER BY start_time DESC
       LIMIT $3`,
      [now, startedCutoff, MAX_PER_RUN]
    );

    const toProcess = new Map<string, { id: string; slug: string }>();
    for (const row of endedRes.rows) {
      toProcess.set(row.slug, { id: row.id, slug: row.slug });
    }
    for (const row of startedRes.rows) {
      if (!toProcess.has(row.slug)) {
        toProcess.set(row.slug, { id: row.id, slug: row.slug });
      }
    }

    const entries = Array.from(toProcess.values()).slice(0, MAX_PER_RUN);
    if (entries.length === 0) return;

    let updated = 0;
    for (const { id, slug } of entries) {
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_FETCHES_MS));
      try {
        const data = await fetchPriceData(slug);
        if (!data) continue;

        const updates: string[] = [];
        const values: unknown[] = [];
        let idx = 1;

        if (data.openPrice != null) {
          updates.push(`opening_price = $${idx++}`);
          values.push(data.openPrice);
        }
        if (data.closePrice != null) {
          updates.push(`closing_price = $${idx++}`);
          values.push(data.closePrice);
        }

        if (updates.length === 0) continue;

        values.push(id);
        await client.query(
          `UPDATE crypto_markets SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${idx}`,
          values
        );
        updated++;
        // logger.info({
        //   message: '[Crypto price cron] Stored prices',
        //   slug,
        //   opening: data.openPrice ?? '(unchanged)',
        //   closing: data.closePrice ?? '(unchanged)',
        // });
      } catch (err) {
        logger.warn({
          message: '[Crypto price cron] Fetch failed',
          slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // if (updated > 0) {
    //   logger.info({ message: '[Crypto price cron] Run complete', updated, total: entries.length });
    // }
  } catch (err) {
    logger.error({
      message: '[Crypto price cron] Error',
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    client.release();
  }
}

/**
 * Start the cron. Runs every 1 minute.
 * Call from sports worker initialization.
 */
export function startCryptoOpeningPriceCron(): void {
  if (cronTimer) return;
  logger.info({ message: '[Crypto price cron] Starting (every 1 min)' });
  runCron(); // Run immediately
  cronTimer = setInterval(runCron, RUN_INTERVAL_MS);
}

/**
 * Stop the cron.
 */
export function stopCryptoOpeningPriceCron(): void {
  if (cronTimer) {
    clearInterval(cronTimer);
    cronTimer = null;
    logger.info({ message: '[Crypto price cron] Stopped' });
  }
}
