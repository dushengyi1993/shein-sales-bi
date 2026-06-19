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
  node - <<'NODE' | while IFS= read -r profile_dir; do
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8'));
for (const store of cfg.stores || []) {
  if (store.enabled === false) continue;
  console.log(path.join(root, 'profiles', `persistent-${store.profileKey}-profile`));
}
NODE
    [[ -n "$profile_dir" ]] || continue
    pkill -f -- "--user-data-dir=$profile_dir" 2>/dev/null || true
  done
}

store_profile_dir() {
  local key="$1"
  STORE_KEY="$key" node -e "const fs=require('fs'); const path=require('path'); const cfg=JSON.parse(fs.readFileSync('config/stores.json','utf8')); const s=(cfg.stores||[]).find(x=>String(x.storeKey).toUpperCase()===process.env.STORE_KEY.toUpperCase()); if(!s) process.exit(2); console.log(path.join(process.cwd(),'profiles',\`persistent-\${s.profileKey}-profile\`));"
}

close_one_store_browser() {
  local key="$1"
  local profile_dir
  profile_dir="$(store_profile_dir "$key")"
  [[ -n "$profile_dir" ]] || return 0
  pkill -f -- "--user-data-dir=$profile_dir" 2>/dev/null || true
}

store_keys() {
  if [[ -n "${SHEIN_LINK_BUSINESS_STORES:-}" ]]; then
    echo "$SHEIN_LINK_BUSINESS_STORES" | tr ',' ' '
    return 0
  fi
  node -e "const fs=require('fs'); const cfg=JSON.parse(fs.readFileSync('config/stores.json','utf8')); console.log((cfg.stores||[]).filter(s=>s.enabled!==false).map(s=>s.storeKey).join(' '));"
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

trap close_store_browsers EXIT

STORES="$(store_keys)"
FAILED_STORES=()
SUCCESS_STORES=()
ALLOW_PARTIAL="${SHEIN_LINK_BUSINESS_ALLOW_PARTIAL:-1}"
for STORE in $STORES; do
  STORE_OK=0
  MAX_ATTEMPTS="${SHEIN_LINK_BUSINESS_STORE_ATTEMPTS:-3}"
  for ATTEMPT in $(seq 1 "$MAX_ATTEMPTS"); do
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
    if [[ "$ALLOW_PARTIAL" != "1" && "$ALLOW_PARTIAL" != "true" ]]; then
      exit 1
    fi
  else
    SUCCESS_STORES+=("$STORE")
  fi
done

if [[ "${#FAILED_STORES[@]}" -gt 0 ]]; then
  echo "[cloud_link_business_sync] WARN failed stores: ${FAILED_STORES[*]}" >&2
  mkdir -p "$ROOT/state/cloud_ops_alerts"
  cat > "$ROOT/state/cloud_ops_alerts/link-business-last-partial.json" <<JSON
{"date":"$DATE","generatedAt":"$(TZ="$TZ_NAME" date --iso-8601=seconds)","failedStores":"${FAILED_STORES[*]}","successStores":"${SUCCESS_STORES[*]}","logFile":"$LOG_FILE"}
JSON
  if [[ "${SHEIN_LINK_BUSINESS_LOAD_PARTIAL:-0}" != "1" && "${SHEIN_LINK_BUSINESS_LOAD_PARTIAL:-0}" != "true" ]]; then
    echo "[cloud_link_business_sync] partial result recorded; skip BI warehouse/portal refresh to avoid presenting incomplete link/business date" >&2
    check_portal_health
    echo "[cloud_link_business_sync] done with partial failures date=$DATE failed=${FAILED_STORES[*]} log=$LOG_FILE"
    exit 0
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
  nohup bash scripts/prewarm_bi_portal_sections.sh >/dev/null 2>&1 &
  echo "[cloud_link_business_sync] portal section prewarm started pid=$!"
fi

check_portal_health

if [[ "${#FAILED_STORES[@]}" -gt 0 ]]; then
  echo "[cloud_link_business_sync] done with partial failures date=$DATE failed=${FAILED_STORES[*]} log=$LOG_FILE"
else
  rm -f "$ROOT/state/cloud_ops_alerts/link-business-last-partial.json" 2>/dev/null || true
  echo "[cloud_link_business_sync] done date=$DATE log=$LOG_FILE"
fi
