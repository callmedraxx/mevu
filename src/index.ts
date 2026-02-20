import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import cluster from 'cluster';
import { swaggerOptions } from './config/swagger';
import apiRouter from './routes';
import { logoMappingService } from './services/espn/logo-mapping.service';
import { liveGamesService } from './services/polymarket/live-games.service';
import { sportsGamesService } from './services/polymarket/sports-games.service';
import { seriesIdSyncService } from './services/polymarket/series-id-sync.service';
import { teamsService } from './services/polymarket/teams.service';
import { privyService } from './services/privy/privy.service';
import { initializeUsersTable } from './services/privy/user.service';
import { teamsRefreshService } from './services/polymarket/teams-refresh.service';
import { sportsWebSocketService } from './services/polymarket/sports-websocket.service';
import { gamesWebSocketService } from './services/polymarket/games-websocket.service';
import { activityWatcherWebSocketService } from './services/polymarket/activity-watcher-websocket.service';
import { clobPriceUpdateService } from './services/polymarket/clob-price-update.service';
import { positionsWebSocketService } from './services/positions/positions-websocket.service';
import { initRedisGamesBroadcast, shutdownRedisGamesBroadcast } from './services/redis-games-broadcast.service';
import { initRedisClusterBroadcast, shutdownRedisClusterBroadcast } from './services/redis-cluster-broadcast.service';
import { initRedisGamesCache, shutdownRedisGamesCache } from './services/polymarket/redis-games-cache.service';
import { initializeProbabilityHistoryTable, cleanupOldProbabilityHistory } from './services/polymarket/probability-history.service';
import { logger } from './config/logger';
import { runMigrations } from './scripts/run-migrations';
// DEPRECATED: polygonUsdcBalanceService - replaced by Alchemy webhooks
// import { polygonUsdcBalanceService } from './services/polygon/polygon-usdc-balance.service';
import { alchemyWebhookService } from './services/alchemy/alchemy-webhook.service';
import { embeddedWalletBalanceService } from './services/privy/embedded-wallet-balance.service';
import { autoTransferService } from './services/privy/auto-transfer.service';
import { depositProgressService } from './services/privy/deposit-progress.service';
import { kalshiService, kalshiPriceUpdateService } from './services/kalshi';
import { registerOnGamesRefreshed } from './services/polymarket/live-games.service';
import { cryptoMarketsService } from './services/crypto/crypto-markets.service';
import { cryptoClobPriceService } from './services/crypto/crypto-clob-price.service';
import { cryptoOrderbookService } from './services/crypto/crypto-orderbook.service';
import { cryptoMarketWebSocketService } from './services/crypto/crypto-market-websocket.service';
import { orderbookWebSocketService } from './services/crypto/orderbook-websocket.service';
import { cryptoChainlinkPriceService } from './services/crypto/crypto-chainlink-price.service';
import { cryptoLivePriceWebSocketService } from './services/crypto/crypto-live-price-websocket.service';

// Load environment variables
dotenv.config();

// Global error handlers to prevent worker crashes
process.on('uncaughtException', (error) => {
  logger.error({
    message: 'Uncaught exception - worker will continue',
    error: error.message,
    stack: error.stack,
    pid: process.pid,
    workerId: cluster.isWorker ? cluster.worker?.id : 'primary',
  });
  // Don't exit - let the worker continue
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({
    message: 'Unhandled promise rejection - worker will continue',
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    pid: process.pid,
    workerId: cluster.isWorker ? cluster.worker?.id : 'primary',
  });
  // Don't exit - let the worker continue
});

// Initialize logo mapping service
logoMappingService.initialize().catch((error) => {
  console.error('Failed to initialize logo mapping service:', error);
});

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
// Allow all origins for development
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add worker ID to response headers for load balancing verification
app.use((req, res, next) => {
  const workerId = cluster.isWorker ? `worker-${cluster.worker?.id}` : 'primary';
  res.setHeader('X-Worker-Id', workerId);
  res.setHeader('X-Process-Id', process.pid.toString());
  next();
});

