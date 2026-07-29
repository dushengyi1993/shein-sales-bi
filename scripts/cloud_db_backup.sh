#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_ROOT="${SHEIN_BI_BACKUP_ROOT:-/srv/shein-bi/backups/auto}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
RETENTION_DAYS="${SHEIN_BI_BACKUP_RETENTION_DAYS:-7}"
COS_MOUNT="${SHEIN_BI_BACKUP_COS_MOUNT:-/lhcos-data}"
COS_ARCHIVE_ROOT="${SHEIN_BI_BACKUP_COS_ARCHIVE_ROOT:-$COS_MOUNT/shein-bi-db-backups}"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
OUT_DIR="$BACKUP_ROOT/$STAMP"

PRUNE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --prune-only) PRUNE_ONLY=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 64 ;;
  esac
done

cos_ready() {
  local probe
  mountpoint -q "$COS_MOUNT" || return 1
  [[ -d "$COS_MOUNT" && -w "$COS_MOUNT" ]] || return 1
  probe="$COS_MOUNT/.shein-bi-db-backup-probe-$STAMP-$$"
  printf 'probe %s\n' "$STAMP" > "$probe" || return 1
  [[ -s "$probe" ]] || return 1
  rm -f -- "$probe"
}

archive_and_remove() {
  local source_dir base archive_day archive_dir archive partial checksum checksum_partial
  source_dir="$1"
  base="$(basename "$source_dir")"
  [[ "$source_dir" == "$BACKUP_ROOT"/* && -d "$source_dir" ]] || {
    echo "[cloud_db_backup] refuse unsafe retention path=$source_dir" >&2
    return 73
  }
  [[ -s "$source_dir/SHA256SUMS.txt" ]] || {
    echo "[cloud_db_backup] keep unverified backup=$source_dir reason=missing-checksums" >&2
    return 0
  }
  if ! sha256sum -c "$source_dir/SHA256SUMS.txt" >/dev/null; then
    echo "[cloud_db_backup] keep unverified backup=$source_dir reason=checksum-mismatch" >&2
    return 0
  fi

  archive_day="$(TZ="$TZ_NAME" date -r "$source_dir" +%Y-%m-%d)"
  archive_dir="$COS_ARCHIVE_ROOT/$archive_day"
  archive="$archive_dir/$base.tar.gz"
  partial="$archive_dir/.$base.tar.gz.partial-$STAMP-$$"
  checksum="$archive.sha256"
  checksum_partial="$archive_dir/.$base.tar.gz.sha256.partial-$STAMP-$$"
  mkdir -p "$archive_dir"

  if [[ ! -s "$archive" ]]; then
    tar -C "$BACKUP_ROOT" -czf "$partial" "$base"
    gzip -t "$partial"
    tar -tzf "$partial" >/dev/null
    mv -- "$partial" "$archive"
  fi
  gzip -t "$archive"
  tar -tzf "$archive" >/dev/null
  (
    cd "$archive_dir"
    sha256sum "$(basename "$archive")" > "$checksum_partial"
    sha256sum -c "$checksum_partial" >/dev/null
    mv -- "$checksum_partial" "$checksum"
    sha256sum -c "$(basename "$checksum")" >/dev/null
  )

  rm -rf -- "$source_dir"
  echo "[cloud_db_backup] archived=$archive removed=$source_dir"
}

prune_expired() {
  local expired=()
  mapfile -d '' expired < <(
    find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d \
      -mtime +"$RETENTION_DAYS" -print0
  )
  if (( ${#expired[@]} == 0 )); then
    echo "[cloud_db_backup] retention no expired backups"
    return 0
  fi
  if ! cos_ready; then
    echo "[cloud_db_backup] retention skipped: COS unavailable; local backups preserved" >&2
    return 0
  fi
  for source_dir in "${expired[@]}"; do
    archive_and_remove "$source_dir"
  done
}

mkdir -p "$BACKUP_ROOT"
if (( PRUNE_ONLY == 0 )); then
  mkdir -p "$OUT_DIR"
  echo "[cloud_db_backup] start out=$OUT_DIR"

  docker exec shein-warehouse-db pg_dump -U shein -d shein_bi -Fc > "$OUT_DIR/shein_bi.dump"
  if docker ps --format '{{.Names}}' | grep -qx 'shein-metabase-db'; then
    docker exec shein-metabase-db pg_dump -U metabase -d metabase -Fc > "$OUT_DIR/metabase.dump"
  else
    echo "[cloud_db_backup] skip metabase.dump: shein-metabase-db is not running (Metabase is archived/manual)"
  fi

  find "$OUT_DIR" -maxdepth 1 -type f -name '*.dump' -print0 |
    sort -z |
    xargs -0 sha256sum > "$OUT_DIR/SHA256SUMS.txt"
  du -sh "$OUT_DIR"
else
  echo "[cloud_db_backup] prune-only"
fi

prune_expired
echo "[cloud_db_backup] done out=${OUT_DIR:-none} retention_days=$RETENTION_DAYS prune_only=$PRUNE_ONLY"
