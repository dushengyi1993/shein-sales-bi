#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
DATE="${SHEIN_BI_ET_LOW_INVENTORY_RUN_DATE:-$(TZ=Asia/Shanghai date +%F)}"
RUNTIME_ROOT="${SHEIN_BI_ET_LOW_INVENTORY_RUNTIME_ROOT:-/srv/shein-bi/runtime/et-low-inventory-guard}"
MANIFEST="${SHEIN_ET_LATEST_MANIFEST:-$ROOT/outputs/et-forwarder/latest-manifest.json}"
EXPECTED_BATCH_ID="${SHEIN_ET_EXPECTED_BATCH_ID:-}"
EXPECTED_MANIFEST_HASH="${SHEIN_ET_EXPECTED_MANIFEST_HASH:-}"
ET_FACT_MAX_AGE_SECONDS="${SHEIN_BI_ET_LOW_INVENTORY_MAX_AGE_SECONDS:-${SHEIN_BI_INVENTORY_TREND_MAX_AGE_SECONDS:-1800}}"
ET_FACT_MAX_AGE_HARD_LIMIT_SECONDS=21600
LOCK="$ROOT/state/locks/daily-inventory-replenishment.lock"
STATE="$RUNTIME_ROOT/state/latest.json"
if [[ ! "$ET_FACT_MAX_AGE_SECONDS" =~ ^[0-9]+$ ]] \
  || (( ET_FACT_MAX_AGE_SECONDS < 1 || ET_FACT_MAX_AGE_SECONDS > ET_FACT_MAX_AGE_HARD_LIMIT_SECONDS )); then
  echo "[et_low_inventory_guard] invalid bounded ET freshness threshold seconds=$ET_FACT_MAX_AGE_SECONDS max=$ET_FACT_MAX_AGE_HARD_LIMIT_SECONDS" >&2
  exit 64
fi
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
if ! command -v realpath >/dev/null 2>&1; then
  echo "[et_low_inventory_guard] realpath is required to bind the ET manifest inside the application root" >&2
  exit 75
fi
ROOT_REAL="$(realpath -e "$ROOT")"
BATCH_ID="$(jq -r '.batchId // empty' "$MANIFEST")"
TARGET_DATE="$(jq -r '.targetDate // empty' "$MANIFEST")"
MANIFEST_OK="$(jq -r '.ok == true' "$MANIFEST")"
if [[ -z "$BATCH_ID" || "$TARGET_DATE" != "$DATE" || "$MANIFEST_OK" != "true" ]]; then
  echo "[et_low_inventory_guard] ET manifest is not a completed current-day batch batch=$BATCH_ID targetDate=$TARGET_DATE" >&2
  exit 75
