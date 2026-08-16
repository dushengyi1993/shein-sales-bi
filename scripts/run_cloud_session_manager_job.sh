#!/usr/bin/env bash
set -Eeuo pipefail

# Single 00:45 coordinator for the nightly SHEIN login/session maintenance run.
#
# The shared browser-read lane (run_host_browser_read_job.sh) defers with exit
# 75 while the host lock, project/domain lock, browser read slots or the
# resource-pressure gate are unavailable. Historically the session-manager unit
# listed SuccessExitStatus=75, so systemd reported those deferrals as
# successful runs while the inner session manager never started, no
# nightly-session marker was written, and store sessions expired before the
# morning chain (2026-08-16 07:10: 19 stores expired, reports all
# 20302/login_not_restored/hasPasswordValue=false).
#
# This coordinator keeps the SAME single 00:45 timer and the SAME logical run:
#   1. Completion is only the strong evidence predicate: an ok=true done
#      nightly-session marker with matching stage/runDate/businessDate AND a
#      same-day ok=true report whose summary covers every enabled store
#      with an exact, unique per-store result set: every enabled storeKey
#      appears exactly once, each row is ok=true, and each row carries the
#      WebAPI probe proof the current producer actually writes
#      (exportSession.stores[].webApiProbe.ok).  A forged summary 19/19 with
#      results=[] (or any missing / extra / duplicate / probe-less store row)
#      is NOT completed and never skips the run.  The same predicate is
#      exposed as --check-only for the morning chain gate, so no other
#      component re-implements a weaker marker-only test.
#   2. Otherwise invoke the shared browser-read lane with retries inside this
#      run until the start deadline.  retry-max defaults to 0 = unlimited: the
#      deadline is the only termination boundary.  A non-zero retry-max is an
#      explicit test/emergency override.  Every attempt acquires the shared
#      locks/slots itself, so full-managed work keeps priority between
#      attempts, and the exponential backoff stays clamped to the remaining
#      deadline.
#   3. If the run still cannot start by the deadline, write an explicit
#      failed/deferred nightly-session pipeline marker and a cloud_ops_alert,
#      and return a real non-success exit so systemd (no longer masking 75)
#      and the watchdog surface it.  The same fail-closed applies when the
#      inner run exited 0 but the strong completion evidence is missing.
#
# No credentials are stored or printed anywhere in this run. Locking, pressure
# and pipeline markers are owned by the lane / pipeline-stage scripts; this
# script only coordinates.

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"

# Defaults come from the unit Environment but every value can be overridden on
# the CLI (tests pin paths/dates through the flags below).
DOMAIN="${SHEIN_BI_SESSION_MANAGER_DOMAIN:-session-manager}"
LOCK_WAIT_SEC="${SHEIN_BI_SESSION_MANAGER_LOCK_WAIT_SEC:-120}"
DEADLINE_AT="${SHEIN_BI_SESSION_MANAGER_START_DEADLINE:-01:27}"
DEADLINE_EPOCH="${SHEIN_BI_SESSION_MANAGER_DEADLINE_EPOCH:-}"
if [[ -n "$DEADLINE_EPOCH" ]]; then
  DEADLINE_SOURCE="environment_epoch"
else
  DEADLINE_SOURCE="clock"
fi
DEFER_STATE="${SHEIN_BI_SESSION_MANAGER_DEFER_STATE:-/srv/shein-bi/runtime/host-scheduler/session-manager.latest.json}"
MARKER_STAGE="${SHEIN_BI_SESSION_MANAGER_MARKER_STAGE:-nightly-session}"
MARKER_ROOT="${SHEIN_BI_PIPELINE_MARKER_ROOT:-$ROOT/state/pipeline-markers}"
ALERT_FILE="${SHEIN_BI_SESSION_MANAGER_ALERT_FILE:-$ROOT/state/cloud_ops_alerts/session-manager-last.json}"
REPORT_FILE="${SHEIN_BI_SESSION_MANAGER_REPORT_FILE:-$ROOT/outputs/reports/cloud-session-manager-latest.json}"
RUN_DATE="${SHEIN_BI_SESSION_MANAGER_RUN_DATE:-}"
RETRY_MAX="${SHEIN_BI_SESSION_MANAGER_RETRY_MAX:-0}"
RETRY_BACKOFF_SEC="${SHEIN_BI_SESSION_MANAGER_RETRY_BACKOFF_SEC:-20}"
RETRY_BACKOFF_MAX_SEC="${SHEIN_BI_SESSION_MANAGER_RETRY_BACKOFF_MAX_SEC:-120}"
DEADLINE_SAFETY_SEC="${SHEIN_BI_SESSION_MANAGER_DEADLINE_SAFETY_SEC:-30}"
CHECK_ONLY=0
ATTEMPT=0
LAST_EXIT=""
LAST_DEFER_REASON=""

