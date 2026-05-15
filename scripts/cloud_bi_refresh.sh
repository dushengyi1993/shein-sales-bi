#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TARGET="${1:-today}"
MODE="${2:-intraday}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_BI_LOG_DIR:-/srv/shein-bi/logs/cloud-refresh}"
METABASE_URL="${METABASE_URL:-http://127.0.0.1:3000}"
PORTAL_HEALTH_URL="${PORTAL_HEALTH_URL:-http://127.0.0.1:8787/api/health}"

resolve_date() {
  local target="$1"
  case "$target" in
    today)
      TZ="$TZ_NAME" date +%F
      ;;
    yesterday)
      TZ="$TZ_NAME" date -d 'yesterday' +%F
      ;;
    2daysago|two-days-ago|third-day-stable-recheck)
      TZ="$TZ_NAME" date -d '2 days ago' +%F
      ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
      printf '%s\n' "$target"
      ;;
    *)
      echo "Unsupported date target: $target" >&2
      exit 64
      ;;
  esac
}

DATE="$(resolve_date "$TARGET")"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${MODE}-${DATE}-${STAMP}.log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[cloud_bi_refresh] start target=$TARGET date=$DATE mode=$MODE root=$ROOT"
cd "$ROOT"

export SHEIN_SALES_TRANSPORT="${SHEIN_SALES_TRANSPORT:-webapi}"
export SHEIN_BI_PORTAL_TIMEOUT_MS="${SHEIN_BI_PORTAL_TIMEOUT_MS:-900000}"

node scripts/run_sales_sync_job.mjs \
  --date "$DATE" \
  --group ALL \
  --skip-lark-base \
  --store-attempts "${SHEIN_STORE_ATTEMPTS:-1}" \
  --no-launch \
  --no-products \
  --no-monthly \
  --no-compact \
  --no-dashboard \
  --status "cloud-${MODE}"

node scripts/load_bi_warehouse.mjs \
  --sales-date "$DATE" \
  --skip-links \
  --skip-dashboard

node scripts/generate_bi_portal.mjs \
  --metabase-url "$METABASE_URL"

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet shein-bi-portal.service || systemctl start shein-bi-portal.service || true
fi

curl -fsS --max-time 15 "$PORTAL_HEALTH_URL" >/dev/null

echo "[cloud_bi_refresh] done date=$DATE mode=$MODE log=$LOG_FILE"
