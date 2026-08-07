#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
STAGE="${1:-all}"
LOG_DIR="${SHEIN_BI_MORNING_CHAIN_LOG_DIR:-/srv/shein-bi/logs/cloud-morning-chain}"
STATE_DIR="${SHEIN_BI_MORNING_CHAIN_STATE_DIR:-$ROOT/state/cloud_morning_chain}"
RUN_DATE="$(TZ="$TZ_NAME" date +%F)"
DATA_DATE="$(TZ="$TZ_NAME" date -d yesterday +%F)"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/morning-${STAGE}-${DATA_DATE}-${STAMP}.log"
DRY_RUN="${SHEIN_BI_MORNING_CHAIN_DRY_RUN:-0}"
RUN_STARTED_EPOCH="$(date +%s)"
RUN_BUDGET_SEC="${SHEIN_BI_MORNING_RUN_BUDGET_SEC:-10200}"
RUN_DEADLINE_EPOCH=$((RUN_STARTED_EPOCH + RUN_BUDGET_SEC))

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
    echo "[cloud_morning_chain] ERROR safety budget exhausted phase=$phase" >&2
    exit 75
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
  SHEIN_BI_DAILY_LINK_BUSINESS_MODE=finalize \
  SHEIN_BI_DAILY_REQUIRE_COMPLETE_LINK_BUSINESS=1 \
  SHEIN_BI_DAILY_RTV_VERIFY=0 \
  SHEIN_BI_PORTAL_PREWARM_DISABLED=0 \
    bash scripts/cloud_daily_refresh.sh "$DATA_DATE"
  status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    return "$status"
  fi
  write_marker "morning-links-ready" "done" "all 19 stores merged and published in the unified daily run" \
    "$STATE_DIR/${RUN_DATE}-all.json" "$LOG_FILE" >/dev/null
  write_marker "morning-supplements" "done" "daily supplements completed inside the unified run" \
    "$LOG_FILE" >/dev/null
}

run_inventory_stage() {
  write_state "running" "refreshing current OpenAPI stock and running the one daily inventory guard"
  # OpenAPI stock is an api-light phase.  It must not reserve the exclusive
  # browser/DB lane for the whole 19-store request.
  bash scripts/cloud_openapi_stock_refresh.sh

  local inventory_status retry_delay
  retry_delay="${SHEIN_BI_MORNING_RESOURCE_RETRY_DELAY_SEC:-60}"
  while true; do
    require_run_budget "daily inventory guard"
    # Keep the command in an if-condition so the inherited ERR trap does not
    # turn the scheduler's temporary 75 into a failed business run.
    if SHEIN_BI_INVENTORY_REQUIRE_PIPELINE_MARKERS=1 \
      SHEIN_BI_INVENTORY_STOCK_NOT_BEFORE="${RUN_DATE}T00:00:00+08:00" \
      SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT=cloud_daily_inventory_replenishment_guard \
      SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION=owner-automatic-inventory-20260803-v1 \
        bash scripts/run_host_heavy_job.sh \
          --domain daily-operating-inventory \
          --class openapi \
          --lock-wait-sec 900 \
          --defer-state /srv/shein-bi/runtime/host-scheduler/daily-operating-inventory.latest.json \
          -- bash scripts/cloud_daily_inventory_replenishment_guard.sh; then
      inventory_status=0
    else
      inventory_status=$?
    fi

    if [[ "$inventory_status" == "0" ]]; then
      write_marker "daily-inventory-guard" "done" "daily inventory guard completed inside the unified run" "$LOG_FILE" >/dev/null
      return 0
    fi
    if [[ "$inventory_status" == "2" ]]; then
      write_marker "daily-inventory-guard" "warning" "daily inventory guard completed with business blockers; no unsafe write was presented" "$LOG_FILE" >/dev/null
      return 0
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

mkdir -p "$LOG_DIR" "$STATE_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1
trap 'on_error "$LINENO" "$?"' ERR
cd "$ROOT"
export SHEIN_BI_ROOT="$ROOT"
export SHEIN_BI_MORNING_CHAIN_STATE_DIR="$STATE_DIR"

echo "[cloud_morning_chain] start stage=$STAGE runDate=$RUN_DATE businessDate=$DATA_DATE dryRun=$DRY_RUN"

if [[ "$DRY_RUN" == "1" || "$DRY_RUN" == "true" ]]; then
  case "$STAGE" in
    all) echo "[cloud_morning_chain] dry-run: one coordinator fetches all 19 stores, publishes once, then runs supplements and inventory" ;;
    *) exit 64 ;;
  esac
  write_state "ok" "dry-run stage validated"
  exit 0
fi

case "$STAGE" in
  all)
    if pipeline_marker_done "daily-operating-refresh"; then
      write_state "ok" "today's complete daily operating run is already published; no duplicate work was started"
      echo "[cloud_morning_chain] resume-skip complete daily-operating-refresh marker"
      exit 0
    fi
    write_state "running" "one daily coordinator is refreshing all 19 stores; the previous complete BI snapshot stays visible until the run is complete"
    RESULT_FILE="$STATE_DIR/${RUN_DATE}-all.json"
    run_all_store_fetch "$RESULT_FILE"
    MISSING_STORES="$(missing_exact_date_stores)"
    RETRY_ROUND=0
    while [[ -n "$MISSING_STORES" ]]; do
      require_run_budget "store-retry"
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
    done

    if pipeline_marker_done "morning-supplements"; then
      echo "[cloud_morning_chain] resume-skip completed supplements/Portal checkpoint; continuing with inventory in the same logical daily run"
    else
      SUPPLEMENT_RETRY_ROUND=0
      while true; do
        require_run_budget "platform-readiness-and-publish"
        if run_supplements_stage; then
          break
        else
          SUPPLEMENT_STATUS=$?
        fi
        if [[ "$SUPPLEMENT_STATUS" -ne 75 ]]; then
          exit "$SUPPLEMENT_STATUS"
        fi
        SUPPLEMENT_RETRY_ROUND=$((SUPPLEMENT_RETRY_ROUND + 1))
        write_state "waiting" "all 19 stores are collected but the platform daily metrics are not ready; the same run will retry without publishing partial data"
        echo "[cloud_morning_chain] waiting platform readiness retryRound=$SUPPLEMENT_RETRY_ROUND"
        sleep "${SHEIN_BI_MORNING_PLATFORM_RETRY_DELAY_SEC:-300}"
      done
    fi
    run_inventory_stage
    write_marker "daily-operating-refresh" "done" "all 19 stores, supplements and inventory completed in one run" \
      "$RESULT_FILE" "$LOG_FILE" >/dev/null
    printf 'completed_at=%s\nbusiness_date=%s\nlog=%s\n' "$(now_iso)" "$DATA_DATE" "$LOG_FILE" \
      > "$STATE_DIR/${RUN_DATE}.done"
    write_state "ok" "all 19 stores, supplements and inventory completed; the complete daily snapshot was published once"
    ;;
  *)
    echo "Unsupported morning stage: $STAGE" >&2
    exit 64
    ;;
esac

echo "[cloud_morning_chain] done stage=$STAGE log=$LOG_FILE"
