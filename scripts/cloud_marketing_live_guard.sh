#!/usr/bin/env bash
set -Eeuo pipefail

reject_marketing_resume_request() {
  local name
  while IFS= read -r name; do
    case "$name" in
      SHEIN_BI_MARKETING_RESUME_*|SHEIN_BI_MARKETING_LIVE_RESUME_*|SHEIN_BI_MARKETING_LIVE_GUARD_RESUME_*)
        echo "[cloud_marketing_live_guard] ERROR same-run marketing resume is disabled; refusing $name before any marketing helper" >&2
        return 64
        ;;
    esac
  done < <(compgen -e)
}

if reject_marketing_resume_request; then
  :
else
  exit 64
fi

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
source "$ROOT/scripts/lib/shared_lock.sh"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_BI_MARKETING_LIVE_LOG_DIR:-/srv/shein-bi/logs/cloud-marketing-live-guard}"
STATE_DIR="${SHEIN_BI_MARKETING_LIVE_STATE_DIR:-$ROOT/state/cloud_marketing_live_guard}"
ALERT_DIR="$ROOT/state/cloud_ops_alerts"
LOCK_FILE="${SHEIN_BI_MARKETING_LIVE_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-marketing-live-guard.lock}"
ARTIFACT_PUBLICATION_LOCK_FILE="${SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-marketing-artifact-publication.lock}"
ARTIFACT_PUBLICATION_LOCK_WAIT_SEC="${SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_WAIT_SEC:-30}"
GROUP="${SHEIN_BI_MARKETING_LIVE_GROUP:-ALL}"
PAGE_SIZE="${SHEIN_BI_MARKETING_LIVE_PAGE_SIZE:-500}"
STORE_ATTEMPTS="${SHEIN_BI_MARKETING_PRICE_STORE_ATTEMPTS:-3}"
SCAN_TIMEOUT_SEC="${SHEIN_BI_MARKETING_LIVE_SCAN_TIMEOUT_SEC:-2400}"
SCAN_KILL_AFTER_SEC="${SHEIN_BI_MARKETING_LIVE_SCAN_KILL_AFTER_SEC:-60}"
STACK_REVIEW_TIMEOUT_SEC="${SHEIN_BI_MARKETING_STACK_REVIEW_TIMEOUT_SEC:-600}"
STACK_REVIEW_KILL_AFTER_SEC="${SHEIN_BI_MARKETING_STACK_REVIEW_KILL_AFTER_SEC:-30}"
STAGE_ATTEMPTS="${SHEIN_BI_MARKETING_STAGE_ATTEMPTS:-3}"
STAGE_RETRY_DELAY_SEC="${SHEIN_BI_MARKETING_STAGE_RETRY_DELAY_SEC:-30}"
GUARD_MAX_AGE_HOURS="${SHEIN_BI_MARKETING_LIVE_GUARD_MAX_AGE_HOURS:-96}"
GUARD_CLOUD_BI_SSH="${SHEIN_BI_MARKETING_LIVE_CLOUD_BI_SSH:-local}"
GUARD_CLOUD_BI_ROOT="${SHEIN_BI_MARKETING_LIVE_CLOUD_BI_ROOT:-$ROOT}"
MIN_AVAILABLE_MEM_MIB="${SHEIN_BI_MARKETING_LIVE_MIN_AVAILABLE_MEM_MIB:-2200}"
LOW_MEMORY_RETRY_INTERVAL_SEC="${SHEIN_BI_MARKETING_LIVE_LOW_MEMORY_RETRY_INTERVAL_SEC:-15}"
LOW_MEMORY_MAX_WAIT_SEC="${SHEIN_BI_MARKETING_LIVE_LOW_MEMORY_MAX_WAIT_SEC:-600}"
MEMINFO_FILE="${SHEIN_BI_MARKETING_LIVE_MEMINFO_FILE:-/proc/meminfo}"
BUILD_REPAIR_QUEUE="${SHEIN_BI_MARKETING_LIVE_BUILD_REPAIR_QUEUE:-${SHEIN_BI_MARKETING_LIVE_AUTO_REPAIR:-0}}"
RESERVED_WINDOW_MINUTES="${SHEIN_BI_MARKETING_LIVE_RESERVED_WINDOW_MINUTES:-6}"
# The managed live guard is session-HTTP/OpenAPI only. Its service cgroup and
# bounded memory gate constrain it; this lane does not add a cross-project API
# semaphore. The old minute table caused the 11:00 run to reject itself and is
# opt-in only for legacy/manual browser scans.
IGNORE_RESERVED_WINDOW="${SHEIN_BI_MARKETING_LIVE_IGNORE_RESERVED_WINDOW:-1}"
FORCE_RERUN="${SHEIN_BI_MARKETING_LIVE_FORCE_RERUN:-0}"
MARKETING_PLAN_REGISTRY_FILE="${SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE:-}"
MARKETING_COST_MAP_PATH="${SHEIN_BI_MARKETING_COST_MAP_PATH:-${SHEIN_BI_MARKETING_LIVE_COST_MAP_PATH:-$ROOT/tmp/mbrs/marketing-cost-map.json}}"
RUN_EVIDENCE_READY=0
RUN_EVIDENCE_SCAN_PATH=""
RUN_EVIDENCE_SCAN_SHA256=""
RUN_EVIDENCE_STACK_REVIEW_PATH=""
RUN_EVIDENCE_STACK_REVIEW_SHA256=""
CURRENT_REGISTRY_HASH=""
GUARD_BOUND_PRICE_OVERRIDES_PATH=""
GUARD_BOUND_PRICE_OVERRIDES_SHA256=""
GUARD_BOUND_REGISTRY_HASH=""
GUARD_BOUND_MARKETING_COST_MAP_PATH=""
GUARD_BOUND_MARKETING_COST_MAP_SHA256=""
MARKETING_COST_MAP_SHA256=""
REPAIR_QUEUE_FINGERPRINT=""
REPAIR_QUEUE_SOURCE_GUARD_HASH=""
REPAIR_QUEUE_STATE_SHA256=""
ARTIFACT_PUBLICATION_LOCK_ACQUIRED=0

resolve_today() {
  if [[ -n "${SHEIN_BI_MARKETING_LIVE_DATE:-}" ]]; then
    printf '%s\n' "$SHEIN_BI_MARKETING_LIVE_DATE"
    return 0
  fi
  TZ="$TZ_NAME" date +%F
}

now_iso() {
  TZ="$TZ_NAME" date --iso-8601=seconds
}

available_mem_mib() {
  awk '/MemAvailable:/ { printf "%d\n", $2 / 1024; found=1 } END { if (!found) print 0 }' "$MEMINFO_FILE" 2>/dev/null || echo 0
}

wait_for_low_memory_capacity() {
  local interval="$LOW_MEMORY_RETRY_INTERVAL_SEC"
  local max_wait="$LOW_MEMORY_MAX_WAIT_SEC"
  local elapsed=0
  local available remaining sleep_for

  if ! [[ "$interval" =~ ^[0-9]+$ ]] || (( interval < 1 )); then
    echo "[cloud_marketing_live_guard] ERROR invalid low-memory retry interval: $interval" >&2
    return 2
  fi
  if ! [[ "$max_wait" =~ ^[0-9]+$ ]] || (( max_wait < 0 || max_wait >= 1800 )); then
    echo "[cloud_marketing_live_guard] ERROR invalid low-memory max wait: $max_wait (must be < 1800s)" >&2
    return 2
  fi

  while :; do
    available="$(available_mem_mib)"
    AVAILABLE_MEM="$available"
    # Only an explicit value at or above the threshold is capacity readiness;
    # zero or an unreadable meminfo source must not silently pass the gate.
    if [[ "$available" =~ ^[0-9]+$ ]] && (( available >= MIN_AVAILABLE_MEM_MIB )); then
      LOW_MEMORY_WAIT_ELAPSED_SEC="$elapsed"
      return 0
    fi
    if (( elapsed >= max_wait )); then
      LOW_MEMORY_WAIT_ELAPSED_SEC="$elapsed"
      return 1
    fi

    remaining=$((max_wait - elapsed))
    sleep_for="$interval"
    if (( sleep_for > remaining )); then
      sleep_for="$remaining"
    fi
    echo "[cloud_marketing_live_guard] low memory wait elapsed=${elapsed}s MemAvailable=${available}MiB threshold=${MIN_AVAILABLE_MEM_MIB}MiB; recheck in ${sleep_for}s"
    sleep "$sleep_for"
    elapsed=$((elapsed + sleep_for))
  done
}

release_marketing_artifact_publication_lock() {
  if [[ "$ARTIFACT_PUBLICATION_LOCK_ACQUIRED" == "1" ]]; then
    flock -u 8 2>/dev/null || true
    exec 8>&-
    ARTIFACT_PUBLICATION_LOCK_ACQUIRED=0
  fi
}

acquire_marketing_artifact_publication_lock() {
  if ! [[ "$ARTIFACT_PUBLICATION_LOCK_WAIT_SEC" =~ ^[0-9]+$ ]] || (( ARTIFACT_PUBLICATION_LOCK_WAIT_SEC >= 1800 )); then
    echo "[cloud_marketing_live_guard] ERROR invalid artifact publication lock wait: $ARTIFACT_PUBLICATION_LOCK_WAIT_SEC" >&2
    return 64
  fi
  prepare_shared_lock_file "$ARTIFACT_PUBLICATION_LOCK_FILE"
  exec 8<>"$ARTIFACT_PUBLICATION_LOCK_FILE"
  if ! flock -w "$ARTIFACT_PUBLICATION_LOCK_WAIT_SEC" 8; then
    echo "[cloud_marketing_live_guard] artifact publication lock busy: $ARTIFACT_PUBLICATION_LOCK_FILE" >&2
    exec 8>&-
    return 75
  fi
  ARTIFACT_PUBLICATION_LOCK_ACQUIRED=1
}

