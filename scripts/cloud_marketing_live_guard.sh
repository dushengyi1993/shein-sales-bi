#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
source "$ROOT/scripts/lib/shared_lock.sh"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_BI_MARKETING_LIVE_LOG_DIR:-/srv/shein-bi/logs/cloud-marketing-live-guard}"
STATE_DIR="${SHEIN_BI_MARKETING_LIVE_STATE_DIR:-$ROOT/state/cloud_marketing_live_guard}"
ALERT_DIR="$ROOT/state/cloud_ops_alerts"
LOCK_FILE="${SHEIN_BI_MARKETING_LIVE_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-marketing-live-guard.lock}"
GROUP="${SHEIN_BI_MARKETING_LIVE_GROUP:-ALL}"
PAGE_SIZE="${SHEIN_BI_MARKETING_LIVE_PAGE_SIZE:-500}"
STORE_ATTEMPTS="${SHEIN_BI_MARKETING_PRICE_STORE_ATTEMPTS:-3}"
SCAN_TIMEOUT_SEC="${SHEIN_BI_MARKETING_LIVE_SCAN_TIMEOUT_SEC:-2400}"
SCAN_KILL_AFTER_SEC="${SHEIN_BI_MARKETING_LIVE_SCAN_KILL_AFTER_SEC:-60}"
STACK_REVIEW_TIMEOUT_SEC="${SHEIN_BI_MARKETING_STACK_REVIEW_TIMEOUT_SEC:-600}"
STACK_REVIEW_KILL_AFTER_SEC="${SHEIN_BI_MARKETING_STACK_REVIEW_KILL_AFTER_SEC:-30}"
GUARD_MAX_AGE_HOURS="${SHEIN_BI_MARKETING_LIVE_GUARD_MAX_AGE_HOURS:-96}"
GUARD_CLOUD_BI_SSH="${SHEIN_BI_MARKETING_LIVE_CLOUD_BI_SSH:-local}"
GUARD_CLOUD_BI_ROOT="${SHEIN_BI_MARKETING_LIVE_CLOUD_BI_ROOT:-$ROOT}"
MIN_AVAILABLE_MEM_MIB="${SHEIN_BI_MARKETING_LIVE_MIN_AVAILABLE_MEM_MIB:-2200}"
AUTO_REPAIR="${SHEIN_BI_MARKETING_LIVE_AUTO_REPAIR:-0}"
RESERVED_WINDOW_MINUTES="${SHEIN_BI_MARKETING_LIVE_RESERVED_WINDOW_MINUTES:-6}"
IGNORE_RESERVED_WINDOW="${SHEIN_BI_MARKETING_LIVE_IGNORE_RESERVED_WINDOW:-0}"
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

guard_json_value() {
  local expression="$1"
  local default_value="${2:-0}"
  GUARD_FILE="$GUARD_OUT" GUARD_EXPR="$expression" GUARD_DEFAULT="$default_value" node <<'NODE'
const fs = require('node:fs');
try {
  const j = JSON.parse(fs.readFileSync(process.env.GUARD_FILE, 'utf8'));
  const f = new Function('j', `return (${process.env.GUARD_EXPR});`);
  const value = f(j);
  console.log(value === undefined || value === null || Number.isNaN(value) ? process.env.GUARD_DEFAULT || '0' : String(value));
} catch {
  console.log(process.env.GUARD_DEFAULT || '0');
}
NODE
}

run_live_scan() {
  local out="$1"
  timeout -k "$SCAN_KILL_AFTER_SEC" "$SCAN_TIMEOUT_SEC" \
    node scripts/marketing/scan_current_marketing_prices_for_bi.mjs \
      --group "$GROUP" \
      --page-size "$PAGE_SIZE" \
      --store-attempts "$STORE_ATTEMPTS" \
      --headless \
      --out "$out"
}

run_marketing_stack_review() {
  timeout -k "$STACK_REVIEW_KILL_AFTER_SEC" "$STACK_REVIEW_TIMEOUT_SEC" \
    node scripts/marketing/export_marketing_stack_review.mjs \
      --batch-size 3 \
      --headless \
      --session-http \
      --cloud-bi-ssh "$GUARD_CLOUD_BI_SSH" \
      --cloud-bi-root "$GUARD_CLOUD_BI_ROOT"
}

