#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
DATE="$(TZ=Asia/Shanghai date +%F)"
RUNTIME_ROOT="${SHEIN_BI_ET_LOW_INVENTORY_RUNTIME_ROOT:-/srv/shein-bi/runtime/et-low-inventory-guard}"
BOOTSTRAP_LOCK_FILE="${SHEIN_BI_INVENTORY_BOOTSTRAP_LOCK_FILE:-/srv/shein-bi/runtime/daily-inventory-replenishment/all-store-sold-out-bootstrap-locks.json}"
MANIFEST="${SHEIN_ET_LATEST_MANIFEST:-$ROOT/outputs/et-forwarder/latest-manifest.json}"
LOCK="$ROOT/state/locks/daily-inventory-replenishment.lock"
STATE="$RUNTIME_ROOT/state/latest.json"
mkdir -p "$RUNTIME_ROOT/source-plans" "$RUNTIME_ROOT/plans" "$RUNTIME_ROOT/results" "$(dirname "$STATE")"
. "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$LOCK"
exec 9>"$LOCK"
if ! flock -w "${SHEIN_BI_ET_LOW_INVENTORY_LOCK_WAIT_SECONDS:-120}" 9; then
  echo "[et_low_inventory_guard] inventory lock is busy; retry at the next checkpoint" >&2
  exit 75
fi
cd "$ROOT"

if [[ ! -s "$MANIFEST" ]]; then
  echo "[et_low_inventory_guard] ET manifest is missing: $MANIFEST" >&2
  exit 75
fi
BATCH_ID="$(jq -r '.batchId // empty' "$MANIFEST")"
TARGET_DATE="$(jq -r '.targetDate // empty' "$MANIFEST")"
MANIFEST_OK="$(jq -r '.ok == true' "$MANIFEST")"
if [[ -z "$BATCH_ID" || "$TARGET_DATE" != "$DATE" || "$MANIFEST_OK" != "true" ]]; then
  echo "[et_low_inventory_guard] ET manifest is not a completed current-day batch batch=$BATCH_ID targetDate=$TARGET_DATE" >&2
  exit 75
