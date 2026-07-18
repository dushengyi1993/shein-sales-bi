#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
source "$ROOT/scripts/lib/shared_lock.sh"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
DATE="${SHEIN_BI_MARKETING_REPAIR_DATE:-$(TZ="$TZ_NAME" date +%F)}"
LOG_DIR="${SHEIN_BI_MARKETING_REPAIR_LOG_DIR:-/srv/shein-bi/logs/cloud-marketing-repair}"
STATE_DIR="${SHEIN_BI_MARKETING_LIVE_STATE_DIR:-$ROOT/state/cloud_marketing_live_guard}"
ALERT_DIR="$ROOT/state/cloud_ops_alerts"
QUEUE_FILE="$STATE_DIR/repair-queues/marketing-repair-${DATE}.json"
LOCK_FILE="${SHEIN_BI_MARKETING_REPAIR_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-marketing-repair.lock}"
LEASE_TASK="${SHEIN_BI_MARKETING_REPAIR_LEASE_TASK:-cloud-marketing-repair}"
LEASE_TTL_SEC="${SHEIN_BI_MARKETING_REPAIR_LEASE_TTL_SEC:-3000}"
LEASE_ACQUIRED=0
MAX_GROUPS="${SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS:-8}"
SCAN_TIMEOUT_SEC="${SHEIN_BI_MARKETING_LIVE_SCAN_TIMEOUT_SEC:-2400}"
SCAN_KILL_AFTER_SEC="${SHEIN_BI_MARKETING_LIVE_SCAN_KILL_AFTER_SEC:-60}"
GUARD_MAX_AGE_HOURS="${SHEIN_BI_MARKETING_LIVE_GUARD_MAX_AGE_HOURS:-96}"
GUARD_CLOUD_BI_SSH="${SHEIN_BI_MARKETING_LIVE_CLOUD_BI_SSH:-local}"
GUARD_CLOUD_BI_ROOT="${SHEIN_BI_MARKETING_LIVE_CLOUD_BI_ROOT:-$ROOT}"
BUSY_SERVICES="${SHEIN_BI_MARKETING_REPAIR_BUSY_SERVICES:-shein-bi-cloud-marketing-live-guard.service shein-bi-cloud-today.service shein-bi-cloud-yesterday.service shein-bi-cloud-et-forwarder.service shein-bi-cloud-daily-refresh.service shein-bi-cloud-session-manager.service shein-bi-cloud-morning-chain.service shein-bi-cloud-order-closure.service shein-bi-db-backup.service}"

queue_value() {
  local expression="$1"
  local default_value="${2:-}"
  JSON_FILE="$QUEUE_FILE" JSON_EXPR="$expression" JSON_DEFAULT="$default_value" node <<'NODE'
const fs = require('node:fs');
try {
  const j = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
  const value = new Function('j', `return (${process.env.JSON_EXPR});`)(j);
  console.log(value === undefined || value === null || Number.isNaN(value) ? process.env.JSON_DEFAULT : String(value));
} catch { console.log(process.env.JSON_DEFAULT); }
NODE
}

active_busy_services() {
  local active=() service
  command -v systemctl >/dev/null 2>&1 || return 0
  for service in $BUSY_SERVICES; do
    systemctl is-active --quiet "$service" && active+=("$service")
  done
  printf '%s\n' "${active[*]}"
}

cleanup_store_browsers() {
  cd "$ROOT"
  local owned_args=()
  if [[ "$LEASE_ACQUIRED" == "1" && -n "${RUN_ID:-}" ]]; then
    owned_args=(--owned-lease-task "$LEASE_TASK" --owned-lease-run-id "$RUN_ID")
  fi
  node scripts/cleanup_shein_store_browsers.mjs --all --cleanup-chrome-tmp --kill-after-sec 5 "${owned_args[@]}" || true
}

new_groups_in_result() {
  local result_path="$1"
  JSON_FILE="$ROOT/$result_path" node <<'NODE'
const fs = require('node:fs');
try {
  const value = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
  const resumed = Number(value.resumedGroups || 0);
  const total = Array.isArray(value.results) ? value.results.length : 0;
  console.log(Math.max(0, total - resumed));
} catch {
  console.log(0);
}
NODE
}

processed_items_this_run() {
  local result_path="$1"
  JSON_FILE="$ROOT/$result_path" node <<'NODE'
const fs = require('node:fs');
try {
  const value = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
  console.log(Math.max(0, Number(value?.totals?.processedThisRun || 0)));
} catch {
  console.log(0);
}
NODE
}

