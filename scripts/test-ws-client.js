#!/usr/bin/env node
/**
 * Test WebSocket connections like the frontend:
 * - wss://dev.api.mevu.com/ws/crypto (price updates)
 * - wss://dev.api.mevu.com/ws/orderbook (orderbook updates)
 *
 * Usage:
 *   node scripts/test-ws-client.js
 *   node scripts/test-ws-client.js btc-updown-15m-1771407900
 *
 * Pass a slug (e.g. btc-updown-15m-1771407900) to test a specific active market.
 */

const https = require('https');
const http = require('http');
const WebSocket = require('ws');

const API_BASE = process.env.API_BASE || 'https://dev.api.mevu.com';
const USE_HTTPS = API_BASE.startsWith('https');
const fetchMod = USE_HTTPS ? https : http;

async function fetchCryptoMarketBySlug(slug) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}/api/crypto-markets/detail/${slug}`;
    fetchMod.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const m = json.market;
          if (!m) return reject(new Error('Market not found'));
          const markets = m.markets || [];
          const sub = markets[0];
          const clobIds = sub?.clobTokenIds || [];
          const outcomes = sub?.outcomes || ['Up', 'Down'];
          const upIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'up');
          const downIdx = outcomes.findIndex((o) => String(o).toLowerCase() === 'down');
          const upClobTokenId = upIdx >= 0 ? clobIds[upIdx] : clobIds[0];
          const downClobTokenId = downIdx >= 0 ? clobIds[downIdx] : clobIds[1] || '';
          resolve({
            slug: m.slug || slug,
            upClobTokenId: upClobTokenId || clobIds[0],
            downClobTokenId: downClobTokenId || clobIds[1] || '',
          });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function fetchCryptoMarketFromList() {
  return new Promise((resolve, reject) => {
    fetchMod.get(`${API_BASE}/api/crypto-markets?subcategory=Bitcoin&timeframe=4hour&limit=1`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const m = json.markets?.[0];
          if (!m) return reject(new Error('No crypto market found'));
          const slug = m.slug || m.id;
          const outcomes = m.outcomes || [];
          const up = outcomes.find((o) => (o.label || '').toLowerCase() === 'up') || outcomes[0];
          const down = outcomes.find((o) => (o.label || '').toLowerCase() === 'down') || outcomes[1];
          resolve({ slug, upClobTokenId: up?.clobTokenId, downClobTokenId: down?.clobTokenId || '' });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function testWsCrypto(slug, upClobTokenId, downClobTokenId) {
  return new Promise((resolve) => {
    const wsBase = API_BASE.replace(/^http/, 'ws');
    const url = `${wsBase}/ws/crypto`;
    console.log('\n=== /ws/crypto ===');
    console.log('Connecting to', url);

    const ws = new WebSocket(url);
    const testDuration = parseInt(process.env.TEST_DURATION_SEC, 10) || 60;
    const timeout = setTimeout(() => {
      console.log(`[crypto] ${testDuration}s elapsed, closing...`);
      ws.close();
      resolve();
    }, testDuration * 1000);

    ws.on('open', () => {
      console.log('[crypto] Connected. Sending subscribe:', { slug, upClobTokenId, downClobTokenId });
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          slug,
          upClobTokenId,
          downClobTokenId: downClobTokenId || '',
        })
      );
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log('[crypto] Message:', msg.type, msg.slug || '', msg.upPrice || '', msg.downPrice || '');
        if (msg.type === 'price_update') {
          console.log('[crypto] ✓ Received price_update - broadcast is working');
        }
      } catch {
        console.log('[crypto] Raw:', data.toString().slice(0, 100));
      }
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      console.log('[crypto] Closed:', code, reason?.toString());
      resolve();
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[crypto] Error:', err.message);
      resolve();
    });
  });
}

function testWsOrderbook(clobTokenId) {
  return new Promise((resolve) => {
    const wsBase = API_BASE.replace(/^http/, 'ws');
    const url = `${wsBase}/ws/orderbook`;
    console.log('\n=== /ws/orderbook ===');
    console.log('Connecting to', url);

    const ws = new WebSocket(url);
    const testDuration = parseInt(process.env.TEST_DURATION_SEC, 10) || 60;
    const timeout = setTimeout(() => {
      console.log(`[orderbook] ${testDuration}s elapsed, closing...`);
      ws.close();
      resolve();
    }, testDuration * 1000);

    ws.on('open', () => {
      console.log('[orderbook] Connected. Sending subscribe:', { clobTokenId: clobTokenId?.slice(0, 30) + '...' });
      ws.send(JSON.stringify({ type: 'subscribe', clobTokenId }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log('[orderbook] Message:', msg.type, msg.clobTokenId?.slice(0, 20) + '...', msg.bids?.length || 0, 'bids');
        if (msg.type === 'orderbook_update') {
          console.log('[orderbook] ✓ Received orderbook_update - broadcast is working');
        }
      } catch {
        console.log('[orderbook] Raw:', data.toString().slice(0, 100));
      }
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      console.log('[orderbook] Closed:', code, reason?.toString());
      resolve();
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[orderbook] Error:', err.message);
      resolve();
    });
  });
}

async function main() {
  const slugArg = process.argv[2];
  console.log('Fetching crypto market for slug/tokenIds...');
  let slug, upClobTokenId, downClobTokenId;
  try {
    const r = slugArg
      ? await fetchCryptoMarketBySlug(slugArg)
      : await fetchCryptoMarketFromList();
    slug = r.slug;
    upClobTokenId = r.upClobTokenId;
    downClobTokenId = r.downClobTokenId;
    console.log('Using:', { slug, upClobTokenId: upClobTokenId?.slice(0, 30) + '...' });
  } catch (e) {
    console.error('Could not fetch market:', e.message);
    slug = 'btc-up-or-down-4-hour-2';
    upClobTokenId = '71321045679252212594626348432735855295023941285421457446677928456624800311307';
    downClobTokenId = '0';
    console.log('Using fallback slug/tokenId');
  }

  await testWsCrypto(slug, upClobTokenId, downClobTokenId);
  await testWsOrderbook(upClobTokenId);
  console.log('\nDone.');
}

main().catch(console.error);
