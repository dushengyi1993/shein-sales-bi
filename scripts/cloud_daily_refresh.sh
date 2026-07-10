#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
source "$ROOT/scripts/lib/shared_lock.sh"
TARGET="${1:-yesterday}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_BI_DAILY_LOG_DIR:-/srv/shein-bi/logs/cloud-daily-refresh}"
METABASE_URL="${METABASE_URL:-http://127.0.0.1:3000}"
PORTAL_HEALTH_URL="${PORTAL_HEALTH_URL:-}"
PORTAL_INDEX_PATH="${PORTAL_INDEX_PATH:-$ROOT/outputs/bi-portal/index.html}"
PORTAL_DATA_PATH="${PORTAL_DATA_PATH:-$ROOT/outputs/bi-portal/data.json}"
LOCK_FILE="${SHEIN_BI_DAILY_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-daily-refresh.lock}"
LARK_REPORT_LOCK_FILE="${SHEIN_LARK_REPORT_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-daily-lark-report.lock}"
LARK_REPORT_LOCK_WAIT_SEC="${SHEIN_BI_DAILY_WAIT_LARK_REPORT_LOCK_SEC:-3600}"
BUSY_WRITER_SERVICES="${SHEIN_BI_DAILY_WAIT_SERVICES:-shein-bi-cloud-today.service shein-bi-cloud-yesterday.service shein-bi-cloud-et-forwarder.service shein-bi-cloud-daily-lark-report.service}"
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
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
      printf '%s\n' "$target"
      ;;
    *)
      echo "Unsupported daily refresh date target: $target" >&2
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
    echo "[cloud_daily_refresh] portal files ok index=$PORTAL_INDEX_PATH data=$PORTAL_DATA_PATH"
  fi
}

close_store_browsers() {
  cd "$ROOT"
  node scripts/cleanup_shein_store_browsers.mjs --all --cleanup-chrome-tmp --kill-after-sec 5 || true
}

write_daily_alert() {
  local status="$1"
  local message="$2"
  mkdir -p "$ROOT/state/cloud_ops_alerts"
  cat > "$ROOT/state/cloud_ops_alerts/daily-refresh-last.json" <<JSON
{"date":"$DATE","generatedAt":"$(TZ="$TZ_NAME" date --iso-8601=seconds)","status":"$status","message":"$message","logFile":"$LOG_FILE"}
JSON
}

on_error() {
  local line="$1"
  local status="$2"
  set +e
  write_daily_alert "failed" "daily refresh aborted at line=$line exit=$status"
  echo "[cloud_daily_refresh] ERROR aborted at line=$line exit=$status log=$LOG_FILE" >&2
  exit "$status"
}

on_signal() {
  local signal="$1"
  local status=143
  case "$signal" in
    INT) status=130 ;;
    TERM) status=143 ;;
    HUP) status=129 ;;
  esac
  set +e
  write_daily_alert "interrupted" "daily refresh interrupted by signal=$signal; run did not complete"
  echo "[cloud_daily_refresh] INTERRUPTED signal=$signal log=$LOG_FILE" >&2
  close_store_browsers
  trap - EXIT ERR INT TERM HUP
  exit "$status"
}

is_service_active() {
  local service="$1"
  command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$service"
}

active_busy_writer_services() {
  local active=()
  local service
  for service in $BUSY_WRITER_SERVICES; do
    if is_service_active "$service"; then
      active+=("$service")
    fi
  done
  printf '%s\n' "${active[*]}"
}

wait_for_busy_writers() {
  local timeout="${SHEIN_BI_DAILY_WAIT_BUSY_TIMEOUT_SEC:-5400}"
  local interval="${SHEIN_BI_DAILY_WAIT_BUSY_INTERVAL_SEC:-30}"
  local elapsed=0
  local active
  while true; do
    active="$(active_busy_writer_services)"
    if [[ -z "$active" ]]; then
      return 0
    fi
    if (( elapsed >= timeout )); then
      write_daily_alert "skipped_busy" "daily refresh skipped because writer services are still active after ${timeout}s: $active"
      echo "[cloud_daily_refresh] SKIP busy writer still active after ${timeout}s: $active; skip this daily refresh to protect server capacity" >&2
      exit 0
    fi
    echo "[cloud_daily_refresh] wait busy writer services: $active elapsed=${elapsed}s"
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
}

