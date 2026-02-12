#!/usr/bin/env bash
# Check Docker logs for critical / error / flush messages in the past N hours.
# Usage: ./scripts/check-docker-logs.sh [hours]   (default: 7)

HOURS="${1:-7}"
SINCE="${HOURS}h"

# Patterns for critical issues
PATTERNS="error|Error|ERROR|critical|Critical|CRITICAL|flush|Flush|FLUSH|fatal|Fatal|FATAL|exception|Exception|ECONNREFUSED|ECONNRESET|timeout|Timeout|OOM|out of memory"

echo "=== Docker logs (past ${HOURS}h) – errors/critical/flush ==="

for cid in $(docker ps -q); do
  name=$(docker inspect -f '{{.Name}}' "$cid" | sed 's/^\///')
  echo "--- $name ---"
  docker logs "$cid" --since "$SINCE" 2>&1 | grep -iE "$PATTERNS" || true
  echo ""
done

echo "=== Done ==="
