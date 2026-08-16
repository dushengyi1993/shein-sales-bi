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
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP

echo "[cloud_daily_refresh] start target=$TARGET date=$DATE root=$ROOT"
cd "$ROOT"

export SHEIN_BI_PORTAL_TIMEOUT_MS="${SHEIN_BI_PORTAL_TIMEOUT_MS:-1800000}"
export SHEIN_BI_PORTAL_DATA_MODE="${SHEIN_BI_PORTAL_DATA_MODE:-api}"

DAILY_WARNINGS=()
LINK_BUSINESS_MODE="${SHEIN_BI_DAILY_LINK_BUSINESS_MODE:-full}"
LINK_BUSINESS_STATUS=0
# Homepage-critical Portal sections (homeRankings..homeProfit) belong to the
# homepage lane, not to the morning inventory coordinator.  `sync` preserves
# the legacy one-shot behavior: the daily run itself builds every
# homepage-critical section before it may return (default for standalone daily
# refresh).  `queue` (used by the 07:10 morning coordinator) hands the same
# sections to the bounded host-locked section queue worker instead, so a slow
# homeRankings/profit refresh can never consume the reserved inventory
# window.  linksData is inventory-critical and stays synchronous in BOTH
# modes; the inventory guard keeps its own fail-closed linksData gate.
CRITICAL_PORTAL_PREWARM_MODE="${SHEIN_BI_DAILY_CRITICAL_PORTAL_PREWARM:-sync}"
case "$CRITICAL_PORTAL_PREWARM_MODE" in
  sync|queue) ;;
  *)
    echo "[cloud_daily_refresh] invalid SHEIN_BI_DAILY_CRITICAL_PORTAL_PREWARM=$CRITICAL_PORTAL_PREWARM_MODE" >&2
    exit 64
    ;;
esac
# A queue-mode caller cannot simultaneously demand synchronous critical
# completion: the queue worker owns those sections and this run would return
# before they are terminal.  Fail closed on the contradiction instead of
# silently downgrading the requirement.
if [[ "$CRITICAL_PORTAL_PREWARM_MODE" == "queue" \
  && "${SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS:-0}" == "1" ]]; then
  echo "[cloud_daily_refresh] ERROR SHEIN_BI_DAILY_CRITICAL_PORTAL_PREWARM=queue cannot be combined with SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS=1; a queue cannot prove synchronous critical-section completion" >&2
  exit 64
fi

wait_for_busy_writers
wait_for_lark_report_lock
ensure_capacity_for_slow_refresh

case "$LINK_BUSINESS_MODE" in
  full)
    echo "[cloud_daily_refresh] step=link-business mode=full date=$DATE"
    if ! SHEIN_LINK_BUSINESS_REFRESH_PORTAL=0 bash scripts/cloud_link_business_sync.sh "$DATE"; then
      DAILY_WARNINGS+=("link-business failed")
      echo "[cloud_daily_refresh] WARN link/business daily refresh failed; continue other daily supplements and keep previous successful warehouse data where guarded" >&2
    fi
    ;;
  finalize)
    echo "[cloud_daily_refresh] step=link-business mode=finalize date=$DATE"
    if SHEIN_LINK_BUSINESS_FINALIZE_ONLY=1 SHEIN_LINK_BUSINESS_REFRESH_PORTAL=0 \
      bash scripts/cloud_link_business_sync.sh "$DATE"; then
      LINK_BUSINESS_STATUS=0
    else
      LINK_BUSINESS_STATUS=$?
    fi
    if [[ "$LINK_BUSINESS_STATUS" -ne 0 ]]; then
      DAILY_WARNINGS+=("link-business finalize failed")
      echo "[cloud_daily_refresh] WARN link/business final merge failed; continue non-link supplements but keep prior complete link snapshot" >&2
    fi
    ;;
  skip)
    echo "[cloud_daily_refresh] step=link-business mode=skip date=$DATE; require caller-owned merged evidence"
    ;;
  *)
    echo "[cloud_daily_refresh] invalid SHEIN_BI_DAILY_LINK_BUSINESS_MODE=$LINK_BUSINESS_MODE" >&2
    exit 64
    ;;
esac

if [[ "${SHEIN_BI_DAILY_REQUIRE_COMPLETE_LINK_BUSINESS:-0}" == "1" || "${SHEIN_BI_DAILY_REQUIRE_COMPLETE_LINK_BUSINESS:-0}" == "true" ]]; then
  LINK_BUSINESS_BLOCKER="$(
    DATE="$DATE" LINK_BUSINESS_STATUS="$LINK_BUSINESS_STATUS" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const date = String(process.env.DATE || '');
