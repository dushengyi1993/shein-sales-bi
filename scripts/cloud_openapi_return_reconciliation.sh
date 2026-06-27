#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TARGET="${1:-yesterday}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_OPENAPI_RETURN_LOG_DIR:-/srv/shein-bi/logs/cloud-openapi-return-reconciliation}"
DEFAULT_STORES="CX,DL,DX,FY,HL,JSH,JY,LQ,MZ,NM,QH,QY,TS,TZ,TZZ,XC,XL,YJ,ZL"
STORES_CSV="${SHEIN_OPENAPI_RETURN_RECONCILE_STORES:-${SHEIN_OPENAPI_RECONCILE_STORES:-$DEFAULT_STORES}}"
CONCURRENCY="${SHEIN_OPENAPI_RETURN_RECONCILE_CONCURRENCY:-${SHEIN_OPENAPI_RECONCILE_CONCURRENCY:-3}}"
WINDOW_DAYS="${SHEIN_OPENAPI_RETURN_RECONCILE_WINDOW_DAYS:-14}"

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
      echo "Unsupported OpenAPI return reconciliation date target: $target" >&2
      exit 64
      ;;
  esac
}

DATE="$(resolve_date "$TARGET")"
if [[ "$WINDOW_DAYS" =~ ^[0-9]+$ ]] && [[ "$WINDOW_DAYS" -gt 1 ]]; then
  START_DATE="$(TZ="$TZ_NAME" date -d "$DATE -$((WINDOW_DAYS - 1)) days" +%F)"
else
  START_DATE="$DATE"
fi
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/openapi-return-reconcile-${DATE}-${STAMP}.log"
REPORT_FILE="$LOG_DIR/openapi-return-reconcile-${DATE}-${STAMP}.summary.json"
LATEST_REPORT_FILE="${SHEIN_OPENAPI_RETURN_RECONCILE_LATEST_FILE:-$ROOT/state/openapi-probes/return-reconciliation.latest.json}"

exec > >(tee -a "$LOG_FILE") 2>&1

cd "$ROOT"
echo "[cloud_openapi_return_reconciliation] start range=$START_DATE..$DATE stores=$STORES_CSV concurrency=$CONCURRENCY root=$ROOT"

if [[ ! -s config/shein_openapi.local.json ]]; then
  echo "Missing config/shein_openapi.local.json on cloud server. This secret config is not stored in GitHub." >&2
  exit 69
fi

set +e
node scripts/run_shein_openapi_returns_reconciliation.mjs \
  --start "$START_DATE" \
  --end "$DATE" \
  --stores "$STORES_CSV" \
  --concurrency "$CONCURRENCY" \
  --out "$REPORT_FILE"
RUN_CODE=$?
set -e
mkdir -p "$(dirname "$LATEST_REPORT_FILE")"
if [[ -s "$REPORT_FILE" ]]; then
  cp -f "$REPORT_FILE" "$LATEST_REPORT_FILE"
fi
echo "[cloud_openapi_return_reconciliation] summary=$REPORT_FILE"
echo "[cloud_openapi_return_reconciliation] latest=$LATEST_REPORT_FILE"
cat "$REPORT_FILE" || true

echo "[cloud_openapi_return_reconciliation] done date=$DATE exit=$RUN_CODE log=$LOG_FILE"
exit "$RUN_CODE"
