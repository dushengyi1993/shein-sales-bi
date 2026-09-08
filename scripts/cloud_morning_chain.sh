#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
STAGE="${1:-all}"
LOG_DIR="${SHEIN_BI_MORNING_CHAIN_LOG_DIR:-/srv/shein-bi/logs/cloud-morning-chain}"
STATE_DIR="${SHEIN_BI_MORNING_CHAIN_STATE_DIR:-$ROOT/state/cloud_morning_chain}"
# The owning wrapper injects immutable runDate/businessDate; defaults remain
# today/yesterday so the script keeps working when invoked directly.
RUN_DATE="${SHEIN_BI_MORNING_RUN_DATE:-$(TZ="$TZ_NAME" date +%F)}"
DATA_DATE="${SHEIN_BI_MORNING_BUSINESS_DATE:-$(TZ="$TZ_NAME" date -d yesterday +%F)}"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/morning-${STAGE}-${DATA_DATE}-${STAMP}.log"
DRY_RUN="${SHEIN_BI_MORNING_CHAIN_DRY_RUN:-0}"
RUN_STARTED_EPOCH="$(date +%s)"
RUN_BUDGET_SEC="${SHEIN_BI_MORNING_RUN_BUDGET_SEC:-10200}"
# The owning wrapper injects the persisted FIRST-START absolute deadline so a
# service restart can never reset the daily run budget.  When invoked directly
# the script still derives today's budget from its own start time.
RUN_DEADLINE_EPOCH="${SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH:-$((RUN_STARTED_EPOCH + RUN_BUDGET_SEC))}"
SESSION_RECOVERY_BUDGET_SEC="${SHEIN_BI_MORNING_SESSION_RECOVERY_BUDGET_SEC:-1800}"
LINK_COLLECTION_RESERVE_SEC="${SHEIN_BI_MORNING_LINK_COLLECTION_RESERVE_SEC:-7200}"
INVENTORY_RESERVE_SEC="${SHEIN_BI_MORNING_INVENTORY_RESERVE_SEC:-4500}"
PRE_INVENTORY_DEADLINE_EPOCH=$((RUN_DEADLINE_EPOCH - INVENTORY_RESERVE_SEC))
STOCK_REFRESH_MAX_SEC="${SHEIN_BI_MORNING_STOCK_REFRESH_MAX_SEC:-900}"
INVENTORY_RUNTIME_ROOT="${SHEIN_BI_INVENTORY_RUNTIME_ROOT:-/srv/shein-bi/runtime/daily-inventory-replenishment}"
MAX_STORE_NO_PROGRESS_ROUNDS="${SHEIN_BI_MORNING_STORE_NO_PROGRESS_MAX:-3}"
CATCHUP_MIN_UPTIME_SEC="${SHEIN_BI_MORNING_CATCHUP_MIN_UPTIME_SEC:-600}"
CATCHUP_RETRY_DELAY_SEC="${SHEIN_BI_MORNING_CATCHUP_RETRY_DELAY_SEC:-30}"
FULL_MANAGED_PRIORITY_SERVICES="${SHEIN_BI_MORNING_FULL_MANAGED_PRIORITY_SERVICES:-shein-fm-home-realtime.service shein-fm-home-daily.service shein-fm-session-renewal.service shein-fm-supply-sync.service shein-fm-home-finance-daily.service}"

