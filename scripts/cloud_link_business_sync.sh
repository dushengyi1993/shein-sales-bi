#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TARGET="${1:-yesterday}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_BI_LOG_DIR:-/srv/shein-bi/logs/cloud-link-business}"
METABASE_URL="${METABASE_URL:-http://127.0.0.1:3000}"
PORTAL_HEALTH_URL="${PORTAL_HEALTH_URL:-}"
PORTAL_INDEX_PATH="${PORTAL_INDEX_PATH:-$ROOT/outputs/bi-portal/index.html}"
PORTAL_DATA_PATH="${PORTAL_DATA_PATH:-$ROOT/outputs/bi-portal/data.json}"
LEASE_TASK="${SHEIN_LINK_BUSINESS_LEASE_TASK:-cloud-link-business}"
LEASE_RUN_ID="${SHEIN_LINK_BUSINESS_RUN_ID:-$(node -e 'console.log(require("node:crypto").randomUUID())')}"
LEASE_TTL_SEC="${SHEIN_LINK_BUSINESS_LEASE_TTL_SEC:-5400}"
LEASE_ACTIVE=0
FETCH_ONLY="${SHEIN_LINK_BUSINESS_FETCH_ONLY:-0}"
FINALIZE_ONLY="${SHEIN_LINK_BUSINESS_FINALIZE_ONLY:-0}"
CHUNK_RESULT_FILE="${SHEIN_LINK_BUSINESS_CHUNK_RESULT_FILE:-}"
RESUME_COMPLETED="${SHEIN_LINK_BUSINESS_RESUME_COMPLETED:-$FETCH_ONLY}"

is_true() {
  [[ "$1" == "1" || "$1" == "true" ]]
}

if is_true "$FETCH_ONLY" && is_true "$FINALIZE_ONLY"; then
  echo "SHEIN_LINK_BUSINESS_FETCH_ONLY and SHEIN_LINK_BUSINESS_FINALIZE_ONLY are mutually exclusive" >&2
  exit 64
fi

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
      echo "Unsupported date target: $target" >&2
      exit 64
      ;;
  esac
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
    echo "[cloud_link_business_sync] portal files ok index=$PORTAL_INDEX_PATH data=$PORTAL_DATA_PATH"
  fi
}

close_store_browsers() {
  cd "$ROOT"
  local owned_args=()
  local selection_args=(--all)
  if [[ "$LEASE_ACTIVE" == "1" ]]; then
    owned_args+=(--owned-lease-task "$LEASE_TASK" --owned-lease-run-id "$LEASE_RUN_ID")
  fi
  if [[ -n "${SHEIN_LINK_BUSINESS_STORES:-}" ]]; then
    selection_args=(--stores "$SHEIN_LINK_BUSINESS_STORES")
  fi
  node scripts/cleanup_shein_store_browsers.mjs "${selection_args[@]}" --cleanup-chrome-tmp --kill-after-sec 5 "${owned_args[@]}" || true
}

lease_action() {
  local selection_args=(--group ALL)
  if [[ -n "${SHEIN_LINK_BUSINESS_STORES:-}" ]]; then
    selection_args=(--stores "$SHEIN_LINK_BUSINESS_STORES")
  fi
  node scripts/manage_browser_task_leases.mjs "$1" --root "$ROOT" --task "$LEASE_TASK" \
    --run-id "$LEASE_RUN_ID" --owner-pid "$$" --ttl-sec "$LEASE_TTL_SEC" "${selection_args[@]}"
}

on_exit() {
  set +e
  if [[ "$LEASE_ACTIVE" == "1" ]]; then
    close_store_browsers
    lease_action release >/dev/null 2>&1 || true
    LEASE_ACTIVE=0
  fi
}

