/**
 * Quick test script to verify Polymarket live-data WS sends chainlink price updates.
 * Run: node scripts/test-chainlink-ws.js
 */
const WebSocket = require('ws');

const WS_URL = 'wss://ws-live-data.polymarket.com/';

console.log('Connecting to', WS_URL);

const ws = new WebSocket(WS_URL, {
  headers: {
    'User-Agent': 'mevu-test/1.0',
  },
});

ws.on('open', () => {
  console.log('Connected!');

  const sub = {
    action: 'subscribe',
    subscriptions: [
      { topic: 'crypto_prices_chainlink', type: 'update', filters: JSON.stringify({ symbol: 'btc/usd' }) },
      { topic: 'crypto_prices_chainlink', type: 'update', filters: JSON.stringify({ symbol: 'eth/usd' }) },
      { topic: 'crypto_prices_chainlink', type: 'update', filters: JSON.stringify({ symbol: 'sol/usd' }) },
      { topic: 'crypto_prices_chainlink', type: 'update', filters: JSON.stringify({ symbol: 'xrp/usd' }) },
    ],
  };

  console.log('Sending subscribe:', JSON.stringify(sub));
  ws.send(JSON.stringify(sub));
});

let count = 0;
ws.on('message', (data) => {
  const raw = data.toString();
  try {
    const msg = JSON.parse(raw);
    count++;
    if (msg.topic === 'crypto_prices_chainlink') {
      console.log(`[${count}] ${msg.payload?.symbol}: $${msg.payload?.value?.toFixed(2)} @ ${new Date(msg.payload?.timestamp).toLocaleTimeString()}`);
    } else {
      // Print full keys and structure
      console.log(`[${count}] keys=${Object.keys(msg)} topic=${msg.topic} type=${msg.type} symbol=${msg.payload?.symbol} dataLen=${msg.payload?.data?.length}`);
    }
  } catch {
    console.log(`[${count}] Raw:`, raw.substring(0, 200));
  }

  // Exit after 30 messages
  if (count >= 30) {
    console.log('\nReceived 30 messages, test passed!');
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (err) => {
  console.error('WS Error:', err.message);
});

ws.on('close', (code, reason) => {
  console.log('WS Closed:', code, reason?.toString());
  process.exit(code === 1000 ? 0 : 1);
});

// Timeout after 15 seconds
setTimeout(() => {
  console.error('TIMEOUT: No messages received after 15 seconds');
  ws.close();
  process.exit(1);
}, 15000);
