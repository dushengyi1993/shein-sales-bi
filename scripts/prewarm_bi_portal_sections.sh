#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
source "$ROOT/scripts/lib/shared_lock.sh"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
PORTAL_URL="${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}"
PORTAL_ROOT="${SHEIN_BI_PORTAL_ROOT:-$ROOT/outputs/bi-portal}"
# Warm the homepage-critical sections first. profit can be much slower than the
# sales/returns sections; keep it near the end so a slow profit refresh cannot
# block homepage sales/order/after-sales freshness. homeProfit derives from the
# current-generation profit cache and fails closed (503/202) when that source
# does not exist, so it must run exactly once, strictly after profit. The
# frontend refuses stale homeProfit summaries.
SECTIONS="${SHEIN_BI_PORTAL_PREWARM_SECTIONS:-homeRankings,afterSales,homeTrafficDaily,orders,actions,linksData,productState,productSalesDaily,productTrafficDaily,comments,rtvData,waybills,rankings,profit,homeProfit}"
LOG_DIR="${SHEIN_BI_PREWARM_LOG_DIR:-/srv/shein-bi/logs/cloud-portal-prewarm}"
TIMEOUT_SECONDS="${SHEIN_BI_PREWARM_SECTION_TIMEOUT_SECONDS:-1200}"
FORCE_REFRESH="${SHEIN_BI_PORTAL_PREWARM_FORCE:-1}"
ASYNC_REFRESH="${SHEIN_BI_PORTAL_PREWARM_ASYNC:-1}"
HOST_LOCKED_WORKER="${SHEIN_BI_PORTAL_PREWARM_HOST_LOCKED:-0}"
LOCK_FILE="${SHEIN_BI_PORTAL_PREWARM_LOCK_FILE:-$ROOT/state/locks/shein-bi-portal-prewarm.lock}"
REFRESH_RUN_TOKEN="${SHEIN_BI_PORTAL_PREWARM_REFRESH_TOKEN:-prewarm:$(date -u +%Y%m%dT%H%M%SZ):$$}"

[[ "$REFRESH_RUN_TOKEN" =~ ^[A-Za-z0-9._:-]{1,160}$ ]] || {
  echo "[prewarm_bi_portal_sections] invalid refresh run token" >&2
  exit 64
}

# Never leak the per-section curl header file, even on early exit paths.
trap '[[ -n "${HEADERS_FILE:-}" ]] && rm -f "$HEADERS_FILE"' EXIT

# A caller that waits synchronously for the refresh (host-locked worker or
# ASYNC=0) must not treat a busy prewarm lock as a completed skip: the portal
# sections were not published, so the caller keeps its run open with a
# retryable 75. Plain async warmups may skip with 0 because another prewarm is
# already doing the same work.
CRITICAL_SYNC_MODE="0"
if [[ "$HOST_LOCKED_WORKER" == "1" || "$HOST_LOCKED_WORKER" == "true" || "$ASYNC_REFRESH" == "0" ]]; then
  CRITICAL_SYNC_MODE="1"
fi

mkdir -p "$LOG_DIR"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/prewarm-${STAMP}.log"

exec >>"$LOG_FILE" 2>&1

prepare_shared_lock_file "$LOCK_FILE"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  if [[ "$CRITICAL_SYNC_MODE" == "1" ]]; then
    echo "[prewarm_bi_portal_sections] defer reason=prewarm_lock_busy_critical mode=sync" >&2
    exit 75
  fi
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
    SECTION_URL="${SECTION_URL}?refresh=1&refreshToken=${REFRESH_RUN_TOKEN}"
    if [[ "$ASYNC_REFRESH" == "1" ]]; then
      SECTION_URL="${SECTION_URL}&async=1"
    fi
  fi
  CURL_HEADERS=()
  if [[ "$HOST_LOCKED_WORKER" == "1" || "$HOST_LOCKED_WORKER" == "true" ]]; then
    CURL_HEADERS=(-H 'X-SHEIN-BI-HOST-LOCKED-WORKER: 1')
  fi
  HEADERS_FILE="$(mktemp)"
  # -f is deliberately not used: 202 pending / 4xx / 5xx responses must be
  # classified explicitly. Only a real HTTP 200 may even be considered fresh.
  set +e
  HTTP_CODE="$(curl -sS --max-time "$TIMEOUT_SECONDS" \
    -D "$HEADERS_FILE" -o /dev/null -w '%{http_code}' \
    "${CURL_HEADERS[@]}" "$SECTION_URL")"
  CURL_STATUS=$?
  set -e
  if [[ "$CURL_STATUS" -ne 0 ]]; then
    STATUS=$CURL_STATUS
    END="$(date +%s)"
    echo "[prewarm_bi_portal_sections] section=$SECTION failed status=$STATUS duration_sec=$((END-START))" >&2
    FAILED_SECTIONS+=("$SECTION:$STATUS")
  elif [[ "$HTTP_CODE" != "200" ]]; then
    # A 202 pending / 403 / 503 / 500 is never a refreshed section: the cache
    # is not terminal yet.
    STATUS=$HTTP_CODE
    END="$(date +%s)"
    echo "[prewarm_bi_portal_sections] section=$SECTION failed status=$STATUS (non-200; pending is never fresh) duration_sec=$((END-START))" >&2
    FAILED_SECTIONS+=("$SECTION:$STATUS")
  elif grep -qiE '^X-BI-Section-(Stale|Refresh-Failed):[[:space:]]*true' "$HEADERS_FILE"; then
    # A 200 that still carries a stale-source or failed-refresh marker is a
    # failed refresh, not a completed section.
    STATUS=78
    END="$(date +%s)"
    echo "[prewarm_bi_portal_sections] section=$SECTION failed status=$STATUS (2xx carried stale/failed refresh marker) duration_sec=$((END-START))" >&2
    FAILED_SECTIONS+=("$SECTION:$STATUS")
  else
    # A clean 200 is still not terminal until the section artifact on disk
    # matches the current core generation. Verify the exact file readback.
    set +e
    TERMINAL_REPORT="$(node scripts/check_bi_portal_section_terminal.mjs \
      --root "$PORTAL_ROOT" --section "$SECTION" 2>&1)"
    TERMINAL_STATUS=$?
    set -e
    if [[ "$TERMINAL_STATUS" -eq 0 ]]; then
      END="$(date +%s)"
      echo "[prewarm_bi_portal_sections] section=$SECTION ok duration_sec=$((END-START))"
    else
      STATUS=$TERMINAL_STATUS
      END="$(date +%s)"
      echo "[prewarm_bi_portal_sections] section=$SECTION failed status=$STATUS (terminal readback: $(printf '%s' "$TERMINAL_REPORT" | tail -c 240)) duration_sec=$((END-START))" >&2
      FAILED_SECTIONS+=("$SECTION:$STATUS")
    fi
  fi
  rm -f "$HEADERS_FILE"
done

if [[ "${#FAILED_SECTIONS[@]}" -gt 0 ]]; then
  echo "[prewarm_bi_portal_sections] failed sections=$(IFS=,; echo "${FAILED_SECTIONS[*]}") log=$LOG_FILE" >&2
  exit 1
fi

echo "[prewarm_bi_portal_sections] done log=$LOG_FILE"
