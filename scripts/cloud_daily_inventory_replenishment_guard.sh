#!/usr/bin/env bash
set -euo pipefail
ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
DATE="${SHEIN_BI_INVENTORY_RUN_DATE:-$(TZ=Asia/Shanghai date +%F)}"
BUSINESS_DATE="${SHEIN_BI_INVENTORY_BUSINESS_DATE:-$(TZ=Asia/Shanghai date -d yesterday +%F)}"
RUN_DEADLINE_EPOCH="${SHEIN_BI_INVENTORY_RUN_DEADLINE_EPOCH:-0}"
RUNTIME_ROOT="${SHEIN_BI_INVENTORY_RUNTIME_ROOT:-/srv/shein-bi/runtime/daily-inventory-replenishment}"
MARKER_ROOT="${SHEIN_BI_PIPELINE_MARKER_ROOT:-$ROOT/state/pipeline-markers}"
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
# ET business day. The refresh must return a terminal inventoryTrend JSON ack
# and leave a cache no older than 1800 seconds with at least one matched
# current-day ET operational row; any failure aborts the guard (fail closed, no
# inventory write, no swallowed error) and the write interface is never retried.
INVENTORY_TREND_FILE="${SHEIN_BI_INVENTORY_TREND_FILE:-$ROOT/outputs/bi-portal/sections/inventoryTrend.json}"
INVENTORY_TREND_MAX_AGE_SECONDS="${SHEIN_BI_INVENTORY_TREND_MAX_AGE_SECONDS:-1800}"
INVENTORY_TREND_REFRESH_TIMEOUT_SECONDS="${SHEIN_BI_INVENTORY_TREND_REFRESH_TIMEOUT_SECONDS:-1200}"
REFRESH_OPENAPI_ON_STALE="${SHEIN_BI_INVENTORY_REFRESH_OPENAPI_ON_STALE:-1}"
REQUIRE_PIPELINE_MARKERS="${SHEIN_BI_INVENTORY_REQUIRE_PIPELINE_MARKERS:-0}"
STOCK_NOT_BEFORE="${SHEIN_BI_INVENTORY_STOCK_NOT_BEFORE:-${DATE}T15:11:00+08:00}"
# The daily plan emits detailRefreshTargets for every inventory-relevant SPU
# (measured maxPerStore=68 on DX for 2026-08-30). Refreshing those SPUs
# with current detail must stay bounded per store: the guard never runs a
# blind full-catalog detail scan (no zero-MAX_DETAILS full scan), and
# over-budget manifests fail closed instead of refreshing a partial target set.
DETAIL_TARGET_BUDGET_PER_STORE="${SHEIN_BI_INVENTORY_DETAIL_TARGET_BUDGET_PER_STORE:-96}"
REFRESH_DETAIL_TARGETS_ON_BLOCKED="${SHEIN_BI_INVENTORY_REFRESH_DETAIL_TARGETS_ON_BLOCKED:-1}"
DETAIL_REBUILD_MAX_ATTEMPTS="${SHEIN_BI_INVENTORY_DETAIL_REBUILD_MAX_ATTEMPTS:-3}"
# The terminal manifest verifier reads the exact cache root used by the
# targeted reconciliation. A successful wrapper summary is not evidence that
# every requested SPU received current detail.
PRODUCT_CACHE_DIR="${SHEIN_OPENAPI_PRODUCT_CACHE_DIR:-/srv/shein-bi/runtime/openapi-product-cache}"
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
if [[ ! "$DETAIL_REBUILD_MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "[daily_inventory_guard] invalid SHEIN_BI_INVENTORY_DETAIL_REBUILD_MAX_ATTEMPTS=$DETAIL_REBUILD_MAX_ATTEMPTS" >&2
  exit 64
fi
mkdir -p "$(dirname "$PLAN")" "$(dirname "$RESULT")" "$DETAIL_TARGETS_DIR"
. "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$LOCK"
exec 9>"$LOCK"
if ! flock -w "${SHEIN_BI_INVENTORY_LOCK_WAIT_SECONDS:-0}" 9; then
  echo "daily inventory replenishment guard is already running" >&2
  exit 75
fi
cd "$ROOT"

BASE_RUNTIME_ROOT="$RUNTIME_ROOT"
SOURCE_MARKER_ROOT="$MARKER_ROOT"
COMMAND_ID="${SHEIN_BI_INVENTORY_COMMAND_ID:-morning:$DATE}"
if [[ ! "$COMMAND_ID" =~ ^[A-Za-z0-9._:-]{1,160}$ ]]; then
  echo "[daily_inventory_guard] invalid command identity" >&2
  exit 64
fi
COMMAND_HASH="$(printf '%s' "$COMMAND_ID" | sha256sum | cut -d ' ' -f 1)"
BATCH_ID="${SHEIN_BI_INVENTORY_BATCH_ID:-batch-${COMMAND_HASH:0:40}}"
if [[ ! "$BATCH_ID" =~ ^[A-Za-z0-9._:-]{1,160}$ ]]; then
  echo "[daily_inventory_guard] invalid batch identity" >&2
  exit 64
fi
INDEX_FILE="$BASE_RUNTIME_ROOT/results/daily-inventory-replenishment-$DATE.index.json"
# Preserve the complete legacy execution without changing its original bytes.
if [[ ! -f "$INDEX_FILE" && -f "$RESULT" ]]; then
  node scripts/inventory/daily_inventory_version_publisher.mjs publish \
    "$BASE_RUNTIME_ROOT" "$DATE" "legacy-$DATE" "morning:$DATE" \
    "$PLAN" "$RESULT" "$SOURCE_MARKER_ROOT/$DATE/daily-inventory-guard.json" >/dev/null
fi
EXISTING_BATCH="$(node scripts/inventory/daily_inventory_version_publisher.mjs read "$BASE_RUNTIME_ROOT" "$DATE" "" "$COMMAND_ID")"
if [[ "$EXISTING_BATCH" != "null" ]]; then
  printf '%s\n' "$EXISTING_BATCH"
  case "$(jq -r '.status' <<<"$EXISTING_BATCH")" in
    done|dry_run_ready) exit 0 ;;
    warning) exit 2 ;;
    *) exit 1 ;;
  esac
