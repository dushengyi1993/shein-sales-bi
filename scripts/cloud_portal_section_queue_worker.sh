#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
PORTAL_URL="${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}"
PORTAL_ROOT="${SHEIN_BI_PORTAL_ROOT:-$ROOT/outputs/bi-portal}"
QUEUE_FILE="${SHEIN_BI_PORTAL_SECTION_QUEUE_FILE:-$ROOT/state/portal-section-queue/queue.json}"
LOCK_FILE="${SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE:-$ROOT/state/locks/shein-bi-portal-section-queue.lock}"
MAX_SECTIONS="${SHEIN_BI_PORTAL_SECTION_QUEUE_MAX_SECTIONS:-3}"
SECTION_TIMEOUT="${SHEIN_BI_PORTAL_SECTION_QUEUE_SECTION_TIMEOUT_SEC:-900}"
PROFIT_MIN_RUNTIME_SEC="${SHEIN_BI_PORTAL_SECTION_QUEUE_PROFIT_MIN_RUNTIME_SEC:-480}"
HOME_RANKINGS_MIN_RUNTIME_SEC="${SHEIN_BI_PORTAL_SECTION_QUEUE_HOME_RANKINGS_MIN_RUNTIME_SEC:-540}"
LEASE_SECONDS="${SHEIN_BI_PORTAL_SECTION_QUEUE_LEASE_SEC:-1200}"
SCHEDULED_ENTRY="${SHEIN_BI_PORTAL_SECTION_QUEUE_SCHEDULED:-0}"
DEADLINE_MINUTE="${SHEIN_BI_PORTAL_SECTION_QUEUE_DEADLINE_MINUTE:-}"
START_HOUR="$(date +%H)"
START_MINUTE="$(date +%M)"

# Never leak the per-section curl header file, even on early exit paths.
trap '[[ -n "${HEADERS_FILE:-}" ]] && rm -f "$HEADERS_FILE"' EXIT

[[ "$MAX_SECTIONS" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$SECTION_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$PROFIT_MIN_RUNTIME_SEC" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$HOME_RANKINGS_MIN_RUNTIME_SEC" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$DEADLINE_MINUTE" =~ ^[0-9]+$ ]] && (( DEADLINE_MINUTE >= 0 && DEADLINE_MINUTE <= 59 )) || exit 64
if [[ "$SCHEDULED_ENTRY" != "1" ]]; then
  echo "[portal-section-worker] defer reason=unscheduled_direct_entry; use shein-bi-cloud-portal-section-queue.service" >&2
  exit 75
fi
SAFE_START=0
case "$START_HOUR:$START_MINUTE" in
  01:*|06:4[3-6]) ;;
  *:1[3-6]|*:4[3-6]) SAFE_START=1 ;;
esac
if (( SAFE_START == 0 )); then
  echo "[portal-section-worker] defer reason=outside_safe_start_window hour=$START_HOUR minute=$START_MINUTE" >&2
  exit 75
fi

source "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$LOCK_FILE"
cd "$ROOT"

queue_command() {
  local output
  local status
  exec 9<>"$LOCK_FILE"
  flock -w 10 9
  if output="$(node scripts/manage_bi_portal_section_queue.mjs "$@" --file "$QUEUE_FILE")"; then
    status=0
  else
    status=$?
  fi
  flock -u 9
  exec 9>&-
  printf '%s\n' "$output"
  return "$status"
}

