import axios from 'axios';

interface EndpointConfig {
  name: string;
  url: string;
  requestCount: number;
}

interface RequestResult {
  ok: boolean;
  status?: number;
  durationMs: number;
  error?: string;
  workerId?: string;
  requestId: number;
  endpoint: string;
  /** Server-reported fetch time (X-Fetch-Ms) - time spent in getFrontendGamesFromDatabase */
  fetchMs?: number;
}

interface EndpointSummary {
  name: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  minLatency: number;
  maxLatency: number;
  avgLatency: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  statusCounts: Record<string, number>;
  workerCounts: Record<string, number>;
  /** Server fetch times (when X-Fetch-Ms present) */
  fetchMsStats?: { min: number; avg: number; max: number; sampleCount: number };
}

const BASE_URL = process.env.BASE_URL || 'https://dev.api.mevu.com';
const ORIGIN = process.env.ORIGIN || 'https://app.mevu.com';
const REQUESTS_PER_ENDPOINT = Number(process.env.REQUESTS || '500');
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || '30000');
const CONCURRENCY = Number(process.env.CONCURRENCY || '50');
/** When set (e.g. SINGLE_ENDPOINT=crypto-markets), only run that endpoint */
const SINGLE_ENDPOINT = process.env.SINGLE_ENDPOINT?.trim() || '';

// Test user/game identifiers
const PRIVY_ID = 'did:privy:cmj921f4201dql40c3nubss93';
const GAME_SLUG = 'nba-dal-mil-2026-01-25';

// CLOB Token IDs for price history testing (fresh tokens not in DB)
const CLOB_TOKEN_IDS = [
  '85197994910792066555961642318438736701826922553469381954551572186674036021666',
  '19410395034837125469891059433041444992924948482142738591910808764491644279863',
];

const CRYPTO_MARKET_SLUG = 'what-price-will-bitcoin-hit-in-february-2026';

const ENDPOINTS: EndpointConfig[] = [
  {
    name: 'crypto-markets',
    url: `${BASE_URL}/api/crypto-markets?page=1&limit=50`,
    requestCount: REQUESTS_PER_ENDPOINT,
  },
  {
    name: 'crypto-markets-detail',
    url: `${BASE_URL}/api/crypto-markets/detail/${CRYPTO_MARKET_SLUG}`,
    requestCount: REQUESTS_PER_ENDPOINT,
  },
  {
    name: 'games/frontend',
    url: `${BASE_URL}/api/games/frontend`,
    requestCount: REQUESTS_PER_ENDPOINT,
  },
  {
    name: 'positions',
    url: `${BASE_URL}/api/positions/${PRIVY_ID}`,
    requestCount: REQUESTS_PER_ENDPOINT,
  },
  {
    name: 'activity-watcher',
    url: `${BASE_URL}/api/activity-watcher/${GAME_SLUG}`,
    requestCount: REQUESTS_PER_ENDPOINT,
  },
  {
    name: 'live-stats',
    url: `${BASE_URL}/api/live-stats/${GAME_SLUG}`,
    requestCount: REQUESTS_PER_ENDPOINT,
  },
  {
    name: 'price-history-token1',
    url: `${BASE_URL}/api/price-history/${CLOB_TOKEN_IDS[0]}?interval=1d`,
    requestCount: REQUESTS_PER_ENDPOINT,
  },
  {
    name: 'price-history-token2',
    url: `${BASE_URL}/api/price-history/${CLOB_TOKEN_IDS[1]}?interval=1d`,
    requestCount: REQUESTS_PER_ENDPOINT,
  },
  {
    name: 'trades',
    url: `${BASE_URL}/api/trades/${GAME_SLUG}`,
    requestCount: REQUESTS_PER_ENDPOINT,
  },
  {
    name: 'holders',
    url: `${BASE_URL}/api/holders/${GAME_SLUG}`,
    requestCount: REQUESTS_PER_ENDPOINT,
  },
  {
    name: 'whale-watcher',
    url: `${BASE_URL}/api/whale-watcher/${GAME_SLUG}`,
    requestCount: REQUESTS_PER_ENDPOINT,
  },
  {
    name: 'ocean-trades',
    url: `${BASE_URL}/api/ocean/trades`,
    requestCount: REQUESTS_PER_ENDPOINT,
  },
];