write_link_business_success() {
  local portal_refreshed="$1"
  mkdir -p "$ROOT/state/cloud_ops_alerts"
  DATE="$DATE" \
  LOG_FILE="$LOG_FILE" \
  PORTAL_REFRESHED="$portal_refreshed" \
  SUCCESS_STORES="${SUCCESS_STORES[*]}" \
  node - <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const successfulStores = String(process.env.SUCCESS_STORES || '')
  .split(/\s+/)
  .map(value => value.trim().toUpperCase())
  .filter(Boolean);
const payload = {
  ok: true,
  date: process.env.DATE,
  generatedAt: new Date().toISOString(),
  successfulStores,
  failedStores: [],
  metricReady: true,
  warehouseLoaded: true,
  portalRefreshed: ['1', 'true'].includes(String(process.env.PORTAL_REFRESHED || '').toLowerCase()),
  logFile: process.env.LOG_FILE,
};
const file = path.join(root, 'state', 'cloud_ops_alerts', 'link-business-last-success.json');
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
fs.renameSync(tmp, file);
NODE
}

write_chunk_result() {
  local status="$1"
  local message="$2"
  [[ -n "$CHUNK_RESULT_FILE" ]] || return 0
  mkdir -p "$(dirname "$CHUNK_RESULT_FILE")"
  DATE="$DATE" \
  STATUS="$status" \
  MESSAGE="$message" \
  SUCCESS_STORES="${SUCCESS_STORES[*]}" \
  FAILED_STORES="${FAILED_STORES[*]}" \
  LOG_FILE="$LOG_FILE" \
  CHUNK_RESULT_FILE="$CHUNK_RESULT_FILE" \
  node - <<'NODE'
const fs = require('fs');
const split = value => String(value || '')
  .split(/[\s,]+/)
  .map(item => item.trim().toUpperCase())
  .filter(Boolean);
const payload = {
  ok: process.env.STATUS === 'done',
  status: process.env.STATUS,
  date: process.env.DATE,
  generatedAt: new Date().toISOString(),
  successfulStores: split(process.env.SUCCESS_STORES),
  failedStores: split(process.env.FAILED_STORES),
  message: process.env.MESSAGE || '',
  logFile: process.env.LOG_FILE,
};
const temporary = `${process.env.CHUNK_RESULT_FILE}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {mode: 0o660});
fs.renameSync(temporary, process.env.CHUNK_RESULT_FILE);
NODE
}

store_profile_dir() {
  local key="$1"
  STORE_KEY="$key" node -e "const fs=require('fs'); const path=require('path'); const cfg=JSON.parse(fs.readFileSync('config/stores.json','utf8')); const s=(cfg.stores||[]).find(x=>String(x.storeKey).toUpperCase()===process.env.STORE_KEY.toUpperCase()); if(!s) process.exit(2); console.log(path.join(process.cwd(),'profiles',\`persistent-\${s.profileKey}-profile\`));"
}

close_one_store_browser() {
  local key="$1"
  local owned_args=()
  if [[ "$LEASE_ACTIVE" == "1" ]]; then
    owned_args+=(--owned-lease-task "$LEASE_TASK" --owned-lease-run-id "$LEASE_RUN_ID")
  fi
  node scripts/cleanup_shein_store_browsers.mjs --store "$key" --cleanup-chrome-tmp --kill-after-sec 5 "${owned_args[@]}" || true
}

store_keys() {
  if [[ -n "${SHEIN_LINK_BUSINESS_STORES:-}" ]]; then
    echo "$SHEIN_LINK_BUSINESS_STORES" | tr ',' ' '
    return 0
  fi
  node -e "const fs=require('fs'); const cfg=JSON.parse(fs.readFileSync('config/stores.json','utf8')); console.log((cfg.stores||[]).filter(s=>s.enabled!==false).map(s=>s.storeKey).join(' '));"
}

store_evidence_is_complete() {
  local store="$1"
  DATE="$DATE" STORE="$store" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const date = process.env.DATE;
const store = String(process.env.STORE || '').trim().toUpperCase();
const files = [
  path.join(process.cwd(), 'outputs', 'shein_links', store, `${date}.json`),
  path.join(process.cwd(), 'outputs', 'shein_business_domains', store, `${date}.json`),
];
for (const file of files) {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { process.exit(1); }
  const payloadStore = String(payload?.store?.storeKey || '').trim().toUpperCase();
  if (payload?.ok !== true || String(payload?.date || '') !== date || payloadStore !== store) process.exit(1);
}
NODE
}

DATE="$(resolve_date "$TARGET")"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/link-business-${DATE}-${STAMP}.log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[cloud_link_business_sync] start target=$TARGET date=$DATE root=$ROOT"
cd "$ROOT"

export SHEIN_BI_PORTAL_TIMEOUT_MS="${SHEIN_BI_PORTAL_TIMEOUT_MS:-1800000}"
export SHEIN_BI_PORTAL_DATA_MODE="${SHEIN_BI_PORTAL_DATA_MODE:-api}"

trap on_exit EXIT
STORES="$(store_keys)"
FAILED_STORES=()
SUCCESS_STORES=()
ALLOW_PARTIAL="${SHEIN_LINK_BUSINESS_ALLOW_PARTIAL:-1}"
if is_true "$FINALIZE_ONLY"; then
  echo "[cloud_link_business_sync] finalize-only validate current-date all-store evidence"
  while IFS='|' read -r STATUS STORE REASON; do
    [[ -n "$STORE" ]] || continue
    if [[ "$STATUS" == "ok" ]]; then
      SUCCESS_STORES+=("$STORE")
    else
      FAILED_STORES+=("$STORE")
      echo "[cloud_link_business_sync] finalize evidence missing store=$STORE reason=$REASON" >&2
    fi
  done < <(
    DATE="$DATE" STORES="$STORES" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const date = process.env.DATE;
const stores = String(process.env.STORES || '').split(/\s+/).map(value => value.trim().toUpperCase()).filter(Boolean);
for (const store of stores) {
  const files = [
    path.join(process.cwd(), 'outputs', 'shein_links', store, `${date}.json`),
    path.join(process.cwd(), 'outputs', 'shein_business_domains', store, `${date}.json`),
  ];
  let reason = '';
  for (const file of files) {
    try {
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      const payloadStore = String(payload?.store?.storeKey || '').trim().toUpperCase();
      if (payload?.ok !== true) reason = `not_ok:${path.basename(path.dirname(file))}`;
      else if (String(payload?.date || '') !== date) reason = `date_mismatch:${path.basename(path.dirname(file))}`;
      else if (payloadStore !== store) reason = `store_mismatch:${path.basename(path.dirname(file))}`;
    } catch (error) {
      reason = error?.code === 'ENOENT' ? `missing:${file}` : `invalid:${file}`;
    }
    if (reason) break;
  }
  process.stdout.write(`${reason ? 'failed' : 'ok'}|${store}|${reason}\n`);
}
NODE
  )
else
  lease_action acquire
  LEASE_ACTIVE=1
  close_store_browsers
  for STORE in $STORES; do
    if is_true "$RESUME_COMPLETED" && store_evidence_is_complete "$STORE"; then
      SUCCESS_STORES+=("$STORE")
      echo "[cloud_link_business_sync] store=$STORE resume-skip exact-date link/business evidence already complete"
      continue
    fi
    STORE_OK=0
    MAX_ATTEMPTS="${SHEIN_LINK_BUSINESS_STORE_ATTEMPTS:-3}"
    for ATTEMPT in $(seq 1 "$MAX_ATTEMPTS"); do
      lease_action heartbeat >/dev/null
      echo "[cloud_link_business_sync] store=$STORE attempt=$ATTEMPT/$MAX_ATTEMPTS bootstrap/fetch start"
      close_one_store_browser "$STORE"
      if node scripts/restore_shein_store_session.mjs \
        --store "$STORE" \
        --date "$DATE" \
        --headless \
        --timeout-ms "${SHEIN_SESSION_RESTORE_TIMEOUT_MS:-180000}" \
        && node scripts/fetch_shein_links.mjs \
          --stores "$STORE" \
          --date "$DATE" \
          --page-size "${SHEIN_LINK_PAGE_SIZE:-50}" \
        && node scripts/fetch_shein_business_domains.mjs \
          --store "$STORE" \
          --date "$DATE" \
          --domains "${SHEIN_BUSINESS_DOMAINS:-home,afterSales,waybill,fulfillment,productInventory,management,marketing,quality,comments}" \
          --wait-ms "${SHEIN_BUSINESS_WAIT_MS:-2000}" \
          --max-pages "${SHEIN_BUSINESS_MAX_PAGES:-20}" \
          --store-attempts "${SHEIN_BUSINESS_STORE_ATTEMPTS:-2}" \
          --relogin-headless \
          --json; then
        STORE_OK=1
        close_one_store_browser "$STORE"
        echo "[cloud_link_business_sync] store=$STORE done"
        break
      fi
      close_one_store_browser "$STORE"
      echo "[cloud_link_business_sync] store=$STORE attempt=$ATTEMPT failed; will retry after short cooldown" >&2
      sleep 10
    done
    if [[ "$STORE_OK" != "1" ]]; then
      echo "[cloud_link_business_sync] store=$STORE failed after $MAX_ATTEMPTS attempts" >&2
      FAILED_STORES+=("$STORE")
      if ! is_true "$ALLOW_PARTIAL"; then
        write_chunk_result "failed" "store fetch failed"
        exit 1
      fi
    else
      SUCCESS_STORES+=("$STORE")
    fi
  done
fi

if is_true "$FETCH_ONLY"; then
  if [[ "${#FAILED_STORES[@]}" -gt 0 ]]; then
    if is_true "$ALLOW_PARTIAL"; then
      write_chunk_result "warning" "one or more stores failed; completed stores are preserved for the next chunk"
      echo "[cloud_link_business_sync] fetch-only partial stores=${SUCCESS_STORES[*]} failed=${FAILED_STORES[*]}" >&2
      exit 0
    fi
    write_chunk_result "failed" "one or more stores failed"
    echo "[cloud_link_business_sync] fetch-only failed stores=${FAILED_STORES[*]}" >&2
    exit 1
  fi
  write_chunk_result "done" "selected stores fetched; global merge intentionally deferred"
  echo "[cloud_link_business_sync] fetch-only done date=$DATE stores=${SUCCESS_STORES[*]} log=$LOG_FILE"
  exit 0
fi

if [[ "${#FAILED_STORES[@]}" -gt 0 ]]; then
  echo "[cloud_link_business_sync] WARN failed stores: ${FAILED_STORES[*]}" >&2
  mkdir -p "$ROOT/state/cloud_ops_alerts"
  DATE="$DATE" \
  GENERATED_AT="$(TZ="$TZ_NAME" date --iso-8601=seconds)" \
  FAILED_STORES="${FAILED_STORES[*]}" \
  SUCCESS_STORES="${SUCCESS_STORES[*]}" \
  LOG_FILE="$LOG_FILE" \
  node - <<'NODE'
const fs = require('fs');
const path = require('path');
const file = path.join(process.cwd(), 'state', 'cloud_ops_alerts', 'link-business-last-partial.json');
const split = value => (Array.isArray(value) ? value : String(value || '').split(/[\s,]+/))
  .map(item => String(item || '').trim().toUpperCase())
  .filter(Boolean);
let prior = null;
try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const sameDate = String(prior?.date || '') === String(process.env.DATE || '');
const success = new Set(sameDate ? split(prior?.successStores) : []);
const failed = new Set(sameDate ? split(prior?.failedStores) : []);
for (const store of split(process.env.SUCCESS_STORES)) {
  success.add(store);
  failed.delete(store);
}
for (const store of split(process.env.FAILED_STORES)) {
  failed.add(store);
  success.delete(store);
}
const payload = {
  date: process.env.DATE,
  generatedAt: process.env.GENERATED_AT,
  failedStores: [...failed].join(' '),
  successStores: [...success].join(' '),
  logFile: process.env.LOG_FILE,
};
const temporary = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
fs.renameSync(temporary, file);
NODE
  if [[ "${SHEIN_LINK_BUSINESS_LOAD_PARTIAL:-0}" != "1" && "${SHEIN_LINK_BUSINESS_LOAD_PARTIAL:-0}" != "true" ]]; then
    echo "[cloud_link_business_sync] partial result recorded; skip BI warehouse/portal refresh to avoid presenting incomplete link/business date" >&2
    check_portal_health
    echo "[cloud_link_business_sync] done with partial failures date=$DATE failed=${FAILED_STORES[*]} log=$LOG_FILE"
    if is_true "$FINALIZE_ONLY" && ! is_true "$ALLOW_PARTIAL"; then
      exit 1
    fi
    exit 0
  fi
fi

# A targeted retry should be able to close an earlier all-store partial run
# without re-opening the other 18 browser profiles. Merge only when the prior
# partial is for the same date, every formerly failed store succeeded now, and
# the combined set exactly covers every enabled store. The downstream metric,
# warehouse and portal checks still run over the merged all-store evidence.
if [[ "${#FAILED_STORES[@]}" -eq 0 && -s "$ROOT/state/cloud_ops_alerts/link-business-last-partial.json" ]]; then
  MERGED_RECOVERY_STORES="$(
    DATE="$DATE" CURRENT_SUCCESS_STORES="${SUCCESS_STORES[*]}" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const stateFile = path.join(root, 'state', 'cloud_ops_alerts', 'link-business-last-partial.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (String(state.date || '') !== String(process.env.DATE || '')) process.exit(0);
const split = value => (Array.isArray(value) ? value : String(value || '').split(/[\s,]+/))
  .map(item => String(item || '').trim().toUpperCase())
  .filter(Boolean);
const current = new Set(split(process.env.CURRENT_SUCCESS_STORES));
const failed = split(state.failedStores);
if (!failed.length || failed.some(store => !current.has(store))) process.exit(0);
const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8'));
const expected = (config.stores || [])
  .filter(store => store.enabled !== false)
  .map(store => String(store.storeKey || '').trim().toUpperCase())
  .filter(Boolean);
const merged = new Set([...split(state.successStores), ...current]);
if (expected.some(store => !merged.has(store)) || [...merged].some(store => !expected.includes(store))) process.exit(0);
process.stdout.write(expected.join(' '));
NODE
  )"
  if [[ -n "$MERGED_RECOVERY_STORES" ]]; then
    SUCCESS_STORES=($MERGED_RECOVERY_STORES)
    echo "[cloud_link_business_sync] targeted recovery completed prior partial; merged all-store evidence: ${SUCCESS_STORES[*]}"
  fi
fi

set +e
METRIC_READY_JSON="$(
  DATE="$DATE" SUCCESS_STORES="${SUCCESS_STORES[*]}" node - <<'NODE'
const fs = require('fs');
const path = require('path');

const date = process.env.DATE;
const successStores = String(process.env.SUCCESS_STORES || '')
  .split(/\s+/)
  .map(s => s.trim())
  .filter(Boolean);

function num(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(String(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : 0;
}

const metrics = {
  date,
  successStores,
  files: 0,
  performanceRows: 0,
  diagnoseDayRows: 0,
  zeroDiagnoseDayStores: [],
  epsUv: 0,
  goodsUv: 0,
  saleCnt: 0,
  payOrderCnt: 0,
};

for (const store of successStores) {
  const file = path.join(process.cwd(), 'outputs', 'shein_links', store, `${date}.json`);
  if (!fs.existsSync(file)) continue;
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(payload.performanceRows) ? payload.performanceRows : [];
  const diagnoseDay = num(payload.counts?.diagnoseDay);
  metrics.files += 1;
  metrics.performanceRows += rows.length;
  metrics.diagnoseDayRows += diagnoseDay;
  if (diagnoseDay === 0) metrics.zeroDiagnoseDayStores.push(store);
  for (const row of rows) {
    metrics.epsUv += num(row.epsUv ?? row.eps_uv);
    metrics.goodsUv += num(row.goodsUv ?? row.goods_uv);
    metrics.saleCnt += num(row.saleCnt ?? row.sale_cnt);
    metrics.payOrderCnt += num(row.payOrderCnt ?? row.pay_order_cnt);
  }
}

const metricSum = metrics.epsUv + metrics.goodsUv + metrics.saleCnt + metrics.payOrderCnt;
const enoughStoresForGuard = successStores.length >= 10;
const notReady = enoughStoresForGuard && metrics.performanceRows > 0 && (metrics.diagnoseDayRows === 0 || metricSum === 0);
const ok = !notReady || ['1', 'true'].includes(String(process.env.SHEIN_LINK_BUSINESS_ALLOW_ALL_ZERO || '').toLowerCase());
console.log(JSON.stringify({
  ok,
  reason: notReady ? 'daily_link_metrics_all_zero_or_not_ready' : '',
  metrics,
}));
process.exit(ok ? 0 : 2);
NODE
)"
METRIC_READY_STATUS=$?
set -e
echo "[cloud_link_business_sync] link metric readiness: $METRIC_READY_JSON"
if [[ "$METRIC_READY_STATUS" != "0" ]]; then
  mkdir -p "$ROOT/state/cloud_ops_alerts"
  cat > "$ROOT/state/cloud_ops_alerts/link-business-last-metric-not-ready.json" <<JSON
{"date":"$DATE","generatedAt":"$(TZ="$TZ_NAME" date --iso-8601=seconds)","logFile":"$LOG_FILE","readiness":$METRIC_READY_JSON}
JSON
  echo "[cloud_link_business_sync] link daily metrics are not ready; skip BI warehouse/portal refresh to avoid writing all-zero traffic date" >&2
  check_portal_health
  echo "[cloud_link_business_sync] done with metric-not-ready date=$DATE log=$LOG_FILE"
  exit 0
fi
rm -f "$ROOT/state/cloud_ops_alerts/link-business-last-metric-not-ready.json" 2>/dev/null || true

node scripts/generate_link_ops_web_dashboard.mjs \
  --date "$DATE" \
  --group ALL

node scripts/load_bi_warehouse.mjs \
  --sales-date 2099-01-01 \
  --link-date "$DATE" \
  --dashboard-json "outputs/link-dashboard/link-ops-dashboard-${DATE}.json"

node scripts/load_bi_business_domains.mjs \
  --date "$DATE"

node scripts/marketing/export_marketing_price_leads_for_bi.mjs || true

if [[ "${SHEIN_LINK_BUSINESS_REFRESH_PORTAL:-1}" != "1" && "${SHEIN_LINK_BUSINESS_REFRESH_PORTAL:-1}" != "true" ]]; then
  echo "[cloud_link_business_sync] warehouse load done; skip portal refresh because SHEIN_LINK_BUSINESS_REFRESH_PORTAL=${SHEIN_LINK_BUSINESS_REFRESH_PORTAL:-}"
  if [[ "${#FAILED_STORES[@]}" -eq 0 ]]; then
    rm -f "$ROOT/state/cloud_ops_alerts/link-business-last-partial.json" 2>/dev/null || true
    write_link_business_success false
  fi
  echo "[cloud_link_business_sync] done date=$DATE log=$LOG_FILE"
  exit 0
fi

node scripts/audit_bi_warehouse.mjs

node scripts/generate_bi_portal.mjs \
  --metabase-url "$METABASE_URL"

node scripts/generate_bi_portal_shell.mjs

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet shein-bi-portal.service || systemctl start shein-bi-portal.service || true
fi

if [[ "$SHEIN_BI_PORTAL_DATA_MODE" == "api" && "${SHEIN_BI_PORTAL_PREWARM_DISABLED:-0}" != "1" ]]; then
  bash scripts/enqueue_bi_portal_sections.sh \
    --sections linksData,productState,productTrafficDaily,homeTrafficDaily \
    --priority 20 \
    --reason "link-business-$DATE"
  bash scripts/enqueue_bi_portal_sections.sh \
    --sections afterSales,waybills,comments,actions \
    --priority 50 \
    --reason "link-business-$DATE"
  echo "[cloud_link_business_sync] portal sections queued for bounded host-locked refresh"
fi

check_portal_health

if [[ "${#FAILED_STORES[@]}" -gt 0 ]]; then
  echo "[cloud_link_business_sync] done with partial failures date=$DATE failed=${FAILED_STORES[*]} log=$LOG_FILE"
else
  rm -f "$ROOT/state/cloud_ops_alerts/link-business-last-partial.json" 2>/dev/null || true
  write_link_business_success true
  echo "[cloud_link_business_sync] done date=$DATE log=$LOG_FILE"
fi