validate_date() {
  local value="$1"
  [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || return 1
  TZ="$TZ_NAME" date -d "$value" +%F >/dev/null 2>&1
}

if ! validate_date "$RUN_DATE" || ! validate_date "$DATA_DATE"; then
  echo "[cloud_morning_chain] ERROR invalid injected run/business date runDate=$RUN_DATE businessDate=$DATA_DATE; refusing to run" >&2
  exit 64
fi

# Fail closed on any mismatched pair (runDate == businessDate, or any other
# non-adjacent pair).  The daily run can only ever operate on
# businessDate = runDate - 1 (Asia/Shanghai calendar day).
EXPECTED_BUSINESS_DATE="$(TZ="$TZ_NAME" date -d "$RUN_DATE - 1 day" +%F)"
if [[ "$DATA_DATE" != "$EXPECTED_BUSINESS_DATE" ]]; then
  echo "[cloud_morning_chain] ERROR injected businessDate=$DATA_DATE does not equal runDate=$RUN_DATE minus one day ($EXPECTED_BUSINESS_DATE); refusing to run" >&2
  exit 64
fi

now_iso() {
  TZ="$TZ_NAME" date --iso-8601=seconds
}

run_budget_remaining() {
  echo $((RUN_DEADLINE_EPOCH - $(date +%s)))
}

require_run_budget() {
  local phase="$1"
  local remaining
  remaining="$(run_budget_remaining)"
  if (( remaining <= 0 )); then
    write_state "failed" "the single daily run exhausted its ${RUN_BUDGET_SEC}s safety budget during $phase; prior complete BI snapshot remains active"
    write_marker "daily-operating-refresh" "failed" "run safety budget exhausted during $phase" "$LOG_FILE" >/dev/null || true
    echo "[cloud_morning_chain] ERROR safety budget exhausted phase=$phase terminal=restart-prevented" >&2
    exit 76
  fi
}

require_pre_inventory_budget() {
  local phase="$1"
  local remaining=$((PRE_INVENTORY_DEADLINE_EPOCH - $(date +%s)))
  if (( remaining <= 0 )); then
    write_state "failed" "inventory reserve (${INVENTORY_RESERVE_SEC}s) was reached before $phase completed; inventory was not started and the previous complete snapshot remains active"
    write_marker "morning-all" "failed" "inventory reserve reached before $phase completed" "$LOG_FILE" >/dev/null || true
    echo "[cloud_morning_chain] ERROR inventory reserve reached phase=$phase preInventoryDeadline=$PRE_INVENTORY_DEADLINE_EPOCH runDeadline=$RUN_DEADLINE_EPOCH" >&2
    exit 76
  fi
}

write_state() {
  local status="$1"
  local message="$2"
  mkdir -p "$STATE_DIR" "$ROOT/state/cloud_ops_alerts"
  STATUS="$status" MESSAGE="$message" STAGE="$STAGE" RUN_DATE="$RUN_DATE" \
  DATA_DATE="$DATA_DATE" LOG_FILE="$LOG_FILE" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.env.SHEIN_BI_ROOT || process.cwd();
const stateDir = process.env.SHEIN_BI_MORNING_CHAIN_STATE_DIR
  || path.join(root, 'state', 'cloud_morning_chain');
const payload = {
  date: process.env.RUN_DATE,
  businessDate: process.env.DATA_DATE,
  generatedAt: new Date().toISOString(),
  stage: process.env.STAGE,
  status: process.env.STATUS,
  message: process.env.MESSAGE,
  logFile: process.env.LOG_FILE,
};
const write = file => {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {mode: 0o660});
  fs.renameSync(temporary, file);
};
write(path.join(stateDir, 'latest.json'));
if (payload.status === 'ok' && ['all', 'supplements'].includes(payload.stage)) {
  try { fs.unlinkSync(path.join(root, 'state', 'cloud_ops_alerts', 'morning-chain-last.json')); } catch {}
} else if (!['ok', 'running'].includes(payload.status)) {
  write(path.join(root, 'state', 'cloud_ops_alerts', 'morning-chain-last.json'));
}
NODE
}

write_marker() {
  local marker_stage="$1"
  local status="$2"
  local message="$3"
  shift 3
  local args=(
    write
    --stage "$marker_stage"
    --date "$RUN_DATE"
    --business-date "$DATA_DATE"
    --status "$status"
    --message "$message"
    --snapshot-evidence
  )
  local evidence
  for evidence in "$@"; do
    [[ -n "$evidence" ]] && args+=(--evidence "$evidence")
  done
  node "$ROOT/scripts/pipeline_marker.mjs" "${args[@]}"
}

