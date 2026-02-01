#!/bin/bash
# Run UFC moneyline debug script inside the app Docker container.
# Uses the container's DATABASE_URL (pgbouncer) to fetch game from live_games.
#
# Usage: ./scripts/run-debug-ufc-moneyline.sh
# Or:    bash scripts/run-debug-ufc-moneyline.sh

set -e
cd "$(dirname "$0")/.."

# Ensure app container is running
if ! docker compose ps app 2>/dev/null | grep -q "Up"; then
  echo "Starting app container..."
  docker compose up -d app
  sleep 5
fi

# Install tsx if missing (production image prunes dev deps)
# Then run the debug script with container's DATABASE_URL
docker compose exec app sh -c '
  if ! command -v npx >/dev/null 2>&1 || ! npx tsx --version 2>/dev/null; then
    echo "Installing tsx for one-off run..."
    npm install tsx --no-save
  fi
  npx tsx scripts/debug-ufc-moneyline.ts
'
