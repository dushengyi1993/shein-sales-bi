#!/usr/bin/env bash
set -euo pipefail
ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
DATE="$(TZ=Asia/Shanghai date +%F)"
RUNTIME_ROOT="${SHEIN_BI_INVENTORY_RUNTIME_ROOT:-/srv/shein-bi/runtime/daily-inventory-replenishment}"
PLAN="$RUNTIME_ROOT/plans/daily-inventory-replenishment-$DATE.json"
RESULT="$RUNTIME_ROOT/results/daily-inventory-replenishment-$DATE.json"
LOCK="$ROOT/state/locks/daily-inventory-replenishment.lock"
mkdir -p "$(dirname "$PLAN")" "$(dirname "$RESULT")"
. "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$LOCK"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "daily inventory replenishment guard is already running" >&2
  exit 0
fi
cd "$ROOT"
node scripts/inventory/build_daily_inventory_replenishment_plan.mjs --date "$DATE" --out "$PLAN"

HASH="$(jq -r '.payloadHash // empty' "$PLAN")"
TOTAL="$(jq -r '.actionable | length' "$PLAN")"
EXECUTABLE="$(jq -r '.executable == true and ((.blockers // []) | length == 0)' "$PLAN")"
if [[ ! "$HASH" =~ ^[a-f0-9]{64}$ ]]; then
  echo "daily inventory plan has no valid payloadHash" >&2
  exit 1
fi
if [[ "$EXECUTABLE" != "true" ]]; then
  jq '{ok:false,state:"plan_blocked",date,payloadHash,blockers}' "$PLAN"
  exit 0
fi
if [[ -f "$RESULT" ]] && jq -e --arg hash "$HASH" --argjson total "$TOTAL" '
  .planHash == $hash
  and .execute == true
  and (.results | length) == $total
  and ([.results[].state] | all(. != "planned" and . != "dry_run_ready"))
' "$RESULT" >/dev/null; then
  jq '{ok:true,state:"already_completed",planHash,executionMode,generatedAt,counts:{
    total:(.results|length),
    updated:([.results[]|select(.state=="updated_readback_matched")]|length),
    skipped:([.results[]|select(.state|startswith("skipped_"))]|length),
    blocked:([.results[]|select(.state=="blocked")]|length)
  }}' "$RESULT"
  exit 0
fi

set +e
node scripts/inventory/execute_daily_inventory_replenishment_plan.mjs \
  --plan "$PLAN" \
  --execute \
  --execution-mode automatic \
  --confirm-hash "$HASH" \
  --max-rows 1000 \
  --out "$RESULT"
EXECUTOR_STATUS=$?
set -e

if [[ ! -f "$RESULT" ]] || ! jq -e --arg hash "$HASH" --argjson total "$TOTAL" '
  .planHash == $hash and .execute == true and (.results | length) == $total
' "$RESULT" >/dev/null; then
  echo "automatic inventory executor did not produce a complete result" >&2
  if (( EXECUTOR_STATUS != 0 )); then
    exit "$EXECUTOR_STATUS"
  fi
  exit 1
fi

# Row-level blockers are terminal, auditable business results. The 09:45 report
# surfaces them; they must not turn a completed daily scan into a systemd crash.
jq '{ok: (([.results[]|select(.state=="blocked")]|length) == 0),state:"completed",planHash,executionMode,generatedAt,counts:{
  total:(.results|length),
  updated:([.results[]|select(.state=="updated_readback_matched")]|length),
  skipped:([.results[]|select(.state|startswith("skipped_"))]|length),
  blocked:([.results[]|select(.state=="blocked")]|length)
}}' "$RESULT"
