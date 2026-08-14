#!/usr/bin/env bash
set -euo pipefail
ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
DATE="$(TZ=Asia/Shanghai date +%F)"
RUNTIME_ROOT="${SHEIN_BI_INVENTORY_RUNTIME_ROOT:-/srv/shein-bi/runtime/daily-inventory-replenishment}"
PORTAL_URL="${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}"
LINKS_DATA_FILE="${SHEIN_BI_LINKS_DATA_FILE:-$ROOT/outputs/bi-portal/sections/linksData.json}"
LINKS_MAX_AGE_SECONDS="${SHEIN_BI_INVENTORY_LINKS_MAX_AGE_SECONDS:-1800}"
LINKS_REFRESH_TIMEOUT_SECONDS="${SHEIN_BI_INVENTORY_LINKS_REFRESH_TIMEOUT_SECONDS:-1200}"
REFRESH_OPENAPI_ON_STALE="${SHEIN_BI_INVENTORY_REFRESH_OPENAPI_ON_STALE:-1}"
REQUIRE_PIPELINE_MARKERS="${SHEIN_BI_INVENTORY_REQUIRE_PIPELINE_MARKERS:-0}"
STOCK_NOT_BEFORE="${SHEIN_BI_INVENTORY_STOCK_NOT_BEFORE:-${DATE}T15:11:00+08:00}"
# The daily plan emits detailRefreshTargets for every inventory-relevant SPU
# (measured ~31 per store / ~362 total on 2026-08-14). Refreshing those SPUs
# with current detail must stay bounded per store: the guard never runs a
# blind full-catalog detail scan (no zero-MAX_DETAILS full scan), and
# over-budget manifests fail closed instead of refreshing a partial target set.
DETAIL_TARGET_BUDGET_PER_STORE="${SHEIN_BI_INVENTORY_DETAIL_TARGET_BUDGET_PER_STORE:-64}"
REFRESH_DETAIL_TARGETS_ON_BLOCKED="${SHEIN_BI_INVENTORY_REFRESH_DETAIL_TARGETS_ON_BLOCKED:-1}"
# The targeted refresh must cover list + stock for every plan store, so STORES
# stays on the same full 19-store set the reconciliation script defaults to
# (test_daily_inventory_guard_targeted_detail.mjs asserts both constants stay
# identical). Never narrow it to the target subset: the refresh is not a
# detail-only pass for the allowlisted SPUs.
RECONCILE_STORES="${SHEIN_BI_INVENTORY_RECONCILE_STORES:-CX,DL,DX,FY,HL,JSH,JY,LQ,MZ,NM,QH,QY,TS,TZ,TZZ,XC,XL,YJ,ZL}"
PLAN="$RUNTIME_ROOT/plans/daily-inventory-replenishment-$DATE.json"
RESULT="$RUNTIME_ROOT/results/daily-inventory-replenishment-$DATE.json"
DETAIL_TARGETS_DIR="$RUNTIME_ROOT/detail-targets"
DETAIL_TARGETS="$DETAIL_TARGETS_DIR/daily-inventory-detail-targets-$DATE.json"
LOCK="$ROOT/state/locks/daily-inventory-replenishment.lock"
if [[ ! "$DETAIL_TARGET_BUDGET_PER_STORE" =~ ^[1-9][0-9]*$ ]]; then
  echo "[daily_inventory_guard] invalid SHEIN_BI_INVENTORY_DETAIL_TARGET_BUDGET_PER_STORE=$DETAIL_TARGET_BUDGET_PER_STORE" >&2
  exit 64
fi
mkdir -p "$(dirname "$PLAN")" "$(dirname "$RESULT")" "$DETAIL_TARGETS_DIR"
. "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$LOCK"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "daily inventory replenishment guard is already running" >&2
  exit 0
fi
cd "$ROOT"

