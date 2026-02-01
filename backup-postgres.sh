#!/bin/bash
# PostgreSQL Backup Script
# Creates a backup of your database before applying configuration changes

set -e

BACKUP_DIR="./postgres-backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/mevu_backup_${TIMESTAMP}.sql"

echo "Creating backup directory if it doesn't exist..."
mkdir -p "$BACKUP_DIR"

echo "Creating PostgreSQL backup..."
echo "Backup file: $BACKUP_FILE"

docker exec mevu-postgres-1 pg_dump -U user -d mevu > "$BACKUP_FILE"

if [ $? -eq 0 ]; then
    BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo "✅ Backup created successfully!"
    echo "   File: $BACKUP_FILE"
    echo "   Size: $BACKUP_SIZE"
    echo ""
    echo "To restore this backup later, use:"
    echo "  docker exec -i mevu-postgres-1 psql -U user -d mevu < $BACKUP_FILE"
else
    echo "❌ Backup failed!"
    exit 1
fi
