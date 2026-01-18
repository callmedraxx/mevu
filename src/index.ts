import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import http from 'http';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import { swaggerOptions } from './config/swagger';
import apiRouter from './routes';
import { logoMappingService } from './services/espn/logo-mapping.service';
import { liveGamesService } from './services/polymarket/live-games.service';
import { sportsGamesService } from './services/polymarket/sports-games.service';
import { teamsService } from './services/polymarket/teams.service';
import { privyService } from './services/privy/privy.service';
import { initializeUsersTable } from './services/privy/user.service';
import { teamsRefreshService } from './services/polymarket/teams-refresh.service';
import { sportsWebSocketService } from './services/polymarket/sports-websocket.service';
import { gamesWebSocketService } from './services/polymarket/games-websocket.service';
import { activityWatcherWebSocketService } from './services/polymarket/activity-watcher-websocket.service';
import { clobPriceUpdateService } from './services/polymarket/clob-price-update.service';
import { positionsWebSocketService } from './services/positions/positions-websocket.service';
import { initializeProbabilityHistoryTable, cleanupOldProbabilityHistory } from './services/polymarket/probability-history.service';
import { logger } from './config/logger';
import { runMigrations } from './scripts/run-migrations';
// DEPRECATED: polygonUsdcBalanceService - replaced by Alchemy webhooks
// import { polygonUsdcBalanceService } from './services/polygon/polygon-usdc-balance.service';
import { alchemyWebhookService } from './services/alchemy/alchemy-webhook.service';
import { embeddedWalletBalanceService } from './services/privy/embedded-wallet-balance.service';
import { autoTransferService } from './services/privy/auto-transfer.service';
import { depositProgressService } from './services/privy/deposit-progress.service';

// Load environment variables
dotenv.config();

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

// Initialize services on startup
async function initializeServices() {
  try {
    // Run database migrations first
    const nodeEnv = process.env.NODE_ENV || 'development';
    if (nodeEnv === 'production') {
      logger.info({ message: 'Running database migrations...' });
      await runMigrations();
      logger.info({ message: 'Database migrations completed' });
    }
    
    // Initialize Privy service (no DB connection needed)
    logger.info({ message: 'Initializing Privy service...' });
    privyService.initialize();
    
    // Stagger database-dependent service initialization to prevent connection pool exhaustion
    // Initialize users table
    logger.info({ message: 'Initializing users table...' });
    await initializeUsersTable();
    
    // Small delay to allow previous connection to complete
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Initialize probability history table
    // logger.info({ message: 'Initializing probability history table...' });
    await initializeProbabilityHistoryTable();
    
    // Longer delay before starting services that make immediate DB connections
    // This prevents connection pool exhaustion
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Start live games polling service (delayed initial refresh built into service)
    // logger.info({ message: 'Starting live games service...' });
    liveGamesService.start();
    
    // Additional delay before starting sports games service
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Start sports games polling service (fetches upcoming games from Polymarket series API)
    // This service fetches games by series_id (e.g., NFL, NBA) which includes upcoming games
    // that may not appear in the live games endpoint yet
    logger.info({ message: 'Starting sports games service...' });
    sportsGamesService.start();
    
    // Additional delay before starting teams refresh service
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Start teams refresh service (delayed initial refresh built into service)
    // logger.info({ message: 'Starting teams refresh service...' });
    teamsRefreshService.start();
    
    // DEPRECATED: Old WebSocket balance watcher - replaced by Alchemy webhooks
    // The polygonUsdcBalanceService is no longer used for balance tracking
    // Alchemy webhooks provide more reliable, push-based balance updates
    
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
      // Don't fail startup if Alchemy webhook fails
    }
    
    // Initialize embedded wallet balance service (listens to Alchemy webhook events)
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
    
    // Initialize auto-transfer service (listens to embedded wallet balance events)
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
    
    // Start sports WebSocket for live game score updates
    logger.info({ message: 'Starting sports WebSocket service...' });
    sportsWebSocketService.connect().catch((error) => {
      logger.error({
        message: 'Failed to connect sports WebSocket',
        error: error instanceof Error ? error.message : String(error),
      });
    });
    
    // Initialize CLOB price update service for real-time odds/probability updates
    logger.info({ message: 'Initializing CLOB price update service...' });
    clobPriceUpdateService.initialize().catch((error) => {
      logger.error({
        message: 'Failed to initialize CLOB price update service',
        error: error instanceof Error ? error.message : String(error),
      });
    });
    
    // Set up periodic cleanup of old probability history (every 6 hours)
    setInterval(() => {
      cleanupOldProbabilityHistory(7).catch((error) => {
        // logger.error({
        //   message: 'Error cleaning up probability history',
        //   error: error instanceof Error ? error.message : String(error),
        // });
      });
    }, 6 * 60 * 60 * 1000);
    
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
      }, 5 * 60 * 1000); // 5 minutes
      
      logger.info({ message: 'Fee retry background job started (runs every 5 minutes)' });
    }
    
    // Balance tracking is now handled by Alchemy webhooks
    // No need to manually restore - webhooks are synced on startup
    
    // logger.info({ message: 'Services initialized successfully' });
  } catch (error) {
    logger.error({
      message: 'Error initializing services',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Create HTTP server (needed for WebSocket)
const server = http.createServer(app);

// Initialize WebSocket services BEFORE server starts listening
// These services handle their own upgrade requests with noServer mode
gamesWebSocketService.initialize(server, '/ws/games');
activityWatcherWebSocketService.initialize(server, '/ws/activity');
positionsWebSocketService.initialize(server);

// Start server
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Swagger documentation available at http://localhost:${PORT}/api-docs`);
  console.log(`WebSocket endpoints:`);
  console.log(`  - Games updates: ws://localhost:${PORT}/ws/games`);
  console.log(`  - Activity watcher: ws://localhost:${PORT}/ws/activity`);

  // Initialize other services after server starts
  initializeServices();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info({ message: 'SIGTERM received, shutting down gracefully' });
  gamesWebSocketService.shutdown();
  activityWatcherWebSocketService.shutdown();
  positionsWebSocketService.shutdown();
  clobPriceUpdateService.shutdown();
  server.close(() => {
    logger.info({ message: 'HTTP server closed' });
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info({ message: 'SIGINT received, shutting down gracefully' });
  gamesWebSocketService.shutdown();
  activityWatcherWebSocketService.shutdown();
  positionsWebSocketService.shutdown();
  clobPriceUpdateService.shutdown();
  server.close(() => {
    logger.info({ message: 'HTTP server closed' });
    process.exit(0);
  });
});

export default app;
export { server };