if [[ "$REQUIRE_PIPELINE_MARKERS" == "1" || "$REQUIRE_PIPELINE_MARKERS" == "true" ]]; then
  node scripts/pipeline_marker.mjs require \
    --stage morning-links-ready \
    --date "$DATE" \
    --status done,warning \
    || {
      echo "[daily_inventory_guard] all-store morning link merge is not ready" >&2
      exit 75
    }
  node scripts/pipeline_marker.mjs require \
    --stage stock-refresh \
    --date "$DATE" \
    --status done,warning \
    --not-before "$STOCK_NOT_BEFORE" \
    || {
      echo "[daily_inventory_guard] stock refresh marker is not ready after $STOCK_NOT_BEFORE" >&2
      exit 75
    }
fi

links_data_age_seconds() {
  local cached_at cached_epoch now_epoch
  [[ -s "$LINKS_DATA_FILE" ]] || return 1
  cached_at="$(jq -r '.cachedAt // .generatedAt // empty' "$LINKS_DATA_FILE")"
  [[ -n "$cached_at" ]] || return 1
  cached_epoch="$(date -d "$cached_at" +%s 2>/dev/null)" || return 1
  now_epoch="$(date +%s)"
  (( now_epoch >= cached_epoch )) || return 1
  printf '%s\n' "$((now_epoch - cached_epoch))"
}

ensure_links_data_fresh() {
  local force="${1:-0}"
  local age
  age="$(links_data_age_seconds 2>/dev/null || true)"
  if [[ "$force" != "1" && "$age" =~ ^[0-9]+$ ]] && (( age <= LINKS_MAX_AGE_SECONDS )); then
    echo "[daily_inventory_guard] linksData fresh ageSeconds=$age; skip duplicate refresh"
    return 0
  fi
  echo "[daily_inventory_guard] refresh linksData synchronously force=$force previousAgeSeconds=${age:-unknown}"
  curl -fsS --max-time "$LINKS_REFRESH_TIMEOUT_SECONDS" \
    -H 'X-SHEIN-BI-HOST-LOCKED-WORKER: 1' \
    "$PORTAL_URL/api/bi/section/linksData?refresh=1" >/dev/null
  age="$(links_data_age_seconds 2>/dev/null || true)"
  if [[ ! "$age" =~ ^[0-9]+$ ]] || (( age > LINKS_MAX_AGE_SECONDS )); then
    echo "[daily_inventory_guard] linksData refresh did not publish a fresh cache ageSeconds=${age:-unknown}" >&2
    return 1
  fi
  echo "[daily_inventory_guard] linksData refresh complete ageSeconds=$age"
}

build_plan() {
  local manifest="${1:-}"
  local status
  set +e
  if [[ -n "$manifest" ]]; then
    node scripts/inventory/build_daily_inventory_replenishment_plan.mjs \
      --date "$DATE" \
      --required-detail-targets "$manifest" \
      --out "$PLAN"
  else
    node scripts/inventory/build_daily_inventory_replenishment_plan.mjs --date "$DATE" --out "$PLAN"
  fi
  status=$?
  set -e
  return "$status"
}

