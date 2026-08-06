#!/usr/bin/env bash
# Read-only ET storage-fee ingestion. It intentionally shares the generic ET
# lock/profile so an ET browser session can never be used by both pipelines.
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
source "$ROOT/scripts/lib/shared_lock.sh"
# The service account deliberately uses an audited NOPASSWD sudo rule for the
# Docker-backed warehouse checks. Keep manual backfills on the same path.
export SHEIN_DOCKER_USE_SUDO="${SHEIN_DOCKER_USE_SUDO:-1}"
MODE="${1:-daily}"
TARGET_DATE="${2:-$(TZ="${SHEIN_BI_TZ:-Asia/Shanghai}" date +%F)}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
BACKFILL_START_DATE="${SHEIN_ET_STORAGE_FEE_BACKFILL_START_DATE:-2025-11-17}"
LOG_DIR="${SHEIN_ET_STORAGE_FEE_LOG_DIR:-/srv/shein-bi/logs/cloud-et-storage-fee}"
# Deliberately the generic ET lock: this is mutual exclusion, not merely a
# storage-fee job lock.
LOCK_FILE="${SHEIN_ET_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-et-forwarder.lock}"
ET_PROFILE_DIR="${SHEIN_ET_PROFILE_DIR:-$ROOT/profiles/persistent-et-forwarder-profile}"
STATE_PATH="${SHEIN_ET_STORAGE_FEE_STATE_PATH:-$ROOT/state/et_storage_fee_sync_state.json}"
OUTPUT_DIR="${SHEIN_ET_STORAGE_FEE_OUTPUT_DIR:-$ROOT/outputs/et-storage-fee}"
ET_CHROME_TMP_DIR="${SHEIN_ET_STORAGE_FEE_CHROME_TMP_DIR:-/tmp/shein-bi-et-storage-fee-chrome-tmp}"
PHASE="fetch"

case "$MODE" in
  daily|backfill) ;;
  *) echo "Usage: $0 [daily|backfill] [YYYY-MM-DD]" >&2; exit 64 ;;
esac
if [[ ! "$TARGET_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "Invalid target date: $TARGET_DATE" >&2
  exit 64
fi

mkdir -p "$LOG_DIR"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/et-storage-fee-${MODE}-${TARGET_DATE}-${STAMP}.log"
exec > >(tee -a "$LOG_FILE") 2>&1

notify_issue() {
  local message="$1"
  if command -v lark-cli >/dev/null 2>&1 && [[ -f "$ROOT/config/lark_report.json" ]]; then
    node "$ROOT/scripts/notify_sync_issue.mjs" --mode cloud-et-storage-fee --date "$TARGET_DATE" \
      --failed-stores ET --message "$message" --log-file "$LOG_FILE" || true
  fi
}

prepare_et_chrome_tmp() {
  mkdir -p "$ET_CHROME_TMP_DIR"
  chmod 0700 "$ET_CHROME_TMP_DIR"
  export TMPDIR="$ET_CHROME_TMP_DIR"
  echo "[cloud_et_storage_fee_sync] chrome tmp dir=$TMPDIR"
}

et_chrome_pids() {
  # First match the exact profile argument, then verify the executable through
  # /proc. This accepts /opt/google/chrome/chrome while excluding awk itself.
  ps -eo pid=,args= | awk -v profile="--user-data-dir=$ET_PROFILE_DIR" \
    'index($0, profile) {print $1}' | while read -r pid; do
      [[ -r "/proc/$pid/exe" ]] || continue
      local exe
      exe="$(readlink -f -- "/proc/$pid/exe" 2>/dev/null || true)"
      case "$(basename -- "$exe")" in
        chrome|google-chrome|google-chrome-stable|chromium|chromium-browser) printf '%s\n' "$pid" ;;
      esac
    done
}

signal_et_chrome() {
  local signal="$1"
  local pids
  pids="$(et_chrome_pids)"
  [[ -n "$pids" ]] || return 0
  # shellcheck disable=SC2086 # PIDs originate from ps/awk above.
  kill "-$signal" $pids 2>/dev/null || true
}

cleanup_et_browser() {
  local wait_round
  signal_et_chrome TERM
  for wait_round in 1 2 3 4 5 6 7 8 9 10; do
    [[ -z "$(et_chrome_pids)" ]] && break
    sleep 0.5
  done
  signal_et_chrome KILL
  # Do not sweep /tmp or a generic ET job's files.
  if [[ "$ET_CHROME_TMP_DIR" == /tmp/shein-bi-et-storage-fee-chrome-tmp* ]]; then
    find "$ET_CHROME_TMP_DIR" -mindepth 1 -maxdepth 1 \
      \( -name 'com.google.Chrome.*' -o -name '.com.google.Chrome.*' \) \
      -exec rm -rf -- {} + 2>/dev/null || true
    rmdir "$ET_CHROME_TMP_DIR" 2>/dev/null || true
  fi
}

on_error() {
  local code=$?
  local cache_state="raw/cache may have advanced; inspect audit before relying on the result"
  if [[ "$PHASE" == "fetch" || "$PHASE" == "validate" || "$PHASE" == "load" ]]; then
    cache_state="previous profit and portal caches were retained"
  fi
  notify_issue "ET storage-fee sync failed phase=$PHASE; $cache_state. See log: $LOG_FILE"
  echo "[cloud_et_storage_fee_sync] ERROR code=$code phase=$PHASE; $cache_state" >&2
  exit "$code"
}
trap on_error ERR
prepare_shared_lock_file "$LOCK_FILE"
exec 9>"$LOCK_FILE"
if ! flock -w "${SHEIN_ET_STORAGE_FEE_LOCK_WAIT_SEC:-1800}" 9; then
  LOCK_MESSAGE="shared ET lock remained busy after ${SHEIN_ET_STORAGE_FEE_LOCK_WAIT_SEC:-1800}s; storage-fee sync did not run and requires retry"
  notify_issue "ET storage-fee sync failed phase=lock; $LOCK_MESSAGE. See log: $LOG_FILE"
  echo "[cloud_et_storage_fee_sync] ERROR $LOCK_MESSAGE" >&2
  exit 75
fi
prepare_et_chrome_tmp
trap cleanup_et_browser EXIT

cd "$ROOT"
mkdir -p "$OUTPUT_DIR"
chmod 0750 "$OUTPUT_DIR"
FETCH_ARGS=(--storage-fee-only --detail-names storage_fee_product_detail --mode "$MODE" --date "$TARGET_DATE" --profile-dir "$ET_PROFILE_DIR" --state-path "$STATE_PATH" --out-dir "$OUTPUT_DIR" --wait-ms "${SHEIN_ET_STORAGE_FEE_WAIT_MS:-250}")
if [[ "$MODE" == "daily" ]]; then
  # Previous-month-to-date is a bounded, safe overlap window; detail exports
  # repair late-generated bills without fetching unrelated finance categories.
  FETCH_ARGS+=(--detail-all --overlap-rows "${SHEIN_ET_STORAGE_FEE_OVERLAP_ROWS:-5}" --daily-initial-pages "${SHEIN_ET_STORAGE_FEE_DAILY_INITIAL_PAGES:-2}")
else
  FETCH_ARGS+=(--start-date "$BACKFILL_START_DATE" --detail-all --no-state-update)
fi

echo "[cloud_et_storage_fee_sync] start mode=$MODE date=$TARGET_DATE profile=$ET_PROFILE_DIR lock=$LOCK_FILE"
PHASE="fetch"
node scripts/fetch_et_forwarder.mjs "${FETCH_ARGS[@]}"
MANIFEST_INDEX="$OUTPUT_DIR/latest-manifest.json"
MANIFEST_PATH="$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(j.manifestPath||'')" "$MANIFEST_INDEX")"
[[ -n "$MANIFEST_PATH" ]] || { echo 'ET storage-fee manifest path is empty' >&2; exit 1; }