run_guard_report() {
  node scripts/marketing/build_marketing_daily_guard_report.mjs \
    --date "$DATE" \
    --max-age-hours "$GUARD_MAX_AGE_HOURS" \
    --cloud-bi-ssh "$GUARD_CLOUD_BI_SSH" \
    --cloud-bi-root "$GUARD_CLOUD_BI_ROOT"
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

upcoming_reserved_window() {
  local current_h current_m now_min best_delta=99999 best_name=""
  current_h="$(TZ="$TZ_NAME" date +%H)"
  current_m="$(TZ="$TZ_NAME" date +%M)"
  now_min=$((10#$current_h * 60 + 10#$current_m))

  consider_reserved_time() {
    local name="$1"
    local minute_of_day="$2"
    local delta
    if (( minute_of_day < now_min )); then
      delta=$((minute_of_day + 1440 - now_min))
    else
      delta=$((minute_of_day - now_min))
    fi
    if (( delta < best_delta )); then
      best_delta="$delta"
      best_name="$name"
    fi
  }

  local h
  for h in $(seq 0 23); do
    # Browser cleanup reserve windows. The timer may be disabled on a given host,
    # but full marketing live scans should still avoid these slots unless forced.
    consider_reserved_time "browser-cleanup:${h}:10" $((h * 60 + 10))
    consider_reserved_time "browser-cleanup:${h}:40" $((h * 60 + 40))

    # ET forwarder runs on odd hours at :20 and uses its own headless/browser/API
    # resources. Do not let a full all-store marketing scan cross into it.
    if (( h % 2 == 1 )); then
      consider_reserved_time "et-forwarder:${h}:20" $((h * 60 + 20))
    fi
  done

  # Other write/heavy production windows.
  for h in $(seq 0 23); do
    # Today sales refresh now runs hourly, except 03:00 is reserved for
    # yesterday-final refresh and 08:00 is handled by morning-chain.
    if (( h != 3 && h != 8 )); then
      consider_reserved_time "today-refresh:${h}:00" $((h * 60))
    fi
  done
  consider_reserved_time "session-manager:02:20" $((2 * 60 + 20))
  consider_reserved_time "db-backup:02:40" $((2 * 60 + 40))
  consider_reserved_time "yesterday-refresh:03:00" $((3 * 60))
  consider_reserved_time "order-closure:06:30" $((6 * 60 + 30))
  consider_reserved_time "morning-chain:08:00" $((8 * 60))

  printf '%s %s\n' "$best_delta" "$best_name"
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

prepare_shared_lock_file "$LOCK_FILE"
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

if [[ "$GROUP" == "ALL" && "$IGNORE_RESERVED_WINDOW" != "1" ]]; then
  read -r NEXT_RESERVED_DELTA NEXT_RESERVED_NAME < <(upcoming_reserved_window)
  if [[ "$NEXT_RESERVED_DELTA" =~ ^[0-9]+$ && "$RESERVED_WINDOW_MINUTES" =~ ^[0-9]+$ && "$NEXT_RESERVED_DELTA" -le "$RESERVED_WINDOW_MINUTES" ]]; then
    write_state "skipped_upcoming_reserved_window" "next reserved window ${NEXT_RESERVED_NAME} starts in ${NEXT_RESERVED_DELTA}min; skip full live scan" 0
    echo "[cloud_marketing_live_guard] SKIP upcoming reserved window name=${NEXT_RESERVED_NAME} in=${NEXT_RESERVED_DELTA}min threshold=${RESERVED_WINDOW_MINUTES}min"
    exit 0
  fi
fi

AVAILABLE_MEM="$(available_mem_mib)"
if [[ "$AVAILABLE_MEM" =~ ^[0-9]+$ ]] && (( AVAILABLE_MEM > 0 && AVAILABLE_MEM < MIN_AVAILABLE_MEM_MIB )); then
  write_state "skipped_low_memory" "MemAvailable=${AVAILABLE_MEM}MiB below ${MIN_AVAILABLE_MEM_MIB}MiB" 0
  echo "[cloud_marketing_live_guard] SKIP low memory MemAvailable=${AVAILABLE_MEM}MiB threshold=${MIN_AVAILABLE_MEM_MIB}MiB"
  exit 0
fi

echo "[cloud_marketing_live_guard] cleanup before live scan"
cleanup_store_browsers

# Ordinary marketing is the highest-priority layer. Refresh its full-store live
# evidence every day before evaluating limited-discount drift or fallback work.
# Session HTTP reuses the session-manager evidence and does not open browsers;
# the guard report below verifies 19/19 explicit store coverage and freshness.
STACK_REVIEW_STATUS=0
echo "[cloud_marketing_live_guard] refresh ordinary marketing stack review via session HTTP"
if run_marketing_stack_review; then
  echo "[cloud_marketing_live_guard] ordinary marketing stack review refreshed"
else
  STACK_REVIEW_STATUS=$?
  echo "[cloud_marketing_live_guard] WARN ordinary marketing stack review returned status=$STACK_REVIEW_STATUS" >&2
fi

SCAN_STATUS=0
if run_live_scan "$SCAN_OUT"; then
  echo "[cloud_marketing_live_guard] live scan done scan=$SCAN_OUT"
else
  SCAN_STATUS=$?
  echo "[cloud_marketing_live_guard] WARN live scan returned status=$SCAN_STATUS; keep partial evidence and continue guard" >&2
fi

echo "[cloud_marketing_live_guard] cleanup after live scan"
cleanup_store_browsers

GUARD_STATUS=0
if run_guard_report; then
  echo "[cloud_marketing_live_guard] guard report done guard=$GUARD_OUT"
else
  GUARD_STATUS=$?
  echo "[cloud_marketing_live_guard] WARN guard report returned status=$GUARD_STATUS" >&2
fi

DRIFT_REPAIR_STATUS=0
NEW_LISTING_STATUS=0
MANUAL_SPECIAL_RESTORE_STATUS=0
WRITE_PHASE_FAILED=0
FINAL_SCAN_STATUS=0
FINAL_GUARD_STATUS=0
ORDINARY_LIVE_READY="$(guard_json_value '(j.marketingStackReviewCoverage?.coverageComplete === true && Number(j.marketingStackReviewFreshness?.activityAgeHours ?? 999999) <= Number(j.marketingStackReviewFreshness?.activityFreshnessThresholdHours ?? 48)) ? 1 : 0' 0)"
echo "[cloud_marketing_live_guard] ordinary live evidence ready=$ORDINARY_LIVE_READY stackReviewStatus=$STACK_REVIEW_STATUS"
if [[ "$AUTO_REPAIR" == "1" && "$STACK_REVIEW_STATUS" -eq 0 && "$ORDINARY_LIVE_READY" -eq 1 && "$SCAN_STATUS" -eq 0 && "$GUARD_STATUS" -eq 0 ]]; then
  DRIFT_BELOW_COUNT="$(guard_json_value '(j.limitedDiscountTargetPriceDrift?.belowRows || []).length' 0)"
  NEW_LISTING_EXEC_COUNT="$(guard_json_value '(j.newSkcCandidates?.newListingWithin7DaysLimitedDiscount?.executableActionCount || 0)' 0)"
  MANUAL_SPECIAL_RESTORE_COUNT="$(guard_json_value 'Number(j.manualSpecialLimitedDiscount?.actionCount || 0)' 0)"
  echo "[cloud_marketing_live_guard] action check manualSpecialRestore=$MANUAL_SPECIAL_RESTORE_COUNT driftBelow=$DRIFT_BELOW_COUNT topTreatmentExecutable=$NEW_LISTING_EXEC_COUNT"

  if [[ "$MANUAL_SPECIAL_RESTORE_COUNT" =~ ^[0-9]+$ && "$MANUAL_SPECIAL_RESTORE_COUNT" -gt 0 ]]; then
    echo "[cloud_marketing_live_guard] restore active user-approved manual special limited discounts count=$MANUAL_SPECIAL_RESTORE_COUNT"
    if node scripts/marketing/batch_restore_manual_limited_discounts.mjs --guard "$GUARD_OUT" --execute; then
      echo "[cloud_marketing_live_guard] manual-special limited-discount restore done"
    else
      MANUAL_SPECIAL_RESTORE_STATUS=$?
      WRITE_PHASE_FAILED=1
      echo "[cloud_marketing_live_guard] WARN manual-special limited-discount restore returned status=$MANUAL_SPECIAL_RESTORE_STATUS" >&2
    fi
    cleanup_store_browsers
  fi

  if [[ "$WRITE_PHASE_FAILED" -eq 0 && "$DRIFT_BELOW_COUNT" =~ ^[0-9]+$ && "$DRIFT_BELOW_COUNT" -gt 0 ]]; then
    echo "[cloud_marketing_live_guard] auto fix limited-discount target-price drift count=$DRIFT_BELOW_COUNT"
    if node scripts/marketing/batch_fix_limited_discount_drift.mjs --guard "$GUARD_OUT" --execute; then
      echo "[cloud_marketing_live_guard] limited-discount drift fix done"
    else
      DRIFT_REPAIR_STATUS=$?
      WRITE_PHASE_FAILED=1
      echo "[cloud_marketing_live_guard] WARN limited-discount drift fix returned status=$DRIFT_REPAIR_STATUS" >&2
    fi
    cleanup_store_browsers
  elif [[ "$WRITE_PHASE_FAILED" -ne 0 && "$DRIFT_BELOW_COUNT" =~ ^[0-9]+$ && "$DRIFT_BELOW_COUNT" -gt 0 ]]; then
    DRIFT_REPAIR_STATUS=90
    echo "[cloud_marketing_live_guard] SKIP drift repair because an earlier write phase failed; final live scan will capture the partial state" >&2
  fi

  if [[ "$WRITE_PHASE_FAILED" -eq 0 && "$NEW_LISTING_EXEC_COUNT" =~ ^[0-9]+$ && "$NEW_LISTING_EXEC_COUNT" -gt 0 ]]; then
    echo "[cloud_marketing_live_guard] auto apply new-listing/relisted top-treatment limited-discount fallback executable=$NEW_LISTING_EXEC_COUNT"
    if node scripts/marketing/batch_apply_new_listing_limited_discount.mjs --date "$DATE" --guard "$GUARD_OUT" --execute; then
      echo "[cloud_marketing_live_guard] new-listing/relisted limited-discount fallback done"
    else
      NEW_LISTING_STATUS=$?
      WRITE_PHASE_FAILED=1
      echo "[cloud_marketing_live_guard] WARN new-listing/relisted limited-discount fallback returned status=$NEW_LISTING_STATUS" >&2
    fi
    cleanup_store_browsers
  elif [[ "$WRITE_PHASE_FAILED" -ne 0 && "$NEW_LISTING_EXEC_COUNT" =~ ^[0-9]+$ && "$NEW_LISTING_EXEC_COUNT" -gt 0 ]]; then
    NEW_LISTING_STATUS=90
    echo "[cloud_marketing_live_guard] SKIP new-listing fallback because an earlier write phase failed; final live scan will capture the partial state" >&2
  fi

  if [[ "$MANUAL_SPECIAL_RESTORE_COUNT" -gt 0 || "$DRIFT_BELOW_COUNT" -gt 0 || "$NEW_LISTING_EXEC_COUNT" -gt 0 ]]; then
    FINAL_STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)-final"
    SCAN_OUT="$ROOT/tmp/marketing-signup/current-price-live/current-marketing-price-live-${DATE}-${FINAL_STAMP}.json"
    echo "[cloud_marketing_live_guard] final live scan after auto actions"
    if run_live_scan "$SCAN_OUT"; then
      echo "[cloud_marketing_live_guard] final live scan done scan=$SCAN_OUT"
    else
      FINAL_SCAN_STATUS=$?
      echo "[cloud_marketing_live_guard] WARN final live scan returned status=$FINAL_SCAN_STATUS" >&2
    fi
    cleanup_store_browsers
    if run_guard_report; then
      echo "[cloud_marketing_live_guard] final guard report done guard=$GUARD_OUT"
    else
      FINAL_GUARD_STATUS=$?
      echo "[cloud_marketing_live_guard] WARN final guard report returned status=$FINAL_GUARD_STATUS" >&2
    fi
  fi
else
  if [[ "$AUTO_REPAIR" != "1" ]]; then
    echo "[cloud_marketing_live_guard] auto repair disabled"
  else
    echo "[cloud_marketing_live_guard] skip auto repair because stackReviewStatus=$STACK_REVIEW_STATUS ordinaryLiveReady=$ORDINARY_LIVE_READY scanStatus=$SCAN_STATUS guardStatus=$GUARD_STATUS"
  fi
fi

if [[ "$STACK_REVIEW_STATUS" -eq 0 && "$ORDINARY_LIVE_READY" -eq 1 && "$SCAN_STATUS" -eq 0 && "$GUARD_STATUS" -eq 0 && "$MANUAL_SPECIAL_RESTORE_STATUS" -eq 0 && "$DRIFT_REPAIR_STATUS" -eq 0 && "$NEW_LISTING_STATUS" -eq 0 && "$FINAL_SCAN_STATUS" -eq 0 && "$FINAL_GUARD_STATUS" -eq 0 ]]; then
  write_state "ok" "marketing live guard completed; ordinaryLiveReady=$ORDINARY_LIVE_READY autoRepair manualSpecial=$MANUAL_SPECIAL_RESTORE_STATUS drift=$DRIFT_REPAIR_STATUS newListing=$NEW_LISTING_STATUS" 1
  echo "[cloud_marketing_live_guard] done ok date=$DATE log=$LOG_FILE"
else
  write_state "warning" "stackReview=$STACK_REVIEW_STATUS ordinaryLiveReady=$ORDINARY_LIVE_READY live scan status=$SCAN_STATUS guard status=$GUARD_STATUS manualSpecialRestore=$MANUAL_SPECIAL_RESTORE_STATUS driftRepair=$DRIFT_REPAIR_STATUS newListing=$NEW_LISTING_STATUS finalScan=$FINAL_SCAN_STATUS finalGuard=$FINAL_GUARD_STATUS" 0
  echo "[cloud_marketing_live_guard] done warning stackReviewStatus=$STACK_REVIEW_STATUS ordinaryLiveReady=$ORDINARY_LIVE_READY scanStatus=$SCAN_STATUS guardStatus=$GUARD_STATUS manualSpecialRestore=$MANUAL_SPECIAL_RESTORE_STATUS driftRepair=$DRIFT_REPAIR_STATUS newListing=$NEW_LISTING_STATUS finalScan=$FINAL_SCAN_STATUS finalGuard=$FINAL_GUARD_STATUS log=$LOG_FILE" >&2
  exit 1
fi
