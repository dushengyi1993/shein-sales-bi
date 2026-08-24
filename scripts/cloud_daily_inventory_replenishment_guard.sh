#!/usr/bin/env bash
set -euo pipefail
ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
DATE="${SHEIN_BI_INVENTORY_RUN_DATE:-$(TZ=Asia/Shanghai date +%F)}"
BUSINESS_DATE="${SHEIN_BI_INVENTORY_BUSINESS_DATE:-$(TZ=Asia/Shanghai date -d yesterday +%F)}"
RUN_DEADLINE_EPOCH="${SHEIN_BI_INVENTORY_RUN_DEADLINE_EPOCH:-0}"
RUNTIME_ROOT="${SHEIN_BI_INVENTORY_RUNTIME_ROOT:-/srv/shein-bi/runtime/daily-inventory-replenishment}"
PORTAL_URL="${SHEIN_BI_PORTAL_URL:-http://127.0.0.1:8787}"
# Stable per-run force-refresh token: the same run reuses it (retries inside
# this run dedupe against the Portal queue), while a later business re-run
# forms a new token and can never be swallowed by the 30-day completed
# tombstone of the previous run on the same core generation. Deterministic
# source: the UTC start second of this run; overridable for pinned runs.
REFRESH_RUN_TOKEN="${SHEIN_BI_INVENTORY_REFRESH_TOKEN:-daily-inventory:$(date -u +%s)}"
if [[ ! "$REFRESH_RUN_TOKEN" =~ ^[A-Za-z0-9._:-]{1,160}$ ]]; then
  echo "[daily_inventory_guard] refresh token must be 1-160 safe characters" >&2
  exit 64
