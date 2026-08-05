#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
PORTAL_URL="${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}"
QUEUE_FILE="${SHEIN_BI_PORTAL_SECTION_QUEUE_FILE:-$ROOT/state/portal-section-queue/queue.json}"
LOCK_FILE="${SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE:-$ROOT/state/locks/shein-bi-portal-section-queue.lock}"
MAX_SECTIONS="${SHEIN_BI_PORTAL_SECTION_QUEUE_MAX_SECTIONS:-3}"
SECTION_TIMEOUT="${SHEIN_BI_PORTAL_SECTION_QUEUE_SECTION_TIMEOUT_SEC:-900}"
LEASE_SECONDS="${SHEIN_BI_PORTAL_SECTION_QUEUE_LEASE_SEC:-1200}"
SCHEDULED_ENTRY="${SHEIN_BI_PORTAL_SECTION_QUEUE_SCHEDULED:-0}"
DEADLINE_MINUTE="${SHEIN_BI_PORTAL_SECTION_QUEUE_DEADLINE_MINUTE:-}"
START_HOUR="$(date +%H)"
START_MINUTE="$(date +%M)"

[[ "$MAX_SECTIONS" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$SECTION_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || exit 64
[[ "$DEADLINE_MINUTE" =~ ^[0-9]+$ ]] && (( DEADLINE_MINUTE >= 0 && DEADLINE_MINUTE <= 59 )) || exit 64
if [[ "$SCHEDULED_ENTRY" != "1" ]]; then
  echo "[portal-section-worker] defer reason=unscheduled_direct_entry; use shein-bi-cloud-portal-section-queue.service" >&2
  exit 75
fi
if [[ "$START_HOUR" =~ ^(01|06|08)$ ]] || ! ((
  (10#$START_MINUTE >= 13 && 10#$START_MINUTE <= 16)
  || (10#$START_MINUTE >= 43 && 10#$START_MINUTE <= 46)
)); then
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
  CLAIM="$(queue_command claim --lease-seconds "$LEASE_SECONDS")"
  CLAIM_STATUS=$?
  set -e
  if [[ "$CLAIM_STATUS" -eq 75 ]]; then
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
  echo "[portal-section-worker] section=$SECTION attempt=$index"
  CURL_TIMEOUT="$SECTION_TIMEOUT"
  if (( CURL_TIMEOUT > REMAINING_SEC - 5 )); then CURL_TIMEOUT=$((REMAINING_SEC - 5)); fi
  if curl -fsS --max-time "$CURL_TIMEOUT" \
    -H 'X-SHEIN-BI-HOST-LOCKED-WORKER: 1' \
    "$PORTAL_URL/api/bi/section/$SECTION?refresh=1" >/dev/null; then
    queue_command complete --section "$SECTION" --lease-id "$LEASE_ID" >/dev/null
    echo "[portal-section-worker] section=$SECTION done"
  else
    STATUS=$?
    queue_command fail --section "$SECTION" --lease-id "$LEASE_ID" \
      --error "curl status=$STATUS" >/dev/null
    echo "[portal-section-worker] section=$SECTION failed status=$STATUS" >&2
  fi
done
echo "[portal-section-worker] done"
