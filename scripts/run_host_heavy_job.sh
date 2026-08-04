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
DEFER_STATE_FILE=""
DEFER_REASON="host_heavy_unavailable"

usage() {
  cat >&2 <<'EOF'
Usage:
  run_host_heavy_job.sh --domain NAME [--class browser|openapi|materializer]
    [--lock-wait-sec N] [--deadline-minute 0..59]
    [--deadline-next-hour] [--deadline-at HH:MM]
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
  (( DEADLINE_MINUTE >= 0 && DEADLINE_MINUTE <= 59 )) || usage
fi
if [[ -n "$DEADLINE_AT" ]]; then
  [[ "$DEADLINE_AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || usage
  [[ -z "$DEADLINE_MINUTE" && "$DEADLINE_NEXT_HOUR" -eq 0 ]] || usage
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

if [[ -L "$HOST_LOCK" || ! -f "$HOST_LOCK" || ! -r "$HOST_LOCK" || ! -w "$HOST_LOCK" ]]; then
  echo "[host-heavy] invalid shared host lock: $HOST_LOCK" >&2
  record_defer "host_lock_invalid"
  exit 73
fi

# Cross-project contract: host -> project -> domain -> pressure -> command.
source "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$PROJECT_LOCK"
prepare_shared_lock_file "$DOMAIN_LOCK"

exec 9<>"$HOST_LOCK"
if ! flock -w "$LOCK_WAIT_SEC" 9; then
  echo "[host-heavy] defer domain=$DOMAIN reason=host_lock_busy" >&2
  record_defer "${DEFER_REASON}:host_lock_busy"
  exit 75
fi

exec 8<>"$PROJECT_LOCK"
if ! flock -w "$LOCK_WAIT_SEC" 8; then
  echo "[host-heavy] defer domain=$DOMAIN reason=project_lock_busy" >&2
  record_defer "${DEFER_REASON}:project_lock_busy"
  exit 75
fi

exec 7<>"$DOMAIN_LOCK"
if ! flock -w "$LOCK_WAIT_SEC" 7; then
  echo "[host-heavy] defer domain=$DOMAIN reason=domain_lock_busy" >&2
  record_defer "${DEFER_REASON}:domain_lock_busy"
  exit 75
fi

set +e
node "$ROOT/scripts/check_host_resource_pressure.mjs" "--class=$RESOURCE_CLASS"
PRESSURE_STATUS=$?
set -e
if [[ "$PRESSURE_STATUS" -ne 0 ]]; then
  echo "[host-heavy] defer domain=$DOMAIN reason=resource_pressure status=$PRESSURE_STATUS" >&2
  record_defer "${DEFER_REASON}:resource_pressure"
  exit 75
fi

TIMEOUT_ARGS=()
if [[ -n "$DEADLINE_AT" ]]; then
  NOW_EPOCH="$(date +%s)"
  CURRENT_DATE="$(date +%F)"
  DEADLINE_EPOCH="$(date -d "${CURRENT_DATE}T${DEADLINE_AT}:00" +%s)"
  if (( NOW_EPOCH >= DEADLINE_EPOCH )); then
    echo "[host-heavy] defer domain=$DOMAIN reason=deadline_elapsed deadlineAt=$DEADLINE_AT" >&2
    record_defer "${DEFER_REASON}:deadline_elapsed"
    exit 75
  fi
  BUDGET_SEC=$((DEADLINE_EPOCH - NOW_EPOCH))
  TIMEOUT_ARGS=(timeout --signal=TERM --kill-after=30s "${BUDGET_SEC}s")
  echo "[host-heavy] deadline domain=$DOMAIN at=$DEADLINE_AT budgetSec=$BUDGET_SEC"
elif [[ -n "$DEADLINE_MINUTE" ]]; then
  NOW_EPOCH="$(date +%s)"
  CURRENT_MINUTE="$(date +%M)"
  CURRENT_HOUR="$(date +%Y-%m-%dT%H)"
  DEADLINE_EPOCH="$(date -d "${CURRENT_HOUR}:${DEADLINE_MINUTE}:00" +%s)"
  if (( DEADLINE_NEXT_HOUR == 1 )); then
    DEADLINE_EPOCH=$((DEADLINE_EPOCH + 3600))
  elif (( 10#$CURRENT_MINUTE >= DEADLINE_MINUTE )); then
    echo "[host-heavy] defer domain=$DOMAIN reason=deadline_elapsed" >&2
    record_defer "${DEFER_REASON}:deadline_elapsed"
    exit 75
  fi
  BUDGET_SEC=$((DEADLINE_EPOCH - NOW_EPOCH))
  if (( BUDGET_SEC <= 0 )); then
    echo "[host-heavy] defer domain=$DOMAIN reason=deadline_elapsed" >&2
    record_defer "${DEFER_REASON}:deadline_elapsed"
    exit 75
  fi
  TIMEOUT_ARGS=(timeout --signal=TERM --kill-after=30s "${BUDGET_SEC}s")
  echo "[host-heavy] deadline domain=$DOMAIN minute=$DEADLINE_MINUTE budgetSec=$BUDGET_SEC"
fi

echo "[host-heavy] start domain=$DOMAIN class=$RESOURCE_CLASS command=$1"
set +e
"${TIMEOUT_ARGS[@]}" "$@"
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
