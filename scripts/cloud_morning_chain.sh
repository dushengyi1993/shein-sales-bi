#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
STAGE="${1:-chunk-1}"
LOG_DIR="${SHEIN_BI_MORNING_CHAIN_LOG_DIR:-/srv/shein-bi/logs/cloud-morning-chain}"
STATE_DIR="${SHEIN_BI_MORNING_CHAIN_STATE_DIR:-$ROOT/state/cloud_morning_chain}"
RUN_DATE="$(TZ="$TZ_NAME" date +%F)"
DATA_DATE="$(TZ="$TZ_NAME" date -d yesterday +%F)"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/morning-${STAGE}-${DATA_DATE}-${STAMP}.log"
CHUNK_1_STORES="${SHEIN_BI_MORNING_CHUNK_1_STORES:-DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ,CX,YJ}"
CHUNK_2_STORES="${SHEIN_BI_MORNING_CHUNK_2_STORES:-XL,QY,QH,TZ,JSH,TZZ,XC}"
DRY_RUN="${SHEIN_BI_MORNING_CHAIN_DRY_RUN:-0}"

now_iso() {
  TZ="$TZ_NAME" date --iso-8601=seconds
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
if (payload.status === 'ok' && payload.stage === 'supplements') {
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

require_marker() {
  node "$ROOT/scripts/pipeline_marker.mjs" require \
    --stage "$1" \
    --date "$RUN_DATE" \
    --status done,warning
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

run_fetch_chunk() {
  local stores="$1"
  local result_file="$2"
  SHEIN_LINK_BUSINESS_STORES="$stores" \
  SHEIN_LINK_BUSINESS_FETCH_ONLY=1 \
  SHEIN_LINK_BUSINESS_ALLOW_PARTIAL=1 \
  SHEIN_LINK_BUSINESS_CHUNK_RESULT_FILE="$result_file" \
  SHEIN_LINK_BUSINESS_STORE_ATTEMPTS="${SHEIN_LINK_BUSINESS_STORE_ATTEMPTS:-2}" \
  SHEIN_LINK_BUSINESS_REFRESH_PORTAL=0 \
    bash scripts/cloud_link_business_sync.sh "$DATA_DATE"
}

chunk_result_status() {
  RESULT_FILE="$1" node - <<'NODE'
const fs = require('fs');
try {
  const payload = JSON.parse(fs.readFileSync(process.env.RESULT_FILE, 'utf8'));
  process.stdout.write(String(payload.status || (payload.ok ? 'done' : 'failed')));
} catch {
  process.stdout.write('failed');
}
NODE
}

chunk_result_failed_stores() {
  RESULT_FILE="$1" node - <<'NODE'
const fs = require('fs');
try {
  const payload = JSON.parse(fs.readFileSync(process.env.RESULT_FILE, 'utf8'));
  process.stdout.write((payload.failedStores || []).map(String).filter(Boolean).join(','));
} catch {}
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

merge_store_lists() {
  FIRST="$1" SECOND="$2" node - <<'NODE'
const values = `${process.env.FIRST || ''},${process.env.SECOND || ''}`
  .split(/[\s,]+/)
  .map(value => value.trim().toUpperCase())
  .filter(Boolean);
process.stdout.write([...new Set(values)].join(','));
NODE
}

finalize_links_if_complete() {
  SHEIN_LINK_BUSINESS_FINALIZE_ONLY=1 \
  SHEIN_LINK_BUSINESS_ALLOW_PARTIAL=1 \
  SHEIN_LINK_BUSINESS_REFRESH_PORTAL=0 \
    bash scripts/cloud_link_business_sync.sh "$DATA_DATE"

  local missing_stores
  missing_stores="$(missing_exact_date_stores)"
  if [[ -n "$missing_stores" ]]; then
    write_state "warning" "link refresh is still partial; retryable stores: $missing_stores"
    write_marker "morning-links-partial" "warning" \
      "current-date evidence is incomplete; retryable stores: $missing_stores" \
      "$LOG_FILE" >/dev/null
    echo "[cloud_morning_chain] WARN exact-date link/business gaps remain stores=$missing_stores; recovery stage will resume only these stores"
    return 75
  fi

  node scripts/generate_bi_portal.mjs \
    --metabase-url "${METABASE_URL:-http://127.0.0.1:3000}" \
    --data-mode api
  node scripts/generate_bi_portal_shell.mjs
  curl -fsS --max-time "${SHEIN_BI_MORNING_LINKS_REFRESH_TIMEOUT_SEC:-600}" \
    -H 'X-SHEIN-BI-HOST-LOCKED-WORKER: 1' \
    "${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}/api/bi/section/linksData?refresh=1" \
    >/dev/null
  write_marker "morning-links-ready" "done" "all 19 stores merged and linksData refreshed" \
    "$STATE_DIR/${RUN_DATE}-chunk-1.json" "$STATE_DIR/${RUN_DATE}-chunk-2.json" "$LOG_FILE" >/dev/null
  write_state "ok" "all 19 stores merged; linksData is ready"
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
    chunk-1) echo "[cloud_morning_chain] dry-run: fetch first 12 stores only" ;;
    chunk-2) echo "[cloud_morning_chain] dry-run: require chunk-1, fetch remaining 7, merge all 19 and refresh linksData" ;;
    supplements) echo "[cloud_morning_chain] dry-run: require merged links, run non-browser daily supplements without RTV" ;;
    *) exit 64 ;;
  esac
  write_state "ok" "dry-run stage validated"
  exit 0
fi

case "$STAGE" in
  chunk-1)
    write_state "running" "first 12 stores are refreshing"
    RESULT_FILE="$STATE_DIR/${RUN_DATE}-chunk-1.json"
    run_fetch_chunk "$CHUNK_1_STORES" "$RESULT_FILE"
    CHUNK_STATUS="$(chunk_result_status "$RESULT_FILE")"
    FAILED_STORES="$(chunk_result_failed_stores "$RESULT_FILE")"
    if [[ "$CHUNK_STATUS" == "warning" ]]; then
      write_marker "morning-chunk-1" "warning" "first chunk completed with store gaps: $FAILED_STORES" "$RESULT_FILE" "$LOG_FILE" >/dev/null
      write_state "warning" "first chunk completed; failed stores will not block the second chunk: $FAILED_STORES"
    else
      write_marker "morning-chunk-1" "done" "first 12 stores fetched" "$RESULT_FILE" "$LOG_FILE" >/dev/null
      write_state "ok" "first 12 stores completed"
    fi
    ;;
  chunk-2)
    PRIOR_MISSING="$(missing_exact_date_stores)"
    TARGET_STORES="$(merge_store_lists "$CHUNK_2_STORES" "$PRIOR_MISSING")"
    if ! require_marker "morning-chunk-1"; then
      echo "[cloud_morning_chain] first chunk marker missing; resume from exact-date store evidence instead of blocking the whole pipeline"
    fi
    write_state "running" "second chunk is refreshing its stores plus unfinished first-chunk stores: $TARGET_STORES"
    RESULT_FILE="$STATE_DIR/${RUN_DATE}-chunk-2.json"
    run_fetch_chunk "$TARGET_STORES" "$RESULT_FILE"
    CHUNK_STATUS="$(chunk_result_status "$RESULT_FILE")"
    FAILED_STORES="$(chunk_result_failed_stores "$RESULT_FILE")"
    if [[ "$CHUNK_STATUS" == "warning" ]]; then
      write_marker "morning-chunk-2" "warning" "second chunk completed with store gaps: $FAILED_STORES" "$RESULT_FILE" "$LOG_FILE" >/dev/null
    else
      write_marker "morning-chunk-2" "done" "remaining 7 stores fetched" "$RESULT_FILE" "$LOG_FILE" >/dev/null
    fi

    write_state "running" "all 19 stores are merging"
    finalize_links_if_complete || exit $?
    ;;
  supplements)
    if ! require_marker "morning-links-ready"; then
      write_state "deferred" "all-store link marker is not ready"
      write_marker "morning-supplements" "deferred" "missing morning-links-ready marker" "$LOG_FILE" >/dev/null
      exit 75
    fi
    write_state "running" "daily OpenAPI, cost and profit supplements are refreshing"
    SHEIN_BI_DAILY_LINK_BUSINESS_MODE=skip \
    SHEIN_BI_DAILY_RTV_VERIFY=0 \
    SHEIN_BI_PORTAL_PREWARM_DISABLED=0 \
      bash scripts/cloud_daily_refresh.sh "$DATA_DATE"
    write_marker "morning-supplements" "done" "daily supplements completed; RTV runs in its own pre-work slot" \
      "$LOG_FILE" >/dev/null
    printf 'completed_at=%s\nbusiness_date=%s\nlog=%s\n' "$(now_iso)" "$DATA_DATE" "$LOG_FILE" \
      > "$STATE_DIR/${RUN_DATE}.done"
    write_state "ok" "morning pipeline completed"
    ;;
  *)
    echo "Unsupported morning stage: $STAGE" >&2
    exit 64
    ;;
esac

echo "[cloud_morning_chain] done stage=$STAGE log=$LOG_FILE"
