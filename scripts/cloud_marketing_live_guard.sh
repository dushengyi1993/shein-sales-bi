#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_BI_MARKETING_LIVE_LOG_DIR:-/srv/shein-bi/logs/cloud-marketing-live-guard}"
STATE_DIR="${SHEIN_BI_MARKETING_LIVE_STATE_DIR:-$ROOT/state/cloud_marketing_live_guard}"
ALERT_DIR="$ROOT/state/cloud_ops_alerts"
LOCK_FILE="${SHEIN_BI_MARKETING_LIVE_LOCK_FILE:-/tmp/shein-bi-cloud-marketing-live-guard.lock}"
GROUP="${SHEIN_BI_MARKETING_LIVE_GROUP:-ALL}"
PAGE_SIZE="${SHEIN_BI_MARKETING_LIVE_PAGE_SIZE:-500}"
SCAN_TIMEOUT_SEC="${SHEIN_BI_MARKETING_LIVE_SCAN_TIMEOUT_SEC:-2400}"
SCAN_KILL_AFTER_SEC="${SHEIN_BI_MARKETING_LIVE_SCAN_KILL_AFTER_SEC:-60}"
GUARD_MAX_AGE_HOURS="${SHEIN_BI_MARKETING_LIVE_GUARD_MAX_AGE_HOURS:-96}"
GUARD_CLOUD_BI_SSH="${SHEIN_BI_MARKETING_LIVE_CLOUD_BI_SSH:-local}"
GUARD_CLOUD_BI_ROOT="${SHEIN_BI_MARKETING_LIVE_CLOUD_BI_ROOT:-$ROOT}"
MIN_AVAILABLE_MEM_MIB="${SHEIN_BI_MARKETING_LIVE_MIN_AVAILABLE_MEM_MIB:-2200}"
# P3-#9: load busy services from config file, fallback to env var or hardcoded default
BUSY_SERVICES_CONFIG="$ROOT/config/cloud_marketing_busy_services.json"
BUSY_SERVICES="${SHEIN_BI_MARKETING_LIVE_BUSY_SERVICES:-}"
if [[ -z "${SHEIN_BI_MARKETING_LIVE_BUSY_SERVICES:-}" ]] && [[ -f "$BUSY_SERVICES_CONFIG" ]]; then
  BUSY_SERVICES="$(python3 -c "import json; print(' '.join(json.load(open('$BUSY_SERVICES_CONFIG')).get('busyServices',[])))" 2>/dev/null)"
fi
if [[ -z "$BUSY_SERVICES" ]]; then
  BUSY_SERVICES="${SHEIN_BI_MARKETING_LIVE_BUSY_SERVICES:-shein-bi-cloud-today.service shein-bi-cloud-yesterday.service shein-bi-cloud-et-forwarder.service shein-bi-cloud-daily-refresh.service shein-bi-cloud-session-manager.service shein-bi-cloud-morning-chain.service shein-bi-cloud-order-closure.service shein-bi-db-backup.service}"
fi

resolve_today() {
  TZ="$TZ_NAME" date +%F
}

now_iso() {
  TZ="$TZ_NAME" date --iso-8601=seconds
}

available_mem_mib() {
  awk '/MemAvailable:/ { printf "%d\n", $2 / 1024; found=1 } END { if (!found) print 0 }' /proc/meminfo 2>/dev/null || echo 0
}

cleanup_store_browsers() {
  cd "$ROOT"
  node scripts/cleanup_shein_store_browsers.mjs --all --cleanup-chrome-tmp --kill-after-sec 5 || true
}

active_busy_services() {
  local active=()
  local service
  if ! command -v systemctl >/dev/null 2>&1; then
    return 0
  fi
  for service in $BUSY_SERVICES; do
    if systemctl is-active --quiet "$service"; then
      active+=("$service")
    fi
  done
  printf '%s\n' "${active[*]}"
}

write_state() {
  local status="$1"
  local message="$2"
  local ok_flag="${3:-0}"
  mkdir -p "$STATE_DIR" "$ALERT_DIR"
  STATE_FILE="$ALERT_DIR/marketing-live-guard-last.json" \
  OK_STATE_FILE="$ALERT_DIR/marketing-live-guard-last-ok.json" \
  STATE_DATE="$DATE" \
  STATE_STATUS="$status" \
  STATE_MESSAGE="$message" \
  STATE_LOG_FILE="$LOG_FILE" \
  STATE_SCAN_FILE="${SCAN_OUT:-}" \
  STATE_GUARD_FILE="${GUARD_OUT:-}" \
  STATE_OK_FLAG="$ok_flag" \
  node <<'NODE'
const fs = require('node:fs');
const state = {
  date: process.env.STATE_DATE,
  generatedAt: new Date().toISOString(),
  status: process.env.STATE_STATUS,
  message: process.env.STATE_MESSAGE,
  logFile: process.env.STATE_LOG_FILE,
  scanFile: process.env.STATE_SCAN_FILE || null,
  guardFile: process.env.STATE_GUARD_FILE || null,
};
fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(state, null, 2));
if (process.env.STATE_OK_FLAG === '1') {
  fs.writeFileSync(process.env.OK_STATE_FILE, JSON.stringify(state, null, 2));
}
NODE
}