const status = Number(process.env.LINK_BUSINESS_STATUS || 0);
const blockers = [];
if (status !== 0) blockers.push(`finalize_exit_${status}`);
for (const [file, label] of [
  ['link-business-last-partial.json', 'store_gaps'],
  ['link-business-last-metric-not-ready.json', 'metrics_not_ready'],
]) {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(root, 'state', 'cloud_ops_alerts', file), 'utf8'));
    if (String(payload?.date || '') === date) blockers.push(label);
  } catch {}
}
process.stdout.write(blockers.join(','));
NODE
  )"
  if [[ -n "$LINK_BUSINESS_BLOCKER" ]]; then
    write_daily_alert "waiting_platform" "link/business is not complete for $DATE: $LINK_BUSINESS_BLOCKER; prior complete Portal snapshot retained"
    echo "[cloud_daily_refresh] WAITING link/business incomplete blockers=$LINK_BUSINESS_BLOCKER; do not publish a partial daily snapshot" >&2
    exit 75
  fi
fi
if [[ "$LINK_BUSINESS_MODE" != "skip" ]]; then
  if [[ -s "$ROOT/state/cloud_ops_alerts/link-business-last-partial.json" ]]; then
    DAILY_WARNINGS+=("link-business partial")
    echo "[cloud_daily_refresh] WARN link/business recorded partial store failures; keep the warning visible in the unified daily refresh status" >&2
  fi
  if [[ -s "$ROOT/state/cloud_ops_alerts/link-business-last-metric-not-ready.json" ]]; then
    DAILY_WARNINGS+=("link-business metrics not ready")
    echo "[cloud_daily_refresh] WARN link/business metrics were not ready; keep previous complete link/business data visible" >&2
  fi
fi

echo "[cloud_daily_refresh] marketing current-price evidence is owned by cloud_marketing_live_guard; skip duplicate all-store scan"

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

if [[ "${SHEIN_BI_DAILY_OPENAPI_FINANCE_SYNC:-0}" == "1" || "${SHEIN_BI_DAILY_OPENAPI_FINANCE_SYNC:-0}" == "true" ]]; then
  echo "[cloud_daily_refresh] step=openapi-finance-sync date=$DATE"
  if SHEIN_BI_PORTAL_PREWARM_DISABLED=1 bash scripts/cloud_openapi_finance_sync.sh "$DATE"; then
    echo "[cloud_daily_refresh] openapi finance sync done"
  else
    DAILY_WARNINGS+=("openapi finance sync execution_failed")
    echo "[cloud_daily_refresh] WARN openapi finance sync execution failed; keep prior settled return-cost facts" >&2
  fi
else
  echo "[cloud_daily_refresh] openapi finance sync disabled by SHEIN_BI_DAILY_OPENAPI_FINANCE_SYNC"
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

COST_LEDGER_STATUS=0
CRITICAL_PORTAL_STATUS=0
# Inventory-critical linksData synchronous publication status.  It starts
# UNPROVEN (nonzero) so any queue-mode run that never reaches a successful
# linksData publish -- portal lock timeout, prewarm failure, or an entire
# skipped block (PREWARM_DISABLED=1 / DATA_MODE!=api) -- fails closed and
# cloud_morning_chain can never mark morning-links-ready / morning-supplements
# done while the inventory-critical section is stale.  Only a real successful
# prewarm, or the explicit LINK_BUSINESS_MODE=skip caller-owned merge branch,
# resets it to 0.
INVENTORY_LINKS_STATUS=75
if [[ "${SHEIN_BI_DAILY_INVENTORY_COST_REFRESH:-1}" == "1" || "${SHEIN_BI_DAILY_INVENTORY_COST_REFRESH:-1}" == "true" ]]; then
  echo "[cloud_daily_refresh] step=inventory-cost-ledger"
  if bash scripts/refresh_inventory_cost_ledger.sh; then
    COST_LEDGER_STATUS=0
  else
    COST_LEDGER_STATUS=$?
  fi
  if [[ "$COST_LEDGER_STATUS" -ne 0 ]]; then
    DAILY_WARNINGS+=("inventory cost ledger refresh failed status=$COST_LEDGER_STATUS")
    echo "[cloud_daily_refresh] WARN inventory cost ledger refresh failed; retain the previous complete profit cache" >&2
  fi
fi