wait_for_lark_report_lock() {
  if [[ -z "$LARK_REPORT_LOCK_FILE" ]]; then
    return 0
  fi
  prepare_shared_lock_file "$LARK_REPORT_LOCK_FILE"
  echo "[cloud_daily_refresh] wait for Lark daily report lock if active file=$LARK_REPORT_LOCK_FILE"
  exec 7>"$LARK_REPORT_LOCK_FILE"
  if ! flock -w "$LARK_REPORT_LOCK_WAIT_SEC" 7; then
    write_daily_alert "skipped_lark_report_busy" "daily refresh skipped because daily Lark report lock is still active after ${LARK_REPORT_LOCK_WAIT_SEC}s"
    echo "[cloud_daily_refresh] SKIP daily Lark report still active after ${LARK_REPORT_LOCK_WAIT_SEC}s; run daily refresh after report completes" >&2
    exit 0
  fi
  echo "[cloud_daily_refresh] Lark daily report lock is clear"
}

available_mem_mib() {
  awk '/MemAvailable:/ { printf "%d\n", $2 / 1024; found=1 } END { if (!found) print 0 }' /proc/meminfo 2>/dev/null || echo 0
}

ensure_capacity_for_slow_refresh() {
  local min_mib="${SHEIN_BI_DAILY_MIN_AVAILABLE_MEM_MIB:-2500}"
  local available_mib
  available_mib="$(available_mem_mib)"
  if [[ "$available_mib" =~ ^[0-9]+$ ]] && (( available_mib > 0 && available_mib < min_mib )); then
    write_daily_alert "skipped_low_memory" "daily refresh skipped because MemAvailable=${available_mib}MiB is below ${min_mib}MiB"
    echo "[cloud_daily_refresh] SKIP low memory MemAvailable=${available_mib}MiB threshold=${min_mib}MiB; keep high-frequency sales/ET and BI portal responsive" >&2
    exit 0
  fi
  echo "[cloud_daily_refresh] capacity ok MemAvailable=${available_mib}MiB threshold=${min_mib}MiB"
}

mkdir -p "$LOG_DIR"
DATE="$(resolve_date "$TARGET")"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/daily-refresh-${DATE}-${STAMP}.log"

prepare_shared_lock_file "$LOCK_FILE"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[cloud_daily_refresh] another daily refresh is running; skip"
  exit 0
fi

exec > >(tee -a "$LOG_FILE") 2>&1

trap 'on_error "$LINENO" "$?"' ERR
trap close_store_browsers EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP

echo "[cloud_daily_refresh] start target=$TARGET date=$DATE root=$ROOT"
cd "$ROOT"

export SHEIN_BI_PORTAL_TIMEOUT_MS="${SHEIN_BI_PORTAL_TIMEOUT_MS:-1800000}"
export SHEIN_BI_PORTAL_DATA_MODE="${SHEIN_BI_PORTAL_DATA_MODE:-api}"

DAILY_WARNINGS=()

wait_for_busy_writers
wait_for_lark_report_lock
ensure_capacity_for_slow_refresh

echo "[cloud_daily_refresh] cleanup stale store browsers after lock acquisition"
close_store_browsers


echo "[cloud_daily_refresh] step=link-business date=$DATE"
if ! SHEIN_LINK_BUSINESS_REFRESH_PORTAL=0 bash scripts/cloud_link_business_sync.sh "$DATE"; then
  DAILY_WARNINGS+=("link-business failed")
  echo "[cloud_daily_refresh] WARN link/business daily refresh failed; continue other daily supplements and keep previous successful warehouse data where guarded" >&2
fi
if [[ -s "$ROOT/state/cloud_ops_alerts/link-business-last-partial.json" ]]; then
  DAILY_WARNINGS+=("link-business partial")
  echo "[cloud_daily_refresh] WARN link/business recorded partial store failures; keep the warning visible in the unified daily refresh status" >&2
fi
if [[ -s "$ROOT/state/cloud_ops_alerts/link-business-last-metric-not-ready.json" ]]; then
  DAILY_WARNINGS+=("link-business metrics not ready")
  echo "[cloud_daily_refresh] WARN link/business metrics were not ready; keep previous complete link/business data visible" >&2
