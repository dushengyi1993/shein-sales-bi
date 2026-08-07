#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
source "$ROOT/scripts/lib/shared_lock.sh"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
PORTAL_URL="${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}"
# Warm the homepage-critical sections first. profit can be much slower than the
# sales/returns sections; keep it near the end so a slow profit refresh cannot
# block homepage sales/order/after-sales freshness. homeProfit is requested both
# before and after profit: the first pass serves a fast summary if the current
# profit cache already exists, while the second pass refreshes it after a
# successful profit warm. The frontend refuses stale homeProfit summaries.
SECTIONS="${SHEIN_BI_PORTAL_PREWARM_SECTIONS:-homeRankings,afterSales,homeTrafficDaily,orders,homeProfit,actions,linksData,productState,productSalesDaily,productTrafficDaily,comments,rtvData,waybills,rankings,profit,homeProfit}"
LOG_DIR="${SHEIN_BI_PREWARM_LOG_DIR:-/srv/shein-bi/logs/cloud-portal-prewarm}"
TIMEOUT_SECONDS="${SHEIN_BI_PREWARM_SECTION_TIMEOUT_SECONDS:-1200}"
FORCE_REFRESH="${SHEIN_BI_PORTAL_PREWARM_FORCE:-1}"
ASYNC_REFRESH="${SHEIN_BI_PORTAL_PREWARM_ASYNC:-1}"
HOST_LOCKED_WORKER="${SHEIN_BI_PORTAL_PREWARM_HOST_LOCKED:-0}"
LOCK_FILE="${SHEIN_BI_PORTAL_PREWARM_LOCK_FILE:-$ROOT/state/locks/shein-bi-portal-prewarm.lock}"

mkdir -p "$LOG_DIR"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/prewarm-${STAMP}.log"

exec >>"$LOG_FILE" 2>&1

prepare_shared_lock_file "$LOCK_FILE"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[prewarm_bi_portal_sections] another prewarm is running; skip"
  exit 0
fi

echo "[prewarm_bi_portal_sections] start root=$ROOT url=$PORTAL_URL sections=$SECTIONS timeout=${TIMEOUT_SECONDS}s force=$FORCE_REFRESH async=$ASYNC_REFRESH"
cd "$ROOT"

IFS=',' read -r -a SECTION_LIST <<< "$SECTIONS"
FAILED_SECTIONS=()
for RAW_SECTION in "${SECTION_LIST[@]}"; do
  SECTION="$(echo "$RAW_SECTION" | xargs)"
  [[ -n "$SECTION" ]] || continue
  START="$(date +%s)"
  echo "[prewarm_bi_portal_sections] section=$SECTION start"
  SECTION_URL="$PORTAL_URL/api/bi/section/$SECTION"
  if [[ "$FORCE_REFRESH" == "1" ]]; then
    SECTION_URL="${SECTION_URL}?refresh=1"
    if [[ "$ASYNC_REFRESH" == "1" ]]; then
      SECTION_URL="${SECTION_URL}&async=1"
    fi
  fi
  CURL_HEADERS=()
  if [[ "$HOST_LOCKED_WORKER" == "1" || "$HOST_LOCKED_WORKER" == "true" ]]; then
    CURL_HEADERS=(-H 'X-SHEIN-BI-HOST-LOCKED-WORKER: 1')
  fi
  if curl -fsS --max-time "$TIMEOUT_SECONDS" "${CURL_HEADERS[@]}" "$SECTION_URL" >/dev/null; then
    END="$(date +%s)"
    echo "[prewarm_bi_portal_sections] section=$SECTION ok duration_sec=$((END-START))"
  else
    STATUS=$?
    END="$(date +%s)"
    echo "[prewarm_bi_portal_sections] section=$SECTION failed status=$STATUS duration_sec=$((END-START))" >&2
    FAILED_SECTIONS+=("$SECTION:$STATUS")
  fi
done

if [[ "${#FAILED_SECTIONS[@]}" -gt 0 ]]; then
  echo "[prewarm_bi_portal_sections] failed sections=$(IFS=,; echo "${FAILED_SECTIONS[*]}") log=$LOG_FILE" >&2
  exit 1
fi

echo "[prewarm_bi_portal_sections] done log=$LOG_FILE"
