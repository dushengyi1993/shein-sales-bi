#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
MIN_START_BUDGET_SEC="${SHEIN_BI_MARKETING_REPAIR_MIN_START_BUDGET_SEC:-900}"
STACK_REVIEW_TIMEOUT_SEC="${SHEIN_BI_MARKETING_STACK_REVIEW_TIMEOUT_SEC:-900}"
STACK_REVIEW_KILL_AFTER_SEC="${SHEIN_BI_MARKETING_STACK_REVIEW_KILL_AFTER_SEC:-60}"
SCAN_TIMEOUT_SEC="${SHEIN_BI_MARKETING_LIVE_SCAN_TIMEOUT_SEC:-2400}"
SCAN_KILL_AFTER_SEC="${SHEIN_BI_MARKETING_LIVE_SCAN_KILL_AFTER_SEC:-60}"
TERMINAL_SNAPSHOT_SAFETY_MARGIN_SEC="${SHEIN_BI_MARKETING_TERMINAL_SNAPSHOT_SAFETY_MARGIN_SEC:-180}"
HOST_FINALIZATION_RESERVE_SEC="${SHEIN_BI_MARKETING_HOST_FINALIZATION_RESERVE_SEC:-4500}"
STATE_DIR="${SHEIN_BI_MARKETING_LIVE_STATE_DIR:-$ROOT/state/cloud_marketing_live_guard}"
IMMEDIATE_AUTHORIZATION_FILE="${SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE:-/srv/shein-bi/marketing-repair-immediate/authorization.json}"
EXPLICIT_IMMEDIATE_RUN="${SHEIN_BI_MARKETING_IMMEDIATE_RUN:-}"
AUTHORIZATION_PRESENT=0
if [[ -e "$IMMEDIATE_AUTHORIZATION_FILE" || -L "$IMMEDIATE_AUTHORIZATION_FILE" ]]; then
  AUTHORIZATION_PRESENT=1
fi