fi

if [[ "${SHEIN_BI_DAILY_SCAN_MARKETING_PRICES:-1}" == "1" || "${SHEIN_BI_DAILY_SCAN_MARKETING_PRICES:-1}" == "true" ]]; then
  echo "[cloud_daily_refresh] step=marketing-current-price-scan"
  close_store_browsers
  PRICE_SCAN_MODE_ARGS=()
  if [[ "${SHEIN_BI_MARKETING_PRICE_VISIBLE:-0}" == "1" || "${SHEIN_BI_MARKETING_PRICE_VISIBLE:-0}" == "true" ]]; then
    PRICE_SCAN_MODE_ARGS+=(--visible)
  elif [[ "${SHEIN_BI_MARKETING_PRICE_HEADLESS:-1}" == "1" || "${SHEIN_BI_MARKETING_PRICE_HEADLESS:-1}" == "true" ]]; then
    PRICE_SCAN_MODE_ARGS+=(--headless)
  fi
  if timeout -k "${SHEIN_BI_MARKETING_PRICE_SCAN_KILL_AFTER_SEC:-120}" "${SHEIN_BI_MARKETING_PRICE_SCAN_TIMEOUT_SEC:-2700}" \
    node scripts/marketing/scan_current_marketing_prices_for_bi.mjs \
    --group "${SHEIN_BI_MARKETING_PRICE_GROUP:-ALL}" \
    --page-size "${SHEIN_BI_MARKETING_PRICE_PAGE_SIZE:-500}" \
    "${PRICE_SCAN_MODE_ARGS[@]}"; then
    echo "[cloud_daily_refresh] marketing current price scan done"
  else
    DAILY_WARNINGS+=("marketing price scan failed")
    echo "[cloud_daily_refresh] WARN marketing current price scan failed; BI will keep previous price snapshot and mark missing prices as待补采" >&2
  fi
  close_store_browsers
else
  echo "[cloud_daily_refresh] marketing current price scan disabled by SHEIN_BI_DAILY_SCAN_MARKETING_PRICES"
fi

node scripts/marketing/export_marketing_price_leads_for_bi.mjs || {
  DAILY_WARNINGS+=("marketing price export failed")
  echo "[cloud_daily_refresh] WARN marketing price lead export failed; continue portal generation with existing snapshot" >&2
}

if [[ "${SHEIN_BI_DAILY_OPENAPI_RECONCILIATION:-0}" == "1" || "${SHEIN_BI_DAILY_OPENAPI_RECONCILIATION:-0}" == "true" ]]; then
  echo "[cloud_daily_refresh] step=openapi-reconciliation date=$DATE"
  if SHEIN_OPENAPI_RECONCILE_REFRESH_PORTAL=0 SHEIN_BI_PORTAL_PREWARM_DISABLED=1 bash scripts/cloud_openapi_reconciliation.sh "$DATE"; then
    echo "[cloud_daily_refresh] openapi reconciliation done"
  else
    DAILY_WARNINGS+=("openapi reconciliation failed")
    echo "[cloud_daily_refresh] WARN openapi reconciliation failed; continue other daily supplements and keep previous reconciliation data" >&2
  fi
else
  echo "[cloud_daily_refresh] openapi reconciliation disabled by SHEIN_BI_DAILY_OPENAPI_RECONCILIATION"
fi

if [[ "${SHEIN_BI_DAILY_OPENAPI_RETURN_RECONCILIATION:-0}" == "1" || "${SHEIN_BI_DAILY_OPENAPI_RETURN_RECONCILIATION:-0}" == "true" ]]; then
  echo "[cloud_daily_refresh] step=openapi-return-reconciliation date=$DATE"
  if SHEIN_BI_PORTAL_PREWARM_DISABLED=1 bash scripts/cloud_openapi_return_reconciliation.sh "$DATE"; then
    echo "[cloud_daily_refresh] openapi return reconciliation done"
  else
    DAILY_WARNINGS+=("openapi return reconciliation failed")
    echo "[cloud_daily_refresh] WARN openapi return reconciliation failed; continue other daily supplements and keep previous return reconciliation data" >&2
  fi