echo "[portal-section-worker] start maxSections=$MAX_SECTIONS"
FAILED_SECTIONS=()
CLAIMED_SECTIONS=()
HEAVY_SECTION_DEFERRED=0
for ((index=1; index<=MAX_SECTIONS; index+=1)); do
  NOW_EPOCH="$(date +%s)"
  CURRENT_HOUR="$(date +%Y-%m-%dT%H)"
  DEADLINE_EPOCH="$(date -d "${CURRENT_HOUR}:${DEADLINE_MINUTE}:00" +%s)"
  REMAINING_SEC=$((DEADLINE_EPOCH - NOW_EPOCH))
  if (( REMAINING_SEC <= 10 )); then
    echo "[portal-section-worker] stop before next core lane remainingSec=$REMAINING_SEC"
    break
  fi
  set +e
  CLAIM_ARGS=(claim --lease-seconds "$LEASE_SECONDS")
  EXCLUDED_SECTIONS=("${CLAIMED_SECTIONS[@]}")
  if (( REMAINING_SEC < PROFIT_MIN_RUNTIME_SEC )); then
    EXCLUDED_SECTIONS+=(profit)
    HEAVY_SECTION_DEFERRED=1
    echo "[portal-section-worker] defer heavy section=profit remainingSec=$REMAINING_SEC requiredSec=$PROFIT_MIN_RUNTIME_SEC"
  fi
  if (( REMAINING_SEC < HOME_RANKINGS_MIN_RUNTIME_SEC )); then
    EXCLUDED_SECTIONS+=(homeRankings)
    HEAVY_SECTION_DEFERRED=1
    echo "[portal-section-worker] defer heavy section=homeRankings remainingSec=$REMAINING_SEC requiredSec=$HOME_RANKINGS_MIN_RUNTIME_SEC"
  fi
  if [[ "${#EXCLUDED_SECTIONS[@]}" -gt 0 ]]; then
    CLAIM_ARGS+=(--exclude-sections "$(IFS=,; echo "${EXCLUDED_SECTIONS[*]}")")
  fi
  CLAIM="$(queue_command "${CLAIM_ARGS[@]}")"
  CLAIM_STATUS=$?
  set -e
  if [[ "$CLAIM_STATUS" -eq 75 ]]; then
    if [[ "$HEAVY_SECTION_DEFERRED" -eq 1 ]]; then
      QUEUE_STATUS="$(queue_command status)"
      PENDING_COUNT="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.counts?.pending||0))' "$QUEUE_STATUS")"
      if (( PENDING_COUNT > 0 )); then
        echo "[portal-section-worker] defer pending sections=$PENDING_COUNT reason=insufficient_heavy_budget"
        exit 75
      fi
    fi
    echo "[portal-section-worker] queue empty"
    break
  fi
  [[ "$CLAIM_STATUS" -eq 0 ]] || exit "$CLAIM_STATUS"
  SECTION="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.entry?.section||""))' "$CLAIM")"
  LEASE_ID="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.entry?.leaseId||""))' "$CLAIM")"
  [[ -n "$SECTION" && -n "$LEASE_ID" ]] || {
    echo "[portal-section-worker] invalid claim: $CLAIM" >&2
    exit 1
  }
  CLAIMED_SECTIONS+=("$SECTION")
  echo "[portal-section-worker] section=$SECTION attempt=$index"
  CURL_TIMEOUT="$SECTION_TIMEOUT"
  if (( CURL_TIMEOUT > REMAINING_SEC - 5 )); then CURL_TIMEOUT=$((REMAINING_SEC - 5)); fi
  HEADERS_FILE="$(mktemp)"
  # -f is deliberately not used: 202/403/503 responses must be classified
  # explicitly. Only a real HTTP 200 may even be considered for completion.
  set +e
  HTTP_CODE="$(curl -sS --max-time "$CURL_TIMEOUT" \
    -D "$HEADERS_FILE" -o /dev/null -w '%{http_code}' \
    -H 'X-SHEIN-BI-HOST-LOCKED-WORKER: 1' \
    "$PORTAL_URL/api/bi/section/$SECTION?refresh=1")"
  CURL_STATUS=$?
  set -e
  if [[ "$CURL_STATUS" -ne 0 ]]; then
    queue_command fail --section "$SECTION" --lease-id "$LEASE_ID" \
      --error "curl status=$CURL_STATUS" >/dev/null
    echo "[portal-section-worker] section=$SECTION failed status=$CURL_STATUS" >&2
    FAILED_SECTIONS+=("$SECTION:$CURL_STATUS")
  elif [[ "$HTTP_CODE" != "200" ]]; then
    # A 202 pending / 403 / 503 / 500 is never a completed section: the cache
    # is not terminal yet. Fail the lease so the entry stays in the queue.
    queue_command fail --section "$SECTION" --lease-id "$LEASE_ID" \
      --error "curl http=$HTTP_CODE non-200 never completes" >/dev/null
    echo "[portal-section-worker] section=$SECTION failed status=$HTTP_CODE (non-200)" >&2
    FAILED_SECTIONS+=("$SECTION:$HTTP_CODE")
  elif grep -qiE '^X-BI-Section-(Stale|Refresh-Failed):[[:space:]]*true' "$HEADERS_FILE"; then
    # A 200 that still carries a stale-source or failed-refresh marker is a
    # failed refresh, not a completed section. Only a fresh, healthy cache may
    # complete the queue entry.
    STATUS=78
    queue_command fail --section "$SECTION" --lease-id "$LEASE_ID" \
      --error "curl status=200 but stale/failed refresh header" >/dev/null
    echo "[portal-section-worker] section=$SECTION failed status=$STATUS (2xx carried stale/failed refresh marker)" >&2
    FAILED_SECTIONS+=("$SECTION:$STATUS")
  else
    # A clean 200 is still not terminal until the artifact on disk matches the
    # current core generation. Verify the exact section file readback.
    set +e
    TERMINAL_REPORT="$(node scripts/check_bi_portal_section_terminal.mjs \
      --root "$PORTAL_ROOT" --section "$SECTION" 2>&1)"
    TERMINAL_STATUS=$?
    set -e
    if [[ "$TERMINAL_STATUS" -eq 0 ]]; then
      COMPLETE_REPORT="$(queue_command complete --section "$SECTION" --lease-id "$LEASE_ID")"
      COMPLETED="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.completed===true))' "$COMPLETE_REPORT")"
      if [[ "$COMPLETED" != "true" ]]; then
        echo "[portal-section-worker] section=$SECTION superseded; newer revision remains pending"
      fi
      echo "[portal-section-worker] section=$SECTION done"
    else
      queue_command fail --section "$SECTION" --lease-id "$LEASE_ID" \
        --error "terminal readback failed code=$TERMINAL_STATUS" >/dev/null
      echo "[portal-section-worker] section=$SECTION failed status=$TERMINAL_STATUS (terminal readback: $(printf '%s' "$TERMINAL_REPORT" | tail -c 240))" >&2
      FAILED_SECTIONS+=("$SECTION:$TERMINAL_STATUS")
    fi
  fi
  rm -f "$HEADERS_FILE"
done
if [[ "${#FAILED_SECTIONS[@]}" -gt 0 ]]; then
  # A terminal artifact from before this lease does not prove the requested
  # revision refreshed. The distinct-section claim rule prevents a later slot
  # from re-claiming the same section, so any recorded lease failure remains a
  # real service failure and stays visible to the watchdog.
  echo "[portal-section-worker] failed sections=$(IFS=,; echo "${FAILED_SECTIONS[*]}")" >&2
  exit 1
fi
echo "[portal-section-worker] done"
