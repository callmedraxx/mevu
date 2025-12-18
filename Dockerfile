FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# Copy migrations directory (needed at runtime for migration script)
COPY migrations ./migrations

# Expose port
EXPOSE 3000

# Start the application (migrations run automatically in index.ts on startup)
CMD ["npm", "start"]