fi
# Each command owns its own artifacts. No completed date-level output is reused.
RUNTIME_ROOT="$BASE_RUNTIME_ROOT/runs/$DATE/$COMMAND_HASH"
MARKER_ROOT="$RUNTIME_ROOT/markers"
PLAN="$RUNTIME_ROOT/plans/daily-inventory-replenishment-$DATE.json"
RESULT="$RUNTIME_ROOT/results/daily-inventory-replenishment-$DATE.json"
DETAIL_TARGETS_DIR="$RUNTIME_ROOT/detail-targets"
DETAIL_TARGETS="$DETAIL_TARGETS_DIR/daily-inventory-detail-targets-$DATE.json"
mkdir -p "$(dirname "$PLAN")" "$(dirname "$RESULT")" "$DETAIL_TARGETS_DIR"
export SHEIN_BI_INVENTORY_COMMAND_ID="$COMMAND_ID"
export SHEIN_BI_INVENTORY_JOURNAL_DIRS="${SHEIN_BI_INVENTORY_JOURNAL_DIRS:+$SHEIN_BI_INVENTORY_JOURNAL_DIRS:}$BASE_RUNTIME_ROOT/results:$BASE_RUNTIME_ROOT/runs"

publish_complete_inventory_version() {
  local status=$?
  trap - EXIT
  local marker="$MARKER_ROOT/$DATE/daily-inventory-guard.json"
  if [[ -f "$PLAN" && -f "$RESULT" && -f "$marker" ]]; then
    if [[ ! -f "$RESULT.journal.ndjson" ]] && jq -e 'all(.results[]; ((.writes // [])|length)==0 and .state!="submitted_but_readback_pending")' "$RESULT" >/dev/null; then
      ( set -o noclobber; : > "$RESULT.journal.ndjson" )
    fi
    if ! node scripts/inventory/daily_inventory_version_publisher.mjs publish \
      "$BASE_RUNTIME_ROOT" "$DATE" "$BATCH_ID" "$COMMAND_ID" \
      "$PLAN" "$RESULT" "$marker" "$SOURCE_MARKER_ROOT" >/dev/null; then
      echo "[daily_inventory_guard] complete immutable version publication failed" >&2
      status=1
    elif [[ "$ROOT" == "/opt/shein-bi/app" && "${SHEIN_OPS_BUSINESS_DELIVERY_ENABLED:-1}" == "1" ]]; then
      timeout -k 2 50 node scripts/cloud_team_report_delivery.mjs \
        --business-result "$RESULT" --automation-id inventory-replenishment \
        --business-date "$DATE" --attachment-file "$RESULT" \
        --attachment-name "inventory-$DATE.json" >/dev/null \
        || echo "[daily_inventory_guard] business evidence published; notification remains in shared delivery state" >&2
    fi
  fi
  exit "$status"
}
trap publish_complete_inventory_version EXIT

