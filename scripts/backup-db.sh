#!/bin/bash
# Daily PostgreSQL backup for Helyx.
# Usage: scripts/backup-db.sh
# Cron:  0 3 * * * /home/altsay/bots/helyx/scripts/backup-db.sh
#
# Keeps last 7 backups, gzipped.
#
# Runs pg_dump INSIDE the helyx-postgres-1 container so the host
# doesn't need postgres-client installed. The dump is streamed back
# over docker exec stdout, gzipped on the host, written to BACKUP_DIR.

set -o pipefail

BACKUP_DIR="${BACKUP_DIR:-/home/altsay/backups/helyx}"
PG_CONTAINER="${PG_CONTAINER:-helyx-postgres-1}"
DB_USER="${DB_USER:-helyx}"
DB_NAME="${DB_NAME:-helyx}"
KEEP_DAYS=7

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

echo "[backup] Starting at $(date)"

# Verify container is running BEFORE we create an empty file.
if ! docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  echo "[backup] FAILED — container '$PG_CONTAINER' not running"
  exit 2
fi

OUT="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql.gz"
docker exec "$PG_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl \
  | gzip -c > "$OUT"
RC=$?

# `pipefail` makes this catch failures from either pg_dump or gzip.
if [ $RC -ne 0 ]; then
  echo "[backup] FAILED — pg_dump returned $RC"
  rm -f "$OUT"
  exit 1
fi

SIZE_BYTES=$(stat -c%s "$OUT" 2>/dev/null || echo 0)
if [ "$SIZE_BYTES" -lt 1024 ]; then
  # < 1 KB means pg_dump produced almost nothing — likely an error
  # not surfaced via exit code (e.g. an early stderr crash).
  echo "[backup] FAILED — output suspiciously small ($SIZE_BYTES bytes)"
  rm -f "$OUT"
  exit 1
fi

SIZE=$(du -h "$OUT" | cut -f1)
echo "[backup] OK: ${DB_NAME}_${TIMESTAMP}.sql.gz ($SIZE)"

# Rotate: keep last N backups
ls -t "$BACKUP_DIR"/${DB_NAME}_*.sql.gz 2>/dev/null | tail -n +$((KEEP_DAYS + 1)) | xargs rm -f 2>/dev/null

REMAINING=$(ls "$BACKUP_DIR"/${DB_NAME}_*.sql.gz 2>/dev/null | wc -l)
echo "[backup] Done. $REMAINING backups retained."
