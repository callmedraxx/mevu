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
      description: 'Game management endpoints',
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
          message: {
            type: 'string',
          },
          error: {
            type: 'string',
          },
        },
      },
    },
  },
};

export const swaggerOptions = {
  definition: swaggerDefinition,
  apis: ['./src/routes/*.ts', './src/index.ts'],
};

