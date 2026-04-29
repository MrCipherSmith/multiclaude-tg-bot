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
# Merge stderr into the pipe so cron / log collectors see pg_dump warnings
# (e.g. "WARNING: schema permission denied for ...") that would otherwise
# only land on the controlling terminal. `pipefail` then catches non-zero
# exits from either pg_dump OR gzip.
docker exec "$PG_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl 2>&1 \
  | gzip -c > "$OUT"
RC=$?

if [ $RC -ne 0 ]; then
  echo "[backup] FAILED — pipeline returned $RC"
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

# gzip integrity test catches the partial-write case: a disk-full or
# IO error mid-stream produces a > 1 KB but corrupt archive that the
# size check alone would let pass. `gzip -t` does a full-archive
# verification by re-decompressing it; failure prints the error and
# returns non-zero.
if ! gzip -t "$OUT" 2>&1; then
  echo "[backup] FAILED — gzip integrity check failed"
  rm -f "$OUT"
  exit 1
fi

SIZE=$(du -h "$OUT" | cut -f1)
echo "[backup] OK: ${DB_NAME}_${TIMESTAMP}.sql.gz ($SIZE)"

# Rotate: keep last N backups. Quote the full path (not just $BACKUP_DIR)
# so spaces in $BACKUP_DIR or $DB_NAME — both env-var-overridable —
# don't cause word-splitting on the glob.
ls -t "${BACKUP_DIR}/${DB_NAME}"_*.sql.gz 2>/dev/null | tail -n +$((KEEP_DAYS + 1)) | xargs -r rm -f

REMAINING=$(ls "${BACKUP_DIR}/${DB_NAME}"_*.sql.gz 2>/dev/null | wc -l)
echo "[backup] Done. $REMAINING backups retained."
