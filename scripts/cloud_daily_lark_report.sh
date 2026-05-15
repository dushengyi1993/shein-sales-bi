#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TARGET="${1:-today}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_LARK_REPORT_LOG_DIR:-/srv/shein-bi/logs/cloud-lark-report}"
LOCK_FILE="${SHEIN_LARK_REPORT_LOCK_FILE:-/tmp/shein-bi-cloud-daily-lark-report.lock}"
SENT_DIR="${SHEIN_LARK_REPORT_SENT_DIR:-$ROOT/state/cloud_daily_report_sent}"

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
      echo "Unsupported daily report date target: $target" >&2
      exit 64
      ;;
  esac
}

mkdir -p "$LOG_DIR" "$SENT_DIR"
DATE="$(resolve_date "$TARGET")"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/daily-lark-report-${DATE}-${STAMP}.log"
SENT_FLAG="$SENT_DIR/${DATE}.sent"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[cloud_daily_lark_report] another report run is active; skip"
  exit 0
fi

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[cloud_daily_lark_report] start date=$DATE root=$ROOT"
cd "$ROOT"

if [[ -f "$SENT_FLAG" && "${SHEIN_LARK_REPORT_FORCE:-0}" != "1" ]]; then
  echo "[cloud_daily_lark_report] already sent for date=$DATE flag=$SENT_FLAG"
  exit 0
fi

if ! command -v lark-cli >/dev/null 2>&1; then
  echo "lark-cli is not installed or not in PATH on cloud server." >&2
  exit 69
fi

if [[ ! -f config/lark_report.json ]]; then
  echo "Missing config/lark_report.json on cloud server. This local secret config is not stored in GitHub." >&2
  exit 69
fi

export SHEIN_SALES_TRANSPORT="${SHEIN_SALES_TRANSPORT:-webapi}"
export SHEIN_REPORT_SYNC_NO_LAUNCH="${SHEIN_REPORT_SYNC_NO_LAUNCH:-1}"
export SHEIN_FEISHU_BASE_PAUSED="${SHEIN_FEISHU_BASE_PAUSED:-1}"

node scripts/send_daily_lark_report.mjs \
  --date "$DATE" \
  --sync-today \
  --send \
  --visual \
  --no-monthly-visual

printf 'sent_at=%s\nlog=%s\n' "$(TZ="$TZ_NAME" date --iso-8601=seconds)" "$LOG_FILE" > "$SENT_FLAG"
echo "[cloud_daily_lark_report] done date=$DATE log=$LOG_FILE"