# Write the managed daily detail-target manifest from the current plan's
# detailRefreshTargets (store+SPU pairs), then refresh list + stock for all 19
# stores and current detail only for the allowlisted targets, bounded by the
# per-store budget. The manifest is written atomically (tmp + mv) and must be
# nonempty with max per-store <= budget before any reconciliation runs.
# Return codes: 0 refreshed, 1 refresh/build failed or empty targets
# (caller retains exact blockers), 2 per-store budget exceeded (caller must
# fail closed).
refresh_targeted_openapi_sources() {
  local max_targets status
  local total_targets
  if ! jq -n \
    --arg date "$DATE" \
    --arg generatedAt "$(date -Is)" \
    --argjson budget "$DETAIL_TARGET_BUDGET_PER_STORE" \
    --argjson rows "$(jq '.detailRefreshTargets // []' "$PLAN")" '
      ($rows | reduce .[] as $row ({};
        .[$row.storeKey] = (((.[$row.storeKey] // []) + [$row.spu]) | unique | sort)
      )) as $grouped
      | {
          schemaVersion:"daily-inventory-detail-targets/v1",
          date:$date,
          generatedAt:$generatedAt,
          budgetPerStore:$budget,
          stores:$grouped,
          counts:{
            total:(reduce ($grouped[] | length) as $n (0; . + $n)),
            perStore:($grouped | map_values(length)),
            maxPerStore:(reduce ($grouped[] | length) as $n (0; if $n > . then $n else . end))
          }
        }
    ' >"$DETAIL_TARGETS.tmp"; then
    echo "[daily_inventory_guard] failed to build the targeted detail manifest from the plan" >&2
    return 1
  fi
  mv -f "$DETAIL_TARGETS.tmp" "$DETAIL_TARGETS"
  total_targets="$(jq -r '.counts.total // 0' "$DETAIL_TARGETS")"
  if [[ ! "$total_targets" =~ ^[1-9][0-9]*$ ]]; then
    echo "[daily_inventory_guard] targeted detail manifest is empty; refusing refresh without targets and staying blocked" >&2
    return 1
  fi
  max_targets="$(jq -r '.counts.maxPerStore // 0' "$DETAIL_TARGETS")"
  if [[ ! "$max_targets" =~ ^[0-9]+$ ]] || (( max_targets > DETAIL_TARGET_BUDGET_PER_STORE )); then
    echo "[daily_inventory_guard] targeted detail manifest exceeds per-store budget maxTargets=${max_targets:-unknown} budget=$DETAIL_TARGET_BUDGET_PER_STORE" >&2
    return 2
  fi
  echo "[daily_inventory_guard] targeted OpenAPI refresh manifest=$DETAIL_TARGETS maxTargets=$max_targets budget=$DETAIL_TARGET_BUDGET_PER_STORE"
  set +e
  SHEIN_OPENAPI_PRODUCT_RECONCILE_STORES="$RECONCILE_STORES" \
  SHEIN_OPENAPI_PRODUCT_RECONCILE_CONCURRENCY=2 \
  SHEIN_OPENAPI_PRODUCT_RECONCILE_MAX_DETAILS="$DETAIL_TARGET_BUDGET_PER_STORE" \
  SHEIN_OPENAPI_PRODUCT_RECONCILE_SKIP_DETAILS=0 \
  SHEIN_OPENAPI_PRODUCT_RECONCILE_DETAIL_PRIORITY_FILE="$DETAIL_TARGETS" \
  SHEIN_OPENAPI_PRODUCT_RECONCILE_PRIORITY_DETAILS_ONLY=1 \
    bash scripts/cloud_openapi_product_reconciliation.sh
  status=$?
  set -e
  return "$status"
}

plan_blocked_with_budget_failure() {
  jq '{ok:false,state:"plan_blocked",date,payloadHash,blockers}' "$PLAN" \
    | jq '. + {blockers: (.blockers + ["daily current-detail target manifest exceeds per-store budget"])}'
}

# The morning chain refreshes the warehouse first. Rebuild the exact section
# consumed by the inventory planner before hashing; never depend on a detached
# prewarm process surviving a oneshot systemd unit.
ensure_links_data_fresh || true
PLAN_STATUS=0
build_plan || PLAN_STATUS=$?

if [[ ! -s "$PLAN" ]]; then
  echo "daily inventory planner did not produce a plan status=$PLAN_STATUS" >&2
  if (( PLAN_STATUS != 0 )); then
    exit "$PLAN_STATUS"
  fi
  exit 1
fi

if jq -e '(.blockers // []) | any(. == "BI links data is stale" or startswith("BI links data is stale:"))' "$PLAN" >/dev/null; then
  echo "[daily_inventory_guard] retry once after forced linksData refresh"
  ensure_links_data_fresh 1 || true
  PLAN_STATUS=0
  build_plan || PLAN_STATUS=$?
fi

# A single targeted-refresh decision per run. Stale/failed/unavailable OpenAPI
# sources OR recoverable current-detail/canonical blockers (only when the
# first build emitted targets) trigger exactly one reconciliation, then the
# same-day plan is rebuilt with the manifest. The branches are mutually
# exclusive, so a failed refresh on the old plan can never trigger a second
# targeted reconciliation in the same run. Missing targets, budget overruns,
# non-current targets, canonical conflicts and SKU/ET/exposure gaps still fail
# closed either here or inside the second build.
REFRESH_REASON=""
if [[ "$REFRESH_OPENAPI_ON_STALE" == "1" ]] && jq -e '
  (.blockers // []) | any(
    test(" OpenAPI product snapshot is stale$")
    or test(" OpenAPI stock snapshot has failed chunks$")
    or test(" OpenAPI product snapshot unavailable:")
  )
' "$PLAN" >/dev/null; then
  REFRESH_REASON="openapi_sources_stale"
elif [[ "$REFRESH_DETAIL_TARGETS_ON_BLOCKED" == "1" ]] \
  && [[ "$(jq -r '.executable' "$PLAN")" != "true" ]] \
  && jq -e '
    ((.detailRefreshTargets // []) | length) > 0
    and ((.blockers // []) | length) > 0
    and all(.blockers[];
      test(" OpenAPI product detail evidence is incomplete$")
      or test(" OpenAPI product canonical evidence is incomplete$")
      or test(" OpenAPI product canonical evidence is not from current detail"))
  ' "$PLAN" >/dev/null; then
  REFRESH_REASON="current_detail_blocked"
fi
if [[ -n "$REFRESH_REASON" ]]; then
  echo "[daily_inventory_guard] refresh 19-store read-only OpenAPI sources with targeted current-detail budget and rebuild plan reason=$REFRESH_REASON"
  REFRESH_STATUS=0
  refresh_targeted_openapi_sources || REFRESH_STATUS=$?
  if (( REFRESH_STATUS == 0 )); then
    PLAN_STATUS=0
    build_plan "$DETAIL_TARGETS" || PLAN_STATUS=$?
  elif (( REFRESH_STATUS == 2 )); then
    echo "[daily_inventory_guard] daily current-detail target budget exceeded; fail closed" >&2
    plan_blocked_with_budget_failure
    exit 2
  else
    echo "[daily_inventory_guard] targeted OpenAPI refresh failed status=$REFRESH_STATUS; retain exact blockers; no second targeted refresh this run" >&2
  fi
fi

HASH="$(jq -r '.payloadHash // empty' "$PLAN")"
TOTAL="$(jq -r '.actionable | length' "$PLAN")"
EXECUTABLE="$(jq -r '.executable == true and ((.blockers // []) | length == 0)' "$PLAN")"
if [[ ! "$HASH" =~ ^[a-f0-9]{64}$ ]]; then
  echo "daily inventory plan has no valid payloadHash" >&2
  exit 1
fi
if [[ "$EXECUTABLE" != "true" ]]; then
  jq '{ok:false,state:"plan_blocked",date,payloadHash,blockers}' "$PLAN"
  if (( PLAN_STATUS != 0 )); then
    exit "$PLAN_STATUS"
  fi
  exit 2
fi
if [[ -f "$RESULT" ]] && jq -e --arg hash "$HASH" --argjson total "$TOTAL" '
  .planHash == $hash
  and .execute == true
  and (.results | length) == $total
  and ([.results[].state] | all(. != "planned" and . != "dry_run_ready"))
' "$RESULT" >/dev/null; then
  jq '{ok: (([.results[]|select(.state=="blocked")]|length) == 0),state:"already_completed",planHash,executionMode,generatedAt,counts:{
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

# Row-level blockers are terminal, auditable business results. The 14:45 report
# surfaces them; they must not turn a completed daily scan into a systemd crash.
jq '{ok: (([.results[]|select(.state=="blocked")]|length) == 0),state:"completed",planHash,executionMode,generatedAt,counts:{
  total:(.results|length),
  updated:([.results[]|select(.state=="updated_readback_matched")]|length),
  skipped:([.results[]|select(.state|startswith("skipped_"))]|length),
  blocked:([.results[]|select(.state=="blocked")]|length)
}}' "$RESULT"
