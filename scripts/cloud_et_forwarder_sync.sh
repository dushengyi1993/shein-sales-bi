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
PORTAL_REFRESH_LOCK_FILE="${SHEIN_BI_PORTAL_REFRESH_LOCK_FILE:-/tmp/shein-bi-portal-refresh.lock}"
PORTAL_REFRESH_LOCK_WAIT_SEC="${SHEIN_BI_PORTAL_REFRESH_LOCK_WAIT_SEC:-1800}"
WAIT_SERVICES="${SHEIN_ET_WAIT_SERVICES:-shein-bi-cloud-today.service shein-bi-cloud-yesterday.service shein-bi-cloud-session-manager.service shein-bi-db-backup.service}"
SKIP_IF_SERVICES="${SHEIN_ET_SKIP_IF_SERVICES:-shein-bi-cloud-daily-refresh.service}"

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

on_error() {
  local code=$?
  notify_issue "Cloud ET forwarder sync failed; BI will keep the previous ET warehouse data. See log: $LOG_FILE"
  echo "[cloud_et_forwarder_sync] failed code=$code date=$DATE log=$LOG_FILE"
  exit "$code"
}
trap on_error ERR

echo "[cloud_et_forwarder_sync] start date=$DATE root=$ROOT"
cd "$ROOT"
protect_et_capacity

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
  PORTAL_DATA_MODE="${SHEIN_ET_PORTAL_DATA_MODE:-${SHEIN_BI_PORTAL_DATA_MODE:-api}}"
  PORTAL_REFRESH_MODE="${SHEIN_ET_REFRESH_PORTAL_MODE:-sections}"
  PORTAL_REFRESH_SECTIONS="${SHEIN_ET_REFRESH_SECTIONS:-orders,waybills,afterSales}"
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
          node scripts/generate_bi_portal_v2.mjs
          if [[ "$PORTAL_DATA_MODE" == "api" && "${SHEIN_BI_PORTAL_PREWARM_DISABLED:-0}" != "1" ]]; then
            SHEIN_BI_PORTAL_PREWARM_SECTIONS="$PORTAL_REFRESH_SECTIONS" \
            SHEIN_BI_PORTAL_PREWARM_ASYNC="${SHEIN_BI_PORTAL_PREWARM_ASYNC:-1}" \
            nohup bash scripts/prewarm_bi_portal_sections.sh >/dev/null 2>&1 &
            echo "[cloud_et_forwarder_sync] portal section prewarm started pid=$! sections=$PORTAL_REFRESH_SECTIONS"
          fi
          ;;
        sections|section|light|lightweight)
          if [[ "${SHEIN_BI_PORTAL_PREWARM_DISABLED:-0}" == "1" ]]; then
            echo "[cloud_et_forwarder_sync] lightweight section refresh disabled by SHEIN_BI_PORTAL_PREWARM_DISABLED=1"
          else
            echo "[cloud_et_forwarder_sync] lightweight section refresh sections=$PORTAL_REFRESH_SECTIONS"
            SHEIN_BI_PORTAL_PREWARM_SECTIONS="$PORTAL_REFRESH_SECTIONS" \
            SHEIN_BI_PORTAL_PREWARM_ASYNC="${SHEIN_BI_PORTAL_PREWARM_ASYNC:-1}" \
            bash scripts/prewarm_bi_portal_sections.sh
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
  } 8>"$PORTAL_REFRESH_LOCK_FILE"
fi

echo "[cloud_et_forwarder_sync] done date=$DATE manifest=$MANIFEST_PATH log=$LOG_FILE"
