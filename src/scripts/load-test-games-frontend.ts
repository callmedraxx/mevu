import axios from 'axios';

interface LoadTestOptions {
  url: string;
  totalRequests: number;
  timeoutMs: number;
}

interface RequestResult {
  ok: boolean;
  status?: number;
  durationMs: number;
  error?: string;
}

function parseArgs(): LoadTestOptions {
  const args = process.argv.slice(2);

  let url = process.env.URL || 'http://localhost:3000/api/games/frontend';
  let totalRequests = Number(process.env.REQUESTS || '500');
  let timeoutMs = Number(process.env.TIMEOUT_MS || '10000');

  for (const arg of args) {
    if (arg.startsWith('--url=')) {
      url = arg.substring('--url='.length);
    } else if (arg.startsWith('--requests=')) {
      totalRequests = Number(arg.substring('--requests='.length)) || totalRequests;
    } else if (arg.startsWith('--timeout=')) {
      timeoutMs = Number(arg.substring('--timeout='.length)) || timeoutMs;
    }
  }

  return {
    url,
    totalRequests,
    timeoutMs,
  };
}

async function runSingleRequest(
  url: string,
  timeoutMs: number,
  index: number,
): Promise<RequestResult> {
  const start = Date.now();
  try {
    const res = await axios.get(url, {
      timeout: timeoutMs,
      // We want to record 4xx/5xx instead of throwing
      validateStatus: () => true,
    });
    const durationMs = Date.now() - start;

    const ok = res.status < 500;

    if (!ok) {
      // Log per-request server-side errors
      // Keep this concise so logs stay readable under load
      // eslint-disable-next-line no-console
      console.error(
        `[REQUEST ${index}] HTTP ${res.status} in ${durationMs}ms`,
      );
    }

    return {
      ok,
      status: res.status,
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const message =
      err instanceof Error ? err.message : `Unknown error: ${String(err)}`;

    // eslint-disable-next-line no-console
    console.error(
      `[REQUEST ${index}] ERROR after ${durationMs}ms: ${message}`,
    );

    return {
      ok: false,
      durationMs,
      error: message,
    };
  }
}

async function main(): Promise<void> {
  const { url, totalRequests, timeoutMs } = parseArgs();

  // eslint-disable-next-line no-console
  console.log(
    `Starting load test: ${totalRequests} concurrent GET requests to ${url} (timeout=${timeoutMs}ms)`,
  );

  const startAll = Date.now();

  const promises: Array<Promise<RequestResult>> = [];
  for (let i = 0; i < totalRequests; i++) {
    promises.push(runSingleRequest(url, timeoutMs, i + 1));
  }

  const results = await Promise.all(promises);
  const totalDuration = Date.now() - startAll;

  const successCount = results.filter((r) => r.ok).length;
  const errorCount = results.length - successCount;

  const durations = results.map((r) => r.durationMs).filter((d) => d >= 0);
  const minLatency = durations.length ? Math.min(...durations) : 0;
  const maxLatency = durations.length ? Math.max(...durations) : 0;
  const avgLatency =
    durations.length
      ? durations.reduce((sum, d) => sum + d, 0) / durations.length
      : 0;

  const statusCounts: Record<string, number> = {};
  for (const r of results) {
    const key =
      typeof r.status === 'number' ? String(r.status) : r.error ? 'ERR' : 'UNK';
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }

  // eslint-disable-next-line no-console
  console.log('--- Load test summary ---');
  // eslint-disable-next-line no-console
  console.log(`URL: ${url}`);
  // eslint-disable-next-line no-console
  console.log(`Total requests: ${results.length}`);
  // eslint-disable-next-line no-console
  console.log(`Success (status < 500): ${successCount}`);
  // eslint-disable-next-line no-console
  console.log(`Errors (>=500 or network): ${errorCount}`);
  // eslint-disable-next-line no-console
  console.log(`Total wall time: ${totalDuration}ms`);
  // eslint-disable-next-line no-console
  console.log(
    `Per-request latency (ms): min=${minLatency} max=${maxLatency} avg=${avgLatency.toFixed(
      2,
    )}`,
  );
  // eslint-disable-next-line no-console
  console.log('Status / error counts:');
  // eslint-disable-next-line no-console
  console.log(statusCounts);
}

// Run if invoked directly
// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();