write_inventory_marker() {
  local status="$1"
  local message="$2"
  local args=(write --stage daily-inventory-guard --date "$DATE" --business-date "$BUSINESS_DATE" --status "$status" --message "$message" --root "$MARKER_ROOT")
  [[ -s "$PLAN" ]] && args+=(--evidence "$PLAN")
  [[ -s "$RESULT" ]] && args+=(--evidence "$RESULT")
  node scripts/pipeline_marker.mjs "${args[@]}" >/dev/null
}

inventory_warning_marker_matches() {
  ROOT_MARKER="$MARKER_ROOT" RUN_DATE="$DATE" BUSINESS_DATE="$BUSINESS_DATE" node - <<'NODE' 2>/dev/null
const fs = require('fs');
const path = require('path');
try {
  const file = path.join(process.env.ROOT_MARKER, process.env.RUN_DATE, 'daily-inventory-guard.json');
  const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  process.exit(marker?.ok === true
    && marker?.stage === 'daily-inventory-guard'
    && marker?.status === 'warning'
    && marker?.runDate === process.env.RUN_DATE
    && marker?.businessDate === process.env.BUSINESS_DATE ? 0 : 1);
} catch { process.exit(1); }
NODE
}

pre_warning_audit() {
  node scripts/validate_daily_operating_refresh.mjs \
    --pre-warning-audit --inventory-only \
    --root "$ROOT" \
    --marker-root "$MARKER_ROOT" \
    --state-dir "$ROOT/state/cloud_morning_chain" \
    --inventory-runtime-root "$RUNTIME_ROOT" \
    --run-date "$DATE" \
    --business-date "$BUSINESS_DATE" >/dev/null
}

