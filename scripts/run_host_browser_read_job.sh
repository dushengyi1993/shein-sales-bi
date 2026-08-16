#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only browser lane shared with the full-managed project.
# Half-managed work prefers slot 1; full-managed work prefers slot 0.
# Business writes and DB/IO-heavy jobs continue to use the host lock
# exclusively through run_host_heavy_job.sh.

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
HOST_LOCK="${SHEIN_HOST_HEAVY_LOCK_FILE:-/run/lock/shein-host-heavy.lock}"
BROWSER_SLOT_0="${SHEIN_BROWSER_READ_SLOT_0:-/run/lock/shein-browser-read-0.lock}"
BROWSER_SLOT_1="${SHEIN_BROWSER_READ_SLOT_1:-/run/lock/shein-browser-read-1.lock}"
PROJECT_LOCK="${SHEIN_BI_HOST_PROJECT_LOCK_FILE:-$ROOT/state/locks/shein-bi-host-heavy.lock}"
DOMAIN=""
LOCK_WAIT_SEC=0
DEADLINE_MINUTE=""
DEADLINE_NEXT_HOUR=0
DEADLINE_AT=""
EPOCH_DEADLINE=""
DEFER_STATE_FILE=""
DEFER_REASON="host_browser_read_unavailable"

usage() {
  cat >&2 <<'EOF'
Usage:
  run_host_browser_read_job.sh --domain NAME [--lock-wait-sec N]
    [--deadline-minute 0..59] [--deadline-next-hour] [--deadline-at HH:MM]
    [--deadline-epoch EPOCH_SEC]
    [--defer-state FILE] [--defer-reason TEXT] -- COMMAND [ARG...]
EOF
  exit 64
}

