#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
PORTAL_URL="${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
RUN_DATE="$(TZ="$TZ_NAME" date +%F)"
STATE_FILE="${SHEIN_OPENAPI_STOCK_REFRESH_STATE_FILE:-$ROOT/state/openapi-probes/stock-refresh.latest.json}"
REPORT_FILE="${SHEIN_OPENAPI_PRODUCT_RECONCILE_LATEST_FILE:-$ROOT/state/openapi-probes/product-reconciliation.latest.json}"
STARTED_AT="$(date -Is)"

cd "$ROOT"

SHEIN_OPENAPI_PRODUCT_RECONCILE_SKIP_DETAILS=1 \
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
  '{
    ok: true,
    startedAt: $startedAt,
    generatedAt: $generatedAt,
    stores: 19,
    mode: "openapi-list-stock-cached-detail",
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