else
  echo "[cloud_daily_refresh] openapi return reconciliation disabled by SHEIN_BI_DAILY_OPENAPI_RETURN_RECONCILIATION"
fi

if [[ "${SHEIN_BI_DAILY_OPENAPI_PRODUCT_RECONCILIATION:-0}" == "1" || "${SHEIN_BI_DAILY_OPENAPI_PRODUCT_RECONCILIATION:-0}" == "true" ]]; then
  echo "[cloud_daily_refresh] step=openapi-product-reconciliation"
  if SHEIN_BI_PORTAL_PREWARM_DISABLED=1 bash scripts/cloud_openapi_product_reconciliation.sh; then
    echo "[cloud_daily_refresh] openapi product reconciliation done"
  else
    DAILY_WARNINGS+=("openapi product reconciliation failed")
    echo "[cloud_daily_refresh] WARN openapi product reconciliation failed; continue portal generation and keep previous product reconciliation data" >&2
  fi
else
  echo "[cloud_daily_refresh] openapi product reconciliation disabled by SHEIN_BI_DAILY_OPENAPI_PRODUCT_RECONCILIATION"
fi

if [[ "${SHEIN_BI_DAILY_RTV_VERIFY:-1}" == "1" || "${SHEIN_BI_DAILY_RTV_VERIFY:-1}" == "true" ]]; then
  echo "[cloud_daily_refresh] step=rtv-verify"
  if SHEIN_RTV_REFRESH_PORTAL=0 SHEIN_BI_PORTAL_PREWARM_DISABLED=1 bash scripts/cloud_rtv_verify.sh; then
    echo "[cloud_daily_refresh] RTV verify done"
  else
    DAILY_WARNINGS+=("RTV verify failed")
    echo "[cloud_daily_refresh] WARN RTV verify failed; continue portal generation with previous RTV verification data" >&2
  fi
else
  echo "[cloud_daily_refresh] RTV verify disabled by SHEIN_BI_DAILY_RTV_VERIFY"
fi

prepare_shared_lock_file "$PORTAL_REFRESH_LOCK_FILE"
{
  if ! flock -w "$PORTAL_REFRESH_LOCK_WAIT_SEC" 8; then
    DAILY_WARNINGS+=("portal refresh lock busy")
    echo "[cloud_daily_refresh] WARN portal refresh lock busy after ${PORTAL_REFRESH_LOCK_WAIT_SEC}s; skip portal generation/prewarm this run" >&2
  else
    set +e
    node scripts/audit_bi_warehouse.mjs
    AUDIT_STATUS=$?
    set -e
    if [[ "$AUDIT_STATUS" -ne 0 ]]; then
      DAILY_WARNINGS+=("warehouse audit status=$AUDIT_STATUS")
      echo "[cloud_daily_refresh] BI audit finished with status=$AUDIT_STATUS; continue portal generation so the page can show the audit result" >&2
    fi

    node scripts/generate_bi_portal.mjs \
      --metabase-url "$METABASE_URL" \
      --data-mode "$SHEIN_BI_PORTAL_DATA_MODE"

    node scripts/generate_bi_portal_shell.mjs

    if command -v systemctl >/dev/null 2>&1; then
      systemctl is-active --quiet shein-bi-portal.service || systemctl start shein-bi-portal.service || true
    fi

    if [[ "$SHEIN_BI_PORTAL_DATA_MODE" == "api" && "${SHEIN_BI_PORTAL_PREWARM_DISABLED:-0}" != "1" ]]; then
      nohup bash scripts/prewarm_bi_portal_sections.sh >/dev/null 2>&1 &
      echo "[cloud_daily_refresh] portal section prewarm started pid=$!"
    fi
  fi
} 8>>"$PORTAL_REFRESH_LOCK_FILE"

check_portal_health

if [[ "${#DAILY_WARNINGS[@]}" -gt 0 ]]; then
  write_daily_alert "warning" "${DAILY_WARNINGS[*]}"
  echo "[cloud_daily_refresh] done with warnings date=$DATE warnings=${DAILY_WARNINGS[*]} log=$LOG_FILE"
else
  rm -f "$ROOT/state/cloud_ops_alerts/daily-refresh-last.json" 2>/dev/null || true
  echo "[cloud_daily_refresh] done date=$DATE log=$LOG_FILE"
fi
