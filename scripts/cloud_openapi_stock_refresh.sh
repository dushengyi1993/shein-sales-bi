#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
PORTAL_URL="${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}"
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
  "$PORTAL_URL/api/bi/section/linksData?refresh=1" >/dev/null

LINKS_FILE="$ROOT/outputs/bi-portal/sections/linksData.json"
jq -e '
  (.data.storeLinks // []) | any(
    .openapi_inventory_fetched_at != null
    and .openapi_inventory_shelf_status_code != null
  )
' "$LINKS_FILE" >/dev/null

OCCURRED_AT="$(date -Is)"
PAYLOAD="{\"kind\":\"inventory_refresh\",\"occurredAt\":\"$OCCURRED_AT\"}"
sudo -n docker exec shein-warehouse-db sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v payload="$1" -Atc "SELECT pg_notify('\''shein_bi_live_update'\'', :'\''payload'\'');"' \
  sh "$PAYLOAD" >/dev/null

mkdir -p "$(dirname "$STATE_FILE")"
TMP_FILE="${STATE_FILE}.${BASHPID}.tmp"
jq -n \
  --arg startedAt "$STARTED_AT" \
  --arg generatedAt "$OCCURRED_AT" \
  --arg reportFile "$REPORT_FILE" \
  --arg linksFile "$LINKS_FILE" \
  '{
    ok: true,
    startedAt: $startedAt,
    generatedAt: $generatedAt,
    stores: 19,
    mode: "openapi-list-stock-cached-detail",
    reportFile: $reportFile,
    linksFile: $linksFile
  }' > "$TMP_FILE"
mv -f "$TMP_FILE" "$STATE_FILE"
cat "$STATE_FILE"