fi
if [[ -s "$STATE" ]] \
  && [[ "$(jq -r '.lastProcessedBatchId // empty' "$STATE")" == "$BATCH_ID" ]] \
  && jq -e '.result != null' "$STATE" >/dev/null; then
  # Older releases treated low-ET canonicals that still need future observation
  # as a technical execution failure. A completed batch with no row-level
  # blocker is healthy; keep the watchlist active without failing systemd.
  # Only a genuinely completed run (result present) may be normalized: a
  # plan_blocked state also writes lastProcessedBatchId but has result null and
  # no counts, so it must keep failing closed instead of being masked as ok.
  if jq -e '(.result != null) and (.counts.blocked // 0) == 0 and .ok != true' "$STATE" >/dev/null; then
    tmp="$STATE.$$.tmp"
    jq '
      .ok = true
      | .businessState = (if .active == true then "watching" else "settled" end)
      | .counts.pendingCanonical = (.counts.blockedCanonical // 0)
    ' "$STATE" >"$tmp"
    mv "$tmp" "$STATE"
  fi
  jq '{ok:true,state:"batch_already_processed",lastProcessedBatchId,active,planHash,result}' "$STATE"
  exit 0
fi
if [[ -s "$STATE" ]] && [[ "$(jq -r '.lastProcessedBatchId // empty' "$STATE")" == "$BATCH_ID" ]]; then
  echo "[et_low_inventory_guard] retry incomplete batch=$BATCH_ID previousState=$(jq -r '.businessState // "plan_blocked"' "$STATE")"
fi

SAFE_BATCH_ID="$(printf '%s' "$BATCH_ID" | tr -c 'A-Za-z0-9._-' '_')"
SOURCE_PLAN="$RUNTIME_ROOT/source-plans/et-low-inventory-source-$SAFE_BATCH_ID.json"
PLAN="$RUNTIME_ROOT/plans/et-low-inventory-$SAFE_BATCH_ID.json"
RESULT="$RUNTIME_ROOT/results/et-low-inventory-$SAFE_BATCH_ID.json"
DETAIL_TARGETS="$RUNTIME_ROOT/source-plans/et-low-inventory-detail-targets-$SAFE_BATCH_ID.json"
DETAIL_BUDGET="${SHEIN_BI_ET_LOW_INVENTORY_DETAIL_BUDGET:-32}"

BUILD_STATUS=0
node scripts/inventory/build_daily_inventory_replenishment_plan.mjs \
  --date "$DATE" \
  --operation-mode et_low_inventory_safety \
  --bootstrap-lock-file "$BOOTSTRAP_LOCK_FILE" \
  --out "$SOURCE_PLAN" || BUILD_STATUS=$?
if [[ ! -s "$SOURCE_PLAN" ]]; then
  echo "[et_low_inventory_guard] source planner did not produce a plan status=$BUILD_STATUS" >&2
  if (( BUILD_STATUS != 0 )); then exit "$BUILD_STATUS"; fi
  exit 1
fi

# The safety planner may use cached canonical identity only to discover a
# conservative low-ET candidate set. Before any action is executable, fetch
# current OpenAPI detail for exactly those SPUs, then rebuild the source plan.
# Non-candidates never consume the shared detail budget.
if (( BUILD_STATUS == 2 )) && jq -e '
  ((.detailRefreshTargets // []) | length) > 0
  and ((.blockers // []) | length) > 0
  and all(.blockers[]; startswith("low-ET OpenAPI product canonical evidence"))
' "$SOURCE_PLAN" >/dev/null; then
  jq -n \
    --argjson rows "$(jq '.detailRefreshTargets' "$SOURCE_PLAN")" '
      {schemaVersion:"et-low-inventory-detail-targets/v1", stores:
        (reduce $rows[] as $row ({};
          .[$row.storeKey] = (((.[$row.storeKey] // []) + [$row.spu]) | unique)
        ))}
    ' >"$DETAIL_TARGETS.tmp"
  mv "$DETAIL_TARGETS.tmp" "$DETAIL_TARGETS"
  TARGET_STORES="$(jq -r '.stores | keys | join(",")' "$DETAIL_TARGETS")"
  MAX_TARGETS="$(jq '[.stores[] | length] | max // 0' "$DETAIL_TARGETS")"
  if [[ ! "$DETAIL_BUDGET" =~ ^[0-9]+$ ]] || (( DETAIL_BUDGET < 1 || MAX_TARGETS > DETAIL_BUDGET )); then
    echo "[et_low_inventory_guard] targeted detail budget exceeded maxTargets=$MAX_TARGETS budget=$DETAIL_BUDGET" >&2
  else
    echo "[et_low_inventory_guard] refresh current detail stores=$TARGET_STORES maxTargets=$MAX_TARGETS budget=$DETAIL_BUDGET"
    DETAIL_STATUS=0
    SHEIN_OPENAPI_PRODUCT_RECONCILE_STORES="$TARGET_STORES" \
    SHEIN_OPENAPI_PRODUCT_RECONCILE_MAX_DETAILS="$DETAIL_BUDGET" \
    SHEIN_OPENAPI_PRODUCT_RECONCILE_SKIP_DETAILS=0 \
    SHEIN_OPENAPI_PRODUCT_RECONCILE_DETAIL_PRIORITY_FILE="$DETAIL_TARGETS" \
    SHEIN_OPENAPI_PRODUCT_RECONCILE_PRIORITY_DETAILS_ONLY=1 \
      bash "$ROOT/scripts/cloud_openapi_product_reconciliation.sh" || DETAIL_STATUS=$?
    if (( DETAIL_STATUS == 0 )); then
      BUILD_STATUS=0
      node scripts/inventory/build_daily_inventory_replenishment_plan.mjs \
        --date "$DATE" \
        --operation-mode et_low_inventory_safety \
        --required-detail-targets "$DETAIL_TARGETS" \
        --bootstrap-lock-file "$BOOTSTRAP_LOCK_FILE" \
        --out "$SOURCE_PLAN" || BUILD_STATUS=$?
    else
      echo "[et_low_inventory_guard] targeted current-detail refresh failed status=$DETAIL_STATUS" >&2
    fi
  fi
fi

FILTER_STATUS=0
node scripts/inventory/build_et_low_inventory_safety_plan.mjs \
  --source-plan "$SOURCE_PLAN" \
  --batch-id "$BATCH_ID" \
  --out "$PLAN" || FILTER_STATUS=$?
if [[ ! -s "$PLAN" ]]; then
  echo "[et_low_inventory_guard] safety planner did not produce a plan status=$FILTER_STATUS" >&2
  if (( FILTER_STATUS != 0 )); then exit "$FILTER_STATUS"; fi
  exit 1
fi

HASH="$(jq -r '.payloadHash // empty' "$PLAN")"
TOTAL="$(jq -r '.actionable | length' "$PLAN")"
EXECUTABLE="$(jq -r '.executable == true and ((.blockers // []) | length == 0)' "$PLAN")"
if [[ ! "$HASH" =~ ^[a-f0-9]{64}$ ]]; then
  echo "[et_low_inventory_guard] safety plan has no valid payloadHash" >&2
  exit 1
fi
if [[ "$EXECUTABLE" != "true" ]]; then
  tmp="$STATE.$$.tmp"
  jq -n \
    --arg at "$(date -Is)" \
    --arg batch "$BATCH_ID" \
    --arg plan "$PLAN" \
    --arg hash "$HASH" \
    --argjson blockers "$(jq '.blockers // []' "$PLAN")" \
    '{ok:false,active:true,updatedAt:$at,lastProcessedBatchId:$batch,plan:$plan,planHash:$hash,result:null,blockers:$blockers}' >"$tmp"
  mv "$tmp" "$STATE"
  jq '{ok:false,state:"plan_blocked",payloadHash,blockers,watch,counts}' "$PLAN"
  if (( FILTER_STATUS != 0 )); then exit "$FILTER_STATUS"; fi
  exit 2
fi

set +e
node scripts/inventory/execute_daily_inventory_replenishment_plan.mjs \
  --plan "$PLAN" \
  --bootstrap-lock-file "$BOOTSTRAP_LOCK_FILE" \
  --execute \
  --execution-mode automatic \
  --confirm-hash "$HASH" \
  --max-rows 1000 \
  --out "$RESULT"
EXECUTOR_STATUS=$?
set -e
if [[ ! -s "$RESULT" ]] || ! jq -e --arg hash "$HASH" --argjson total "$TOTAL" '
  .planHash == $hash and .execute == true and (.results | length) == $total
' "$RESULT" >/dev/null; then
  echo "[et_low_inventory_guard] executor did not produce a complete result" >&2
  if (( EXECUTOR_STATUS != 0 )); then exit "$EXECUTOR_STATUS"; fi
  exit 1
fi

BLOCKED="$(jq '[.results[] | select(.state == "blocked")] | length' "$RESULT")"
BLOCKED_CANONICAL="$(jq '.watch.blockedLowEtCanonicalCount // 0' "$PLAN")"
UPDATED="$(jq '[.results[] | select(.state == "updated_readback_matched")] | length' "$RESULT")"
SKIPPED="$(jq '[.results[] | select(.state | startswith("skipped_"))] | length' "$RESULT")"
WATCH_ACTIVE="$(jq -r '.watch.active == true' "$PLAN")"
ACTIVE=false
if [[ "$WATCH_ACTIVE" == "true" || "$BLOCKED" != "0" || "$BLOCKED_CANONICAL" != "0" ]]; then ACTIVE=true; fi
tmp="$STATE.$$.tmp"
jq -n \
  --arg at "$(date -Is)" \
  --arg batch "$BATCH_ID" \
  --arg plan "$PLAN" \
  --arg result "$RESULT" \
  --arg hash "$HASH" \
  --argjson active "$ACTIVE" \
  --argjson total "$TOTAL" \
  --argjson updated "$UPDATED" \
  --argjson skipped "$SKIPPED" \
  --argjson blocked "$BLOCKED" \
  --argjson blockedCanonical "$BLOCKED_CANONICAL" \
  '{ok:($blocked==0),businessState:(if $active then "watching" else "settled" end),active:$active,updatedAt:$at,lastProcessedBatchId:$batch,plan:$plan,planHash:$hash,result:$result,counts:{total:$total,updated:$updated,skipped:$skipped,blocked:$blocked,blockedCanonical:$blockedCanonical,pendingCanonical:$blockedCanonical}}' >"$tmp"
mv "$tmp" "$STATE"
jq '{ok,state:"completed",active,lastProcessedBatchId,planHash,result,counts}' "$STATE"
if (( BLOCKED > 0 )); then exit 1; fi
