import axios from 'axios';

interface LoadTestOptions {
  url: string;
  totalRequests: number;
  timeoutMs: number;
  concurrency: number;
  origin: string;
}

interface RequestResult {
  ok: boolean;
  status?: number;
  durationMs: number;
  error?: string;
  workerId?: string;
  requestId: number;
}

function parseArgs(): LoadTestOptions {
  const args = process.argv.slice(2);

  let url = process.env.URL || 'https://dev.api.mevu.com/api/positions/did:privy:cmj921f4201dql40c3nubss93';
  let totalRequests = Number(process.env.REQUESTS || '1000');
  let timeoutMs = Number(process.env.TIMEOUT_MS || '30000');
  let concurrency = Number(process.env.CONCURRENCY || '100'); // Batch size for concurrent requests
  let origin = process.env.ORIGIN || 'https://app.mevu.com';

  for (const arg of args) {
    if (arg.startsWith('--url=')) {
      url = arg.substring('--url='.length);
    } else if (arg.startsWith('--requests=')) {
      totalRequests = Number(arg.substring('--requests='.length)) || totalRequests;
    } else if (arg.startsWith('--timeout=')) {
      timeoutMs = Number(arg.substring('--timeout='.length)) || timeoutMs;
    } else if (arg.startsWith('--concurrency=')) {
      concurrency = Number(arg.substring('--concurrency='.length)) || concurrency;
    } else if (arg.startsWith('--origin=')) {
      origin = arg.substring('--origin='.length);
    }
  }

  return {
    url,
    totalRequests,
    timeoutMs,
    concurrency,
    origin,
  };
}