while (($#)); do
  case "$1" in
    --domain) (($# >= 2)) || usage; DOMAIN="$2"; shift 2 ;;
    --lock-wait-sec) (($# >= 2)) || usage; LOCK_WAIT_SEC="$2"; shift 2 ;;
    --deadline-minute) (($# >= 2)) || usage; DEADLINE_MINUTE="$2"; shift 2 ;;
    --deadline-next-hour) DEADLINE_NEXT_HOUR=1; shift ;;
    --deadline-at) (($# >= 2)) || usage; DEADLINE_AT="$2"; shift 2 ;;
    --deadline-epoch) (($# >= 2)) || usage; EPOCH_DEADLINE="$2"; shift 2 ;;
    --defer-state) (($# >= 2)) || usage; DEFER_STATE_FILE="$2"; shift 2 ;;
    --defer-reason) (($# >= 2)) || usage; DEFER_REASON="$2"; shift 2 ;;
    --) shift; break ;;
    *) usage ;;
  esac
done

[[ "$DOMAIN" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || usage
[[ "$LOCK_WAIT_SEC" =~ ^[0-9]+$ ]] || usage
if [[ -n "$DEADLINE_MINUTE" ]]; then
  [[ "$DEADLINE_MINUTE" =~ ^[0-9]+$ ]] || usage
  (( DEADLINE_MINUTE >= 0 && DEADLINE_MINUTE <= 59 )) || usage
fi
if [[ -n "$DEADLINE_AT" ]]; then
  [[ "$DEADLINE_AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || usage
  [[ -z "$DEADLINE_MINUTE" && "$DEADLINE_NEXT_HOUR" -eq 0 ]] || usage
fi
if [[ -n "$EPOCH_DEADLINE" ]]; then
  [[ "$EPOCH_DEADLINE" =~ ^[0-9]+$ ]] || usage
fi
# Backward-compatible epoch fallback: an owning orchestrator (the morning
# chain coordinator) exports its absolute run deadline so every per-store
# wrapper inherits it without any caller-side argument change.
if [[ -z "$EPOCH_DEADLINE" && -n "${SHEIN_HOST_BROWSER_READ_DEADLINE_EPOCH:-}" ]]; then
  EPOCH_DEADLINE="$SHEIN_HOST_BROWSER_READ_DEADLINE_EPOCH"
  [[ "$EPOCH_DEADLINE" =~ ^[0-9]+$ ]] || usage
fi
(($# > 0)) || usage

DOMAIN_LOCK="${SHEIN_BI_HOST_DOMAIN_LOCK_FILE:-$ROOT/state/locks/shein-bi-host-${DOMAIN}.lock}"

record_defer() {
  local reason="$1"
  local status="${2:-deferred}"
  [[ -n "$DEFER_STATE_FILE" ]] || return 0
  mkdir -p "$(dirname -- "$DEFER_STATE_FILE")"
  DOMAIN="$DOMAIN" REASON="$reason" STATUS="$status" STATE_FILE="$DEFER_STATE_FILE" node - <<'NODE'
const fs = require('node:fs');
const file = process.env.STATE_FILE;
const payload = {
  ok: false,
  status: process.env.STATUS || 'deferred',
  reason: process.env.REASON || 'host_browser_read_unavailable',
  domain: process.env.DOMAIN || '',
  generatedAt: new Date().toISOString(),
};
const temporary = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {mode: 0o660});
fs.renameSync(temporary, file);
NODE
}

validate_neutral_lock() {
  local file="$1"
  if [[ -L "$file" || ! -f "$file" || ! -r "$file" || ! -w "$file" ]]; then
    echo "[host-browser-read] invalid neutral lock: $file" >&2
    record_defer "neutral_lock_invalid"
    exit 73
  fi
}

validate_neutral_lock "$HOST_LOCK"
validate_neutral_lock "$BROWSER_SLOT_0"
validate_neutral_lock "$BROWSER_SLOT_1"

# --- Effective deadline resolution, BEFORE any flock ---
#
# The effective deadline is the earlier of the clock deadline
# (--deadline-at / --deadline-minute) and the epoch deadline
# (--deadline-epoch, or the owning coordinator's
# SHEIN_HOST_BROWSER_READ_DEADLINE_EPOCH fallback).  Resolving it here, before
# any lock is taken, guarantees (a) an already-elapsed deadline defers with 75
# immediately without touching locks, and (b) every lock wait is clamped to
# the remaining seconds so a run can never wait a full LOCK_WAIT_SEC past the
# deadline.
CLOCK_EPOCH=""
EPOCH_BUDGET_SEC=""
DEADLINE_EPOCH=""
DEADLINE_LABEL=""
NOW_EPOCH="$(date +%s)"
if [[ -n "$DEADLINE_AT" ]]; then
  CLOCK_EPOCH="$(date -d "$(date +%F)T${DEADLINE_AT}:00" +%s)"
  DEADLINE_EPOCH="$CLOCK_EPOCH"
  DEADLINE_LABEL="at=$DEADLINE_AT"
elif [[ -n "$DEADLINE_MINUTE" ]]; then
  CLOCK_EPOCH="$(date -d "$(date +%Y-%m-%dT%H):${DEADLINE_MINUTE}:00" +%s)"
  if (( DEADLINE_NEXT_HOUR == 1 )); then
    CLOCK_EPOCH=$((CLOCK_EPOCH + 3600))
  fi
  DEADLINE_EPOCH="$CLOCK_EPOCH"
  DEADLINE_LABEL="minute=$DEADLINE_MINUTE"
fi
if [[ -n "$EPOCH_DEADLINE" ]]; then
  if [[ -z "$DEADLINE_EPOCH" || "$EPOCH_DEADLINE" -lt "$DEADLINE_EPOCH" ]]; then
    DEADLINE_EPOCH="$EPOCH_DEADLINE"
    DEADLINE_LABEL="epoch=$EPOCH_DEADLINE"
  fi
fi
if [[ -n "$DEADLINE_EPOCH" ]] && (( NOW_EPOCH >= DEADLINE_EPOCH )); then
  echo "[host-browser-read] defer domain=$DOMAIN reason=deadline_elapsed deadline=$DEADLINE_LABEL" >&2
  record_defer "${DEFER_REASON}:deadline_elapsed"
  exit 75
fi

# Seconds a lock wait may consume before the deadline; exits 75 immediately
# once the deadline has been reached.
lock_wait_remaining() {
  if [[ -z "$DEADLINE_EPOCH" ]]; then
    printf '%s\n' "$LOCK_WAIT_SEC"
    return 0
  fi
  local remaining=$((DEADLINE_EPOCH - $(date +%s)))
  if (( remaining <= 0 )); then
    echo "[host-browser-read] defer domain=$DOMAIN reason=deadline_elapsed deadline=$DEADLINE_LABEL" >&2
    record_defer "${DEFER_REASON}:deadline_elapsed"
    exit 75
  fi
  if (( LOCK_WAIT_SEC > 0 && LOCK_WAIT_SEC < remaining )); then
    printf '%s\n' "$LOCK_WAIT_SEC"
  else
    printf '%s\n' "$remaining"
  fi
}

defer_lock_busy() {
  local reason="$1"
  if [[ -n "$DEADLINE_EPOCH" ]] && (( $(date +%s) >= DEADLINE_EPOCH )); then
    reason="deadline_elapsed"
    echo "[host-browser-read] defer domain=$DOMAIN reason=deadline_elapsed deadline=$DEADLINE_LABEL" >&2
  else
    echo "[host-browser-read] defer domain=$DOMAIN reason=$reason" >&2
  fi
  record_defer "${DEFER_REASON}:$reason"
  exit 75
}

# Cross-project order: host -> project -> domain -> browser slot -> pressure.
source "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$PROJECT_LOCK"
prepare_shared_lock_file "$DOMAIN_LOCK"

exec 9<>"$HOST_LOCK"
if ! flock -s -w "$(lock_wait_remaining)" 9; then
  defer_lock_busy "host_exclusive_busy"
fi

exec 8<>"$PROJECT_LOCK"
if ! flock -s -w "$(lock_wait_remaining)" 8; then
  defer_lock_busy "project_lock_busy"
fi

exec 7<>"$DOMAIN_LOCK"
if ! flock -w "$(lock_wait_remaining)" 7; then
  defer_lock_busy "domain_lock_busy"
fi

BROWSER_SLOT=""
exec 6<>"$BROWSER_SLOT_1"
if flock -n 6; then
  BROWSER_SLOT=1
else
  exec 6>&-
  exec 6<>"$BROWSER_SLOT_0"
  if flock -n 6; then
    BROWSER_SLOT=0
  else
    exec 6>&-
    echo "[host-browser-read] defer domain=$DOMAIN reason=browser_slots_busy" >&2
    record_defer "${DEFER_REASON}:browser_slots_busy"
    exit 75
  fi
fi

OTHER_SLOT=0
[[ "$BROWSER_SLOT" == "0" ]] && OTHER_SLOT=1
OTHER_SLOT_FILE="$BROWSER_SLOT_0"
[[ "$OTHER_SLOT" == "1" ]] && OTHER_SLOT_FILE="$BROWSER_SLOT_1"
PRESSURE_CLASS=browser
exec 5<>"$OTHER_SLOT_FILE"
if flock -n 5; then
  flock -u 5
else
  PRESSURE_CLASS=browser-secondary
fi
exec 5>&-

set +e
node "$ROOT/scripts/check_host_resource_pressure.mjs" "--class=$PRESSURE_CLASS"
PRESSURE_STATUS=$?
set -e
if [[ "$PRESSURE_STATUS" -ne 0 ]]; then
  echo "[host-browser-read] defer domain=$DOMAIN reason=resource_pressure status=$PRESSURE_STATUS" >&2
  record_defer "${DEFER_REASON}:resource_pressure"
  exit 75
fi

TIMEOUT_ARGS=()
BUDGET_SEC=""
CLOCK_BUDGET_SEC=""
NOW_EPOCH="$(date +%s)"
if [[ -n "$CLOCK_EPOCH" ]]; then
  CLOCK_BUDGET_SEC=$((CLOCK_EPOCH - NOW_EPOCH))
  if [[ -n "$DEADLINE_AT" ]]; then
    echo "[host-browser-read] deadline domain=$DOMAIN at=$DEADLINE_AT budgetSec=$CLOCK_BUDGET_SEC"
  else
    echo "[host-browser-read] deadline domain=$DOMAIN minute=$DEADLINE_MINUTE budgetSec=$CLOCK_BUDGET_SEC"
  fi
fi
if [[ -n "$EPOCH_DEADLINE" ]]; then
  EPOCH_BUDGET_SEC=$((EPOCH_DEADLINE - NOW_EPOCH))
  if [[ -z "$CLOCK_BUDGET_SEC" || "$EPOCH_BUDGET_SEC" -lt "$CLOCK_BUDGET_SEC" ]]; then
    BUDGET_SEC="$EPOCH_BUDGET_SEC"
    echo "[host-browser-read] deadline domain=$DOMAIN epoch=$EPOCH_DEADLINE budgetSec=$BUDGET_SEC"
  else
    BUDGET_SEC="$CLOCK_BUDGET_SEC"
  fi
else
  BUDGET_SEC="$CLOCK_BUDGET_SEC"
fi
if [[ -n "$BUDGET_SEC" ]]; then
  if (( BUDGET_SEC <= 0 )); then
    echo "[host-browser-read] defer domain=$DOMAIN reason=deadline_elapsed deadline=$DEADLINE_LABEL" >&2
    record_defer "${DEFER_REASON}:deadline_elapsed"
    exit 75
  fi
  TIMEOUT_ARGS=(timeout --signal=TERM --kill-after=30s "${BUDGET_SEC}s")
fi

echo "[host-browser-read] start domain=$DOMAIN slot=$BROWSER_SLOT pressureClass=$PRESSURE_CLASS command=$1"
export SHEIN_BI_HOST_HEAVY_WRAPPED=1
export SHEIN_BI_HOST_HEAVY_DOMAIN="$DOMAIN"
export SHEIN_BI_HOST_RESOURCE_LANE=browser-read
set +e
"${TIMEOUT_ARGS[@]}" "$@"
STATUS=$?
set -e
if [[ "$STATUS" -eq 124 || "$STATUS" -eq 137 || "$STATUS" -eq 143 ]]; then
  record_defer "${DEFER_REASON}:deadline_reached" "partial"
fi
echo "[host-browser-read] done domain=$DOMAIN slot=$BROWSER_SLOT status=$STATUS"
exit "$STATUS"