# An ExportStoreFee failure is not a complete backfill. Do this before loading
# so a failed/partial export cannot be advertised as a successful warehouse run.
PHASE="validate"
node - "$MANIFEST_PATH" <<'NODE'
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const bills = Number(manifest.endpoints?.income_bill?.rowCount || 0);
const detail = manifest.endpoints?.storage_fee_product_detail;
if (!bills) process.exit(0);
const incomplete = !detail
  || Number(detail.errorCount || 0) > 0
  || Number(detail.parentCount || 0) !== Number(detail.totalParents || 0)
  || Number(detail.skippedParents || 0) > 0
  || Number(detail.rowCount || 0) === 0;
if (incomplete) {
  console.error('[cloud_et_storage_fee_sync] incomplete ExportStoreFee detail; retry required', JSON.stringify({bills, detail}));
  process.exit(2);
}
NODE

PHASE="load"
node scripts/load_et_forwarder_warehouse.mjs --manifest "$MANIFEST_PATH"
# refresh_profit_marts publishes atomically; a failure leaves the last complete
# cache in place and ERR above makes the degradation visible to operators.
PHASE="refresh"
bash scripts/refresh_profit_marts.sh

# The reconciliation check covers ET detail -> allocation -> profit cache. It
# runs only after the cache publish, so a nonzero result is an operator alert
# while the previous complete portal cache remains available.
if [[ "$MODE" == "backfill" ]]; then
  COVERAGE_START="$BACKFILL_START_DATE"
else
  COVERAGE_START="$(TZ="$TZ_NAME" date -d "$TARGET_DATE -1 month" +%Y-%m-01)"
fi
PHASE="audit"
COVERAGE_END="$(TZ="$TZ_NAME" date -d "$TARGET_DATE +1 day" +%F)"
node scripts/check_storage_fee_profit.mjs --mode local --start "$COVERAGE_START" --end "$COVERAGE_END"
node scripts/audit_bi_warehouse.mjs

if [[ "${SHEIN_ET_STORAGE_FEE_REFRESH_PORTAL:-1}" == "1" ]]; then
  PHASE="enqueue"
  # Storage fees change profit only. Publishing the warehouse/profit facts is
  # the business completion boundary; slow Portal sections belong to the
  # bounded materializer queue and must not turn a successful ET settlement
  # into a systemd timeout.
  if bash scripts/enqueue_bi_portal_sections.sh \
    --sections profit,homeProfit \
    --priority 10 \
    --reason "et-storage-fee-${TARGET_DATE}"; then
    echo '[cloud_et_storage_fee_sync] portal refresh queued sections=profit,homeProfit'
  else
    echo '[cloud_et_storage_fee_sync] WARN portal section enqueue failed; settled warehouse/profit cache remains valid' >&2
  fi
fi

echo "[cloud_et_storage_fee_sync] done mode=$MODE date=$TARGET_DATE manifest=$MANIFEST_PATH log=$LOG_FILE"
