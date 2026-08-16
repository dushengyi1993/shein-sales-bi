#!/usr/bin/env bash
set -Eeuo pipefail

# Single systemd entry point for the cloud morning chain.
#
# The service unit uses Restart=on-failure so a crashed/interrupted run is
# resumed by the same service instead of waiting for the next timer slot.  To
# make that resume lossless, this wrapper:
#   1. atomically persists an active run context (runDate/businessDate and the
#      FIRST-START absolute deadline) in state/cloud_morning_chain/active.json
#      before invoking the chain.  The deadline is persisted once and reused on
#      every restart of the same runDate, so a mid-run interruption can never
#      reset the daily run budget;
#   2. on every start recovers the active context first (same runDate and
#      businessDate), so a mid-run interruption never loses which business day
#      was being refreshed;
#   3. injects immutable SHEIN_BI_MORNING_RUN_DATE /
#      SHEIN_BI_MORNING_BUSINESS_DATE and the persisted first-start absolute
#      SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH into the child chain, so neither
#      the date pair nor the run budget can change after midnight or across
#      restarts;
#   4. enforces businessDate == runDate - 1 (Asia/Shanghai calendar day) for
#      every accepted context, so a malformed / mismatched context (including
#      runDate == businessDate) fails closed and is replaced by a correctly
#      derived fresh pair;
#   5. after a successful child run verifies the SINGLE authoritative
#      completion record: the exact daily-operating-refresh pipeline marker
#      (ok=true, status=done, matching stage/runDate/businessDate) before
#      clearing the context.  There is no second artifact, so a crash between
#      "marker done" and any other file can never wedge a successfully
#      completed child in a permanent restart livelock: the resumed child
#      self-heals through its own idempotent marker skip and the wrapper sees
#      the same single evidence;
#   6. when the persisted first-start deadline has already been reached, the
#      run converges to an explicit terminal failure (failed latest.json +
#      failed morning-all marker + cloud_ops_alert, visible to the watchdog)
#      and exits 0 so Restart=on-failure can never spin forever past the
#      deadline.  An incomplete run is NEVER reported as success: exit 0 only
#      ever means "terminal state recorded" (done marker, or convergent
#      deadline failure with watchdog-visible evidence).
#
# No credentials are stored or printed.  The only mutable state is the active
# context file in state/cloud_morning_chain (atomically replaced, mode 0660).

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
STATE_DIR="${SHEIN_BI_MORNING_CHAIN_STATE_DIR:-$ROOT/state/cloud_morning_chain}"
ACTIVE_FILE="$STATE_DIR/active.json"
MARKER_ROOT="${SHEIN_BI_PIPELINE_MARKER_ROOT:-$ROOT/state/pipeline-markers}"
CHAIN_SCRIPT="${SHEIN_BI_MORNING_CHAIN_SCRIPT:-$ROOT/scripts/cloud_morning_chain.sh}"
RUN_BUDGET_SEC="${SHEIN_BI_MORNING_RUN_BUDGET_SEC:-10200}"

usage() {
  cat >&2 <<'EOF'
Usage:
  run_cloud_morning_chain_job.sh [--root DIR]

Environment (all optional):
  SHEIN_BI_MORNING_CHAIN_STATE_DIR     active-context directory
  SHEIN_BI_PIPELINE_MARKER_ROOT        pipeline marker root
  SHEIN_BI_MORNING_CHAIN_SCRIPT        child chain script path (tests only)
  SHEIN_BI_MORNING_RUN_BUDGET_SEC      first-start budget for a fresh run window
  SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH  absolute first-start deadline override (tests only)
EOF
  exit 64
}