prepare_shared_lock_file "$PORTAL_REFRESH_LOCK_FILE"
{
  if ! flock -w "$PORTAL_REFRESH_LOCK_WAIT_SEC" 8; then
    CRITICAL_PORTAL_STATUS=75
    INVENTORY_LINKS_STATUS=75
    DAILY_WARNINGS+=("portal refresh lock busy")
    echo "[cloud_daily_refresh] WARN portal refresh lock busy after ${PORTAL_REFRESH_LOCK_WAIT_SEC}s; skip portal generation/prewarm this run" >&2
  else
    if [[ "$COST_LEDGER_STATUS" -eq 0 && "${SHEIN_BI_PROFIT_MART_REFRESH_DISABLED:-0}" != "1" ]]; then
      if bash scripts/refresh_profit_marts.sh; then
        PROFIT_MART_STATUS=0
      else
        PROFIT_MART_STATUS=$?
      fi
      if [[ "$PROFIT_MART_STATUS" -ne 0 ]]; then
        DAILY_WARNINGS+=("profit mart refresh failed status=$PROFIT_MART_STATUS")
        echo "[cloud_daily_refresh] WARN profit mart refresh failed; portal will retain the last complete cache" >&2
      fi
    fi
    if node scripts/audit_bi_warehouse.mjs; then
      AUDIT_STATUS=0
    else
      AUDIT_STATUS=$?
    fi
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
      if [[ "$LINK_BUSINESS_MODE" != "skip" ]]; then
        echo "[cloud_daily_refresh] refresh inventory-critical linksData section synchronously"
        if SHEIN_BI_PORTAL_PREWARM_SECTIONS=linksData \
          SHEIN_BI_PORTAL_PREWARM_ASYNC=0 \
          SHEIN_BI_PORTAL_PREWARM_HOST_LOCKED=1 \
          bash scripts/prewarm_bi_portal_sections.sh 8>&-; then
          INVENTORY_LINKS_STATUS=0
          echo "[cloud_daily_refresh] inventory-critical linksData section refreshed"
        else
          INVENTORY_LINKS_STATUS=$?
          DAILY_WARNINGS+=("linksData section refresh failed")
          echo "[cloud_daily_refresh] WARN linksData section refresh failed; inventory guard will fail closed or retry its own source preparation" >&2
        fi
      else
        INVENTORY_LINKS_STATUS=0
        echo "[cloud_daily_refresh] linksData was synchronously published by the caller-owned all-store merge"
      fi

      CRITICAL_PORTAL_SECTIONS="${SHEIN_BI_DAILY_CRITICAL_PORTAL_SECTIONS:-homeRankings,homeTrafficDaily,priceScatter,afterSales,orders,profit,homeProfit}"
      if [[ "$CRITICAL_PORTAL_PREWARM_MODE" == "sync" ]]; then
        # The standalone daily run is not complete while homepage-critical
        # caches still belong to the previous core generation.  Previously
        # these six sections were only queued two-at-a-time, so recurring
        # order/return refreshes could leave the homepage on a multi-day
        # fallback even though the daily run had already been marked done.
        echo "[cloud_daily_refresh] refresh homepage-critical sections synchronously sections=$CRITICAL_PORTAL_SECTIONS"
        if SHEIN_BI_PORTAL_PREWARM_SECTIONS="$CRITICAL_PORTAL_SECTIONS" \
          SHEIN_BI_PORTAL_PREWARM_ASYNC=0 \
          SHEIN_BI_PORTAL_PREWARM_HOST_LOCKED=1 \
          bash scripts/prewarm_bi_portal_sections.sh 8>&-; then
          echo "[cloud_daily_refresh] homepage-critical sections refreshed"
        else
          CRITICAL_PORTAL_STATUS=$?
          DAILY_WARNINGS+=("homepage-critical section refresh failed status=$CRITICAL_PORTAL_STATUS")
          echo "[cloud_daily_refresh] WARN homepage-critical section refresh failed; keep the run open and retain cache fallbacks" >&2
        fi
      else
        # The morning coordinator enters the reserved inventory window as soon
        # as the 19-store merge and inventory-critical linksData are complete.
        # Homepage-critical sections are handed to the bounded host-locked
        # queue worker (lease + per-section timeout + dependency barriers), so
        # a slow homeRankings/profit refresh can never consume the inventory
        # window.  The queue worker and watchdog own their terminal evidence;
        # an enqueue failure stays a visible warning, never a success claim.
        echo "[cloud_daily_refresh] enqueue homepage-critical sections for the bounded queue worker sections=$CRITICAL_PORTAL_SECTIONS"
        if bash scripts/enqueue_bi_portal_sections.sh \
            --sections "$CRITICAL_PORTAL_SECTIONS" \
            --priority "${SHEIN_BI_DAILY_CRITICAL_PORTAL_QUEUE_PRIORITY:-10}" \
            --reason "daily-refresh-$DATE"; then
          echo "[cloud_daily_refresh] homepage-critical sections queued"
        else
          DAILY_WARNINGS+=("homepage-critical section enqueue failed")
          echo "[cloud_daily_refresh] WARN homepage-critical section enqueue failed; the queue worker will not refresh these sections this run" >&2
        fi
      fi

      if bash scripts/enqueue_bi_portal_sections.sh \
          --sections actions,productState,productSalesDaily,productTrafficDaily,comments,rtvData,waybills,rankings \
          --priority 50 \
          --reason "daily-refresh-$DATE"; then
        echo "[cloud_daily_refresh] non-critical portal sections queued for bounded host-locked refresh"
      else
        DAILY_WARNINGS+=("portal section queue failed")
        echo "[cloud_daily_refresh] WARN portal section queue enqueue failed" >&2
      fi
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

if [[ "$CRITICAL_PORTAL_PREWARM_MODE" == "queue" && "$INVENTORY_LINKS_STATUS" -ne 0 ]]; then
  echo "[cloud_daily_refresh] inventory-critical linksData was not synchronously published; unified coordinator must retry before marking the daily publish complete" >&2
  exit 75
fi

if [[ "$CRITICAL_PORTAL_STATUS" -ne 0 \
  && "${SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS:-0}" == "1" ]]; then
  echo "[cloud_daily_refresh] critical Portal sections are incomplete; unified coordinator must retry before marking the daily publish complete" >&2
  exit 75
fi
