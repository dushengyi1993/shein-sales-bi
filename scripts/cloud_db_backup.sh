#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_ROOT="${SHEIN_BI_BACKUP_ROOT:-/srv/shein-bi/backups/auto}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
RETENTION_DAYS="${SHEIN_BI_BACKUP_RETENTION_DAYS:-14}"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
OUT_DIR="$BACKUP_ROOT/$STAMP"

mkdir -p "$OUT_DIR"
echo "[cloud_db_backup] start out=$OUT_DIR"

docker exec shein-warehouse-db pg_dump -U shein -d shein_bi -Fc > "$OUT_DIR/shein_bi.dump"
if docker ps --format '{{.Names}}' | grep -qx 'shein-metabase-db'; then
  docker exec shein-metabase-db pg_dump -U metabase -d metabase -Fc > "$OUT_DIR/metabase.dump"
else
  echo "[cloud_db_backup] skip metabase.dump: shein-metabase-db is not running (Metabase is archived/manual)"
fi

find "$OUT_DIR" -maxdepth 1 -type f -name '*.dump' -print0 | xargs -0 sha256sum > "$OUT_DIR/SHA256SUMS.txt"

find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -print -exec rm -rf {} +

du -sh "$OUT_DIR"
echo "[cloud_db_backup] done out=$OUT_DIR retention_days=$RETENTION_DAYS"