fi
LINKS_DATA_FILE="${SHEIN_BI_LINKS_DATA_FILE:-$ROOT/outputs/bi-portal/sections/linksData.json}"
LINKS_MAX_AGE_SECONDS="${SHEIN_BI_INVENTORY_LINKS_MAX_AGE_SECONDS:-1800}"
LINKS_REFRESH_TIMEOUT_SECONDS="${SHEIN_BI_INVENTORY_LINKS_REFRESH_TIMEOUT_SECONDS:-1200}"
# The ET forwarder sync-refreshes only orders/waybills/afterSales and enqueues
# inventoryTrend asynchronously, so the guard performs exactly one bounded
# synchronous inventoryTrend refresh before the first plan build, always
# forced (force=1) because a freshly published cache can still carry an old
# ET business day. The refresh must succeed over HTTP, must publish a cachedAt
# strictly later than the request start, and must contain at least one matched
# current-day ET operational row; any failure aborts the guard (fail closed,
# no inventory write, no swallowed error) and the write interface is never
# retried.
INVENTORY_TREND_FILE="${SHEIN_BI_INVENTORY_TREND_FILE:-$ROOT/outputs/bi-portal/sections/inventoryTrend.json}"
INVENTORY_TREND_MAX_AGE_SECONDS="${SHEIN_BI_INVENTORY_TREND_MAX_AGE_SECONDS:-1800}"
INVENTORY_TREND_REFRESH_TIMEOUT_SECONDS="${SHEIN_BI_INVENTORY_TREND_REFRESH_TIMEOUT_SECONDS:-1200}"
REFRESH_OPENAPI_ON_STALE="${SHEIN_BI_INVENTORY_REFRESH_OPENAPI_ON_STALE:-1}"
REQUIRE_PIPELINE_MARKERS="${SHEIN_BI_INVENTORY_REQUIRE_PIPELINE_MARKERS:-0}"
STOCK_NOT_BEFORE="${SHEIN_BI_INVENTORY_STOCK_NOT_BEFORE:-${DATE}T15:11:00+08:00}"
# The daily plan emits detailRefreshTargets for every inventory-relevant SPU
# (measured maxPerStore=59 on FY for 2026-08-15). Refreshing those SPUs
# with current detail must stay bounded per store: the guard never runs a
# blind full-catalog detail scan (no zero-MAX_DETAILS full scan), and
# over-budget manifests fail closed instead of refreshing a partial target set.
DETAIL_TARGET_BUDGET_PER_STORE="${SHEIN_BI_INVENTORY_DETAIL_TARGET_BUDGET_PER_STORE:-64}"
REFRESH_DETAIL_TARGETS_ON_BLOCKED="${SHEIN_BI_INVENTORY_REFRESH_DETAIL_TARGETS_ON_BLOCKED:-1}"
# The executor refuses to slice the actionable set, so the guard applies the
# same per-run row ceiling before invoking it: TOTAL > MAX_ROWS exits 2 with
# no executor call and no inventory write. Both gates must stay in sync.
MAX_ROWS="${SHEIN_BI_INVENTORY_MAX_ROWS:-1000}"
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
if [[ ! "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] \
  || [[ "$(TZ=Asia/Shanghai date -d "$DATE" +%F 2>/dev/null || true)" != "$DATE" ]]; then
  echo "[daily_inventory_guard] invalid runDate=$DATE" >&2
  exit 65
fi
EXPECTED_BUSINESS_DATE="$(TZ=Asia/Shanghai date -d "$DATE - 1 day" +%F)"
if [[ "$BUSINESS_DATE" != "$EXPECTED_BUSINESS_DATE" ]]; then
  echo "[daily_inventory_guard] businessDate=$BUSINESS_DATE must equal runDate=$DATE minus one day ($EXPECTED_BUSINESS_DATE)" >&2
  exit 65
fi
if [[ ! "$DETAIL_TARGET_BUDGET_PER_STORE" =~ ^[1-9][0-9]*$ ]]; then
  echo "[daily_inventory_guard] invalid SHEIN_BI_INVENTORY_DETAIL_TARGET_BUDGET_PER_STORE=$DETAIL_TARGET_BUDGET_PER_STORE" >&2
  exit 64
fi
if [[ ! "$MAX_ROWS" =~ ^[1-9][0-9]*$ ]]; then
  echo "[daily_inventory_guard] invalid SHEIN_BI_INVENTORY_MAX_ROWS=$MAX_ROWS" >&2
  exit 64
fi
mkdir -p "$(dirname "$PLAN")" "$(dirname "$RESULT")" "$DETAIL_TARGETS_DIR"
. "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$LOCK"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "daily inventory replenishment guard is already running" >&2
  exit 75
fi
cd "$ROOT"

write_inventory_marker() {
  local status="$1"
  local message="$2"
  local args=(write --stage daily-inventory-guard --date "$DATE" --business-date "$BUSINESS_DATE" --status "$status" --message "$message")
  [[ -s "$PLAN" ]] && args+=(--evidence "$PLAN")
  [[ -s "$RESULT" ]] && args+=(--evidence "$RESULT")
  node scripts/pipeline_marker.mjs "${args[@]}" >/dev/null
}

result_is_complete_and_safe() {
  jq -e --arg hash "$HASH" --argjson total "$TOTAL" '
    . as $result
    | .planHash == $hash
    and .execute == true
    and .executionMode == "automatic"
    and (.results | length) == $total
    and all(.results[];
      if .state == "updated_readback_matched" then
        (.after.totalUsableInventory == .targetUsableInventory) and ((.writes // []) | length > 0)
      elif .state == "skipped_target_already_matched" then
        .before.totalUsableInventory == .targetUsableInventory
      elif .state == "skipped_terminal_readback_recorded" then
        $result.reconcilePendingOnly == true
        and .terminalDisposition == "readback_matched"
        and ((.terminalIntentId // "") | length) > 0
        and ((.terminalRunDate // "") | length) == 10
        and ((.terminalRecordedAt // "") | length) > 0
        and (.currentLiveUsableInventory | type) == "number"
        and .before.totalUsableInventory == .currentLiveUsableInventory
        and ((.writes // []) | length) == 0
      elif .state == "skipped_safety_no_increase" then
        ($result.executionConstraints.decreaseOnly == true)
        and (.before.totalUsableInventory | type) == "number"
        and .before.totalUsableInventory < .targetUsableInventory
      elif .state == "skipped_within_scarcity_band" then
        .ruleClass == "recent_sale_scarcity" and ((.before.totalUsableInventory | type) == "number")
      elif .state == "skipped_recovered" then
        .ruleClass == "legacy_virtual_inventory_top_up" and ((.before.totalUsableInventory | type) == "number")
      else false end)
  ' "$RESULT" >/dev/null \
    && node scripts/validate_daily_operating_refresh.mjs \
      --inventory-only \
      --root "$ROOT" \
      --marker-root "$ROOT/state/pipeline-markers" \
      --state-dir "$ROOT/state/cloud_morning_chain" \
      --inventory-runtime-root "$RUNTIME_ROOT" \
      --run-date "$DATE" \
      --business-date "$BUSINESS_DATE" >/dev/null
}

result_is_readback_pending_only() {
  jq -e --arg hash "$HASH" --argjson total "$TOTAL" '
    .planHash == $hash
    and .execute == true
    and .executionMode == "automatic"
    and (.results | length) == $total
    and ([.results[] | select(.state == "submitted_but_readback_pending")] | length) > 0
    and all(.results[];
      .state == "submitted_but_readback_pending"
      or .state == "updated_readback_matched"
      or (.state | startswith("skipped_")))
  ' "$RESULT" >/dev/null
}

JOURNAL="$RESULT.journal.ndjson"
RECONCILE_PENDING_ONLY=0
if [[ -s "$PLAN" && -s "$RESULT" ]]; then
  HASH="$(jq -r '.payloadHash // empty' "$PLAN")"
  TOTAL="$(jq -r '.actionable | length' "$PLAN")"
  if [[ "$HASH" =~ ^[a-f0-9]{64}$ && "$TOTAL" =~ ^[0-9]+$ ]] && result_is_complete_and_safe; then
    write_inventory_marker done "automatic inventory execution completed with plan/result hash and terminal readback evidence"
    jq '{ok:true,state:"already_completed",planHash,executionMode,generatedAt,counts:{
      total:(.results|length),
      updated:([.results[]|select(.state=="updated_readback_matched")]|length),
      skipped:([.results[]|select(.state|startswith("skipped_"))]|length),
      blocked:0
    }}' "$RESULT"
    exit 0
  fi
fi
PENDING_INTENT_COUNT=0
CURRENT_PENDING_INTENT_COUNT=0
CURRENT_READBACK_MATCHED_INTENT_COUNT=0
HISTORICAL_PENDING_INTENT_COUNT=0
READBACK_MATCHED_INTENT_COUNT=0
LIFECYCLE_JSON="$(node --input-type=module - "$JOURNAL" "$DATE" <<'NODE'
import path from 'node:path';
import {
  discoverInventoryJournalFiles,
  readInventoryIntentLifecycle,
  readInventoryIntentJournals,
} from './lib/durable_inventory_write.mjs';
// readInventoryIntentLifecycle remains the underlying single-file parser; the
// directory helper aggregates its strict results without trusting RESULT files.
const currentJournal = path.resolve(process.argv[2]);
const maxRunDate = process.argv[3];
const inventoryJournalDirectories = String(process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS || '')
  .split(path.delimiter)
  .map(directory => directory.trim())
  .filter(Boolean);
const files = await discoverInventoryJournalFiles(currentJournal, {
  includeAll: true,
  additionalDirectories: inventoryJournalDirectories,
});
const lifecycle = await readInventoryIntentJournals(files, {maxRunDate});
let currentPending = 0;
let currentReadbackMatched = 0;
let historicalPending = 0;
for (const record of lifecycle.records) {
  const isCurrent = record.journalFile === currentJournal;
  currentPending += isCurrent ? record.pending.size : 0;
  currentReadbackMatched += isCurrent
    ? [...record.terminalOutcomes.values()].filter(row => row.disposition === 'readback_matched').length
    : 0;
  for (const intent of record.pending.values()) {
    if (intent.runDate < maxRunDate) historicalPending += 1;
  }
}
process.stdout.write(JSON.stringify({
  pending: lifecycle.pending.size,
  currentPending,
  currentReadbackMatched,
  historicalPending,
  readbackMatched: [...lifecycle.terminalOutcomes.values()].filter(row => row.disposition === 'readback_matched').length,
}));
NODE
)"
PENDING_INTENT_COUNT="$(jq -r '.pending // -1' <<<"$LIFECYCLE_JSON")"
CURRENT_PENDING_INTENT_COUNT="$(jq -r '.currentPending // -1' <<<"$LIFECYCLE_JSON")"
CURRENT_READBACK_MATCHED_INTENT_COUNT="$(jq -r '.currentReadbackMatched // -1' <<<"$LIFECYCLE_JSON")"
HISTORICAL_PENDING_INTENT_COUNT="$(jq -r '.historicalPending // -1' <<<"$LIFECYCLE_JSON")"
READBACK_MATCHED_INTENT_COUNT="$(jq -r '.readbackMatched // -1' <<<"$LIFECYCLE_JSON")"
for count in "$PENDING_INTENT_COUNT" "$CURRENT_PENDING_INTENT_COUNT" "$CURRENT_READBACK_MATCHED_INTENT_COUNT" "$HISTORICAL_PENDING_INTENT_COUNT" "$READBACK_MATCHED_INTENT_COUNT"; do
  [[ "$count" =~ ^[0-9]+$ ]] || {
    echo "[daily_inventory_guard] durable inventory journal lifecycle count is invalid" >&2
    exit 65
  }
done
# PENDING_INTENT_COUNT > 0 || READBACK_MATCHED_INTENT_COUNT > 0 is the total
# journal signal. Only current-date lifecycle rows select reconcile-only;
# historical rows retain item-scoped continuation through the executor.
if (( CURRENT_PENDING_INTENT_COUNT > 0 || CURRENT_READBACK_MATCHED_INTENT_COUNT > 0 )); then
  if [[ ! -s "$PLAN" ]]; then
    echo "[daily_inventory_guard] durable inventory intent exists but its immutable plan is missing; refuse refresh, rebuild and every inventory write" >&2
    exit 76
  fi
  RECONCILE_PENDING_ONLY=1
  echo "[daily_inventory_guard] durable inventory journal requires lifecycle recovery pending=$PENDING_INTENT_COUNT readbackMatched=$READBACK_MATCHED_INTENT_COUNT; preserve the immutable plan and run readback-only reconciliation currentPending=$CURRENT_PENDING_INTENT_COUNT currentReadbackMatched=$CURRENT_READBACK_MATCHED_INTENT_COUNT"
elif (( HISTORICAL_PENDING_INTENT_COUNT > 0 )); then
  echo "[daily_inventory_guard] historical durable inventory intent(s) pending=$HISTORICAL_PENDING_INTENT_COUNT; build today's plan and freeze only matching store/SKC/SKU scopes"
fi

if (( RECONCILE_PENDING_ONLY == 0 )) && [[ "$REQUIRE_PIPELINE_MARKERS" == "1" || "$REQUIRE_PIPELINE_MARKERS" == "true" ]]; then
  node scripts/pipeline_marker.mjs require \
    --stage morning-links-ready \
    --date "$DATE" \
    --status done \
    --require-evidence \
    || {
      echo "[daily_inventory_guard] all-store morning link merge is not ready" >&2
      exit 75
    }
  node scripts/pipeline_marker.mjs require \
    --stage stock-refresh \
    --date "$DATE" \
    --status done \
    --not-before "$STOCK_NOT_BEFORE" \
    --require-evidence \
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
    "$PORTAL_URL/api/bi/section/linksData?refresh=1&refreshToken=${REFRESH_RUN_TOKEN}" >/dev/null
  age="$(links_data_age_seconds 2>/dev/null || true)"
  if [[ ! "$age" =~ ^[0-9]+$ ]] || (( age > LINKS_MAX_AGE_SECONDS )); then
    echo "[daily_inventory_guard] linksData refresh did not publish a fresh cache ageSeconds=${age:-unknown}" >&2
    return 1
  fi
  echo "[daily_inventory_guard] linksData refresh complete ageSeconds=$age"
}

inventory_trend_age_seconds() {
  local cached_at cached_epoch now_epoch
  [[ -s "$INVENTORY_TREND_FILE" ]] || return 1
  cached_at="$(jq -r '.cachedAt // .generatedAt // empty' "$INVENTORY_TREND_FILE")"
  [[ -n "$cached_at" ]] || return 1
  cached_epoch="$(date -d "$cached_at" +%s 2>/dev/null)" || return 1
  now_epoch="$(date +%s)"
  (( now_epoch >= cached_epoch )) || return 1
  printf '%s\n' "$((now_epoch - cached_epoch))"
}

inventory_trend_published_epoch_seconds() {
  local cached_at cached_epoch
  [[ -s "$INVENTORY_TREND_FILE" ]] || return 1
  cached_at="$(jq -r '.cachedAt // .generatedAt // empty' "$INVENTORY_TREND_FILE")"
  [[ -n "$cached_at" ]] || return 1
  cached_epoch="$(date -d "$cached_at" +%s 2>/dev/null)" || return 1
  printf '%s\n' "$cached_epoch"
}

# Mirror the planner's current-day gate on the refreshed artifact: count
# inventoryDepletion.products rows whose inventory_match_status is "matched"
# and whose per-row warehouse-position operational date equals today's
# business date. Same row rule as the planner: full-carton policy rows use
# et_box_snapshot_date, all others use et_store_snapshot_date.
inventory_trend_matched_current_day_rows() {
  local rows
  rows="$(jq -r --arg date "$DATE" '
    . as $doc
    | (if ($doc.data | type) == "object" then $doc.data else $doc end)
    | ((.inventoryDepletion // {}) | (.products // []))
    | [ .[]
      | select((( .inventory_match_status // "") == "matched"))
      | (if ((.et_operational_stock_policy // "") | tostring | contains("01_full_carton_exception"))
         then (.et_box_snapshot_date // "")
         else (.et_store_snapshot_date // "")
         end)
      | if type == "string" then .[0:10] else "" end
      | select(. == $date)
      ]
    | length
  ' "$INVENTORY_TREND_FILE")" || return 1
  [[ "$rows" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$rows"
}

# Bounded synchronous inventoryTrend refresh, symmetric with linksData, plus
# three hard post-conditions: HTTP success, cachedAt strictly advanced past
# the request start, and at least one matched current-day ET operational row.
# This write interface is called at most once per run and is never retried.
ensure_inventory_trend_fresh() {
  local force="${1:-0}"
  local age request_start_epoch published_epoch matched_current_day
  age="$(inventory_trend_age_seconds 2>/dev/null || true)"
  if [[ "$force" != "1" && "$age" =~ ^[0-9]+$ ]] && (( age <= INVENTORY_TREND_MAX_AGE_SECONDS )); then
    echo "[daily_inventory_guard] inventoryTrend fresh ageSeconds=$age; skip duplicate refresh"
    return 0
  fi
  request_start_epoch="$(date +%s)"
  echo "[daily_inventory_guard] refresh inventoryTrend synchronously force=$force previousAgeSeconds=${age:-unknown}"
  if ! curl -fsS --max-time "$INVENTORY_TREND_REFRESH_TIMEOUT_SECONDS" \
    -H 'X-SHEIN-BI-HOST-LOCKED-WORKER: 1' \
    "$PORTAL_URL/api/bi/section/inventoryTrend?refresh=1&refreshToken=${REFRESH_RUN_TOKEN}" >/dev/null; then
    echo "[daily_inventory_guard] inventoryTrend HTTP refresh failed; blocking the daily inventory guard" >&2
    return 1
  fi
  age="$(inventory_trend_age_seconds 2>/dev/null || true)"
  if [[ ! "$age" =~ ^[0-9]+$ ]] || (( age > INVENTORY_TREND_MAX_AGE_SECONDS )); then
    echo "[daily_inventory_guard] inventoryTrend refresh did not publish a fresh cache ageSeconds=${age:-unknown}" >&2
    return 1
  fi
  published_epoch="$(inventory_trend_published_epoch_seconds)" || {
    echo "[daily_inventory_guard] inventoryTrend published timestamp is unreadable after refresh" >&2
    return 1
  }
  if (( published_epoch <= request_start_epoch )); then
    echo "[daily_inventory_guard] inventoryTrend cachedAt did not advance past request start publishedEpoch=$published_epoch requestStartEpoch=$request_start_epoch; blocking" >&2
    return 1
  fi
  matched_current_day="$(inventory_trend_matched_current_day_rows)" || {
    echo "[daily_inventory_guard] inventoryTrend matched current-day row count is unreadable after refresh" >&2
    return 1
  }
  if [[ ! "$matched_current_day" =~ ^[0-9]+$ ]] || (( matched_current_day <= 0 )); then
    echo "[daily_inventory_guard] inventoryTrend has no matched current-day operational rows date=$DATE matched=${matched_current_day:-unknown}; blocking" >&2
    return 1
  fi
  echo "[daily_inventory_guard] inventoryTrend refresh complete ageSeconds=$age cachedAtAdvanced=1 matchedCurrentDayRows=$matched_current_day"
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
  # MAX_DETAILS is the manifest's exact maxPerStore (already validated <=
  # budget), so the reconciliation only pays for the real target count while
  # the budget check above still fails closed for any store over the ceiling.
  SHEIN_OPENAPI_PRODUCT_RECONCILE_STORES="$RECONCILE_STORES" \
  SHEIN_OPENAPI_PRODUCT_RECONCILE_CONCURRENCY=2 \
  SHEIN_OPENAPI_PRODUCT_RECONCILE_MAX_DETAILS="$max_targets" \
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

# The morning chain refreshes the warehouse first. The ET forwarder only
# sync-refreshes orders/waybills/afterSales and queues inventoryTrend
# asynchronously, so both sections consumed by the inventory planner are
# refreshed here before hashing; never depend on a detached prewarm process
# surviving a oneshot systemd unit. inventoryTrend is always force-refreshed
# once per daily run (a fresh cachedAt can still hide an old ET business day);
# HTTP failure, a cachedAt that did not advance, or zero matched current-day
# ET rows aborts the guard before the plan build. The error is not swallowed
# and the write interface is never retried.
if (( RECONCILE_PENDING_ONLY == 0 )); then
  ensure_links_data_fresh || true
  ensure_inventory_trend_fresh 1
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
      test(" OpenAPI product detail evidence is incomplete($|:)")
      or test(" OpenAPI product canonical evidence is incomplete($|:)")
      or test(" OpenAPI product canonical evidence is not from current detail($|:)"))
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
else
  PLAN_STATUS=0
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
# Double-gated row ceiling: the executor refuses to slice, and this guard
# refuses to invoke it when the plan already exceeds the ceiling. This check
# sits before the already-completed shortcut and before the executor, so a
# growing actionable set can never produce a partial inventory write.
if (( TOTAL > MAX_ROWS )); then
  echo "[daily_inventory_guard] daily inventory plan exceeds per-run row ceiling total=$TOTAL maxRows=$MAX_ROWS; refusing executor to avoid partial writes" >&2
  jq '{ok:false,state:"plan_blocked",date,payloadHash,blockers}' "$PLAN" \
    | jq '. + {blockers: (.blockers + ["daily inventory plan exceeds per-run row ceiling"])}'
  exit 2
fi
if [[ -f "$RESULT" ]] && jq -e --arg hash "$HASH" --argjson total "$TOTAL" '
  .planHash == $hash
  and .execute == true
  and (.results | length) == $total
  and ([.results[].state] | all(. != "planned" and . != "dry_run_ready"))
' "$RESULT" >/dev/null; then
  if result_is_complete_and_safe; then
    write_inventory_marker done "automatic inventory execution completed with plan/result hash and terminal readback evidence"
    jq '{ok:true,state:"already_completed",planHash,executionMode,generatedAt,counts:{
      total:(.results|length),
      updated:([.results[]|select(.state=="updated_readback_matched")]|length),
      skipped:([.results[]|select(.state|startswith("skipped_"))]|length),
      blocked:0
    }}' "$RESULT"
    exit 0
  fi
  echo "[daily_inventory_guard] prior result is not a safe current terminal readback; re-run read-only guards and executor recovery (durable intents forbid duplicate writes)" >&2
fi

if (( RECONCILE_PENDING_ONLY == 0 )) && [[ "$RUN_DEADLINE_EPOCH" =~ ^[1-9][0-9]*$ ]] && (( $(date +%s) >= RUN_DEADLINE_EPOCH )); then
  echo "[daily_inventory_guard] run deadline reached before executor dispatch; no inventory request was submitted" >&2
  write_inventory_marker failed "run deadline reached before executor dispatch"
  exit 76
fi

set +e
EXECUTOR_RECOVERY_ARGS=()
if (( RECONCILE_PENDING_ONLY == 1 )); then
  EXECUTOR_RECOVERY_ARGS+=(--reconcile-pending-only)
fi
node scripts/inventory/execute_daily_inventory_replenishment_plan.mjs \
  --plan "$PLAN" \
  --execute \
  --execution-mode automatic \
  --confirm-hash "$HASH" \
  --max-rows "$MAX_ROWS" \
  "${EXECUTOR_RECOVERY_ARGS[@]}" \
  --out "$RESULT"
EXECUTOR_STATUS=$?
set -e

if [[ ! -f "$RESULT" ]] || ! jq -e --arg hash "$HASH" --argjson total "$TOTAL" '
  .planHash == $hash and .execute == true and .executionMode == "automatic" and (.results | length) == $total
' "$RESULT" >/dev/null; then
  echo "automatic inventory executor did not produce a complete result" >&2
  if (( EXECUTOR_STATUS != 0 )); then
    exit "$EXECUTOR_STATUS"
  fi
  exit 1
fi

# Row-level blockers remain terminal and auditable, but they are not a successful
# inventory run and cannot be promoted to daily-operating-refresh done.
if result_is_readback_pending_only; then
  write_inventory_marker warning "automatic inventory write has an exact durable intent and is waiting for readback; same run will retry readback only"
  jq '{ok:false,state:"submitted_but_readback_pending",planHash,executionMode,generatedAt,counts:{
    total:(.results|length),
    pending:([.results[]|select(.state=="submitted_but_readback_pending")]|length),
    updated:([.results[]|select(.state=="updated_readback_matched")]|length),
    skipped:([.results[]|select(.state|startswith("skipped_"))]|length)
  }}' "$RESULT"
  exit 75
fi
if result_is_complete_and_safe; then
  write_inventory_marker done "automatic inventory execution completed with plan/result hash and terminal readback evidence"
else
  write_inventory_marker warning "automatic inventory execution has terminal blockers or non-matching readback; overall morning run remains failed"
  jq '{ok:false,state:"completed_with_blockers",planHash,executionMode,generatedAt,counts:{
    total:(.results|length),
    updated:([.results[]|select(.state=="updated_readback_matched")]|length),
    skipped:([.results[]|select(.state|startswith("skipped_"))]|length),
    blocked:([.results[]|select(.state=="blocked")]|length)
  }}' "$RESULT"
  exit 2
fi
jq '{ok: (([.results[]|select(.state=="blocked")]|length) == 0),state:"completed",planHash,executionMode,generatedAt,counts:{
  total:(.results|length),
  updated:([.results[]|select(.state=="updated_readback_matched")]|length),
  skipped:([.results[]|select(.state|startswith("skipped_"))]|length),
  blocked:([.results[]|select(.state=="blocked")]|length)
}}' "$RESULT"
