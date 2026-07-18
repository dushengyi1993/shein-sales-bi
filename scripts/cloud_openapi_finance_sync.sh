#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TARGET="${1:-yesterday}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
WINDOW_DAYS="${SHEIN_OPENAPI_FINANCE_WINDOW_DAYS:-35}"
CONCURRENCY="${SHEIN_OPENAPI_FINANCE_CONCURRENCY:-3}"
DEFAULT_STORES="CX,DL,DX,FY,HL,JSH,JY,LQ,MZ,NM,QH,QY,TS,TZ,TZZ,XC,XL,YJ,ZL"
STORES="${SHEIN_OPENAPI_FINANCE_STORES:-$DEFAULT_STORES}"
LOG_DIR="${SHEIN_OPENAPI_FINANCE_LOG_DIR:-/srv/shein-bi/logs/cloud-openapi-finance-sync}"
STATE_DIR="${SHEIN_OPENAPI_FINANCE_STATE_DIR:-$ROOT/state/openapi-finance}"

case "$TARGET" in
  today) END_DATE="$(TZ="$TZ_NAME" date +%F)" ;;
  yesterday) END_DATE="$(TZ="$TZ_NAME" date -d yesterday +%F)" ;;
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) END_DATE="$TARGET" ;;
  *) echo "Unsupported finance sync target: $TARGET" >&2; exit 64 ;;
esac
START_DATE="$(TZ="$TZ_NAME" date -d "$END_DATE -$((WINDOW_DAYS - 1)) days" +%F)"
RUN_ID="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)-$$"
RUN_DIR="$STATE_DIR/runs/$RUN_ID"
LOG_FILE="$LOG_DIR/finance-sync-${START_DATE}-${END_DATE}-${RUN_ID}.log"
REPORT_FILE="$RUN_DIR/report.json"

mkdir -p "$LOG_DIR" "$RUN_DIR"
exec > >(tee -a "$LOG_FILE") 2>&1
cd "$ROOT"

echo "[cloud_openapi_finance_sync] start runId=$RUN_ID range=$START_DATE..$END_DATE stores=$STORES"
if [[ ! -s config/shein_openapi.local.json ]]; then
  echo "Missing config/shein_openapi.local.json" >&2
  exit 69
fi

set +e
node scripts/run_shein_openapi_finance_sync.mjs \
  --start "$START_DATE" \
  --end "$END_DATE" \
  --stores "$STORES" \
  --concurrency "$CONCURRENCY" \
  --out "$REPORT_FILE"
STATUS=$?
set -e

if [[ -s "$REPORT_FILE" ]]; then
  mkdir -p "$STATE_DIR"
  cp -f "$REPORT_FILE" "$STATE_DIR/latest.json"
fi
echo "[cloud_openapi_finance_sync] done runId=$RUN_ID status=$STATUS report=$REPORT_FILE log=$LOG_FILE"
exit "$STATUS"
