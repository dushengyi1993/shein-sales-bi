#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
source "$ROOT/scripts/lib/shared_lock.sh"
TARGET="${1:-today}"
MODE="${SHEIN_ET_SYNC_MODE:-daily}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_ET_LOG_DIR:-/srv/shein-bi/logs/cloud-et-forwarder}"
METABASE_URL="${METABASE_URL:-http://127.0.0.1:3000}"
PORTAL_HEALTH_URL="${PORTAL_HEALTH_URL:-}"
PORTAL_INDEX_PATH="${PORTAL_INDEX_PATH:-$ROOT/outputs/bi-portal/index.html}"
PORTAL_DATA_PATH="${PORTAL_DATA_PATH:-$ROOT/outputs/bi-portal/data.json}"
LOCK_FILE="${SHEIN_ET_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-et-forwarder.lock}"
PORTAL_REFRESH_LOCK_FILE="${SHEIN_BI_PORTAL_REFRESH_LOCK_FILE:-$ROOT/state/locks/shein-bi-portal-refresh.lock}"
PORTAL_REFRESH_LOCK_WAIT_SEC="${SHEIN_BI_PORTAL_REFRESH_LOCK_WAIT_SEC:-1800}"
WAIT_SERVICES="${SHEIN_ET_WAIT_SERVICES:-shein-bi-cloud-today.service shein-bi-cloud-yesterday.service shein-bi-cloud-session-manager.service shein-bi-db-backup.service}"
SKIP_IF_SERVICES="${SHEIN_ET_SKIP_IF_SERVICES:-shein-bi-cloud-daily-refresh.service}"
ET_CHROME_PROFILE_NAME="persistent-et-forwarder-profile"
ET_CHROME_TMP_DIR="${SHEIN_ET_CHROME_TMP_DIR:-/tmp/shein-bi-et-forwarder-chrome-tmp}"
ET_CLEANUP_LEGACY_CHROME_TMP="${SHEIN_ET_CLEANUP_LEGACY_CHROME_TMP:-1}"

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
if [[ "$TARGET" == "ship-backfill" || "$TARGET" == "ship-full" ]]; then
  MODE="backfill"
  DATE="$(TZ="$TZ_NAME" date +%F)"
else
  DATE="$(resolve_date "$TARGET")"
fi
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/et-forwarder-${DATE}-${STAMP}.log"

prepare_shared_lock_file "$LOCK_FILE"
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


is_service_active() {
  local service="$1"
  command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$service"
}

active_services_from_list() {
  local active=()
  local service
  for service in $1; do
    if is_service_active "$service"; then
      active+=("$service")
    fi
  done
  printf '%s\n' "${active[*]}"
}

