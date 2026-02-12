/**
 * Debug log ingest URL for Cursor/IDE debugging.
 * The ingest server (e.g. Cursor on port 7245) runs on the host.
 *
 * - When the app runs on the host: localhost:7245 works.
 * - When the app runs in Docker: localhost is the container, so use
 *   DEBUG_INGEST_URL=http://host.docker.internal:7245/ingest/<id>
 *   so requests reach the host where the ingest server listens.
 */

const DEFAULT_INGEST_ID = '60ddb764-e4c3-47f8-bbea-98f9add98263';

/** Fallback ingest URL (localhost) when DEBUG_INGEST_URL is unset or for dual-write backup. */
export const DEBUG_INGEST_FALLBACK_URL = `http://localhost:7245/ingest/${DEFAULT_INGEST_ID}`;

/** Base URL for the ingest server (host:port only). Defaults to localhost for local dev. */
const ingestBase =
  process.env.DEBUG_INGEST_URL ||
  DEBUG_INGEST_FALLBACK_URL;

/** Full URL to POST debug log payloads. Empty string disables ingest. */
export const DEBUG_INGEST_URL = ingestBase.trim() ? ingestBase : '';

function sendToIngest(url: string, payload: Record<string, unknown>): void {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

/** POST a debug log payload to the ingest server (no-op if DEBUG_INGEST_URL is unset). */
export function ingestDebugLog(payload: Record<string, unknown>): void {
  if (!DEBUG_INGEST_URL) return;
  sendToIngest(DEBUG_INGEST_URL, payload);
}

/** Send to both config URL and localhost fallback so logs arrive if either works (e.g. Docker vs host). */
export function ingestDebugLogWithBackup(payload: Record<string, unknown>): void {
  if (DEBUG_INGEST_URL) sendToIngest(DEBUG_INGEST_URL, payload);
  sendToIngest(DEBUG_INGEST_FALLBACK_URL, payload);
}