HOUR="$(TZ="$TZ_NAME" date +%H)"
HOUR=$((10#$HOUR))
MINUTE="$(TZ="$TZ_NAME" date +%M)"
MINUTE=$((10#$MINUTE))
TODAY="$(TZ="$TZ_NAME" date +%F)"
NOW_EPOCH="$(date +%s)"
QUEUE_FILE="$STATE_DIR/repair-queues/marketing-repair-${TODAY}.json"
IMMEDIATE_CONTINUATION=0
IMMEDIATE_RESULT=""
IMMEDIATE_ISSUED_CURRENT=0

# A pending source wins only when it still exactly binds this date and current
# queue. A stale manual authorization artifact is audit evidence, not a normal
# scheduled-run mode switch. If it was already atomically claimed/consumed
# before a crash, discover only an immutable receipt that still exactly binds
# this date and current queue; this is continuation-only admission.
if (( AUTHORIZATION_PRESENT == 1 )); then
  if IMMEDIATE_RESULT="$(node "$ROOT/scripts/manage_cloud_marketing_immediate_run.mjs" verify-issued \
      --date "$TODAY" --queue "$QUEUE_FILE" --root "$ROOT" \
      --authorization-file "$IMMEDIATE_AUTHORIZATION_FILE" --time-zone "$TZ_NAME")"; then
    IMMEDIATE_RUN=true
    IMMEDIATE_ISSUED_CURRENT=1
  else
    status=$?
    if [[ "$EXPLICIT_IMMEDIATE_RUN" == "true" ]]; then
      echo "[marketing-fallback-slot] immediate authorization verification failed; no consume occurred" >&2
      exit "$status"
    fi
    IMMEDIATE_RUN=false
  fi
elif [[ -f "$QUEUE_FILE" && -d "$(dirname "$IMMEDIATE_AUTHORIZATION_FILE")" ]]; then
  if IMMEDIATE_RESULT="$(node "$ROOT/scripts/manage_cloud_marketing_immediate_run.mjs" find-continuation \
      --date "$TODAY" --queue "$QUEUE_FILE" --root "$ROOT" \
      --authorization-file "$IMMEDIATE_AUTHORIZATION_FILE" --time-zone "$TZ_NAME" \
      --scheduled-discovery)"; then
    if [[ "$(printf '%s' "$IMMEDIATE_RESULT" | node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(v.continuation===true?"1":"0")')" == "1" ]]; then
      IMMEDIATE_RUN=true
      IMMEDIATE_CONTINUATION=1
    elif [[ "$(printf '%s' "$IMMEDIATE_RESULT" | node -e 'const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(0,"utf8"));process.stdout.write(v.stale===true?"1":"0")')" == "1" ]]; then
      if [[ "$EXPLICIT_IMMEDIATE_RUN" == "true" ]]; then
        echo "[marketing-fallback-slot] stale continuation cannot be used for explicit immediate run; no consume occurred" >&2
        exit 64
      fi
      echo "[marketing-fallback-slot] stale continuation ignored for scheduled run; no marketing writes" >&2
      IMMEDIATE_RUN=false
    elif [[ -n "$EXPLICIT_IMMEDIATE_RUN" ]]; then
      IMMEDIATE_RUN="$EXPLICIT_IMMEDIATE_RUN"
    else
      IMMEDIATE_RUN=false
    fi
  else
    status=$?
    echo "[marketing-fallback-slot] immutable authorization continuation discovery failed closed" >&2
    exit "$status"
  fi
elif [[ -n "$EXPLICIT_IMMEDIATE_RUN" ]]; then
  IMMEDIATE_RUN="$EXPLICIT_IMMEDIATE_RUN"
else
  IMMEDIATE_RUN=false
fi

if [[ ! "$MIN_START_BUDGET_SEC" =~ ^[0-9]+$ ]] || (( MIN_START_BUDGET_SEC < 900 )); then
  echo "[marketing-fallback-slot] invalid minimum start budget: $MIN_START_BUDGET_SEC" >&2
  exit 64
fi

for deadline_value_name in STACK_REVIEW_TIMEOUT_SEC STACK_REVIEW_KILL_AFTER_SEC SCAN_TIMEOUT_SEC SCAN_KILL_AFTER_SEC TERMINAL_SNAPSHOT_SAFETY_MARGIN_SEC HOST_FINALIZATION_RESERVE_SEC; do
  deadline_value="${!deadline_value_name}"
  if [[ ! "$deadline_value" =~ ^[0-9]+$ ]]; then
    echo "[marketing-fallback-slot] invalid deadline contract value ${deadline_value_name}=${deadline_value}" >&2
    exit 64
  fi
done
if (( STACK_REVIEW_TIMEOUT_SEC < 1 || STACK_REVIEW_KILL_AFTER_SEC < 1 \
    || SCAN_TIMEOUT_SEC < 1 || SCAN_KILL_AFTER_SEC < 1 \
    || TERMINAL_SNAPSHOT_SAFETY_MARGIN_SEC < 60 )); then
  echo "[marketing-fallback-slot] terminal snapshot timeout contract is below its safe minimum" >&2
  exit 64
fi
TERMINAL_SNAPSHOT_BOUND_SEC=$((
  STACK_REVIEW_TIMEOUT_SEC + STACK_REVIEW_KILL_AFTER_SEC
  + SCAN_TIMEOUT_SEC + SCAN_KILL_AFTER_SEC
  + TERMINAL_SNAPSHOT_SAFETY_MARGIN_SEC
))
REQUIRED_HOST_FINALIZATION_SEC=$((MIN_START_BUDGET_SEC + TERMINAL_SNAPSHOT_BOUND_SEC))
if (( HOST_FINALIZATION_RESERVE_SEC < REQUIRED_HOST_FINALIZATION_SEC )); then
  echo "[marketing-fallback-slot] host finalization reserve is too short: configured=${HOST_FINALIZATION_RESERVE_SEC}s required=${REQUIRED_HOST_FINALIZATION_SEC}s" >&2
  exit 64
fi

if [[ "$IMMEDIATE_RUN" != "true" && "$IMMEDIATE_RUN" != "false" ]]; then
  echo "[marketing-fallback-slot] invalid immediate-run flag: $IMMEDIATE_RUN" >&2
  exit 64
fi

IMMEDIATE_MODE=0
IMMEDIATE_FIELDS=()
if [[ "$IMMEDIATE_RUN" == "true" ]]; then
  if (( AUTHORIZATION_PRESENT == 0 && IMMEDIATE_CONTINUATION == 0 )); then
    echo "[marketing-fallback-slot] immediate mode requires the authorization artifact" >&2
    exit 64
  fi
  if (( IMMEDIATE_CONTINUATION == 0 && IMMEDIATE_ISSUED_CURRENT == 0 )); then
    if IMMEDIATE_RESULT="$(node "$ROOT/scripts/manage_cloud_marketing_immediate_run.mjs" verify-issued \
        --date "$TODAY" --queue "$QUEUE_FILE" --root "$ROOT" \
        --authorization-file "$IMMEDIATE_AUTHORIZATION_FILE" --time-zone "$TZ_NAME")"; then
      :
    else
      status=$?
      echo "[marketing-fallback-slot] immediate authorization verification failed; no consume occurred" >&2
      exit "$status"
    fi
  fi
  if ! mapfile -t IMMEDIATE_FIELDS < <(printf '%s' "$IMMEDIATE_RESULT" | node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(0, "utf8"));
const fields = [
  value.authorizationId,
  value.date,
  value.queueStateSha256,
  value.queueFingerprint,
  value.sourceGuardHash,
  value.maxGroups,
  value.gracefulCutoffEpoch,
  value.outerHardDeadlineEpoch,
  value.reason,
  value.receiptFile || "none",
  value.receiptSha256 || "none",
  value.status,
];
if (fields.some(value => value === undefined || value === null || /[\r\n]/.test(String(value)))) {
  throw new Error("immediate verify output is incomplete or contains unsafe fields");
}
process.stdout.write(fields.map(value => String(value)).join("\n"));
'); then
    echo "[marketing-fallback-slot] immediate authorization verify output could not be parsed" >&2
    exit 64
  fi
  if [[ "${#IMMEDIATE_FIELDS[@]}" -ne 12 ]]; then
    echo "[marketing-fallback-slot] immediate authorization verify output has an invalid field count" >&2
    exit 64
  fi
  IMMEDIATE_MODE=1
  IMMEDIATE_AUTHORIZATION_ID="${IMMEDIATE_FIELDS[0]}"
  IMMEDIATE_AUTHORIZATION_DATE="${IMMEDIATE_FIELDS[1]}"
  IMMEDIATE_QUEUE_STATE_SHA256="${IMMEDIATE_FIELDS[2]}"
  IMMEDIATE_QUEUE_FINGERPRINT="${IMMEDIATE_FIELDS[3]}"
  IMMEDIATE_SOURCE_GUARD_HASH="${IMMEDIATE_FIELDS[4]}"
  IMMEDIATE_MAX_GROUPS="${IMMEDIATE_FIELDS[5]}"
  IMMEDIATE_GRACEFUL_CUTOFF_EPOCH="${IMMEDIATE_FIELDS[6]}"
  IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH="${IMMEDIATE_FIELDS[7]}"
  IMMEDIATE_REASON="${IMMEDIATE_FIELDS[8]}"
  IMMEDIATE_RECEIPT_FILE="${IMMEDIATE_FIELDS[9]}"
  IMMEDIATE_RECEIPT_SHA256="${IMMEDIATE_FIELDS[10]}"
  IMMEDIATE_RECEIPT_STATUS="${IMMEDIATE_FIELDS[11]}"
  NOW_EPOCH="$(date +%s)"
  if [[ "$IMMEDIATE_AUTHORIZATION_DATE" != "$TODAY" ]]; then
    echo "[marketing-fallback-slot] immediate authorization date drifted after verification" >&2
    exit 64
  fi
  if [[ ! "$IMMEDIATE_GRACEFUL_CUTOFF_EPOCH" =~ ^[1-9][0-9]*$ ]] \
    || [[ ! "$IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH" =~ ^[1-9][0-9]*$ ]]; then
    echo "[marketing-fallback-slot] immediate authorization deadlines are invalid" >&2
    exit 64
  fi
  if (( IMMEDIATE_CONTINUATION == 0 && IMMEDIATE_GRACEFUL_CUTOFF_EPOCH - NOW_EPOCH < MIN_START_BUDGET_SEC )); then
    echo "[marketing-fallback-slot] immediate authorization graceful cutoff has insufficient remaining budget" >&2
    exit 64
  fi
  if (( IMMEDIATE_CONTINUATION == 1 && NOW_EPOCH >= IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH )); then
    echo "[marketing-fallback-slot] immutable authorization continuation is past outer hard deadline" >&2
    exit 64
  fi
  if (( IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH < IMMEDIATE_GRACEFUL_CUTOFF_EPOCH + MIN_START_BUDGET_SEC )); then
    echo "[marketing-fallback-slot] immediate authorization outer deadline lacks the graceful/finalization safety margin" >&2
    exit 64
  fi
  if [[ ! "$IMMEDIATE_MAX_GROUPS" =~ ^[1-9][0-9]*$ ]] || (( IMMEDIATE_MAX_GROUPS > 32 )); then
    echo "[marketing-fallback-slot] immediate authorization maxGroups is outside 1 through 32" >&2
    exit 64
  fi
  GRACEFUL_CUTOFF_EPOCH="$IMMEDIATE_GRACEFUL_CUTOFF_EPOCH"
  OUTER_HARD_DEADLINE_EPOCH="$IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH"
else
  # The existing 20:45/21:15 timer remains the only scheduler. A started run
  # may continue through the same-day fallback window; the broad acceptance
  # range only matters if systemd starts the same service after a transient
  # lock/resource defer. The worker gates every new group independently.
  if ! ((
    (HOUR == 20 && MINUTE >= 45)
    || (HOUR == 21 && MINUTE >= 15)
    || HOUR == 22
  )); then
    echo "[marketing-fallback-slot] outside 20:45-22:55 same-day fallback window; defer"
    exit 75
  fi

  if ! GRACEFUL_CUTOFF_EPOCH="$(TZ="$TZ_NAME" date -d "${TODAY} 22:55:00" +%s)"; then
    echo "[marketing-fallback-slot] unable to resolve same-day graceful cutoff" >&2
    exit 75
  fi
  if ! OUTER_HARD_DEADLINE_EPOCH="$(TZ="$TZ_NAME" date -d "${TODAY} 23:10:00" +%s)"; then
    echo "[marketing-fallback-slot] unable to resolve same-day outer deadline" >&2
    exit 75
  fi
  if [[ ! "$GRACEFUL_CUTOFF_EPOCH" =~ ^[0-9]+$ ]] || [[ ! "$OUTER_HARD_DEADLINE_EPOCH" =~ ^[0-9]+$ ]]; then
    echo "[marketing-fallback-slot] resolved deadlines are invalid" >&2
    exit 75
  fi
  if (( OUTER_HARD_DEADLINE_EPOCH <= GRACEFUL_CUTOFF_EPOCH )); then
    echo "[marketing-fallback-slot] outer deadline must be later than graceful cutoff" >&2
    exit 75
  fi
  if (( OUTER_HARD_DEADLINE_EPOCH - GRACEFUL_CUTOFF_EPOCH < MIN_START_BUDGET_SEC )); then
    echo "[marketing-fallback-slot] outer deadline has less than the minimum group safety margin" >&2
    exit 75
  fi
  if (( NOW_EPOCH >= GRACEFUL_CUTOFF_EPOCH || GRACEFUL_CUTOFF_EPOCH - NOW_EPOCH < MIN_START_BUDGET_SEC )); then
    echo "[marketing-fallback-slot] insufficient same-day group budget; defer"
    exit 75
  fi
fi

export SHEIN_BI_MARKETING_CLOUD_FALLBACK_ENABLED=true
export SHEIN_BI_MARKETING_REPAIR_GRACEFUL_CUTOFF_EPOCH="$GRACEFUL_CUTOFF_EPOCH"
export SHEIN_BI_MARKETING_REPAIR_SLOT_HARD_DEADLINE_EPOCH="$OUTER_HARD_DEADLINE_EPOCH"
export SHEIN_BI_MARKETING_REPAIR_MIN_START_BUDGET_SEC="$MIN_START_BUDGET_SEC"
if (( IMMEDIATE_MODE == 1 )); then
  export SHEIN_BI_MARKETING_IMMEDIATE_RUN=true
  export SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE="$IMMEDIATE_AUTHORIZATION_FILE"
  export SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_ID="$IMMEDIATE_AUTHORIZATION_ID"
  export SHEIN_BI_MARKETING_IMMEDIATE_DATE="$IMMEDIATE_AUTHORIZATION_DATE"
  export SHEIN_BI_MARKETING_IMMEDIATE_QUEUE_STATE_SHA256="$IMMEDIATE_QUEUE_STATE_SHA256"
  export SHEIN_BI_MARKETING_IMMEDIATE_QUEUE_FINGERPRINT="$IMMEDIATE_QUEUE_FINGERPRINT"
  export SHEIN_BI_MARKETING_IMMEDIATE_SOURCE_GUARD_HASH="$IMMEDIATE_SOURCE_GUARD_HASH"
  export SHEIN_BI_MARKETING_IMMEDIATE_MAX_GROUPS="$IMMEDIATE_MAX_GROUPS"
  export SHEIN_BI_MARKETING_IMMEDIATE_GRACEFUL_CUTOFF_EPOCH="$IMMEDIATE_GRACEFUL_CUTOFF_EPOCH"
  export SHEIN_BI_MARKETING_IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH="$IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH"
  export SHEIN_BI_MARKETING_IMMEDIATE_REASON="$IMMEDIATE_REASON"
  export SHEIN_BI_MARKETING_IMMEDIATE_CONTINUATION="$IMMEDIATE_CONTINUATION"
  if (( IMMEDIATE_CONTINUATION == 1 )); then
    export SHEIN_BI_MARKETING_IMMEDIATE_RECEIPT_FILE="$IMMEDIATE_RECEIPT_FILE"
    export SHEIN_BI_MARKETING_IMMEDIATE_RECEIPT_SHA256="$IMMEDIATE_RECEIPT_SHA256"
    export SHEIN_BI_MARKETING_IMMEDIATE_RECEIPT_STATUS="$IMMEDIATE_RECEIPT_STATUS"
  fi
  export SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS="$IMMEDIATE_MAX_GROUPS"
fi

# The worker owns the real outer deadline. Keep the host-heavy watchdog alive
# through the sequential inventory-recovery reserve followed by the declared
# terminal 19-store snapshot bound. This does not extend the executor write
# window: every executor still receives OUTER_HARD_DEADLINE_EPOCH unchanged.
HOST_HARD_DEADLINE_EPOCH="$OUTER_HARD_DEADLINE_EPOCH"
# This applies to both the ordinary fallback and the immediate path: the
# executor's outer deadline is the no-new-write boundary, while the wrapper's
# watchdog must remain alive for the bounded inventory finally/restore/readback
# window after it.
HOST_HARD_DEADLINE_EPOCH=$((OUTER_HARD_DEADLINE_EPOCH + HOST_FINALIZATION_RESERVE_SEC))
deadline_args=(--deadline-epoch "$HOST_HARD_DEADLINE_EPOCH")

exec /usr/bin/env bash "$ROOT/scripts/run_host_heavy_job.sh" \
  --domain marketing-repair --class browser --lock-wait-sec 0 \
  "${deadline_args[@]}" \
  --defer-state /srv/shein-bi/runtime/host-scheduler/marketing-repair.latest.json \
  --defer-reason deferred_to_local -- \
  /usr/bin/env bash "$ROOT/scripts/cloud_marketing_repair_worker.sh"
