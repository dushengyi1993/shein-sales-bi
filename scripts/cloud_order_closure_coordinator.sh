#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
RETRY_DELAY_SEC="${SHEIN_BI_ORDER_CLOSURE_RETRY_DELAY_SEC:-60}"
START_DEADLINE="${SHEIN_BI_ORDER_CLOSURE_START_DEADLINE:-07:27}"
DEFER_STATE="${SHEIN_BI_ORDER_CLOSURE_DEFER_STATE:-/srv/shein-bi/runtime/host-scheduler/order-closure.latest.json}"
COORDINATOR_STATE="${SHEIN_BI_ORDER_CLOSURE_COORDINATOR_STATE:-/srv/shein-bi/runtime/host-scheduler/order-closure-coordinator.latest.json}"

deadline_epoch() {
  TZ="$TZ_NAME" date -d "$(TZ="$TZ_NAME" date +%F) $START_DEADLINE:00" +%s
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
DEADLINE_EPOCH="${SHEIN_BI_ORDER_CLOSURE_DEADLINE_EPOCH:-$(deadline_epoch)}"

while true; do
  ATTEMPT=$((ATTEMPT + 1))
  if (( $(date +%s) >= DEADLINE_EPOCH )); then
    write_state "failed" "resource window expired before order closure could start"
    echo "[order-closure-coordinator] ERROR start deadline $START_DEADLINE elapsed after attempts=$ATTEMPT" >&2
    exit 1
  fi

  write_state "running" "attempting the same daily order-closure run"
  set +e
  bash "$ROOT/scripts/run_host_heavy_job.sh" \
    --domain order-closure \
    --class openapi \
    --lock-wait-sec 120 \
    --deadline-at "$START_DEADLINE" \
    --defer-state "$DEFER_STATE" \
    -- bash "$ROOT/scripts/run_pipeline_stage.sh" \
      --stage order-closure \
      --business-date yesterday \
      --message "order lifecycle closure completed" \
      -- bash "$ROOT/scripts/cloud_order_closure.sh"
  status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    write_state "done" "order lifecycle closure completed in the same daily run"
    exit 0
  fi
  if [[ "$status" -ne 75 ]]; then
    write_state "failed" "order lifecycle closure failed with exit=$status"
    exit "$status"
  fi

  if (( $(date +%s) + RETRY_DELAY_SEC >= DEADLINE_EPOCH )); then
    write_state "failed" "resource deferral persisted until the start deadline"
    echo "[order-closure-coordinator] ERROR resource deferral persisted until $START_DEADLINE attempts=$ATTEMPT" >&2
    exit 1
  fi
  write_state "waiting_resource" "host capacity is temporarily unavailable; retrying inside the same daily run"
  echo "[order-closure-coordinator] deferred attempt=$ATTEMPT; retrying in ${RETRY_DELAY_SEC}s without creating another timer"
  sleep "$RETRY_DELAY_SEC"
done
