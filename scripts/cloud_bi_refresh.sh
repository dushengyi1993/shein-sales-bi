#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
source "$ROOT/scripts/lib/shared_lock.sh"
TARGET="${1:-today}"
MODE="${2:-intraday}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_BI_LOG_DIR:-/srv/shein-bi/logs/cloud-refresh}"
METABASE_URL="${METABASE_URL:-http://127.0.0.1:3000}"
PORTAL_HEALTH_URL="${PORTAL_HEALTH_URL:-}"
PORTAL_INDEX_PATH="${PORTAL_INDEX_PATH:-$ROOT/outputs/bi-portal/index.html}"
PORTAL_DATA_PATH="${PORTAL_DATA_PATH:-$ROOT/outputs/bi-portal/data.json}"
MARKETING_PRICE_LEADS_PATH="${SHEIN_BI_MARKETING_PRICE_LEADS_PATH:-$ROOT/outputs/bi-portal/marketing-price-leads.json}"
LOCK_FILE="${SHEIN_BI_REFRESH_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-sales-refresh.lock}"
PORTAL_REFRESH_LOCK_FILE="${SHEIN_BI_PORTAL_REFRESH_LOCK_FILE:-$ROOT/state/locks/shein-bi-portal-refresh.lock}"
PORTAL_REFRESH_LOCK_WAIT_SEC="${SHEIN_BI_PORTAL_REFRESH_LOCK_WAIT_SEC:-1800}"
if [[ "${SHEIN_DOCKER_USE_SUDO:-0}" == "1" ]]; then
  DOCKER=(sudo docker)
else
  DOCKER=(docker)
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
    2daysago|two-days-ago|third-day-stable-recheck)
      TZ="$TZ_NAME" date -d '2 days ago' +%F
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
    echo "[cloud_bi_refresh] portal files ok index=$PORTAL_INDEX_PATH data=$PORTAL_DATA_PATH"
  fi
  local marketing_health
  marketing_health="$(marketing_price_snapshot_health)"
  echo "[cloud_bi_refresh] marketing price snapshot health $marketing_health"
  if [[ "${SHEIN_BI_MARKETING_PRICE_LEADS_REQUIRE_FRESH:-0}" == "1" && "$marketing_health" != fresh\|* ]]; then
    echo "[cloud_bi_refresh] marketing price snapshot is not fresh and strict freshness is required" >&2
    exit 1
  fi
}

marketing_price_snapshot_health() {
  node - "$MARKETING_PRICE_LEADS_PATH" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
try {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const freshness = doc && typeof doc.freshness === 'object' ? doc.freshness : {};
  const status = String(freshness.status || 'unknown').toLowerCase();
  const checkedAt = String(freshness.checkedAt || '');
  const snapshotAt = String(freshness.snapshotGeneratedAt || doc.generatedAt || '');
  const reason = String(freshness.reason || '').replace(/[\r\n|]+/g, ' ').slice(0, 500);
  console.log(`${status}|checkedAt=${checkedAt}|snapshotAt=${snapshotAt}|reason=${reason}`);
} catch (error) {
  console.log(`error|reason=unreadable marketing price snapshot: ${String(error.message || error).replace(/[\r\n|]+/g, ' ').slice(0, 500)}`);
}
NODE
}

DATE="$(resolve_date "$TARGET")"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${MODE}-${DATE}-${STAMP}.log"

prepare_shared_lock_file "$LOCK_FILE"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[cloud_bi_refresh] another sales refresh is running; skip target=$TARGET date=$DATE mode=$MODE"
  exit "${SHEIN_BI_REFRESH_BUSY_EXIT_CODE:-0}"
fi

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[cloud_bi_refresh] start target=$TARGET date=$DATE mode=$MODE root=$ROOT"
cd "$ROOT"

export SHEIN_SALES_TRANSPORT="${SHEIN_SALES_TRANSPORT:-openapi}"
export SHEIN_BI_PORTAL_TIMEOUT_MS="${SHEIN_BI_PORTAL_TIMEOUT_MS:-1800000}"
export SHEIN_BI_PORTAL_DATA_MODE="${SHEIN_BI_PORTAL_DATA_MODE:-api}"