const ACTIVE_ENDPOINTS = SINGLE_ENDPOINT
  ? ENDPOINTS.filter((e) => e.name === SINGLE_ENDPOINT)
  : ENDPOINTS;

if (ACTIVE_ENDPOINTS.length === 0) {
  console.error(`No endpoints match SINGLE_ENDPOINT="${SINGLE_ENDPOINT}". Valid names: ${ENDPOINTS.map((e) => e.name).join(', ')}`);
  process.exit(1);
}

/** Endpoints where we want identical URLs to test request coalescing (no cache busting) */
const COALESCE_ENDPOINTS = new Set(['games/frontend', 'crypto-markets']);

async function runSingleRequest(
  endpoint: EndpointConfig,
  index: number,
): Promise<RequestResult> {
  const start = Date.now();
  
  // Skip cache busting for coalescing endpoints - identical URLs let server coalesce concurrent requests
  const url = COALESCE_ENDPOINTS.has(endpoint.name)
    ? endpoint.url
    : `${endpoint.url}${endpoint.url.includes('?') ? '&' : '?'}_t=${Date.now()}_${index}_${Math.random().toString(36).substring(7)}`;
  
  try {
    const res = await axios.get(url, {
      timeout: TIMEOUT_MS,
      validateStatus: () => true,
      headers: {
        'Accept': 'application/json',
        'Origin': ORIGIN,
        'Referer': `${ORIGIN}/`,
        'User-Agent': `LoadTest/1.0 ${endpoint.name}/${index}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
    const durationMs = Date.now() - start;
    const ok = res.status < 500;
    
    const workerId = res.headers['x-worker-id'] || 
                     res.headers['x-served-by'] || 
                     res.headers['x-instance-id'] ||
                     undefined;
    const fetchMsHeader = res.headers['x-fetch-ms'];
    const fetchMs = fetchMsHeader ? parseInt(String(fetchMsHeader), 10) : undefined;

    if (!ok) {
      console.error(`[${endpoint.name}][${index}] HTTP ${res.status} in ${durationMs}ms`);
    }

    return {
      ok,
      status: res.status,
      durationMs,
      workerId,
      requestId: index,
      endpoint: endpoint.name,
      fetchMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : `Unknown error: ${String(err)}`;

    console.error(`[${endpoint.name}][${index}] ERROR after ${durationMs}ms: ${message}`);

    return {
      ok: false,
      durationMs,
      error: message,
      requestId: index,
      endpoint: endpoint.name,
    };
  }
}

async function runEndpointBatch(
  endpoint: EndpointConfig,
  startIndex: number,
  batchSize: number,
): Promise<RequestResult[]> {
  const promises: Array<Promise<RequestResult>> = [];
  for (let i = 0; i < batchSize; i++) {
    promises.push(runSingleRequest(endpoint, startIndex + i));
  }
  return Promise.all(promises);
}

function calculateSummary(name: string, results: RequestResult[]): EndpointSummary {
  const successCount = results.filter(r => r.ok).length;
  const errorCount = results.length - successCount;
  
  const durations = results.map(r => r.durationMs).filter(d => d >= 0);
  const sortedDurations = [...durations].sort((a, b) => a - b);
  
  const minLatency = durations.length ? Math.min(...durations) : 0;
  const maxLatency = durations.length ? Math.max(...durations) : 0;
  const avgLatency = durations.length ? durations.reduce((sum, d) => sum + d, 0) / durations.length : 0;
  const p50 = sortedDurations[Math.floor(sortedDurations.length * 0.50)] || 0;
  const p90 = sortedDurations[Math.floor(sortedDurations.length * 0.90)] || 0;
  const p95 = sortedDurations[Math.floor(sortedDurations.length * 0.95)] || 0;
  const p99 = sortedDurations[Math.floor(sortedDurations.length * 0.99)] || 0;

  const statusCounts: Record<string, number> = {};
  for (const r of results) {
    const key = typeof r.status === 'number' ? String(r.status) : r.error ? 'ERR' : 'UNK';
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }

  const workerCounts: Record<string, number> = {};
  for (const r of results) {
    if (r.workerId) {
      workerCounts[r.workerId] = (workerCounts[r.workerId] || 0) + 1;
    }
  }

  const fetchMsValues = results.map(r => r.fetchMs).filter((v): v is number => typeof v === 'number');
  const fetchMsStats = fetchMsValues.length > 0
    ? {
        min: Math.min(...fetchMsValues),
        avg: fetchMsValues.reduce((a, b) => a + b, 0) / fetchMsValues.length,
        max: Math.max(...fetchMsValues),
        sampleCount: fetchMsValues.length,
      }
    : undefined;

  return {
    name,
    totalRequests: results.length,
    successCount,
    errorCount,
    minLatency,
    maxLatency,
    avgLatency,
    p50,
    p90,
    p95,
    p99,
    statusCounts,
    workerCounts,
    fetchMsStats,
  };
}

function printSummary(summary: EndpointSummary): void {
  console.log(`\n--- ${summary.name.toUpperCase()} ---`);
  console.log(`  Requests: ${summary.totalRequests}`);
  console.log(`  Success: ${summary.successCount} (${((summary.successCount / summary.totalRequests) * 100).toFixed(1)}%)`);
  console.log(`  Errors: ${summary.errorCount} (${((summary.errorCount / summary.totalRequests) * 100).toFixed(1)}%)`);
  console.log(`  Latency: min=${summary.minLatency}ms, avg=${summary.avgLatency.toFixed(0)}ms, max=${summary.maxLatency}ms`);
  console.log(`  Percentiles: P50=${summary.p50}ms, P90=${summary.p90}ms, P95=${summary.p95}ms, P99=${summary.p99}ms`);
  
  const statusStr = Object.entries(summary.statusCounts)
    .sort()
    .map(([s, c]) => `${s}:${c}`)
    .join(', ');
  console.log(`  Status codes: ${statusStr}`);
  
  if (Object.keys(summary.workerCounts).length > 0) {
    const workerStr = Object.entries(summary.workerCounts)
      .sort()
      .map(([w, c]) => `${w}:${c}`)
      .join(', ');
    console.log(`  Workers: ${workerStr}`);
  }
  if (summary.fetchMsStats) {
    const f = summary.fetchMsStats;
    console.log(`  Server fetch (X-Fetch-Ms): min=${f.min}ms, avg=${f.avg.toFixed(0)}ms, max=${f.max}ms (n=${f.sampleCount})`);
  }
}

async function runAllEndpointsSimultaneously(): Promise<void> {
  console.log('='.repeat(70));
  console.log('MULTI-ENDPOINT LOAD TEST');
  console.log('='.repeat(70));
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Origin: ${ORIGIN}`);
  console.log(`Requests per endpoint: ${REQUESTS_PER_ENDPOINT}`);
  console.log(`Concurrency per endpoint: ${CONCURRENCY}`);
  console.log(`Timeout: ${TIMEOUT_MS}ms`);
  if (SINGLE_ENDPOINT) console.log(`Single endpoint mode: ${SINGLE_ENDPOINT}`);
  console.log('');
  console.log('Endpoints:');
  for (const ep of ACTIVE_ENDPOINTS) {
    console.log(`  - ${ep.name}: ${ep.url}`);
  }
  console.log('='.repeat(70));
  console.log('');

  const startAll = Date.now();
  
  // Create promises for all endpoints running in parallel
  const endpointPromises = ACTIVE_ENDPOINTS.map(async (endpoint) => {
    const results: RequestResult[] = [];
    const numBatches = Math.ceil(endpoint.requestCount / CONCURRENCY);
    
    console.log(`[${endpoint.name}] Starting ${endpoint.requestCount} requests in ${numBatches} batches...`);
    
    for (let batch = 0; batch < numBatches; batch++) {
      const startIndex = batch * CONCURRENCY + 1;
      const remainingRequests = endpoint.requestCount - batch * CONCURRENCY;
      const batchSize = Math.min(CONCURRENCY, remainingRequests);
      
      const batchResults = await runEndpointBatch(endpoint, startIndex, batchSize);
      results.push(...batchResults);
      
      const batchSuccess = batchResults.filter(r => r.ok).length;
      console.log(`[${endpoint.name}] Batch ${batch + 1}/${numBatches}: ${batchSuccess}/${batchSize} success`);
      
      // Small delay between batches
      if (batch < numBatches - 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    
    return { endpoint: endpoint.name, results };
  });

  // Wait for all endpoints to complete
  const allEndpointResults = await Promise.all(endpointPromises);
  
  const totalDuration = Date.now() - startAll;

  // Aggregate all results
  const allResults: RequestResult[] = [];
  const summaries: EndpointSummary[] = [];
  
  for (const { endpoint, results } of allEndpointResults) {
    allResults.push(...results);
    summaries.push(calculateSummary(endpoint, results));
  }

  // Calculate overall summary
  const overallSuccess = allResults.filter(r => r.ok).length;
  const overallError = allResults.length - overallSuccess;
  const allDurations = allResults.map(r => r.durationMs).filter(d => d >= 0);
  const sortedAllDurations = [...allDurations].sort((a, b) => a - b);
  const overallAvg = allDurations.length ? allDurations.reduce((sum, d) => sum + d, 0) / allDurations.length : 0;
  const overallP50 = sortedAllDurations[Math.floor(sortedAllDurations.length * 0.50)] || 0;
  const overallP90 = sortedAllDurations[Math.floor(sortedAllDurations.length * 0.90)] || 0;
  const overallP95 = sortedAllDurations[Math.floor(sortedAllDurations.length * 0.95)] || 0;
  const overallP99 = sortedAllDurations[Math.floor(sortedAllDurations.length * 0.99)] || 0;

  // Print results
  console.log('');
  console.log('='.repeat(70));
  console.log('LOAD TEST RESULTS');
  console.log('='.repeat(70));
  
  // Per-endpoint summaries
  for (const summary of summaries) {
    printSummary(summary);
  }

  // Overall summary
  console.log('');
  console.log('='.repeat(70));
  console.log('OVERALL SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total requests: ${allResults.length}`);
  console.log(`Total success: ${overallSuccess} (${((overallSuccess / allResults.length) * 100).toFixed(1)}%)`);
  console.log(`Total errors: ${overallError} (${((overallError / allResults.length) * 100).toFixed(1)}%)`);
  console.log(`Total wall time: ${totalDuration}ms (${(totalDuration / 1000).toFixed(2)}s)`);
  console.log(`Overall throughput: ${(allResults.length / (totalDuration / 1000)).toFixed(2)} requests/second`);
  console.log(`Overall latency: avg=${overallAvg.toFixed(0)}ms, P50=${overallP50}ms, P90=${overallP90}ms, P95=${overallP95}ms, P99=${overallP99}ms`);
  
  // Worker distribution across all endpoints
  const overallWorkerCounts: Record<string, number> = {};
  for (const r of allResults) {
    if (r.workerId) {
      overallWorkerCounts[r.workerId] = (overallWorkerCounts[r.workerId] || 0) + 1;
    }
  }
  
  if (Object.keys(overallWorkerCounts).length > 0) {
    console.log('');
    console.log('Worker distribution (all endpoints):');
    for (const [worker, count] of Object.entries(overallWorkerCounts).sort()) {
      console.log(`  ${worker}: ${count} (${((count / allResults.length) * 100).toFixed(1)}%)`);
    }
  }
  
  console.log('='.repeat(70));
}

// Run the test
runAllEndpointsSimultaneously().catch(err => {
  console.error('Load test failed:', err);
  process.exit(1);
});
