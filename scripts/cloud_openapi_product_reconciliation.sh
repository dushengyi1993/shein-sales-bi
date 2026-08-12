#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_OPENAPI_PRODUCT_LOG_DIR:-/srv/shein-bi/logs/cloud-openapi-product-reconciliation}"
DEFAULT_STORES="CX,DL,DX,FY,HL,JSH,JY,LQ,MZ,NM,QH,QY,TS,TZ,TZZ,XC,XL,YJ,ZL"
STORES_CSV="${SHEIN_OPENAPI_PRODUCT_RECONCILE_STORES:-${SHEIN_OPENAPI_RECONCILE_STORES:-$DEFAULT_STORES}}"
CONCURRENCY="${SHEIN_OPENAPI_PRODUCT_RECONCILE_CONCURRENCY:-2}"
FETCH_TIMEOUT_MS="${SHEIN_OPENAPI_PRODUCT_RECONCILE_FETCH_TIMEOUT_MS:-1800000}"
LOAD_TIMEOUT_MS="${SHEIN_OPENAPI_PRODUCT_RECONCILE_LOAD_TIMEOUT_MS:-600000}"
MAX_DETAILS="${SHEIN_OPENAPI_PRODUCT_RECONCILE_MAX_DETAILS:-0}"
SKIP_DETAILS="${SHEIN_OPENAPI_PRODUCT_RECONCILE_SKIP_DETAILS:-0}"
SKIP_STOCK="${SHEIN_OPENAPI_PRODUCT_RECONCILE_SKIP_STOCK:-0}"
DETAIL_PRIORITY_FILE="${SHEIN_OPENAPI_PRODUCT_RECONCILE_DETAIL_PRIORITY_FILE:-}"
PRIORITY_DETAILS_ONLY="${SHEIN_OPENAPI_PRODUCT_RECONCILE_PRIORITY_DETAILS_ONLY:-0}"
KEEP_SNAPSHOTS="${SHEIN_OPENAPI_PRODUCT_KEEP_SNAPSHOTS:-2}"
LOCK_FILE="${SHEIN_OPENAPI_PRODUCT_RECONCILE_LOCK_FILE:-$ROOT/state/locks/openapi-product-reconciliation.lock}"

STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/openapi-product-reconcile-${STAMP}.log"
REPORT_FILE="$LOG_DIR/openapi-product-reconcile-${STAMP}.summary.json"
LATEST_REPORT_FILE="${SHEIN_OPENAPI_PRODUCT_RECONCILE_LATEST_FILE:-$ROOT/state/openapi-probes/product-reconciliation.latest.json}"

exec > >(tee -a "$LOG_FILE") 2>&1

cd "$ROOT"
. "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$LOCK_FILE"
exec 9>"$LOCK_FILE"
if ! flock -w 900 9; then
  echo "Timed out waiting for OpenAPI product reconciliation lock: $LOCK_FILE" >&2
  exit 75
fi
echo "[cloud_openapi_product_reconciliation] start stores=$STORES_CSV concurrency=$CONCURRENCY maxDetails=$MAX_DETAILS root=$ROOT"

if [[ ! -s config/shein_openapi.local.json ]]; then
  echo "Missing config/shein_openapi.local.json on cloud server. This secret config is not stored in GitHub." >&2
  exit 69
fi

ARGS=(
  --stores "$STORES_CSV"
  --concurrency "$CONCURRENCY"
  --fetch-timeout-ms "$FETCH_TIMEOUT_MS"
  --load-timeout-ms "$LOAD_TIMEOUT_MS"
  --out "$REPORT_FILE"
  --latest-out "$LATEST_REPORT_FILE"
)
export SHEIN_OPENAPI_PRODUCT_KEEP_SNAPSHOTS="$KEEP_SNAPSHOTS"

if [[ "$MAX_DETAILS" =~ ^[0-9]+$ ]] && [[ "$MAX_DETAILS" -gt 0 ]]; then
  ARGS+=(--max-details "$MAX_DETAILS")
fi
if [[ "$SKIP_DETAILS" == "1" || "$SKIP_DETAILS" == "true" ]]; then
  ARGS+=(--skip-details)
fi
if [[ "$SKIP_STOCK" == "1" || "$SKIP_STOCK" == "true" ]]; then
  ARGS+=(--skip-stock)
fi
if [[ -n "$DETAIL_PRIORITY_FILE" ]]; then
  ARGS+=(--detail-priority-file "$DETAIL_PRIORITY_FILE")
fi
if [[ "$PRIORITY_DETAILS_ONLY" == "1" || "$PRIORITY_DETAILS_ONLY" == "true" ]]; then
  ARGS+=(--priority-details-only)
fi

set +e
node scripts/run_shein_openapi_products_reconciliation.mjs "${ARGS[@]}"
RUN_CODE=$?
set -e

echo "[cloud_openapi_product_reconciliation] summary=$REPORT_FILE"
echo "[cloud_openapi_product_reconciliation] latest=$LATEST_REPORT_FILE"
cat "$REPORT_FILE" || true

echo "[cloud_openapi_product_reconciliation] done exit=$RUN_CODE log=$LOG_FILE"
exit "$RUN_CODE"
