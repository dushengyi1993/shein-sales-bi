#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TARGET="${1:-today}"
MODE="${2:-intraday}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_BI_LOG_DIR:-/srv/shein-bi/logs/cloud-refresh}"
METABASE_URL="${METABASE_URL:-http://127.0.0.1:3000}"
PORTAL_HEALTH_URL="${PORTAL_HEALTH_URL:-}"
PORTAL_INDEX_PATH="${PORTAL_INDEX_PATH:-$ROOT/outputs/bi-portal/index.html}"
PORTAL_DATA_PATH="${PORTAL_DATA_PATH:-$ROOT/outputs/bi-portal/data.json}"

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

check_portal_health() {
  if [[ ! -s "$PORTAL_INDEX_PATH" ]]; then
    echo "BI Portal index is missing or empty: $PORTAL_INDEX_PATH" >&2
    exit 1
  fi
  if [[ ! -s "$PORTAL_DATA_PATH" ]]; then
    echo "BI Portal data is missing or empty: $PORTAL_DATA_PATH" >&2
    exit 1
  fi
  if [[ -n "$PORTAL_HEALTH_URL" ]]; then
    curl -fsS --max-time 15 "$PORTAL_HEALTH_URL" >/dev/null
  else
    echo "[cloud_bi_refresh] portal files ok index=$PORTAL_INDEX_PATH data=$PORTAL_DATA_PATH"
  fi
}

DATE="$(resolve_date "$TARGET")"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${MODE}-${DATE}-${STAMP}.log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[cloud_bi_refresh] start target=$TARGET date=$DATE mode=$MODE root=$ROOT"
cd "$ROOT"

export SHEIN_SALES_TRANSPORT="${SHEIN_SALES_TRANSPORT:-webapi}"
export SHEIN_BI_PORTAL_TIMEOUT_MS="${SHEIN_BI_PORTAL_TIMEOUT_MS:-1800000}"

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

set +e
node scripts/audit_bi_warehouse.mjs
AUDIT_STATUS=$?
set -e
if [[ "$AUDIT_STATUS" -ne 0 ]]; then
  echo "[cloud_bi_refresh] BI audit finished with status=$AUDIT_STATUS; continue portal generation so the page can show the audit result"
fi

node scripts/generate_bi_portal.mjs \
  --metabase-url "$METABASE_URL"

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet shein-bi-portal.service || systemctl start shein-bi-portal.service || true
fi

check_portal_health

echo "[cloud_bi_refresh] done date=$DATE mode=$MODE log=$LOG_FILE"
