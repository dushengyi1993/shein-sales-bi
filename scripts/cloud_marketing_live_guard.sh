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
STAGE_ATTEMPTS="${SHEIN_BI_MARKETING_STAGE_ATTEMPTS:-3}"
STAGE_RETRY_DELAY_SEC="${SHEIN_BI_MARKETING_STAGE_RETRY_DELAY_SEC:-30}"
GUARD_MAX_AGE_HOURS="${SHEIN_BI_MARKETING_LIVE_GUARD_MAX_AGE_HOURS:-96}"
GUARD_CLOUD_BI_SSH="${SHEIN_BI_MARKETING_LIVE_CLOUD_BI_SSH:-local}"
GUARD_CLOUD_BI_ROOT="${SHEIN_BI_MARKETING_LIVE_CLOUD_BI_ROOT:-$ROOT}"
MIN_AVAILABLE_MEM_MIB="${SHEIN_BI_MARKETING_LIVE_MIN_AVAILABLE_MEM_MIB:-2200}"
BUILD_REPAIR_QUEUE="${SHEIN_BI_MARKETING_LIVE_BUILD_REPAIR_QUEUE:-${SHEIN_BI_MARKETING_LIVE_AUTO_REPAIR:-0}}"
RESERVED_WINDOW_MINUTES="${SHEIN_BI_MARKETING_LIVE_RESERVED_WINDOW_MINUTES:-6}"
# The managed live guard is session-HTTP/OpenAPI only. Resource tokens and the
# host pressure gate already isolate it; the old minute table caused the 11:00
# run to reject itself and is opt-in only for legacy/manual browser scans.
IGNORE_RESERVED_WINDOW="${SHEIN_BI_MARKETING_LIVE_IGNORE_RESERVED_WINDOW:-1}"
FORCE_RERUN="${SHEIN_BI_MARKETING_LIVE_FORCE_RERUN:-0}"
# P3-#9: load busy services from config file, fallback to env var or hardcoded default
BUSY_SERVICES_CONFIG="$ROOT/config/cloud_marketing_busy_services.json"
BUSY_SERVICES="${SHEIN_BI_MARKETING_LIVE_BUSY_SERVICES:-}"
if [[ -z "${SHEIN_BI_MARKETING_LIVE_BUSY_SERVICES:-}" ]] && [[ -f "$BUSY_SERVICES_CONFIG" ]]; then
  BUSY_SERVICES="$(python3 -c "import json; print(' '.join(json.load(open('$BUSY_SERVICES_CONFIG')).get('busyServices',[])))" 2>/dev/null)"
fi
if [[ -z "$BUSY_SERVICES" ]]; then
  BUSY_SERVICES="${SHEIN_BI_MARKETING_LIVE_BUSY_SERVICES:-shein-bi-cloud-today.service shein-bi-cloud-yesterday.service shein-bi-cloud-et-forwarder.service shein-bi-cloud-daily-refresh.service shein-bi-cloud-session-manager.service shein-bi-cloud-morning-chain.service shein-bi-cloud-order-closure.service shein-bi-db-backup.service shein-bi-cloud-marketing-repair.service}"
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
      --session-http \
      --session-concurrency "${SHEIN_BI_MARKETING_PRICE_SESSION_CONCURRENCY:-3}" \
      --out "$out"
}

run_marketing_stack_review() {
  timeout -k "$STACK_REVIEW_KILL_AFTER_SEC" "$STACK_REVIEW_TIMEOUT_SEC" \
    node scripts/marketing/export_marketing_stack_review.mjs \
      --batch-size 3 \
      --session-http \
      --cloud-bi-ssh "$GUARD_CLOUD_BI_SSH" \
      --cloud-bi-root "$GUARD_CLOUD_BI_ROOT"
}

run_stage_with_retry() {
  local label="$1"
  shift
  local attempt=1
  local status=1
  while (( attempt <= STAGE_ATTEMPTS )); do
    echo "[cloud_marketing_live_guard] stage=$label attempt=$attempt/$STAGE_ATTEMPTS"
    if "$@"; then
      return 0
    else
      status=$?
    fi
    if (( attempt < STAGE_ATTEMPTS )); then
      echo "[cloud_marketing_live_guard] WARN stage=$label attempt=$attempt status=$status; retrying the failed stage inside the same daily run in ${STAGE_RETRY_DELAY_SEC}s" >&2
      sleep "$STAGE_RETRY_DELAY_SEC"
    fi
    attempt=$((attempt + 1))
  done
  return "$status"
}

