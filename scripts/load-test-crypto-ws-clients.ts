/**
 * Load test: Connect many WebSocket clients to /ws/crypto and subscribe to the same market.
 * Use to observe CLOB shard connection behavior when many clients subscribe simultaneously.
 *
 * Usage:
 *   CLIENT_COUNT=50 BASE_URL=http://localhost:3000 tsx scripts/load-test-crypto-ws-clients.ts
 *
 * Watch app logs for "Crypto WS: client subscribed" and "CLOB shard X closed".
 */

import WebSocket from 'ws';
import axios from 'axios';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const CLIENT_COUNT = Number(process.env.CLIENT_COUNT || '50');
const HOLD_SECONDS = Number(process.env.HOLD_SECONDS || '60');

const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws/crypto';

interface CryptoMarket {
  slug: string;
  outcomes: { label: string; clobTokenId?: string }[];
}

async function fetchCryptoMarket(): Promise<{ slug: string; upClobTokenId: string; downClobTokenId: string }> {
  const res = await axios.get(`${BASE_URL}/api/crypto-markets`, {
    params: { page: 1, limit: 50, timeframe: '5m' },
    timeout: 10000,
  });
  const markets: CryptoMarket[] = res.data?.markets ?? res.data?.data ?? [];
  for (const m of markets) {
    const outcomes = m.outcomes ?? [];
    const upIdx = outcomes.findIndex((o) => o.label?.toLowerCase() === 'up');
    const downIdx = outcomes.findIndex((o) => o.label?.toLowerCase() === 'down');
    const upToken = upIdx >= 0 ? outcomes[upIdx]?.clobTokenId : outcomes[0]?.clobTokenId;
    const downToken = downIdx >= 0 ? outcomes[downIdx]?.clobTokenId : outcomes[1]?.clobTokenId;
    if (upToken) {
      return {
        slug: m.slug,
        upClobTokenId: upToken,
        downClobTokenId: downToken || '',
      };
    }
  }
  throw new Error('No crypto market with Up/Down outcomes found');
}

function connectClient(
  id: number,
  market: { slug: string; upClobTokenId: string; downClobTokenId: string },
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          slug: market.slug,
          upClobTokenId: market.upClobTokenId,
          downClobTokenId: market.downClobTokenId,
        }),
      );
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribed') {
          resolve(ws);
        }
      } catch {
        // ignore
      }
    });
    ws.on('error', (err) => reject(err));
    ws.on('close', () => {});
  });
}

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('CRYPTO WS CLIENT LOAD TEST');
  console.log('='.repeat(60));
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`WebSocket: ${WS_URL}`);
  console.log(`Client count: ${CLIENT_COUNT}`);
  console.log(`Hold time: ${HOLD_SECONDS}s`);
  console.log('');

  console.log('Fetching crypto market...');
  const market = await fetchCryptoMarket();
  console.log(`Market: ${market.slug}`);
  console.log(`  upClobTokenId: ${market.upClobTokenId.substring(0, 24)}...`);
  console.log(`  downClobTokenId: ${market.downClobTokenId ? market.downClobTokenId.substring(0, 24) + '...' : '(none)'}`);
  console.log('');

  console.log(`Connecting ${CLIENT_COUNT} clients simultaneously...`);
  const start = Date.now();
  const connectPromises = Array.from({ length: CLIENT_COUNT }, (_, i) =>
    connectClient(i + 1, market).catch((err) => {
      console.error(`[client ${i + 1}] Failed: ${err.message}`);
      return null;
    }),
  );
  const sockets = (await Promise.all(connectPromises)).filter((ws): ws is WebSocket => ws != null);
  const elapsed = Date.now() - start;
  console.log(`Connected ${sockets.length}/${CLIENT_COUNT} clients in ${elapsed}ms`);
  console.log('');
  console.log(`Holding connections for ${HOLD_SECONDS}s — watch app logs for CLOB shard activity...`);
  console.log('');

  await new Promise((r) => setTimeout(r, HOLD_SECONDS * 1000));

  console.log('Closing connections...');
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});