guard_json_value() {
  local expression="$1"
  local default_value="${2:-0}"
  GUARD_FILE="$GUARD_INPUT_OUT" GUARD_EXPR="$expression" GUARD_DEFAULT="$default_value" node <<'NODE'
const fs = require('node:fs');
try {
  const j = JSON.parse(fs.readFileSync(process.env.GUARD_FILE, 'utf8'));
  const f = new Function('j', `return (${process.env.GUARD_EXPR});`);
  const value = f(j);
  console.log(value === undefined || value === null || Number.isNaN(value) ? process.env.GUARD_DEFAULT || '0' : String(value));
} catch {
  console.log(process.env.GUARD_DEFAULT || '0');
}
NODE
}

validate_guard_plan_binding() {
  local guard_file="$1"
  local expected_registry_hash="${2:-}"
  local expected_cost_map_path="${3:-$MARKETING_COST_MAP_PATH}"
  local expected_cost_map_hash="${4:-$MARKETING_COST_MAP_SHA256}"
  local binding
  local fields=()
  if ! binding="$(GUARD_BINDING_FILE="$guard_file" ROOT_DIR="$ROOT" EXPECTED_REGISTRY_HASH="$expected_registry_hash" EXPECTED_COST_MAP_PATH="$expected_cost_map_path" EXPECTED_COST_MAP_SHA256="$expected_cost_map_hash" node <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.env.ROOT_DIR);
const guardFile = path.resolve(root, process.env.GUARD_BINDING_FILE);
const guardStat = fs.lstatSync(guardFile);
if (!guardStat.isFile() || guardStat.isSymbolicLink()) {
  throw new Error(`guard report must be a regular non-symlink file: ${guardFile}`);
}
const report = JSON.parse(fs.readFileSync(guardFile, 'utf8').replace(/^\uFEFF/, ''));
const selection = report?.targetPlanSelection || {};
if (selection.strategy !== 'registry_current_baseline') {
  throw new Error(`guard targetPlanSelection.strategy must be registry_current_baseline; got=${selection.strategy || 'missing'}`);
}
const registryHash = String(selection.registryHash || '').trim().toLowerCase();
const priceOverridesHash = String(selection.priceOverridesHash || '').trim().toLowerCase();
if (!/^[a-f0-9]{64}$/.test(registryHash)) {
  throw new Error(`guard targetPlanSelection.registryHash must be a 64-hex SHA-256; got=${registryHash || 'missing'}`);
}
if (!/^[a-f0-9]{64}$/.test(priceOverridesHash)) {
  throw new Error(`guard targetPlanSelection.priceOverridesHash must be a 64-hex SHA-256; got=${priceOverridesHash || 'missing'}`);
}
const expectedRegistryHash = String(process.env.EXPECTED_REGISTRY_HASH || '').trim().toLowerCase();
if (expectedRegistryHash && !/^[a-f0-9]{64}$/.test(expectedRegistryHash)) {
  throw new Error(`expected registry hash must be 64-hex; got=${expectedRegistryHash}`);
}
if (expectedRegistryHash && registryHash !== expectedRegistryHash) {
  throw new Error(`guard registry hash drift expected=${expectedRegistryHash} actual=${registryHash}`);
}
const rawPricePath = String(selection.priceOverrides || '').trim();
if (!rawPricePath || /[\r\n]/.test(rawPricePath)) {
  throw new Error('guard targetPlanSelection.priceOverrides must be a non-empty single-line path');
}
const priceOverridesPath = path.isAbsolute(rawPricePath)
  ? path.resolve(rawPricePath)
  : path.resolve(root, rawPricePath);
const priceStat = fs.lstatSync(priceOverridesPath);
if (!priceStat.isFile() || priceStat.isSymbolicLink()) {
  throw new Error(`guard price overrides must be a regular non-symlink file: ${priceOverridesPath}`);
}
const actualPriceOverridesHash = crypto.createHash('sha256').update(fs.readFileSync(priceOverridesPath)).digest('hex');
if (actualPriceOverridesHash !== priceOverridesHash) {
  throw new Error(`guard price overrides hash drift expected=${priceOverridesHash} actual=${actualPriceOverridesHash} file=${priceOverridesPath}`);
}
const costMapSource = report?.marketingCostMapSource || {};
const rawCostMapPath = String(costMapSource.path || '').trim();
const costMapHash = String(costMapSource.sha256 || '').trim().toLowerCase();
if (!rawCostMapPath || /[\r\n]/.test(rawCostMapPath)) {
  throw new Error('guard marketingCostMapSource.path must be a non-empty single-line path');
}
if (!/^[a-f0-9]{64}$/.test(costMapHash)) {
  throw new Error(`guard marketingCostMapSource.sha256 must be a 64-hex SHA-256; got=${costMapHash || 'missing'}`);
}
if (costMapSource.verified !== true) {
  throw new Error('guard marketingCostMapSource.verified must be true');
}
const costMapPath = path.isAbsolute(rawCostMapPath)
  ? path.resolve(rawCostMapPath)
  : path.resolve(root, rawCostMapPath);
const expectedCostMapPath = String(process.env.EXPECTED_COST_MAP_PATH || '').trim();
const expectedCostMapHash = String(process.env.EXPECTED_COST_MAP_SHA256 || '').trim().toLowerCase();
if (expectedCostMapPath && costMapPath !== path.resolve(expectedCostMapPath)) {
  throw new Error(`guard marketing cost map path drift expected=${expectedCostMapPath} actual=${costMapPath}`);
}
if (expectedCostMapHash && costMapHash !== expectedCostMapHash) {
  throw new Error(`guard marketing cost map hash drift expected=${expectedCostMapHash} actual=${costMapHash}`);
}
const costMapStat = fs.lstatSync(costMapPath);
if (!costMapStat.isFile() || costMapStat.isSymbolicLink()) {
  throw new Error(`guard marketing cost map must be a regular non-symlink file: ${costMapPath}`);
}
const actualCostMapHash = crypto.createHash('sha256').update(fs.readFileSync(costMapPath)).digest('hex');
if (actualCostMapHash !== costMapHash) {
  throw new Error(`guard marketing cost map hash drift expected=${costMapHash} actual=${actualCostMapHash} file=${costMapPath}`);
}
process.stdout.write(`${priceOverridesPath}\n${priceOverridesHash}\n${registryHash}\n${costMapPath}\n${costMapHash}`);
NODE
)"; then
    echo "[cloud_marketing_live_guard] ERROR guard plan binding validation failed guard=$guard_file" >&2
    return 66
  fi
  mapfile -t fields <<<"$binding"
  if [[ "${#fields[@]}" -ne 5 || -z "${fields[0]}" || -z "${fields[3]}" ]]; then
    echo "[cloud_marketing_live_guard] ERROR guard plan binding validator returned an invalid tuple" >&2
    return 66
  fi
  GUARD_BOUND_PRICE_OVERRIDES_PATH="${fields[0]}"
  GUARD_BOUND_PRICE_OVERRIDES_SHA256="${fields[1]}"
  GUARD_BOUND_REGISTRY_HASH="${fields[2]}"
  GUARD_BOUND_MARKETING_COST_MAP_PATH="${fields[3]}"
  GUARD_BOUND_MARKETING_COST_MAP_SHA256="${fields[4]}"
}

