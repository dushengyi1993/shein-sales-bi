#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
DATE="$(TZ="$TZ_NAME" date +%F)"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
STATE_DIR="${SHEIN_TODAY_RECONCILE_STATE_DIR:-$ROOT/state/pipeline/today-sales/$DATE}"
LOG_DIR="${SHEIN_TODAY_RECONCILE_LOG_DIR:-/srv/shein-bi/logs/cloud-today-sales-reconcile}"
LOCK_FILE="${SHEIN_TODAY_RECONCILE_LOCK_FILE:-$ROOT/state/locks/shein-bi-today-sales-reconcile.lock}"
REPORT_FILE="$STATE_DIR/openapi-$STAMP.json"
MARKER_FILE="$STATE_DIR/reconciled-$STAMP.json"
LATEST_FILE="$STATE_DIR/latest.json"
PORTAL_URL="${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}"

mkdir -p "$STATE_DIR" "$LOG_DIR"
source "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$LOCK_FILE"
exec 9<>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[today-sales-reconcile] another lightweight reconcile is active; skip"
  exit 75
fi

LOG_FILE="$LOG_DIR/today-sales-$STAMP.log"
exec > >(tee -a "$LOG_FILE") 2>&1
cd "$ROOT"
echo "[today-sales-reconcile] start date=$DATE"

SHEIN_OPENAPI_LOG_DIR="$LOG_DIR/openapi" \
SHEIN_OPENAPI_RECONCILE_LATEST_FILE="$REPORT_FILE" \
SHEIN_OPENAPI_RECONCILE_REFRESH_PORTAL=0 \
  bash scripts/cloud_openapi_reconciliation.sh "$DATE"

node - "$REPORT_FILE" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const expectedStores = ['CX','DL','DX','FY','HL','JSH','JY','LQ','MZ','NM','QH','QY','TS','TZ','TZZ','XC','XL','YJ','ZL'];
const counts = report.counts || {};
const authorizedStores = [...new Set((report.authorizedStores || [])
  .map(value => String(value || '').trim().toUpperCase()))].sort();
const results = Array.isArray(report.results) ? report.results : [];
const complete = report.ok === true
  && Number(counts.total) === expectedStores.length
  && Number(counts.succeeded) === expectedStores.length
  && Number(counts.failed || 0) === 0
  && Number(counts.skipped || 0) === 0
  && JSON.stringify(authorizedStores) === JSON.stringify(expectedStores)
  && results.length === expectedStores.length
  && results.every(row => row?.ok === true
    && row?.fetch?.ok === true
    && row?.load?.ok === true
    && Number(row?.load?.rowCounts?.daily || 0) === 1);
if (!complete) {
  throw new Error(`Today OpenAPI completeness gate failed: ${JSON.stringify({
    counts,
    authorizedStores,
    failedStores: results.filter(row => !(row?.ok === true
      && row?.fetch?.ok === true
      && row?.load?.ok === true
      && Number(row?.load?.rowCounts?.daily || 0) === 1)).map(row => row?.storeKey),
  })}`);
}
NODE

PROMOTION_RESULT="$(
  sudo -n docker exec shein-warehouse-db psql -X -qAt -F '|' -v ON_ERROR_STOP=1 \
    -U shein -d shein_bi \
    -c "SELECT headers_written,items_written,payment_flags_written,daily_rows_refreshed FROM ops.promote_openapi_sales_slice(DATE '$DATE',DATE '$DATE')"
)"

# Current sales must become visible before the slower accounting/profit repair.
curl -fsS --max-time 60 "$PORTAL_URL/api/bi/section/liveSalesToday?refresh=1" >/dev/null
OCCURRED_AT="$(date -Is)"
PAYLOAD="{\"kind\":\"order\",\"businessDate\":\"$DATE\",\"occurredAt\":\"$OCCURRED_AT\",\"source\":\"today_openapi_reconcile\"}"
sudo -n docker exec shein-warehouse-db psql -X -qAt -v ON_ERROR_STOP=1 -U shein -d shein_bi \
  -c "SELECT pg_notify('shein_bi_live_update', '$PAYLOAD')" >/dev/null

REPORT_FILE="$REPORT_FILE" MARKER_FILE="$MARKER_FILE" DATE="$DATE" STAMP="$STAMP" \
PROMOTION_RESULT="$PROMOTION_RESULT" LOG_FILE="$LOG_FILE" node - <<'NODE'
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.env.REPORT_FILE, 'utf8'));
const payload = {
  ok: true,
  status: 'reconciled',
  stage: 'today-sales',
  businessDate: process.env.DATE,
  startedStamp: process.env.STAMP,
  completedAt: new Date().toISOString(),
  sourceMaxDate: process.env.DATE,
  storesSucceeded: report.counts?.succeeded || 0,
  storesPending: 0,
  promotionResult: process.env.PROMOTION_RESULT,
  reportFile: process.env.REPORT_FILE,
  logFile: process.env.LOG_FILE,
};
fs.writeFileSync(process.env.MARKER_FILE, `${JSON.stringify(payload, null, 2)}\n`);
NODE
cp -f "$MARKER_FILE" "$LATEST_FILE"
cat "$MARKER_FILE"
echo "[today-sales-reconcile] done date=$DATE marker=$MARKER_FILE"
