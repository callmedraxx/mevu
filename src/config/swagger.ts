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
    },
  },
};

export const swaggerOptions = {
  definition: swaggerDefinition,
  apis: ['./src/routes/*.ts', './src/index.ts'],
};
