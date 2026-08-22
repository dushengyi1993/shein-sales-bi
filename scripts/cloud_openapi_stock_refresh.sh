#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
PORTAL_URL="${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
RUN_DATE="${SHEIN_OPENAPI_STOCK_REFRESH_RUN_DATE:-$(TZ="$TZ_NAME" date +%F)}"
STATE_FILE="${SHEIN_OPENAPI_STOCK_REFRESH_STATE_FILE:-$ROOT/state/openapi-probes/stock-refresh.latest.json}"
REPORT_FILE="${SHEIN_OPENAPI_PRODUCT_RECONCILE_LATEST_FILE:-$ROOT/state/openapi-probes/product-reconciliation.latest.json}"
STARTED_AT="$(date -Is)"
DETAIL_MODE="${SHEIN_OPENAPI_STOCK_REFRESH_DETAILS_MODE:-auto}"
DETAIL_BUDGET="${SHEIN_OPENAPI_STOCK_REFRESH_DETAIL_BUDGET:-32}"
DETAIL_REFRESH_CLOCK="${SHEIN_OPENAPI_STOCK_REFRESH_DETAIL_CLOCK:-07:18}"
CURRENT_CLOCK="$(TZ="$TZ_NAME" date +%H:%M)"

if [[ ! "$RUN_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
  || [[ "$(TZ="$TZ_NAME" date -d "$RUN_DATE" +%F 2>/dev/null || true)" != "$RUN_DATE" ]]; then
  echo "Invalid SHEIN_OPENAPI_STOCK_REFRESH_RUN_DATE=$RUN_DATE" >&2
  exit 65
fi
if [[ -n "${SHEIN_BI_MORNING_RUN_DATE:-}" && "$RUN_DATE" != "$SHEIN_BI_MORNING_RUN_DATE" ]]; then
  echo "stock refresh runDate drift: injected=$RUN_DATE coordinator=$SHEIN_BI_MORNING_RUN_DATE" >&2
  exit 65
fi

cd "$ROOT"

case "$DETAIL_MODE" in
  full)
    SKIP_DETAILS=0
    ;;
  skip)
    SKIP_DETAILS=1
    ;;
  auto)
    if [[ "$CURRENT_CLOCK" == "$DETAIL_REFRESH_CLOCK" ]]; then
      SKIP_DETAILS=0
    else
      SKIP_DETAILS=1
    fi
    ;;
  *)
    echo "Invalid SHEIN_OPENAPI_STOCK_REFRESH_DETAILS_MODE=$DETAIL_MODE; expected auto, full or skip" >&2
    exit 64
    ;;
esac
[[ "$DETAIL_BUDGET" =~ ^[1-9][0-9]*$ ]] || {
  echo "Invalid SHEIN_OPENAPI_STOCK_REFRESH_DETAIL_BUDGET=$DETAIL_BUDGET" >&2
  exit 64
}
if [[ "$SKIP_DETAILS" == "0" ]]; then
  REFRESH_MODE="openapi-list-stock-bounded-detail"
else
  REFRESH_MODE="openapi-list-stock-cached-detail"
fi
echo "[cloud_openapi_stock_refresh] detailMode=$DETAIL_MODE currentClock=$CURRENT_CLOCK detailClock=$DETAIL_REFRESH_CLOCK skipDetails=$SKIP_DETAILS detailBudget=$DETAIL_BUDGET"

SHEIN_OPENAPI_PRODUCT_RECONCILE_SKIP_DETAILS="$SKIP_DETAILS" \
SHEIN_OPENAPI_PRODUCT_RECONCILE_MAX_DETAILS="$DETAIL_BUDGET" \
SHEIN_OPENAPI_PRODUCT_RECONCILE_SKIP_STOCK=0 \
SHEIN_OPENAPI_PRODUCT_RECONCILE_CONCURRENCY="${SHEIN_OPENAPI_STOCK_REFRESH_CONCURRENCY:-4}" \
SHEIN_OPENAPI_PRODUCT_KEEP_SNAPSHOTS=1 \
  bash scripts/cloud_openapi_product_reconciliation.sh

jq -e '
  .ok == true
  and .reportScope.complete == true
  and .counts.total == 19
  and .counts.succeeded == 19
  and .counts.stockMissing == 0
' "$REPORT_FILE" >/dev/null

curl -fsS --max-time "${SHEIN_OPENAPI_STOCK_PORTAL_REFRESH_TIMEOUT_SECONDS:-600}" \
  "$PORTAL_URL/api/bi/section/inventoryStock?refresh=1" >/dev/null

STOCK_FILE="$ROOT/outputs/bi-portal/sections/inventoryStock.json"
jq -e '
  (.data.inventoryStock // []) | any(
    .fetched_at != null
    and .shelf_status_code != null
  )
' "$STOCK_FILE" >/dev/null

OCCURRED_AT="$(date -Is)"
PAYLOAD="{\"kind\":\"inventory_refresh\",\"occurredAt\":\"$OCCURRED_AT\"}"
sudo -n docker exec shein-warehouse-db sh -lc \
  "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -Atc \"SELECT pg_notify('shein_bi_live_update', '$PAYLOAD');\"" \
  >/dev/null

mkdir -p "$(dirname "$STATE_FILE")"
TMP_FILE="${STATE_FILE}.${BASHPID}.tmp"
jq -n \
  --arg startedAt "$STARTED_AT" \
  --arg generatedAt "$OCCURRED_AT" \
  --arg reportFile "$REPORT_FILE" \
  --arg stockFile "$STOCK_FILE" \
  --arg mode "$REFRESH_MODE" \
  --arg runDate "$RUN_DATE" \
  '{
    ok: true,
    startedAt: $startedAt,
    generatedAt: $generatedAt,
    stores: 19,
    mode: $mode,
    runDate: $runDate,
    reportFile: $reportFile,
    stockFile: $stockFile
  }' > "$TMP_FILE"
mv -f "$TMP_FILE" "$STATE_FILE"
node "$ROOT/scripts/pipeline_marker.mjs" write \
  --stage stock-refresh \
  --date "$RUN_DATE" \
  --business-date "$RUN_DATE" \
  --status done \
  --message "19-store OpenAPI virtual stock refreshed" \
  --evidence "$STATE_FILE" \
  --evidence "$REPORT_FILE" \
  >/dev/null
cat "$STATE_FILE"
