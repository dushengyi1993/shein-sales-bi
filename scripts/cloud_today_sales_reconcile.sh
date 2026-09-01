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
    -c "SELECT changed,headers_added,headers_modified,headers_deleted,items_added,items_modified,items_deleted,payment_flags_added,payment_flags_modified,payment_flags_deleted,headers_written,items_written,payment_flags_written,daily_rows_refreshed FROM ops.promote_openapi_sales_slice_v2(DATE '$DATE',DATE '$DATE')"
)"

PROMOTION_FIELDS="$(
  PROMOTION_RESULT="$PROMOTION_RESULT" node - <<'NODE'
const raw = String(process.env.PROMOTION_RESULT ?? '').trim();
const fields = raw.split('|');
if (fields.length !== 14 || !['t', 'f'].includes(fields[0])) {
  throw new Error('invalid promotion result; expected changed plus thirteen fields: ' + JSON.stringify(raw));
}
const values = fields.slice(1).map(value => {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('invalid promotion count; expected a non-negative integer: ' + JSON.stringify(value));
  }
  return Number(value);
});
if (values.some(value => !Number.isSafeInteger(value) || value < 0)) {
  throw new Error('promotion result exceeds safe integer range: ' + JSON.stringify(raw));
}
const changed = fields[0] === 't';
const differences = values.slice(0, 9).reduce((sum, value) => sum + value, 0);
const written = values.slice(9, 12).reduce((sum, value) => sum + value, 0);
const daily = values[12];
if (!changed && (differences !== 0 || written !== 0 || daily !== 0)) {
  throw new Error('contradictory no-change promotion result: ' + JSON.stringify(raw));
}
// Delete-only replacement is valid: it can write zero source rows while the
// semantic diff and the 19-store daily refresh still prove a real promotion.
if (changed && (differences === 0 || daily === 0)) {
  throw new Error('contradictory changed promotion result: ' + JSON.stringify(raw));
}
process.stdout.write([changed ? '1' : '0', ...values].join('\t'));
NODE
)"
IFS=$'\t' read -r PROMOTION_CHANGED_FLAG HEADERS_ADDED HEADERS_MODIFIED HEADERS_DELETED \
  ITEMS_ADDED ITEMS_MODIFIED ITEMS_DELETED PAYMENT_FLAGS_ADDED PAYMENT_FLAGS_MODIFIED PAYMENT_FLAGS_DELETED \
  HEADERS_WRITTEN ITEMS_WRITTEN PAYMENT_FLAGS_WRITTEN DAILY_ROWS_REFRESHED <<< "$PROMOTION_FIELDS"

PROMOTION_CHANGED=false
NOTIFICATION_SENT=false
if [[ "$PROMOTION_CHANGED_FLAG" == 1 ]]; then
  # Current sales must become visible before the slower accounting/profit repair.
  curl -fsS --max-time 60 "$PORTAL_URL/api/bi/section/liveSalesToday?refresh=1" >/dev/null
  OCCURRED_AT="$(date -Is)"
  PAYLOAD="{\"kind\":\"order\",\"businessDate\":\"$DATE\",\"occurredAt\":\"$OCCURRED_AT\",\"source\":\"today_openapi_reconcile\"}"
  sudo -n docker exec shein-warehouse-db psql -X -qAt -v ON_ERROR_STOP=1 -U shein -d shein_bi \
    -c "SELECT pg_notify('shein_bi_live_update', '$PAYLOAD')" >/dev/null
  PROMOTION_CHANGED=true
  NOTIFICATION_SENT=true
  echo "[today-sales-reconcile] semantic promotion changed; daily_rows_refreshed=$DAILY_ROWS_REFRESHED; liveSalesToday refreshed and notification sent"
else
  echo "[today-sales-reconcile] no semantic change; skip liveSalesToday refresh and notification"
fi