publish_audited_inventory_warning() {
  local message="$1"
  # The marker is a candidate until the shared pre-warning validator has
  # reread its exact plan/result evidence and current journal.  A failed audit
  # is immediately downgraded to failed and never returned as warning.
  if ! write_inventory_marker warning "$message"; then
    echo "[daily_inventory_guard] could not publish the inventory warning candidate" >&2
    return 1
  fi
  if ! pre_warning_audit; then
    echo "[daily_inventory_guard] pre-warning audit failed; inventory warning is not promotable" >&2
    write_inventory_marker failed "inventory warning pre-audit failed; plan/result/journal evidence is not a verified same-day warning" >/dev/null 2>&1 || true
    return 1
  fi
  return 0
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
      elif .state == "skipped_owner_confirmed_same_target_above_target" then
        ((.before.totalUsableInventory | type) == "number")
        and ((.targetUsableInventory | type) == "number")
        and .before.totalUsableInventory > .targetUsableInventory
        and (((.writes // []) | length) == 0)
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
      elif .state == "submitted_but_readback_pending" and .historicalPending == true then
        .disposition == "skipped"
        and ((.historicalIntentId // "") | length) > 0
        and ((.historicalRunDate // "") | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$"))
        and (.historicalRunDate < $result.generatedAt[0:10])
        and ((.historicalTargetUsableInventory | type) == "number")
        and ((.before.totalUsableInventory | type) == "number")
        and ((.writes // []) | length) == 0
      elif .state == "blocked_by_manual_resolution_fence" then
        .manualResolutionFence.disposition == "manual_baseline_adopted_effect_unknown"
        and .manualResolutionFence.reason == "exact_scope_manual_resolution_fence"
        and ((.manualResolutionFence.resolutionId // "") | length) > 0
        and ((.manualResolutionFence.intentId // "") | length) > 0
        and .manualResolutionFence.scope.storeKey == .storeKey
        and .manualResolutionFence.scope.skc == .skc
        and .manualResolutionFence.scope.skuCode == .skuCode
        and ((.manualResolutionFence.scope.warehouseCode // "") | length) > 0
        and .manualResolutionFence.scope.invType == "VI"
        and ((.manualResolutionFence.scope.scopeKey // "") | test("^[a-f0-9]{64}$"))
        and ((.writes // []) | length) == 0
      else false end)
  ' "$RESULT" >/dev/null \
    && node scripts/validate_daily_operating_refresh.mjs \
      --inventory-only \
      --root "$ROOT" \
      --marker-root "$MARKER_ROOT" \
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
    and ([.results[] | select(.state == "submitted_but_readback_pending" and .historicalPending != true)] | length) > 0
    and all(.results[];
      .state == "submitted_but_readback_pending"
      or .state == "updated_readback_matched"
      or (.state | startswith("skipped_")))
  ' "$RESULT" >/dev/null
}

result_has_item_warning() {
  jq -e --arg date "$DATE" '
    type == "object"
    and ([.results[]?
      | select((.state == "submitted_but_readback_pending" and (.historicalPending != true or .historicalRunDate == $date))
        or .state == "historical_readback_matched"
        or .state == "blocked_by_manual_resolution_fence"
        or .state == "pre_submit_blocked")]
      | length) > 0
  ' "$RESULT" >/dev/null
}

# The executor publishes RESULT with a tmp-file + atomic rename. Capture the
# published file identity before dispatch and require a changed identity after
# dispatch, so an old pending result can never be reclassified as this run's
# readback-pending output after a fatal executor exit. The fingerprint combines
# device/inode (atomic replacement), size, nanosecond mtime, and content hash;
# an absent file is a deliberate stable fingerprint too.
result_fingerprint() {
  node --input-type=module - "$RESULT" <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs';

const file = process.argv[2];
try {
  const stat = fs.statSync(file, {bigint: true});
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const mtime = typeof stat.mtimeNs === 'bigint' ? stat.mtimeNs : stat.mtimeMs;
  process.stdout.write([
    stat.dev,
    stat.ino,
    stat.size,
    mtime,
    hash,
  ].map(String).join(':'));
} catch (error) {
  if (error?.code === 'ENOENT') {
    process.stdout.write('absent');
  } else {
    throw error;
  }
}
NODE
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
MANUAL_RESOLUTION_COUNT=0
MANUAL_RESOLUTION_TOMBSTONE_COUNT=0
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
const lifecycle = await readInventoryIntentJournals(files, {
  maxRunDate,
  allowMultiplePendingByScope: true,
  currentJournalFile: currentJournal,
  quarantineHistoricalDanglingSupersedes: true,
});
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
  manualResolutionCount: lifecycle.manualResolutions?.size || 0,
  manualResolutionFenceCount: lifecycle.fences?.size || 0,
  manualResolutionTombstoneCount: lifecycle.tombstonedIdempotencyKeys?.size || 0,
  quarantinedSupersedeCount: lifecycle.quarantinedSupersedes?.length || 0,
}));
NODE
)"
PENDING_INTENT_COUNT="$(jq -r '.pending // -1' <<<"$LIFECYCLE_JSON")"
CURRENT_PENDING_INTENT_COUNT="$(jq -r '.currentPending // -1' <<<"$LIFECYCLE_JSON")"
CURRENT_READBACK_MATCHED_INTENT_COUNT="$(jq -r '.currentReadbackMatched // -1' <<<"$LIFECYCLE_JSON")"
HISTORICAL_PENDING_INTENT_COUNT="$(jq -r '.historicalPending // -1' <<<"$LIFECYCLE_JSON")"
READBACK_MATCHED_INTENT_COUNT="$(jq -r '.readbackMatched // -1' <<<"$LIFECYCLE_JSON")"
MANUAL_RESOLUTION_COUNT="$(jq -r '.manualResolutionCount // -1' <<<"$LIFECYCLE_JSON")"
MANUAL_RESOLUTION_TOMBSTONE_COUNT="$(jq -r '.manualResolutionTombstoneCount // -1' <<<"$LIFECYCLE_JSON")"
QUARANTINED_SUPERSEDE_COUNT="$(jq -r '.quarantinedSupersedeCount // -1' <<<"$LIFECYCLE_JSON")"
for count in "$PENDING_INTENT_COUNT" "$CURRENT_PENDING_INTENT_COUNT" "$CURRENT_READBACK_MATCHED_INTENT_COUNT" "$HISTORICAL_PENDING_INTENT_COUNT" "$READBACK_MATCHED_INTENT_COUNT" "$MANUAL_RESOLUTION_COUNT" "$MANUAL_RESOLUTION_TOMBSTONE_COUNT" "$QUARANTINED_SUPERSEDE_COUNT"; do
  [[ "$count" =~ ^[0-9]+$ ]] || {
    echo "[daily_inventory_guard] durable inventory journal lifecycle count is invalid" >&2
    exit 65
  }
done
if (( MANUAL_RESOLUTION_COUNT > 0 )); then
  echo "[daily_inventory_guard] manual-resolution permanent fences discovered count=$MANUAL_RESOLUTION_COUNT tombstones=$MANUAL_RESOLUTION_TOMBSTONE_COUNT; matching scopes remain blocked and no new inventory POST is allowed"
fi
if (( QUARANTINED_SUPERSEDE_COUNT > 0 )); then
  echo "[daily_inventory_guard] quarantined legacy dangling supersede count=$QUARANTINED_SUPERSEDE_COUNT; affected historical SKU scopes remain pending and blocked without stopping unrelated current readback"
fi
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
    --root "$SOURCE_MARKER_ROOT" \
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
    --root "$SOURCE_MARKER_ROOT" \
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
# hard post-conditions: a terminal section ack, a cache age within the limit,
# and at least one matched current-day ET operational row. This write
# interface is called at most once per run and is never retried.
ensure_inventory_trend_fresh() {
  local force="${1:-0}"
  local age refresh_ack matched_current_day
  age="$(inventory_trend_age_seconds 2>/dev/null || true)"
  if [[ "$force" != "1" && "$age" =~ ^[0-9]+$ ]] && (( age <= INVENTORY_TREND_MAX_AGE_SECONDS )); then
    echo "[daily_inventory_guard] inventoryTrend fresh ageSeconds=$age; skip duplicate refresh"
    return 0
  fi
  echo "[daily_inventory_guard] refresh inventoryTrend synchronously force=$force previousAgeSeconds=${age:-unknown}"
  if ! refresh_ack="$(curl -fsS --max-time "$INVENTORY_TREND_REFRESH_TIMEOUT_SECONDS" \
    -H 'X-SHEIN-BI-HOST-LOCKED-WORKER: 1' \
    "$PORTAL_URL/api/bi/section/inventoryTrend?refresh=1&refreshToken=${REFRESH_RUN_TOKEN}")"; then
    echo "[daily_inventory_guard] inventoryTrend HTTP refresh failed; blocking the daily inventory guard" >&2
    return 1
  fi
  if ! jq -e '
    type == "object"
    and .ok == true
    and .section == "inventoryTrend"
    and .terminal == true
  ' <<<"$refresh_ack" >/dev/null; then
    echo "[daily_inventory_guard] inventoryTrend refresh returned an invalid, non-terminal, or wrong-section JSON ack; blocking the daily inventory guard" >&2
    return 1
  fi
  age="$(inventory_trend_age_seconds 2>/dev/null || true)"
  if [[ ! "$age" =~ ^[0-9]+$ ]] || (( age > INVENTORY_TREND_MAX_AGE_SECONDS )); then
    echo "[daily_inventory_guard] inventoryTrend refresh did not publish a fresh cache ageSeconds=${age:-unknown}" >&2
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
  echo "[daily_inventory_guard] inventoryTrend refresh complete terminalAck=1 ageSeconds=$age matchedCurrentDayRows=$matched_current_day"
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
    --slurpfile plan "$PLAN" '
      ($plan[0].detailRefreshTargets // []) as $rows
      |
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
          },
          producer:"cloud_daily_inventory_replenishment_guard",
          terminalEvidence:null,
          targetBindings:($rows | map({storeKey:(.storeKey|ascii_upcase), spu:(.spu|tostring), skc:(.skc|tostring), matchKey:(.matchKey|tostring)})
            | unique_by([.storeKey,.spu]) | sort_by([.storeKey,.spu]))
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
  # The reconciliation command may return a success summary while a target
  # was silently omitted. Require a fresh, exact per-target terminal readback
  # before allowing the second plan build to proceed. The summary and target
  # rows are written as a separate same-day evidence artifact, then bound into
  # the manifest by atomic replacement.
  local refresh_started_at refresh_ended_at terminal_evidence_tmp terminal_evidence_file terminal_evidence_sha manifest_original_file
  refresh_started_at="$(date -Is)"
  export SHEIN_OPENAPI_PRODUCT_CACHE_DIR="$PRODUCT_CACHE_DIR"
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
  refresh_ended_at="$(date -Is)"
  terminal_evidence_tmp="$DETAIL_TARGETS.tmp-terminal"
  terminal_evidence_file="$DETAIL_TARGETS.terminal-evidence.json"
  manifest_original_file="$DETAIL_TARGETS.original.json"
  if (( status != 0 )); then
    rm -f -- "$terminal_evidence_tmp"
    return "$status"
  fi
  cp -- "$DETAIL_TARGETS" "$manifest_original_file"
  if ! node scripts/inventory/verify_daily_inventory_detail_manifest.mjs \
    --manifest "$manifest_original_file" \
    --cache-dir "$PRODUCT_CACHE_DIR" \
    --date "$DATE" \
    --refresh-started-at "$refresh_started_at" \
    --refresh-ended-at "$refresh_ended_at" \
    >"$terminal_evidence_tmp"; then
    echo "[daily_inventory_guard] targeted refresh did not produce exact same-day terminal detail evidence; retaining the plan blocker" >&2
    rm -f -- "$terminal_evidence_tmp"
    return 1
  fi
  mv -f "$terminal_evidence_tmp" "$terminal_evidence_file"
  terminal_evidence_sha="$(sha256sum "$terminal_evidence_file" | awk '{print tolower($1)}')"
  if [[ ! "$terminal_evidence_sha" =~ ^[a-f0-9]{64}$ ]]; then
    echo "[daily_inventory_guard] terminal target evidence SHA-256 is unavailable" >&2
    return 1
  fi
  if ! jq --arg evidenceFile "$terminal_evidence_file" --arg evidenceSha256 "$terminal_evidence_sha" \
    --slurpfile evidence "$terminal_evidence_file" \
    '.terminalEvidence = ($evidence[0] + {evidenceFile:$evidenceFile,evidenceSha256:$evidenceSha256})' \
    "$DETAIL_TARGETS" >"$DETAIL_TARGETS.tmp-bound"; then
    echo "[daily_inventory_guard] failed to bind terminal target evidence to manifest" >&2
    rm -f -- "$DETAIL_TARGETS.tmp-bound"
    return 1
  fi
  mv -f "$DETAIL_TARGETS.tmp-bound" "$DETAIL_TARGETS"
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
# HTTP/ack failure, a stale cache, or zero matched current-day ET rows aborts
# the guard before the plan build. The error is not swallowed and the write
# interface is never retried.
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
    DETAIL_REBUILD_ATTEMPTS=0
    while :; do
      REFRESH_STATUS=0
      refresh_targeted_openapi_sources || REFRESH_STATUS=$?
      if (( REFRESH_STATUS == 0 )); then
        PLAN_STATUS=0
        build_plan "$DETAIL_TARGETS" || PLAN_STATUS=$?
        # A targeted refresh can legitimately reveal a new inventory-relevant
        # store+SPU. Rebuild against the new plan target set and recover with
        # another bounded targeted refresh; every iteration rewrites the
        # manifest atomically and must publish terminal same-day evidence.
        if (( PLAN_STATUS != 0 )) && jq -e '
          (.blockers // []) | any(startswith("daily current-detail target set is not fully covered by manifest:"))
        ' "$PLAN" >/dev/null; then
          if (( DETAIL_REBUILD_ATTEMPTS >= DETAIL_REBUILD_MAX_ATTEMPTS )); then
            echo "[daily_inventory_guard] current-detail target drift did not converge within attempts=$DETAIL_REBUILD_MAX_ATTEMPTS; retain exact blocker and fail closed" >&2
            break
          fi
          (( DETAIL_REBUILD_ATTEMPTS += 1 ))
          REFRESH_REASON="current_detail_target_drift"
          echo "[daily_inventory_guard] targeted refresh discovered new current-detail targets; recover incrementally attempt=$DETAIL_REBUILD_ATTEMPTS/$DETAIL_REBUILD_MAX_ATTEMPTS"
          continue
        fi
      elif (( REFRESH_STATUS == 2 )); then
        echo "[daily_inventory_guard] daily current-detail target budget exceeded; fail closed" >&2
        plan_blocked_with_budget_failure
        exit 2
      else
        echo "[daily_inventory_guard] targeted OpenAPI refresh failed status=$REFRESH_STATUS; retain exact blockers; no second targeted refresh this run" >&2
      fi
      break
    done
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
  if (( RECONCILE_PENDING_ONLY == 0 )) && result_has_item_warning; then
    if publish_audited_inventory_warning "existing exact command completed with verified item warnings; no business item was replayed"; then
      jq '{ok:false,state:"already_completed_with_warning",planHash,executionMode,generatedAt}' "$RESULT"
      exit 2
    fi
    exit 1
  fi
  echo "[daily_inventory_guard] prior result is not a safe current terminal readback; re-run read-only guards and executor recovery (durable intents forbid duplicate writes)" >&2
fi

if (( RECONCILE_PENDING_ONLY == 0 )) && [[ "$RUN_DEADLINE_EPOCH" =~ ^[1-9][0-9]*$ ]] && (( $(date +%s) >= RUN_DEADLINE_EPOCH )); then
  echo "[daily_inventory_guard] run deadline reached before executor dispatch; no inventory request was submitted" >&2
  write_inventory_marker failed "run deadline reached before executor dispatch"
  exit 76
fi

if ! RESULT_BEFORE_FINGERPRINT="$(result_fingerprint)"; then
  echo "[daily_inventory_guard] cannot fingerprint the prior inventory result; refusing executor classification" >&2
  exit 1
fi

set +e
EXECUTOR_RECOVERY_ARGS=()
EXECUTOR_EXECUTE_ARGS=(--execute)
if [[ "${SHEIN_BI_INVENTORY_DRY_RUN:-0}" == "1" ]]; then
  EXECUTOR_EXECUTE_ARGS=()
fi
if (( RECONCILE_PENDING_ONLY == 1 )); then
  EXECUTOR_RECOVERY_ARGS+=(--reconcile-pending-only)
fi
node scripts/inventory/execute_daily_inventory_replenishment_plan.mjs \
  --plan "$PLAN" \
  "${EXECUTOR_EXECUTE_ARGS[@]}" \
  --execution-mode automatic \
  --confirm-hash "$HASH" \
  --max-rows "$MAX_ROWS" \
  "${EXECUTOR_RECOVERY_ARGS[@]}" \
  --out "$RESULT"
EXECUTOR_STATUS=$?
set -e
if [[ "${SHEIN_BI_INVENTORY_DRY_RUN:-0}" == "1" ]]; then
  if (( EXECUTOR_STATUS != 0 )) || ! jq -e --arg hash "$HASH" --argjson total "$TOTAL" \
    '.planHash==$hash and .execute==false and (.results|length)==$total and all(.results[]; .state=="dry_run_ready" or .state=="planned")' "$RESULT" >/dev/null; then
    exit 1
  fi
  write_inventory_marker done "inventory dry-run completed; no inventory POST was dispatched"
  exit 0
fi
# Exit 75 is the guard's capacity/readback-only contract. An executor 75
# without a fresh complete publication is a real executor failure, not a
# capacity defer that the morning coordinator may retry indefinitely.
EXECUTOR_FAILURE_STATUS="$EXECUTOR_STATUS"
if (( EXECUTOR_FAILURE_STATUS == 75 )); then
  EXECUTOR_FAILURE_STATUS=1
fi

if ! RESULT_AFTER_FINGERPRINT="$(result_fingerprint)"; then
  echo "[daily_inventory_guard] cannot fingerprint the inventory result after executor exit" >&2
  if (( EXECUTOR_STATUS != 0 )); then
    exit "$EXECUTOR_FAILURE_STATUS"
  fi
  exit 1
fi

if [[ "$RESULT_AFTER_FINGERPRINT" == "$RESULT_BEFORE_FINGERPRINT" ]] || [[ ! -f "$RESULT" ]] || ! jq -e --arg hash "$HASH" --argjson total "$TOTAL" '
  .planHash == $hash and .execute == true and .executionMode == "automatic" and (.results | length) == $total
' "$RESULT" >/dev/null; then
  echo "automatic inventory executor did not produce a complete result: fresh complete result missing" >&2
  if (( EXECUTOR_STATUS != 0 )); then
    exit "$EXECUTOR_FAILURE_STATUS"
  fi
  exit 1
fi

# Row-level same-day pending/fenced blockers are a narrow, auditable warning
# outcome.  The shared validator is the promotion gate; without it the guard
# fails closed and never returns the capacity/readback retry status.
if result_has_item_warning || result_is_readback_pending_only; then
  if publish_audited_inventory_warning "automatic inventory execution completed with an auditable same-day item warning; no duplicate inventory submission will be attempted"; then
    jq '{ok:false,state:"completed_with_warning",planHash,executionMode,generatedAt,counts:{
      total:(.results|length),
      pending:([.results[]|select(.state=="submitted_but_readback_pending")]|length),
      fenced:([.results[]|select(.state=="blocked_by_manual_resolution_fence")]|length),
      preSubmitBlocked:([.results[]|select(.state=="pre_submit_blocked")]|length),
      updated:([.results[]|select(.state=="updated_readback_matched")]|length),
      skipped:([.results[]|select(.state|startswith("skipped_"))]|length)
    }}' "$RESULT"
    exit 2
  fi
  echo "[daily_inventory_guard] same-day warning result failed the shared pre-warning audit; fail closed without capacity retry" >&2
  jq '{ok:false,state:"warning_audit_failed",planHash,executionMode,generatedAt}' "$RESULT" 2>/dev/null || true
  exit 1
fi
if result_is_complete_and_safe; then
  write_inventory_marker done "automatic inventory execution completed with plan/result hash and terminal readback evidence"
else
  write_inventory_marker failed "automatic inventory execution has terminal blockers or non-matching readback; warning promotion was not auditable"
  jq '{ok:false,state:"completed_with_blockers",planHash,executionMode,generatedAt,counts:{
    total:(.results|length),
    updated:([.results[]|select(.state=="updated_readback_matched")]|length),
    skipped:([.results[]|select(.state|startswith("skipped_"))]|length),
    blocked:([.results[]|select(.state=="blocked")]|length)
  }}' "$RESULT"
  exit 1
fi
jq '{ok: (([.results[]|select(.state=="blocked")]|length) == 0),state:"completed",planHash,executionMode,generatedAt,counts:{
  total:(.results|length),
  updated:([.results[]|select(.state=="updated_readback_matched")]|length),
  skipped:([.results[]|select(.state|startswith("skipped_"))]|length),
  blocked:([.results[]|select(.state=="blocked")]|length)
}}' "$RESULT"