PRIMARY_SALES_ACTIVE="$(
  "${DOCKER[@]}" exec shein-warehouse-db psql -X -qAt -U shein -d shein_bi \
    -c "SELECT CASE WHEN ops.shein_webhook_primary_sales_enabled(DATE '$DATE') THEN 'true' ELSE 'false' END"
)"
if [[ "$PRIMARY_SALES_ACTIVE" == "true" && "${SHEIN_BI_PRIMARY_SALES_FINALIZE:-1}" != "0" ]]; then
  # Webhook + official OpenAPI are the production sales sources after cutover.
  # Finalize the complete day from all 19 authorized stores without depending
  # on expiring Seller Center cookies or browser profiles.  The OpenAPI fetch,
  # load, and per-store daily-row checks below are the completeness gate; the
  # reconciliation status against any old WebAPI artifact is diagnostic only.
  OPENAPI_RECON_DIR="${SHEIN_BI_OPENAPI_RECON_DIR:-/srv/shein-bi/logs/openapi-sales-reconciliation}"
  OPENAPI_RECON_FILE="$OPENAPI_RECON_DIR/openapi-sales-$DATE-$STAMP.json"
  mkdir -p "$OPENAPI_RECON_DIR"
  node scripts/run_shein_openapi_sales_reconciliation.mjs \
    --date "$DATE" \
    --concurrency "${SHEIN_OPENAPI_RECONCILE_CONCURRENCY:-3}" \
    --out "$OPENAPI_RECON_FILE"
  node - "$OPENAPI_RECON_FILE" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const counts = report.counts || {};
const expected = 19;
const expectedStores = ['CX','DL','DX','FY','HL','JSH','JY','LQ','MZ','NM','QH','QY','TS','TZ','TZZ','XC','XL','YJ','ZL'];
const authorizedStores = [...new Set((report.authorizedStores || []).map(value => String(value || '').trim().toUpperCase()))].sort();
const results = Array.isArray(report.results) ? report.results : [];
const ok = report.ok === true
  && Number(counts.total) === expected
  && Number(counts.succeeded) === expected
  && Number(counts.failed || 0) === 0
  && Number(counts.skipped || 0) === 0
  && JSON.stringify(authorizedStores) === JSON.stringify(expectedStores)
  && results.length === expected
  && results.every(row =>
    row?.ok === true
    && row?.fetch?.ok === true
    && row?.load?.ok === true
    && Number(row?.load?.rowCounts?.daily || 0) === 1
  );
if (!ok) {
  throw new Error(`OpenAPI final-day completeness gate failed: ${JSON.stringify({
    counts,
    authorizedStores,
    resultCount: results.length,
    failedStores: results.filter(row => !(row?.ok === true && row?.fetch?.ok === true && row?.load?.ok === true && Number(row?.load?.rowCounts?.daily || 0) === 1)).map(row => row?.storeKey),
  })}`);
}
console.log(`[cloud_bi_refresh] OpenAPI final-day completeness gate passed: ${JSON.stringify(counts)}`);
NODE
  PROMOTION_RESULT="$(
    "${DOCKER[@]}" exec shein-warehouse-db psql -X -qAt -F '|' -v ON_ERROR_STOP=1 -U shein -d shein_bi \
      -c "SELECT headers_written,items_written,payment_flags_written,daily_rows_refreshed FROM ops.promote_openapi_sales_slice(DATE '$DATE',DATE '$DATE')"
  )"
  echo "[cloud_bi_refresh] canonical OpenAPI sales promoted date=$DATE result=$PROMOTION_RESULT reconciliation=$OPENAPI_RECON_FILE"
else
  # Historical pre-cutover recovery only. Production dates must not fall back
  # to Seller Center sessions merely because a browser profile is available.
  export SHEIN_SALES_TRANSPORT=webapi
  node scripts/run_sales_sync_job.mjs \
    --date "$DATE" \
    --group ALL \
    --skip-lark-base \
    --store-attempts "${SHEIN_STORE_ATTEMPTS:-1}" \
    --no-launch \
    --no-products \
    --no-monthly \
    --no-compact \
    --no-dashboard \
    --status "cloud-${MODE}"

  node scripts/load_bi_warehouse.mjs \
    --sales-date "$DATE" \
    --skip-links \
    --skip-dashboard
fi

