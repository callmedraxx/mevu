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
import { teamsRefreshService } from './services/polymarket/teams-refresh.service';
import { sportsWebSocketService } from './services/polymarket/sports-websocket.service';
import { gamesWebSocketService } from './services/polymarket/games-websocket.service';
import { initializeProbabilityHistoryTable, cleanupOldProbabilityHistory } from './services/polymarket/probability-history.service';
import { logger } from './config/logger';

// Load environment variables
dotenv.config();

// Initialize logo mapping service
logoMappingService.initialize().catch((error) => {
  console.error('Failed to initialize logo mapping service:', error);
});

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
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

// API routes
app.use('/api', apiRouter);

// Initialize services on startup
async function initializeServices() {
  try {
    // Initialize probability history table
    logger.info({ message: 'Initializing probability history table...' });
    await initializeProbabilityHistoryTable();
    
    // Start live games polling service
    logger.info({ message: 'Starting live games service...' });
    liveGamesService.start();
    
    // Start teams refresh service
    logger.info({ message: 'Starting teams refresh service...' });
    teamsRefreshService.start();
    
    // Start sports WebSocket for live updates
    logger.info({ message: 'Starting sports WebSocket service...' });
    sportsWebSocketService.connect().catch((error) => {
      logger.error({
        message: 'Failed to connect sports WebSocket',
        error: error instanceof Error ? error.message : String(error),
      });
    });
    
    // Set up periodic cleanup of old probability history (every 6 hours)
    setInterval(() => {
      cleanupOldProbabilityHistory(7).catch((error) => {
        logger.error({
          message: 'Error cleaning up probability history',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 6 * 60 * 60 * 1000);
    
    logger.info({ message: 'Services initialized successfully' });
  } catch (error) {
    logger.error({
      message: 'Error initializing services',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Create HTTP server (needed for WebSocket)
const server = http.createServer(app);

// Start server
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Swagger documentation available at http://localhost:${PORT}/api-docs`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws/games`);
  
  // Initialize WebSocket service with HTTP server
  gamesWebSocketService.initialize(server, '/ws/games');
  
  // Initialize other services after server starts
  initializeServices();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info({ message: 'SIGTERM received, shutting down gracefully' });
  gamesWebSocketService.shutdown();
  server.close(() => {
    logger.info({ message: 'HTTP server closed' });
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info({ message: 'SIGINT received, shutting down gracefully' });
  gamesWebSocketService.shutdown();
  server.close(() => {
    logger.info({ message: 'HTTP server closed' });
    process.exit(0);
  });
});

export default app;
export { server };