pipeline_marker_done() {
  local marker_stage="$1"
  MARKER_STAGE="$marker_stage" RUN_DATE="$RUN_DATE" DATA_DATE="$DATA_DATE" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.env.SHEIN_BI_ROOT || process.cwd();
const file = path.join(root, 'state', 'pipeline-markers', process.env.RUN_DATE, `${process.env.MARKER_STAGE}.json`);
try {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  process.exit(payload?.ok === true
    && payload?.status === 'done'
    && payload?.runDate === process.env.RUN_DATE
    && payload?.businessDate === process.env.DATA_DATE ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

daily_operating_refresh_done() {
  node "$ROOT/scripts/validate_daily_operating_refresh.mjs" \
    --root "$ROOT" \
    --marker-root "$ROOT/state/pipeline-markers" \
    --state-dir "$STATE_DIR" \
    --inventory-runtime-root "$INVENTORY_RUNTIME_ROOT" \
    --run-date "$RUN_DATE" \
    --business-date "$DATA_DATE" >/dev/null
}

daily_operating_refresh_warning() {
  if ! RUN_DATE="$RUN_DATE" DATA_DATE="$DATA_DATE" ROOT="$ROOT" node - <<'NODE'
const fs = require('fs');
const path = require('path');
try {
  const file = path.join(process.env.ROOT, 'state', 'pipeline-markers', process.env.RUN_DATE, 'daily-operating-refresh.json');
  const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  process.exit(marker?.ok === true
    && marker?.stage === 'daily-operating-refresh'
    && marker?.status === 'warning'
    && marker?.runDate === process.env.RUN_DATE
    && marker?.businessDate === process.env.DATA_DATE ? 0 : 1);
} catch { process.exit(1); }
NODE
  then
    return 1
  fi
  node "$ROOT/scripts/pipeline_marker.mjs" require \
    --stage daily-operating-refresh \
    --date "$RUN_DATE" \
    --status warning \
    --require-evidence >/dev/null
}

resolve_inventory_artifacts() {
  local entry
  entry="$(node "$ROOT/scripts/inventory/daily_inventory_version_publisher.mjs" read "$INVENTORY_RUNTIME_ROOT" "$RUN_DATE" "" "morning:$RUN_DATE")" || return 1
  if [[ "$entry" != "null" ]]; then
    INVENTORY_PLAN="$(jq -r '.planFile' <<<"$entry")"
    INVENTORY_RESULT="$(jq -r '.file' <<<"$entry")"
    INVENTORY_MARKER="$(jq -r '.markerFile' <<<"$entry")"
  elif [[ ! -f "$INVENTORY_RUNTIME_ROOT/results/daily-inventory-replenishment-$RUN_DATE.index.json" ]]; then
    INVENTORY_PLAN="$INVENTORY_RUNTIME_ROOT/plans/daily-inventory-replenishment-$RUN_DATE.json"
    INVENTORY_RESULT="$INVENTORY_RUNTIME_ROOT/results/daily-inventory-replenishment-$RUN_DATE.json"
    INVENTORY_MARKER="$ROOT/state/pipeline-markers/$RUN_DATE/daily-inventory-guard.json"
  else
    return 1
  fi
}

inventory_marker_done() {
  resolve_inventory_artifacts || return 1
  if ! RUN_DATE="$RUN_DATE" DATA_DATE="$DATA_DATE" INVENTORY_MARKER_FILE="$INVENTORY_MARKER" node - <<'NODE'
const fs = require('fs');
const path = require('path');
try {
  const file = process.env.INVENTORY_MARKER_FILE;
  const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  process.exit(marker?.ok === true
    && marker?.stage === 'daily-inventory-guard'
    && marker?.status === 'done'
    && marker?.runDate === process.env.RUN_DATE
    && marker?.businessDate === process.env.DATA_DATE ? 0 : 1);
} catch { process.exit(1); }
NODE
  then
    return 1
  fi
  node "$ROOT/scripts/pipeline_marker.mjs" require \
    --stage daily-inventory-guard \
    --root "$(dirname "$(dirname "$INVENTORY_MARKER")")" \
    --date "$RUN_DATE" \
    --status done \
    --require-evidence >/dev/null
}

inventory_marker_warning() {
  resolve_inventory_artifacts || return 1
  if ! RUN_DATE="$RUN_DATE" DATA_DATE="$DATA_DATE" INVENTORY_MARKER_FILE="$INVENTORY_MARKER" node - <<'NODE'
const fs = require('fs');
const path = require('path');
try {
  const file = process.env.INVENTORY_MARKER_FILE;
  const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  process.exit(marker?.ok === true
    && marker?.stage === 'daily-inventory-guard'
    && marker?.status === 'warning'
    && marker?.runDate === process.env.RUN_DATE
    && marker?.businessDate === process.env.DATA_DATE ? 0 : 1);
} catch { process.exit(1); }
NODE
  then
    return 1
  fi
  node "$ROOT/scripts/pipeline_marker.mjs" require \
    --stage daily-inventory-guard \
    --root "$(dirname "$(dirname "$INVENTORY_MARKER")")" \
    --date "$RUN_DATE" \
    --status warning \
    --require-evidence >/dev/null
}

latest_state_status() {
  STATE_DIR="$STATE_DIR" node - <<'NODE' 2>/dev/null || true
const fs = require('fs');
const path = require('path');
try {
  const payload = JSON.parse(fs.readFileSync(path.join(process.env.STATE_DIR, 'latest.json'), 'utf8'));
  process.stdout.write(String(payload?.status || ''));
} catch {}
NODE
}

active_full_managed_priority_services() {
  local service active=()
  command -v systemctl >/dev/null 2>&1 || return 0
  for service in $FULL_MANAGED_PRIORITY_SERVICES; do
    if systemctl is-active --quiet "$service"; then
      active+=("$service")
    fi
  done
  printf '%s' "${active[*]:-}"
}

session_recovery_deadline_epoch() {
  local now budget_deadline reserve_deadline
  now="$(date +%s)"
  budget_deadline=$((now + SESSION_RECOVERY_BUDGET_SEC))
  reserve_deadline=$((RUN_DEADLINE_EPOCH - LINK_COLLECTION_RESERVE_SEC))
  if (( budget_deadline < reserve_deadline )); then
    printf '%s\n' "$budget_deadline"
  else
    printf '%s\n' "$reserve_deadline"
  fi
}

run_nightly_session_readiness_gate() {
  local recovery_deadline recovery_status now
  # Strong evidence gate: only an ok=true done marker with matching
  # stage/runDate/businessDate AND a same-day ok=true report covering every
  # enabled store counts as completed.  The session helper owns this predicate
  # (--check-only) so the morning chain never re-implements a weaker
  # marker-only judgement, and a warning marker without evidence must trigger
  # recovery instead of a skip.
  if bash scripts/run_cloud_session_manager_job.sh \
    --check-only \
    --root "$ROOT" \
    --marker-stage nightly-session \
    --marker-root "$ROOT/state/pipeline-markers" \
    --run-date "$RUN_DATE"; then
    echo "[cloud_morning_chain] session-ready strong evidence (done marker + same-day 19/19 report) runDate=$RUN_DATE; no session-manager work started"
    return 0
  fi

  recovery_deadline="$(session_recovery_deadline_epoch)"
  now="$(date +%s)"
  if (( recovery_deadline <= now )); then
    write_state "failed" "nightly session recovery cannot start without consuming the reserved ${LINK_COLLECTION_RESERVE_SEC}s link-collection budget; link collection was not started; manual login or scheduled session manager run required"
    write_marker "morning-all" "failed" "nightly-session recovery had no safe budget before link collection" "$LOG_FILE" >/dev/null || true
    echo "[cloud_morning_chain] ERROR session recovery has no safe budget runDeadline=$RUN_DEADLINE_EPOCH linkReserveSec=$LINK_COLLECTION_RESERVE_SEC" >&2
    return 79
  fi

  write_state "running" "nightly-session completion evidence is missing; one bounded in-run session recovery is running before link collection"
  echo "[cloud_morning_chain] session-recovery needed deadlineEpoch=$recovery_deadline runDeadline=$RUN_DEADLINE_EPOCH budgetSec=$SESSION_RECOVERY_BUDGET_SEC linkReserveSec=$LINK_COLLECTION_RESERVE_SEC"
  if bash scripts/run_cloud_session_manager_job.sh \
    --root "$ROOT" \
    --domain session-manager \
    --lock-wait-sec "${SHEIN_BI_MORNING_SESSION_LOCK_WAIT_SEC:-120}" \
    --deadline-epoch "$recovery_deadline" \
    --defer-state "${SHEIN_BI_MORNING_SESSION_DEFER_STATE:-/srv/shein-bi/runtime/host-scheduler/session-manager.latest.json}" \
    --marker-stage nightly-session \
    --marker-root "$ROOT/state/pipeline-markers" \
    --alert-file "${SHEIN_BI_MORNING_SESSION_ALERT_FILE:-$ROOT/state/cloud_ops_alerts/session-manager-last.json}" \
    --run-date "$RUN_DATE" \
    -- /usr/bin/env bash "$ROOT/scripts/run_pipeline_stage.sh" \
      --stage nightly-session \
      --message "19-store session maintenance completed" \
      -- /usr/bin/flock -w "${SHEIN_BI_MORNING_SESSION_INNER_LOCK_WAIT_SEC:-120}" \
        "${SHEIN_BI_NIGHTLY_MAINTENANCE_LOCK_FILE:-$ROOT/state/locks/shein-bi-nightly-maintenance.lock}" \
        /usr/bin/env bash "$ROOT/scripts/cloud_shein_session_manager.sh"; then
    recovery_status=0
  else
    recovery_status=$?
  fi

  if [[ "$recovery_status" != "0" ]]; then
    write_state "failed" "nightly session recovery failed status=$recovery_status; manual login or scheduled session manager run required before link collection; all-store fetch skipped"
    write_marker "morning-all" "failed" "nightly-session recovery failed status=$recovery_status before link collection" "$LOG_FILE" >/dev/null || true
    echo "[cloud_morning_chain] ERROR session recovery failed status=$recovery_status; all-store fetch skipped" >&2
    return 79
  fi

  # Re-verify through the same strong helper; never trust the recovery exit
  # code or an intermediate marker alone.
  if bash scripts/run_cloud_session_manager_job.sh \
    --check-only \
    --root "$ROOT" \
    --marker-stage nightly-session \
    --marker-root "$ROOT/state/pipeline-markers" \
    --run-date "$RUN_DATE"; then
    write_state "running" "nightly session recovery evidence verified; all-store link collection is starting"
    echo "[cloud_morning_chain] session-recovery evidence verified (done marker + same-day 19/19 report); continuing to all-store fetch"
    return 0
  fi

  write_state "failed" "nightly session recovery exited 0 but completion evidence (done marker + same-day 19/19 report) is missing; manual login or scheduled session manager run required before link collection; all-store fetch skipped"
  write_marker "morning-all" "failed" "nightly-session recovery evidence missing after exit 0" "$LOG_FILE" >/dev/null || true
  echo "[cloud_morning_chain] ERROR session recovery evidence missing after exit 0; all-store fetch skipped" >&2
  return 79
}

# Idempotent terminal-state convergence.  Only a non-terminal latest state
# (missing / running / waiting / waiting_resource) is replaced with failed so
# the successful paths that already wrote ok are never overwritten by the EXIT
# trap, and repeated TERM/INT/EXIT invocations converge to the same single
# failed state plus a failed pipeline marker.
converge_terminal_state() {
  local reason="$1"
  [[ "${TERMINAL_STATE_WRITTEN:-0}" == "1" ]] && return 0
  TERMINAL_STATE_WRITTEN=1
  set +e
  local current_status
  current_status="$(latest_state_status)"
  case "$current_status" in
    ""|running|waiting|waiting_resource)
      write_state "failed" "$reason"
      write_marker "morning-$STAGE" "failed" "$reason" "$LOG_FILE" >/dev/null 2>&1 || true
      ;;
  esac
}

on_termination() {
  local signal_name="$1"
  local exit_code="$2"
  converge_terminal_state "cloud_morning_chain received SIG$signal_name before a terminal state was recorded; the owning service Restart resumes the same active run context (runDate=$RUN_DATE businessDate=$DATA_DATE)"
  exit "$exit_code"
}

wait_for_catchup_startup_window() {
  local now_seconds scheduled_seconds uptime_seconds wait_seconds active
  now_seconds=$((10#$(TZ="$TZ_NAME" date +%H) * 3600 + 10#$(TZ="$TZ_NAME" date +%M) * 60 + 10#$(TZ="$TZ_NAME" date +%S)))
  scheduled_seconds=$((7 * 3600 + 10 * 60))
  if (( now_seconds <= scheduled_seconds + 60 )); then
    return 0
  fi

  uptime_seconds="$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)"
  if (( uptime_seconds < CATCHUP_MIN_UPTIME_SEC )); then
    wait_seconds=$((CATCHUP_MIN_UPTIME_SEC - uptime_seconds))
    write_state "waiting_resource" "same-day boot catch-up is waiting ${wait_seconds}s for the host to become stable; no heavy resource is held"
    echo "[cloud_morning_chain] catch-up startup stability wait=${wait_seconds}s uptime=${uptime_seconds}s"
    sleep "$wait_seconds"
  fi

  while true; do
    require_pre_inventory_budget "catch-up-priority-window"
    active="$(active_full_managed_priority_services)"
    [[ -z "$active" ]] && break
    write_state "waiting_resource" "same-day boot catch-up is yielding to the full-managed priority run: $active"
    echo "[cloud_morning_chain] catch-up waits for priority services: $active"
    sleep "$CATCHUP_RETRY_DELAY_SEC"
  done
}

on_error() {
  local line="$1"
  local status="$2"
  set +e
  write_state "failed" "stage=$STAGE aborted at line=$line exit=$status"
  write_marker "morning-$STAGE" "failed" "aborted at line=$line exit=$status" "$LOG_FILE" >/dev/null || true
  echo "[cloud_morning_chain] ERROR stage=$STAGE line=$line exit=$status log=$LOG_FILE" >&2
  exit "$status"
}

run_all_store_fetch() {
  local result_file="$1"
  SHEIN_LINK_BUSINESS_STORES="$(store_keys_all_csv)" \
  SHEIN_LINK_BUSINESS_FETCH_ONLY=1 \
  SHEIN_LINK_BUSINESS_ALLOW_PARTIAL=1 \
  SHEIN_LINK_BUSINESS_CHUNK_RESULT_FILE="$result_file" \
  SHEIN_LINK_BUSINESS_STORE_ATTEMPTS="${SHEIN_LINK_BUSINESS_STORE_ATTEMPTS:-2}" \
  SHEIN_LINK_BUSINESS_PER_STORE_BROWSER_WRAPPER=1 \
  SHEIN_LINK_BUSINESS_REFRESH_PORTAL=0 \
    bash scripts/cloud_link_business_sync.sh "$DATA_DATE"
}

store_keys_all_csv() {
  node - <<'NODE'
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('config/stores.json', 'utf8'));
process.stdout.write((config.stores || [])
  .filter(store => store.enabled !== false)
  .map(store => String(store.storeKey || '').trim().toUpperCase())
  .filter(Boolean)
  .join(','));
NODE
}

missing_exact_date_stores() {
  DATA_DATE="$DATA_DATE" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const date = process.env.DATA_DATE;
const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8'));
const missing = [];
for (const row of config.stores || []) {
  if (row.enabled === false) continue;
  const store = String(row.storeKey || '').trim().toUpperCase();
  let complete = Boolean(store);
  for (const domain of ['shein_links', 'shein_business_domains']) {
    const file = path.join(root, 'outputs', domain, store, `${date}.json`);
    try {
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      const payloadStore = String(payload?.store?.storeKey || '').trim().toUpperCase();
      if (payload?.ok !== true || String(payload?.date || '') !== date || payloadStore !== store) complete = false;
    } catch {
      complete = false;
    }
  }
  if (!complete) missing.push(store);
}
process.stdout.write(missing.join(','));
NODE
}

run_supplements_stage() {
  write_state "running" "all-store evidence is complete; warehouse merge, supplements and one atomic Portal publish are running"
  local status
  set +e
  local remaining=$((PRE_INVENTORY_DEADLINE_EPOCH - $(date +%s)))
  if (( remaining <= 0 )); then return 76; fi
  # The inventory coordinator enters the reserved inventory window as soon as
  # the 19-store merge and the inventory-critical linksData section are
  # complete.  Homepage-critical Portal sections (homeRankings..homeProfit)
  # are NOT on this critical path: cloud_daily_refresh enqueues them for the
  # bounded host-locked queue worker instead of a synchronous prewarm that can
  # take many minutes per section and exhaust the inventory window.  linksData
  # stays synchronous and the inventory guard keeps its own fail-closed
  # linksData/inventoryTrend gates, so a linksData failure is never treated as
  # success by this coordinator.
  SHEIN_BI_DAILY_LINK_BUSINESS_MODE=finalize \
  SHEIN_BI_DAILY_REQUIRE_COMPLETE_LINK_BUSINESS=1 \
  SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS=0 \
  SHEIN_BI_DAILY_CRITICAL_PORTAL_PREWARM=queue \
  SHEIN_BI_DAILY_METRIC_REFETCH_ON_NOT_READY="${SHEIN_BI_MORNING_METRIC_REFETCH_ON_NOT_READY:-1}" \
  SHEIN_BI_DAILY_REFRESH_DEADLINE_EPOCH="$PRE_INVENTORY_DEADLINE_EPOCH" \
  SHEIN_BI_DAILY_REFRESH_RUN_KEY="${RUN_DATE}:${DATA_DATE}" \
  SHEIN_BI_DAILY_METRIC_REFETCH_BROWSER_WRAPPER=1 \
  SHEIN_BI_DAILY_RTV_VERIFY=0 \
  SHEIN_BI_PORTAL_PREWARM_DISABLED=0 \
    timeout --signal=TERM --kill-after=30s "${remaining}s" bash scripts/cloud_daily_refresh.sh "$DATA_DATE"
  status=$?
  set -e
  if [[ "$status" -eq 124 || "$status" -eq 137 || "$status" -eq 143 ]]; then
    echo "[cloud_morning_chain] supplements crossed the inventory reserve boundary" >&2
    return 76
  fi
  if [[ "$status" -ne 0 ]]; then
    return "$status"
  fi
  write_marker "morning-links-ready" "done" "all 19 stores merged and published in the unified daily run" \
    "$STATE_DIR/${RUN_DATE}-all.json" >/dev/null
  write_marker "morning-supplements" "done" "daily supplements completed inside the unified run" \
    "$LOG_FILE" >/dev/null
}

run_inventory_stage() {
  if [[ "${SHEIN_BI_INVENTORY_FORCE_RECHECK:-0}" != "1" ]] && inventory_marker_warning; then
    echo "[cloud_morning_chain] verified inventory guard warning marker already exists runDate=$RUN_DATE; bypassing inventory execution" >&2
    return 102
  fi
  write_state "running" "refreshing current OpenAPI stock and running the one daily inventory guard"
  # OpenAPI stock is an api-light phase.  It must not reserve the exclusive
  # browser/DB lane for the whole 19-store request.
  local stock_remaining stock_budget
  stock_remaining=$((RUN_DEADLINE_EPOCH - $(date +%s)))
  if (( stock_remaining <= 0 )); then return 76; fi
  stock_budget="$STOCK_REFRESH_MAX_SEC"
  if (( stock_budget > stock_remaining )); then stock_budget="$stock_remaining"; fi
  set +e
  SHEIN_OPENAPI_STOCK_REFRESH_RUN_DATE="$RUN_DATE" \
  SHEIN_BI_MORNING_RUN_DATE="$RUN_DATE" \
    timeout --signal=TERM --kill-after=30s "${stock_budget}s" bash scripts/cloud_openapi_stock_refresh.sh
  local stock_status=$?
  set -e
  if [[ "$stock_status" -eq 124 || "$stock_status" -eq 137 || "$stock_status" -eq 143 ]]; then
    echo "[cloud_morning_chain] stock refresh exhausted its bounded inventory-reserve slice" >&2
    return 76
  fi
  if [[ "$stock_status" -ne 0 ]]; then return "$stock_status"; fi

  local inventory_status retry_delay
  retry_delay="${SHEIN_BI_MORNING_RESOURCE_RETRY_DELAY_SEC:-60}"
  while true; do
    require_run_budget "daily inventory guard"
    # Keep the command in an if-condition so the inherited ERR trap does not
    # turn the scheduler's temporary 75 into a failed business run.
    if SHEIN_BI_INVENTORY_REQUIRE_PIPELINE_MARKERS=1 \
      SHEIN_BI_INVENTORY_RUN_DATE="$RUN_DATE" \
      SHEIN_BI_INVENTORY_BUSINESS_DATE="$DATA_DATE" \
      SHEIN_BI_INVENTORY_RUN_DEADLINE_EPOCH="$RUN_DEADLINE_EPOCH" \
      SHEIN_BI_INVENTORY_STOCK_NOT_BEFORE="${RUN_DATE}T00:00:00+08:00" \
      SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT=cloud_daily_inventory_replenishment_guard \
      SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION=owner-automatic-inventory-20260803-v1 \
        bash scripts/run_host_heavy_job.sh \
          --domain daily-operating-inventory \
          --class openapi \
          --lock-wait-sec 900 \
          --deadline-epoch "$RUN_DEADLINE_EPOCH" \
          --defer-state /srv/shein-bi/runtime/host-scheduler/daily-operating-inventory.latest.json \
          -- bash scripts/cloud_daily_inventory_replenishment_guard.sh; then
      inventory_status=0
    else
      inventory_status=$?
    fi

    if [[ "$inventory_status" == "0" ]]; then
      if inventory_marker_done; then
        return 0
      fi
      echo "[cloud_morning_chain] ERROR inventory guard exited 0 without verified date-scoped plan/result evidence" >&2
      return 76
    fi
    if [[ "$inventory_status" == "2" ]]; then
      if inventory_marker_warning; then
        echo "[cloud_morning_chain] inventory guard completed with item-level business blockers; verified plan/result evidence recorded with warning" >&2
        return 102
      fi
      echo "[cloud_morning_chain] ERROR inventory guard exited 2 without verified date-scoped plan/result warning evidence" >&2
      return 76
    fi
    if [[ "$inventory_status" == "75" ]]; then
      write_state "waiting_resource" "daily inventory guard is waiting for host capacity inside the same run; completed daily data remains published"
      echo "[cloud_morning_chain] daily inventory guard waiting for capacity; retrying same run in ${retry_delay}s"
      sleep "$retry_delay"
      continue
    fi
    return "$inventory_status"
  done
}

if [[ "$DRY_RUN" == "1" || "$DRY_RUN" == "true" ]]; then
  echo "[cloud_morning_chain] start stage=$STAGE runDate=$RUN_DATE businessDate=$DATA_DATE dryRun=$DRY_RUN"
  case "$STAGE" in
    all) echo "[cloud_morning_chain] dry-run: one coordinator fetches all 19 stores, publishes once, then runs supplements and inventory" ;;
    inventory|replenishment) echo "[cloud_morning_chain] dry-run: inventory stage only" ;;
    *) exit 64 ;;
  esac
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  write_state "ok" "dry-run stage validated"
  exit 0
