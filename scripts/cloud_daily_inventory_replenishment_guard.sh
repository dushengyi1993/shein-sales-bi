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
    --not-before "${DATE}T15:11:00+08:00" \
    || {
      echo "[daily_inventory_guard] 15:12 stock refresh marker is not ready" >&2
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
  local status
  set +e
  node scripts/inventory/build_daily_inventory_replenishment_plan.mjs --date "$DATE" --out "$PLAN"
  status=$?
  set -e
  return "$status"
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

if [[ "$REFRESH_OPENAPI_ON_STALE" == "1" ]] && jq -e '
  (.blockers // []) | any(
    test(" OpenAPI product snapshot is stale$")
    or test(" OpenAPI stock snapshot has failed chunks$")
    or test(" OpenAPI product snapshot unavailable:")
  )
' "$PLAN" >/dev/null; then
  echo "[daily_inventory_guard] refresh 19-store read-only OpenAPI product/stock snapshots and rebuild plan"
  if SHEIN_OPENAPI_PRODUCT_RECONCILE_CONCURRENCY=2 bash scripts/cloud_openapi_product_reconciliation.sh; then
    PLAN_STATUS=0
    build_plan || PLAN_STATUS=$?
  else
    echo "[daily_inventory_guard] OpenAPI source refresh failed; retain exact blockers in rebuilt/current plan" >&2
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
