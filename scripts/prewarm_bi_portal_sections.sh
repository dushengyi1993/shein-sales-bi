#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
PORTAL_URL="${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}"
# Warm the homepage-critical sections first. profit can be much slower than the
# sales/returns sections; keep it near the end so a slow profit refresh cannot
# block homepage sales/order/after-sales freshness. homeProfit is requested both
# before and after profit: the first pass serves a fast summary if the current
# profit cache already exists, while the second pass refreshes it after a
# successful profit warm. The frontend refuses stale homeProfit summaries.
SECTIONS="${SHEIN_BI_PORTAL_PREWARM_SECTIONS:-homeRankings,afterSales,homeProfit,actions,financeData,linksData,inventoryTrend,comments,orders,rtvData,waybills,rankings,profit,homeProfit}"
LOG_DIR="${SHEIN_BI_PREWARM_LOG_DIR:-/srv/shein-bi/logs/cloud-portal-prewarm}"
TIMEOUT_SECONDS="${SHEIN_BI_PREWARM_SECTION_TIMEOUT_SECONDS:-1200}"
FORCE_REFRESH="${SHEIN_BI_PORTAL_PREWARM_FORCE:-0}"

mkdir -p "$LOG_DIR"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/prewarm-${STAMP}.log"

exec >>"$LOG_FILE" 2>&1

echo "[prewarm_bi_portal_sections] start root=$ROOT url=$PORTAL_URL sections=$SECTIONS timeout=${TIMEOUT_SECONDS}s force=$FORCE_REFRESH"
cd "$ROOT"

IFS=',' read -r -a SECTION_LIST <<< "$SECTIONS"
for RAW_SECTION in "${SECTION_LIST[@]}"; do
  SECTION="$(echo "$RAW_SECTION" | xargs)"
  [[ -n "$SECTION" ]] || continue
  START="$(date +%s)"
  echo "[prewarm_bi_portal_sections] section=$SECTION start"
  SECTION_URL="$PORTAL_URL/api/bi/section/$SECTION"
  if [[ "$FORCE_REFRESH" == "1" ]]; then
    SECTION_URL="${SECTION_URL}?refresh=1"
  fi
  if curl -fsS --max-time "$TIMEOUT_SECONDS" "$SECTION_URL" >/dev/null; then
    END="$(date +%s)"
    echo "[prewarm_bi_portal_sections] section=$SECTION ok duration_sec=$((END-START))"
  else
    STATUS=$?
    END="$(date +%s)"
    echo "[prewarm_bi_portal_sections] section=$SECTION failed status=$STATUS duration_sec=$((END-START))" >&2
  fi
done

echo "[prewarm_bi_portal_sections] done log=$LOG_FILE"