run_guard_report() {
  node scripts/marketing/build_marketing_daily_guard_report.mjs \
    --date "$DATE" \
    --max-age-hours "$GUARD_MAX_AGE_HOURS" \
    --cloud-bi-ssh "$GUARD_CLOUD_BI_SSH" \
    --cloud-bi-root "$GUARD_CLOUD_BI_ROOT"
}

refresh_marketing_cost_map() {
  python3 scripts/marketing/build_marketing_cost_map.py
}

run_on_shelf_limited_discount_plan() {
  local price_overrides price_overrides_path
  price_overrides="$(guard_json_value '(j.targetPlanSelection?.priceOverrides || "")' '')"
  if [[ "$price_overrides" == /* ]]; then
    price_overrides_path="$price_overrides"
  else
    price_overrides_path="$ROOT/$price_overrides"
  fi
  if [[ -z "$price_overrides" || ! -f "$price_overrides_path" ]]; then
    echo "[cloud_marketing_live_guard] ERROR current price-overrides not found: ${price_overrides:-empty}" >&2
    return 2
  fi
  node scripts/marketing/build_new_listing_limited_discount_plan.mjs \
    --date "$DATE" \
    --source-guard "$GUARD_OUT" \
    --exclude-manual-special true \
    --price-overrides "$price_overrides_path" \
    --current-marketing-live-scan "$SCAN_OUT"
}

run_drift_repair_plan() {
  node scripts/marketing/build_limited_discount_drift_rescue_plan.mjs \
    --guard "$GUARD_OUT" \
    --out-dir "$ROOT/tmp/marketing-signup/limited-discount-fallback/target-price-drift-${DATE}" \
    --end-time "$(TZ="$TZ_NAME" date -d "$DATE +7 days" +%F) 23:59:59"
}

run_manual_special_restore_plan() {
  node scripts/marketing/build_manual_limited_discount_restore_plan.mjs \
    --guard "$GUARD_OUT" \
    --out-dir "$ROOT/tmp/marketing-signup/manual-limited-discount-restore/${DATE}"
}

run_high_click_special_plan() {
  node scripts/marketing/build_high_click_special_discount_plan.mjs \
    --date "$DATE" \
    --guard "$GUARD_OUT" \
    --out "$ROOT/outputs/reports/high-click-low-conversion-special-plan-${DATE}.json"
}

build_repair_queue() {
  node scripts/marketing/manage_marketing_repair_queue.mjs build \
    --date "$DATE" \
    --guard "$GUARD_OUT" \
    --high-click-plan "$ROOT/outputs/reports/high-click-low-conversion-special-plan-${DATE}.json" \
    --manual-plan "$ROOT/tmp/marketing-signup/manual-limited-discount-restore/${DATE}/manual-limited-discount-restore-plan.json" \
    --drift-plan-dir "$ROOT/tmp/marketing-signup/limited-discount-fallback/target-price-drift-${DATE}" \
    --fallback-plan "$ROOT/outputs/reports/new-listing-7d-limited-discount-plan-${DATE}.json" \
    --queue "$REPAIR_QUEUE_FILE"
}

queue_json_value() {
  local expression="$1"
  local default_value="${2:-0}"
  JSON_FILE="$REPAIR_QUEUE_FILE" JSON_EXPR="$expression" JSON_DEFAULT="$default_value" node <<'NODE'
const fs = require('node:fs');
try {
  const j = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
  const value = new Function('j', `return (${process.env.JSON_EXPR});`)(j);
  console.log(value === undefined || value === null || Number.isNaN(value) ? process.env.JSON_DEFAULT : String(value));
} catch {
  console.log(process.env.JSON_DEFAULT);
}
NODE
}

on_shelf_limited_discount_plan_count() {
  local plan_file="$ROOT/outputs/reports/new-listing-7d-limited-discount-plan-${DATE}.json"
  PLAN_FILE="$plan_file" node <<'NODE'
const fs = require('node:fs');
try {
  const plan = JSON.parse(fs.readFileSync(process.env.PLAN_FILE, 'utf8'));
  console.log(Number(plan?.totals?.actionable || 0));
} catch {
  console.log(0);
}
NODE
}

today_guard_already_ok() {
  local state_file="$ALERT_DIR/marketing-live-guard-last.json"
  STATE_FILE="$state_file" STATE_DATE="$DATE" node <<'NODE'
const fs = require('node:fs');
try {
  const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8'));
  // Later timer slots are retries for a failed inspection, not another full
  // scan while the independent repair worker is consuming today's queue.
  console.log(state?.date === process.env.STATE_DATE && state?.status === 'ok' ? '1' : '0');
} catch {
  console.log('0');
}
NODE
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
  STATE_REPAIR_QUEUE_FILE="${REPAIR_QUEUE_FILE:-}" \
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
  repairQueueFile: process.env.STATE_REPAIR_QUEUE_FILE || null,
};
try {
  const queue = JSON.parse(fs.readFileSync(process.env.STATE_REPAIR_QUEUE_FILE, 'utf8'));
  state.repairQueueStatus = queue.status || null;
  state.repairQueueCounts = queue.counts || null;
} catch {}
fs.writeFileSync(process.env.STATE_FILE, JSON.stringify(state, null, 2));
if (process.env.STATE_OK_FLAG === '1') {
  fs.writeFileSync(process.env.OK_STATE_FILE, JSON.stringify(state, null, 2));
}
NODE
  write_immutable_run_report "$status" "$message"
}

write_immutable_run_report() {
  local status="$1"
  local message="$2"
  RUN_REPORT_FILE="$RUN_REPORT_FILE" RUN_REPORT_STATUS="$status" RUN_REPORT_MESSAGE="$message" RUN_REPORT_DATE="$DATE" RUN_REPORT_ID="$RUN_ID" RUN_REPORT_LOG="$LOG_FILE" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const report = {
  date: process.env.RUN_REPORT_DATE,
  runId: process.env.RUN_REPORT_ID,
  generatedAt: new Date().toISOString(),
  status: process.env.RUN_REPORT_STATUS,
  message: process.env.RUN_REPORT_MESSAGE,
  logFile: process.env.RUN_REPORT_LOG,
};
fs.mkdirSync(path.dirname(process.env.RUN_REPORT_FILE), {recursive: true});
try {
  fs.writeFileSync(process.env.RUN_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'});
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
}
NODE
}

on_error() {
  local line="$1"
  local status="$2"
  set +e
  write_state "failed" "marketing live guard aborted at line=$line exit=$status" 0
  echo "[cloud_marketing_live_guard] ERROR aborted at line=$line exit=$status log=$LOG_FILE" >&2
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
  trap - ERR INT TERM HUP
  exit "$status"
}

mkdir -p "$LOG_DIR" "$STATE_DIR" "$ALERT_DIR"
DATE="$(resolve_today)"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
RUN_ID="${SHEIN_BI_MARKETING_LIVE_RUN_ID:-$(node -e 'console.log(require("node:crypto").randomUUID())')}"
LOG_FILE="$LOG_DIR/marketing-live-guard-${DATE}-${STAMP}.log"
SCAN_OUT="$ROOT/tmp/marketing-signup/current-price-live/current-marketing-price-live-${DATE}-${STAMP}.json"
GUARD_OUT="$ROOT/outputs/reports/marketing-daily-guard-${DATE}.json"
RUN_REPORT_FILE="$STATE_DIR/reports/marketing-live-guard-${DATE}-${RUN_ID}.json"
REPAIR_QUEUE_FILE="$STATE_DIR/repair-queues/marketing-repair-${DATE}.json"

prepare_shared_lock_file "$LOCK_FILE"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[cloud_marketing_live_guard] another marketing live guard is running; skip"
  exit 0
fi

exec > >(tee -a "$LOG_FILE") 2>&1

trap 'on_error "$LINENO" "$?"' ERR
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP

cd "$ROOT"
echo "[cloud_marketing_live_guard] start date=$DATE runId=$RUN_ID root=$ROOT group=$GROUP"

if [[ "$FORCE_RERUN" != "1" && "$(today_guard_already_ok)" == "1" ]]; then
  echo "[cloud_marketing_live_guard] today already has a successful inspection; retry window exits without another scan or browser cleanup"
  exit 0
fi

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

# Both evidence collectors use session-manager cookie snapshots. Inspection is
# deliberately browserless: it must not acquire browser leases, launch Chrome,
# or clean profiles owned by unrelated tasks.
echo "[cloud_marketing_live_guard] browserless inspection via session HTTP"

COST_MAP_STATUS=0
echo "[cloud_marketing_live_guard] refresh current marketing cost evidence"
if refresh_marketing_cost_map; then
  echo "[cloud_marketing_live_guard] marketing cost evidence refreshed"
else
  COST_MAP_STATUS=$?
  echo "[cloud_marketing_live_guard] WARN marketing cost evidence returned status=$COST_MAP_STATUS" >&2
fi

# Ordinary marketing is the highest-priority layer. Refresh its full-store live
# evidence every day before evaluating limited-discount drift or fallback work.
# Session HTTP reuses the session-manager evidence and does not open browsers;
# the guard report below verifies 19/19 explicit store coverage and freshness.
STACK_REVIEW_STATUS=0
echo "[cloud_marketing_live_guard] refresh ordinary marketing stack review via session HTTP"
if run_stage_with_retry "ordinary-stack-review" run_marketing_stack_review; then
  echo "[cloud_marketing_live_guard] ordinary marketing stack review refreshed"
else
  STACK_REVIEW_STATUS=$?
  echo "[cloud_marketing_live_guard] WARN ordinary marketing stack review returned status=$STACK_REVIEW_STATUS" >&2
fi

SCAN_STATUS=0
if run_stage_with_retry "limited-discount-live-scan" run_live_scan "$SCAN_OUT"; then
  echo "[cloud_marketing_live_guard] live scan done scan=$SCAN_OUT"
else
  SCAN_STATUS=$?
  echo "[cloud_marketing_live_guard] WARN live scan returned status=$SCAN_STATUS; keep partial evidence and continue guard" >&2
fi

GUARD_STATUS=0
if run_stage_with_retry "guard-report" run_guard_report; then
  echo "[cloud_marketing_live_guard] guard report done guard=$GUARD_OUT"
else
  GUARD_STATUS=$?
  echo "[cloud_marketing_live_guard] WARN guard report returned status=$GUARD_STATUS" >&2
fi

ON_SHELF_PLAN_STATUS=0
HIGH_CLICK_PLAN_STATUS=0
MANUAL_PLAN_STATUS=0
DRIFT_PLAN_STATUS=0
REPAIR_QUEUE_BUILD_STATUS=0
REPAIR_DEFERRED=0
REPAIR_TOTAL_ROWS=0
REPAIR_TOTAL_GROUPS=0
ORDINARY_LIVE_READY="$(guard_json_value '(j.marketingStackReviewCoverage?.coverageComplete === true && Number(j.marketingStackReviewFreshness?.activityAgeHours ?? 999999) <= Number(j.marketingStackReviewFreshness?.activityFreshnessThresholdHours ?? 48)) ? 1 : 0' 0)"
echo "[cloud_marketing_live_guard] ordinary live evidence ready=$ORDINARY_LIVE_READY stackReviewStatus=$STACK_REVIEW_STATUS"
if [[ "$BUILD_REPAIR_QUEUE" == "1" && "$STACK_REVIEW_STATUS" -eq 0 && "$ORDINARY_LIVE_READY" -eq 1 && "$SCAN_STATUS" -eq 0 && "$GUARD_STATUS" -eq 0 ]]; then
  HIGH_CLICK_ACTION_COUNT="$(guard_json_value 'Number(j.highClickLowConversionSpecial?.actionCount || 0)' 0)"
  echo "[cloud_marketing_live_guard] build high-click low-conversion protected special-discount plan"
  if run_high_click_special_plan; then
    echo "[cloud_marketing_live_guard] high-click special plan ready actions=$HIGH_CLICK_ACTION_COUNT"
  else
    HIGH_CLICK_PLAN_STATUS=$?
    REPAIR_QUEUE_BUILD_STATUS=90
    echo "[cloud_marketing_live_guard] WARN high-click special plan returned status=$HIGH_CLICK_PLAN_STATUS" >&2
  fi
  DRIFT_BELOW_COUNT="$(guard_json_value '(j.limitedDiscountTargetPriceDrift?.belowRows || []).length' 0)"
  GUARD_NEW_LISTING_EXEC_COUNT="$(guard_json_value '(j.newSkcCandidates?.newListingWithin7DaysLimitedDiscount?.executableActionCount || 0)' 0)"
  NEW_LISTING_EXEC_COUNT="$GUARD_NEW_LISTING_EXEC_COUNT"
  echo "[cloud_marketing_live_guard] build complete-live-scan diff for all on-shelf limited-discount gaps"
  if run_on_shelf_limited_discount_plan; then
    ON_SHELF_PLAN_COUNT="$(on_shelf_limited_discount_plan_count)"
    if [[ "$ON_SHELF_PLAN_COUNT" =~ ^[0-9]+$ && "$ON_SHELF_PLAN_COUNT" -gt "$NEW_LISTING_EXEC_COUNT" ]]; then
      NEW_LISTING_EXEC_COUNT="$ON_SHELF_PLAN_COUNT"
    fi
    echo "[cloud_marketing_live_guard] all-on-shelf limited-discount plan actionable=$ON_SHELF_PLAN_COUNT"
  else
    ON_SHELF_PLAN_STATUS=$?
    echo "[cloud_marketing_live_guard] WARN all-on-shelf limited-discount plan returned status=$ON_SHELF_PLAN_STATUS" >&2
  fi
  MANUAL_SPECIAL_RESTORE_COUNT="$(guard_json_value 'Number(j.manualSpecialLimitedDiscount?.actionCount || 0)' 0)"
  if [[ "$MANUAL_SPECIAL_RESTORE_COUNT" =~ ^[0-9]+$ && "$MANUAL_SPECIAL_RESTORE_COUNT" -gt 0 ]]; then
    echo "[cloud_marketing_live_guard] build exact current-run manual-special restore manifest"
    if run_manual_special_restore_plan; then
      echo "[cloud_marketing_live_guard] exact manual-special restore manifest ready"
    else
      MANUAL_PLAN_STATUS=$?
      REPAIR_QUEUE_BUILD_STATUS=91
      echo "[cloud_marketing_live_guard] WARN manual-special restore plan returned status=$MANUAL_PLAN_STATUS" >&2
    fi
  fi
  if [[ "$ON_SHELF_PLAN_STATUS" -eq 0 && "$DRIFT_BELOW_COUNT" =~ ^[0-9]+$ && "$DRIFT_BELOW_COUNT" -gt 0 ]]; then
    echo "[cloud_marketing_live_guard] build exact current-run drift repair manifest"
    if run_drift_repair_plan; then
      echo "[cloud_marketing_live_guard] exact drift repair manifest ready"
    else
      DRIFT_PLAN_STATUS=$?
      REPAIR_QUEUE_BUILD_STATUS=92
      echo "[cloud_marketing_live_guard] WARN drift repair plan returned status=$DRIFT_PLAN_STATUS" >&2
    fi
  fi
  if [[ "$HIGH_CLICK_PLAN_STATUS" -eq 0 && "$ON_SHELF_PLAN_STATUS" -eq 0 && "$MANUAL_PLAN_STATUS" -eq 0 && "$DRIFT_PLAN_STATUS" -eq 0 ]]; then
    if build_repair_queue; then
      REPAIR_TOTAL_ROWS="$(queue_json_value 'Number(j.counts?.totalRows || 0)' 0)"
      REPAIR_TOTAL_GROUPS="$(queue_json_value 'Number(j.counts?.totalGroups || 0)' 0)"
      if [[ "$REPAIR_TOTAL_ROWS" =~ ^[0-9]+$ && "$REPAIR_TOTAL_ROWS" -gt 0 ]]; then
        REPAIR_DEFERRED=1
        node scripts/marketing/manage_marketing_repair_queue.mjs handoff-local \
          --queue "$REPAIR_QUEUE_FILE" \
          --reason "cloud marketing writes are disabled; preserve the exact queue for local controlled execution"
        echo "[cloud_marketing_live_guard] repair workload queued rows=$REPAIR_TOTAL_ROWS groups=$REPAIR_TOTAL_GROUPS; cloud inspection is complete and all writes are handed to local controlled execution"
      fi
    else
      REPAIR_QUEUE_BUILD_STATUS=$?
      echo "[cloud_marketing_live_guard] WARN repair queue build returned status=$REPAIR_QUEUE_BUILD_STATUS" >&2
    fi
  fi
  echo "[cloud_marketing_live_guard] action check highClickSpecial=$HIGH_CLICK_ACTION_COUNT manualSpecialRestore=$MANUAL_SPECIAL_RESTORE_COUNT driftBelow=$DRIFT_BELOW_COUNT limitedFallbackExecutable=$NEW_LISTING_EXEC_COUNT deferred=$REPAIR_DEFERRED"
  echo "[cloud_marketing_live_guard] inspection phase complete; no SHEIN mutation is executed in this service. The exact hashed queue is consumed only by shein-bi-cloud-marketing-repair.service."
else
  if [[ "$BUILD_REPAIR_QUEUE" != "1" ]]; then
    echo "[cloud_marketing_live_guard] repair queue build disabled"
  else
    echo "[cloud_marketing_live_guard] skip auto repair because stackReviewStatus=$STACK_REVIEW_STATUS ordinaryLiveReady=$ORDINARY_LIVE_READY scanStatus=$SCAN_STATUS guardStatus=$GUARD_STATUS"
  fi
fi

if [[ "$COST_MAP_STATUS" -eq 0 && "$STACK_REVIEW_STATUS" -eq 0 && "$ORDINARY_LIVE_READY" -eq 1 && "$SCAN_STATUS" -eq 0 && "$GUARD_STATUS" -eq 0 && "$HIGH_CLICK_PLAN_STATUS" -eq 0 && "$ON_SHELF_PLAN_STATUS" -eq 0 && "$MANUAL_PLAN_STATUS" -eq 0 && "$DRIFT_PLAN_STATUS" -eq 0 && "$REPAIR_QUEUE_BUILD_STATUS" -eq 0 ]]; then
  write_state "ok" "marketing inspection completed; repairDeferred=$REPAIR_DEFERRED" 1
  if [[ "$REPAIR_TOTAL_ROWS" -eq 0 ]]; then
    node scripts/marketing/send_marketing_daily_group_report.mjs \
      --date "$DATE" --queue "$REPAIR_QUEUE_FILE" --guard "$GUARD_OUT" \
      || echo "[cloud_marketing_live_guard] WARN group report delivery failed" >&2
  else
    echo "[cloud_marketing_live_guard] final group report waits for the same-day repair queue terminal state; no intermediate report sent"
  fi
  echo "[cloud_marketing_live_guard] done ok date=$DATE log=$LOG_FILE"
else
  write_state "warning" "costMap=$COST_MAP_STATUS stackReview=$STACK_REVIEW_STATUS ordinaryLiveReady=$ORDINARY_LIVE_READY liveScan=$SCAN_STATUS guard=$GUARD_STATUS highClickPlan=$HIGH_CLICK_PLAN_STATUS onShelfPlan=$ON_SHELF_PLAN_STATUS manualPlan=$MANUAL_PLAN_STATUS driftPlan=$DRIFT_PLAN_STATUS repairQueue=$REPAIR_QUEUE_BUILD_STATUS" 0
  echo "[cloud_marketing_live_guard] done warning costMapStatus=$COST_MAP_STATUS stackReviewStatus=$STACK_REVIEW_STATUS ordinaryLiveReady=$ORDINARY_LIVE_READY scanStatus=$SCAN_STATUS guardStatus=$GUARD_STATUS highClickPlanStatus=$HIGH_CLICK_PLAN_STATUS onShelfPlanStatus=$ON_SHELF_PLAN_STATUS manualPlanStatus=$MANUAL_PLAN_STATUS driftPlanStatus=$DRIFT_PLAN_STATUS repairQueueStatus=$REPAIR_QUEUE_BUILD_STATUS log=$LOG_FILE" >&2
  exit 1
fi