usage() {
  cat >&2 <<'EOF'
Usage:
  run_cloud_session_manager_job.sh [--root DIR] --domain NAME [--lock-wait-sec N]
    [--deadline-at HH:MM] [--deadline-epoch EPOCH_SEC]
    [--defer-state FILE] [--marker-stage NAME] [--marker-root DIR]
    [--alert-file FILE] [--report-file FILE] [--run-date YYYY-MM-DD]
    [--retry-max N] [--retry-backoff-sec N] [--retry-backoff-max-sec N]
    [--deadline-safety-sec N] -- COMMAND [ARG...]

  run_cloud_session_manager_job.sh --check-only [--root DIR]
    [--marker-stage NAME] [--marker-root DIR] [--run-date YYYY-MM-DD]
    [--report-file FILE]

  --check-only evaluates the strong completion evidence (done marker + same-day
  full-store report) and exits 0 when complete, 1 otherwise.  It never writes
  markers or alerts and never starts any work.
EOF
  exit 64
}

while (($#)); do
  case "$1" in
    --root) (($# >= 2)) || usage; ROOT="$2"; shift 2 ;;
    --domain) (($# >= 2)) || usage; DOMAIN="$2"; shift 2 ;;
    --lock-wait-sec) (($# >= 2)) || usage; LOCK_WAIT_SEC="$2"; shift 2 ;;
    --deadline-at) (($# >= 2)) || usage; DEADLINE_AT="$2"; shift 2 ;;
    --deadline-epoch)
      (($# >= 2)) || usage
      DEADLINE_EPOCH="$2"
      DEADLINE_SOURCE="explicit_epoch"
      shift 2
      ;;
    --defer-state) (($# >= 2)) || usage; DEFER_STATE="$2"; shift 2 ;;
    --marker-stage) (($# >= 2)) || usage; MARKER_STAGE="$2"; shift 2 ;;
    --marker-root) (($# >= 2)) || usage; MARKER_ROOT="$2"; shift 2 ;;
    --alert-file) (($# >= 2)) || usage; ALERT_FILE="$2"; shift 2 ;;
    --report-file) (($# >= 2)) || usage; REPORT_FILE="$2"; shift 2 ;;
    --run-date) (($# >= 2)) || usage; RUN_DATE="$2"; shift 2 ;;
    --retry-max) (($# >= 2)) || usage; RETRY_MAX="$2"; shift 2 ;;
    --retry-backoff-sec) (($# >= 2)) || usage; RETRY_BACKOFF_SEC="$2"; shift 2 ;;
    --retry-backoff-max-sec) (($# >= 2)) || usage; RETRY_BACKOFF_MAX_SEC="$2"; shift 2 ;;
    --deadline-safety-sec) (($# >= 2)) || usage; DEADLINE_SAFETY_SEC="$2"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --) shift; break ;;
    *) usage ;;
  esac
done

[[ -n "$ROOT" ]] || usage
export SHEIN_BI_ROOT="$ROOT"
[[ "$DOMAIN" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || usage
[[ "$LOCK_WAIT_SEC" =~ ^[0-9]+$ ]] || usage
[[ "$DEADLINE_AT" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || usage
if [[ -n "$DEADLINE_EPOCH" ]]; then
  [[ "$DEADLINE_EPOCH" =~ ^[0-9]+$ ]] || usage
fi
[[ "$MARKER_STAGE" =~ ^[a-z0-9][a-z0-9-]{0,79}$ ]] || usage
if [[ -n "$RUN_DATE" ]]; then
  [[ "$RUN_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || usage
fi
[[ "$RETRY_MAX" =~ ^[0-9]+$ ]] || usage
[[ "$RETRY_BACKOFF_SEC" =~ ^[0-9]+$ ]] || usage
[[ "$RETRY_BACKOFF_MAX_SEC" =~ ^[0-9]+$ ]] || usage
[[ "$DEADLINE_SAFETY_SEC" =~ ^[0-9]+$ ]] || usage
if [[ "$CHECK_ONLY" -eq 0 ]]; then
  [[ "$DOMAIN" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || usage
  (($# > 0)) || usage
fi

log() {
  printf '[cloud-session-manager-coordinator] %s\n' "$*" >&2
}

now_epoch() {
  date +%s
}

resolve_run_date() {
  if [[ -n "$RUN_DATE" ]]; then
    printf '%s\n' "$RUN_DATE"
  else
    TZ="$TZ_NAME" date +%F
  fi
}

resolve_deadline_epoch() {
  if [[ -n "$DEADLINE_EPOCH" ]]; then
    printf '%s\n' "$DEADLINE_EPOCH"
  else
    TZ="$TZ_NAME" date -d "$(TZ="$TZ_NAME" date +%F) $DEADLINE_AT:00" +%s
  fi
}

marker_status() {
  # Prints done|warning|failed|deferred|partial|missing for the run date.
  local output status
  output="$("$NODE" "$ROOT/scripts/pipeline_marker.mjs" read \
    --stage "$MARKER_STAGE" --date "$RUN_DATE" --root "$MARKER_ROOT" 2>/dev/null || true)"
  status="$(printf '%s' "$output" | "$NODE" -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", () => {
      try {
        const marker = JSON.parse(raw);
        if (marker && typeof marker.status === "string") process.stdout.write(marker.status);
        else process.stdout.write("missing");
      } catch {
        process.stdout.write("missing");
      }
    });
  ')"
  if [[ -z "$status" || ! "$status" =~ ^(done|warning|failed|deferred|partial)$ ]]; then
    status="missing"
  fi
  printf '%s' "$status"
}

# Strong completion evidence predicate (shared by the coordinator and its
# --check-only mode; never re-implemented by the morning chain):
#   1. pipeline marker: ok=true, status=done, stage/runDate/businessDate all
#      match the run date;
#   2. cloud-session-manager-latest.json must be the same-day full-store
#      evidence produced by cloud_shein_session_manager.mjs:
#        - report.ok === true, report.date === runDate and the report
#          generatedAt falls on the run date;
#        - summary agrees with the expected enabled store count (exact set);
#        - results is a NON-EMPTY exact permutation of the enabled storeKey
#          set: every enabled store appears exactly once (unique storeKey, no
#          extra store can satisfy a forged 19/19 summary);
#        - every result row is ok=true AND carries the WebAPI probe proof the
#          current producer actually writes: result.exportSession.stores[]
#          contains the same storeKey with webApiProbe.ok === true.  A forged
#          summary 19/19 + results=[] (or results without per-store probe
#          proof) must fail.
# A warning marker, a bare done marker, a stale/partial report or a missing
# probe proof is NOT completed, so it always triggers a fresh attempt instead
# of a skip.  An unreadable/empty store config fails closed too (an empty
# enabled-store set can never prove 19/19).
nightly_session_completed() {
  MARKER_ROOT="$MARKER_ROOT" MARKER_STAGE="$MARKER_STAGE" \
  RUN_DATE="$RUN_DATE" REPORT_FILE="$REPORT_FILE" \
  EXPECTED_STORES="${SHEIN_BI_SESSION_MANAGER_EXPECTED_STORES:-}" \
  "$NODE" - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const runDate = process.env.RUN_DATE;
const stage = process.env.MARKER_STAGE;
const shanghaiDateOf = value => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const d = new Date(time + 8 * 3600_000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const normalizeKey = value => String(value || '').trim().toUpperCase();
const enabledStoreKeys = () => {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(process.env.SHEIN_BI_ROOT, 'config', 'stores.json'), 'utf8'));
    return (config.stores || [])
      .filter(store => store.enabled !== false)
      .map(store => normalizeKey(store.storeKey))
      .filter(Boolean)
      .sort();
  } catch {
    return null;
  }
};
const expectedKeys = enabledStoreKeys();
const rawExpected = process.env.EXPECTED_STORES || '';
if (rawExpected.startsWith('[')) {
  try {
    const override = JSON.parse(rawExpected);
    if (Array.isArray(override)) {
      expectedKeys.length = 0;
      expectedKeys.push(...override.map(normalizeKey).filter(Boolean).sort());
    }
  } catch {
    process.exit(1);
  }
}
// Fail closed: without a non-empty authoritative enabled-store set there is no
// way to prove full-store coverage, and an unreadable config must never be
// reported as success.
if (!Array.isArray(expectedKeys) || expectedKeys.length === 0) process.exit(1);
if (/^[0-9]+$/.test(rawExpected) && Number(rawExpected) !== expectedKeys.length) process.exit(1);
try {
  const marker = JSON.parse(fs.readFileSync(path.join(process.env.MARKER_ROOT, runDate, `${stage}.json`), 'utf8'));
  const markerOk = marker?.ok === true
    && marker?.status === 'done'
    && marker?.stage === stage
    && marker?.runDate === runDate
    && marker?.businessDate === runDate;
  if (!markerOk) process.exit(1);
  const report = JSON.parse(fs.readFileSync(process.env.REPORT_FILE, 'utf8'));
  const total = Number(report?.summary?.totalStores);
  const okStores = Number(report?.summary?.okStores);
  const failedStores = Array.isArray(report?.summary?.failedStores) ? report.summary.failedStores : null;
  const results = Array.isArray(report?.results) ? report.results : [];
  const resultKeys = results.map(row => normalizeKey(row?.storeKey)).filter(Boolean);
  const uniqueKeys = new Set(resultKeys);
  // Exact store coverage is a SET contract, not an ordering contract.  The
  // producer preserves config order (for example DL, DX, ...), while
  // expectedKeys is normalized/sorted above.  Keep resultKeys unchanged for
  // the uniqueness check and compare a sorted copy for exact-set equality.
  const sortedResultKeys = [...resultKeys].sort();
  // Per-store evidence the CURRENT producer actually writes: an ok row only
  // exists when the WebAPI export was fresh and the probe passed, and the
  // probe proof itself is carried in exportSession.stores[].webApiProbe.ok.
  const everyRowHasWebApiProbe = results.every(row => {
    const key = normalizeKey(row?.storeKey);
    return row?.ok === true
      && Array.isArray(row?.exportSession?.stores)
      && row.exportSession.stores.some(entry =>
        normalizeKey(entry?.storeKey) === key && entry?.webApiProbe?.ok === true);
  });
  const reportOk = report?.ok === true
    && String(report?.date || '') === runDate
    && shanghaiDateOf(report?.generatedAt) === runDate
    && total === expectedKeys.length
    && okStores === expectedKeys.length
    && (failedStores?.length ?? -1) === 0
    && results.length === expectedKeys.length
    && uniqueKeys.size === resultKeys.length
    && sortedResultKeys.join(',') === expectedKeys.join(',')
    && everyRowHasWebApiProbe;
  process.exit(reportOk ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

read_defer_state() {
  # Prints "status reason generatedAt" parsed from the lane defer-state file.
  DEFER_STATE_FILE="$DEFER_STATE" "$NODE" - <<'NODE'
const fs = require('node:fs');
try {
  const state = JSON.parse(fs.readFileSync(process.env.DEFER_STATE_FILE, 'utf8'));
  process.stdout.write(`${state?.status || 'deferred'} ${state?.reason || 'unknown_defers'} ${state?.generatedAt || ''}\n`);
} catch {
  process.stdout.write('deferred unknown_defers \n');
}
NODE
}

write_marker() {
  local status="$1"
  local message="$2"
  local evidence_args=()
  if [[ -f "$DEFER_STATE" ]]; then
    evidence_args=(--evidence "$DEFER_STATE")
  fi
  "$NODE" "$ROOT/scripts/pipeline_marker.mjs" write \
    --stage "$MARKER_STAGE" \
    --date "$RUN_DATE" \
    --status "$status" \
    --message "$message" \
    --root "$MARKER_ROOT" \
    "${evidence_args[@]}" >/dev/null
}

ALERT_OK_FILE="${ALERT_FILE//-last.json/-last-ok.json}"
write_alert() {
  local status="$1"
  local reason="$2"
  local message="$3"
  local last_exit="${4:-}"
  mkdir -p "$(dirname "$ALERT_FILE")"
  ALERT_FILE="$ALERT_FILE" ALERT_OK_FILE="$ALERT_OK_FILE" \
  ALERT_DATE="$RUN_DATE" ALERT_STATUS="$status" ALERT_REASON="$reason" \
  ALERT_MESSAGE="$message" ALERT_ATTEMPT="$ATTEMPT" ALERT_LAST_EXIT="$last_exit" \
  ALERT_DEFER_STATE="$DEFER_STATE" ALERT_MARKER_STAGE="$MARKER_STAGE" \
  ALERT_LOG_FILE="${SHEIN_BI_SESSION_MANAGER_LOG_FILE:-}" \
  "$NODE" - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.ALERT_FILE;
const payload = {
  ok: process.env.ALERT_STATUS === 'ok',
  date: process.env.ALERT_DATE,
  generatedAt: new Date().toISOString(),
  status: process.env.ALERT_STATUS,
  reason: process.env.ALERT_REASON || '',
  message: process.env.ALERT_MESSAGE || '',
  attempt: Number(process.env.ALERT_ATTEMPT || 0),
  lastExit: process.env.ALERT_LAST_EXIT ? Number(process.env.ALERT_LAST_EXIT) : null,
  deferState: process.env.ALERT_DEFER_STATE || null,
  markerStage: process.env.ALERT_MARKER_STAGE || '',
  logFile: process.env.ALERT_LOG_FILE || null,
};
fs.mkdirSync(path.dirname(file), {recursive: true});
const temporary = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {mode: 0o660});
fs.renameSync(temporary, file);
if (process.env.ALERT_STATUS === 'ok') {
  const okFile = process.env.ALERT_OK_FILE;
  const okPayload = {...payload, status: 'ok', attempt: 0, lastExit: 0};
  const okTemporary = `${okFile}.${process.pid}.tmp`;
  fs.writeFileSync(okTemporary, `${JSON.stringify(okPayload, null, 2)}\n`, {mode: 0o660});
  fs.renameSync(okTemporary, okFile);
}
NODE
}

finalize_failure() {
  local status="$1"
  local reason="$2"
  local message="$3"
  local exit_code="$4"
  # Never overwrite a strongly completed run (done marker + same-day
  # full-store report).  A warning marker is NOT completed and may be
  # overwritten by the recovery's failure record.
  if ! nightly_session_completed; then
    write_marker "$status" "$message"
  fi
  write_alert "$status" "$reason" "$message" "$LAST_EXIT"
  echo "[cloud-session-manager-coordinator] ERROR $reason attempts=$ATTEMPT lastExit=${LAST_EXIT:-none} lastDefer=${LAST_DEFER_REASON:-none}" >&2
  exit "$exit_code"
}

NODE="${SHEIN_BI_SESSION_MANAGER_NODE:-node}"
RUN_DATE="$(resolve_run_date)"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  if nightly_session_completed; then
    log "check-only runDate=$RUN_DATE strong completion evidence present (done marker + same-day full-store report)"
    exit 0
  fi
  log "check-only runDate=$RUN_DATE completion evidence missing (done marker + same-day full-store report required)"
  exit 1
fi

DEADLINE_EPOCH="$(resolve_deadline_epoch)"
if [[ "$DEADLINE_SOURCE" == "clock" ]]; then
  # Normal 00:45 unit path: preserve the existing 01:27 wall-clock lane
  # contract. The coordinator uses the equivalent epoch only for its own
  # retry/sleep budget.
  LANE_DEADLINE_ARGS=(--deadline-at "$DEADLINE_AT")
  DEADLINE_LABEL="clock=$DEADLINE_AT"
else
  # Catch-up/tests may provide a later absolute deadline. Passing the stale
  # default --deadline-at as well would make run_host_browser_read_job.sh
  # reject after 01:27 before it evaluates the future epoch.
  LANE_DEADLINE_ARGS=(--deadline-epoch "$DEADLINE_EPOCH")
  DEADLINE_LABEL="epoch=$DEADLINE_EPOCH"
fi
mkdir -p "$(dirname "$ALERT_FILE")"
mkdir -p "$(dirname "$DEFER_STATE")"

current_status="$(marker_status)"
if [[ "$current_status" == "warning" ]]; then
  log "marker=$current_status runDate=$RUN_DATE is NOT a completed state; a fresh attempt with strong evidence is required"
fi
if nightly_session_completed; then
  log "strong completion evidence present marker=$current_status runDate=$RUN_DATE; idempotent skip (nightly session maintenance already completed)"
  write_alert "skipped" "completion_evidence_present" \
    "nightly-session strong completion evidence (done marker + same-day full-store report) is present; skipped without starting a second run" ""
  exit 0
fi

log "start runDate=$RUN_DATE marker=$current_status completionEvidence=missing deadlineSource=$DEADLINE_SOURCE deadline=$DEADLINE_LABEL retryMax=$RETRY_MAX (0=unlimited, deadline is the only boundary)"

while true; do
  ATTEMPT=$((ATTEMPT + 1))
  if (( $(now_epoch) + DEADLINE_SAFETY_SEC >= DEADLINE_EPOCH )); then
    finalize_failure "deferred" "deadline_elapsed" \
      "start deadline $DEADLINE_LABEL reached before nightly session maintenance could start (attempt=$ATTEMPT)" 1
  fi

  log "attempt=$ATTEMPT starting shared browser-read lane domain=$DOMAIN"
  set +e
  bash "$ROOT/scripts/run_host_browser_read_job.sh" \
    --domain "$DOMAIN" \
    --lock-wait-sec "$LOCK_WAIT_SEC" \
    "${LANE_DEADLINE_ARGS[@]}" \
    --defer-state "$DEFER_STATE" \
    -- "$@"
  STATUS=$?
  set -e
  LAST_EXIT="$STATUS"

  if [[ "$STATUS" -eq 0 ]]; then
    if nightly_session_completed; then
      log "nightly session maintenance completed with strong evidence attempt=$ATTEMPT"
      write_alert "ok" "completed" "nightly session maintenance completed with strong evidence in the same daily run" "0"
      exit 0
    fi
    finalize_failure "failed" "completion_evidence_missing" \
      "nightly session maintenance exited 0 but the done marker / same-day full-store report evidence is missing (attempt=$ATTEMPT)" 1
  fi

  if [[ "$STATUS" -eq 75 ]]; then
    read -r LAST_DEFER_STATUS LAST_DEFER_REASON _ <<<"$(read_defer_state)"
    log "lane deferred attempt=$ATTEMPT status=${LAST_DEFER_STATUS:-deferred} reason=${LAST_DEFER_REASON:-unknown_defers}"
    if [[ "$LAST_DEFER_REASON" == *deadline_elapsed* || "$LAST_DEFER_REASON" == *deadline_reached* ]]; then
      finalize_failure "deferred" "$LAST_DEFER_REASON" \
        "the shared browser-read lane reported $LAST_DEFER_REASON before nightly session maintenance could start (attempt=$ATTEMPT)" 1
    fi
    if (( RETRY_MAX > 0 && ATTEMPT >= RETRY_MAX )); then
      finalize_failure "deferred" "retry_budget_exhausted" \
        "bounded in-run retries exhausted after attempts=$ATTEMPT (retryMax=$RETRY_MAX); last defer=$LAST_DEFER_REASON" 1
    fi
    backoff="$RETRY_BACKOFF_SEC"
    power=1
    for ((i = 1; i < ATTEMPT; i++)); do
      power=$((power * 2))
    done
    backoff=$((RETRY_BACKOFF_SEC * power))
    if (( backoff > RETRY_BACKOFF_MAX_SEC )); then
      backoff="$RETRY_BACKOFF_MAX_SEC"
    fi
    remaining=$((DEADLINE_EPOCH - DEADLINE_SAFETY_SEC - $(now_epoch)))
    if (( remaining <= 0 )); then
      continue
    fi
    if (( backoff > remaining )); then
      backoff="$remaining"
    fi
    log "retrying in ${backoff}s (deadline-bounded, same 00:45 run, no extra timer)"
    sleep "$backoff"
    continue
  fi

  if [[ "$STATUS" -eq 124 || "$STATUS" -eq 137 || "$STATUS" -eq 143 ]]; then
    read -r LAST_DEFER_STATUS LAST_DEFER_REASON _ <<<"$(read_defer_state)"
    log "run started but was terminated at the run deadline exit=$STATUS reason=${LAST_DEFER_REASON:-deadline_reached}"
    write_alert "partial" "${LAST_DEFER_REASON:-deadline_reached}" \
      "nightly session maintenance started but was terminated at the $DEADLINE_LABEL run deadline (exit=$STATUS)" "$STATUS"
    echo "[cloud-session-manager-coordinator] ERROR partial run terminated by deadline exit=$STATUS attempt=$ATTEMPT" >&2
    exit "$STATUS"
  fi

  finalize_failure "failed" "inner_exit_$STATUS" \
    "nightly session maintenance failed with exit=$STATUS (attempt=$ATTEMPT)" "$STATUS"
done