publish_staged_guard_report() {
  local staged_json="$GUARD_INPUT_OUT"
  local staged_md="$GUARD_STAGE_DIR/marketing-daily-guard-${DATE}.md"
  if [[ ! -f "$staged_json" || ! -f "$staged_md" ]]; then
    echo "[cloud_marketing_live_guard] ERROR staged guard report is incomplete: dir=$GUARD_STAGE_DIR" >&2
    return 66
  fi
  STAGED_JSON="$staged_json" STAGED_MD="$staged_md" TARGET_JSON="$GUARD_OUT" TARGET_MD="$ROOT/outputs/reports/marketing-daily-guard-${DATE}.md" ROOT_DIR="$ROOT" EXPECTED_REGISTRY_HASH="$CURRENT_REGISTRY_HASH" EXPECTED_COST_MAP_PATH="$MARKETING_COST_MAP_PATH" EXPECTED_COST_MAP_SHA256="$MARKETING_COST_MAP_SHA256" node --input-type=module <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {writeFileAtomic} from './lib/atomic_file_publish.mjs';

const json = await fs.readFile(process.env.STAGED_JSON);
const md = await fs.readFile(process.env.STAGED_MD);
const report = JSON.parse(json.toString('utf8').replace(/^\uFEFF/, ''));
const selection = report?.targetPlanSelection || {};
if (selection.strategy !== 'registry_current_baseline') {
  throw new Error(`staged guard targetPlanSelection.strategy must be registry_current_baseline; got=${selection.strategy || 'missing'}`);
}
const registryHash = String(selection.registryHash || '').trim().toLowerCase();
const priceOverridesHash = String(selection.priceOverridesHash || '').trim().toLowerCase();
const expectedRegistryHash = String(process.env.EXPECTED_REGISTRY_HASH || '').trim().toLowerCase();
if (!/^[a-f0-9]{64}$/.test(registryHash) || !/^[a-f0-9]{64}$/.test(priceOverridesHash)) {
  throw new Error('staged guard registryHash and priceOverridesHash must both be 64-hex SHA-256 values');
}
if (!/^[a-f0-9]{64}$/.test(expectedRegistryHash) || registryHash !== expectedRegistryHash) {
  throw new Error(`staged guard registry hash drift expected=${expectedRegistryHash || 'missing'} actual=${registryHash}`);
}
const rawPricePath = String(selection.priceOverrides || '').trim();
if (!rawPricePath || /[\r\n]/.test(rawPricePath)) {
  throw new Error('staged guard targetPlanSelection.priceOverrides must be a non-empty single-line path');
}
const priceOverridesPath = path.isAbsolute(rawPricePath)
  ? path.resolve(rawPricePath)
  : path.resolve(process.env.ROOT_DIR, rawPricePath);
const priceStat = await fs.lstat(priceOverridesPath);
if (!priceStat.isFile() || priceStat.isSymbolicLink()) {
  throw new Error(`staged guard price overrides must be a regular non-symlink file: ${priceOverridesPath}`);
}
const actualPriceOverridesHash = crypto.createHash('sha256').update(await fs.readFile(priceOverridesPath)).digest('hex');
if (actualPriceOverridesHash !== priceOverridesHash) {
  throw new Error(`staged guard price overrides hash drift expected=${priceOverridesHash} actual=${actualPriceOverridesHash}`);
}
const costMapSource = report?.marketingCostMapSource || {};
const rawCostMapPath = String(costMapSource.path || '').trim();
const costMapHash = String(costMapSource.sha256 || '').trim().toLowerCase();
if (!rawCostMapPath || /[\r\n]/.test(rawCostMapPath)) {
  throw new Error('staged guard marketingCostMapSource.path must be a non-empty single-line path');
}
if (!/^[a-f0-9]{64}$/.test(costMapHash) || costMapSource.verified !== true) {
  throw new Error('staged guard marketingCostMapSource must contain a verified 64-hex SHA-256');
}
const costMapPath = path.isAbsolute(rawCostMapPath)
  ? path.resolve(rawCostMapPath)
  : path.resolve(process.env.ROOT_DIR, rawCostMapPath);
const expectedCostMapPath = String(process.env.EXPECTED_COST_MAP_PATH || '').trim();
const expectedCostMapHash = String(process.env.EXPECTED_COST_MAP_SHA256 || '').trim().toLowerCase();
if (expectedCostMapPath && costMapPath !== path.resolve(expectedCostMapPath)) {
  throw new Error(`staged guard marketing cost map path drift expected=${expectedCostMapPath} actual=${costMapPath}`);
}
if (expectedCostMapHash && costMapHash !== expectedCostMapHash) {
  throw new Error(`staged guard marketing cost map hash drift expected=${expectedCostMapHash} actual=${costMapHash}`);
}
const costMapStat = await fs.lstat(costMapPath);
if (!costMapStat.isFile() || costMapStat.isSymbolicLink()) {
  throw new Error(`staged guard marketing cost map must be a regular non-symlink file: ${costMapPath}`);
}
const actualCostMapHash = crypto.createHash('sha256').update(await fs.readFile(costMapPath)).digest('hex');
if (actualCostMapHash !== costMapHash) {
  throw new Error(`staged guard marketing cost map hash drift expected=${costMapHash} actual=${actualCostMapHash}`);
}
await writeFileAtomic(process.env.TARGET_JSON, json, {encoding: 'utf8'});
await writeFileAtomic(process.env.TARGET_MD, md, {encoding: 'utf8'});
NODE
}

run_live_scan() {
  local out="$1"
  timeout -k "$SCAN_KILL_AFTER_SEC" "$SCAN_TIMEOUT_SEC" \
    node scripts/marketing/scan_current_marketing_prices_for_bi.mjs \
      --group "$GROUP" \
      --page-size "$PAGE_SIZE" \
      --store-attempts "$STORE_ATTEMPTS" \
      --session-http \
      --session-concurrency "${SHEIN_BI_MARKETING_PRICE_SESSION_CONCURRENCY:-3}" \
      --out "$out"
}

run_marketing_stack_review() {
  timeout -k "$STACK_REVIEW_KILL_AFTER_SEC" "$STACK_REVIEW_TIMEOUT_SEC" \
    node scripts/marketing/export_marketing_stack_review.mjs \
      --batch-size 3 \
      --session-http \
      --cloud-bi-ssh "$GUARD_CLOUD_BI_SSH" \
      --cloud-bi-root "$GUARD_CLOUD_BI_ROOT"
}

run_stage_with_retry() {
  local label="$1"
  shift
  local attempt=1
  local status=1
  while (( attempt <= STAGE_ATTEMPTS )); do
    echo "[cloud_marketing_live_guard] stage=$label attempt=$attempt/$STAGE_ATTEMPTS"
    if "$@"; then
      return 0
    else
      status=$?
    fi
    if (( attempt < STAGE_ATTEMPTS )); then
      echo "[cloud_marketing_live_guard] WARN stage=$label attempt=$attempt status=$status; retrying the failed stage inside the same daily run in ${STAGE_RETRY_DELAY_SEC}s" >&2
      sleep "$STAGE_RETRY_DELAY_SEC"
    fi
    attempt=$((attempt + 1))
  done
  return "$status"
}

run_guard_report() {
  local -a current_run_evidence_args=()
  if [[ -n "${RUN_EVIDENCE_SCAN_PATH:-}" && -n "${RUN_EVIDENCE_STACK_REVIEW_PATH:-}" ]]; then
    current_run_evidence_args=(
      --current-marketing-live-scan "$RUN_EVIDENCE_SCAN_PATH"
      --marketing-stack-review "$RUN_EVIDENCE_STACK_REVIEW_PATH"
    )
  fi
  node scripts/marketing/build_marketing_daily_guard_report.mjs \
    --date "$DATE" \
    --out-dir "$GUARD_STAGE_DIR" \
    --max-age-hours "$GUARD_MAX_AGE_HOURS" \
    --cloud-bi-ssh "$GUARD_CLOUD_BI_SSH" \
    --cloud-bi-root "$GUARD_CLOUD_BI_ROOT" \
    --marketing-cost-map "$MARKETING_COST_MAP_PATH" \
    --expected-marketing-cost-map-sha256 "$MARKETING_COST_MAP_SHA256" \
    "${current_run_evidence_args[@]}"
}

rebuild_final_guard_report_after_repair_plans() {
  local rebuild_status binding_status publish_status
  echo "[cloud_marketing_live_guard] rebuild final guard report after repair plans before queue build"
  if run_stage_with_retry "final-guard-report" run_guard_report; then
    GUARD_INPUT_OUT="$GUARD_STAGE_DIR/marketing-daily-guard-${DATE}.json"
    if validate_guard_plan_binding "$GUARD_INPUT_OUT" "$CURRENT_REGISTRY_HASH"; then
      if publish_staged_guard_report; then
        GUARD_INPUT_OUT="$GUARD_OUT"
        echo "[cloud_marketing_live_guard] final guard report published before queue build guard=$GUARD_OUT registryHash=$GUARD_BOUND_REGISTRY_HASH priceOverridesHash=$GUARD_BOUND_PRICE_OVERRIDES_SHA256"
        return 0
      else
        publish_status=$?
        echo "[cloud_marketing_live_guard] WARN final guard report publication returned status=$publish_status" >&2
        return "$publish_status"
      fi
    else
      binding_status=$?
      echo "[cloud_marketing_live_guard] WARN final guard report binding returned status=$binding_status" >&2
      return "$binding_status"
    fi
  else
    rebuild_status=$?
    echo "[cloud_marketing_live_guard] WARN final guard report rebuild returned status=$rebuild_status" >&2
    return "$rebuild_status"
  fi
}

refresh_marketing_cost_map() {
  python3 scripts/marketing/build_marketing_cost_map.py
}

run_on_shelf_limited_discount_plan() {
  local price_overrides_path price_overrides_hash cost_map_path cost_map_hash
  validate_guard_plan_binding "$GUARD_OUT" "$CURRENT_REGISTRY_HASH" "$MARKETING_COST_MAP_PATH" "$MARKETING_COST_MAP_SHA256" || return $?
  price_overrides_path="$GUARD_BOUND_PRICE_OVERRIDES_PATH"
  price_overrides_hash="$GUARD_BOUND_PRICE_OVERRIDES_SHA256"
  cost_map_path="$GUARD_BOUND_MARKETING_COST_MAP_PATH"
  cost_map_hash="$GUARD_BOUND_MARKETING_COST_MAP_SHA256"
  node scripts/marketing/build_new_listing_limited_discount_plan.mjs \
    --date "$DATE" \
    --source-guard "$GUARD_OUT" \
    --exclude-manual-special true \
    --current-marketing-live-scan "$SCAN_OUT" \
    --cost-map "$cost_map_path" \
    --expected-marketing-cost-map-sha256 "$cost_map_hash" \
    --price-overrides "$price_overrides_path" \
    --expected-price-overrides-sha256 "$price_overrides_hash" \
    --no-supplemental-price-overrides true
}

