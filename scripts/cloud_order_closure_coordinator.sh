#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
MARKER_ROOT="${SHEIN_BI_PIPELINE_MARKER_ROOT:-$ROOT/state/pipeline-markers}"
RETRY_DELAY_SEC="${SHEIN_BI_ORDER_CLOSURE_RETRY_DELAY_SEC:-60}"
START_DEADLINE="${SHEIN_BI_ORDER_CLOSURE_START_DEADLINE:-07:27}"
DEFER_STATE="${SHEIN_BI_ORDER_CLOSURE_DEFER_STATE:-/srv/shein-bi/runtime/host-scheduler/order-closure.latest.json}"
COORDINATOR_STATE="${SHEIN_BI_ORDER_CLOSURE_COORDINATOR_STATE:-/srv/shein-bi/runtime/host-scheduler/order-closure-coordinator.latest.json}"
RUN_DATE_TARGET="${SHEIN_BI_ORDER_CLOSURE_RUN_DATE:-today}"
BUSINESS_DATE_TARGET="${SHEIN_BI_ORDER_CLOSURE_BUSINESS_DATE:-yesterday}"
MAX_PAIRS="${SHEIN_ORDER_CLOSURE_MAX_PAIRS:-500}"
MIN_AGE_DAYS="${SHEIN_ORDER_CLOSURE_MIN_AGE_DAYS:-2}"
COOLDOWN_HOURS="${SHEIN_ORDER_CLOSURE_COOLDOWN_HOURS:-20}"
PORTAL_URL="${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}"
PORTAL_TIMEOUT_SEC="${SHEIN_ORDER_CLOSURE_PORTAL_TIMEOUT_SEC:-240}"
WORK_FINGERPRINT_SCOPE="order-closure"
# Manual semantic contract for the closure implementation, candidate SQL and
# required Portal refresh/queue effects. Bump only when those business
# semantics change; comments, wrappers and unrelated source commits do not.
WORK_SEMANTIC_VERSION="order-closure/v5-zero-zero-done-candidates-v1-portal-queue-v1"

deadline_epoch() {
  TZ="$TZ_NAME" date -d "$(TZ="$TZ_NAME" date +%F) $START_DEADLINE:00" +%s
}

resolve_date() {
  case "$1" in
    today) TZ="$TZ_NAME" date +%F ;;
    yesterday) TZ="$TZ_NAME" date -d yesterday +%F ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) printf '%s\n' "$1" ;;
    *) return 64 ;;
  esac
}

write_state() {
  local status="$1"
  local message="$2"
  mkdir -p "$(dirname "$COORDINATOR_STATE")"
  STATUS="$status" MESSAGE="$message" ATTEMPT="$ATTEMPT" STATE_FILE="$COORDINATOR_STATE" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.STATE_FILE;
const payload = {
  ok: process.env.STATUS === 'done',
  status: process.env.STATUS,
  message: process.env.MESSAGE,
  attempt: Number(process.env.ATTEMPT || 0),
  generatedAt: new Date().toISOString(),
};
fs.mkdirSync(path.dirname(file), {recursive: true});
const temporary = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
fs.renameSync(temporary, file);
NODE
}

ATTEMPT=0

# The source commit is retained for audit only. It is deliberately excluded
# from the structured work fingerprint.
SOURCE_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
WORK_PARAMETERS=(
  "stage=order-closure"
  "transport=openapi"
  "maxPairs=$MAX_PAIRS"
  "minAgeDays=$MIN_AGE_DAYS"
  "cooldownHours=$COOLDOWN_HOURS"
  "portalUrl=$PORTAL_URL"
  "portalTimeoutSec=$PORTAL_TIMEOUT_SEC"
  "portalRefreshSection=orders"
  "queueSections=afterSales,homeRankings,homeProfit"
  "queuePriority=20"
  "queueReason=order-closure"
)
echo "[order-closure-coordinator] prepared scope=$WORK_FINGERPRINT_SCOPE semanticVersion=$WORK_SEMANTIC_VERSION markerRoot=$MARKER_ROOT"

DEADLINE_EPOCH="${SHEIN_BI_ORDER_CLOSURE_DEADLINE_EPOCH:-$(deadline_epoch)}"

