#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TARGET="${1:-yesterday}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_OPENAPI_LOG_DIR:-/srv/shein-bi/logs/cloud-openapi-reconciliation}"
METABASE_URL="${METABASE_URL:-http://127.0.0.1:3000}"
DEFAULT_STORES="CX,DL,DX,FY,HL,JSH,JY,LQ,MZ,NM,QH,QY,TS,TZ,TZZ,XC,XL,YJ,ZL"
STORES_CSV="${SHEIN_OPENAPI_RECONCILE_STORES:-$DEFAULT_STORES}"
CONCURRENCY="${SHEIN_OPENAPI_RECONCILE_CONCURRENCY:-3}"
REFRESH_PORTAL="${SHEIN_OPENAPI_RECONCILE_REFRESH_PORTAL:-0}"

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
      echo "Unsupported OpenAPI reconciliation date target: $target" >&2
      exit 64
      ;;
  esac
}

DATE="$(resolve_date "$TARGET")"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/openapi-reconcile-${DATE}-${STAMP}.log"
REPORT_FILE="$LOG_DIR/openapi-reconcile-${DATE}-${STAMP}.summary.json"
LATEST_REPORT_FILE="${SHEIN_OPENAPI_RECONCILE_LATEST_FILE:-$ROOT/state/openapi-probes/sales-reconciliation.latest.json}"

exec > >(tee -a "$LOG_FILE") 2>&1

cd "$ROOT"
echo "[cloud_openapi_reconciliation] start date=$DATE stores=$STORES_CSV concurrency=$CONCURRENCY root=$ROOT"

if [[ ! -s config/shein_openapi.local.json ]]; then
  echo "Missing config/shein_openapi.local.json on cloud server. This secret config is not stored in GitHub." >&2
  exit 69
fi

set +e
node scripts/run_shein_openapi_sales_reconciliation.mjs \
  --date "$DATE" \
  --stores "$STORES_CSV" \
  --concurrency "$CONCURRENCY" \
  --out "$REPORT_FILE"
RUN_CODE=$?
set -e
mkdir -p "$(dirname "$LATEST_REPORT_FILE")"
if [[ -s "$REPORT_FILE" ]]; then
  cp -f "$REPORT_FILE" "$LATEST_REPORT_FILE"
fi
echo "[cloud_openapi_reconciliation] summary=$REPORT_FILE"
echo "[cloud_openapi_reconciliation] latest=$LATEST_REPORT_FILE"
cat "$REPORT_FILE" || true

if [[ "$REFRESH_PORTAL" == "1" || "$REFRESH_PORTAL" == "true" ]]; then
  echo "[cloud_openapi_reconciliation] refresh portal"
  export SHEIN_BI_PORTAL_TIMEOUT_MS="${SHEIN_BI_PORTAL_TIMEOUT_MS:-1800000}"
  export SHEIN_BI_PORTAL_DATA_MODE="${SHEIN_BI_PORTAL_DATA_MODE:-api}"
  node scripts/generate_bi_portal.mjs --metabase-url "$METABASE_URL"
  node scripts/generate_bi_portal_shell.mjs
  if command -v systemctl >/dev/null 2>&1; then
    systemctl is-active --quiet shein-bi-portal.service || systemctl start shein-bi-portal.service || true
  fi
fi

echo "[cloud_openapi_reconciliation] done date=$DATE exit=$RUN_CODE log=$LOG_FILE"
exit "$RUN_CODE"
