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

// Load environment variables
dotenv.config();

// Initialize logo mapping service
logoMappingService.initialize().catch((error) => {
  console.error('Failed to initialize logo mapping service:', error);
});

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:5173',
      'http://localhost:5174',
      'https://fa3795bc-6208-4282-97cc-8f1c26adec6c.lovableproject.com',
      /^https:\/\/.*\.lovableproject\.com$/, // Allow all Lovable project subdomains
      /^https:\/\/.*\.lovable\.app$/, // Allow all Lovable app subdomains (preview, etc.)
      'https://app.mevu.com',
      'https://mevu.com',
      /^https:\/\/.*\.mevu\.com$/, // Allow all mevu subdomains
    ];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, Postman, curl)
    if (!origin) {
      return callback(null, true);
    }

    // Check if origin matches any allowed origin
    const isAllowed = allowedOrigins.some(allowed => {
      if (typeof allowed === 'string') {
        return origin === allowed;
      } else if (allowed instanceof RegExp) {
        return allowed.test(origin);
      }
      return false;
    });

    if (isAllowed) {
      callback(null, true);
    } else {
      logger.warn({
        message: 'CORS blocked origin',
        origin,
        allowedOrigins: allowedOrigins.filter(o => typeof o === 'string'),
      });
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    
    // Initialize Privy service
    logger.info({ message: 'Initializing Privy service...' });
    privyService.initialize();
    
    // Initialize users table
    logger.info({ message: 'Initializing users table...' });
    await initializeUsersTable();
    
    // Initialize probability history table
    // logger.info({ message: 'Initializing probability history table...' });
    await initializeProbabilityHistoryTable();
    
    // Start live games polling service
    // logger.info({ message: 'Starting live games service...' });
    liveGamesService.start();
    
    // Start teams refresh service
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