on_error() {
  local line="$1"
  local status="$2"
  set +e
  write_state "failed" "marketing live guard aborted at line=$line exit=$status" 0
  echo "[cloud_marketing_live_guard] ERROR aborted at line=$line exit=$status log=$LOG_FILE" >&2
  cleanup_store_browsers
  exit "$status"
}

on_signal() {
  local signal="$1"
  local status=143
  case "$signal" in
    INT) status=130 ;;
    TERM) status=143 ;;
    HUP) status=129 ;;
  esac
  set +e
  write_state "interrupted" "marketing live guard interrupted by signal=$signal" 0
  echo "[cloud_marketing_live_guard] INTERRUPTED signal=$signal log=$LOG_FILE" >&2
  cleanup_store_browsers
  trap - EXIT ERR INT TERM HUP
  exit "$status"
}

mkdir -p "$LOG_DIR" "$STATE_DIR" "$ALERT_DIR"
DATE="$(resolve_today)"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/marketing-live-guard-${DATE}-${STAMP}.log"
SCAN_OUT="$ROOT/tmp/marketing-signup/current-price-live/current-marketing-price-live-${DATE}-${STAMP}.json"
GUARD_OUT="$ROOT/outputs/reports/marketing-daily-guard-${DATE}.json"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[cloud_marketing_live_guard] another marketing live guard is running; skip"
  exit 0
fi

exec > >(tee -a "$LOG_FILE") 2>&1

trap 'on_error "$LINENO" "$?"' ERR
trap cleanup_store_browsers EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP

cd "$ROOT"
echo "[cloud_marketing_live_guard] start date=$DATE root=$ROOT group=$GROUP"

ACTIVE_BUSY="$(active_busy_services)"
if [[ -n "$ACTIVE_BUSY" ]]; then
  write_state "skipped_busy" "busy services active: $ACTIVE_BUSY" 0
  echo "[cloud_marketing_live_guard] SKIP busy services active: $ACTIVE_BUSY"
  exit 0
fi

AVAILABLE_MEM="$(available_mem_mib)"
if [[ "$AVAILABLE_MEM" =~ ^[0-9]+$ ]] && (( AVAILABLE_MEM > 0 && AVAILABLE_MEM < MIN_AVAILABLE_MEM_MIB )); then
  write_state "skipped_low_memory" "MemAvailable=${AVAILABLE_MEM}MiB below ${MIN_AVAILABLE_MEM_MIB}MiB" 0
  echo "[cloud_marketing_live_guard] SKIP low memory MemAvailable=${AVAILABLE_MEM}MiB threshold=${MIN_AVAILABLE_MEM_MIB}MiB"
  exit 0
fi

echo "[cloud_marketing_live_guard] cleanup before live scan"
cleanup_store_browsers

SCAN_STATUS=0
if timeout -k "$SCAN_KILL_AFTER_SEC" "$SCAN_TIMEOUT_SEC" \
  node scripts/marketing/scan_current_marketing_prices_for_bi.mjs \
    --group "$GROUP" \
    --page-size "$PAGE_SIZE" \
    --headless \
    --out "$SCAN_OUT"; then
  echo "[cloud_marketing_live_guard] live scan done scan=$SCAN_OUT"
else
  SCAN_STATUS=$?
  echo "[cloud_marketing_live_guard] WARN live scan returned status=$SCAN_STATUS; keep partial evidence and continue guard" >&2
fi

echo "[cloud_marketing_live_guard] cleanup after live scan"
cleanup_store_browsers

GUARD_STATUS=0
if node scripts/marketing/build_marketing_daily_guard_report.mjs \
  --date "$DATE" \
  --max-age-hours "$GUARD_MAX_AGE_HOURS" \
  --cloud-bi-ssh "$GUARD_CLOUD_BI_SSH" \
  --cloud-bi-root "$GUARD_CLOUD_BI_ROOT"; then
  echo "[cloud_marketing_live_guard] guard report done guard=$GUARD_OUT"
else
  GUARD_STATUS=$?
  echo "[cloud_marketing_live_guard] WARN guard report returned status=$GUARD_STATUS" >&2
fi

if [[ "$SCAN_STATUS" -eq 0 && "$GUARD_STATUS" -eq 0 ]]; then
  write_state "ok" "marketing live guard completed" 1
  echo "[cloud_marketing_live_guard] done ok date=$DATE log=$LOG_FILE"
else
  write_state "warning" "live scan status=$SCAN_STATUS guard status=$GUARD_STATUS" 0
  echo "[cloud_marketing_live_guard] done warning scanStatus=$SCAN_STATUS guardStatus=$GUARD_STATUS log=$LOG_FILE" >&2
fi