// Global request logging for debugging
app.use((req, res, next) => {
  if (req.path.includes('/trading/') || req.path.includes('/sell') || req.path.includes('/buy')) {
    logger.info({
      message: '📥 TRADING REQUEST INCOMING',
      method: req.method,
      path: req.path,
      ip: req.ip,
      contentLength: req.headers['content-length'],
      userAgent: req.headers['user-agent']?.substring(0, 50),
    });
  }
  next();
});

// Swagger setup
const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Health check route
/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Server is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// WebSocket health check endpoint
app.get('/ws/health', (req, res) => {
  res.json({
    status: 'ok',
    websockets: {
      games: '/ws/games',
      activity: '/ws/activity',
    },
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.use('/api', apiRouter);

// Initialize SPORTS services only (for sports background worker)
async function initializeSportsServices() {
  try {
    // Run database migrations first
    const nodeEnv = process.env.NODE_ENV || 'development';
    if (nodeEnv === 'production') {
      logger.info({ message: 'Running database migrations...' });
      await runMigrations();
      logger.info({ message: 'Database migrations completed' });
    }

    // Stagger database-dependent service initialization to prevent connection pool exhaustion
    // Initialize users table
    logger.info({ message: 'Initializing users table...' });
    await initializeUsersTable();

    // Small delay to allow previous connection to complete
    await new Promise(resolve => setTimeout(resolve, 500));

    // Initialize probability history table
    await initializeProbabilityHistoryTable();

    // Longer delay before starting services that make immediate DB connections
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Sync series IDs from Gamma so we don't have to hardcode seasonal series_id changes
    await seriesIdSyncService.start();

    // Start live games polling service
    liveGamesService.start();

    await new Promise(resolve => setTimeout(resolve, 500));

    // Start sports games polling service
    logger.info({ message: 'Starting sports games service...' });
    sportsGamesService.start();

    await new Promise(resolve => setTimeout(resolve, 500));

    // Start teams refresh service
    teamsRefreshService.start();

    // Initialize Kalshi service - runs in parallel with live games refresh
    logger.info({ message: 'Initializing Kalshi service...' });
    registerOnGamesRefreshed(async () => {
      try {
        await kalshiService.refreshKalshiMarkets();
      } catch (error) {
        logger.error({
          message: 'Error refreshing Kalshi markets',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    // Initial Kalshi fetch (non-blocking)
    kalshiService.refreshKalshiMarkets().catch(err => {
      logger.warn({ message: 'Initial Kalshi fetch failed', error: err instanceof Error ? err.message : String(err) });
    });
    logger.info({ message: 'Kalshi service initialized' });

    // Initialize Alchemy webhook service for USDC balance notifications
    try {
      logger.info({ message: 'Initializing Alchemy webhook service...' });
      await alchemyWebhookService.initialize();
      logger.info({ message: 'Alchemy webhook service initialized', isReady: alchemyWebhookService.isReady() });
    } catch (alchemyError) {
      logger.error({
        message: 'Failed to initialize Alchemy webhook service',
        error: alchemyError instanceof Error ? alchemyError.message : String(alchemyError),
      });
    }

    // Initialize embedded wallet balance service
    try {
      logger.info({ message: 'Initializing embedded wallet balance service...' });
      await embeddedWalletBalanceService.initialize();
      logger.info({ message: 'Embedded wallet balance service initialized' });
    } catch (balanceServiceError) {
      logger.error({
        message: 'Failed to initialize embedded wallet balance service',
        error: balanceServiceError instanceof Error ? balanceServiceError.message : String(balanceServiceError),
      });
    }

    // Initialize auto-transfer service
    try {
      logger.info({ message: 'Initializing auto-transfer service...' });
      autoTransferService.initialize();
      logger.info({ message: 'Auto-transfer service initialized' });
    } catch (autoTransferError) {
      logger.error({
        message: 'Failed to initialize auto-transfer service',
        error: autoTransferError instanceof Error ? autoTransferError.message : String(autoTransferError),
      });
    }

    // Load any pending deposits from database for progress tracking
    try {
      logger.info({ message: 'Loading pending deposits for progress tracking...' });
      await depositProgressService.loadFromDatabase();
      logger.info({ message: 'Deposit progress service ready' });
    } catch (depositProgressError) {
      logger.warn({
        message: 'Could not load pending deposits (table may not exist yet)',
        error: depositProgressError instanceof Error ? depositProgressError.message : String(depositProgressError),
      });
    }

    // Start crypto markets polling service (1h refresh)
    logger.info({ message: 'Starting crypto markets service...' });
    cryptoMarketsService.start();

    // Start sports WebSocket for live game score updates
    logger.info({ message: 'Starting sports WebSocket service...' });
    sportsWebSocketService.connect().catch((error) => {
      logger.error({
        message: 'Failed to connect sports WebSocket',
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // Set up periodic cleanup of old probability history (every 6 hours)
    setInterval(() => {
      cleanupOldProbabilityHistory(7).catch(() => {});
    }, 6 * 60 * 60 * 1000);

    // Set up periodic cache sync and stale mapping cleanup (every 5 minutes)
    const { cleanupStaleMappings, getCacheStats } = await import('./services/polymarket/redis-games-cache.service');

    // Initial cleanup after 30 seconds
    setTimeout(async () => {
      try {
        const stats = await getCacheStats();
        logger.info({
          message: 'Initial cache stats',
          gamesCount: stats.gamesCount,
          gidMappingsCount: stats.gidMappingsCount,
          slugMappingsCount: stats.slugMappingsCount,
        });
        await cleanupStaleMappings();
      } catch (error) {
        logger.warn({
          message: 'Error in initial cache cleanup',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, 30 * 1000);

    // Periodic cleanup every 5 minutes
    setInterval(async () => {
      try {
        await cleanupStaleMappings();
      } catch (error) {
        logger.warn({
          message: 'Error in periodic cache cleanup',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, 5 * 60 * 1000);

    // Set up periodic fee retry job (every 5 minutes)
    if (nodeEnv === 'production') {
      setInterval(async () => {
        try {
          const { retryPendingFees } = await import('./services/polymarket/trading/fee.service');
          await retryPendingFees();
        } catch (error) {
          logger.error({
            message: 'Error retrying pending fees',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }, 5 * 60 * 1000);

      logger.info({ message: 'Fee retry background job started (runs every 5 minutes)' });
    }

    logger.info({ message: 'Sports services initialized successfully' });
  } catch (error) {
    logger.error({
      message: 'Error initializing sports services',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Initialize CLOB services only (for CLOB background worker)
async function initializeClobServices() {
  try {
    // Start crypto Redis subscriptions immediately so we don't miss early client subscribe messages.
    // They use addAssets which merges into pendingSubscriptions; when CLOB connects we'll send all.
    logger.info({ message: 'Initializing crypto CLOB Redis subscriptions (early, before games delay)...' });
    cryptoClobPriceService.initialize();
    cryptoOrderbookService.initialize();

    // Connect to Polymarket live-data WS for Chainlink oracle prices (BTC, ETH, SOL, XRP)
    logger.info({ message: 'Initializing Chainlink price service...' });
    cryptoChainlinkPriceService.initialize();

    // Wait a bit for sports worker to populate games cache first
    logger.info({ message: 'CLOB worker waiting for games cache to populate...' });
    await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second delay

    // Initialize CLOB price update service for real-time odds/probability updates
    logger.info({ message: 'Initializing CLOB price update service...' });
    await clobPriceUpdateService.initialize();

    // Initialize Kalshi WebSocket price update service
    // Uses leader election - only one worker will maintain the WebSocket connection
    const kalshiWsEnabled = process.env.KALSHI_WS_ENABLED !== 'false';
    if (kalshiWsEnabled) {
      logger.info({ message: 'Initializing Kalshi WebSocket price update service...' });
      try {
        await kalshiPriceUpdateService.initialize();
        const status = kalshiPriceUpdateService.getStatus();
        logger.info({
          message: 'Kalshi WebSocket price update service initialized',
          isLeader: status.isLeader,
          tickerCount: status.mapperStats?.tickerCount || 0,
        });
      } catch (kalshiError) {
        // Non-fatal: Kalshi WS is optional, REST polling will still work
        logger.warn({
          message: 'Kalshi WebSocket service failed to initialize (falling back to REST)',
          error: kalshiError instanceof Error ? kalshiError.message : String(kalshiError),
        });
      }
    } else {
      logger.info({ message: 'Kalshi WebSocket disabled via KALSHI_WS_ENABLED=false' });
    }

    // Crypto services already initialized above (before games delay)
    const cryptoStatus = cryptoClobPriceService.getStatus();
    logger.info({
      message: 'CLOB crypto pipeline ready',
      trackedCryptoTokens: cryptoStatus.trackedTokens,
      trackedSlugs: cryptoStatus.trackedSlugs,
    });

    logger.info({ message: 'CLOB services initialized successfully' });
  } catch (error) {
    logger.error({
      message: 'Error initializing CLOB services',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Initialize ALL services (for development mode - single process)
async function initializeServices() {
  await initializeSportsServices();
  await initializeClobServices();
}

let server: http.Server | null = null;

/**
 * Start the SPORTS background worker that handles:
 * - Polling services (live games, sports games, teams refresh)
 * - Sports WebSocket for live scores
 * - Database flush operations for game data
 * - Alchemy webhooks, wallet balance, auto-transfer services
 *
 * This worker does NOT serve HTTP requests or handle CLOB price updates.
 */
function startSportsBackgroundWorker() {
  logger.info({
    message: 'Starting SPORTS background worker (no HTTP, no CLOB)',
    pid: process.pid,
    workerId: cluster.isWorker ? cluster.worker?.id : 'primary',
  });

  // Initialize Redis games cache (required for sharing data with HTTP workers)
  const redisInitialized = initRedisGamesCache();
  if (redisInitialized) {
    logger.info({ message: 'Redis games cache initialized for sports worker' });
  } else {
    logger.error({ message: 'Redis games cache REQUIRED for sports worker but failed to initialize!' });
  }

  // Initialize Redis broadcast (required for pushing updates to HTTP workers)
  const broadcastInitialized = initRedisGamesBroadcast();
  if (broadcastInitialized) {
    logger.info({ message: 'Redis broadcast initialized for sports worker' });
  } else {
    logger.error({ message: 'Redis broadcast REQUIRED for sports worker but failed to initialize!' });
  }

  // Initialize Privy (needed for some background operations like fee collection)
  privyService.initialize();

  // Start sports-specific services (NOT CLOB)
  initializeSportsServices();

  // Graceful shutdown for sports worker
  const shutdownSports = () => {
    logger.info({ message: 'Sports worker shutting down gracefully' });
    sportsWebSocketService.disconnect();
    shutdownRedisGamesBroadcast().catch(() => {});
    shutdownRedisGamesCache().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', shutdownSports);
  process.on('SIGINT', shutdownSports);
}

/**
 * Start the CLOB background worker that handles:
 * - CLOB WebSocket connection for real-time price updates
 * - Price update broadcasting to HTTP workers
 *
 * This worker is lightweight and focused only on high-frequency price updates.
 */
function startClobBackgroundWorker() {
  logger.info({
    message: 'Starting CLOB background worker (prices only)',
    pid: process.pid,
    workerId: cluster.isWorker ? cluster.worker?.id : 'primary',
  });

  // Initialize Redis games cache (required for reading game data)
  const redisInitialized = initRedisGamesCache();
  if (redisInitialized) {
    logger.info({ message: 'Redis games cache initialized for CLOB worker' });
  } else {
    logger.error({ message: 'Redis games cache REQUIRED for CLOB worker but failed to initialize!' });
  }

  // Initialize Redis broadcast (required for pushing price updates to HTTP workers)
  const broadcastInitialized = initRedisGamesBroadcast();
  if (broadcastInitialized) {
    logger.info({ message: 'Redis broadcast initialized for CLOB worker' });
  } else {
    logger.error({ message: 'Redis broadcast REQUIRED for CLOB worker but failed to initialize!' });
  }

  // Start CLOB price update service only
  initializeClobServices();

  // Graceful shutdown for CLOB worker
  const shutdownClob = async () => {
    logger.info({ message: 'CLOB worker shutting down gracefully' });
    clobPriceUpdateService.shutdown();
    cryptoClobPriceService.shutdown();
    cryptoOrderbookService.shutdown();
    cryptoChainlinkPriceService.shutdown();
    await kalshiPriceUpdateService.shutdown().catch(() => {});
    await shutdownRedisGamesBroadcast().catch(() => {});
    await shutdownRedisGamesCache().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', shutdownClob);
  process.on('SIGINT', shutdownClob);
}

/**
 * Start an HTTP worker that handles:
 * - HTTP API requests
 * - WebSocket connections FROM clients (games updates, activity watcher, positions)
 *
 * This worker does NOT run background services - it reads data from Redis cache.
 */
function startHttpWorker() {
  logger.info({
    message: 'Starting HTTP worker',
    pid: process.pid,
    workerId: cluster.isWorker ? cluster.worker?.id : 'primary',
  });

  // Initialize Privy for API requests (signing, verification, etc.)
  privyService.initialize();

  // Initialize Redis cluster broadcast (required for crypto/orderbook WebSocket Redis pub/sub)
  const broadcastInitialized = initRedisClusterBroadcast();
  if (broadcastInitialized) {
    logger.info({ message: 'Redis cluster broadcast initialized for HTTP worker (crypto/orderbook WS)' });
    // Bridge Redis deposits:balance → Alchemy webhook service so SSE balance streams receive updates
    // (webhook may hit a different HTTP worker than the one with the user's SSE connection)
    import('./services/redis-cluster-broadcast.service').then(({ subscribeToDepositsBalance }) => {
      subscribeToDepositsBalance((msg: unknown) => {
        alchemyWebhookService.forwardBalanceNotification(msg as import('./services/alchemy/alchemy-webhook.service').BalanceNotification);
      });
    });
    import('./routes/positions').then(({ initPortfolioRedisBridge }) => {
      initPortfolioRedisBridge();
    });
  } else {
    logger.warn({
      message: 'Redis cluster broadcast not available - crypto/orderbook WebSockets will not receive price updates',
      hint: 'Set REDIS_URL for multi-worker broadcasting',
    });
  }

  // Initialize Redis games cache (reads data written by background worker)
  const redisInitialized = initRedisGamesCache();
  if (redisInitialized) {
    logger.info({ message: 'Redis games cache initialized for HTTP worker' });
  } else {
    logger.warn({ message: 'Redis games cache not available - API may return stale data' });
  }

  // Initialize frontend games cache sync (subscribes to Redis for cache invalidation)
  // This ensures all HTTP workers clear their local cache when the DB is updated
  import('./services/polymarket/frontend-games.service').then(({ initFrontendGamesCacheSync }) => {
    initFrontendGamesCacheSync();
  }).catch((err) => {
    logger.warn({ message: 'Failed to init frontend games cache sync', error: err.message });
  });

  // Create HTTP server
  server = http.createServer(app);

  // Initialize client-facing WebSocket services
  gamesWebSocketService.initialize(server, '/ws/games');
  activityWatcherWebSocketService.initialize(server, '/ws/activity');
  positionsWebSocketService.initialize(server);
  cryptoMarketWebSocketService.initialize(server, '/ws/crypto');
  orderbookWebSocketService.initialize(server, '/ws/orderbook');
  cryptoLivePriceWebSocketService.initialize(server, '/ws/crypto-prices');

  // Start server
  server.listen(PORT, () => {
    console.log(`HTTP worker running on port ${PORT} (pid=${process.pid})`);
    console.log(`Swagger: http://localhost:${PORT}/api-docs`);
  });

  // Graceful shutdown for HTTP worker
  const shutdownHttp = () => {
    logger.info({ message: 'HTTP worker shutting down gracefully' });
    gamesWebSocketService.shutdown();
    activityWatcherWebSocketService.shutdown();
    positionsWebSocketService.shutdown();
    cryptoMarketWebSocketService.shutdown();
    orderbookWebSocketService.shutdown();
    cryptoLivePriceWebSocketService.shutdown();
    shutdownRedisClusterBroadcast().catch(() => {});
    shutdownRedisGamesCache().catch(() => {});
    if (server) {
      server.close(() => {
        logger.info({ message: 'HTTP server closed' });
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  };

  process.on('SIGTERM', shutdownHttp);
  process.on('SIGINT', shutdownHttp);
}

/**
 * Start in development mode (single process handles everything)
 */
function startDevelopmentServer() {
  privyService.initialize();
  initRedisGamesCache();
  initRedisClusterBroadcast();

  server = http.createServer(app);
  gamesWebSocketService.initialize(server, '/ws/games');
  activityWatcherWebSocketService.initialize(server, '/ws/activity');
  positionsWebSocketService.initialize(server);
  cryptoMarketWebSocketService.initialize(server, '/ws/crypto');
  orderbookWebSocketService.initialize(server, '/ws/orderbook');
  cryptoLivePriceWebSocketService.initialize(server, '/ws/crypto-prices');

  server.listen(PORT, () => {
    console.log(`Development server running on port ${PORT}`);
    console.log(`Swagger: http://localhost:${PORT}/api-docs`);
    initializeServices();
  });

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

const nodeEnv = process.env.NODE_ENV || 'development';

if (nodeEnv === 'production' && cluster.isPrimary) {
  // Total workers = 2 background (sports + CLOB) + N HTTP workers
  // With WORKER_COUNT=4: 2 background + 2 HTTP = 4 workers + 1 primary = 5 processes
  const totalWorkers = Number(process.env.WORKER_COUNT) || 4;
  const httpWorkerCount = Math.max(1, totalWorkers - 2); // At least 1 HTTP worker, 2 slots for background

  logger.info({
    message: 'Starting cluster master',
    pid: process.pid,
    totalWorkers,
    backgroundWorkers: 2,
    httpWorkers: httpWorkerCount,
  });

  // Track which workers are background workers
  let sportsWorkerId: number | null = null;
  let clobWorkerId: number | null = null;

  // Fork 1 dedicated SPORTS background worker (games, teams, scores)
  const sportsWorker = cluster.fork({ WORKER_TYPE: 'sports' });
  sportsWorkerId = sportsWorker.id;
  logger.info({ message: 'SPORTS background worker started', workerId: sportsWorker.id });

  // Fork 1 dedicated CLOB background worker (price updates only)
  const clobWorker = cluster.fork({ WORKER_TYPE: 'clob' });
  clobWorkerId = clobWorker.id;
  logger.info({ message: 'CLOB background worker started', workerId: clobWorker.id });

  // Fork HTTP workers
  for (let i = 0; i < httpWorkerCount; i++) {
    const worker = cluster.fork({ WORKER_TYPE: 'http' });
    logger.info({ message: 'HTTP worker started', workerId: worker.id });
  }

  cluster.on('exit', (worker, code, signal) => {
    let workerType = 'http';
    if (worker.id === sportsWorkerId) {
      workerType = 'sports';
    } else if (worker.id === clobWorkerId) {
      workerType = 'clob';
    }

    logger.error({
      message: `${workerType.toUpperCase()} worker exited, forking replacement`,
      workerId: worker.id,
      pid: worker.process.pid,
      code,
      signal,
    });

    // Fork a replacement worker of the same type
    const newWorker = cluster.fork({ WORKER_TYPE: workerType });
    if (workerType === 'sports') {
      sportsWorkerId = newWorker.id;
      logger.info({ message: 'New SPORTS worker started', workerId: newWorker.id });
    } else if (workerType === 'clob') {
      clobWorkerId = newWorker.id;
      logger.info({ message: 'New CLOB worker started', workerId: newWorker.id });
    } else {
      logger.info({ message: 'New HTTP worker started', workerId: newWorker.id });
    }
  });
} else if (nodeEnv === 'production' && cluster.isWorker) {
  // Cluster worker - check type and start appropriate mode
  const workerType = process.env.WORKER_TYPE || 'http';

  if (workerType === 'sports') {
    startSportsBackgroundWorker();
  } else if (workerType === 'clob') {
    startClobBackgroundWorker();
  } else {
    startHttpWorker();
  }
} else {
  // Development mode - single process handles everything
  startDevelopmentServer();
}

export default app;
export { server };