REPORT_FILE="$REPORT_FILE" MARKER_FILE="$MARKER_FILE" DATE="$DATE" STAMP="$STAMP" \
  PROMOTION_RESULT="$PROMOTION_RESULT" HEADERS_WRITTEN="$HEADERS_WRITTEN" ITEMS_WRITTEN="$ITEMS_WRITTEN" \
  PAYMENT_FLAGS_WRITTEN="$PAYMENT_FLAGS_WRITTEN" DAILY_ROWS_REFRESHED="$DAILY_ROWS_REFRESHED" \
  HEADERS_ADDED="$HEADERS_ADDED" HEADERS_MODIFIED="$HEADERS_MODIFIED" HEADERS_DELETED="$HEADERS_DELETED" \
  ITEMS_ADDED="$ITEMS_ADDED" ITEMS_MODIFIED="$ITEMS_MODIFIED" ITEMS_DELETED="$ITEMS_DELETED" \
  PAYMENT_FLAGS_ADDED="$PAYMENT_FLAGS_ADDED" PAYMENT_FLAGS_MODIFIED="$PAYMENT_FLAGS_MODIFIED" PAYMENT_FLAGS_DELETED="$PAYMENT_FLAGS_DELETED" \
  PROMOTION_CHANGED="$PROMOTION_CHANGED" NOTIFICATION_SENT="$NOTIFICATION_SENT" LOG_FILE="$LOG_FILE" node - <<'NODE'
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.env.REPORT_FILE, 'utf8'));
const nonNegativeInteger = name => {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid marker count ' + name);
  return value;
};
const promotionChanged = process.env.PROMOTION_CHANGED === 'true';
const notificationSent = process.env.NOTIFICATION_SENT === 'true';
const diffNames = [
  'HEADERS_ADDED', 'HEADERS_MODIFIED', 'HEADERS_DELETED',
  'ITEMS_ADDED', 'ITEMS_MODIFIED', 'ITEMS_DELETED',
  'PAYMENT_FLAGS_ADDED', 'PAYMENT_FLAGS_MODIFIED', 'PAYMENT_FLAGS_DELETED',
];
const differenceTotal = diffNames.reduce((sum, name) => sum + nonNegativeInteger(name), 0);
if (promotionChanged !== (differenceTotal > 0)) {
  throw new Error('promotionChanged must exactly follow explicit semantic changed');
}
if (notificationSent !== promotionChanged) {
  throw new Error('notificationSent must exactly follow a real promotion');
}
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
  promotionCounts: {
    headersAdded: nonNegativeInteger('HEADERS_ADDED'),
    headersModified: nonNegativeInteger('HEADERS_MODIFIED'),
    headersDeleted: nonNegativeInteger('HEADERS_DELETED'),
    itemsAdded: nonNegativeInteger('ITEMS_ADDED'),
    itemsModified: nonNegativeInteger('ITEMS_MODIFIED'),
    itemsDeleted: nonNegativeInteger('ITEMS_DELETED'),
    paymentFlagsAdded: nonNegativeInteger('PAYMENT_FLAGS_ADDED'),
    paymentFlagsModified: nonNegativeInteger('PAYMENT_FLAGS_MODIFIED'),
    paymentFlagsDeleted: nonNegativeInteger('PAYMENT_FLAGS_DELETED'),
    headersWritten: nonNegativeInteger('HEADERS_WRITTEN'),
    itemsWritten: nonNegativeInteger('ITEMS_WRITTEN'),
    paymentFlagsWritten: nonNegativeInteger('PAYMENT_FLAGS_WRITTEN'),
    dailyRowsRefreshed: nonNegativeInteger('DAILY_ROWS_REFRESHED'),
  },
  promotionChanged,
  notificationSent,
  reportFile: process.env.REPORT_FILE,
  logFile: process.env.LOG_FILE,
};
fs.writeFileSync(process.env.MARKER_FILE, `${JSON.stringify(payload, null, 2)}\n`);
NODE
cp -f "$MARKER_FILE" "$LATEST_FILE"
cat "$MARKER_FILE"
echo "[today-sales-reconcile] done date=$DATE marker=$MARKER_FILE"