while true; do
  ATTEMPT=$((ATTEMPT + 1))
  if (( $(date +%s) >= DEADLINE_EPOCH )); then
    # The heavy lane never expands past its authorized start deadline. No
    # candidate digest or marker is read/written here, so a late-arriving order
    # cannot be claimed by today's marker; the next authorized activation uses
    # its own runDate and takes a fresh locked candidate snapshot.
    write_state "failed" "resource window expired before order closure could start; late candidates remain for the next authorized activation"
    echo "[order-closure-coordinator] ERROR start deadline $START_DEADLINE elapsed after attempts=$ATTEMPT; late candidates remain unclaimed for the next authorized activation" >&2
    exit 75
  fi

  if ! ATTEMPT_RUN_DATE="$(resolve_date "$RUN_DATE_TARGET")" \
    || ! ATTEMPT_BUSINESS_DATE="$(resolve_date "$BUSINESS_DATE_TARGET")"; then
    write_state "failed" "invalid runDate or businessDate target"
    exit 64
  fi
  write_state "running" "attempting the same daily order-closure run"
  ORDER_STAGE_ARGS=(
    --stage order-closure
    --run-date "$ATTEMPT_RUN_DATE"
    --business-date "$ATTEMPT_BUSINESS_DATE"
    --skip-if-done
    --work-fingerprint-scope "$WORK_FINGERPRINT_SCOPE"
    --work-semantic-version "$WORK_SEMANTIC_VERSION"
    --workset-digest-program node
    --workset-digest-arg "$ROOT/scripts/recheck_order_statuses.mjs"
    --workset-digest-arg --candidate-digest
    --workset-digest-arg --max-pairs
    --workset-digest-arg "$MAX_PAIRS"
    --workset-digest-arg --min-age-days
    --workset-digest-arg "$MIN_AGE_DAYS"
    --workset-digest-arg --cooldown-hours
    --workset-digest-arg "$COOLDOWN_HOURS"
    --workset-digest-arg --transport
    --workset-digest-arg openapi
    --message "order lifecycle closure completed"
  )
  for parameter in "${WORK_PARAMETERS[@]}"; do ORDER_STAGE_ARGS+=(--work-parameter "$parameter"); done
  if [[ -n "$SOURCE_COMMIT" ]]; then ORDER_STAGE_ARGS+=(--source-commit "$SOURCE_COMMIT"); fi
  set +e
  bash "$ROOT/scripts/run_host_heavy_job.sh" \
    --domain order-closure \
    --class openapi \
    --lock-wait-sec 120 \
    --deadline-at "$START_DEADLINE" \
    --defer-state "$DEFER_STATE" \
    -- bash "$ROOT/scripts/run_pipeline_stage.sh" \
      "${ORDER_STAGE_ARGS[@]}" \
      -- bash "$ROOT/scripts/cloud_order_closure.sh"
  status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    STAGE_OUTCOME_ARGS=(
      outcome
      --stage order-closure
      --date "$ATTEMPT_RUN_DATE"
      --business-date "$ATTEMPT_BUSINESS_DATE"
      --work-fingerprint-scope "$WORK_FINGERPRINT_SCOPE"
      --work-semantic-version "$WORK_SEMANTIC_VERSION"
      --root "$MARKER_ROOT"
    )
    for parameter in "${WORK_PARAMETERS[@]}"; do STAGE_OUTCOME_ARGS+=(--work-parameter "$parameter"); done
    set +e
    STAGE_OUTCOME_OUTPUT="$(node "$ROOT/scripts/pipeline_marker.mjs" "${STAGE_OUTCOME_ARGS[@]}" 2>&1)"
    STAGE_OUTCOME_STATUS=$?
    set -e
    if [[ "$STAGE_OUTCOME_STATUS" -ne 0 ]]; then
      write_state "failed" "stage returned success but central marker outcome validation failed"
      echo "[order-closure-coordinator] ERROR central marker outcome validation failed runDate=$ATTEMPT_RUN_DATE detail=$STAGE_OUTCOME_OUTPUT" >&2
      exit 1
    fi
    set +e
    STAGE_OUTCOME="$(printf '%s\n' "$STAGE_OUTCOME_OUTPUT" | node -e "let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s); if(j.ok!==true||!['done','partial'].includes(j.outcome)||!Number.isSafeInteger(j.worksetCandidateCount)||!Number.isSafeInteger(j.worksetPairCount))process.exit(2); process.stdout.write([j.outcome,j.worksetCandidateCount,j.worksetPairCount].join(' '));}catch{process.exit(2);}});")"
    STAGE_OUTCOME_DECODE_STATUS=$?
    set -e
    if [[ "$STAGE_OUTCOME_DECODE_STATUS" -ne 0 ]]; then
      write_state "failed" "central marker outcome response was unreadable"
      echo "[order-closure-coordinator] ERROR unreadable central marker outcome response runDate=$ATTEMPT_RUN_DATE" >&2
      exit 1
    fi
    read -r COORDINATOR_OUTCOME REMAINING_CANDIDATES REMAINING_PAIRS <<<"$STAGE_OUTCOME"
    if [[ "$COORDINATOR_OUTCOME" == "done" ]]; then
      write_state "done" "order lifecycle closure reached an authoritative empty done marker"
      exit 0
    fi
    write_state "partial" "order closure activation incomplete; markerStatus=partial remainingCandidates=$REMAINING_CANDIDATES remainingPairs=$REMAINING_PAIRS; next authorized activation required"
    echo "[order-closure-coordinator] partial runDate=$ATTEMPT_RUN_DATE remainingCandidates=$REMAINING_CANDIDATES remainingPairs=$REMAINING_PAIRS; next authorized activation required"
    exit 0
  fi
  if [[ "$status" -ne 75 ]]; then
    write_state "failed" "order lifecycle closure failed with exit=$status"
    exit "$status"
  fi

  if (( $(date +%s) + RETRY_DELAY_SEC >= DEADLINE_EPOCH )); then
    write_state "failed" "resource deferral persisted until the start deadline"
    echo "[order-closure-coordinator] ERROR resource deferral persisted until $START_DEADLINE attempts=$ATTEMPT" >&2
    exit 75
  fi
  write_state "waiting_resource" "host capacity is temporarily unavailable; retrying inside the same daily run"
  echo "[order-closure-coordinator] deferred attempt=$ATTEMPT; retrying in ${RETRY_DELAY_SEC}s without creating another timer"
  sleep "$RETRY_DELAY_SEC"
done