run_drift_repair_plan() {
  node scripts/marketing/build_limited_discount_drift_rescue_plan.mjs \
    --guard "$GUARD_OUT" \
    --out-dir "$ROOT/tmp/marketing-signup/limited-discount-fallback/target-price-drift-${DATE}" \
    --end-time "$(TZ="$TZ_NAME" date -d "$DATE +7 days" +%F) 23:59:59"
}

run_manual_special_restore_plan() {
  node scripts/marketing/build_manual_limited_discount_restore_plan.mjs \
    --guard "$GUARD_OUT" \
    --out-dir "$ROOT/tmp/marketing-signup/manual-limited-discount-restore/${DATE}"
}

run_high_click_special_plan() {
  node scripts/marketing/build_high_click_special_discount_plan.mjs \
    --date "$DATE" \
    --guard "$GUARD_OUT" \
    --out "$ROOT/outputs/reports/high-click-low-conversion-special-plan-${DATE}.json"
}

build_repair_queue() {
  node scripts/marketing/manage_marketing_repair_queue.mjs build \
    --date "$DATE" \
    --guard "$GUARD_OUT" \
    --high-click-plan "$ROOT/outputs/reports/high-click-low-conversion-special-plan-${DATE}.json" \
    --manual-plan "$ROOT/tmp/marketing-signup/manual-limited-discount-restore/${DATE}/manual-limited-discount-restore-plan.json" \
    --drift-plan-dir "$ROOT/tmp/marketing-signup/limited-discount-fallback/target-price-drift-${DATE}" \
    --fallback-plan "$ROOT/outputs/reports/new-listing-7d-limited-discount-plan-${DATE}.json" \
    --queue "$REPAIR_QUEUE_FILE"
}

prepare_marketing_price_leads() {
  node scripts/marketing/export_marketing_price_leads_for_bi.mjs \
    --require-fresh --out "$PRICE_LEADS_STAGE_FILE"
}

queue_json_value() {
  local expression="$1"
  local default_value="${2:-0}"
  JSON_FILE="$REPAIR_QUEUE_FILE" JSON_EXPR="$expression" JSON_DEFAULT="$default_value" node <<'NODE'
const fs = require('node:fs');
try {
  const j = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
  const value = new Function('j', `return (${process.env.JSON_EXPR});`)(j);
  console.log(value === undefined || value === null || Number.isNaN(value) ? process.env.JSON_DEFAULT : String(value));
} catch {
  console.log(process.env.JSON_DEFAULT);
}
NODE
}

on_shelf_limited_discount_plan_count() {
  local plan_file="$ROOT/outputs/reports/new-listing-7d-limited-discount-plan-${DATE}.json"
  PLAN_FILE="$plan_file" node <<'NODE'
const fs = require('node:fs');
try {
  const plan = JSON.parse(fs.readFileSync(process.env.PLAN_FILE, 'utf8'));
  console.log(Number(plan?.totals?.actionable || 0));
} catch {
  console.log(0);
}
NODE
}

sha256_file() {
  sha256sum "$1" | awk '{print tolower($1)}'
}