fi
# latest-manifest.json is only a pointer/diagnostic index. Bind the plan to
# the immutable batch manifest it names, then hash that exact file. The
# pointer and its target must describe the same batch/date/ok state; a changed
# target or a same-batch hash drift fails closed before any planner work.
MANIFEST_REF="$(jq -r '.manifestPath // empty' "$MANIFEST")"
ET_MANIFEST_FILE="$MANIFEST"
if [[ -n "$MANIFEST_REF" ]]; then
  if [[ "$MANIFEST_REF" = /* ]]; then
    ET_MANIFEST_FILE="$MANIFEST_REF"
  else
    ET_MANIFEST_FILE="$ROOT/$MANIFEST_REF"
  fi
fi
if [[ ! -s "$ET_MANIFEST_FILE" ]]; then
  echo "[et_low_inventory_guard] ET batch manifest target is missing: $ET_MANIFEST_FILE" >&2
  exit 75
fi
ET_MANIFEST_REAL="$(realpath -e "$ET_MANIFEST_FILE")"
case "$ET_MANIFEST_REAL" in
  "$ROOT_REAL"/*) ;;
  *)
    echo "[et_low_inventory_guard] ET manifest target escapes application root: $ET_MANIFEST_REAL" >&2
    exit 75
    ;;
esac
ET_MANIFEST_FILE="$ET_MANIFEST_REAL"
ACTUAL_BATCH_ID="$(jq -r '.batchId // empty' "$ET_MANIFEST_FILE")"
ACTUAL_TARGET_DATE="$(jq -r '.targetDate // empty' "$ET_MANIFEST_FILE")"
ACTUAL_MANIFEST_OK="$(jq -r '.ok == true' "$ET_MANIFEST_FILE")"
if [[ "$ACTUAL_BATCH_ID" != "$BATCH_ID" || "$ACTUAL_TARGET_DATE" != "$TARGET_DATE" || "$ACTUAL_MANIFEST_OK" != "true" ]]; then
  echo "[et_low_inventory_guard] ET manifest pointer drift: pointer=$BATCH_ID/$TARGET_DATE/$MANIFEST_OK target=$ACTUAL_BATCH_ID/$ACTUAL_TARGET_DATE/$ACTUAL_MANIFEST_OK" >&2
  exit 2
fi
if ! command -v sha256sum >/dev/null 2>&1; then
  echo "[et_low_inventory_guard] sha256sum is required to bind the ET manifest" >&2
  exit 75
fi
ET_MANIFEST_HASH="$(sha256sum "$ET_MANIFEST_FILE" | awk '{print $1}')"
if [[ ! "$ET_MANIFEST_HASH" =~ ^[a-f0-9]{64}$ ]]; then
  echo "[et_low_inventory_guard] ET manifest hash is unreadable: $ET_MANIFEST_FILE" >&2
  exit 2
fi
if [[ -n "$EXPECTED_BATCH_ID" && "$EXPECTED_BATCH_ID" != "$BATCH_ID" ]]; then
  echo "[et_low_inventory_guard] same-run ET batch drift: expected=$EXPECTED_BATCH_ID actual=$BATCH_ID" >&2
  exit 2
fi
if [[ -n "$EXPECTED_MANIFEST_HASH" && "$EXPECTED_MANIFEST_HASH" != "$ET_MANIFEST_HASH" ]]; then
  echo "[et_low_inventory_guard] same-run ET manifest hash drift: expected=$EXPECTED_MANIFEST_HASH actual=$ET_MANIFEST_HASH" >&2
  exit 2
fi
if [[ -s "$STATE" ]] && [[ "$(jq -r '.lastProcessedBatchId // empty' "$STATE")" == "$BATCH_ID" ]]; then
  STORED_ET_MANIFEST_HASH="$(jq -r '.etManifestHash // empty' "$STATE")"
  if jq -e '.result != null' "$STATE" >/dev/null && [[ -z "$STORED_ET_MANIFEST_HASH" ]]; then
    echo "[et_low_inventory_guard] persisted same-batch ET manifest binding is missing; refuse idempotent success" >&2
    exit 2
  fi
  if [[ -n "$STORED_ET_MANIFEST_HASH" && "$STORED_ET_MANIFEST_HASH" != "$ET_MANIFEST_HASH" ]]; then
    echo "[et_low_inventory_guard] persisted ET manifest hash drift: previous=$STORED_ET_MANIFEST_HASH current=$ET_MANIFEST_HASH" >&2
    exit 2
  fi
fi
SAFE_BATCH_ID="$(printf '%s' "$BATCH_ID" | tr -c 'A-Za-z0-9._-' '_')"
SOURCE_PLAN="$RUNTIME_ROOT/source-plans/et-low-inventory-source-$SAFE_BATCH_ID.json"
PLAN="$RUNTIME_ROOT/plans/et-low-inventory-$SAFE_BATCH_ID.json"
RESULT="$RUNTIME_ROOT/results/et-low-inventory-$SAFE_BATCH_ID.json"
DETAIL_TARGETS="$RUNTIME_ROOT/source-plans/et-low-inventory-detail-targets-$SAFE_BATCH_ID.json"
DETAIL_BUDGET="${SHEIN_BI_ET_LOW_INVENTORY_DETAIL_BUDGET:-32}"
ATTEMPT_ID="$$-$(date +%s)"
SOURCE_PLAN_ATTEMPT="$SOURCE_PLAN.attempt-$ATTEMPT_ID"
PLAN_ATTEMPT="$PLAN.attempt-$ATTEMPT_ID"
RESULT_ATTEMPT="$RESULT.attempt-$ATTEMPT_ID"
RESULT_JOURNAL="$RESULT.journal.ndjson"
RESULT_ATTEMPT_JOURNAL="$RESULT_ATTEMPT.journal.ndjson"
DETAIL_TARGETS_ATTEMPT="$DETAIL_TARGETS.attempt-$ATTEMPT_ID"
RETAIN_RESULT_ATTEMPT=0
cleanup_attempt_outputs() {
  rm -f "$SOURCE_PLAN_ATTEMPT" "$PLAN_ATTEMPT" "$DETAIL_TARGETS_ATTEMPT"
  if (( RETAIN_RESULT_ATTEMPT == 0 )); then
    rm -f "$RESULT_ATTEMPT" "$RESULT_ATTEMPT_JOURNAL"
  fi
}
trap cleanup_attempt_outputs EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

journal_is_complete_and_valid() {
  [[ ! -e "$RESULT_JOURNAL" ]] && return 0
  [[ ! -L "$RESULT_JOURNAL" && -f "$RESULT_JOURNAL" ]] || return 1
  [[ ! -s "$RESULT_JOURNAL" ]] && return 0
  [[ "$(tail -c 1 "$RESULT_JOURNAL" | od -An -t u1 | tr -d ' ')" == "10" ]] || return 1
  jq -s -e 'all(.[]; type == "object")' "$RESULT_JOURNAL" >/dev/null 2>&1
}

sync_durable_path() {
  local target="$1"
  sync -f "$target" 2>/dev/null || sync "$target"
}

# The guard-level intent closes the process-start window before the inventory
# executor can make any POST. The lock makes each single-line append exclusive;
# fsync makes the prepared/executing phase durable before control is handed to
# the child process. A torn or invalid journal always fails closed on recovery.
append_executor_run_phase() {
  local intent_id="$1"
  local phase="$2"
  local attempt_id="$3"
  local plan_hash="$4"
  local action_count="$5"
  local result_attempt="$6"
  local executor_status="${7:-}"
  local stable_result="${8:-}"
  local result_hash="${9:-}"
  local readback_identity="${10:-}"
  local line journal_tmp
  journal_is_complete_and_valid || {
    echo "[et_low_inventory_guard] durable executor journal is torn or invalid: $RESULT_JOURNAL" >&2
    return 1
  }
  line="$(jq -cn \
    --arg intentId "$intent_id" \
    --arg phase "$phase" \
    --arg attemptId "$attempt_id" \
    --arg runDate "$DATE" \
    --arg batchId "$BATCH_ID" \
    --arg manifestHash "$ET_MANIFEST_HASH" \
    --arg planHash "$plan_hash" \
    --argjson actionCount "$action_count" \
    --arg resultAttempt "$result_attempt" \
    --arg stableResult "$stable_result" \
    --arg resultHash "$result_hash" \
    --arg readbackIdentity "$readback_identity" \
    --arg executorStatus "$executor_status" \
    --arg recordedAt "$(date -Is)" '
      {
        kind:"executor_run_intent",
        intentId:$intentId,
        phase:$phase,
        attemptId:$attemptId,
        runDate:$runDate,
        batchId:$batchId,
        manifestHash:$manifestHash,
        planHash:$planHash,
        actionCount:$actionCount,
        resultAttempt:$resultAttempt,
        recordedAt:$recordedAt
      }
      + (if $stableResult == "" then {} else {stableResult:$stableResult} end)
      + (if $resultHash == "" then {} else {resultHash:$resultHash} end)
      + (if $readbackIdentity == "" then {} else {readbackIdentity:$readbackIdentity} end)
      + (if $executorStatus == "" then {} else {executorStatus:($executorStatus | tonumber)} end)
    ')"
  if [[ ! -e "$RESULT_JOURNAL" ]]; then
    journal_tmp="$RESULT_JOURNAL.$$.tmp"
    printf '%s\n' "$line" >"$journal_tmp"
    chmod 600 "$journal_tmp"
    sync_durable_path "$journal_tmp"
    mv "$journal_tmp" "$RESULT_JOURNAL"
    sync_durable_path "$(dirname "$RESULT_JOURNAL")"
  else
    printf '%s\n' "$line" >>"$RESULT_JOURNAL"
    sync_durable_path "$RESULT_JOURNAL"
  fi
}

latest_executor_run_intents() {
  [[ -s "$RESULT_JOURNAL" ]] || { printf '[]\n'; return 0; }
  jq -sc '
    reduce .[] as $entry ({};
      if $entry.kind == "executor_run_intent" and ($entry.intentId | type) == "string"
      then .[$entry.intentId] = $entry else . end)
    | [.[]]
  ' "$RESULT_JOURNAL"
}

pending_inventory_intent_count() {
  [[ -s "$RESULT_JOURNAL" ]] || { printf '0\n'; return 0; }
  jq -sc '
    reduce .[] as $entry ({};
      if $entry.kind == "intent" and ($entry.intentId | type) == "string" then
        .[$entry.intentId] = true
      elif $entry.kind == "write_outcome"
        and ($entry.intentId | type) == "string"
        and ($entry.disposition == "rejected" or $entry.disposition == "readback_matched") then
        del(.[$entry.intentId])
      elif $entry.kind == "manual_resolution"
        and ($entry.intentId | type) == "string" then
        # manual_resolution is a terminal audit event for the old intent, but
        # it is not a write_outcome and its exact scope remains permanently
        # fenced. Do not report the resolved intent as pending while keeping
        # the public v2 client/executor responsible for the actual fence.
        del(.[$entry.intentId])
      else . end)
    | length
  ' "$RESULT_JOURNAL"
}

result_is_complete_and_safe() {
  local result_file="$1"
  local plan_hash="$2"
  local action_count="$3"
  jq -e --arg hash "$plan_hash" --argjson total "$action_count" '
    .schemaVersion == "daily-inventory-replenishment-result/v1"
    and .planHash == $hash
    and .execute == true
    and .executionMode == "automatic"
    and .executionConstraints.decreaseOnly == true
    and ((.unresolvedIntents // []) | length) == 0
    and (.results | length) == $total
    and all(.results[];
      ((.targetUsableInventory | type) == "number")
      and if .state == "updated_readback_matched" then
        ((.after.totalUsableInventory | type) == "number")
        and .after.totalUsableInventory == .targetUsableInventory
        and ((.writes // []) | length > 0)
      elif .state == "skipped_target_already_matched" then
        ((.before.totalUsableInventory | type) == "number")
        and .before.totalUsableInventory == .targetUsableInventory
      elif .state == "skipped_safety_no_increase" then
        ((.before.totalUsableInventory | type) == "number")
        and .before.totalUsableInventory < .targetUsableInventory
      else false end)
  ' "$result_file" >/dev/null 2>&1
}

result_readback_identity() {
  local result_file="$1"
  jq -cS '
    {
      schemaVersion,
      planHash,
      execute,
      executionMode,
      executionConstraints:{decreaseOnly:.executionConstraints.decreaseOnly},
      unresolvedIntents:(.unresolvedIntents // []),
      results:[.results[] | {
        storeKey,
        skc,
        skuCode,
        targetUsableInventory,
        state,
        beforeUsableInventory:(.before.totalUsableInventory // null),
        afterUsableInventory:(.after.totalUsableInventory // null),
        writes:[(.writes // [])[] | {
          idempotencyKey:(.idempotencyKey // null),
          requestPayloadHash:(.requestPayloadHash // null),
          success:(.success // null),
          recoveredFromIntent:(.recoveredFromIntent // false)
        }]
      }]
    }
  ' "$result_file" | sha256sum | awk '{print $1}'
}

result_matches_promotion_evidence() {
  local result_file="$1"
  local intent_json="$2"
  local bound_plan_hash bound_action_count bound_result_hash bound_readback_identity
  bound_plan_hash="$(jq -r '.planHash // empty' <<<"$intent_json")"
  bound_action_count="$(jq -r '.actionCount // -1' <<<"$intent_json")"
  bound_result_hash="$(jq -r '.resultHash // empty' <<<"$intent_json")"
  bound_readback_identity="$(jq -r '.readbackIdentity // empty' <<<"$intent_json")"
  [[ -s "$result_file" \
    && "$bound_result_hash" =~ ^[a-f0-9]{64}$ \
    && "$bound_readback_identity" =~ ^[a-f0-9]{64}$ \
    && "$(sha256sum "$result_file" | awk '{print $1}')" == "$bound_result_hash" \
    && "$(result_readback_identity "$result_file")" == "$bound_readback_identity" ]] \
    && result_is_complete_and_safe "$result_file" "$bound_plan_hash" "$bound_action_count"
}

validate_historical_skip_warning() {
  node scripts/inventory/validate_et_historical_skip_warning.mjs \
    "$PLAN" "$1" "$RESULT_JOURNAL" "$2" "$3" "$DATE" "$BATCH_ID" "$ET_MANIFEST_HASH"
}

persist_historical_skip_warning() {
  local result_attempt="$1" intent_id="$2" audit="$3" tmp="$STATE.$$.tmp"
  jq -n --arg at "$(date -Is)" --arg batch "$BATCH_ID" --arg manifest "$ET_MANIFEST_HASH" \
    --arg plan "$PLAN" --arg hash "$(jq -r '.payloadHash' "$PLAN")" \
    --arg result "$result_attempt" --arg intentId "$intent_id" --argjson audit "$audit" \
    '{ok:false,businessState:"watching",active:true,warning:"historical_skip_no_current_submission",
      updatedAt:$at,lastProcessedBatchId:$batch,etManifestHash:$manifest,plan:$plan,planHash:$hash,
      result:$result,resultHash:$audit.resultHash,executorIntentId:$intentId,executorStatus:1,
      counts:{total:$audit.total,updated:0,skipped:$audit.skipped,blocked:$audit.historicalSkipped,
        historicalSkipped:$audit.historicalSkipped,deferredHistorical:$audit.deferredHistorical}}' >"$tmp"
  sync_durable_path "$tmp"
  mv "$tmp" "$STATE"
  sync_durable_path "$(dirname "$STATE")"
  jq '{ok,state:"historical_skip_warning",businessState,active,warning,lastProcessedBatchId,etManifestHash,planHash,result,resultHash,executorStatus,counts}' "$STATE"
}

persist_completed_state() {
  local result_file="$1"
  local blocked blocked_canonical pending_canonical unknown_et_canonical updated skipped watch_active active tmp
  blocked="$(jq '[.results[] | select(.state == "blocked")] | length' "$result_file")"
  blocked_canonical="$(jq '.watch.blockedLowEtCanonicalCount // 0' "$PLAN")"
  pending_canonical="$(jq '[.results[] | select(.state == "submitted_but_readback_pending") | (.matchKey // .canonical // (.storeKey + "::" + .skc))] | unique | length' "$result_file")"
  unknown_et_canonical="$(jq '.watch.unknownEtCanonicalCount // 0' "$PLAN")"
  updated="$(jq '[.results[] | select(.state == "updated_readback_matched")] | length' "$result_file")"
  skipped="$(jq '[.results[] | select(.state | startswith("skipped_"))] | length' "$result_file")"
  watch_active="$(jq -r '.watch.active == true' "$PLAN")"
  active=false
  if [[ "$watch_active" == "true" || "$blocked" != "0" || "$blocked_canonical" != "0" || "$pending_canonical" != "0" || "$unknown_et_canonical" != "0" ]]; then active=true; fi
  tmp="$STATE.$$.tmp"
  jq -n \
    --arg at "$(date -Is)" \
    --arg batch "$BATCH_ID" \
    --arg etManifestHash "$ET_MANIFEST_HASH" \
    --arg plan "$PLAN" \
    --arg result "$result_file" \
    --arg hash "$HASH" \
    --argjson active "$active" \
    --argjson total "$TOTAL" \
    --argjson updated "$updated" \
    --argjson skipped "$skipped" \
    --argjson blocked "$blocked" \
    --argjson blockedCanonical "$blocked_canonical" \
    --argjson pendingCanonical "$pending_canonical" \
    --argjson unknownEtCanonical "$unknown_et_canonical" \
    '{ok:($blocked==0 and $blockedCanonical==0 and $pendingCanonical==0 and $unknownEtCanonical==0),businessState:(if $active then "watching" else "settled" end),active:$active,updatedAt:$at,lastProcessedBatchId:$batch,etManifestHash:$etManifestHash,plan:$plan,planHash:$hash,result:$result,counts:{total:$total,updated:$updated,skipped:$skipped,blocked:$blocked,blockedCanonical:$blockedCanonical,pendingCanonical:$pendingCanonical,unknownEtCanonical:$unknownEtCanonical}}' >"$tmp"
  mv "$tmp" "$STATE"
}

executor_run_intent_binding_is_current() {
  local intent_json="$1"
  local phase bound_attempt_id bound_plan_hash bound_action_count bound_result_attempt expected_result_attempt
  phase="$(jq -r '.phase // empty' <<<"$intent_json")"
  bound_attempt_id="$(jq -r '.attemptId // empty' <<<"$intent_json")"
  bound_plan_hash="$(jq -r '.planHash // empty' <<<"$intent_json")"
  bound_action_count="$(jq -r '.actionCount // -1' <<<"$intent_json")"
  bound_result_attempt="$(jq -r '.resultAttempt // empty' <<<"$intent_json")"
  expected_result_attempt="$RESULT.attempt-$bound_attempt_id"
  if ! [[ "$(jq -r '.runDate // empty' <<<"$intent_json")" == "$DATE" \
    && "$(jq -r '.batchId // empty' <<<"$intent_json")" == "$BATCH_ID" \
    && "$(jq -r '.manifestHash // empty' <<<"$intent_json")" == "$ET_MANIFEST_HASH" \
    && "$bound_plan_hash" =~ ^[a-f0-9]{64}$ \
    && "$bound_action_count" =~ ^[0-9]+$ \
    && -n "$bound_attempt_id" \
    && "$bound_result_attempt" == "$expected_result_attempt" \
    && -s "$PLAN" \
    && "$(jq -r '.payloadHash // empty' "$PLAN")" == "$bound_plan_hash" \
    && "$(jq -r '.actionable | length' "$PLAN")" == "$bound_action_count" \
    && "$(jq -r '.executionConstraints.triggerBatchId // empty' "$PLAN")" == "$BATCH_ID" \
    && "$(jq -r '.executionConstraints.triggerManifestHash // empty' "$PLAN")" == "$ET_MANIFEST_HASH" ]]; then
    return 1
  fi
  if [[ "$phase" == "promoting" || "$phase" == "completed" ]]; then
    [[ "$(jq -r '.stableResult // empty' <<<"$intent_json")" == "$RESULT" \
      && "$(jq -r '.resultHash // empty' <<<"$intent_json")" =~ ^[a-f0-9]{64}$ \
      && "$(jq -r '.readbackIdentity // empty' <<<"$intent_json")" =~ ^[a-f0-9]{64}$ ]]
  fi
}

durably_promote_exact_result() {
  local intent_id="$1"
  local attempt_id="$2"
  local plan_hash="$3"
  local action_count="$4"
  local result_attempt="$5"
  local result_hash="$6"
  local readback_identity="$7"
  local executor_status="${8:-0}"
  local write_promoting="${9:-1}"
  local promotion_intent
  [[ "$(dirname "$result_attempt")" == "$(dirname "$RESULT")" ]] || {
    echo "[et_low_inventory_guard] result promotion crosses directories; reconcile-required/incomplete" >&2
    return 1
  }
  promotion_intent="$(jq -cn \
    --arg intentId "$intent_id" \
    --arg phase promoting \
    --arg attemptId "$attempt_id" \
    --arg runDate "$DATE" \
    --arg batchId "$BATCH_ID" \
    --arg manifestHash "$ET_MANIFEST_HASH" \
    --arg planHash "$plan_hash" \
    --argjson actionCount "$action_count" \
    --arg resultAttempt "$result_attempt" \
    --arg stableResult "$RESULT" \
    --arg resultHash "$result_hash" \
    --arg readbackIdentity "$readback_identity" '
      {kind:"executor_run_intent",intentId:$intentId,phase:$phase,attemptId:$attemptId,
       runDate:$runDate,batchId:$batchId,manifestHash:$manifestHash,planHash:$planHash,
       actionCount:$actionCount,resultAttempt:$resultAttempt,stableResult:$stableResult,
       resultHash:$resultHash,readbackIdentity:$readbackIdentity}
    ')"
  result_matches_promotion_evidence "$result_attempt" "$promotion_intent" || {
    echo "[et_low_inventory_guard] result attempt no longer matches promotion evidence" >&2
    return 1
  }
  if (( write_promoting == 1 )); then
    append_executor_run_phase "$intent_id" promoting "$attempt_id" "$plan_hash" "$action_count" "$result_attempt" "$executor_status" "$RESULT" "$result_hash" "$readback_identity"
  fi
  mv "$result_attempt" "$RESULT"
  sync_durable_path "$RESULT"
  sync_durable_path "$(dirname "$RESULT")"
  result_matches_promotion_evidence "$RESULT" "$promotion_intent" || {
    echo "[et_low_inventory_guard] atomically promoted result failed exact verification; reconcile-required/incomplete" >&2
    return 1
  }
  append_executor_run_phase "$intent_id" completed "$attempt_id" "$plan_hash" "$action_count" "$result_attempt" "$executor_status" "$RESULT" "$result_hash" "$readback_identity"
}

journal_is_complete_and_valid || {
  echo "[et_low_inventory_guard] durable executor journal is torn or invalid; reconcile-required/incomplete" >&2
  exit 2
}
LATEST_RUN_INTENTS="$(latest_executor_run_intents)"
UNKNOWN_RUN_PHASE_COUNT="$(jq '[.[] | select(.phase != "prepared" and .phase != "executing" and .phase != "ambiguous" and .phase != "promoting" and .phase != "completed" and .phase != "rejected" and .phase != "not_submitted")] | length' <<<"$LATEST_RUN_INTENTS")"
if (( UNKNOWN_RUN_PHASE_COUNT > 0 )); then
  echo "[et_low_inventory_guard] executor journal contains an unknown run phase; reconcile-required/incomplete" >&2
  exit 2
fi
NONTERMINAL_RUN_INTENTS="$(jq '[.[] | select(.phase == "prepared" or .phase == "executing" or .phase == "ambiguous" or .phase == "promoting")]' <<<"$LATEST_RUN_INTENTS")"
NONTERMINAL_RUN_COUNT="$(jq 'length' <<<"$NONTERMINAL_RUN_INTENTS")"
COMPLETED_RUN_INTENTS="$(jq '[.[] | select(.phase == "completed")]' <<<"$LATEST_RUN_INTENTS")"
COMPLETED_RUN_COUNT="$(jq 'length' <<<"$COMPLETED_RUN_INTENTS")"
WARNING_RUN_INTENTS="$(jq '[.[] | select(.phase == "not_submitted" and has("resultHash"))]' <<<"$LATEST_RUN_INTENTS")"
WARNING_RUN_COUNT="$(jq 'length' <<<"$WARNING_RUN_INTENTS")"
# A retained not_submitted artifact without its binding is damaged evidence,
# not an old failed attempt eligible for replay (also covers missing state).
while IFS= read -r UNBOUND_WARNING_RESULT; do
  if [[ -n "$UNBOUND_WARNING_RESULT" && -e "$UNBOUND_WARNING_RESULT" ]]; then
    echo "[et_low_inventory_guard] retained not_submitted result lacks hash binding; replay forbidden" >&2
    exit 2
  fi
done < <(jq -r '.[] | select(.phase == "not_submitted" and (has("resultHash") | not)) | .resultAttempt // empty' <<<"$LATEST_RUN_INTENTS")
if (( WARNING_RUN_COUNT > 0 && (COMPLETED_RUN_COUNT > 0 || NONTERMINAL_RUN_COUNT > 0 || WARNING_RUN_COUNT > 1) )); then
  echo "[et_low_inventory_guard] conflicting warning evidence; replay forbidden" >&2
  exit 2
fi
if (( COMPLETED_RUN_COUNT > 1 || (COMPLETED_RUN_COUNT == 1 && NONTERMINAL_RUN_COUNT > 0) )); then
  echo "[et_low_inventory_guard] conflicting executor run intents exist; reconcile-required/incomplete" >&2
  exit 2
fi
if (( COMPLETED_RUN_COUNT == 1 )); then
  COMPLETED_INTENT="$(jq '.[0]' <<<"$COMPLETED_RUN_INTENTS")"
  if ! executor_run_intent_binding_is_current "$COMPLETED_INTENT"; then
    echo "[et_low_inventory_guard] completed executor intent binding drift; reconcile-required/incomplete" >&2
    exit 2
  fi
  HASH="$(jq -r '.planHash' <<<"$COMPLETED_INTENT")"
  TOTAL="$(jq -r '.actionCount' <<<"$COMPLETED_INTENT")"
  if ! result_matches_promotion_evidence "$RESULT" "$COMPLETED_INTENT"; then
    echo "[et_low_inventory_guard] completed executor intent lacks exact stable readback result; reconcile-required/incomplete" >&2
    exit 2
  fi
  persist_completed_state "$RESULT"
  jq '{ok,state:"completed_after_journal_reconcile",active,lastProcessedBatchId,etManifestHash,planHash,result,counts}' "$STATE"
  exit 0
fi
if (( NONTERMINAL_RUN_COUNT > 1 )); then
  echo "[et_low_inventory_guard] multiple nonterminal executor run intents exist; reconcile-required/incomplete" >&2
  exit 2
fi
# A warning retains its attempt artifact, never promotes it to completed.
# Recover from the bound not_submitted receipt even if state publication died.
if (( WARNING_RUN_COUNT > 0 )); then
  WARNING_INTENT="$(jq '.[0]' <<<"$WARNING_RUN_INTENTS")"
  WARNING_RESULT="$(jq -r '.resultAttempt' <<<"$WARNING_INTENT")"
  WARNING_INTENT_ID="$(jq -r '.intentId' <<<"$WARNING_INTENT")"
  if ! executor_run_intent_binding_is_current "$WARNING_INTENT" \
    || ! WARNING_AUDIT="$(validate_historical_skip_warning "$WARNING_RESULT" "$WARNING_INTENT_ID" bound)"; then
    echo "[et_low_inventory_guard] bound historical warning evidence damaged; replay forbidden" >&2
    exit 2
  fi
  persist_historical_skip_warning "$WARNING_RESULT" "$WARNING_INTENT_ID" "$WARNING_AUDIT"
  exit 0
fi
if [[ -s "$STATE" ]] && jq -e --arg batch "$BATCH_ID" \
  '.lastProcessedBatchId == $batch and .warning == "historical_skip_no_current_submission"' "$STATE" >/dev/null; then
  echo "[et_low_inventory_guard] warning state lacks bound journal evidence; replay forbidden" >&2
  exit 2
fi
if (( NONTERMINAL_RUN_COUNT == 1 )); then
  RECOVERY_INTENT="$(jq '.[0]' <<<"$NONTERMINAL_RUN_INTENTS")"
  RECOVERY_INTENT_ID="$(jq -r '.intentId // empty' <<<"$RECOVERY_INTENT")"
  RECOVERY_ATTEMPT_ID="$(jq -r '.attemptId // empty' <<<"$RECOVERY_INTENT")"
  RECOVERY_PLAN_HASH="$(jq -r '.planHash // empty' <<<"$RECOVERY_INTENT")"
  RECOVERY_ACTION_COUNT="$(jq -r '.actionCount // -1' <<<"$RECOVERY_INTENT")"
  RECOVERY_RESULT_ATTEMPT="$(jq -r '.resultAttempt // empty' <<<"$RECOVERY_INTENT")"
  RECOVERY_PHASE="$(jq -r '.phase // empty' <<<"$RECOVERY_INTENT")"
  if ! executor_run_intent_binding_is_current "$RECOVERY_INTENT"; then
    echo "[et_low_inventory_guard] nonterminal executor intent binding drift; reconcile-required/incomplete" >&2
    exit 2
  fi
  HASH="$RECOVERY_PLAN_HASH"
  TOTAL="$RECOVERY_ACTION_COUNT"
  RECOVERY_STABLE_PRESENT=false
  RECOVERY_STABLE_PLAN_READBACK_EXACT=false
  if [[ -s "$RESULT" ]]; then
    RECOVERY_STABLE_PRESENT=true
    if result_is_complete_and_safe "$RESULT" "$HASH" "$TOTAL"; then RECOVERY_STABLE_PLAN_READBACK_EXACT=true; fi
  fi
  if [[ "$RECOVERY_PHASE" == "promoting" ]]; then
    RECOVERY_RESULT_HASH="$(jq -r '.resultHash // empty' <<<"$RECOVERY_INTENT")"
    RECOVERY_READBACK_IDENTITY="$(jq -r '.readbackIdentity // empty' <<<"$RECOVERY_INTENT")"
    ATTEMPT_PRESENT=false
    STABLE_PRESENT=false
    ATTEMPT_EXACT=false
    STABLE_EXACT=false
    if [[ -s "$RECOVERY_RESULT_ATTEMPT" ]]; then ATTEMPT_PRESENT=true; fi
    if [[ -s "$RESULT" ]]; then STABLE_PRESENT=true; fi
    if [[ "$ATTEMPT_PRESENT" == "true" ]] && result_matches_promotion_evidence "$RECOVERY_RESULT_ATTEMPT" "$RECOVERY_INTENT"; then ATTEMPT_EXACT=true; fi
    if [[ "$STABLE_PRESENT" == "true" ]] && result_matches_promotion_evidence "$RESULT" "$RECOVERY_INTENT"; then STABLE_EXACT=true; fi
    if [[ "$STABLE_EXACT" == "true" ]]; then
      append_executor_run_phase "$RECOVERY_INTENT_ID" completed "$RECOVERY_ATTEMPT_ID" "$HASH" "$TOTAL" "$RECOVERY_RESULT_ATTEMPT" "${RECOVERY_EXECUTOR_STATUS:-0}" "$RESULT" "$RECOVERY_RESULT_HASH" "$RECOVERY_READBACK_IDENTITY"
      persist_completed_state "$RESULT"
      jq '{ok,state:"completed_after_stable_promotion_reconcile",active,lastProcessedBatchId,etManifestHash,planHash,result,counts}' "$STATE"
      exit 0
    fi
    if [[ "$ATTEMPT_EXACT" == "true" ]]; then
      durably_promote_exact_result "$RECOVERY_INTENT_ID" "$RECOVERY_ATTEMPT_ID" "$HASH" "$TOTAL" "$RECOVERY_RESULT_ATTEMPT" "$RECOVERY_RESULT_HASH" "$RECOVERY_READBACK_IDENTITY" "$(jq -r '.executorStatus // 0' <<<"$RECOVERY_INTENT")" 0
      persist_completed_state "$RESULT"
      jq '{ok,state:"completed_after_attempt_promotion_reconcile",active,lastProcessedBatchId,etManifestHash,planHash,result,counts}' "$STATE"
      exit 0
    fi
    if [[ "$ATTEMPT_PRESENT" == "true" || "$STABLE_PRESENT" == "true" ]]; then
      echo "[et_low_inventory_guard] promotion artifacts do not match exact journal evidence; reconcile-required/incomplete" >&2
      exit 2
    fi
  elif [[ -s "$RECOVERY_RESULT_ATTEMPT" ]] && result_is_complete_and_safe "$RECOVERY_RESULT_ATTEMPT" "$HASH" "$TOTAL"; then
    RECOVERY_RESULT_HASH="$(sha256sum "$RECOVERY_RESULT_ATTEMPT" | awk '{print $1}')"
    RECOVERY_READBACK_IDENTITY="$(result_readback_identity "$RECOVERY_RESULT_ATTEMPT")"
    durably_promote_exact_result "$RECOVERY_INTENT_ID" "$RECOVERY_ATTEMPT_ID" "$HASH" "$TOTAL" "$RECOVERY_RESULT_ATTEMPT" "$RECOVERY_RESULT_HASH" "$RECOVERY_READBACK_IDENTITY" "$(jq -r '.executorStatus // 0' <<<"$RECOVERY_INTENT")" 1
    persist_completed_state "$RESULT"
    jq '{ok,state:"completed_after_readonly_reconcile",active,lastProcessedBatchId,etManifestHash,planHash,result,counts}' "$STATE"
    exit 0
  fi
  PENDING_ROW_INTENTS="$(pending_inventory_intent_count)"
  echo "[et_low_inventory_guard] nonterminal executor intent phase=$(jq -r '.phase' <<<"$RECOVERY_INTENT") pendingRowIntents=$PENDING_ROW_INTENTS hasCurrentAttemptResult=$([[ -s "$RECOVERY_RESULT_ATTEMPT" ]] && echo true || echo false) hasStableResult=$RECOVERY_STABLE_PRESENT stablePlanReadbackExactWithoutJournalHash=$RECOVERY_STABLE_PLAN_READBACK_EXACT; reconcile-required/incomplete; executor replay forbidden" >&2
  exit 2
fi

PENDING_ROW_INTENTS="$(pending_inventory_intent_count)"
if (( PENDING_ROW_INTENTS > 0 )); then
  echo "[et_low_inventory_guard] orphan durable inventory intents=$PENDING_ROW_INTENTS; reconcile-required/incomplete; executor replay forbidden" >&2
  exit 2
fi

if [[ -s "$STATE" ]] \
  && [[ "$(jq -r '.lastProcessedBatchId // empty' "$STATE")" == "$BATCH_ID" ]] \
  && jq -e '.result != null' "$STATE" >/dev/null; then
  # A technically completed batch can still have item-level business warnings.
  # Recompute from the bound artifacts; never turn blocked canonicals into writes pending.
  persist_completed_state "$(jq -r '.result' "$STATE")"
  jq '{ok,state:"batch_already_processed",lastProcessedBatchId,active,planHash,etManifestHash,result,counts}' "$STATE"
  exit 0
fi
if [[ -s "$STATE" ]] && [[ "$(jq -r '.lastProcessedBatchId // empty' "$STATE")" == "$BATCH_ID" ]]; then
  echo "[et_low_inventory_guard] retry incomplete batch=$BATCH_ID previousState=$(jq -r '.businessState // "plan_blocked"' "$STATE")"
fi

run_source_plan_attempt() {
  local required_detail_targets="${1:-}"
  local -a planner_args=(
    --date "$DATE"
    --operation-mode et_low_inventory_safety
    --et-manifest "$ET_MANIFEST_FILE"
    --et-batch-id "$BATCH_ID"
    --et-manifest-hash "$ET_MANIFEST_HASH"
    --et-max-age-seconds "$ET_FACT_MAX_AGE_SECONDS"
    --out "$SOURCE_PLAN_ATTEMPT"
  )
  if [[ -n "$required_detail_targets" ]]; then
    planner_args+=(--required-detail-targets "$required_detail_targets")
  fi
  rm -f "$SOURCE_PLAN_ATTEMPT"
  BUILD_STATUS=0
  node scripts/inventory/build_daily_inventory_replenishment_plan.mjs "${planner_args[@]}" || BUILD_STATUS=$?
  if [[ ! -s "$SOURCE_PLAN_ATTEMPT" ]] || ! jq -e '
    .schemaVersion == "daily-inventory-replenishment-plan/v1"
    and ((.blockers // []) | type == "array")
    and (.payloadHash | type == "string")
  ' "$SOURCE_PLAN_ATTEMPT" >/dev/null 2>&1; then
    rm -f "$SOURCE_PLAN_ATTEMPT"
    echo "[et_low_inventory_guard] current source planner attempt did not produce a valid plan status=$BUILD_STATUS" >&2
    if (( BUILD_STATUS == 0 )); then BUILD_STATUS=1; fi
  fi
}

run_source_plan_attempt

# The safety planner may use cached canonical identity only to discover a
# conservative low-ET candidate set. Before any action is executable, fetch
# current OpenAPI detail for exactly those SPUs, then rebuild the source plan.
# Non-candidates never consume the shared detail budget.
if (( BUILD_STATUS == 2 )) && jq -e '
  ((.detailRefreshTargets // []) | length) > 0
  and ((.blockers // []) | length) > 0
  and all(.blockers[]; startswith("low-ET OpenAPI product canonical evidence is not from current detail:"))
' "$SOURCE_PLAN_ATTEMPT" >/dev/null; then
  jq -n \
    --argjson rows "$(jq '.detailRefreshTargets' "$SOURCE_PLAN_ATTEMPT")" '
      {schemaVersion:"et-low-inventory-detail-targets/v1", stores:
        (reduce $rows[] as $row ({};
          .[$row.storeKey] = (((.[$row.storeKey] // []) + [$row.spu]) | unique)
        ))}
    ' >"$DETAIL_TARGETS_ATTEMPT"
  TARGET_STORES="$(jq -r '.stores | keys | join(",")' "$DETAIL_TARGETS_ATTEMPT")"
  MAX_TARGETS="$(jq '[.stores[] | length] | max // 0' "$DETAIL_TARGETS_ATTEMPT")"
  if [[ ! "$DETAIL_BUDGET" =~ ^[0-9]+$ ]] || (( DETAIL_BUDGET < 1 || MAX_TARGETS > DETAIL_BUDGET )); then
    echo "[et_low_inventory_guard] targeted detail budget exceeded maxTargets=$MAX_TARGETS budget=$DETAIL_BUDGET" >&2
    exit 2
  else
    mv "$DETAIL_TARGETS_ATTEMPT" "$DETAIL_TARGETS"
    echo "[et_low_inventory_guard] refresh current detail stores=$TARGET_STORES maxTargets=$MAX_TARGETS budget=$DETAIL_BUDGET"
    DETAIL_STATUS=0
    SHEIN_OPENAPI_PRODUCT_RECONCILE_STORES="$TARGET_STORES" \
    SHEIN_OPENAPI_PRODUCT_RECONCILE_MAX_DETAILS="$DETAIL_BUDGET" \
    SHEIN_OPENAPI_PRODUCT_RECONCILE_SKIP_DETAILS=0 \
    SHEIN_OPENAPI_PRODUCT_RECONCILE_DETAIL_PRIORITY_FILE="$DETAIL_TARGETS" \
    SHEIN_OPENAPI_PRODUCT_RECONCILE_PRIORITY_DETAILS_ONLY=1 \
      bash "$ROOT/scripts/cloud_openapi_product_reconciliation.sh" || DETAIL_STATUS=$?
    if (( DETAIL_STATUS == 0 )); then
      run_source_plan_attempt "$DETAIL_TARGETS"
    else
      echo "[et_low_inventory_guard] targeted current-detail refresh failed status=$DETAIL_STATUS" >&2
      if (( DETAIL_STATUS != 0 )); then exit "$DETAIL_STATUS"; fi
      exit 1
    fi
  fi
fi

if (( BUILD_STATUS != 0 )); then
  echo "[et_low_inventory_guard] current source planner attempt failed status=$BUILD_STATUS; stale source plan is not eligible" >&2
  exit "$BUILD_STATUS"
fi
if [[ ! -s "$SOURCE_PLAN_ATTEMPT" ]] || ! jq -e '
  .executable == true and ((.blockers // []) | length == 0)
' "$SOURCE_PLAN_ATTEMPT" >/dev/null; then
  echo "[et_low_inventory_guard] current source planner attempt is not executable" >&2
  exit 2
fi
mv "$SOURCE_PLAN_ATTEMPT" "$SOURCE_PLAN"

FILTER_STATUS=0
rm -f "$PLAN_ATTEMPT"
node scripts/inventory/build_et_low_inventory_safety_plan.mjs \
  --source-plan "$SOURCE_PLAN" \
  --batch-id "$BATCH_ID" \
  --manifest-hash "$ET_MANIFEST_HASH" \
  --out "$PLAN_ATTEMPT" || FILTER_STATUS=$?
if [[ ! -s "$PLAN_ATTEMPT" ]] || ! jq -e '
  .schemaVersion == "et-low-inventory-safety-plan/v1"
  and (.payloadHash | type == "string")
' "$PLAN_ATTEMPT" >/dev/null 2>&1; then
  rm -f "$PLAN_ATTEMPT"
  echo "[et_low_inventory_guard] current safety planner attempt did not produce a valid plan status=$FILTER_STATUS" >&2
  if (( FILTER_STATUS != 0 )); then exit "$FILTER_STATUS"; fi
  exit 1
fi
if (( FILTER_STATUS != 0 )); then
  echo "[et_low_inventory_guard] current safety planner attempt failed status=$FILTER_STATUS; stale safety plan is not eligible" >&2
  exit "$FILTER_STATUS"
fi
if ! jq -e '.executable == true and ((.blockers // []) | length == 0)' "$PLAN_ATTEMPT" >/dev/null; then
  echo "[et_low_inventory_guard] current safety planner attempt is not executable" >&2
  exit 2
fi
mv "$PLAN_ATTEMPT" "$PLAN"

HASH="$(jq -r '.payloadHash // empty' "$PLAN")"
TOTAL="$(jq -r '.actionable | length' "$PLAN")"
EXECUTABLE="$(jq -r '.executable == true and ((.blockers // []) | length == 0)' "$PLAN")"
if [[ ! "$HASH" =~ ^[a-f0-9]{64}$ ]]; then
  echo "[et_low_inventory_guard] safety plan has no valid payloadHash" >&2
  exit 1
fi
if [[ "$EXECUTABLE" != "true" ]]; then
  echo "[et_low_inventory_guard] current safety plan lost executable status after atomic replace" >&2
  exit 2
fi

rm -f "$RESULT_ATTEMPT" "$RESULT_ATTEMPT_JOURNAL"
RUN_INTENT_ID="$(printf '%s\n' "$DATE|$BATCH_ID|$ET_MANIFEST_HASH|$HASH|$ATTEMPT_ID" | sha256sum | awk '{print $1}')"
# Retention is armed before the first durable run-intent append. A signal in
# the instruction-sized gap after fsync therefore cannot delete an executor
# result that may already contain authoritative write/readback evidence.
RETAIN_RESULT_ATTEMPT=1
append_executor_run_phase "$RUN_INTENT_ID" prepared "$ATTEMPT_ID" "$HASH" "$TOTAL" "$RESULT_ATTEMPT"
if ! ln "$RESULT_JOURNAL" "$RESULT_ATTEMPT_JOURNAL"; then
  echo "[et_low_inventory_guard] cannot bind current executor attempt to the stable durable journal" >&2
  exit 1
fi
append_executor_run_phase "$RUN_INTENT_ID" executing "$ATTEMPT_ID" "$HASH" "$TOTAL" "$RESULT_ATTEMPT"
set +e
node scripts/inventory/execute_daily_inventory_replenishment_plan.mjs \
  --plan "$PLAN" \
  --execute \
  --execution-mode automatic \
  --confirm-hash "$HASH" \
  --max-rows 1000 \
  --out "$RESULT_ATTEMPT"
EXECUTOR_STATUS=$?
set -e

# The executor appends its row-level intents and outcomes through a hard-link
# alias to the already durable stable journal. Removing the alias never removes
# the stable inode or its pre-write run intent.
if [[ -e "$RESULT_ATTEMPT_JOURNAL" ]]; then
  rm -f "$RESULT_ATTEMPT_JOURNAL"
fi
if (( EXECUTOR_STATUS != 0 )); then
  CURRENT_RUN_DISPOSITION="$(jq -r --arg intentId "$RUN_INTENT_ID" --arg planHash "$HASH" '
    (to_entries | map(select(.value.kind == "executor_run_intent" and .value.intentId == $intentId)) | first | .key) as $start
    | [to_entries[] | select(.key > $start) | .value | select(.kind == "intent" and .planHash == $planHash)] as $intents
    | [to_entries[] | select(.key > $start) | .value | select(.kind == "write_outcome")] as $outcomes
    | if ($intents | length) == 0 then "not_submitted"
      elif all($intents[]; .intentId as $id | any($outcomes[]; .intentId == $id and .disposition == "rejected")) then "rejected"
      else "ambiguous" end
  ' <(jq -s '.' "$RESULT_JOURNAL"))"
  # Leave ordinary pre-submit failures on their existing strict failure path.
  # Malformed results or any historical/pending claim require exact validation.
  WARNING_CANDIDATE=true
  if [[ -s "$RESULT_ATTEMPT" ]] && jq -e '
    (.results | type) == "array" and all(.results[];
      .state != "submitted_but_readback_pending" and .historicalPending != true
      and .historicalIntentId == null)
  ' "$RESULT_ATTEMPT" >/dev/null 2>&1; then WARNING_CANDIDATE=false; fi
  if (( EXECUTOR_STATUS == 1 )) && [[ "$CURRENT_RUN_DISPOSITION" == "not_submitted" && -s "$RESULT_ATTEMPT" && "$WARNING_CANDIDATE" == "true" ]]; then
    if WARNING_AUDIT="$(validate_historical_skip_warning "$RESULT_ATTEMPT" "$RUN_INTENT_ID" candidate)"; then
      sync_durable_path "$RESULT_ATTEMPT"
      sync_durable_path "$(dirname "$RESULT_ATTEMPT")"
      append_executor_run_phase "$RUN_INTENT_ID" not_submitted "$ATTEMPT_ID" "$HASH" "$TOTAL" "$RESULT_ATTEMPT" "$EXECUTOR_STATUS" "" "$(jq -r '.resultHash' <<<"$WARNING_AUDIT")"
      persist_historical_skip_warning "$RESULT_ATTEMPT" "$RUN_INTENT_ID" "$WARNING_AUDIT"
      exit 0
    fi
    # A supplied but unverifiable result must never authorize a retry.
    append_executor_run_phase "$RUN_INTENT_ID" ambiguous "$ATTEMPT_ID" "$HASH" "$TOTAL" "$RESULT_ATTEMPT" "$EXECUTOR_STATUS"
    echo "[et_low_inventory_guard] historical warning validation failed; retained evidence; replay forbidden" >&2
    exit 1
  fi
  append_executor_run_phase "$RUN_INTENT_ID" "$CURRENT_RUN_DISPOSITION" "$ATTEMPT_ID" "$HASH" "$TOTAL" "$RESULT_ATTEMPT" "$EXECUTOR_STATUS"
  if [[ "$CURRENT_RUN_DISPOSITION" == "not_submitted" || "$CURRENT_RUN_DISPOSITION" == "rejected" ]]; then RETAIN_RESULT_ATTEMPT=0; fi
  echo "[et_low_inventory_guard] current executor attempt failed status=$EXECUTOR_STATUS; stale stable result is not eligible" >&2
  exit "$EXECUTOR_STATUS"
fi
if [[ ! -s "$RESULT_ATTEMPT" ]] || ! result_is_complete_and_safe "$RESULT_ATTEMPT" "$HASH" "$TOTAL"; then
  append_executor_run_phase "$RUN_INTENT_ID" ambiguous "$ATTEMPT_ID" "$HASH" "$TOTAL" "$RESULT_ATTEMPT" "$EXECUTOR_STATUS"
  echo "[et_low_inventory_guard] current executor attempt did not produce an exact complete readback result" >&2
  exit 1
fi
RESULT_HASH="$(sha256sum "$RESULT_ATTEMPT" | awk '{print $1}')"
READBACK_IDENTITY="$(result_readback_identity "$RESULT_ATTEMPT")"
durably_promote_exact_result "$RUN_INTENT_ID" "$ATTEMPT_ID" "$HASH" "$TOTAL" "$RESULT_ATTEMPT" "$RESULT_HASH" "$READBACK_IDENTITY" "$EXECUTOR_STATUS" 1
persist_completed_state "$RESULT"
jq '{ok,state:"completed",active,lastProcessedBatchId,etManifestHash,planHash,result,counts}' "$STATE"