COST_LEDGER_STATUS=0
if [[ "${SHEIN_BI_INVENTORY_COST_REFRESH:-1}" == "1" || "${SHEIN_BI_INVENTORY_COST_REFRESH:-1}" == "true" ]]; then
  set +e
  bash scripts/refresh_inventory_cost_ledger.sh
  COST_LEDGER_STATUS=$?
  set -e
  if [[ "$COST_LEDGER_STATUS" -ne 0 ]]; then
    echo "[cloud_bi_refresh] WARN inventory cost ledger refresh failed status=$COST_LEDGER_STATUS; sales facts remain available and profit keeps the previous valued snapshot" >&2
  fi
fi

# 高频销售刷新只使用已经补采好的慢变数据快照；不要在两小时销售
# 任务里顺手打开 SHEIN 后台扫描活动价，否则会拖慢当天经营数据刷新。
# 慢变补采统一由 cloud_daily_refresh.sh 调度。
node scripts/marketing/export_marketing_price_leads_for_bi.mjs
MARKETING_PRICE_SNAPSHOT_HEALTH="$(marketing_price_snapshot_health)"
case "$MARKETING_PRICE_SNAPSHOT_HEALTH" in
  fresh\|*) echo "[cloud_bi_refresh] marketing price snapshot refreshed $MARKETING_PRICE_SNAPSHOT_HEALTH" ;;
  *) echo "[cloud_bi_refresh] WARN marketing price snapshot is degraded $MARKETING_PRICE_SNAPSHOT_HEALTH" >&2 ;;
esac

prepare_shared_lock_file "$PORTAL_REFRESH_LOCK_FILE"
{
  if ! flock -w "$PORTAL_REFRESH_LOCK_WAIT_SEC" 8; then
    echo "[cloud_bi_refresh] portal refresh lock busy after ${PORTAL_REFRESH_LOCK_WAIT_SEC}s; skip portal generation/prewarm this run"
  else
    if [[ "$COST_LEDGER_STATUS" -eq 0 && "${SHEIN_BI_PROFIT_MART_REFRESH_DISABLED:-0}" != "1" ]]; then
      set +e
      bash scripts/refresh_profit_marts.sh
      PROFIT_MART_STATUS=$?
      set -e
      if [[ "$PROFIT_MART_STATUS" -ne 0 ]]; then
        echo "[cloud_bi_refresh] WARN profit mart refresh failed status=$PROFIT_MART_STATUS; portal will retain the last complete cache" >&2
      fi
    fi
    set +e
    node scripts/audit_bi_warehouse.mjs
    AUDIT_STATUS=$?
    set -e
    if [[ "$AUDIT_STATUS" -ne 0 ]]; then
      echo "[cloud_bi_refresh] BI audit finished with status=$AUDIT_STATUS; continue portal generation so the page can show the audit result"
    fi

    # V2 production is a lightweight shell + on-demand section API. Refresh
    # only the small API core data.json here so watchdog/data status sees the
    # latest sales run; do not run the legacy all-in-one portal SQL.
    node scripts/generate_bi_portal.mjs \
      --metabase-url "$METABASE_URL" \
      --data-mode "$SHEIN_BI_PORTAL_DATA_MODE"
    node scripts/generate_bi_portal_shell.mjs

    if command -v systemctl >/dev/null 2>&1; then
      systemctl is-active --quiet shein-bi-portal.service || systemctl start shein-bi-portal.service || true
    fi

    if [[ "$SHEIN_BI_PORTAL_DATA_MODE" == "api" && "${SHEIN_BI_PORTAL_PREWARM_DISABLED:-0}" != "1" ]]; then
      bash scripts/enqueue_bi_portal_sections.sh \
        --sections homeRankings,afterSales,orders \
        --priority 4 \
        --reason "sales-$MODE-$DATE"
      bash scripts/enqueue_bi_portal_sections.sh \
        --sections profit \
        --priority 5 \
        --reason "sales-$MODE-$DATE"
      bash scripts/enqueue_bi_portal_sections.sh \
        --sections homeProfit,homeTrafficDaily,priceScatter \
        --priority 10 \
        --reason "sales-$MODE-$DATE"
      bash scripts/enqueue_bi_portal_sections.sh \
        --sections actions,linksData,productState,productSalesDaily,productTrafficDaily,comments,rtvData,waybills,rankings \
        --priority 50 \
        --reason "sales-$MODE-$DATE"
      echo "[cloud_bi_refresh] portal sections queued for bounded host-locked refresh"
    fi
  fi
} 8>>"$PORTAL_REFRESH_LOCK_FILE"

check_portal_health

echo "[cloud_bi_refresh] done date=$DATE mode=$MODE log=$LOG_FILE"