consume_group_budget() {
  local count="${1:-0}"
  [[ "$count" =~ ^[0-9]+$ ]] || count=0
  if (( count >= REMAINING_GROUPS )); then REMAINING_GROUPS=0; else REMAINING_GROUPS=$((REMAINING_GROUPS - count)); fi
}

lease_action() {
  node scripts/manage_browser_task_leases.mjs "$1" --root "$ROOT" --task "$LEASE_TASK" --run-id "$RUN_ID" --owner-pid "$$" --ttl-sec "$LEASE_TTL_SEC" --group ALL
}

update_stage() {
  local stage="$1" status="$2" readback_ok="$3" detail="$4" result_path="${5:-}"
  node scripts/marketing/manage_marketing_repair_queue.mjs update-stage \
    --queue "$QUEUE_FILE" --stage "$stage" --status "$status" \
    --readback-ok "$readback_ok" --detail "$detail" --result-path "$result_path"
}

write_state() {
  local status="$1" message="$2"
  mkdir -p "$ALERT_DIR"
  STATE_FILE="$ALERT_DIR/marketing-repair-last.json" STATE_DATE="$DATE" STATE_STATUS="$status" STATE_MESSAGE="$message" STATE_LOG="$LOG_FILE" STATE_QUEUE="$QUEUE_FILE" node <<'NODE'
const fs = require('node:fs');
const state = {
  date: process.env.STATE_DATE,
  generatedAt: new Date().toISOString(),
  status: process.env.STATE_STATUS,
  message: process.env.STATE_MESSAGE,
  logFile: process.env.STATE_LOG,
  queueFile: process.env.STATE_QUEUE,
};
try {
  const queue = JSON.parse(fs.readFileSync(process.env.STATE_QUEUE, 'utf8'));
  state.queueStatus = queue.status;
  state.queueCounts = queue.counts;
  state.queueFingerprint = queue.queueFingerprint;
} catch {}
fs.writeFileSync(process.env.STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
NODE
}

run_final_readback() {
  local stamp scan_out guard_out price_overrides price_path manual_count drift_count manual_plan
  stamp="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)-repair-final"
  scan_out="$ROOT/tmp/marketing-signup/current-price-live/current-marketing-price-live-${DATE}-${stamp}.json"
  guard_out="$ROOT/outputs/reports/marketing-daily-guard-${DATE}.json"
  lease_action heartbeat
  timeout -k "$SCAN_KILL_AFTER_SEC" "$SCAN_TIMEOUT_SEC" \
    node scripts/marketing/scan_current_marketing_prices_for_bi.mjs \
      --group ALL --page-size 500 --store-attempts 3 \
      --session-http --session-concurrency "${SHEIN_BI_MARKETING_PRICE_SESSION_CONCURRENCY:-3}" \
      --out "$scan_out"
  lease_action heartbeat
  node scripts/marketing/build_marketing_daily_guard_report.mjs \
    --date "$DATE" --max-age-hours "$GUARD_MAX_AGE_HOURS" \
    --cloud-bi-ssh "$GUARD_CLOUD_BI_SSH" --cloud-bi-root "$GUARD_CLOUD_BI_ROOT"
  price_overrides="$(GUARD_FILE="$guard_out" node -e "const j=require(process.env.GUARD_FILE);process.stdout.write(String(j.targetPlanSelection?.priceOverrides||''))")"
  [[ -n "$price_overrides" ]] || return 2
  if [[ "$price_overrides" == /* ]]; then price_path="$price_overrides"; else price_path="$ROOT/$price_overrides"; fi
  node scripts/marketing/build_new_listing_limited_discount_plan.mjs \
    --date "$DATE" --source-guard "$guard_out" --exclude-manual-special true --price-overrides "$price_path" \
    --current-marketing-live-scan "$scan_out"
  manual_count="$(GUARD_FILE="$guard_out" node -e "const j=require(process.env.GUARD_FILE);process.stdout.write(String(Number(j.manualSpecialLimitedDiscount?.actionCount||0)))")"
  manual_plan="$ROOT/tmp/marketing-signup/manual-limited-discount-restore/${DATE}/manual-limited-discount-restore-plan.json"
  if [[ "$manual_count" -gt 0 ]]; then
    node scripts/marketing/build_manual_limited_discount_restore_plan.mjs \
      --guard "$guard_out" \
      --out-dir "$(dirname "$manual_plan")"
  fi
  drift_count="$(GUARD_FILE="$guard_out" node -e "const j=require(process.env.GUARD_FILE);process.stdout.write(String((j.limitedDiscountTargetPriceDrift?.belowRows||[]).length))")"
  if [[ "$drift_count" -gt 0 ]]; then
    node scripts/marketing/build_limited_discount_drift_rescue_plan.mjs \
      --guard "$guard_out" \
      --out-dir "$ROOT/tmp/marketing-signup/limited-discount-fallback/target-price-drift-${DATE}" \
      --end-time "$(TZ="$TZ_NAME" date -d "$DATE +7 days" +%F) 23:59:59"
  fi
  node scripts/marketing/manage_marketing_repair_queue.mjs build \
    --date "$DATE" --guard "$guard_out" \
    --manual-plan "$manual_plan" \
    --drift-plan-dir "$ROOT/tmp/marketing-signup/limited-discount-fallback/target-price-drift-${DATE}" \
    --fallback-plan "$ROOT/outputs/reports/new-listing-7d-limited-discount-plan-${DATE}.json" \
    --queue "$QUEUE_FILE"
}

on_exit() {
  local status="$?"
  trap - EXIT
  set +e
  if [[ "$LEASE_ACQUIRED" == "1" ]]; then
    cleanup_store_browsers
    lease_action release >/dev/null 2>&1
    LEASE_ACQUIRED=0
  fi
  exit "$status"
}

mkdir -p "$LOG_DIR" "$STATE_DIR/repair-queues" "$ALERT_DIR"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
RUN_ID="${SHEIN_BI_MARKETING_REPAIR_RUN_ID:-$(node -e 'console.log(require("node:crypto").randomUUID())')}"
LOG_FILE="$LOG_DIR/marketing-repair-${DATE}-${STAMP}.log"
prepare_shared_lock_file "$LOCK_FILE"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[cloud_marketing_repair] another repair worker is running; skip"
  exit 0
fi
exec > >(tee -a "$LOG_FILE") 2>&1
trap on_exit EXIT
cd "$ROOT"

if [[ ! -f "$QUEUE_FILE" ]]; then
  echo "[cloud_marketing_repair] no queue for date=$DATE"
  exit 0
fi
QUEUE_STATUS="$(queue_value 'j.status' missing)"
if [[ "$QUEUE_STATUS" == "completed" ]]; then
  write_state ok "repair queue already completed"
  echo "[cloud_marketing_repair] queue already completed"
  exit 0
fi
ACTIVE_BUSY="$(active_busy_services)"
if [[ -n "$ACTIVE_BUSY" ]]; then
  write_state skipped_busy "busy services active: $ACTIVE_BUSY"
  echo "[cloud_marketing_repair] SKIP busy services active: $ACTIVE_BUSY"
  exit 0
fi

lease_action acquire
LEASE_ACQUIRED=1
export SHEIN_BI_BROWSER_LEASE_TASK="$LEASE_TASK"
export SHEIN_BI_BROWSER_LEASE_RUN_ID="$RUN_ID"
cleanup_store_browsers
REMAINING_GROUPS="$MAX_GROUPS"

MANUAL_STATUS="$(queue_value 'j.stages?.manualSpecialRestore?.status' not_required)"
if [[ "$MANUAL_STATUS" != "not_required" && "$MANUAL_STATUS" != "completed" ]]; then
  export SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH="$(queue_value 'j.stages?.manualSpecialRestore?.workFingerprint || j.stages?.manualSpecialRestore?.inputFingerprint' '')"
  WORK_FINGERPRINT="$(queue_value 'j.stages?.manualSpecialRestore?.workFingerprint' '')"
  GUARD_PATH="$ROOT/$(queue_value 'j.sourceGuard' '')"
  MANUAL_PLAN_PATH="$ROOT/$(queue_value 'j.stages?.manualSpecialRestore?.planPath' '')"
  MANUAL_OUT_DIR="$(dirname "$MANUAL_PLAN_PATH")"
  RESULT_PATH="tmp/marketing-signup/manual-limited-discount-restore/${DATE}/manual-limited-discount-restore-result.json"
  if node scripts/marketing/batch_restore_manual_limited_discounts.mjs \
      --guard "$GUARD_PATH" --out-dir "$MANUAL_OUT_DIR" --skip-build --execute \
      --max-items "$REMAINING_GROUPS" --result "$ROOT/$RESULT_PATH" \
      --expected-work-fingerprint "$WORK_FINGERPRINT"; then
    update_stage manualSpecialRestore completed true "bounded execute and per-item readback succeeded" "$RESULT_PATH"
    consume_group_budget "$(processed_items_this_run "$RESULT_PATH")"
  else
    status=$?
    if [[ "$status" -eq 3 ]]; then
      update_stage manualSpecialRestore pending false "bounded chunk completed; more exact-plan items remain" "$RESULT_PATH"
      write_state pending "manual-special repair chunk completed; queue will resume without replaying successful items"
      exit 0
    fi
    update_stage manualSpecialRestore failed false "execute/readback failed status=$status"
    write_state failed "manual special restore failed status=$status"
    exit "$status"
  fi
fi

if (( REMAINING_GROUPS <= 0 )); then
  write_state pending "bounded group budget consumed; remaining stages continue on the next worker run"
  exit 0
fi

DRIFT_STATUS="$(queue_value 'j.stages?.driftRepair?.status' not_required)"
if [[ "$DRIFT_STATUS" != "not_required" && "$DRIFT_STATUS" != "completed" ]]; then
  WORK_FINGERPRINT="$(queue_value 'j.stages?.driftRepair?.workFingerprint' '')"
  export SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH="$WORK_FINGERPRINT"
  GUARD_PATH="$ROOT/$(queue_value 'j.sourceGuard' '')"
  RESULT_PATH="tmp/marketing-signup/limited-discount-rescue/batch-drift-fix-result-${DATE}.json"
  if node scripts/marketing/batch_fix_limited_discount_drift.mjs \
      --guard "$GUARD_PATH" --skip-build-plan --execute --max-groups "$REMAINING_GROUPS" \
      --expected-work-fingerprint "$WORK_FINGERPRINT"; then
    update_stage driftRepair completed true "bounded execute and per-group readback succeeded" "$RESULT_PATH"
    consume_group_budget "$(new_groups_in_result "$RESULT_PATH")"
  else
    status=$?
    if [[ "$status" -eq 3 ]]; then
      update_stage driftRepair pending false "bounded chunk completed; more exact-manifest groups remain" "$RESULT_PATH"
      write_state pending "drift repair chunk completed; queue will resume without replaying successful groups"
      exit 0
    fi
    update_stage driftRepair failed false "execute/readback failed status=$status" "$RESULT_PATH"
    write_state failed "drift repair failed status=$status"
    exit "$status"
  fi
fi


if (( REMAINING_GROUPS <= 0 )); then
  write_state pending "bounded group budget consumed; remaining stages continue on the next worker run"
  exit 0
fi

FALLBACK_STATUS="$(queue_value 'j.stages?.fallbackRepair?.status' not_required)"
if [[ "$FALLBACK_STATUS" != "not_required" && "$FALLBACK_STATUS" != "completed" ]]; then
  WORK_FINGERPRINT="$(queue_value 'j.stages?.fallbackRepair?.workFingerprint' '')"
  export SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH="$WORK_FINGERPRINT"
  GUARD_PATH="$ROOT/$(queue_value 'j.sourceGuard' '')"
  RESULT_PATH="outputs/reports/new-listing-7d-limited-discount-execution-summary-${DATE}.json"
  if node scripts/marketing/batch_apply_new_listing_limited_discount.mjs \
      --date "$DATE" --guard "$GUARD_PATH" --skip-build --execute --max-groups "$REMAINING_GROUPS" \
      --expected-work-fingerprint "$WORK_FINGERPRINT"; then
    update_stage fallbackRepair completed true "bounded execute and per-group readback succeeded" "$RESULT_PATH"
    consume_group_budget "$(new_groups_in_result "$RESULT_PATH")"
  else
    status=$?
    if [[ "$status" -eq 3 ]]; then
      update_stage fallbackRepair pending false "bounded chunk completed; more exact-plan groups remain" "$RESULT_PATH"
      write_state pending "fallback repair chunk completed; queue will resume without replaying successful groups"
      exit 0
    fi
    update_stage fallbackRepair failed false "execute/readback failed status=$status" "$RESULT_PATH"
    write_state failed "fallback repair failed status=$status"
    exit "$status"
  fi
fi

if [[ "$(queue_value 'j.status' pending)" == "awaiting_final_readback" ]]; then
  if run_final_readback; then
    if [[ "$(queue_value 'j.status' pending)" == "completed" ]]; then
      write_state ok "all queued repairs passed final full-store live readback"
      echo "[cloud_marketing_repair] done ok date=$DATE"
      exit 0
    fi
    write_state pending "final readback produced a smaller/new exact repair queue"
    echo "[cloud_marketing_repair] final readback found remaining bounded work"
    exit 0
  fi
  status=$?
  write_state failed "final full-store readback failed status=$status"
  exit "$status"
fi

write_state pending "repair queue remains pending"