async function runSingleRequest(
  url: string,
  timeoutMs: number,
  index: number,
  origin: string,
): Promise<RequestResult> {
  const start = Date.now();
  
  // Add unique query param to help distribute across workers (cache busting + load balancer distribution)
  const uniqueUrl = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}_${index}_${Math.random().toString(36).substring(7)}`;
  
  try {
    const res = await axios.get(uniqueUrl, {
      timeout: timeoutMs,
      // We want to record 4xx/5xx instead of throwing
      validateStatus: () => true,
      headers: {
        'Origin': origin,
        'Referer': `${origin}/`,
        'User-Agent': `LoadTest/1.0 Request/${index}`,
        // Add cache-control to prevent caching
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      },
    });
    const durationMs = Date.now() - start;

    const ok = res.status < 500;
    
    // Try to extract worker ID from response headers (if your backend sends it)
    const workerId = res.headers['x-worker-id'] || 
                     res.headers['x-served-by'] || 
                     res.headers['x-instance-id'] ||
                     undefined;

    if (!ok) {
      // Log per-request server-side errors
      console.error(
        `[REQUEST ${index}] HTTP ${res.status} in ${durationMs}ms`,
      );
    }

    return {
      ok,
      status: res.status,
      durationMs,
      workerId,
      requestId: index,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const message =
      err instanceof Error ? err.message : `Unknown error: ${String(err)}`;

    console.error(
      `[REQUEST ${index}] ERROR after ${durationMs}ms: ${message}`,
    );

    return {
      ok: false,
      durationMs,
      error: message,
      requestId: index,
    };
  }
}

async function runBatch(
  url: string,
  timeoutMs: number,
  startIndex: number,
  batchSize: number,
  origin: string,
): Promise<RequestResult[]> {
  const promises: Array<Promise<RequestResult>> = [];
  for (let i = 0; i < batchSize; i++) {
    promises.push(runSingleRequest(url, timeoutMs, startIndex + i, origin));
  }
  return Promise.all(promises);
}

async function main(): Promise<void> {
  const { url, totalRequests, timeoutMs, concurrency, origin } = parseArgs();

  console.log('='.repeat(60));
  console.log('LOAD TEST: /games/frontend endpoint');
  console.log('='.repeat(60));
  console.log(`URL: ${url}`);
  console.log(`Origin: ${origin}`);
  console.log(`Total requests: ${totalRequests}`);
  console.log(`Concurrency (batch size): ${concurrency}`);
  console.log(`Timeout per request: ${timeoutMs}ms`);
  console.log('='.repeat(60));
  console.log('');

  const startAll = Date.now();
  const allResults: RequestResult[] = [];
  
  // Run requests in batches to avoid overwhelming the system
  const numBatches = Math.ceil(totalRequests / concurrency);
  
  for (let batch = 0; batch < numBatches; batch++) {
    const startIndex = batch * concurrency + 1;
    const remainingRequests = totalRequests - batch * concurrency;
    const batchSize = Math.min(concurrency, remainingRequests);
    
    const batchStart = Date.now();
    console.log(`[Batch ${batch + 1}/${numBatches}] Sending ${batchSize} requests (${startIndex} - ${startIndex + batchSize - 1})...`);
    
    const batchResults = await runBatch(url, timeoutMs, startIndex, batchSize, origin);
    allResults.push(...batchResults);
    
    const batchDuration = Date.now() - batchStart;
    const batchSuccess = batchResults.filter(r => r.ok).length;
    console.log(`[Batch ${batch + 1}/${numBatches}] Completed in ${batchDuration}ms (${batchSuccess}/${batchSize} success)`);
    
    // Small delay between batches to let connections settle
    if (batch < numBatches - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  const totalDuration = Date.now() - startAll;

  const successCount = allResults.filter((r) => r.ok).length;
  const errorCount = allResults.length - successCount;

  const durations = allResults.map((r) => r.durationMs).filter((d) => d >= 0);
  const minLatency = durations.length ? Math.min(...durations) : 0;
  const maxLatency = durations.length ? Math.max(...durations) : 0;
  const avgLatency =
    durations.length
      ? durations.reduce((sum, d) => sum + d, 0) / durations.length
      : 0;
  
  // Calculate percentiles
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const p50 = sortedDurations[Math.floor(sortedDurations.length * 0.50)] || 0;
  const p90 = sortedDurations[Math.floor(sortedDurations.length * 0.90)] || 0;
  const p95 = sortedDurations[Math.floor(sortedDurations.length * 0.95)] || 0;
  const p99 = sortedDurations[Math.floor(sortedDurations.length * 0.99)] || 0;

  const statusCounts: Record<string, number> = {};
  for (const r of allResults) {
    const key =
      typeof r.status === 'number' ? String(r.status) : r.error ? 'ERR' : 'UNK';
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }
  
  // Track worker distribution
  const workerCounts: Record<string, number> = {};
  for (const r of allResults) {
    if (r.workerId) {
      workerCounts[r.workerId] = (workerCounts[r.workerId] || 0) + 1;
    }
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('LOAD TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`URL: ${url}`);
  console.log(`Origin: ${origin}`);
  console.log(`Total requests: ${allResults.length}`);
  console.log(`Success (status < 500): ${successCount} (${((successCount / allResults.length) * 100).toFixed(1)}%)`);
  console.log(`Errors (>=500 or network): ${errorCount} (${((errorCount / allResults.length) * 100).toFixed(1)}%)`);
  console.log('');
  console.log('--- Timing ---');
  console.log(`Total wall time: ${totalDuration}ms (${(totalDuration / 1000).toFixed(2)}s)`);
  console.log(`Throughput: ${(allResults.length / (totalDuration / 1000)).toFixed(2)} requests/second`);
  console.log('');
  console.log('--- Latency (ms) ---');
  console.log(`Min: ${minLatency}`);
  console.log(`Max: ${maxLatency}`);
  console.log(`Avg: ${avgLatency.toFixed(2)}`);
  console.log(`P50: ${p50}`);
  console.log(`P90: ${p90}`);
  console.log(`P95: ${p95}`);
  console.log(`P99: ${p99}`);
  console.log('');
  console.log('--- Status Codes ---');
  for (const [status, count] of Object.entries(statusCounts).sort()) {
    console.log(`  ${status}: ${count} (${((count / allResults.length) * 100).toFixed(1)}%)`);
  }
  
  if (Object.keys(workerCounts).length > 0) {
    console.log('');
    console.log('--- Worker Distribution ---');
    for (const [worker, count] of Object.entries(workerCounts).sort()) {
      console.log(`  ${worker}: ${count} (${((count / allResults.length) * 100).toFixed(1)}%)`);
    }
  } else {
    console.log('');
    console.log('--- Worker Distribution ---');
    console.log('  (No worker ID headers detected in responses)');
    console.log('  Tip: Add X-Worker-Id header to your backend responses to track distribution');
  }
  
  console.log('='.repeat(60));
}

// Run if invoked directly
main().catch(err => {
  console.error('Load test failed:', err);
  process.exit(1);
});