bind_marketing_cost_map() {
  if [[ -z "$MARKETING_COST_MAP_PATH" || "$MARKETING_COST_MAP_PATH" != /* || "$MARKETING_COST_MAP_PATH" == *$'\n'* || "$MARKETING_COST_MAP_PATH" == *$'\r'* ]]; then
    echo "[cloud_marketing_live_guard] ERROR marketing cost-map path must be absolute and single-line: $MARKETING_COST_MAP_PATH" >&2
    return 64
  fi
  if [[ ! -f "$MARKETING_COST_MAP_PATH" || -L "$MARKETING_COST_MAP_PATH" ]]; then
    echo "[cloud_marketing_live_guard] ERROR marketing cost-map must be a regular non-symlink file: $MARKETING_COST_MAP_PATH" >&2
    return 66
  fi
  local cost_hash
  if ! cost_hash="$(sha256_file "$MARKETING_COST_MAP_PATH")"; then
    echo "[cloud_marketing_live_guard] ERROR unable to hash marketing cost-map: $MARKETING_COST_MAP_PATH" >&2
    return 66
  fi
  if ! [[ "$cost_hash" =~ ^[a-f0-9]{64}$ ]]; then
    echo "[cloud_marketing_live_guard] ERROR marketing cost-map hash is not 64-hex: $cost_hash" >&2
    return 66
  fi
  MARKETING_COST_MAP_SHA256="${cost_hash,,}"
  echo "[cloud_marketing_live_guard] marketing cost-map bound path=$MARKETING_COST_MAP_PATH sha256=$MARKETING_COST_MAP_SHA256"
}

bind_current_run_evidence() {
  local scan_path="$1"
  local stack_review_path="$2"
  local binding
  if ! binding="$(RUN_SCAN_FILE="$scan_path" RUN_STACK_FILE="$stack_review_path" node <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function hashStableRegular(file, label) {
  if (!path.isAbsolute(file)) throw new Error(`${label} path must be absolute: ${file}`);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`${label} must be a regular non-symlink single-link file: ${file}`);
  }
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1
    || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`${label} changed while hashing: ${file}`);
  }
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

const scanPath = process.env.RUN_SCAN_FILE;
const stackPath = process.env.RUN_STACK_FILE;
const scanHash = hashStableRegular(scanPath, 'current run live scan');
const stackHash = hashStableRegular(stackPath, 'current run stack review');
process.stdout.write(`${scanPath}\n${scanHash}\n${stackPath}\n${stackHash}`);
NODE
)"; then
    echo "[cloud_marketing_live_guard] ERROR current run scan/stack evidence binding failed" >&2
    return 66
  fi
  local fields=()
  mapfile -t fields <<<"$binding"
  if [[ "${#fields[@]}" -ne 4 || -z "${fields[0]}" || -z "${fields[1]}" || -z "${fields[2]}" || -z "${fields[3]}" ]]; then
    echo "[cloud_marketing_live_guard] ERROR current run scan/stack evidence binding tuple is invalid" >&2
    return 66
  fi
  RUN_EVIDENCE_SCAN_PATH="${fields[0]}"
  RUN_EVIDENCE_SCAN_SHA256="${fields[1],,}"
  RUN_EVIDENCE_STACK_REVIEW_PATH="${fields[2]}"
  RUN_EVIDENCE_STACK_REVIEW_SHA256="${fields[3],,}"
  RUN_EVIDENCE_READY=1
}

read_repair_queue_pair() {
  local pair actual_guard_hash
  if ! pair="$(QUEUE_FILE="$REPAIR_QUEUE_FILE" node <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const queueFile = process.env.QUEUE_FILE;
const stat = fs.lstatSync(queueFile);
if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`repair queue must be a regular non-symlink file: ${queueFile}`);
const bytes = fs.readFileSync(queueFile);
const queue = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
const queueFingerprint = String(queue?.queueFingerprint || '').trim().toLowerCase();
const sourceGuardHash = String(queue?.sourceGuardHash || '').trim().toLowerCase();
if (!/^[a-f0-9]{64}$/.test(queueFingerprint) || !/^[a-f0-9]{64}$/.test(sourceGuardHash)) {
  throw new Error('repair queue queueFingerprint/sourceGuardHash must both be 64-hex SHA-256 values');
}
const queueStateSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
process.stdout.write(`${queueFingerprint}\n${sourceGuardHash}\n${queueStateSha256}`);
NODE
)"; then
    echo "[cloud_marketing_live_guard] ERROR generated repair queue pair is missing or invalid: $REPAIR_QUEUE_FILE" >&2
    return 66
  fi
  mapfile -t pair_fields <<<"$pair"
  if [[ "${#pair_fields[@]}" -ne 3 || -z "${pair_fields[0]}" || -z "${pair_fields[1]}" || -z "${pair_fields[2]}" ]]; then
    echo "[cloud_marketing_live_guard] ERROR generated repair queue pair is malformed: $REPAIR_QUEUE_FILE" >&2
    return 66
  fi
  REPAIR_QUEUE_FINGERPRINT="${pair_fields[0],,}"
  REPAIR_QUEUE_SOURCE_GUARD_HASH="${pair_fields[1],,}"
  REPAIR_QUEUE_STATE_SHA256="${pair_fields[2],,}"
  actual_guard_hash="$(sha256_file "$GUARD_OUT")" || return 66
  if [[ "$REPAIR_QUEUE_SOURCE_GUARD_HASH" != "$actual_guard_hash" ]]; then
    echo "[cloud_marketing_live_guard] ERROR generated repair queue source guard hash drift expected=$actual_guard_hash actual=$REPAIR_QUEUE_SOURCE_GUARD_HASH" >&2
    return 65
  fi
  echo "[cloud_marketing_live_guard] repair queue pair bound queueFingerprint=$REPAIR_QUEUE_FINGERPRINT sourceGuardHash=$REPAIR_QUEUE_SOURCE_GUARD_HASH queueStateSha256=$REPAIR_QUEUE_STATE_SHA256"
}

verify_marketing_plan_registry_preflight() {
  if [[ -z "$MARKETING_PLAN_REGISTRY_FILE" ]]; then
    echo "[cloud_marketing_live_guard] ERROR SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE is required; refuse unregistered tmp price material" >&2
    return 64
  fi
  local registry_hash
  if ! registry_hash="$(REGISTRY_FILE="$MARKETING_PLAN_REGISTRY_FILE" ROOT_DIR="$ROOT" node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root = process.env.ROOT_DIR;
const registryFile = path.resolve(process.env.REGISTRY_FILE);
const moduleUrl = pathToFileURL(path.join(root, 'lib', 'marketing_plan_registry.mjs')).href;
const {verifyMarketingPlanRegistrySync} = await import(moduleUrl);
const storesConfigPath = path.join(root, 'config', 'stores.json');
let expectedStoreKeys = [];
try {
  const stores = JSON.parse(fs.readFileSync(storesConfigPath, 'utf8'))?.stores || [];
  expectedStoreKeys = [...new Set(stores.filter(store => store?.enabled !== false)
    .map(store => String(store?.storeKey || '').trim().toUpperCase()).filter(Boolean))].sort();
  if (expectedStoreKeys.length !== 19) throw new Error(`expected exactly 19 enabled stores, got=${expectedStoreKeys.length}`);
} catch (error) {
  throw new Error(`stores config preflight failed: ${error.message}`);
}
const result = verifyMarketingPlanRegistrySync({
  registryFile,
  registryRoot: path.dirname(registryFile),
  expectedStoreKeys,
});
process.stdout.write(String(result.registryHash).toLowerCase());
NODE
)"; then
    echo "[cloud_marketing_live_guard] ERROR marketing plan registry preflight failed" >&2
    return 66
  fi
  if ! [[ "$registry_hash" =~ ^[A-Fa-f0-9]{64}$ ]]; then
    echo "[cloud_marketing_live_guard] ERROR registry preflight returned invalid hash: $registry_hash" >&2
    return 66
  fi
  CURRENT_REGISTRY_HASH="${registry_hash,,}"
  export SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE="$MARKETING_PLAN_REGISTRY_FILE"
  echo "[cloud_marketing_live_guard] registry preflight ok hash=$CURRENT_REGISTRY_HASH"
}

today_guard_already_ok() {
  local state_file="$ALERT_DIR/marketing-live-guard-last.json"
  STATE_FILE="$state_file" STATE_DATE="$DATE" node <<'NODE'
const fs = require('node:fs');
try {
  const state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8'));
  // Later timer slots are retries for a failed inspection, not another full
  // scan while the independent repair worker is consuming today's queue.
  console.log(state?.date === process.env.STATE_DATE && state?.status === 'ok' ? '1' : '0');
} catch {
  console.log('0');
}
NODE
}

upcoming_reserved_window() {
  local current_h current_m now_min best_delta=99999 best_name=""
  current_h="$(TZ="$TZ_NAME" date +%H)"
  current_m="$(TZ="$TZ_NAME" date +%M)"
  now_min=$((10#$current_h * 60 + 10#$current_m))

  consider_reserved_time() {
    local name="$1"
    local minute_of_day="$2"
    local delta
    if (( minute_of_day < now_min )); then
      delta=$((minute_of_day + 1440 - now_min))
    else
      delta=$((minute_of_day - now_min))
    fi
    if (( delta < best_delta )); then
      best_delta="$delta"
      best_name="$name"
    fi
  }

  local h
  for h in $(seq 0 23); do
    # ET forwarder runs on odd hours at :20 and uses its own headless/browser/API
    # resources. Do not let a full all-store marketing scan cross into it.
    if (( h % 2 == 1 )); then
      consider_reserved_time "et-forwarder:${h}:20" $((h * 60 + 20))
    fi
  done

  # Other write/heavy production windows.
  for h in $(seq 0 23); do
    # Today sales refresh now runs hourly, except 03:00 is reserved for
    # yesterday-final refresh and 08:00 is handled by morning-chain.
    if (( h != 3 && h != 8 )); then
      consider_reserved_time "today-refresh:${h}:00" $((h * 60))
    fi
  done
  consider_reserved_time "session-manager:02:20" $((2 * 60 + 20))
  consider_reserved_time "db-backup:02:40" $((2 * 60 + 40))
  consider_reserved_time "yesterday-refresh:03:00" $((3 * 60))
  consider_reserved_time "order-closure:06:30" $((6 * 60 + 30))
  consider_reserved_time "morning-chain:08:00" $((8 * 60))

  printf '%s %s\n' "$best_delta" "$best_name"
}

write_state() {
  local status="$1"
  local message="$2"
  local ok_flag="${3:-0}"
  mkdir -p "$STATE_DIR" "$ALERT_DIR"
  STATE_FILE="$ALERT_DIR/marketing-live-guard-last.json" \
  OK_STATE_FILE="$ALERT_DIR/marketing-live-guard-last-ok.json" \
  STATE_DATE="$DATE" \
  STATE_STATUS="$status" \
  STATE_MESSAGE="$message" \
  STATE_LOG_FILE="$LOG_FILE" \
  STATE_SCAN_FILE="${SCAN_OUT:-}" \
  STATE_GUARD_FILE="${GUARD_OUT:-}" \
  STATE_REPAIR_QUEUE_FILE="${REPAIR_QUEUE_FILE:-}" \
  STATE_COST_MAP_PATH="${MARKETING_COST_MAP_PATH:-}" \
  STATE_COST_MAP_SHA256="${MARKETING_COST_MAP_SHA256:-}" \
  STATE_RUN_EVIDENCE_READY="${RUN_EVIDENCE_READY:-0}" \
  STATE_RUN_SCAN_PATH="${RUN_EVIDENCE_SCAN_PATH:-}" \
  STATE_RUN_SCAN_SHA256="${RUN_EVIDENCE_SCAN_SHA256:-}" \
  STATE_RUN_STACK_REVIEW_PATH="${RUN_EVIDENCE_STACK_REVIEW_PATH:-}" \
  STATE_RUN_STACK_REVIEW_SHA256="${RUN_EVIDENCE_STACK_REVIEW_SHA256:-}" \
  STATE_REGISTRY_HASH="${CURRENT_REGISTRY_HASH:-}" \
  STATE_OK_FLAG="$ok_flag" \
  ROOT_DIR="$ROOT" \
  node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {writeJsonFileAtomic} = await import(pathToFileURL(path.join(process.env.ROOT_DIR, 'lib', 'atomic_file_publish.mjs')).href);
const state = {
  date: process.env.STATE_DATE,
  generatedAt: new Date().toISOString(),
  status: process.env.STATE_STATUS,
  message: process.env.STATE_MESSAGE,
  logFile: process.env.STATE_LOG_FILE,
  scanFile: process.env.STATE_SCAN_FILE || null,
  guardFile: process.env.STATE_GUARD_FILE || null,
  repairQueueFile: process.env.STATE_REPAIR_QUEUE_FILE || null,
  registryHash: process.env.STATE_REGISTRY_HASH || null,
  marketingCostMapSource: {
    path: process.env.STATE_COST_MAP_PATH || null,
    sha256: process.env.STATE_COST_MAP_SHA256 || null,
    verified: Boolean(process.env.STATE_COST_MAP_SHA256),
  },
  runEvidence: process.env.STATE_RUN_EVIDENCE_READY === '1' ? {
    scanPath: process.env.STATE_RUN_SCAN_PATH,
    scanSha256: process.env.STATE_RUN_SCAN_SHA256,
    stackReviewPath: process.env.STATE_RUN_STACK_REVIEW_PATH,
    stackReviewSha256: process.env.STATE_RUN_STACK_REVIEW_SHA256,
    verified: true,
  } : null,
};
try {
  const queue = JSON.parse(fs.readFileSync(process.env.STATE_REPAIR_QUEUE_FILE, 'utf8'));
  state.repairQueueStatus = queue.status || null;
  state.repairQueueCounts = queue.counts || null;
} catch {}
await writeJsonFileAtomic(process.env.STATE_FILE, state);
if (process.env.STATE_OK_FLAG === '1') {
  await writeJsonFileAtomic(process.env.OK_STATE_FILE, state);
}
NODE
  write_immutable_run_report "$status" "$message"
}

write_immutable_run_report() {
  local status="$1"
  local message="$2"
  RUN_REPORT_FILE="$RUN_REPORT_FILE" RUN_REPORT_STATUS="$status" RUN_REPORT_MESSAGE="$message" RUN_REPORT_DATE="$DATE" RUN_REPORT_ID="$RUN_ID" RUN_REPORT_LOG="$LOG_FILE" RUN_REPORT_REGISTRY_HASH="$CURRENT_REGISTRY_HASH" RUN_REPORT_COST_MAP_PATH="$MARKETING_COST_MAP_PATH" RUN_REPORT_COST_MAP_SHA256="$MARKETING_COST_MAP_SHA256" RUN_REPORT_RUN_EVIDENCE_READY="$RUN_EVIDENCE_READY" RUN_REPORT_RUN_SCAN_PATH="$RUN_EVIDENCE_SCAN_PATH" RUN_REPORT_RUN_SCAN_SHA256="$RUN_EVIDENCE_SCAN_SHA256" RUN_REPORT_RUN_STACK_REVIEW_PATH="$RUN_EVIDENCE_STACK_REVIEW_PATH" RUN_REPORT_RUN_STACK_REVIEW_SHA256="$RUN_EVIDENCE_STACK_REVIEW_SHA256" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const report = {
  date: process.env.RUN_REPORT_DATE,
  runId: process.env.RUN_REPORT_ID,
  generatedAt: new Date().toISOString(),
  status: process.env.RUN_REPORT_STATUS,
  message: process.env.RUN_REPORT_MESSAGE,
  logFile: process.env.RUN_REPORT_LOG,
  registryHash: process.env.RUN_REPORT_REGISTRY_HASH || null,
  marketingCostMapSource: {
    path: process.env.RUN_REPORT_COST_MAP_PATH || null,
    sha256: process.env.RUN_REPORT_COST_MAP_SHA256 || null,
    verified: Boolean(process.env.RUN_REPORT_COST_MAP_SHA256),
  },
  runEvidence: process.env.RUN_REPORT_RUN_EVIDENCE_READY === '1' ? {
    scanPath: process.env.RUN_REPORT_RUN_SCAN_PATH,
    scanSha256: process.env.RUN_REPORT_RUN_SCAN_SHA256,
    stackReviewPath: process.env.RUN_REPORT_RUN_STACK_REVIEW_PATH,
    stackReviewSha256: process.env.RUN_REPORT_RUN_STACK_REVIEW_SHA256,
    verified: true,
  } : null,
};
fs.mkdirSync(path.dirname(process.env.RUN_REPORT_FILE), {recursive: true});
try {
  fs.writeFileSync(process.env.RUN_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'});
} catch (error) {
  if (error?.code !== 'EEXIST') throw error;
}
NODE
}

on_error() {
  local line="$1"
  local status="$2"
  set +e
  release_marketing_artifact_publication_lock
  write_state "failed" "marketing live guard aborted at line=$line exit=$status" 0
  echo "[cloud_marketing_live_guard] ERROR aborted at line=$line exit=$status log=$LOG_FILE" >&2
  exit "$status"
}

on_signal() {
  local signal="$1"
  local status=143
  case "$signal" in
    INT) status=130 ;;
    TERM) status=143 ;;
    HUP) status=129 ;;
  esac
  set +e
  release_marketing_artifact_publication_lock
  write_state "interrupted" "marketing live guard interrupted by signal=$signal" 0
  echo "[cloud_marketing_live_guard] INTERRUPTED signal=$signal log=$LOG_FILE" >&2
  trap - ERR INT TERM HUP
  exit "$status"
}

mkdir -p "$LOG_DIR" "$STATE_DIR" "$ALERT_DIR"
DATE="$(resolve_today)"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
RUN_ID="${SHEIN_BI_MARKETING_LIVE_RUN_ID:-$(node -e 'console.log(require("node:crypto").randomUUID())')}"
LOG_FILE="$LOG_DIR/marketing-live-guard-${DATE}-${STAMP}.log"
SCAN_OUT="$ROOT/tmp/marketing-signup/current-price-live/current-marketing-price-live-${DATE}-${STAMP}.json"
GUARD_OUT="$ROOT/outputs/reports/marketing-daily-guard-${DATE}.json"
GUARD_STAGE_DIR="$STATE_DIR/report-staging/${DATE}/${RUN_ID}"
GUARD_INPUT_OUT="$GUARD_OUT"
PRICE_LEADS_FILE="${SHEIN_BI_MARKETING_PRICE_LEADS_FILE:-$ROOT/outputs/bi-portal/marketing-price-leads.json}"
PRICE_LEADS_STAGE_FILE="$GUARD_STAGE_DIR/marketing-price-leads.json"
RUN_REPORT_FILE="$STATE_DIR/reports/marketing-live-guard-${DATE}-${RUN_ID}.json"
REPAIR_QUEUE_FILE="$STATE_DIR/repair-queues/marketing-repair-${DATE}.json"

trap release_marketing_artifact_publication_lock EXIT

prepare_shared_lock_file "$LOCK_FILE"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[cloud_marketing_live_guard] another marketing live guard is running; skip"
  exit 0
fi

exec > >(tee -a "$LOG_FILE") 2>&1

trap 'on_error "$LINENO" "$?"' ERR
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP

cd "$ROOT"
echo "[cloud_marketing_live_guard] start date=$DATE runId=$RUN_ID root=$ROOT group=$GROUP"

if verify_marketing_plan_registry_preflight; then
  :
else
  REGISTRY_PREFLIGHT_STATUS=$?
  write_state "failed" "marketing plan registry preflight failed status=$REGISTRY_PREFLIGHT_STATUS" 0
  echo "[cloud_marketing_live_guard] ERROR marketing plan registry preflight failed status=$REGISTRY_PREFLIGHT_STATUS" >&2
  exit "$REGISTRY_PREFLIGHT_STATUS"
fi

if [[ "$FORCE_RERUN" != "1" && "$(today_guard_already_ok)" == "1" ]]; then
  echo "[cloud_marketing_live_guard] today already has a successful inspection; retry window exits without another scan or browser cleanup"
  exit 0
fi

if [[ "$GROUP" == "ALL" && "$IGNORE_RESERVED_WINDOW" != "1" ]]; then
  read -r NEXT_RESERVED_DELTA NEXT_RESERVED_NAME < <(upcoming_reserved_window)
  if [[ "$NEXT_RESERVED_DELTA" =~ ^[0-9]+$ && "$RESERVED_WINDOW_MINUTES" =~ ^[0-9]+$ && "$NEXT_RESERVED_DELTA" -le "$RESERVED_WINDOW_MINUTES" ]]; then
    write_state "skipped_upcoming_reserved_window" "next reserved window ${NEXT_RESERVED_NAME} starts in ${NEXT_RESERVED_DELTA}min; skip full live scan" 0
    echo "[cloud_marketing_live_guard] SKIP upcoming reserved window name=${NEXT_RESERVED_NAME} in=${NEXT_RESERVED_DELTA}min threshold=${RESERVED_WINDOW_MINUTES}min"
    exit 0
  fi
fi

echo "[cloud_marketing_live_guard] resource lane=${SHEIN_BI_HOST_RESOURCE_LANE:-api-light} (browserless; no heavy/browser lock)"
if wait_for_low_memory_capacity; then
  if [[ "$LOW_MEMORY_WAIT_ELAPSED_SEC" -gt 0 ]]; then
    echo "[cloud_marketing_live_guard] low memory recovered in ${LOW_MEMORY_WAIT_ELAPSED_SEC}s MemAvailable=${AVAILABLE_MEM}MiB threshold=${MIN_AVAILABLE_MEM_MIB}MiB; continuing same run"
  else
    echo "[cloud_marketing_live_guard] memory capacity ready MemAvailable=${AVAILABLE_MEM}MiB threshold=${MIN_AVAILABLE_MEM_MIB}MiB"
  fi
else
  LOW_MEMORY_WAIT_STATUS=$?
  if [[ "$LOW_MEMORY_WAIT_STATUS" -eq 1 ]]; then
    write_state "blocked_low_memory" "MemAvailable=${AVAILABLE_MEM}MiB remained below ${MIN_AVAILABLE_MEM_MIB}MiB after ${LOW_MEMORY_WAIT_ELAPSED_SEC:-$LOW_MEMORY_MAX_WAIT_SEC}s bounded wait" 0
    echo "[cloud_marketing_live_guard] BLOCKED low memory MemAvailable=${AVAILABLE_MEM}MiB threshold=${MIN_AVAILABLE_MEM_MIB}MiB wait=${LOW_MEMORY_MAX_WAIT_SEC}s; no scan was run" >&2
    exit 1
  fi
  write_state "failed" "low-memory capacity wait configuration failed status=${LOW_MEMORY_WAIT_STATUS}" 0
  echo "[cloud_marketing_live_guard] ERROR low-memory capacity wait failed status=$LOW_MEMORY_WAIT_STATUS" >&2
  exit "$LOW_MEMORY_WAIT_STATUS"
fi

# Both evidence collectors use session-manager cookie snapshots. Inspection is
# deliberately browserless: it must not acquire browser leases, launch Chrome,
# or clean profiles owned by unrelated tasks.
echo "[cloud_marketing_live_guard] browserless inspection via session HTTP"

COST_MAP_STATUS=0
STACK_REVIEW_STATUS=0
SCAN_STATUS=0
echo "[cloud_marketing_live_guard] refresh current marketing cost evidence"
if refresh_marketing_cost_map; then
  if bind_marketing_cost_map; then
    echo "[cloud_marketing_live_guard] marketing cost evidence refreshed"
  else
    COST_MAP_STATUS=$?
    echo "[cloud_marketing_live_guard] WARN marketing cost evidence binding returned status=$COST_MAP_STATUS" >&2
  fi
else
  COST_MAP_STATUS=$?
  echo "[cloud_marketing_live_guard] WARN marketing cost evidence returned status=$COST_MAP_STATUS" >&2
fi

# Ordinary marketing is the highest-priority layer. Refresh its full-store live
# evidence every day before evaluating limited-discount drift or fallback work.
# Session HTTP reuses the session-manager evidence and does not open browsers;
# the guard report below verifies 19/19 explicit store coverage and freshness.
echo "[cloud_marketing_live_guard] refresh ordinary marketing stack review via session HTTP"
if run_stage_with_retry "ordinary-stack-review" run_marketing_stack_review; then
  echo "[cloud_marketing_live_guard] ordinary marketing stack review refreshed"
else
  STACK_REVIEW_STATUS=$?
  echo "[cloud_marketing_live_guard] WARN ordinary marketing stack review returned status=$STACK_REVIEW_STATUS" >&2
fi

if run_stage_with_retry "limited-discount-live-scan" run_live_scan "$SCAN_OUT"; then
  echo "[cloud_marketing_live_guard] live scan done scan=$SCAN_OUT"
else
  SCAN_STATUS=$?
  echo "[cloud_marketing_live_guard] WARN live scan returned status=$SCAN_STATUS; keep partial evidence and continue guard" >&2
fi

if [[ "$STACK_REVIEW_STATUS" -eq 0 && "$SCAN_STATUS" -eq 0 ]]; then
  if bind_current_run_evidence "$SCAN_OUT" "$ROOT/outputs/reports/marketing-stack-review-${DATE}.json"; then
    echo "[cloud_marketing_live_guard] current run evidence bound scan=$RUN_EVIDENCE_SCAN_PATH scanSha256=$RUN_EVIDENCE_SCAN_SHA256 stackReview=$RUN_EVIDENCE_STACK_REVIEW_PATH stackReviewSha256=$RUN_EVIDENCE_STACK_REVIEW_SHA256"
  else
    RUN_EVIDENCE_BIND_STATUS=$?
    STACK_REVIEW_STATUS="$RUN_EVIDENCE_BIND_STATUS"
    SCAN_STATUS="$RUN_EVIDENCE_BIND_STATUS"
    echo "[cloud_marketing_live_guard] WARN current run evidence binding returned status=$RUN_EVIDENCE_BIND_STATUS" >&2
  fi
fi

BI_PUBLISH_STATUS=0

GUARD_STATUS=0
if run_stage_with_retry "guard-report" run_guard_report; then
  GUARD_INPUT_OUT="$GUARD_STAGE_DIR/marketing-daily-guard-${DATE}.json"
  if validate_guard_plan_binding "$GUARD_INPUT_OUT" "$CURRENT_REGISTRY_HASH"; then
    echo "[cloud_marketing_live_guard] guard report binding validated guard=$GUARD_INPUT_OUT registryHash=$GUARD_BOUND_REGISTRY_HASH priceOverridesHash=$GUARD_BOUND_PRICE_OVERRIDES_SHA256"
  else
    GUARD_STATUS=$?
    echo "[cloud_marketing_live_guard] WARN guard report binding returned status=$GUARD_STATUS" >&2
  fi
else
  GUARD_STATUS=$?
  echo "[cloud_marketing_live_guard] WARN guard report returned status=$GUARD_STATUS" >&2
fi

ON_SHELF_PLAN_STATUS=0
HIGH_CLICK_PLAN_STATUS=0
MANUAL_PLAN_STATUS=0
DRIFT_PLAN_STATUS=0
REPAIR_QUEUE_BUILD_STATUS=0
REPAIR_DEFERRED=0
REPAIR_TOTAL_ROWS=0
REPAIR_TOTAL_GROUPS=0
ORDINARY_LIVE_READY="$(guard_json_value '(j.marketingStackReviewCoverage?.coverageComplete === true && Number(j.marketingStackReviewFreshness?.activityAgeHours ?? 999999) <= Number(j.marketingStackReviewFreshness?.activityFreshnessThresholdHours ?? 48)) ? 1 : 0' 0)"
echo "[cloud_marketing_live_guard] ordinary live evidence ready=$ORDINARY_LIVE_READY stackReviewStatus=$STACK_REVIEW_STATUS"
GUARD_PUBLICATION_STATUS=0
PRICE_LEADS_PREP_STATUS=75
if [[ "$COST_MAP_STATUS" -eq 0 && "$STACK_REVIEW_STATUS" -eq 0 && "$ORDINARY_LIVE_READY" -eq 1 && "$SCAN_STATUS" -eq 0 ]]; then
  PRICE_LEADS_PREP_STATUS=0
  echo "[cloud_marketing_live_guard] prepare marketing price leads before shared publication lock"
  if prepare_marketing_price_leads; then
    echo "[cloud_marketing_live_guard] marketing price leads prepared stage=$PRICE_LEADS_STAGE_FILE"
  else
    PRICE_LEADS_PREP_STATUS=$?
    echo "[cloud_marketing_live_guard] WARN marketing price leads preparation returned status=$PRICE_LEADS_PREP_STATUS" >&2
  fi
fi
if [[ "$GUARD_STATUS" -eq 0 ]]; then
  if acquire_marketing_artifact_publication_lock; then
    if publish_staged_guard_report; then
      GUARD_INPUT_OUT="$GUARD_OUT"
      if [[ "$COST_MAP_STATUS" -eq 0 && "$STACK_REVIEW_STATUS" -eq 0 && "$ORDINARY_LIVE_READY" -eq 1 && "$SCAN_STATUS" -eq 0 ]]; then
        if [[ "$BUILD_REPAIR_QUEUE" == "1" ]]; then
          HIGH_CLICK_ACTION_COUNT="$(guard_json_value 'Number(j.highClickLowConversionSpecial?.actionCount || 0)' 0)"
          echo "[cloud_marketing_live_guard] build high-click low-conversion protected special-discount plan"
          if run_high_click_special_plan; then
            echo "[cloud_marketing_live_guard] high-click special plan ready actions=$HIGH_CLICK_ACTION_COUNT"
          else
            HIGH_CLICK_PLAN_STATUS=$?
            REPAIR_QUEUE_BUILD_STATUS=90
            echo "[cloud_marketing_live_guard] WARN high-click special plan returned status=$HIGH_CLICK_PLAN_STATUS" >&2
          fi
          DRIFT_BELOW_COUNT="$(guard_json_value '(j.limitedDiscountTargetPriceDrift?.belowRows || []).length' 0)"
          GUARD_NEW_LISTING_EXEC_COUNT="$(guard_json_value '(j.newSkcCandidates?.newListingWithin7DaysLimitedDiscount?.executableActionCount || 0)' 0)"
          NEW_LISTING_EXEC_COUNT="$GUARD_NEW_LISTING_EXEC_COUNT"
          echo "[cloud_marketing_live_guard] build complete-live-scan diff for all on-shelf limited-discount gaps"
          if run_on_shelf_limited_discount_plan; then
            ON_SHELF_PLAN_COUNT="$(on_shelf_limited_discount_plan_count)"
            if [[ "$ON_SHELF_PLAN_COUNT" =~ ^[0-9]+$ && "$ON_SHELF_PLAN_COUNT" -gt "$NEW_LISTING_EXEC_COUNT" ]]; then
              NEW_LISTING_EXEC_COUNT="$ON_SHELF_PLAN_COUNT"
            fi
            echo "[cloud_marketing_live_guard] all-on-shelf limited-discount plan actionable=$ON_SHELF_PLAN_COUNT"
          else
            ON_SHELF_PLAN_STATUS=$?
            if [[ "$REPAIR_QUEUE_BUILD_STATUS" -eq 0 ]]; then
              REPAIR_QUEUE_BUILD_STATUS="$ON_SHELF_PLAN_STATUS"
            fi
            echo "[cloud_marketing_live_guard] WARN all-on-shelf limited-discount plan returned status=$ON_SHELF_PLAN_STATUS" >&2
          fi
          MANUAL_SPECIAL_RESTORE_COUNT="$(guard_json_value 'Number(j.manualSpecialLimitedDiscount?.actionCount || 0)' 0)"
          if [[ "$MANUAL_SPECIAL_RESTORE_COUNT" =~ ^[0-9]+$ && "$MANUAL_SPECIAL_RESTORE_COUNT" -gt 0 ]]; then
            echo "[cloud_marketing_live_guard] build exact current-run manual-special restore manifest"
            if run_manual_special_restore_plan; then
              echo "[cloud_marketing_live_guard] exact manual-special restore manifest ready"
            else
              MANUAL_PLAN_STATUS=$?
              REPAIR_QUEUE_BUILD_STATUS=91
              echo "[cloud_marketing_live_guard] WARN manual-special restore plan returned status=$MANUAL_PLAN_STATUS" >&2
            fi
          fi
          if [[ "$ON_SHELF_PLAN_STATUS" -eq 0 && "$DRIFT_BELOW_COUNT" =~ ^[0-9]+$ && "$DRIFT_BELOW_COUNT" -gt 0 ]]; then
            echo "[cloud_marketing_live_guard] build exact current-run drift repair manifest"
            if run_drift_repair_plan; then
              echo "[cloud_marketing_live_guard] exact drift repair manifest ready"
            else
              DRIFT_PLAN_STATUS=$?
              REPAIR_QUEUE_BUILD_STATUS=92
              echo "[cloud_marketing_live_guard] WARN drift repair plan returned status=$DRIFT_PLAN_STATUS" >&2
            fi
          fi
        else
          echo "[cloud_marketing_live_guard] repair queue build disabled"
        fi
        if [[ "$HIGH_CLICK_PLAN_STATUS" -eq 0 && "$ON_SHELF_PLAN_STATUS" -eq 0 && "$MANUAL_PLAN_STATUS" -eq 0 && "$DRIFT_PLAN_STATUS" -eq 0 ]]; then
          if [[ "$BUILD_REPAIR_QUEUE" != "1" ]]; then
            :
          else
            FINAL_GUARD_REBUILD_STATUS=0
            if rebuild_final_guard_report_after_repair_plans; then
              echo "[cloud_marketing_live_guard] rebind high-click special plan to final canonical guard before queue build"
              if run_high_click_special_plan; then
                echo "[cloud_marketing_live_guard] high-click special plan rebound to final canonical guard"
                if build_repair_queue; then
                  REPAIR_TOTAL_ROWS="$(queue_json_value 'Number(j.counts?.totalRows || 0)' 0)"
                  REPAIR_TOTAL_GROUPS="$(queue_json_value 'Number(j.counts?.totalGroups || 0)' 0)"
                  if read_repair_queue_pair; then
                    :
                  else
                    REPAIR_QUEUE_BUILD_STATUS=$?
                    echo "[cloud_marketing_live_guard] WARN generated repair queue pair validation returned status=$REPAIR_QUEUE_BUILD_STATUS" >&2
                  fi
                  if [[ "$REPAIR_QUEUE_BUILD_STATUS" -eq 0 && "$REPAIR_TOTAL_ROWS" =~ ^[0-9]+$ && "$REPAIR_TOTAL_ROWS" -gt 0 ]]; then
                    REPAIR_DEFERRED=1
                    if node scripts/marketing/manage_marketing_repair_queue.mjs handoff-local \
                      --queue "$REPAIR_QUEUE_FILE" \
                      --expected-queue-fingerprint "$REPAIR_QUEUE_FINGERPRINT" \
                      --expected-source-guard-hash "$REPAIR_QUEUE_SOURCE_GUARD_HASH" \
                      --expected-queue-state-sha256 "$REPAIR_QUEUE_STATE_SHA256" \
                      --reason "cloud marketing writes are disabled; preserve the exact queue for local controlled execution"; then
                      echo "[cloud_marketing_live_guard] repair workload queued rows=$REPAIR_TOTAL_ROWS groups=$REPAIR_TOTAL_GROUPS; cloud inspection is complete and all writes are handed to local controlled execution"
                    else
                      HANDOFF_STATUS=$?
                      REPAIR_QUEUE_BUILD_STATUS="$HANDOFF_STATUS"
                      REPAIR_DEFERRED=0
                      echo "[cloud_marketing_live_guard] WARN repair queue handoff returned status=$HANDOFF_STATUS" >&2
                    fi
                  fi
                else
                  REPAIR_QUEUE_BUILD_STATUS=$?
                  echo "[cloud_marketing_live_guard] WARN repair queue build returned status=$REPAIR_QUEUE_BUILD_STATUS" >&2
                fi
              else
                HIGH_CLICK_PLAN_STATUS=$?
                REPAIR_QUEUE_BUILD_STATUS="$HIGH_CLICK_PLAN_STATUS"
                echo "[cloud_marketing_live_guard] WARN repair queue skipped because final high-click plan rebind failed status=$REPAIR_QUEUE_BUILD_STATUS" >&2
              fi
            else
              FINAL_GUARD_REBUILD_STATUS=$?
              REPAIR_QUEUE_BUILD_STATUS="$FINAL_GUARD_REBUILD_STATUS"
              echo "[cloud_marketing_live_guard] WARN repair queue skipped because final guard rebuild failed status=$REPAIR_QUEUE_BUILD_STATUS" >&2
            fi
          fi
        fi
        echo "[cloud_marketing_live_guard] action check highClickSpecial=$HIGH_CLICK_ACTION_COUNT manualSpecialRestore=$MANUAL_SPECIAL_RESTORE_COUNT driftBelow=$DRIFT_BELOW_COUNT limitedFallbackExecutable=$NEW_LISTING_EXEC_COUNT deferred=$REPAIR_DEFERRED"
        echo "[cloud_marketing_live_guard] inspection phase complete; no SHEIN mutation is executed in this service. The exact hashed queue is consumed only by shein-bi-cloud-marketing-repair.service."
        if [[ "$BUILD_REPAIR_QUEUE" == "1" && "$REPAIR_QUEUE_BUILD_STATUS" -ne 0 ]]; then
          BI_PUBLISH_STATUS=75
          echo "[cloud_marketing_live_guard] BI portal publish skipped because repair queue preparation failed status=$REPAIR_QUEUE_BUILD_STATUS" >&2
        elif [[ "$PRICE_LEADS_PREP_STATUS" -ne 0 ]]; then
          BI_PUBLISH_STATUS=75
          echo "[cloud_marketing_live_guard] BI portal publish skipped because marketing price leads preparation failed status=$PRICE_LEADS_PREP_STATUS" >&2
        else
          echo "[cloud_marketing_live_guard] publish complete marketing live snapshot to BI portal queue"
          if SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_HELD=1 \
            SHEIN_BI_MARKETING_BI_PUBLISH_DATE="$DATE" \
            SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_FILE="$ARTIFACT_PUBLICATION_LOCK_FILE" \
            SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_WAIT_SEC="$ARTIFACT_PUBLICATION_LOCK_WAIT_SEC" \
            SHEIN_BI_MARKETING_PRICE_LEADS_FILE="$PRICE_LEADS_FILE" \
            SHEIN_BI_MARKETING_PRICE_LEADS_STAGE_FILE="$PRICE_LEADS_STAGE_FILE" \
            SHEIN_BI_MARKETING_PRICE_LEADS_PREPARED=1 \
            bash scripts/publish_marketing_price_leads_to_bi.sh; then
            echo "[cloud_marketing_live_guard] BI portal publish done"
          else
            BI_PUBLISH_STATUS=$?
            echo "[cloud_marketing_live_guard] WARN BI portal publish returned status=$BI_PUBLISH_STATUS" >&2
          fi
        fi
      else
        BI_PUBLISH_STATUS=75
        echo "[cloud_marketing_live_guard] BI portal publish skipped because evidence is incomplete stackReviewStatus=$STACK_REVIEW_STATUS ordinaryLiveReady=$ORDINARY_LIVE_READY liveScanStatus=$SCAN_STATUS" >&2
      fi
    else
      GUARD_PUBLICATION_STATUS=$?
      echo "[cloud_marketing_live_guard] WARN staged guard report publication returned status=$GUARD_PUBLICATION_STATUS" >&2
    fi
    release_marketing_artifact_publication_lock
  else
    GUARD_PUBLICATION_STATUS=$?
    BI_PUBLISH_STATUS=75
    REPAIR_QUEUE_BUILD_STATUS=75
    echo "[cloud_marketing_live_guard] WARN artifact publication lock unavailable status=$GUARD_PUBLICATION_STATUS" >&2
  fi
else
  GUARD_PUBLICATION_STATUS="$GUARD_STATUS"
  BI_PUBLISH_STATUS=75
  REPAIR_QUEUE_BUILD_STATUS=75
  echo "[cloud_marketing_live_guard] WARN fixed guard report publication skipped because guard report status=$GUARD_STATUS" >&2
fi

if [[ "$COST_MAP_STATUS" -eq 0 && "$STACK_REVIEW_STATUS" -eq 0 && "$ORDINARY_LIVE_READY" -eq 1 && "$SCAN_STATUS" -eq 0 && "$GUARD_STATUS" -eq 0 && "$GUARD_PUBLICATION_STATUS" -eq 0 && "$HIGH_CLICK_PLAN_STATUS" -eq 0 && "$ON_SHELF_PLAN_STATUS" -eq 0 && "$MANUAL_PLAN_STATUS" -eq 0 && "$DRIFT_PLAN_STATUS" -eq 0 && "$REPAIR_QUEUE_BUILD_STATUS" -eq 0 && "$BI_PUBLISH_STATUS" -eq 0 ]]; then
  write_state "ok" "marketing inspection completed; repairDeferred=$REPAIR_DEFERRED" 1
  if [[ "$REPAIR_TOTAL_ROWS" -eq 0 ]]; then
    node scripts/marketing/send_marketing_daily_group_report.mjs \
      --date "$DATE" --queue "$REPAIR_QUEUE_FILE" --guard "$GUARD_OUT" \
      || echo "[cloud_marketing_live_guard] WARN group report delivery failed" >&2
  else
    echo "[cloud_marketing_live_guard] final group report waits for the same-day repair queue terminal state; no intermediate report sent"
  fi
  echo "[cloud_marketing_live_guard] done ok date=$DATE log=$LOG_FILE"
else
  write_state "warning" "costMap=$COST_MAP_STATUS stackReview=$STACK_REVIEW_STATUS ordinaryLiveReady=$ORDINARY_LIVE_READY liveScan=$SCAN_STATUS guard=$GUARD_STATUS guardPublication=$GUARD_PUBLICATION_STATUS highClickPlan=$HIGH_CLICK_PLAN_STATUS onShelfPlan=$ON_SHELF_PLAN_STATUS manualPlan=$MANUAL_PLAN_STATUS driftPlan=$DRIFT_PLAN_STATUS repairQueue=$REPAIR_QUEUE_BUILD_STATUS biPublish=$BI_PUBLISH_STATUS" 0
  echo "[cloud_marketing_live_guard] done warning costMapStatus=$COST_MAP_STATUS stackReviewStatus=$STACK_REVIEW_STATUS ordinaryLiveReady=$ORDINARY_LIVE_READY scanStatus=$SCAN_STATUS guardStatus=$GUARD_STATUS guardPublicationStatus=$GUARD_PUBLICATION_STATUS highClickPlanStatus=$HIGH_CLICK_PLAN_STATUS onShelfPlanStatus=$ON_SHELF_PLAN_STATUS manualPlanStatus=$MANUAL_PLAN_STATUS driftPlanStatus=$DRIFT_PLAN_STATUS repairQueueStatus=$REPAIR_QUEUE_BUILD_STATUS biPublishStatus=$BI_PUBLISH_STATUS log=$LOG_FILE" >&2
  exit 1
fi