protect_et_capacity() {
  local active
  active="$(active_services_from_list "$SKIP_IF_SERVICES")"
  if [[ -n "$active" ]]; then
    echo "[cloud_et_forwarder_sync] SKIP capacity: services active=$active; daily slow refresh has priority, next ET timer will retry"
    exit 0
  fi
  local timeout="${SHEIN_ET_WAIT_BUSY_TIMEOUT_SEC:-2700}"
  local interval="${SHEIN_ET_WAIT_BUSY_INTERVAL_SEC:-30}"
  local elapsed=0
  while true; do
    active="$(active_services_from_list "$WAIT_SERVICES")"
    if [[ -z "$active" ]]; then
      return 0
    fi
    if (( elapsed >= timeout )); then
      echo "[cloud_et_forwarder_sync] SKIP busy services still active after ${timeout}s: $active; next ET timer will retry"
      exit 0
    fi
    echo "[cloud_et_forwarder_sync] wait busy services: $active elapsed=${elapsed}s"
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
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

prepare_et_chrome_tmp() {
  if [[ "${SHEIN_ET_CLEANUP_BROWSER:-1}" == "0" || "${SHEIN_ET_CLEANUP_BROWSER:-1}" == "false" ]]; then
    return 0
  fi
  mkdir -p "$ET_CHROME_TMP_DIR"
  chmod 0700 "$ET_CHROME_TMP_DIR" 2>/dev/null || true
  export TMPDIR="$ET_CHROME_TMP_DIR"
  echo "[cloud_et_forwarder_sync] chrome tmp dir=$TMPDIR"
}

live_chrome_process_count() {
  ps -eo comm= | awk '/^(chrome|chromium|chromium-browser|google-chrome|google-chrome-stable)$/ {c++} END {print c+0}'
}

cleanup_et_browser() {
  if [[ "${SHEIN_ET_CLEANUP_BROWSER:-1}" == "0" || "${SHEIN_ET_CLEANUP_BROWSER:-1}" == "false" ]]; then
    return 0
  fi
  local profile_pattern="$ET_CHROME_PROFILE_NAME"
  local wait_round
  pkill -TERM -f "$profile_pattern" >/dev/null 2>&1 || true
  for wait_round in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$profile_pattern" >/dev/null 2>&1 || break
    sleep 0.5
  done
  pkill -KILL -f "$profile_pattern" >/dev/null 2>&1 || true

  if [[ -n "${ET_CHROME_TMP_DIR:-}" && "$ET_CHROME_TMP_DIR" == /tmp/shein-bi-et-forwarder-chrome-tmp* ]]; then
    find "$ET_CHROME_TMP_DIR" -mindepth 1 -maxdepth 1 \
      \( -name 'com.google.Chrome.*' -o -name '.com.google.Chrome.*' \) \
      -exec rm -rf -- {} + 2>/dev/null || true
    rmdir "$ET_CHROME_TMP_DIR" 2>/dev/null || true
  fi

  if [[ "$ET_CLEANUP_LEGACY_CHROME_TMP" != "0" && "$ET_CLEANUP_LEGACY_CHROME_TMP" != "false" ]]; then
    local live_count
    live_count="$(live_chrome_process_count)"
    if [[ "$live_count" == "0" ]]; then
      find /tmp -maxdepth 1 \
        \( -name 'com.google.Chrome.*' -o -name '.com.google.Chrome.*' \) \
        -exec rm -rf -- {} + 2>/dev/null || true
    else
      echo "[cloud_et_forwarder_sync] skip legacy chrome tmp cleanup; live_chrome_processes=$live_count"
    fi
  fi
}

on_error() {
  local code=$?
  notify_issue "Cloud ET forwarder sync failed; BI will keep the previous ET warehouse data. See log: $LOG_FILE"
  echo "[cloud_et_forwarder_sync] failed code=$code date=$DATE log=$LOG_FILE"
  exit "$code"
}
trap on_error ERR
trap cleanup_et_browser EXIT

echo "[cloud_et_forwarder_sync] start date=$DATE mode=$MODE target=$TARGET root=$ROOT"
cd "$ROOT"
protect_et_capacity
prepare_et_chrome_tmp

FETCH_ARGS=(
  --mode "$MODE"
  --date "$DATE"
  --overlap-rows "${SHEIN_ET_OVERLAP_ROWS:-5}"
  --daily-initial-pages "${SHEIN_ET_DAILY_INITIAL_PAGES:-2}"
  --ship-lookback-days "${SHEIN_ET_SHIP_LOOKBACK_DAYS:-45}"
  --max-details "${SHEIN_ET_MAX_DETAILS:-50}"
  --wait-ms "${SHEIN_ET_WAIT_MS:-250}"
)
if [[ "$TARGET" == "ship-backfill" || "$TARGET" == "ship-full" ]]; then
  FETCH_ARGS=(
    --mode backfill
    --date "$DATE"
    --start-date "${SHEIN_ET_SHIP_BACKFILL_START_DATE:-2024-01-01}"
    --endpoints ship_order
    --detail-all
    --no-state-update
    --wait-ms "${SHEIN_ET_WAIT_MS:-250}"
  )
elif [[ "${SHEIN_ET_INCLUDE_FINANCE:-0}" == "1" || "${SHEIN_ET_INCLUDE_FINANCE:-0}" == "true" ]]; then
  FETCH_ARGS+=(--include-finance)
else
  FETCH_ARGS+=(--no-finance)
fi
if [[ -n "${SHEIN_ET_ENDPOINTS:-}" && "$TARGET" != "ship-backfill" && "$TARGET" != "ship-full" ]]; then
  FETCH_ARGS+=(--endpoints "$SHEIN_ET_ENDPOINTS")
fi

node scripts/fetch_et_forwarder.mjs "${FETCH_ARGS[@]}"

MANIFEST_PATH="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('outputs/et-forwarder/latest-manifest.json','utf8'));process.stdout.write(j.manifestPath||'')")"
if [[ -z "$MANIFEST_PATH" ]]; then
  echo "ET latest manifest path is empty" >&2
  exit 1
