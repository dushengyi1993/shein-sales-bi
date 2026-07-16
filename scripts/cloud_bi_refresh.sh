#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
source "$ROOT/scripts/lib/shared_lock.sh"
TARGET="${1:-today}"
MODE="${2:-intraday}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_BI_LOG_DIR:-/srv/shein-bi/logs/cloud-refresh}"
METABASE_URL="${METABASE_URL:-http://127.0.0.1:3000}"
PORTAL_HEALTH_URL="${PORTAL_HEALTH_URL:-}"
PORTAL_INDEX_PATH="${PORTAL_INDEX_PATH:-$ROOT/outputs/bi-portal/index.html}"
PORTAL_DATA_PATH="${PORTAL_DATA_PATH:-$ROOT/outputs/bi-portal/data.json}"
LOCK_FILE="${SHEIN_BI_REFRESH_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-sales-refresh.lock}"
PORTAL_REFRESH_LOCK_FILE="${SHEIN_BI_PORTAL_REFRESH_LOCK_FILE:-$ROOT/state/locks/shein-bi-portal-refresh.lock}"
PORTAL_REFRESH_LOCK_WAIT_SEC="${SHEIN_BI_PORTAL_REFRESH_LOCK_WAIT_SEC:-1800}"

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

prepare_shared_lock_file "$LOCK_FILE"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[cloud_bi_refresh] another sales refresh is running; skip target=$TARGET date=$DATE mode=$MODE"
  exit "${SHEIN_BI_REFRESH_BUSY_EXIT_CODE:-0}"
fi

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[cloud_bi_refresh] start target=$TARGET date=$DATE mode=$MODE root=$ROOT"
cd "$ROOT"

export SHEIN_SALES_TRANSPORT="${SHEIN_SALES_TRANSPORT:-webapi}"
export SHEIN_BI_PORTAL_TIMEOUT_MS="${SHEIN_BI_PORTAL_TIMEOUT_MS:-1800000}"
export SHEIN_BI_PORTAL_DATA_MODE="${SHEIN_BI_PORTAL_DATA_MODE:-api}"

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

# 高频销售刷新只使用已经补采好的慢变数据快照；不要在两小时销售
# 任务里顺手打开 SHEIN 后台扫描活动价，否则会拖慢当天经营数据刷新。
# 慢变补采统一由 cloud_daily_refresh.sh 调度。
node scripts/marketing/export_marketing_price_leads_for_bi.mjs || true

prepare_shared_lock_file "$PORTAL_REFRESH_LOCK_FILE"
{
  if ! flock -w "$PORTAL_REFRESH_LOCK_WAIT_SEC" 8; then
    echo "[cloud_bi_refresh] portal refresh lock busy after ${PORTAL_REFRESH_LOCK_WAIT_SEC}s; skip portal generation/prewarm this run"
  else
    set +e
    node scripts/audit_bi_warehouse.mjs
    AUDIT_STATUS=$?
    set -e
    if [[ "$AUDIT_STATUS" -ne 0 ]]; then
      echo "[cloud_bi_refresh] BI audit finished with status=$AUDIT_STATUS; continue portal generation so the page can show the audit result"
    fi

    # V2 production is a lightweight shell + on-demand section API. Refresh
    # only the small API core data.json here so watchdog/data status sees the
    # latest sales run; do not run the legacy all-in-one portal SQL.
    node scripts/generate_bi_portal.mjs \
      --metabase-url "$METABASE_URL" \
      --data-mode "$SHEIN_BI_PORTAL_DATA_MODE"
    node scripts/generate_bi_portal_shell.mjs

    if command -v systemctl >/dev/null 2>&1; then
      systemctl is-active --quiet shein-bi-portal.service || systemctl start shein-bi-portal.service || true
    fi

    if [[ "$SHEIN_BI_PORTAL_DATA_MODE" == "api" && "${SHEIN_BI_PORTAL_PREWARM_DISABLED:-0}" != "1" ]]; then
      nohup bash scripts/prewarm_bi_portal_sections.sh 8>&- 9>&- >/dev/null 2>&1 &
      echo "[cloud_bi_refresh] portal section prewarm started pid=$!"
    fi
  fi
} 8>>"$PORTAL_REFRESH_LOCK_FILE"

check_portal_health

echo "[cloud_bi_refresh] done date=$DATE mode=$MODE log=$LOG_FILE"
