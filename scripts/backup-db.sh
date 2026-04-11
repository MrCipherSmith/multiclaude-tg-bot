#!/bin/bash
# Daily PostgreSQL backup for Helyx.
# Usage: scripts/backup-db.sh
# Cron:  0 3 * * * /home/altsay/bots/helyx/scripts/backup-db.sh
#
# Keeps last 7 backups, gzipped.

BACKUP_DIR="${BACKUP_DIR:-/home/altsay/backups/helyx}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5433}"
DB_USER="${DB_USER:-helyx}"
DB_NAME="${DB_NAME:-helyx}"
DB_PASSWORD="${DB_PASSWORD:-helyx_secret}"
KEEP_DAYS=7

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

echo "[backup] Starting at $(date)"

PGPASSWORD="$DB_PASSWORD" pg_dump \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME" \
  | gzip > "$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql.gz"

if [ $? -eq 0 ]; then
  SIZE=$(du -h "$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql.gz" | cut -f1)
  echo "[backup] OK: ${DB_NAME}_${TIMESTAMP}.sql.gz ($SIZE)"
else
  echo "[backup] FAILED"
  exit 1
fi

# Rotate: keep last N backups
ls -t "$BACKUP_DIR"/${DB_NAME}_*.sql.gz 2>/dev/null | tail -n +$((KEEP_DAYS + 1)) | xargs rm -f 2>/dev/null

REMAINING=$(ls "$BACKUP_DIR"/${DB_NAME}_*.sql.gz 2>/dev/null | wc -l)
echo "[backup] Done. $REMAINING backups retained."