fi

node scripts/load_et_forwarder_warehouse.mjs --manifest "$MANIFEST_PATH"

if [[ "${SHEIN_ET_REFRESH_PORTAL:-1}" == "1" ]]; then
  PORTAL_DATA_MODE="${SHEIN_ET_PORTAL_DATA_MODE:-${SHEIN_BI_PORTAL_DATA_MODE:-api}}"
  PORTAL_REFRESH_MODE="${SHEIN_ET_REFRESH_PORTAL_MODE:-sections}"
  PORTAL_REFRESH_SECTIONS="${SHEIN_ET_REFRESH_SECTIONS:-orders,waybills,afterSales,inventoryTrend}"
  prepare_shared_lock_file "$PORTAL_REFRESH_LOCK_FILE"
  {
    if ! flock -w "$PORTAL_REFRESH_LOCK_WAIT_SEC" 8; then
      echo "[cloud_et_forwarder_sync] portal refresh lock busy after ${PORTAL_REFRESH_LOCK_WAIT_SEC}s; skip portal refresh this run"
    else
      if command -v systemctl >/dev/null 2>&1; then
        systemctl is-active --quiet shein-bi-portal.service || systemctl start shein-bi-portal.service || true
      fi
      check_portal_health
      case "$PORTAL_REFRESH_MODE" in
        full)
          echo "[cloud_et_forwarder_sync] full BI portal refresh data_mode=$PORTAL_DATA_MODE"
          SHEIN_BI_PORTAL_DATA_MODE="$PORTAL_DATA_MODE" node scripts/generate_bi_portal.mjs \
            --metabase-url "$METABASE_URL" \
            --data-mode "$PORTAL_DATA_MODE"
          node scripts/generate_bi_portal_shell.mjs
          if [[ "$PORTAL_DATA_MODE" == "api" && "${SHEIN_BI_PORTAL_PREWARM_DISABLED:-0}" != "1" ]]; then
            bash scripts/enqueue_bi_portal_sections.sh \
              --sections "$PORTAL_REFRESH_SECTIONS" \
              --priority 20 \
              --reason "et-forwarder-$DATE-$MODE"
            echo "[cloud_et_forwarder_sync] Portal sections queued sections=$PORTAL_REFRESH_SECTIONS"
          fi
          ;;
        sections|section|light|lightweight)
          if [[ "${SHEIN_BI_PORTAL_PREWARM_DISABLED:-0}" == "1" ]]; then
            echo "[cloud_et_forwarder_sync] lightweight section refresh disabled by SHEIN_BI_PORTAL_PREWARM_DISABLED=1"
          else
            echo "[cloud_et_forwarder_sync] lightweight section refresh sections=$PORTAL_REFRESH_SECTIONS"
            SHEIN_BI_PORTAL_PREWARM_SECTIONS="${SHEIN_ET_SYNC_PREWARM_SECTIONS:-orders,waybills,afterSales,inventoryTrend}" \
            SHEIN_BI_PORTAL_PREWARM_ASYNC=0 \
            SHEIN_BI_PORTAL_PREWARM_HOST_LOCKED=1 \
              bash scripts/prewarm_bi_portal_sections.sh
            bash scripts/enqueue_bi_portal_sections.sh \
              --sections inventoryTrend \
              --priority 40 \
              --reason "et-forwarder-$DATE-$MODE"
          fi
          ;;
        none|off|0|false)
          echo "[cloud_et_forwarder_sync] portal refresh skipped by SHEIN_ET_REFRESH_PORTAL_MODE=$PORTAL_REFRESH_MODE"
          ;;
        *)
          echo "Unsupported SHEIN_ET_REFRESH_PORTAL_MODE=$PORTAL_REFRESH_MODE" >&2
          exit 64
          ;;
      esac
    fi
  } 8>>"$PORTAL_REFRESH_LOCK_FILE"
fi

echo "[cloud_et_forwarder_sync] done date=$DATE mode=$MODE target=$TARGET manifest=$MANIFEST_PATH log=$LOG_FILE"
