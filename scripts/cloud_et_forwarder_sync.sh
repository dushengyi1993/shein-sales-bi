#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TARGET="${1:-today}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_ET_LOG_DIR:-/srv/shein-bi/logs/cloud-et-forwarder}"
METABASE_URL="${METABASE_URL:-http://127.0.0.1:3000}"
PORTAL_HEALTH_URL="${PORTAL_HEALTH_URL:-}"
PORTAL_INDEX_PATH="${PORTAL_INDEX_PATH:-$ROOT/outputs/bi-portal/index.html}"
PORTAL_DATA_PATH="${PORTAL_DATA_PATH:-$ROOT/outputs/bi-portal/data.json}"
LOCK_FILE="${SHEIN_ET_LOCK_FILE:-/tmp/shein-bi-cloud-et-forwarder.lock}"

resolve_date() {
  local target="$1"
  case "$target" in
    today)
      TZ="$TZ_NAME" date +%F
      ;;
    yesterday)
      TZ="$TZ_NAME" date -d 'yesterday' +%F
      ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
      printf '%s\n' "$target"
      ;;
    *)
      echo "Unsupported ET date target: $target" >&2
      exit 64
      ;;
  esac
}

mkdir -p "$LOG_DIR"
DATE="$(resolve_date "$TARGET")"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/et-forwarder-${DATE}-${STAMP}.log"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[cloud_et_forwarder_sync] another ET sync is running; skip"
  exit 0
fi

exec > >(tee -a "$LOG_FILE") 2>&1

notify_issue() {
  local message="$1"
  if command -v lark-cli >/dev/null 2>&1 && [[ -f "$ROOT/config/lark_report.json" ]]; then
    node "$ROOT/scripts/notify_sync_issue.mjs" \
      --mode "cloud-et-forwarder" \
      --date "$DATE" \
      --failed-stores "ET" \
      --message "$message" \
      --log-file "$LOG_FILE" || true
  fi
}

check_portal_health() {
  if [[ ! -s "$PORTAL_INDEX_PATH" ]]; then
    echo "BI Portal index is missing or empty: $PORTAL_INDEX_PATH" >&2
    exit 1
  fi
  if [[ ! -s "$PORTAL_DATA_PATH" ]]; then
    echo "BI Portal data is missing or empty: $PORTAL_DATA_PATH" >&2
    exit 1
  fi
  if [[ -n "$PORTAL_HEALTH_URL" ]]; then
    curl -fsS --max-time 15 "$PORTAL_HEALTH_URL" >/dev/null
  else
    echo "[cloud_et_forwarder_sync] portal files ok index=$PORTAL_INDEX_PATH data=$PORTAL_DATA_PATH"
  fi
}

on_error() {
  local code=$?
  notify_issue "Cloud ET forwarder sync failed; BI will keep the previous ET warehouse data. See log: $LOG_FILE"
  echo "[cloud_et_forwarder_sync] failed code=$code date=$DATE log=$LOG_FILE"
  exit "$code"
}
trap on_error ERR

echo "[cloud_et_forwarder_sync] start date=$DATE root=$ROOT"
cd "$ROOT"

node scripts/fetch_et_forwarder.mjs \
  --mode daily \
  --date "$DATE" \
  --overlap-rows "${SHEIN_ET_OVERLAP_ROWS:-5}" \
  --daily-initial-pages "${SHEIN_ET_DAILY_INITIAL_PAGES:-2}" \
  --max-details "${SHEIN_ET_MAX_DETAILS:-50}" \
  --wait-ms "${SHEIN_ET_WAIT_MS:-250}"

MANIFEST_PATH="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('outputs/et-forwarder/latest-manifest.json','utf8'));process.stdout.write(j.manifestPath||'')")"
if [[ -z "$MANIFEST_PATH" ]]; then
  echo "ET latest manifest path is empty" >&2
  exit 1
fi

node scripts/load_et_forwarder_warehouse.mjs --manifest "$MANIFEST_PATH"

if [[ "${SHEIN_ET_REFRESH_PORTAL:-1}" == "1" ]]; then
  node scripts/generate_bi_portal.mjs --metabase-url "$METABASE_URL"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl restart shein-bi-portal.service || true
  fi
  check_portal_health
fi

echo "[cloud_et_forwarder_sync] done date=$DATE manifest=$MANIFEST_PATH log=$LOG_FILE"