while (($#)); do
  case "$1" in
    --root) (($# >= 2)) || usage; ROOT="$2"; shift 2 ;;
    *) usage ;;
  esac
done

mktoday() {
  TZ="$TZ_NAME" date +%F
}

prev_day() {
  TZ="$TZ_NAME" date -d "$1 - 1 day" +%F
}

valid_date() {
  local value="$1"
  [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || return 1
  TZ="$TZ_NAME" date -d "$value" +%F >/dev/null 2>&1 || return 1
}

now_epoch() {
  date +%s
}

now_iso() {
  TZ="$TZ_NAME" date --iso-8601=seconds
}

# A recovered context is trustworthy only when the date pair is calendar-valid
# AND businessDate is exactly runDate - 1 AND the persisted first-start
# deadline is a positive number.  Anything else (missing, malformed,
# mismatched pair, runDate == businessDate, missing/non-numeric deadline)
# prints nothing so the caller replaces it with a correctly derived fresh run.
# Prints the persisted active context as "runDate businessDate deadlineEpoch".
read_active_context() {
  ACTIVE_FILE="$ACTIVE_FILE" node - <<'NODE' 2>/dev/null || true
const fs = require('fs');
try {
  const payload = JSON.parse(fs.readFileSync(process.env.ACTIVE_FILE, 'utf8'));
  const runDate = String(payload?.runDate || '');
  const businessDate = String(payload?.businessDate || '');
  const deadline = Number(payload?.deadlineEpoch);
  const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (valid(runDate) && valid(businessDate) && Number.isFinite(deadline) && deadline > 0) {
    process.stdout.write(`${runDate} ${businessDate} ${deadline}\n`);
  }
} catch {}
NODE
}

write_active_context() {
  local run_date="$1"
  local business_date="$2"
  local attempt="$3"
  local deadline="$4"
  mkdir -p "$STATE_DIR"
  RUN_DATE="$run_date" BUSINESS_DATE="$business_date" ATTEMPT="$attempt" DEADLINE_EPOCH="$deadline" \
  ACTIVE_FILE="$ACTIVE_FILE" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const file = process.env.ACTIVE_FILE;
const payload = {
  runDate: process.env.RUN_DATE,
  businessDate: process.env.BUSINESS_DATE,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  pid: process.pid,
  attempt: Number(process.env.ATTEMPT || 1),
  deadlineEpoch: Number(process.env.DEADLINE_EPOCH || 0),
};
fs.mkdirSync(path.dirname(file), {recursive: true});
const temporary = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {mode: 0o660});
fs.renameSync(temporary, file);
NODE
}

clear_active_context() {
  local run_date="$1"
  rm -f -- "$ACTIVE_FILE"
  echo "[cloud-morning-chain-wrapper] active context cleared runDate=$run_date"
}

# SINGLE authoritative completion evidence for one run: the exact
# daily-operating-refresh pipeline marker (ok=true, status=done,
# stage/runDate/businessDate all match).  There is deliberately no second
# artifact: the child chain's own idempotent resume-skip already keys on this
# exact marker, so a successfully completed child can always self-heal, and
# nothing outside the marker can fake completion.
daily_run_completed() {
  local run_date="$1"
  local business_date="$2"
  MARKER_ROOT="$MARKER_ROOT" STATE_DIR="$STATE_DIR" \
  RUN_DATE="$run_date" BUSINESS_DATE="$business_date" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const markerFile = path.join(process.env.MARKER_ROOT, process.env.RUN_DATE, 'daily-operating-refresh.json');
try {
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  const markerOk = marker?.ok === true
    && marker?.status === 'done'
    && marker?.stage === 'daily-operating-refresh'
    && marker?.runDate === process.env.RUN_DATE
    && marker?.businessDate === process.env.BUSINESS_DATE;
  process.exit(markerOk ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

# Current latest.json status (missing/unreadable prints nothing).
latest_state_status() {
  STATE_DIR="$STATE_DIR" node - <<'NODE' 2>/dev/null || true
const fs = require('fs');
const path = require('path');
try {
  const payload = JSON.parse(fs.readFileSync(path.join(process.env.STATE_DIR, 'latest.json'), 'utf8'));
  process.stdout.write(String(payload?.status || ''));
} catch {}
NODE
}

latest_state_matches_run() {
  local run_date="$1"
  local business_date="$2"
  STATE_DIR="$STATE_DIR" RUN_DATE="$run_date" BUSINESS_DATE="$business_date" node - <<'NODE'
const fs = require('fs');
const path = require('path');
try {
  const payload = JSON.parse(fs.readFileSync(path.join(process.env.STATE_DIR, 'latest.json'), 'utf8'));
  process.exit(payload?.date === process.env.RUN_DATE
    && payload?.businessDate === process.env.BUSINESS_DATE ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

# Terminal deadline convergence (idempotent).  Only a non-terminal latest state
# (missing / running / waiting / waiting_resource) is replaced with failed.
# An existing failed/deferred/partial latest state keeps its original failure
# reason ONLY when latest.date/businessDate exactly match this logical run;
# stale, cross-day or date-less terminal state is atomically replaced with the
# current run's deadline failure so the watchdog sees the current date.  The
# deadline alert and failed morning-all marker are independent of that decision
# and are ALWAYS atomically/idempotently ensured.
write_terminal_deadline_failure() {
  local run_date="$1"
  local business_date="$2"
  local deadline="$3"
  local current_status preserve_latest=0
  current_status="$(latest_state_status)"
  case "$current_status" in
    failed|deferred|partial)
      if latest_state_matches_run "$run_date" "$business_date"; then
        preserve_latest=1
      fi
      ;;
  esac
  if [[ "$preserve_latest" -ne 1 ]]; then
    mkdir -p "$STATE_DIR"
    RUN_DATE="$run_date" BUSINESS_DATE="$business_date" DEADLINE_EPOCH="$deadline" \
    STATE_DIR="$STATE_DIR" SHEIN_BI_ROOT="$ROOT" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const stateDir = process.env.STATE_DIR;
const message = `first-start absolute deadline expired (deadlineEpoch=${process.env.DEADLINE_EPOCH}) before runDate=${process.env.RUN_DATE} businessDate=${process.env.BUSINESS_DATE} could complete; no further automatic attempts in this window; the watchdog surfaces this terminal failure`;
const payload = {
  date: process.env.RUN_DATE,
  businessDate: process.env.BUSINESS_DATE,
  generatedAt: new Date().toISOString(),
  stage: 'all',
  status: 'failed',
  message,
  deadlineEpoch: Number(process.env.DEADLINE_EPOCH || 0),
};
const write = file => {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {mode: 0o660});
  fs.renameSync(temporary, file);
};
write(path.join(stateDir, 'latest.json'));
NODE
  fi

  # Always ensure the deadline-specific alert, including when the child had
  # already converged latest.json to failed/deferred/partial before restart.
  # This is deliberately separate from the latest-state case above.
  RUN_DATE="$run_date" BUSINESS_DATE="$business_date" DEADLINE_EPOCH="$deadline" \
  SHEIN_BI_ROOT="$ROOT" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const file = path.join(process.env.SHEIN_BI_ROOT, 'state', 'cloud_ops_alerts', 'morning-chain-last.json');
const payload = {
  date: process.env.RUN_DATE,
  businessDate: process.env.BUSINESS_DATE,
  generatedAt: new Date().toISOString(),
  stage: 'all',
  status: 'failed',
  message: `first-start absolute deadline expired (deadlineEpoch=${process.env.DEADLINE_EPOCH}) before runDate=${process.env.RUN_DATE} businessDate=${process.env.BUSINESS_DATE} could complete; no further automatic attempts in this window`,
  deadlineEpoch: Number(process.env.DEADLINE_EPOCH || 0),
};
const temporary = `${file}.${process.pid}.tmp`;
fs.mkdirSync(path.dirname(file), {recursive: true});
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {mode: 0o660});
fs.renameSync(temporary, file);
NODE

  # Safe idempotent overwrite: the date-scoped marker must always state that
  # this run window ended because its persisted first-start deadline expired.
  node "$ROOT/scripts/pipeline_marker.mjs" write \
    --stage morning-all \
    --date "$run_date" \
    --business-date "$business_date" \
    --status failed \
    --message "first-start absolute deadline expired deadlineEpoch=$deadline runDate=$run_date businessDate=$business_date; no further automatic attempts in this window" \
    --root "$MARKER_ROOT" >/dev/null
  echo "[cloud-morning-chain-wrapper] converged terminal failure runDate=$run_date businessDate=$business_date deadlineEpoch=$deadline latestStatus=${current_status:-missing}"
}

deadline_expired() {
  local deadline="$1"
  (( $(now_epoch) >= deadline ))
}

# First-start absolute deadline for a fresh run window.  The env override is a
# deterministic test hook; production derives now + budget once, then persists
# the value in active.json so no restart can reset it.
fresh_deadline() {
  if [[ -n "${SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH:-}" ]]; then
    printf '%s\n' "$SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH"
  else
    printf '%s\n' "$(( $(now_epoch) + RUN_BUDGET_SEC ))"
  fi
}

# Runs one child chain invocation with immutable env-injected dates and the
# persisted first-start absolute deadline.  The context is refreshed before
# every attempt so a failure always leaves the exact active run (including the
# deadline) behind for the service Restart to resume.
run_chain_once() {
  local run_date="$1"
  local business_date="$2"
  local attempt="$3"
  local deadline="$4"
  write_active_context "$run_date" "$business_date" "$attempt" "$deadline"
  echo "[cloud-morning-chain-wrapper] start child chain runDate=$run_date businessDate=$business_date deadlineEpoch=$deadline attempt=$attempt"
  set +e
  SHEIN_BI_MORNING_RUN_DATE="$run_date" \
  SHEIN_BI_MORNING_BUSINESS_DATE="$business_date" \
  SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH="$deadline" \
  SHEIN_BI_MORNING_CHAIN_STATE_DIR="$STATE_DIR" \
    /usr/bin/env bash "$CHAIN_SCRIPT" all
  local status=$?
  set -e
  if [[ "$status" -ne 0 ]]; then
    echo "[cloud-morning-chain-wrapper] ERROR child chain failed runDate=$run_date businessDate=$business_date exit=$status; active context (deadlineEpoch=$deadline) kept for service Restart resume" >&2
    return "$status"
  fi
  if ! daily_run_completed "$run_date" "$business_date"; then
    echo "[cloud-morning-chain-wrapper] ERROR child chain exited 0 but the single completion marker (daily-operating-refresh done with matching dates) is missing runDate=$run_date businessDate=$business_date; treated as failure, context kept" >&2
    return 78
  fi
  clear_active_context "$run_date"
  echo "[cloud-morning-chain-wrapper] run completed with marker evidence runDate=$run_date businessDate=$business_date"
}

ATTEMPT=0

# One logical run window for a runDate: reuse the persisted first-start
# deadline; never recompute it.  If the deadline is already reached and the run
# has NOT completed, converge to a terminal failure and exit 0 (so systemd
# stops restarting).  If it HAS completed (self-healed child), just clear the
# context.  A child failure is propagated: the caller exits non-zero and the
# service Restart resumes the SAME context with the SAME deadline.
run_one_date() {
  local run_date="$1"
  local business_date="$2"
  local deadline="$3"
  if deadline_expired "$deadline"; then
    if daily_run_completed "$run_date" "$business_date"; then
      clear_active_context "$run_date"
      echo "[cloud-morning-chain-wrapper] deadline passed but completion marker already present runDate=$run_date businessDate=$business_date; self-healed, context cleared"
      return 0
    fi
    write_terminal_deadline_failure "$run_date" "$business_date" "$deadline"
    return 0
  fi
  ATTEMPT=$((ATTEMPT + 1))
  run_chain_once "$run_date" "$business_date" "$ATTEMPT" "$deadline"
}

mkdir -p "$STATE_DIR"

if [[ ! -f "$CHAIN_SCRIPT" ]]; then
  echo "[cloud-morning-chain-wrapper] ERROR child chain script not found: $CHAIN_SCRIPT" >&2
  exit 64
fi

TODAY="$(mktoday)"
read -r -a RECOVERED_CONTEXT <<<"$(read_active_context)" || true
TODAY_RAN=0

if ((${#RECOVERED_CONTEXT[@]} >= 3)); then
  RECOVERED_RUN_DATE="${RECOVERED_CONTEXT[0]}"
  RECOVERED_BUSINESS_DATE="${RECOVERED_CONTEXT[1]}"
  RECOVERED_DEADLINE="${RECOVERED_CONTEXT[2]}"
  if valid_date "$RECOVERED_RUN_DATE" && valid_date "$RECOVERED_BUSINESS_DATE" \
    && [[ "$RECOVERED_DEADLINE" =~ ^[0-9]+$ ]]; then
    if [[ "$RECOVERED_RUN_DATE" > "$TODAY" ]]; then
      echo "[cloud-morning-chain-wrapper] active context runDate=$RECOVERED_RUN_DATE is in the future; ignored as untrusted and replaced by a fresh today run"
    elif [[ "$(prev_day "$RECOVERED_RUN_DATE")" != "$RECOVERED_BUSINESS_DATE" ]]; then
      echo "[cloud-morning-chain-wrapper] active context is mismatched (businessDate=$RECOVERED_BUSINESS_DATE is not runDate=$RECOVERED_RUN_DATE - 1 day); failed closed and replaced by a correctly derived fresh run"
    else
      echo "[cloud-morning-chain-wrapper] resume active context runDate=$RECOVERED_RUN_DATE businessDate=$RECOVERED_BUSINESS_DATE deadlineEpoch=$RECOVERED_DEADLINE (first-start absolute, reused across restarts)"
      run_one_date "$RECOVERED_RUN_DATE" "$RECOVERED_BUSINESS_DATE" "$RECOVERED_DEADLINE" || exit $?
      if [[ "$RECOVERED_RUN_DATE" == "$TODAY" ]]; then
        TODAY_RAN=1
      fi
    fi
  else
    echo "[cloud-morning-chain-wrapper] active context is malformed; ignored (a fresh run overwrites it)"
  fi
fi

# After a completed/converged recovery of an older runDate, continue with
# today.  Today's run is a NEW logical window: it gets a fresh first-start
# deadline.  A context already equal to today means today's run was handled
# above (completed, converged, or failed with the context kept).
if [[ "$TODAY_RAN" -eq 0 ]]; then
  TODAY_DEADLINE="$(fresh_deadline)"
  echo "[cloud-morning-chain-wrapper] start fresh today run runDate=$TODAY businessDate=$(prev_day "$TODAY") deadlineEpoch=$TODAY_DEADLINE"
  run_one_date "$TODAY" "$(prev_day "$TODAY")" "$TODAY_DEADLINE" || exit $?
fi

echo "[cloud-morning-chain-wrapper] done all required runs; exiting 0"
exit 0