fi

mkdir -p "$LOG_DIR" "$STATE_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'on_error "$LINENO" "$?"' ERR
trap 'on_termination TERM 143' TERM
trap 'on_termination INT 130' INT
trap 'converge_terminal_state "cloud_morning_chain exited without a terminal non-running state; success and failure paths already recorded their own states"' EXIT
cd "$ROOT"
export SHEIN_BI_ROOT="$ROOT"
export SHEIN_BI_MORNING_CHAIN_STATE_DIR="$STATE_DIR"
# The absolute run deadline propagates to every per-store browser wrapper so a
# single store / the whole round can never run past the internal budget.
export SHEIN_HOST_BROWSER_READ_DEADLINE_EPOCH="$PRE_INVENTORY_DEADLINE_EPOCH"

echo "[cloud_morning_chain] start stage=$STAGE runDate=$RUN_DATE businessDate=$DATA_DATE dryRun=$DRY_RUN"

case "$STAGE" in
  inventory|replenishment)
    echo "[cloud_morning_chain] running standalone inventory replenishment stage runDate=$RUN_DATE"
    if run_inventory_stage; then
      echo "[cloud_morning_chain] standalone inventory stage completed successfully"
      exit 0
    else
      local_status=$?
      echo "[cloud_morning_chain] standalone inventory stage finished with status=$local_status"
      exit "$local_status"
    fi
    ;;
  all)
    if daily_operating_refresh_done; then
      write_state "ok" "today's complete daily operating run is already published; no duplicate work was started"
      echo "[cloud_morning_chain] resume-skip complete daily-operating-refresh marker"
      exit 0
    fi
    if daily_operating_refresh_warning; then
      write_state "warning" "today's daily operating run is already completed with warning; no duplicate work was started"
      echo "[cloud_morning_chain] resume-skip warning daily-operating-refresh marker"
      exit 0
    fi
    if inventory_marker_warning; then
      echo "[cloud_morning_chain] verified inventory warning already completed; bypassing expired catch-up startup window" >&2
    elif pipeline_marker_done "inventory-started" \
      && node "$ROOT/scripts/pipeline_marker.mjs" require \
        --stage inventory-started --date "$RUN_DATE" --status done --require-evidence >/dev/null; then
      require_run_budget "inventory-resume"
      echo "[cloud_morning_chain] verified inventory already started; resuming within the original absolute deadline" >&2
    else
      wait_for_catchup_startup_window
    fi
    write_state "running" "one daily coordinator is refreshing all 19 stores; the previous complete BI snapshot stays visible until the run is complete"
    RESULT_FILE="$STATE_DIR/${RUN_DATE}-all.json"
    MISSING_STORES="$(missing_exact_date_stores)"
    if [[ -z "$MISSING_STORES" ]]; then
      echo "[cloud_morning_chain] resume-skip all-store fetch; exact-date evidence already exists for all enabled stores"
      node scripts/build_morning_resume_evidence.mjs --date "$DATA_DATE" --out "$RESULT_FILE"
    else
      require_pre_inventory_budget "all-store-fetch"
      if run_nightly_session_readiness_gate; then
        :
      else
        SESSION_GATE_STATUS=$?
        exit "$SESSION_GATE_STATUS"
      fi
      run_all_store_fetch "$RESULT_FILE"
      MISSING_STORES="$(missing_exact_date_stores)"
      RETRY_ROUND=0
      NO_PROGRESS_ROUNDS=0
      while [[ -n "$MISSING_STORES" ]]; do
        require_pre_inventory_budget "store-retry"
        PREV_MISSING_STORES="$MISSING_STORES"
        RETRY_ROUND=$((RETRY_ROUND + 1))
        echo "[cloud_morning_chain] retryRound=$RETRY_ROUND missingStores=$MISSING_STORES; retrying only those stores inside the same run"
        if (( RETRY_ROUND > 1 )); then
          sleep "${SHEIN_BI_MORNING_STORE_RETRY_DELAY_SEC:-120}"
        fi
        SHEIN_LINK_BUSINESS_STORES="$MISSING_STORES" \
        SHEIN_LINK_BUSINESS_FETCH_ONLY=1 \
        SHEIN_LINK_BUSINESS_ALLOW_PARTIAL=1 \
        SHEIN_LINK_BUSINESS_CHUNK_RESULT_FILE="$STATE_DIR/${RUN_DATE}-retry-${RETRY_ROUND}.json" \
        SHEIN_LINK_BUSINESS_STORE_ATTEMPTS=1 \
        SHEIN_LINK_BUSINESS_PER_STORE_BROWSER_WRAPPER=1 \
        SHEIN_LINK_BUSINESS_REFRESH_PORTAL=0 \
          bash scripts/cloud_link_business_sync.sh "$DATA_DATE"
        MISSING_STORES="$(missing_exact_date_stores)"
        if [[ "$PREV_MISSING_STORES" == "$MISSING_STORES" ]]; then
          NO_PROGRESS_ROUNDS=$((NO_PROGRESS_ROUNDS + 1))
        else
          NO_PROGRESS_ROUNDS=0
        fi
        if (( NO_PROGRESS_ROUNDS >= MAX_STORE_NO_PROGRESS_ROUNDS )); then
          write_state "failed" "store fetch made no progress in ${NO_PROGRESS_ROUNDS} consecutive retry rounds (bound=${MAX_STORE_NO_PROGRESS_ROUNDS}); missing=$MISSING_STORES; the previous complete BI snapshot remains active"
          write_marker "morning-all" "failed" "no-progress store retry bound reached after ${NO_PROGRESS_ROUNDS} rounds: $MISSING_STORES" "$LOG_FILE" >/dev/null || true
          exit 78
        fi
      done
    fi

    # Normalize the initial fetch and every retry into one immutable 19-store
    # bundle.  A chunk result can retain stores that succeeded in a later
    # retry, so chunk status is never accepted as final completion evidence.
    node scripts/build_morning_resume_evidence.mjs --date "$DATA_DATE" --out "$RESULT_FILE"

    if pipeline_marker_done "morning-supplements"; then
      # RESULT_FILE was rebuilt above from the exact-date store evidence.  A
      # restart may therefore invalidate the previous links-ready evidence
      # hash even though supplements/Portal are already complete.  Re-sign
      # only this marker with the current bundle before entering inventory;
      # the exact-store gate above still forbids incomplete data here.
      write_marker "morning-links-ready" "done" "all 19 stores merged and published in the unified daily run" \
        "$RESULT_FILE" >/dev/null
      echo "[cloud_morning_chain] resume-skip completed supplements/Portal checkpoint; continuing with inventory in the same logical daily run"
    else
      SUPPLEMENT_RETRY_ROUND=0
      while true; do
        require_pre_inventory_budget "platform-readiness-and-publish"
        if run_supplements_stage; then
          break
        else
          SUPPLEMENT_STATUS=$?
        fi
        if [[ "$SUPPLEMENT_STATUS" -ne 75 ]]; then
          write_state "failed" "daily supplements failed status=$SUPPLEMENT_STATUS; the previous complete BI snapshot remains active"
          write_marker "morning-all" "failed" "daily supplements failed status=$SUPPLEMENT_STATUS" "$LOG_FILE" >/dev/null || true
          exit "$SUPPLEMENT_STATUS"
        fi
        SUPPLEMENT_RETRY_ROUND=$((SUPPLEMENT_RETRY_ROUND + 1))
        write_state "waiting" "all 19 stores are collected but the platform daily metrics are not ready; the same run will retry without publishing partial data"
        echo "[cloud_morning_chain] waiting platform readiness retryRound=$SUPPLEMENT_RETRY_ROUND"
        sleep "${SHEIN_BI_MORNING_PLATFORM_RETRY_DELAY_SEC:-300}"
      done
    fi
    if pipeline_marker_done "inventory-started"; then
      echo "[cloud_morning_chain] resume inventory stage inside the original run deadline"
    else
      require_pre_inventory_budget "inventory-stage-dispatch"
      write_marker "inventory-started" "done" "inventory reserve entered; restarts may resume this stage until the absolute run deadline" "$RESULT_FILE" >/dev/null
    fi
    if run_inventory_stage; then
      INVENTORY_STAGE_STATUS=0
    else
      INVENTORY_STAGE_STATUS=$?
    fi
    if [[ "$INVENTORY_STAGE_STATUS" -ne 0 && "$INVENTORY_STAGE_STATUS" -ne 102 ]]; then
      exit "$INVENTORY_STAGE_STATUS"
    fi
    resolve_inventory_artifacts
    if [[ "$INVENTORY_STAGE_STATUS" -eq 102 ]]; then
      write_marker "daily-operating-refresh" "warning" "all 19 stores and supplements completed; inventory completed with item-level business blockers" \
        "$RESULT_FILE" "$INVENTORY_MARKER" \
        "$INVENTORY_PLAN" "$INVENTORY_RESULT" >/dev/null
      printf 'completed_at=%s\nbusiness_date=%s\nlog=%s\n' "$(now_iso)" "$DATA_DATE" "$LOG_FILE" \
        > "$STATE_DIR/${RUN_DATE}.done"
      write_state "warning" "all 19 stores and supplements completed; inventory completed with item-level business blockers"
    else
      write_marker "daily-operating-refresh" "done" "all 19 stores, supplements and inventory completed in one run" \
        "$RESULT_FILE" "$INVENTORY_MARKER" \
        "$INVENTORY_PLAN" "$INVENTORY_RESULT" >/dev/null
      printf 'completed_at=%s\nbusiness_date=%s\nlog=%s\n' "$(now_iso)" "$DATA_DATE" "$LOG_FILE" \
        > "$STATE_DIR/${RUN_DATE}.done"
      write_state "ok" "all 19 stores, supplements and inventory completed; the complete daily snapshot was published once"
    fi
    ;;
  *)
    echo "Unsupported morning stage: $STAGE" >&2
    exit 64
    ;;
esac

echo "[cloud_morning_chain] done stage=$STAGE log=$LOG_FILE"
