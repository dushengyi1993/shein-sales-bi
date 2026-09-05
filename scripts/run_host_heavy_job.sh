#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
HOST_LOCK="${SHEIN_HOST_HEAVY_LOCK_FILE:-/run/lock/shein-host-heavy.lock}"
PROJECT_LOCK="${SHEIN_BI_HOST_PROJECT_LOCK_FILE:-$ROOT/state/locks/shein-bi-host-heavy.lock}"
RESOURCE_CLASS="browser"
DOMAIN=""
LOCK_WAIT_SEC=0
DEADLINE_MINUTE=""
DEADLINE_NEXT_HOUR=0
DEADLINE_AT=""
DEADLINE_EPOCH=""
DEFER_STATE_FILE=""
DEFER_REASON="host_heavy_unavailable"

usage() {
  cat >&2 <<'EOF'
Usage:
  run_host_heavy_job.sh --domain NAME [--class browser|openapi|materializer]
    [--lock-wait-sec N] [--deadline-minute 0..59]
    [--deadline-next-hour] [--deadline-at HH:MM] [--deadline-epoch EPOCH]
    [--defer-state FILE] [--defer-reason TEXT] -- COMMAND [ARG...]
EOF
  exit 64
}

while (($#)); do
  case "$1" in
    --domain)
      (($# >= 2)) || usage
      DOMAIN="$2"
      shift 2
      ;;
    --class)
      (($# >= 2)) || usage
      RESOURCE_CLASS="$2"
      shift 2
      ;;
    --lock-wait-sec)
      (($# >= 2)) || usage
      LOCK_WAIT_SEC="$2"
      shift 2
      ;;
    --deadline-minute)
      (($# >= 2)) || usage
      DEADLINE_MINUTE="$2"
      shift 2
      ;;
    --deadline-next-hour)
      DEADLINE_NEXT_HOUR=1
      shift
      ;;
    --deadline-at)
      (($# >= 2)) || usage
      DEADLINE_AT="$2"
      shift 2
      ;;
    --deadline-epoch)
      (($# >= 2)) || usage
      DEADLINE_EPOCH="$2"
      shift 2
      ;;
    --defer-state)
      (($# >= 2)) || usage
      DEFER_STATE_FILE="$2"
      shift 2
      ;;
    --defer-reason)
      (($# >= 2)) || usage
      DEFER_REASON="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      usage
      ;;
  esac
done

[[ "$DOMAIN" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || usage
[[ "$RESOURCE_CLASS" =~ ^(browser|openapi|materializer)$ ]] || usage
[[ "$LOCK_WAIT_SEC" =~ ^[0-9]+$ ]] || usage
if [[ -n "$DEADLINE_MINUTE" ]]; then
  [[ "$DEADLINE_MINUTE" =~ ^[0-9]+$ ]] || usage
  (( 10#$DEADLINE_MINUTE >= 0 && 10#$DEADLINE_MINUTE <= 59 )) || usage
fi
if [[ -n "$DEADLINE_AT" ]]; then
  [[ "$DEADLINE_AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || usage
  [[ -z "$DEADLINE_MINUTE" && "$DEADLINE_NEXT_HOUR" -eq 0 ]] || usage
fi
if [[ -n "$DEADLINE_EPOCH" ]]; then
  [[ "$DEADLINE_EPOCH" =~ ^[0-9]+$ ]] || usage
fi
(($# > 0)) || usage

DOMAIN_LOCK="${SHEIN_BI_HOST_DOMAIN_LOCK_FILE:-$ROOT/state/locks/shein-bi-host-${DOMAIN}.lock}"

record_defer() {
  local reason="$1"
  local status="${2:-deferred}"
  if [[ "$DEFER_REASON" == "deferred_to_local" && "$status" == "deferred" ]]; then
    status="deferred_to_local"
  fi
  [[ -n "$DEFER_STATE_FILE" ]] || return 0
  mkdir -p "$(dirname -- "$DEFER_STATE_FILE")"
  DOMAIN="$DOMAIN" REASON="$reason" STATUS="$status" STATE_FILE="$DEFER_STATE_FILE" node - <<'NODE'
const fs = require('node:fs');
const file = process.env.STATE_FILE;
const payload = {
  ok: false,
  status: process.env.STATUS || 'deferred',
  reason: process.env.REASON || 'host_heavy_unavailable',
  domain: process.env.DOMAIN || '',
  generatedAt: new Date().toISOString(),
};
const temporary = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {mode: 0o660});
fs.renameSync(temporary, file);
NODE
}

release_locks() {
  exec 6>&- 2>/dev/null || true
  exec 7>&- 2>/dev/null || true
  exec 8>&- 2>/dev/null || true
  exec 9>&- 2>/dev/null || true
}

resolve_effective_deadline() {
  local now_epoch current_date current_hour minute_text clock_epoch epoch_candidate
  now_epoch="$(date +%s)"
  CLOCK_EPOCH=""
  DEADLINE_EPOCH=""
  DEADLINE_LABEL=""

  # Convert every supported wall-clock form to an absolute epoch before any
  # shared lock is prepared or opened. An explicit epoch may accompany a
  # legacy clock argument; the earliest valid absolute deadline wins.
  if [[ -n "$DEADLINE_AT" ]]; then
    current_date="$(date +%F)"
    CLOCK_EPOCH="$(date -d "${current_date}T${DEADLINE_AT}:00" +%s)"
    DEADLINE_EPOCH="$CLOCK_EPOCH"
    DEADLINE_LABEL="at=$DEADLINE_AT"
  elif [[ -n "$DEADLINE_MINUTE" ]]; then
    current_hour="$(date +%Y-%m-%dT%H)"
    printf -v minute_text '%02d' "$((10#$DEADLINE_MINUTE))"
    CLOCK_EPOCH="$(date -d "${current_hour}:${minute_text}:00" +%s)"
    if (( DEADLINE_NEXT_HOUR == 1 )); then
      CLOCK_EPOCH=$((CLOCK_EPOCH + 3600))
    fi
    DEADLINE_EPOCH="$CLOCK_EPOCH"
    DEADLINE_LABEL="minute=$DEADLINE_MINUTE"
  fi

  if [[ -n "$DEADLINE_EPOCH" ]]; then
    # The input was restricted to decimal digits above; 10# also prevents
    # Bash from interpreting a leading-zero epoch as octal.
    DEADLINE_EPOCH=$((10#$DEADLINE_EPOCH))
  fi
  if [[ -n "${DEADLINE_EPOCH_INPUT:-}" ]]; then
    epoch_candidate=$((10#$DEADLINE_EPOCH_INPUT))
    if [[ -z "$DEADLINE_EPOCH" || "$epoch_candidate" -lt "$DEADLINE_EPOCH" ]]; then
      DEADLINE_EPOCH="$epoch_candidate"
      DEADLINE_LABEL="epoch=$DEADLINE_EPOCH_INPUT"
    fi
  fi

  if [[ -n "$DEADLINE_EPOCH" ]] && (( now_epoch >= DEADLINE_EPOCH )); then
    echo "[host-heavy] defer domain=$DOMAIN reason=deadline_elapsed deadline=$DEADLINE_LABEL" >&2
    record_defer "${DEFER_REASON}:deadline_elapsed"
    exit 75
  fi
}

lock_wait_for_current_deadline() {
  local wait="$LOCK_WAIT_SEC"
  if [[ -z "$DEADLINE_EPOCH" ]]; then
    printf '%s\n' "$wait"
    return 0
  fi
  local remaining=$((DEADLINE_EPOCH - $(date +%s)))
  if (( remaining <= 0 )); then return 1; fi
  if (( wait > remaining )); then wait="$remaining"; fi
  printf '%s\n' "$wait"
}

defer_lock_busy() {
  local reason="$1"
  if [[ -n "$DEADLINE_EPOCH" ]] && (( $(date +%s) >= DEADLINE_EPOCH )); then
    reason="deadline_elapsed"
    echo "[host-heavy] defer domain=$DOMAIN reason=deadline_elapsed deadline=$DEADLINE_LABEL" >&2
  else
    echo "[host-heavy] defer domain=$DOMAIN reason=$reason" >&2
  fi
  release_locks
  record_defer "${DEFER_REASON}:$reason"
  exit 75
}

# Preserve the raw epoch separately so --deadline-epoch can be combined with a
# clock form and still participate in the earliest-deadline selection.
DEADLINE_EPOCH_INPUT="$DEADLINE_EPOCH"
resolve_effective_deadline

if [[ "$RESOURCE_CLASS" != "openapi" ]] && [[ -L "$HOST_LOCK" || ! -f "$HOST_LOCK" || ! -r "$HOST_LOCK" || ! -w "$HOST_LOCK" ]]; then
  echo "[host-heavy] invalid shared host lock: $HOST_LOCK" >&2
  record_defer "host_lock_invalid"
  exit 73
fi

# Share maintenance locks across independent domains. OpenAPI owns no browser
# capacity; exact inventory-object locks remain with the existing writers.
source "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$PROJECT_LOCK"
prepare_shared_lock_file "$DOMAIN_LOCK"

if [[ "$RESOURCE_CLASS" != "openapi" ]]; then
exec 9<>"$HOST_LOCK"
CURRENT_LOCK_WAIT="$(lock_wait_for_current_deadline)" || {
  echo "[host-heavy] defer domain=$DOMAIN reason=deadline_elapsed before_host_lock" >&2
  release_locks
  record_defer "${DEFER_REASON}:deadline_elapsed"
  exit 75
}
if ! flock -s -w "$CURRENT_LOCK_WAIT" 9; then
  defer_lock_busy "host_lock_busy"
fi

exec 8<>"$PROJECT_LOCK"
CURRENT_LOCK_WAIT="$(lock_wait_for_current_deadline)" || {
  echo "[host-heavy] defer domain=$DOMAIN reason=deadline_elapsed before_project_lock" >&2
  release_locks
  record_defer "${DEFER_REASON}:deadline_elapsed"
  exit 75
}
if ! flock -s -w "$CURRENT_LOCK_WAIT" 8; then
  defer_lock_busy "project_lock_busy"
fi

fi

exec 7<>"$DOMAIN_LOCK"
CURRENT_LOCK_WAIT="$(lock_wait_for_current_deadline)" || {
  echo "[host-heavy] defer domain=$DOMAIN reason=deadline_elapsed before_domain_lock" >&2
  release_locks
  record_defer "${DEFER_REASON}:deadline_elapsed"
  exit 75
}
if ! flock -w "$CURRENT_LOCK_WAIT" 7; then
  defer_lock_busy "domain_lock_busy"
fi

PRESSURE_CLASS="$RESOURCE_CLASS"
if [[ "$RESOURCE_CLASS" == "browser" ]]; then
  BROWSER_SLOT_0="${SHEIN_BROWSER_READ_SLOT_0:-/run/lock/shein-browser-read-0.lock}"
  BROWSER_SLOT_1="${SHEIN_BROWSER_READ_SLOT_1:-/run/lock/shein-browser-read-1.lock}"
  for slot_file in "$BROWSER_SLOT_0" "$BROWSER_SLOT_1"; do
    if [[ -L "$slot_file" || ! -f "$slot_file" || ! -r "$slot_file" || ! -w "$slot_file" ]]; then
      record_defer "browser_slot_invalid"
      exit 73
    fi
  done
  exec 6<>"$BROWSER_SLOT_1"
  OTHER_SLOT_FILE="$BROWSER_SLOT_0"
  if ! flock -n 6; then
    exec 6>&-
    exec 6<>"$BROWSER_SLOT_0"
    if ! flock -n 6; then defer_lock_busy "browser_slots_busy"; fi
    OTHER_SLOT_FILE="$BROWSER_SLOT_1"
  fi
  exec 5<>"$OTHER_SLOT_FILE"
  if flock -n 5; then flock -u 5; else PRESSURE_CLASS=browser-secondary; fi
  exec 5>&-
fi

set +e
node "$ROOT/scripts/check_host_resource_pressure.mjs" "--class=$PRESSURE_CLASS"
PRESSURE_STATUS=$?
set -e
if [[ "$PRESSURE_STATUS" -ne 0 ]]; then
  echo "[host-heavy] defer domain=$DOMAIN reason=resource_pressure status=$PRESSURE_STATUS" >&2
  release_locks
  record_defer "${DEFER_REASON}:resource_pressure"
  exit 75
fi

TIMEOUT_ARGS=()
if [[ -n "$DEADLINE_EPOCH" ]]; then
  NOW_EPOCH="$(date +%s)"
  BUDGET_SEC=$((DEADLINE_EPOCH - NOW_EPOCH))
  if (( BUDGET_SEC <= 0 )); then
    echo "[host-heavy] defer domain=$DOMAIN reason=deadline_elapsed deadline=$DEADLINE_LABEL" >&2
    release_locks
    record_defer "${DEFER_REASON}:deadline_elapsed"
    exit 75
  fi
  TIMEOUT_ARGS=(timeout --signal=TERM --kill-after=30s "${BUDGET_SEC}s")
  echo "[host-heavy] deadline domain=$DOMAIN $DEADLINE_LABEL budgetSec=$BUDGET_SEC"
fi

echo "[host-heavy] start domain=$DOMAIN class=$RESOURCE_CLASS command=$1"
export SHEIN_BI_HOST_HEAVY_WRAPPED=1
export SHEIN_BI_HOST_HEAVY_DOMAIN="$DOMAIN"
CHILD_FD_CLEAN_COMMAND=(/usr/bin/env bash -c 'exec 6>&- 7>&- 8>&- 9>&-; exec "$@"' --)
set +e
if [[ "${#TIMEOUT_ARGS[@]}" -gt 0 ]]; then
  "${TIMEOUT_ARGS[@]}" "${CHILD_FD_CLEAN_COMMAND[@]}" "$@"
else
  "${CHILD_FD_CLEAN_COMMAND[@]}" "$@"
fi
STATUS=$?
set -e
if [[ "$STATUS" -eq 124 || "$STATUS" -eq 137 || "$STATUS" -eq 143 ]]; then
  if [[ "$DEFER_REASON" == "deferred_to_local" ]]; then
    record_defer "${DEFER_REASON}:deadline_reached" "deferred_to_local"
  else
    record_defer "${DEFER_REASON}:deadline_reached" "partial"
  fi
fi
echo "[host-heavy] done domain=$DOMAIN status=$STATUS"
exit "$STATUS"
