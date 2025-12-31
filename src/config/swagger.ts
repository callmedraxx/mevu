import { SwaggerDefinition } from 'swagger-jsdoc';

const swaggerDefinition: SwaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'MEVU API',
    version: '1.0.0',
    description: 'Market Event Value Updater API - Fetch and update live games from Polymarket',
    contact: {
      name: 'API Support',
    },
  },
  servers: [
    {
      url: process.env.SWAGGER_BASE_URL || 'http://localhost:3000',
      description: 'Development server',
    },
  ],
  tags: [
    {
      name: 'Health',
      description: 'Health check endpoints',
    },
    {
      name: 'Games',
      description: 'Live games endpoints - fetch games, SSE updates, and frontend-formatted data',
    },
    {
      name: 'Teams',
      description: 'Team data and logo management endpoints',
    },
    {
      name: 'Logos',
      description: 'Team logo endpoints',
    },
    {
      name: 'ActivityWatcher',
      description: 'Per-game activity watcher with markets and SSE updates',
    },
    {
      name: 'Trades',
      description: 'Live trade widget endpoints - fetch and display trades for games',
    },
    {
      name: 'Holders',
      description: 'Top holders endpoints - fetch and display top holders for games',
    },
    {
      name: 'WhaleWatcher',
      description: 'Whale watcher endpoints - fetch and display whale trades (amount >= $1000) for games',
    },
    {
      name: 'LiveStats',
      description: 'Live stats widget endpoints - fetch period scores and live game statistics',
    },
    {
      name: 'Users',
      description: 'User registration, proxy wallet deployment, and token approvals for Polymarket trading',
    },
    {
      name: 'Trading',
      description: 'Buy and sell markets on Polymarket CLOB with gasless transactions. Also includes USDC.e withdrawal functionality.',
    },
    {
      name: 'Positions',
      description: 'User positions and portfolio tracking endpoints',
    },
  ],
  components: {
    schemas: {
      Error: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
            example: false,
          },
          error: {
            type: 'string',
          },
        },
      },
      Team: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          league: { type: 'string' },
          record: { type: 'string' },
          logo: { type: 'string' },
          abbreviation: { type: 'string' },
        },
      },
      FrontendGame: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          time: { type: 'string', example: '7:00 PM EST' },
          volume: { type: 'string', example: '$612.4k' },
          awayTeam: {
            type: 'object',
            properties: {
              abbr: { type: 'string', example: 'WAS' },
              name: { type: 'string', example: 'Wizards' },
              record: { type: 'string', example: '3-18' },
              buyPrice: { type: 'number', example: 20 },
              sellPrice: { type: 'number', example: 21 },
              score: { type: 'number', example: 87 },
            },
          },
          homeTeam: {
            type: 'object',
            properties: {
              abbr: { type: 'string', example: 'PHX' },
              name: { type: 'string', example: 'Suns' },
              record: { type: 'string', example: '15-6' },
              buyPrice: { type: 'number', example: 80 },
              sellPrice: { type: 'number', example: 81 },
              score: { type: 'number', example: 92 },
            },
          },
          liquidity: { type: 'string', example: '$2.50M' },
          chartData: { type: 'array', items: { type: 'number' } },
          percentChange: { type: 'number', example: 3.4 },
          traders: { type: 'number', example: 207 },
          spread: { type: 'string', example: '1-2¢' },
          isLive: { type: 'boolean' },
          quarter: { type: 'string', example: '3Q' },
          gameTime: { type: 'string', example: '5:45' },
        },
      },
      ActivityWatcherOutcome: {
        type: 'object',
        properties: {
          label: { type: 'string', example: 'Lakers' },
          shortLabel: { type: 'string', example: 'LAL' },
          price: { type: 'number', example: 65.5 },
          probability: { type: 'number', example: 65.5 },
          clobTokenId: { 
            type: 'string', 
            example: '16678291189211314787145083999015737376658799626130630684070927984975568281601',
            description: 'CLOB token ID for trading this specific outcome',
          },
        },
      },
      ActivityWatcherMarket: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '12345' },
          title: { type: 'string', example: 'Will Team A win?' },
          question: { type: 'string', example: 'Will Team A win?', description: 'Full market question for trading context' },
          volume: { type: 'string', example: '$250k' },
          liquidity: { type: 'string', example: '$1.2M' },
          outcomes: {
            type: 'array',
            items: { $ref: '#/components/schemas/ActivityWatcherOutcome' },
            example: [
              { label: 'Lakers', shortLabel: 'LAL', price: 65.5, probability: 65.5, clobTokenId: '166782...' },
              { label: 'Warriors', shortLabel: 'GSW', price: 34.5, probability: 34.5, clobTokenId: '234567...' },
            ],
          },
          conditionId: { 
            type: 'string', 
            example: '0x1234567890abcdef',
            description: 'Market condition ID for trading contract',
          },
          clobTokenIds: { 
            type: 'array',
            items: { type: 'string' },
            example: ['16678291189211314787145083999015737376658799626130630684070927984975568281601', '23456789012345678901234567890123456789012345678901234567890123456789012345'],
            description: 'Token IDs for all outcomes',
          },
          negRisk: { 
            type: 'boolean',
            example: false,
            description: 'If true, uses negative risk trading',
          },
          negRiskMarketId: { 
            type: 'string',
            example: '0xabcdef1234567890',
            description: 'Negative risk market ID (required if negRisk is true)',
          },
        },
      },
      ActivityWatcherGame: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          slug: { type: 'string' },
          sport: { type: 'string', example: 'nba' },
          league: { type: 'string', example: 'nba' },
          homeTeam: { $ref: '#/components/schemas/FrontendGame/properties/homeTeam' },
          awayTeam: { $ref: '#/components/schemas/FrontendGame/properties/awayTeam' },
          markets: {
            type: 'array',
            items: { $ref: '#/components/schemas/ActivityWatcherMarket' },
          },
        },
      },
      TransformedTrade: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['Buy', 'Sell'], example: 'Buy' },
          amount: { type: 'number', example: 5.66, description: 'Dollar amount (shares * price)' },
          shares: { type: 'number', example: 18.26, description: 'Number of shares' },
          price: { type: 'number', example: 31, description: 'Price multiplied by 100 (e.g., 0.31 -> 31)' },
          trader: { type: 'string', example: '0x3a090da22b2bcfee0f3125a26265efbcd356f9f7', description: 'Trader proxy wallet address' },
          traderAvatar: { type: 'string', example: '' },
          outcome: { type: 'string', example: 'Falcons' },
          awayTeam: { $ref: '#/components/schemas/FrontendGame/properties/awayTeam' },
          homeTeam: { $ref: '#/components/schemas/FrontendGame/properties/homeTeam' },
          time: { type: 'string', format: 'date-time', example: '2025-12-11T12:00:00.000Z' },
        },
      },
      HolderAsset: {
        type: 'object',
        properties: {
          assetId: { type: 'string', example: '13418209068108241811582544181319225659671692055851508749598025092643070994419' },
          shortLabel: { type: 'string', example: 'YES' },
          question: { type: 'string', example: 'Over 220.5 Points', description: 'Market question for context' },
          amount: { type: 'number', example: 170 },
        },
      },
      TransformedHolder: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '1,2,3', description: 'Database IDs comma-separated' },
          rank: { type: 'number', example: 1, description: 'Rank based on total amount' },
          wallet: { type: 'string', example: '0xead152b855effa6b5b5837f53b24c0756830c76a' },
          totalAmount: { type: 'number', example: 145000 },
          assets: {
            type: 'array',
            items: { $ref: '#/components/schemas/HolderAsset' },
          },
        },
      },
      WhaleTrade: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '12345', description: 'Database ID as string' },
          trader: { type: 'string', example: '0x3a090da22b2bcfee0f3125a26265efbcd356f9f7', description: 'Proxy wallet address' },
          type: { type: 'string', enum: ['buy', 'sell'], example: 'buy', description: 'Trade type (lowercase)' },
          team: {
            type: 'object',
            properties: {
              homeTeam: { $ref: '#/components/schemas/FrontendGame/properties/homeTeam' },
              awayTeam: { $ref: '#/components/schemas/FrontendGame/properties/awayTeam' },
            },
            description: 'Both team objects',
          },
          amount: { type: 'number', example: 1500.50, description: 'Trade amount in dollars (price * size)' },
          price: { type: 'number', example: 65, description: 'Price in cents (price * 100)' },
          time: { type: 'string', format: 'date-time', example: '2025-12-11T12:00:00.000Z', description: 'ISO timestamp from created_at' },
          shares: { type: 'number', example: 23.08, description: 'Number of shares (size field)' },
        },
      },
      PeriodScores: {
        type: 'object',
        description: 'Period scores indexed by normalized period keys (q1, q2, q3, q4, p1, p2, p3, 1h, 2h, ot)',
        additionalProperties: {
          type: 'object',
          properties: {
            home: { type: 'number', example: 25 },
            away: { type: 'number', example: 20 },
          },
        },
        example: {
          q1: { home: 25, away: 20 },
          q2: { home: 30, away: 25 },
        },
      },
      FinalScore: {
        type: 'object',
        properties: {
          home: { type: 'number', example: 99 },
          away: { type: 'number', example: 82 },
        },
      },
      LiveStats: {
        type: 'object',
        properties: {
          homeTeam: { $ref: '#/components/schemas/FrontendGame/properties/homeTeam' },
          awayTeam: { $ref: '#/components/schemas/FrontendGame/properties/awayTeam' },
          periodScores: {
            oneOf: [
              { $ref: '#/components/schemas/PeriodScores' },
              { type: 'null' },
            ],
            description: 'Period scores object, or null for games with period "NS" (not started)',
          },
          finalScore: {
            oneOf: [
              { $ref: '#/components/schemas/FinalScore' },
              { type: 'null' },
            ],
            description: 'Final score object, or null for games with period "NS" (not started)',
          },
          currentPeriod: { type: 'string', example: 'Q2', description: 'Current period (e.g., Q1, Q2, P1, 1H, NS)' },
          isLive: { type: 'boolean', example: true, description: 'Whether the game is currently live' },
        },
      },
    },
  },
};

// Determine which files to scan based on environment
// In production (Docker), files are compiled to dist/, in development they're in src/
const isProduction = process.env.NODE_ENV === 'production';
const apiPaths = isProduction
  ? ['./dist/routes/*.js', './dist/index.js']
  : ['./src/routes/*.ts', './src/index.ts'];

export const swaggerOptions = {
  definition: swaggerDefinition,
  apis: apiPaths,
};
