# MEVU - Market Event Value Updater

Express.js server for fetching and updating live games from Polymarket.

## Features

- Express.js server with TypeScript
- Docker support for production
- PostgreSQL for production, in-memory for development
- Swagger/OpenAPI documentation
- Hot reload development with tsx

## Development Setup

1. Install dependencies:
```bash
npm install
```

2. Copy environment variables:
```bash
cp .env.example .env
```

3. Start development server:
```bash
npm run dev
```

The server will run on `http://localhost:3000` and Swagger documentation will be available at `http://localhost:3000/api-docs`.

## Production Setup with Docker

1. Build and start services:
```bash
docker-compose up --build
```

2. The application will be available at `http://localhost:3000`
3. PostgreSQL will be available on port `5432`

## Scripts

- `npm run dev` - Start development server with hot reload (tsx)
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm run swagger` - Generate swagger.json file

## Project Structure

```
mevu/
├── src/
│   ├── config/
│   │   ├── swagger.ts      # Swagger configuration
│   │   └── database.ts     # Database configuration
│   ├── routes/
│   │   └── index.ts        # API routes
│   └── index.ts            # Express app entry point
├── dist/                   # Compiled JavaScript (generated)
├── Dockerfile              # Production Docker image
├── docker-compose.yml      # Docker Compose configuration
├── tsconfig.json           # TypeScript configuration
└── package.json            # Dependencies and scripts
```

## Environment Variables

- `NODE_ENV` - Environment (development/production)
- `PORT` - Server port (default: 3000)
- `DATABASE_URL` - PostgreSQL connection string (production only)
- `SWAGGER_BASE_URL` - Base URL for Swagger documentation

# mevu
