/**
 * Connect to the games WebSocket (same as frontend) and log incoming messages.
 * Use to verify kalshi_price_update and other events are actually received.
 *
 * Usage:
 *   WS_URL=ws://localhost:3000/ws/games npx tsx scripts/ws-games-client-test.ts
 *   WS_URL=wss://dev.api.mevu.com/ws/games npx tsx scripts/ws-games-client-test.ts
 */

import WebSocket from 'ws';

const WS_URL = process.env.WS_URL || 'ws://localhost:3000/ws/games';
const RUN_MS = Number(process.env.RUN_MS) || 90_000;

const counts: Record<string, number> = {};
let kalshiReceived = 0;

function log(type: string, data: unknown) {
  counts[type] = (counts[type] || 0) + 1;
  if (type === 'kalshi_price_update') {
    kalshiReceived++;
    const d = data as { updatedSides?: string[]; gameId?: string };
    const hasUpdatedSides = Array.isArray(d?.updatedSides) && d.updatedSides.length > 0;
    console.log(`\n[${new Date().toISOString()}] kalshi_price_update #${kalshiReceived} gameId=${d?.gameId} updatedSides=${hasUpdatedSides ? JSON.stringify(d.updatedSides) : 'MISSING'}`);
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`[${new Date().toISOString()}] ${type}`, type === 'heartbeat' ? '' : JSON.stringify(data).slice(0, 200));
  }
}

function main() {
  console.log('Connecting to', WS_URL, '... (will run for', RUN_MS / 1000, 's)\n');
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('Connected.\n');
  });

  ws.on('message', (raw: Buffer) => {
    try {
      const data = JSON.parse(raw.toString());
      const type = data?.type ?? 'unknown';
      log(type, data);
    } catch {
      console.log('[raw]', raw.toString().slice(0, 200));
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });

  ws.on('close', (code, reason) => {
    console.log('\nClosed:', code, reason?.toString());
    console.log('\nMessage counts:', counts);
    console.log('Total kalshi_price_update received:', kalshiReceived);
    process.exit(0);
  });

  setTimeout(() => {
    console.log('\n--- Time limit reached ---');
    console.log('Message counts:', counts);
    console.log('Total kalshi_price_update received:', kalshiReceived);
    ws.close();
  }, RUN_MS);
}

main();
