#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
source "$ROOT/scripts/lib/shared_lock.sh"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
DATE="${SHEIN_BI_MARKETING_REPAIR_DATE:-$(TZ="$TZ_NAME" date +%F)}"
LOG_DIR="${SHEIN_BI_MARKETING_REPAIR_LOG_DIR:-/srv/shein-bi/logs/cloud-marketing-repair}"
STATE_DIR="${SHEIN_BI_MARKETING_LIVE_STATE_DIR:-$ROOT/state/cloud_marketing_live_guard}"
ALERT_DIR="$ROOT/state/cloud_ops_alerts"
QUEUE_FILE="$STATE_DIR/repair-queues/marketing-repair-${DATE}.json"
LOCK_FILE="${SHEIN_BI_MARKETING_REPAIR_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-marketing-repair.lock}"
ARTIFACT_PUBLICATION_LOCK_FILE="${SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-marketing-artifact-publication.lock}"
ARTIFACT_PUBLICATION_LOCK_WAIT_SEC="${SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_WAIT_SEC:-30}"
GUARD_OUT="$ROOT/outputs/reports/marketing-daily-guard-${DATE}.json"
GUARD_INPUT_OUT="$GUARD_OUT"
MARKETING_PLAN_REGISTRY_FILE="${SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE:-/srv/shein-bi/runtime/marketing-plans/current.json}"
export SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE="$MARKETING_PLAN_REGISTRY_FILE"
MARKETING_PLAN_REGISTRY_ROOT="${SHEIN_BI_MARKETING_PLAN_REGISTRY_ROOT:-$(dirname -- "$MARKETING_PLAN_REGISTRY_FILE")}"
REGISTRY_PUBLISH_LOCK_DIR="$MARKETING_PLAN_REGISTRY_ROOT/.publish.lock"
MARKETING_COST_MAP_PATH="${SHEIN_BI_MARKETING_COST_MAP_PATH:-${SHEIN_BI_MARKETING_LIVE_COST_MAP_PATH:-$ROOT/tmp/mbrs/marketing-cost-map.json}}"
GUARD_STAGE_DIR=""
LEASE_TASK="${SHEIN_BI_MARKETING_REPAIR_LEASE_TASK:-cloud-marketing-repair}"
LEASE_TTL_SEC="${SHEIN_BI_MARKETING_REPAIR_LEASE_TTL_SEC:-3000}"
LEASE_ACQUIRED=0
MAX_GROUPS="${SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS:-32}"
AUTOMATION_CONTEXT="${SHEIN_BI_MARKETING_AUTOMATION_CONTEXT:-}"
EXECUTION_LOCATION="${SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION:-cloud}"
CLOUD_FALLBACK_ENABLED="${SHEIN_BI_MARKETING_CLOUD_FALLBACK_ENABLED:-false}"
FALLBACK_MIN_START_BUDGET_SEC="${SHEIN_BI_MARKETING_REPAIR_MIN_START_BUDGET_SEC:-900}"
FALLBACK_GRACEFUL_CUTOFF_EPOCH="${SHEIN_BI_MARKETING_REPAIR_GRACEFUL_CUTOFF_EPOCH:-}"
FALLBACK_OUTER_HARD_DEADLINE_EPOCH="${SHEIN_BI_MARKETING_REPAIR_SLOT_HARD_DEADLINE_EPOCH:-}"
IS_CLOUD_EXECUTION=1
if [[ "$EXECUTION_LOCATION" == "local" && "$ROOT" != "/opt/shein-bi/app" ]]; then
  IS_CLOUD_EXECUTION=0
fi

if (( IS_CLOUD_EXECUTION == 1 )); then
  if [[ ! "$MAX_GROUPS" =~ ^[1-9][0-9]*$ ]] || (( MAX_GROUPS > 32 )); then
    echo "[cloud_marketing_repair] ERROR cloud max groups must be an integer from 1 through 32: $MAX_GROUPS" >&2
    exit 64
  fi
fi
SCAN_TIMEOUT_SEC="${SHEIN_BI_MARKETING_LIVE_SCAN_TIMEOUT_SEC:-2400}"
SCAN_KILL_AFTER_SEC="${SHEIN_BI_MARKETING_LIVE_SCAN_KILL_AFTER_SEC:-60}"
STACK_REVIEW_TIMEOUT_SEC="${SHEIN_BI_MARKETING_STACK_REVIEW_TIMEOUT_SEC:-900}"
STACK_REVIEW_KILL_AFTER_SEC="${SHEIN_BI_MARKETING_STACK_REVIEW_KILL_AFTER_SEC:-60}"
GUARD_MAX_AGE_HOURS="${SHEIN_BI_MARKETING_LIVE_GUARD_MAX_AGE_HOURS:-96}"
GUARD_CLOUD_BI_SSH="${SHEIN_BI_MARKETING_LIVE_CLOUD_BI_SSH:-local}"
GUARD_CLOUD_BI_ROOT="${SHEIN_BI_MARKETING_LIVE_CLOUD_BI_ROOT:-$ROOT}"
BUSY_SERVICES="${SHEIN_BI_MARKETING_REPAIR_BUSY_SERVICES:-shein-bi-cloud-marketing-live-guard.service shein-bi-cloud-today.service shein-bi-cloud-yesterday.service shein-bi-cloud-et-forwarder.service shein-bi-cloud-daily-refresh.service shein-bi-cloud-session-manager.service shein-bi-cloud-morning-chain.service shein-bi-cloud-order-closure.service shein-bi-db-backup.service}"
ARTIFACT_PUBLICATION_LOCK_ACQUIRED=0
REGISTRY_PUBLISH_LOCK_ACQUIRED=0
QUEUE_MUTATION_LOCK_HELD=0
REPAIR_ARTIFACT_REGISTRY_LOCKS_HELD=0
STAGE_CRITICAL_SECTION_HELD=0
QUEUE_MUTATION_LOCK_TOKEN=""
QUEUE_MUTATION_LOCK_DIR="$QUEUE_FILE.mutation.lock"
QUEUE_EXPECTED_FINGERPRINT=""
QUEUE_EXPECTED_SOURCE_GUARD_HASH=""
QUEUE_EXPECTED_STATE_SHA256=""
QUEUE_ACTUAL_FINGERPRINT=""
QUEUE_ACTUAL_SOURCE_GUARD_HASH=""
QUEUE_ACTUAL_STATE_SHA256=""
QUEUE_CONFLICT_STATUS=73
QUEUE_CONFLICT_DETAIL=""
GUARD_BOUND_PRICE_OVERRIDES_PATH=""
GUARD_BOUND_PRICE_OVERRIDES_SHA256=""
GUARD_BOUND_REGISTRY_HASH=""
GUARD_BOUND_MARKETING_COST_MAP_PATH=""
GUARD_BOUND_MARKETING_COST_MAP_SHA256=""
CURRENT_REGISTRY_HASH=""
MARKETING_COST_MAP_SHA256=""

release_marketing_artifact_publication_lock() {
  if [[ "$ARTIFACT_PUBLICATION_LOCK_ACQUIRED" == "1" ]]; then
    flock -u 8 2>/dev/null || true
    exec 8>&-
    ARTIFACT_PUBLICATION_LOCK_ACQUIRED=0
  fi
}

acquire_marketing_artifact_publication_lock() {
  if ! [[ "$ARTIFACT_PUBLICATION_LOCK_WAIT_SEC" =~ ^[0-9]+$ ]] || (( ARTIFACT_PUBLICATION_LOCK_WAIT_SEC >= 1800 )); then
    echo "[cloud_marketing_repair] ERROR invalid artifact publication lock wait: $ARTIFACT_PUBLICATION_LOCK_WAIT_SEC" >&2
    return 64
  fi
  prepare_shared_lock_file "$ARTIFACT_PUBLICATION_LOCK_FILE"
  exec 8<>"$ARTIFACT_PUBLICATION_LOCK_FILE"
  if ! flock -w "$ARTIFACT_PUBLICATION_LOCK_WAIT_SEC" 8; then
    echo "[cloud_marketing_repair] artifact publication lock busy: $ARTIFACT_PUBLICATION_LOCK_FILE" >&2
    exec 8>&-
    return 75
  fi
  ARTIFACT_PUBLICATION_LOCK_ACQUIRED=1
}

# Cross-process lock order is fixed and must not be inverted:
#   artifact publication lock -> registry-root/.publish.lock -> queue mutation lock
# The registry publisher owns the non-reclaimable directory lock itself. This
# worker never inspects its age or removes it blindly.
release_marketing_plan_registry_publish_lock() {
  local status=0
  if [[ "$REGISTRY_PUBLISH_LOCK_ACQUIRED" == "1" ]]; then
    if [[ -d "$REGISTRY_PUBLISH_LOCK_DIR" ]]; then
      if ! rmdir -- "$REGISTRY_PUBLISH_LOCK_DIR"; then
        echo "[cloud_marketing_repair] ERROR registry publish lock could not be released: $REGISTRY_PUBLISH_LOCK_DIR" >&2
        status=75
      else
        REGISTRY_PUBLISH_LOCK_ACQUIRED=0
      fi
    elif [[ -e "$REGISTRY_PUBLISH_LOCK_DIR" ]]; then
      echo "[cloud_marketing_repair] ERROR registry publish lock path is not a removable directory: $REGISTRY_PUBLISH_LOCK_DIR" >&2
      status=75
    else
      REGISTRY_PUBLISH_LOCK_ACQUIRED=0
    fi
  fi
  return "$status"
}

acquire_marketing_plan_registry_publish_lock() {
  if [[ -z "$MARKETING_PLAN_REGISTRY_ROOT" || "$MARKETING_PLAN_REGISTRY_ROOT" != /* || "$MARKETING_PLAN_REGISTRY_ROOT" == *$'\n'* || "$MARKETING_PLAN_REGISTRY_ROOT" == *$'\r'* ]]; then
    echo "[cloud_marketing_repair] ERROR registry root must be absolute and single-line: $MARKETING_PLAN_REGISTRY_ROOT" >&2
    return 64
  fi
  if [[ "$REGISTRY_PUBLISH_LOCK_ACQUIRED" == "1" ]]; then
    return 0
  fi
  if ! mkdir -- "$REGISTRY_PUBLISH_LOCK_DIR" 2>/dev/null; then
    if [[ -e "$REGISTRY_PUBLISH_LOCK_DIR" ]]; then
      echo "[cloud_marketing_repair] registry publish lock already held; fail closed: $REGISTRY_PUBLISH_LOCK_DIR" >&2
      return 75
    fi
    echo "[cloud_marketing_repair] ERROR registry publish lock could not be acquired: $REGISTRY_PUBLISH_LOCK_DIR" >&2
    return 66
  fi
  REGISTRY_PUBLISH_LOCK_ACQUIRED=1
}

release_repair_queue_mutation_lock() {
  local status=0
  if [[ "$QUEUE_MUTATION_LOCK_HELD" == "1" ]]; then
    if node scripts/marketing/manage_marketing_repair_queue.mjs release-lock \
        --queue "$QUEUE_FILE" --queue-lock-token "$QUEUE_MUTATION_LOCK_TOKEN" >/dev/null; then
      QUEUE_MUTATION_LOCK_HELD=0
      QUEUE_MUTATION_LOCK_TOKEN=""
    else
      echo "[cloud_marketing_repair] ERROR queue mutation lock could not be released: $QUEUE_MUTATION_LOCK_DIR" >&2
      status=75
    fi
  fi
  return "$status"
}

acquire_repair_queue_mutation_lock() {
  if [[ "$QUEUE_MUTATION_LOCK_HELD" == "1" ]]; then
    return 0
  fi
  if QUEUE_MUTATION_LOCK_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"; then
    :
  else
    echo "[cloud_marketing_repair] ERROR unable to create queue mutation lock token" >&2
    return 66
  fi
  local lock_output
  if ! lock_output="$(node scripts/marketing/manage_marketing_repair_queue.mjs acquire-lock \
      --queue "$QUEUE_FILE" --queue-lock-token "$QUEUE_MUTATION_LOCK_TOKEN")"; then
    echo "$lock_output" >&2
    QUEUE_MUTATION_LOCK_TOKEN=""
    return 75
  fi
  echo "$lock_output"
  QUEUE_MUTATION_LOCK_HELD=1
}

release_repair_artifact_registry_locks() {
  local status=0 registry_released=0 artifact_released=0
  if [[ "$REPAIR_ARTIFACT_REGISTRY_LOCKS_HELD" == "1" ]]; then
    if release_marketing_plan_registry_publish_lock; then
      registry_released=1
    else
      status=75
    fi
    if release_marketing_artifact_publication_lock; then
      artifact_released=1
    else
      status=75
    fi
    if [[ "$registry_released" == "1" && "$artifact_released" == "1" ]]; then
      REPAIR_ARTIFACT_REGISTRY_LOCKS_HELD=0
    fi
  fi
  return "$status"
}

acquire_repair_artifact_registry_locks() {
  if [[ "$REPAIR_ARTIFACT_REGISTRY_LOCKS_HELD" == "1" ]]; then
    return 0
  fi
  local status=0
  if acquire_marketing_artifact_publication_lock; then
    :
  else
    return $?
  fi
  if acquire_marketing_plan_registry_publish_lock; then
    :
  else
    status=$?
    release_marketing_artifact_publication_lock || true
    return "$status"
  fi
  REPAIR_ARTIFACT_REGISTRY_LOCKS_HELD=1
}

release_repair_critical_locks() {
  local status=0
  if ! release_repair_queue_mutation_lock; then
    status=75
  fi
  if ! release_repair_artifact_registry_locks; then
    status=75
  fi
  STAGE_CRITICAL_SECTION_HELD=0
  return "$status"
}

acquire_repair_critical_locks() {
  if [[ "$STAGE_CRITICAL_SECTION_HELD" == "1" ]]; then
    return 0
  fi
  if acquire_repair_artifact_registry_locks; then
    :
  else
    return $?
  fi
  if acquire_repair_queue_mutation_lock; then
    :
  else
    local status=$?
    release_repair_artifact_registry_locks || true
    return "$status"
  fi
  STAGE_CRITICAL_SECTION_HELD=1
}

sha256_regular_file() {
  local file="$1"
  if ! FILE_PATH="$file" node <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const raw = String(process.env.FILE_PATH || '');
if (!raw || /[\r\n]/.test(raw) || !path.isAbsolute(raw)) {
  throw new Error(`file path must be an absolute single-line path: ${raw || 'missing'}`);
}
const file = path.resolve(raw);
const stat = fs.lstatSync(file);
if (!stat.isFile() || stat.isSymbolicLink()) {
  throw new Error(`file must be a regular non-symlink file: ${file}`);
}
process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
NODE
  then
    return 66
  fi
}

bind_marketing_cost_map() {
  if [[ -z "$MARKETING_COST_MAP_PATH" || "$MARKETING_COST_MAP_PATH" != /* || "$MARKETING_COST_MAP_PATH" == *$'\n'* || "$MARKETING_COST_MAP_PATH" == *$'\r'* ]]; then
    echo "[cloud_marketing_repair] ERROR marketing cost-map path must be absolute and single-line: $MARKETING_COST_MAP_PATH" >&2
    return 64
  fi
  local cost_hash
  if ! cost_hash="$(sha256_regular_file "$MARKETING_COST_MAP_PATH")"; then
    echo "[cloud_marketing_repair] ERROR unable to hash marketing cost-map: $MARKETING_COST_MAP_PATH" >&2
    return 66
  fi
  if ! [[ "$cost_hash" =~ ^[a-f0-9]{64}$ ]]; then
    echo "[cloud_marketing_repair] ERROR marketing cost-map hash is invalid: $cost_hash" >&2
    return 66
  fi
  MARKETING_COST_MAP_SHA256="${cost_hash,,}"
  echo "[cloud_marketing_repair] marketing cost-map bound path=$MARKETING_COST_MAP_PATH sha256=$MARKETING_COST_MAP_SHA256"
}

verify_current_marketing_plan_registry() {
  if [[ -z "$MARKETING_PLAN_REGISTRY_FILE" || "$MARKETING_PLAN_REGISTRY_FILE" != /* || "$MARKETING_PLAN_REGISTRY_FILE" == *$'\n'* || "$MARKETING_PLAN_REGISTRY_FILE" == *$'\r'* ]]; then
    echo "[cloud_marketing_repair] ERROR managed marketing plan registry path must be absolute and single-line: $MARKETING_PLAN_REGISTRY_FILE" >&2
    return 64
  fi
  local registry_hash
  if ! registry_hash="$(REGISTRY_FILE="$MARKETING_PLAN_REGISTRY_FILE" REGISTRY_ROOT="$MARKETING_PLAN_REGISTRY_ROOT" ROOT_DIR="$ROOT" node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = path.resolve(process.env.ROOT_DIR);
const registryFile = path.resolve(process.env.REGISTRY_FILE);
const registryRoot = path.resolve(process.env.REGISTRY_ROOT);
const storesConfigPath = path.join(root, 'config', 'stores.json');
let expectedStoreKeys = [];
try {
  const stores = JSON.parse(fs.readFileSync(storesConfigPath, 'utf8'))?.stores || [];
  expectedStoreKeys = [...new Set(stores
    .filter(store => store?.enabled !== false)
    .map(store => String(store?.storeKey || store?.store_key || store?.key || '').trim().toUpperCase())
    .filter(Boolean))].sort();
  if (expectedStoreKeys.length !== 19) throw new Error(`expected exactly 19 enabled stores, got=${expectedStoreKeys.length}`);
} catch (error) {
  throw new Error(`stores config preflight failed: ${error.message}`);
}
const moduleUrl = pathToFileURL(path.join(root, 'lib', 'marketing_plan_registry.mjs')).href;
const {verifyMarketingPlanRegistrySync} = await import(moduleUrl);
const result = verifyMarketingPlanRegistrySync({
  registryFile,
  registryRoot,
  expectedStoreKeys,
});
process.stdout.write(String(result.registryHash).toLowerCase());
NODE
)"; then
    echo "[cloud_marketing_repair] ERROR managed marketing plan registry verification failed file=$MARKETING_PLAN_REGISTRY_FILE" >&2
    return 66
  fi
  if ! [[ "$registry_hash" =~ ^[a-f0-9]{64}$ ]]; then
    echo "[cloud_marketing_repair] ERROR managed marketing plan registry returned an invalid hash: $registry_hash" >&2
    return 66
  fi
  CURRENT_REGISTRY_HASH="${registry_hash,,}"
  echo "[cloud_marketing_repair] current managed marketing plan registry verified hash=$CURRENT_REGISTRY_HASH"
}

queue_source_guard_file_locked() {
  if ! JSON_FILE="$QUEUE_FILE" ROOT_DIR="$ROOT" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.env.ROOT_DIR);
const queue = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
const raw = String(queue?.sourceGuard || '').trim();
if (!raw || /[\r\n]/.test(raw)) throw new Error('queue sourceGuard must be a non-empty single-line path');
const guard = path.resolve(root, raw);
const relative = path.relative(root, guard);
if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  throw new Error(`queue sourceGuard escapes worker root: ${raw}`);
}
process.stdout.write(guard);
NODE
  then
    return 66
  fi
}

guard_registry_hash_value() {
  if ! GUARD_BINDING_FILE="$1" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const guardFile = path.resolve(process.env.GUARD_BINDING_FILE);
const report = JSON.parse(fs.readFileSync(guardFile, 'utf8').replace(/^\uFEFF/, ''));
const registryHash = String(report?.targetPlanSelection?.registryHash || '').trim().toLowerCase();
if (!/^[a-f0-9]{64}$/.test(registryHash)) {
  throw new Error(`guard targetPlanSelection.registryHash must be a 64-hex SHA-256; got=${registryHash || 'missing'}`);
}
process.stdout.write(registryHash);
NODE
  then
    return 66
  fi
}

validate_guard_plan_binding() {
  local guard_file="$1"
  local expected_registry_hash="${2:-}"
  local expected_cost_map_path="${3:-}"
  local expected_cost_map_hash="${4:-}"
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
if (expectedRegistryHash && (!/^[a-f0-9]{64}$/.test(expectedRegistryHash) || registryHash !== expectedRegistryHash)) {
  throw new Error(`guard registry hash drift expected=${expectedRegistryHash || 'invalid'} actual=${registryHash}`);
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
if (expectedCostMapHash && (!/^[a-f0-9]{64}$/.test(expectedCostMapHash) || costMapHash !== expectedCostMapHash)) {
  throw new Error(`guard marketing cost map hash drift expected=${expectedCostMapHash || 'invalid'} actual=${costMapHash}`);
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
    echo "[cloud_marketing_repair] ERROR guard plan binding validation failed guard=$guard_file" >&2
    return 66
  fi
  mapfile -t fields <<<"$binding"
  if [[ "${#fields[@]}" -ne 5 || -z "${fields[0]}" || -z "${fields[3]}" ]]; then
    echo "[cloud_marketing_repair] ERROR guard plan binding validator returned an invalid tuple" >&2
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
    echo "[cloud_marketing_repair] ERROR staged guard report is incomplete: dir=$GUARD_STAGE_DIR" >&2
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
if (!/^[a-f0-9]{64}$/.test(registryHash) || !/^[a-f0-9]{64}$/.test(priceOverridesHash)) {
  throw new Error('staged guard registryHash and priceOverridesHash must both be 64-hex SHA-256 values');
}
const expectedRegistryHash = String(process.env.EXPECTED_REGISTRY_HASH || '').trim().toLowerCase();
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
  throw new Error('staged guard marketingCostMapSource.sha256 must be 64-hex and verified must be true');
}
const costMapPath = path.isAbsolute(rawCostMapPath)
  ? path.resolve(rawCostMapPath)
  : path.resolve(process.env.ROOT_DIR, rawCostMapPath);
const expectedCostMapPath = String(process.env.EXPECTED_COST_MAP_PATH || '').trim();
const expectedCostMapHash = String(process.env.EXPECTED_COST_MAP_SHA256 || '').trim().toLowerCase();
if (expectedCostMapPath && costMapPath !== path.resolve(expectedCostMapPath)) {
  throw new Error(`staged guard marketing cost map path drift expected=${expectedCostMapPath} actual=${costMapPath}`);
}
if (!/^[a-f0-9]{64}$/.test(expectedCostMapHash) || costMapHash !== expectedCostMapHash) {
  throw new Error(`staged guard marketing cost map hash drift expected=${expectedCostMapHash || 'missing'} actual=${costMapHash}`);
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

queue_value() {
  local expression="$1"
  local default_value="${2:-}"
  JSON_FILE="$QUEUE_FILE" JSON_EXPR="$expression" JSON_DEFAULT="$default_value" node <<'NODE'
const fs = require('node:fs');
try {
  const j = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
  const value = new Function('j', `return (${process.env.JSON_EXPR});`)(j);
  console.log(value === undefined || value === null || Number.isNaN(value) ? process.env.JSON_DEFAULT : String(value));
} catch { console.log(process.env.JSON_DEFAULT); }
NODE
}

queue_snapshot_value() {
  JSON_FILE="$QUEUE_FILE" node <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
try {
  const bytes = fs.readFileSync(process.env.JSON_FILE);
  const queue = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const queueFingerprint = String(queue?.queueFingerprint || '').trim().toLowerCase();
  const sourceGuardHash = String(queue?.sourceGuardHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(queueFingerprint) || !/^[a-f0-9]{64}$/.test(sourceGuardHash)) {
    throw new Error(`queue pair must contain 64-hex queueFingerprint/sourceGuardHash; queueFingerprint=${queueFingerprint || 'missing'} sourceGuardHash=${sourceGuardHash || 'missing'}`);
  }
  const queueStateSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  process.stdout.write(`${queueStateSha256}\n${queueFingerprint}\n${sourceGuardHash}`);
} catch (error) {
  console.error(`[cloud_marketing_repair] queue snapshot read failed: ${error.message}`);
  process.exitCode = 66;
}
NODE
}

refresh_queue_pair_locked() {
  local pair
  local fields=()
  if ! pair="$(queue_snapshot_value)"; then
    return 66
  fi
  mapfile -t fields <<<"$pair"
  if [[ "${#fields[@]}" -ne 3 || -z "${fields[0]}" || -z "${fields[1]}" || -z "${fields[2]}" ]]; then
    echo "[cloud_marketing_repair] queue snapshot reader returned an invalid tuple" >&2
    return 66
  fi
  QUEUE_EXPECTED_STATE_SHA256="${fields[0]}"
  QUEUE_EXPECTED_FINGERPRINT="${fields[1]}"
  QUEUE_EXPECTED_SOURCE_GUARD_HASH="${fields[2]}"
  QUEUE_ACTUAL_STATE_SHA256="${fields[0]}"
  QUEUE_ACTUAL_FINGERPRINT="${fields[1]}"
  QUEUE_ACTUAL_SOURCE_GUARD_HASH="${fields[2]}"
  QUEUE_CONFLICT_DETAIL=""
}

assert_current_queue_pair_locked() {
  local pair
  local fields=()
  if ! pair="$(queue_snapshot_value)"; then
    return 66
  fi
  mapfile -t fields <<<"$pair"
  if [[ "${#fields[@]}" -ne 3 || -z "${fields[0]}" || -z "${fields[1]}" || -z "${fields[2]}" ]]; then
    echo "[cloud_marketing_repair] queue snapshot reader returned an invalid tuple" >&2
    return 66
  fi
  QUEUE_ACTUAL_STATE_SHA256="${fields[0]}"
  QUEUE_ACTUAL_FINGERPRINT="${fields[1]}"
  QUEUE_ACTUAL_SOURCE_GUARD_HASH="${fields[2]}"
  if [[ "$QUEUE_ACTUAL_FINGERPRINT" != "$QUEUE_EXPECTED_FINGERPRINT" || "$QUEUE_ACTUAL_SOURCE_GUARD_HASH" != "$QUEUE_EXPECTED_SOURCE_GUARD_HASH" ]]; then
    QUEUE_CONFLICT_DETAIL="expected queueFingerprint=$QUEUE_EXPECTED_FINGERPRINT sourceGuardHash=$QUEUE_EXPECTED_SOURCE_GUARD_HASH actual queueFingerprint=$QUEUE_ACTUAL_FINGERPRINT sourceGuardHash=$QUEUE_ACTUAL_SOURCE_GUARD_HASH"
    return "$QUEUE_CONFLICT_STATUS"
  fi
  QUEUE_CONFLICT_DETAIL=""
}

assert_current_queue_state_locked() {
  if [[ -z "$QUEUE_EXPECTED_STATE_SHA256" || ! "$QUEUE_EXPECTED_STATE_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
    echo "[cloud_marketing_repair] ERROR expected queue state SHA-256 is missing or invalid" >&2
    return 66
  fi
  if [[ "$QUEUE_ACTUAL_STATE_SHA256" != "$QUEUE_EXPECTED_STATE_SHA256" ]]; then
    QUEUE_CONFLICT_DETAIL="expected queueStateSha256=$QUEUE_EXPECTED_STATE_SHA256 actual queueStateSha256=$QUEUE_ACTUAL_STATE_SHA256"
    return "$QUEUE_CONFLICT_STATUS"
  fi
  QUEUE_CONFLICT_DETAIL=""
}

assert_current_queue_registry_locked() {
  local guard_file guard_hash actual_guard_hash guard_registry_hash status
  if verify_current_marketing_plan_registry; then
    :
  else
    return $?
  fi
  if bind_marketing_cost_map; then
    :
  else
    return $?
  fi
  if ! guard_file="$(queue_source_guard_file_locked)"; then
    echo "[cloud_marketing_repair] ERROR queue source guard path could not be resolved" >&2
    return 66
  fi
  if ! actual_guard_hash="$(sha256_regular_file "$guard_file")"; then
    echo "[cloud_marketing_repair] ERROR queue source guard could not be hashed: $guard_file" >&2
    return 66
  fi
  actual_guard_hash="${actual_guard_hash,,}"
  if [[ "$actual_guard_hash" != "$QUEUE_ACTUAL_SOURCE_GUARD_HASH" ]]; then
    QUEUE_CONFLICT_DETAIL="queue sourceGuardHash drift expected=$QUEUE_ACTUAL_SOURCE_GUARD_HASH actual=$actual_guard_hash guard=$guard_file"
    return "$QUEUE_CONFLICT_STATUS"
  fi
  if ! guard_registry_hash="$(guard_registry_hash_value "$guard_file")"; then
    echo "[cloud_marketing_repair] ERROR queue source guard registry hash could not be read: $guard_file" >&2
    return 66
  fi
  guard_registry_hash="${guard_registry_hash,,}"
  if [[ "$guard_registry_hash" != "$CURRENT_REGISTRY_HASH" ]]; then
    QUEUE_CONFLICT_DETAIL="current managed registry drift expected guard registryHash=$guard_registry_hash actual durable registryHash=$CURRENT_REGISTRY_HASH guard=$guard_file"
    return "$QUEUE_CONFLICT_STATUS"
  fi
  if validate_guard_plan_binding "$guard_file" "$CURRENT_REGISTRY_HASH" "$MARKETING_COST_MAP_PATH" "$MARKETING_COST_MAP_SHA256"; then
    status=0
  else
    status=$?
  fi
  if (( status != 0 )); then
    return "$status"
  fi
  return 0
}

mark_queue_conflict() {
  local stage="$1"
  local phase="$2"
  local result_path="${3:-}"
  local evidence="${result_path:-no result path supplied}"
  write_state conflict "queue publication conflict stage=$stage phase=$phase; $QUEUE_CONFLICT_DETAIL; result evidence retained at $evidence; no further business operations will run"
  echo "[cloud_marketing_repair] CONFLICT stage=$stage phase=$phase; $QUEUE_CONFLICT_DETAIL; result evidence retained at $evidence; stopping further business operations" >&2
}

begin_stage_critical_section() {
  local stage="$1"
  local status=0
  if acquire_repair_artifact_registry_locks; then
    :
  else
    return $?
  fi
  if acquire_repair_queue_mutation_lock; then
    :
  else
    status=$?
    release_repair_artifact_registry_locks || true
    return "$status"
  fi
  # The artifact lock, registry publish lock, and queue mutation lock are all
  # held before this final precheck and remain held until update_stage commits.
  if assert_current_queue_pair_locked && assert_current_queue_registry_locked; then
    if assert_current_queue_state_locked; then
      status=0
    else
      status=$?
    fi
  else
    status=$?
  fi
  if (( status != 0 )); then
    release_repair_critical_locks || true
    if (( status == QUEUE_CONFLICT_STATUS )); then
      mark_queue_conflict "$stage" before-execution
    fi
    return "$status"
  fi
  STAGE_CRITICAL_SECTION_HELD=1
}

assert_stage_current() {
  local stage="$1"
  local status=0
  # begin_stage_critical_section performs assert_current_queue_registry_locked
  # and leaves all three locks held for the executor/readback/commit boundary.
  if begin_stage_critical_section "$stage"; then
    status=0
  else
    status=$?
  fi
  if (( status == 0 )); then
    release_repair_critical_locks || status=$?
  fi
  return "$status"
}

active_busy_services() {
  local active=() service
  command -v systemctl >/dev/null 2>&1 || return 0
  for service in $BUSY_SERVICES; do
    systemctl is-active --quiet "$service" && active+=("$service")
  done
  printf '%s\n' "${active[*]}"
}

cleanup_store_browsers() {
  cd "$ROOT"
  local owned_args=()
  if [[ "$LEASE_ACQUIRED" == "1" && -n "${RUN_ID:-}" ]]; then
    owned_args=(--owned-lease-task "$LEASE_TASK" --owned-lease-run-id "$RUN_ID")
  fi
  node scripts/cleanup_shein_store_browsers.mjs --all --cleanup-chrome-tmp --kill-after-sec 5 "${owned_args[@]}" || true
}

new_groups_in_result() {
  local result_path="$1"
  JSON_FILE="$ROOT/$result_path" node <<'NODE'
const fs = require('node:fs');
try {
  const value = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
  const resumed = Number(value.resumedGroups || 0);
  const total = Array.isArray(value.results) ? value.results.length : 0;
  console.log(Math.max(0, total - resumed));
} catch {
  console.log(0);
}
NODE
}

processed_items_this_run() {
  local result_path="$1"
  JSON_FILE="$ROOT/$result_path" node <<'NODE'
const fs = require('node:fs');
try {
  const value = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
  console.log(Math.max(0, Number(value?.totals?.processedThisRun || 0)));
} catch {
  console.log(0);
}
NODE
}

result_total() {
  local result_path="$1" field="$2"
  JSON_FILE="$ROOT/$result_path" JSON_FIELD="$field" node <<'NODE'
const fs = require('node:fs');
try {
  const value = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
  console.log(Math.max(0, Number(value?.totals?.[process.env.JSON_FIELD] || 0)));
} catch {
  console.log(0);
}
NODE
}

consume_group_budget() {
  local count="${1:-0}"
  [[ "$count" =~ ^[0-9]+$ ]] || count=0
  if (( count >= REMAINING_GROUPS )); then REMAINING_GROUPS=0; else REMAINING_GROUPS=$((REMAINING_GROUPS - count)); fi
}

lease_action() {
  node scripts/manage_browser_task_leases.mjs "$1" --root "$ROOT" --task "$LEASE_TASK" --run-id "$RUN_ID" --owner-pid "$$" --ttl-sec "$LEASE_TTL_SEC" --group ALL
}

ensure_browser_lease() {
  if [[ "$LEASE_ACQUIRED" == "1" ]]; then
    return 0
  fi
  lease_action acquire || return $?
  LEASE_ACQUIRED=1
  export SHEIN_BI_BROWSER_LEASE_TASK="$LEASE_TASK"
  export SHEIN_BI_BROWSER_LEASE_RUN_ID="$RUN_ID"
  cleanup_store_browsers
  return 0
}

update_stage() {
  local stage="$1" status="$2" readback_ok="$3" detail="$4" result_path="${5:-}"
  local command_status=0 release_status=0 manager_output manager_state actual_state
  local held_before="$STAGE_CRITICAL_SECTION_HELD"
  if [[ "$held_before" != "1" ]]; then
    if acquire_repair_critical_locks; then
      :
    else
      return $?
    fi
  fi
  if assert_current_queue_pair_locked && assert_current_queue_registry_locked; then
    if assert_current_queue_state_locked && manager_output="$(node scripts/marketing/manage_marketing_repair_queue.mjs update-stage \
        --queue "$QUEUE_FILE" --stage "$stage" --status "$status" \
        --readback-ok "$readback_ok" --detail "$detail" --result-path "$result_path" \
        --expected-queue-fingerprint "$QUEUE_EXPECTED_FINGERPRINT" \
        --expected-source-guard-hash "$QUEUE_EXPECTED_SOURCE_GUARD_HASH" \
        --expected-queue-state-sha256 "$QUEUE_EXPECTED_STATE_SHA256" \
        --queue-lock-token "$QUEUE_MUTATION_LOCK_TOKEN")"; then
      echo "$manager_output"
      if ! manager_state="$(printf '%s' "$manager_output" | node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(value.queueStateSha256 || ""));')"; then
        echo "[cloud_marketing_repair] ERROR queue manager returned invalid state readback" >&2
        command_status=66
      elif [[ ! "$manager_state" =~ ^[a-f0-9]{64}$ ]]; then
        echo "[cloud_marketing_repair] ERROR queue manager returned invalid queueStateSha256: $manager_state" >&2
        command_status=66
      elif ! actual_state="$(sha256_regular_file "$QUEUE_FILE")"; then
        command_status=66
      elif [[ "$actual_state" != "$manager_state" ]]; then
        QUEUE_CONFLICT_DETAIL="queue manager state readback mismatch expected=$manager_state actual=$actual_state"
        command_status="$QUEUE_CONFLICT_STATUS"
      elif refresh_queue_pair_locked; then
        QUEUE_EXPECTED_STATE_SHA256="$manager_state"
        QUEUE_ACTUAL_STATE_SHA256="$manager_state"
        command_status=0
      else
        command_status=$?
      fi
    else
      command_status=$?
    fi
  else
    command_status=$?
  fi
  if [[ "$held_before" == "1" || "$REPAIR_ARTIFACT_REGISTRY_LOCKS_HELD" == "1" || "$QUEUE_MUTATION_LOCK_HELD" == "1" ]]; then
    if ! release_repair_critical_locks; then
      release_status=75
    fi
  fi
  if (( command_status == 0 && release_status != 0 )); then
    command_status="$release_status"
  fi
  if (( command_status == QUEUE_CONFLICT_STATUS )); then
    mark_queue_conflict "$stage" after-execution "$result_path"
  fi
  return "$command_status"
}

write_state() {
  local status="$1" message="$2"
  mkdir -p "$ALERT_DIR"
  STATE_FILE="$ALERT_DIR/marketing-repair-last.json" STATE_DATE="$DATE" STATE_STATUS="$status" STATE_MESSAGE="$message" STATE_LOG="$LOG_FILE" STATE_QUEUE="$QUEUE_FILE" ROOT_DIR="$ROOT" node --input-type=module <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {writeJsonFileAtomic} = await import(pathToFileURL(path.join(process.env.ROOT_DIR, 'lib', 'atomic_file_publish.mjs')).href);
const state = {
  date: process.env.STATE_DATE,
  generatedAt: new Date().toISOString(),
  status: process.env.STATE_STATUS,
  message: process.env.STATE_MESSAGE,
  logFile: process.env.STATE_LOG,
  queueFile: process.env.STATE_QUEUE,
};
try {
  const queueBytes = fs.readFileSync(process.env.STATE_QUEUE);
  const queue = JSON.parse(queueBytes.toString('utf8').replace(/^\uFEFF/, ''));
  state.queueStatus = queue.status;
  state.queueCounts = queue.counts;
  state.queueFingerprint = queue.queueFingerprint;
  state.queueStateSha256 = crypto.createHash('sha256').update(queueBytes).digest('hex');
} catch {}
await writeJsonFileAtomic(process.env.STATE_FILE, state);
NODE
}

defer_remaining_work() {
  local message="$1"
  if (( IS_CLOUD_EXECUTION == 1 )); then
    write_state deferred_to_local "$message; remaining exact queue preserved for local-browser continuation"
    exit 75
  fi
  write_state pending "$message"
  exit 0
}

fallback_remaining_seconds() {
  [[ -n "$FALLBACK_GRACEFUL_CUTOFF_EPOCH" ]] || { echo -1; return 0; }
  echo $((FALLBACK_GRACEFUL_CUTOFF_EPOCH - $(date +%s)))
}

ensure_fallback_start_budget() {
  (( IS_CLOUD_EXECUTION == 1 )) || return 0
  [[ "$CLOUD_FALLBACK_ENABLED" == "true" ]] || return 0
  local remaining
  remaining="$(fallback_remaining_seconds)"
  if (( remaining < FALLBACK_MIN_START_BUDGET_SEC )); then
    defer_remaining_work "cloud emergency slot has ${remaining}s left; refuse to start another transaction"
  fi
}

validate_cloud_fallback_window() {
  (( IS_CLOUD_EXECUTION == 1 )) || return 0
  [[ "$CLOUD_FALLBACK_ENABLED" == "true" ]] || return 0
  local hour minute now_epoch remaining
  if [[ ! "$FALLBACK_MIN_START_BUDGET_SEC" =~ ^[1-9][0-9]*$ ]] || (( FALLBACK_MIN_START_BUDGET_SEC < 900 )); then
    echo "[cloud_marketing_repair] ERROR minimum group start budget must be at least 900 seconds: $FALLBACK_MIN_START_BUDGET_SEC" >&2
    exit 64
  fi
  if [[ ! "$FALLBACK_GRACEFUL_CUTOFF_EPOCH" =~ ^[1-9][0-9]*$ ]] || [[ ! "$FALLBACK_OUTER_HARD_DEADLINE_EPOCH" =~ ^[1-9][0-9]*$ ]]; then
    echo "[cloud_marketing_repair] ERROR cloud fallback requires absolute graceful and outer deadlines" >&2
    exit 64
  fi
  now_epoch="$(date +%s)"
  if (( FALLBACK_OUTER_HARD_DEADLINE_EPOCH <= FALLBACK_GRACEFUL_CUTOFF_EPOCH )); then
    echo "[cloud_marketing_repair] ERROR outer deadline must be later than graceful cutoff" >&2
    exit 64
  fi
  if (( FALLBACK_OUTER_HARD_DEADLINE_EPOCH - FALLBACK_GRACEFUL_CUTOFF_EPOCH < FALLBACK_MIN_START_BUDGET_SEC )); then
    echo "[cloud_marketing_repair] ERROR outer deadline has less than the minimum group safety margin" >&2
    exit 64
  fi
  remaining=$((FALLBACK_GRACEFUL_CUTOFF_EPOCH - now_epoch))
  if (( remaining < FALLBACK_MIN_START_BUDGET_SEC )); then
    write_state deferred_to_local "cloud emergency fallback has ${remaining}s before the graceful no-new-group cutoff; preserve the exact queue"
    exit 75
  fi
  hour=$((10#$(TZ="$TZ_NAME" date +%H)))
  minute=$((10#$(TZ="$TZ_NAME" date +%M)))
  if ! ((
    (hour == 20 && minute >= 45)
    || (hour == 21 && minute >= 15)
    || hour == 22
  )); then
    write_state deferred_to_local "cloud emergency fallback is outside 20:45-22:55 same-day window"
    exit 75
  fi
}

handoff_local_queue() {
  local command_status=0 release_status=0 manager_output manager_state actual_state
  if acquire_repair_artifact_registry_locks; then
    :
  else
    return $?
  fi
  if acquire_repair_queue_mutation_lock; then
    :
  else
    command_status=$?
    release_repair_artifact_registry_locks || true
    return "$command_status"
  fi
  if assert_current_queue_pair_locked && assert_current_queue_registry_locked; then
    if assert_current_queue_state_locked && manager_output="$(node scripts/marketing/manage_marketing_repair_queue.mjs handoff-local \
        --queue "$QUEUE_FILE" \
        --reason "cloud marketing writes are disabled; preserve the exact queue for local controlled execution" \
        --expected-queue-fingerprint "$QUEUE_EXPECTED_FINGERPRINT" \
        --expected-source-guard-hash "$QUEUE_EXPECTED_SOURCE_GUARD_HASH" \
        --expected-queue-state-sha256 "$QUEUE_EXPECTED_STATE_SHA256" \
        --queue-lock-token "$QUEUE_MUTATION_LOCK_TOKEN")"; then
      echo "$manager_output"
      if ! manager_state="$(printf '%s' "$manager_output" | node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(value.queueStateSha256 || ""));')"; then
        echo "[cloud_marketing_repair] ERROR queue manager returned invalid handoff state readback" >&2
        command_status=66
      elif [[ ! "$manager_state" =~ ^[a-f0-9]{64}$ ]]; then
        echo "[cloud_marketing_repair] ERROR queue manager returned invalid handoff queueStateSha256: $manager_state" >&2
        command_status=66
      elif ! actual_state="$(sha256_regular_file "$QUEUE_FILE")"; then
        command_status=66
      elif [[ "$actual_state" != "$manager_state" ]]; then
        QUEUE_CONFLICT_DETAIL="handoff queue manager state readback mismatch expected=$manager_state actual=$actual_state"
        command_status="$QUEUE_CONFLICT_STATUS"
      elif refresh_queue_pair_locked; then
        QUEUE_EXPECTED_STATE_SHA256="$manager_state"
        QUEUE_ACTUAL_STATE_SHA256="$manager_state"
        command_status=0
      else
        command_status=$?
      fi
    else
      command_status=$?
    fi
  else
    command_status=$?
  fi
  if ! release_repair_critical_locks; then
    release_status=75
  fi
  if (( command_status == 0 && release_status != 0 )); then
    command_status="$release_status"
  fi
  if (( command_status == QUEUE_CONFLICT_STATUS )); then
    mark_queue_conflict handoff-local handoff
  fi
  return "$command_status"
}

send_daily_group_report() {
  node scripts/marketing/send_marketing_daily_group_report.mjs \
    --date "$DATE" --queue "$QUEUE_FILE" \
    --guard "$ROOT/outputs/reports/marketing-daily-guard-${DATE}.json" \
    --execution "$ROOT/outputs/reports/new-listing-7d-limited-discount-execution-summary-${DATE}.json"
}

FINAL_SCAN_OUT=""

run_terminal_final_snapshot() {
  local stamp scan_out
  stamp="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)-repair-final"
  scan_out="$ROOT/tmp/marketing-signup/current-price-live/current-marketing-price-live-${DATE}-${stamp}.json"
  # Every terminal report is built after a fresh browserless ordinary/coupon
  # snapshot and a final 19-store price readback. A blocked queue is not a
  # report-ready state by itself.
  ensure_browser_lease || return $?
  lease_action heartbeat || return $?
  timeout -k "$STACK_REVIEW_KILL_AFTER_SEC" "$STACK_REVIEW_TIMEOUT_SEC" \
    node scripts/marketing/export_marketing_stack_review.mjs \
      --batch-size 3 \
      --session-http \
      --cloud-bi-ssh "$GUARD_CLOUD_BI_SSH" \
      --cloud-bi-root "$GUARD_CLOUD_BI_ROOT" || return $?
  lease_action heartbeat || return $?
  timeout -k "$SCAN_KILL_AFTER_SEC" "$SCAN_TIMEOUT_SEC" \
    node scripts/marketing/scan_current_marketing_prices_for_bi.mjs \
      --group ALL --page-size 500 --store-attempts 3 \
       --session-http --session-concurrency "${SHEIN_BI_MARKETING_PRICE_SESSION_CONCURRENCY:-3}" \
       --out "$scan_out" || return $?
  lease_action heartbeat || return $?
  bind_marketing_cost_map || return $?
  node scripts/marketing/build_marketing_daily_guard_report.mjs \
    --date "$DATE" --max-age-hours "$GUARD_MAX_AGE_HOURS" \
    --out-dir "$GUARD_STAGE_DIR" \
    --cloud-bi-ssh "$GUARD_CLOUD_BI_SSH" --cloud-bi-root "$GUARD_CLOUD_BI_ROOT" \
    --marketing-cost-map "$MARKETING_COST_MAP_PATH" \
    --expected-marketing-cost-map-sha256 "$MARKETING_COST_MAP_SHA256" || return $?
  GUARD_INPUT_OUT="$GUARD_STAGE_DIR/marketing-daily-guard-${DATE}.json"
  FINAL_SCAN_OUT="$scan_out"
}

run_final_readback() {
  run_terminal_final_snapshot || return $?
  verify_current_marketing_plan_registry || return $?
  validate_guard_plan_binding "$GUARD_INPUT_OUT" "$CURRENT_REGISTRY_HASH" "$MARKETING_COST_MAP_PATH" "$MARKETING_COST_MAP_SHA256" || return $?
  echo "[cloud_marketing_repair] staged guard binding validated registryHash=$GUARD_BOUND_REGISTRY_HASH priceOverridesHash=$GUARD_BOUND_PRICE_OVERRIDES_SHA256 marketingCostMap=$GUARD_BOUND_MARKETING_COST_MAP_PATH marketingCostMapSha256=$GUARD_BOUND_MARKETING_COST_MAP_SHA256"
  prepare_marketing_price_leads || return $?
  acquire_repair_artifact_registry_locks || return $?
  local publication_status=0
  if verify_current_marketing_plan_registry \
      && validate_guard_plan_binding "$GUARD_INPUT_OUT" "$CURRENT_REGISTRY_HASH" "$MARKETING_COST_MAP_PATH" "$MARKETING_COST_MAP_SHA256" \
      && publish_staged_guard_report; then
    GUARD_INPUT_OUT="$GUARD_OUT"
    if build_current_repair_plans && rebuild_repair_queue_locked && refresh_queue_pair_locked && assert_current_queue_registry_locked; then
      echo "[cloud_marketing_repair] refreshed queue pair after final readback queueFingerprint=$QUEUE_EXPECTED_FINGERPRINT sourceGuardHash=$QUEUE_EXPECTED_SOURCE_GUARD_HASH"
      echo "[cloud_marketing_repair] publish terminal marketing live snapshot to BI portal queue"
      if SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_HELD=1 \
        SHEIN_BI_MARKETING_BI_PUBLISH_DATE="$DATE" \
        SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_FILE="$ARTIFACT_PUBLICATION_LOCK_FILE" \
        SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_WAIT_SEC="$ARTIFACT_PUBLICATION_LOCK_WAIT_SEC" \
        SHEIN_BI_MARKETING_PRICE_LEADS_FILE="$PRICE_LEADS_FILE" \
        SHEIN_BI_MARKETING_PRICE_LEADS_STAGE_FILE="$PRICE_LEADS_STAGE_FILE" \
        SHEIN_BI_MARKETING_PRICE_LEADS_PREPARED=1 \
        bash scripts/publish_marketing_price_leads_to_bi.sh; then
        publication_status=0
      else
        publication_status=$?
      fi
    else
      publication_status=$?
    fi
  else
    publication_status=$?
  fi
  release_repair_artifact_registry_locks || publication_status=75
  return "$publication_status"
}

prepare_marketing_price_leads() {
  node scripts/marketing/export_marketing_price_leads_for_bi.mjs \
    --require-fresh --out "$PRICE_LEADS_STAGE_FILE"
}

build_current_repair_plans() {
  local scan_out guard_out manual_count drift_count manual_plan price_overrides_path price_overrides_hash marketing_cost_map_path marketing_cost_map_hash
  scan_out="$FINAL_SCAN_OUT"
  guard_out="$ROOT/outputs/reports/marketing-daily-guard-${DATE}.json"
  verify_current_marketing_plan_registry || return $?
  validate_guard_plan_binding "$guard_out" "$CURRENT_REGISTRY_HASH" "$MARKETING_COST_MAP_PATH" "$MARKETING_COST_MAP_SHA256" || return $?
  price_overrides_path="$GUARD_BOUND_PRICE_OVERRIDES_PATH"
  price_overrides_hash="$GUARD_BOUND_PRICE_OVERRIDES_SHA256"
  marketing_cost_map_path="$GUARD_BOUND_MARKETING_COST_MAP_PATH"
  marketing_cost_map_hash="$GUARD_BOUND_MARKETING_COST_MAP_SHA256"
  node scripts/marketing/build_high_click_special_discount_plan.mjs \
    --date "$DATE" --guard "$guard_out" \
    --out "$ROOT/outputs/reports/high-click-low-conversion-special-plan-${DATE}.json" || return $?
  node scripts/marketing/build_new_listing_limited_discount_plan.mjs \
    --date "$DATE" --source-guard "$guard_out" --exclude-manual-special true \
    --current-marketing-live-scan "$scan_out" \
    --price-overrides "$price_overrides_path" \
    --expected-price-overrides-sha256 "$price_overrides_hash" \
    --expected-marketing-cost-map-sha256 "$marketing_cost_map_hash" \
    --cost-map "$marketing_cost_map_path" \
    --no-supplemental-price-overrides true || return $?
  manual_count="$(GUARD_FILE="$guard_out" node -e "const j=require(process.env.GUARD_FILE);process.stdout.write(String(Number(j.manualSpecialLimitedDiscount?.actionCount||0)))")" || return $?
  manual_plan="$ROOT/tmp/marketing-signup/manual-limited-discount-restore/${DATE}/manual-limited-discount-restore-plan.json"
  if [[ "$manual_count" -gt 0 ]]; then
    node scripts/marketing/build_manual_limited_discount_restore_plan.mjs \
      --guard "$guard_out" \
      --out-dir "$(dirname "$manual_plan")" || return $?
  fi
  drift_count="$(GUARD_FILE="$guard_out" node -e "const j=require(process.env.GUARD_FILE);process.stdout.write(String((j.limitedDiscountTargetPriceDrift?.belowRows||[]).length))")" || return $?
  if [[ "$drift_count" -gt 0 ]]; then
    node scripts/marketing/build_limited_discount_drift_rescue_plan.mjs \
      --guard "$guard_out" \
      --out-dir "$ROOT/tmp/marketing-signup/limited-discount-fallback/target-price-drift-${DATE}" \
      --end-time "$(TZ="$TZ_NAME" date -d "$DATE +7 days" +%F) 23:59:59" || return $?
  fi
  return 0
}

rebuild_repair_queue_locked() {
  local guard_out manual_plan manager_output manager_state actual_state
  guard_out="$GUARD_OUT"
  manual_plan="$ROOT/tmp/marketing-signup/manual-limited-discount-restore/${DATE}/manual-limited-discount-restore-plan.json"
  if manager_output="$(node scripts/marketing/manage_marketing_repair_queue.mjs build \
    --date "$DATE" --guard "$guard_out" \
    --high-click-plan "$ROOT/outputs/reports/high-click-low-conversion-special-plan-${DATE}.json" \
    --manual-plan "$manual_plan" \
    --drift-plan-dir "$ROOT/tmp/marketing-signup/limited-discount-fallback/target-price-drift-${DATE}" \
    --fallback-plan "$ROOT/outputs/reports/new-listing-7d-limited-discount-plan-${DATE}.json" \
    --queue "$QUEUE_FILE")"; then
    :
  else
    return $?
  fi
  echo "$manager_output"
  if ! manager_state="$(printf '%s' "$manager_output" | node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(value.queueStateSha256 || ""));')"; then
    echo "[cloud_marketing_repair] ERROR queue build returned invalid state readback" >&2
    return 66
  fi
  if [[ ! "$manager_state" =~ ^[a-f0-9]{64}$ ]]; then
    echo "[cloud_marketing_repair] ERROR queue build returned invalid queueStateSha256: $manager_state" >&2
    return 66
  fi
  actual_state="$(sha256_regular_file "$QUEUE_FILE")" || return $?
  if [[ "$actual_state" != "$manager_state" ]]; then
    echo "[cloud_marketing_repair] ERROR queue build state readback mismatch expected=$manager_state actual=$actual_state" >&2
    return "$QUEUE_CONFLICT_STATUS"
  fi
  refresh_queue_pair_locked || return $?
  assert_current_queue_registry_locked || return $?
}

rebuild_repair_queue() {
  acquire_repair_artifact_registry_locks
  local command_status=0
  if rebuild_repair_queue_locked; then
    command_status=0
  else
    command_status=$?
  fi
  release_repair_artifact_registry_locks || command_status=75
  return "$command_status"
}

terminal_report_ready() {
  node scripts/marketing/check_marketing_terminal_report_readiness.mjs \
    --guard "$ROOT/outputs/reports/marketing-daily-guard-${DATE}.json" \
    --high-click-plan "$ROOT/outputs/reports/high-click-low-conversion-special-plan-${DATE}.json" \
    --manual-plan "$ROOT/tmp/marketing-signup/manual-limited-discount-restore/${DATE}/manual-limited-discount-restore-plan.json" \
    --drift-plan "$ROOT/tmp/marketing-signup/limited-discount-fallback/target-price-drift-${DATE}/limited-discount-target-drift-rescue-plan-${DATE}.json" \
    --fallback-plan "$ROOT/outputs/reports/new-listing-7d-limited-discount-plan-${DATE}.json" \
    --high-click-result "$ROOT/outputs/reports/high-click-low-conversion-special-execution-${DATE}.json" \
    --manual-result "$ROOT/tmp/marketing-signup/manual-limited-discount-restore/${DATE}/manual-limited-discount-restore-result.json" \
    --drift-result "$ROOT/tmp/marketing-signup/limited-discount-rescue/batch-drift-fix-result-${DATE}.json" \
    --fallback-result "$ROOT/outputs/reports/new-listing-7d-limited-discount-execution-summary-${DATE}.json"
}

on_exit() {
  local status="$?"
  trap - EXIT
  set +e
  if [[ "$LEASE_ACQUIRED" == "1" ]]; then
    cleanup_store_browsers
    lease_action release >/dev/null 2>&1
    LEASE_ACQUIRED=0
  fi
  release_repair_critical_locks || true
  exit "$status"
}

mkdir -p "$LOG_DIR" "$STATE_DIR/repair-queues" "$ALERT_DIR"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
RUN_ID="${SHEIN_BI_MARKETING_REPAIR_RUN_ID:-$(node -e 'console.log(require("node:crypto").randomUUID())')}"
LOG_FILE="$LOG_DIR/marketing-repair-${DATE}-${STAMP}.log"
GUARD_STAGE_DIR="$STATE_DIR/report-staging/${DATE}/${RUN_ID}"
GUARD_INPUT_OUT="$GUARD_OUT"
PRICE_LEADS_FILE="${SHEIN_BI_MARKETING_PRICE_LEADS_FILE:-$ROOT/outputs/bi-portal/marketing-price-leads.json}"
PRICE_LEADS_STAGE_FILE="$GUARD_STAGE_DIR/marketing-price-leads.json"
trap on_exit EXIT
prepare_shared_lock_file "$LOCK_FILE"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[cloud_marketing_repair] another repair worker is running; skip"
  exit 0
fi
exec > >(tee -a "$LOG_FILE") 2>&1
trap on_exit EXIT
cd "$ROOT"

if [[ ! -f "$QUEUE_FILE" ]]; then
  echo "[cloud_marketing_repair] no queue for date=$DATE"
  exit 0
fi
if acquire_repair_artifact_registry_locks; then
  :
else
  status=$?
  write_state deferred_to_local "could not acquire artifact publication lock before queue pair capture status=$status"
  exit "$status"
fi
if refresh_queue_pair_locked && assert_current_queue_registry_locked; then
  QUEUE_STATUS="$(queue_value 'j.status' missing)"
else
  status=$?
  release_repair_artifact_registry_locks || true
  if (( status == QUEUE_CONFLICT_STATUS )); then
    mark_queue_conflict initial before-execution
  else
    write_state failed "initial queue/registry capture failed status=$status"
  fi
  exit "$status"
fi
release_repair_artifact_registry_locks || true
if [[ "$QUEUE_STATUS" == "completed" || "$QUEUE_STATUS" == "blocked" ]]; then
  if [[ "$QUEUE_STATUS" == "blocked" ]]; then
    if run_final_readback; then
      :
    else
      status=$?
      write_state failed "final terminal snapshot/publication failed status=$status"
      exit "$status"
    fi
    if ! terminal_report_ready; then
      write_state pending "final snapshot found new authorized repair work; final report delivery deferred"
      echo "[cloud_marketing_repair] final report deferred because final snapshot added unhandled repair work"
      exit 0
    fi
    write_state blocked "repair queue reached terminal business blockers and final-snapshot work is fully accounted"
  else
    write_state ok "repair queue already completed"
  fi
  set +e
  send_daily_group_report
  REPORT_STATUS=$?
  set -e
  if [[ "$REPORT_STATUS" -eq 3 ]]; then
    echo "[cloud_marketing_repair] terminal queue has no post-execution final guard; refreshing final evidence"
    if run_final_readback; then
      send_daily_group_report
    else
      status=$?
      write_state failed "terminal final guard refresh/publication failed status=$status"
      exit "$status"
    fi
  elif [[ "$REPORT_STATUS" -ne 0 ]]; then
    echo "[cloud_marketing_repair] WARN complete group report delivery failed status=$REPORT_STATUS" >&2
  fi
  echo "[cloud_marketing_repair] queue already terminal status=$QUEUE_STATUS"
  exit 0
fi
if (( IS_CLOUD_EXECUTION == 1 )) && [[ "$CLOUD_FALLBACK_ENABLED" != "true" ]]; then
  if handoff_local_queue; then
    :
  else
    status=$?
    if (( status != QUEUE_CONFLICT_STATUS )); then
      write_state deferred_to_local "cloud marketing handoff could not update the exact queue status=$status"
    fi
    exit "$status"
  fi
  write_state deferred_to_local "cloud marketing writes are disabled; exact queue preserved for local controlled execution"
  echo "[cloud_marketing_repair] DEFER TO LOCAL before browser lease or SHEIN mutation; the final report waits for local execution and terminal readback"
  exit 75
fi
validate_cloud_fallback_window
ACTIVE_BUSY="$(active_busy_services)"
if [[ -n "$ACTIVE_BUSY" ]]; then
  write_state deferred_to_local "cloud host is busy; keep the exact queue for local-browser continuation: $ACTIVE_BUSY"
  echo "[cloud_marketing_repair] DEFER TO LOCAL busy services active: $ACTIVE_BUSY"
  exit 75
fi
CURRENT_MINUTE="$(TZ="$TZ_NAME" date +%M)"
CURRENT_MINUTE=$((10#$CURRENT_MINUTE))
if (( IS_CLOUD_EXECUTION == 1 )); then
  if (( CURRENT_MINUTE >= 23 && CURRENT_MINUTE <= 42 )); then
    write_state deferred_to_local "reserved :32-:43 core-data lane is too close; exact repair queue preserved for local-browser continuation"
    echo "[cloud_marketing_repair] DEFER TO LOCAL outside safe start window minute=$CURRENT_MINUTE context=${AUTOMATION_CONTEXT:-unknown}"
    exit 75
  fi
  echo "[cloud_marketing_repair] cloud repair batch max groups=$MAX_GROUPS; group writes remain serial context=${AUTOMATION_CONTEXT:-unknown}"
  export SHEIN_BI_MARKETING_CLOUD_WRITE_GATE=bounded-repair-v1
fi

ensure_browser_lease
REMAINING_GROUPS="$MAX_GROUPS"

# A local runner may have completed writes without mutating the cloud queue.
# The emergency cloud slot therefore rebuilds the exact queue from a fresh
# browserless 19-store snapshot before it is allowed to open any cloud Chrome.
# This prevents replaying work already completed on the owner's computer.
if (( IS_CLOUD_EXECUTION == 1 )) && [[ "$CLOUD_FALLBACK_ENABLED" == "true" ]]; then
  run_final_readback
  QUEUE_STATUS="$(queue_value 'j.status' pending)"
  if [[ "$QUEUE_STATUS" == "completed" ]]; then
    write_state ok "local execution already covered all authorized repairs; cloud fallback only performed final readback"
    send_daily_group_report
    echo "[cloud_marketing_repair] fallback readback found no remaining work date=$DATE"
    exit 0
  fi
  if [[ "$QUEUE_STATUS" == "blocked" ]]; then
    write_state blocked "final readback found only terminal business blockers; cloud fallback did not write"
    send_daily_group_report
    echo "[cloud_marketing_repair] fallback readback found only terminal blockers date=$DATE"
    exit 0
  fi
  ensure_fallback_start_budget
fi

HIGH_CLICK_STATUS="$(queue_value 'j.stages?.highClickSpecial?.status' not_required)"
if [[ "$HIGH_CLICK_STATUS" != "not_required" && "$HIGH_CLICK_STATUS" != "completed" ]]; then
  ensure_fallback_start_budget
  WORK_FINGERPRINT="$(queue_value 'j.stages?.highClickSpecial?.workFingerprint' '')"
  export SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH="$WORK_FINGERPRINT"
  GUARD_PATH="$ROOT/$(queue_value 'j.sourceGuard' '')"
  HIGH_CLICK_PLAN_PATH="$ROOT/$(queue_value 'j.stages?.highClickSpecial?.planPath' '')"
  RESULT_PATH="outputs/reports/high-click-low-conversion-special-execution-${DATE}.json"
  begin_stage_critical_section highClickSpecial || { status=$?; exit "$status"; }
  if node scripts/marketing/batch_apply_high_click_special_discounts.mjs \
      --date "$DATE" --guard "$GUARD_PATH" --plan "$HIGH_CLICK_PLAN_PATH" \
      --execute --max-items "$REMAINING_GROUPS" --result "$ROOT/$RESULT_PATH" \
      --expected-work-fingerprint "$WORK_FINGERPRINT"; then
    update_stage highClickSpecial completed true "protected registration, execute and per-item live readback succeeded" "$RESULT_PATH"
    consume_group_budget "$(processed_items_this_run "$RESULT_PATH")"
  else
    status=$?
    if [[ "$status" -eq 3 ]]; then
      update_stage highClickSpecial pending false "bounded chunk completed; more exact-plan items remain" "$RESULT_PATH"
      defer_remaining_work "high-click special chunk completed without replaying successful items"
    fi
    BLOCKED_TARGETS="$(result_total "$RESULT_PATH" blocked)"
    FAILED_TARGETS="$(result_total "$RESULT_PATH" failed)"
    if (( BLOCKED_TARGETS > 0 && FAILED_TARGETS == 0 )); then
      update_stage highClickSpecial blocked false "ET/platform preflight safely blocked one or more protected specials" "$RESULT_PATH"
      write_state blocked "high-click special repair safely blocked by current ET inventory/platform conditions"
      consume_group_budget "$(processed_items_this_run "$RESULT_PATH")"
    else
      update_stage highClickSpecial failed false "execute/readback failed status=$status" "$RESULT_PATH"
      write_state failed "high-click special execute failed status=$status"
      exit "$status"
    fi
  fi
fi

if (( REMAINING_GROUPS <= 0 )); then
  defer_remaining_work "bounded group budget consumed"
fi

MANUAL_STATUS="$(queue_value 'j.stages?.manualSpecialRestore?.status' not_required)"
if [[ "$MANUAL_STATUS" != "not_required" && "$MANUAL_STATUS" != "completed" ]]; then
  ensure_fallback_start_budget
  export SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH="$(queue_value 'j.stages?.manualSpecialRestore?.workFingerprint || j.stages?.manualSpecialRestore?.inputFingerprint' '')"
  WORK_FINGERPRINT="$(queue_value 'j.stages?.manualSpecialRestore?.workFingerprint' '')"
  GUARD_PATH="$ROOT/$(queue_value 'j.sourceGuard' '')"
  MANUAL_PLAN_PATH="$ROOT/$(queue_value 'j.stages?.manualSpecialRestore?.planPath' '')"
  MANUAL_OUT_DIR="$(dirname "$MANUAL_PLAN_PATH")"
  RESULT_PATH="tmp/marketing-signup/manual-limited-discount-restore/${DATE}/manual-limited-discount-restore-result.json"
  begin_stage_critical_section manualSpecialRestore || { status=$?; exit "$status"; }
  if node scripts/marketing/batch_restore_manual_limited_discounts.mjs \
      --guard "$GUARD_PATH" --out-dir "$MANUAL_OUT_DIR" --skip-build --execute \
      --max-items "$REMAINING_GROUPS" --result "$ROOT/$RESULT_PATH" \
      --expected-work-fingerprint "$WORK_FINGERPRINT"; then
    update_stage manualSpecialRestore completed true "bounded execute and per-item readback succeeded" "$RESULT_PATH"
    consume_group_budget "$(processed_items_this_run "$RESULT_PATH")"
  else
    status=$?
    if [[ "$status" -eq 3 ]]; then
      update_stage manualSpecialRestore pending false "bounded chunk completed; more exact-plan items remain" "$RESULT_PATH"
      defer_remaining_work "manual-special repair chunk completed without replaying successful items"
    fi
    update_stage manualSpecialRestore failed false "execute/readback failed status=$status"
    write_state failed "manual special restore failed status=$status"
    exit "$status"
  fi
fi

if (( REMAINING_GROUPS <= 0 )); then
  defer_remaining_work "bounded group budget consumed"
fi

DRIFT_STATUS="$(queue_value 'j.stages?.driftRepair?.status' not_required)"
if [[ "$DRIFT_STATUS" != "not_required" && "$DRIFT_STATUS" != "completed" ]]; then
  ensure_fallback_start_budget
  WORK_FINGERPRINT="$(queue_value 'j.stages?.driftRepair?.workFingerprint' '')"
  export SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH="$WORK_FINGERPRINT"
  GUARD_PATH="$ROOT/$(queue_value 'j.sourceGuard' '')"
  RESULT_PATH="tmp/marketing-signup/limited-discount-rescue/batch-drift-fix-result-${DATE}.json"
  begin_stage_critical_section driftRepair || { status=$?; exit "$status"; }
  if node scripts/marketing/batch_fix_limited_discount_drift.mjs \
      --guard "$GUARD_PATH" --skip-build-plan --execute --max-groups "$REMAINING_GROUPS" \
      --expected-work-fingerprint "$WORK_FINGERPRINT"; then
    update_stage driftRepair completed true "bounded execute and per-group readback succeeded" "$RESULT_PATH"
    consume_group_budget "$(new_groups_in_result "$RESULT_PATH")"
  else
    status=$?
    if [[ "$status" -eq 3 ]]; then
      update_stage driftRepair pending false "bounded chunk completed; more exact-manifest groups remain" "$RESULT_PATH"
      defer_remaining_work "drift repair chunk completed without replaying successful groups"
    fi
    if [[ "$status" -eq 4 ]]; then
      update_stage driftRepair blocked false "current inventory/platform conditions safely blocked one or more drift repairs; existing protection was preserved" "$RESULT_PATH"
      consume_group_budget "$(new_groups_in_result "$RESULT_PATH")"
    else
      update_stage driftRepair failed false "execute/readback failed status=$status" "$RESULT_PATH"
      write_state failed "drift repair failed status=$status"
      exit "$status"
    fi
  fi
fi


if (( REMAINING_GROUPS <= 0 )); then
  defer_remaining_work "bounded group budget consumed"
fi

FALLBACK_STATUS="$(queue_value 'j.stages?.fallbackRepair?.status' not_required)"
if [[ "$FALLBACK_STATUS" != "not_required" && "$FALLBACK_STATUS" != "completed" ]]; then
  ensure_fallback_start_budget
  WORK_FINGERPRINT="$(queue_value 'j.stages?.fallbackRepair?.workFingerprint' '')"
  export SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH="$WORK_FINGERPRINT"
  GUARD_PATH="$ROOT/$(queue_value 'j.sourceGuard' '')"
  RESULT_PATH="outputs/reports/new-listing-7d-limited-discount-execution-summary-${DATE}.json"
  begin_stage_critical_section fallbackRepair || { status=$?; exit "$status"; }
  if node scripts/marketing/batch_apply_new_listing_limited_discount.mjs \
      --date "$DATE" --guard "$GUARD_PATH" --skip-build --execute --max-groups "$REMAINING_GROUPS" \
      --graceful-cutoff-epoch "$FALLBACK_GRACEFUL_CUTOFF_EPOCH" \
      --min-start-budget-sec "$FALLBACK_MIN_START_BUDGET_SEC" \
      --expected-work-fingerprint "$WORK_FINGERPRINT"; then
    BLOCKED_TARGETS="$(result_total "$RESULT_PATH" blockedTargetCount)"
    FAILED_TARGETS="$(result_total "$RESULT_PATH" failedTargetCount)"
    if (( BLOCKED_TARGETS > 0 && FAILED_TARGETS == 0 )); then
      update_stage fallbackRepair blocked false "preflight reached terminal inventory/platform blockers; no unsafe write attempted" "$RESULT_PATH"
      write_state blocked "fallback repair safely blocked by current inventory/platform conditions"
      consume_group_budget "$(new_groups_in_result "$RESULT_PATH")"
      echo "[cloud_marketing_repair] terminal fallback blockers recorded; final snapshot still required date=$DATE rows=$BLOCKED_TARGETS"
    else
      update_stage fallbackRepair completed true "bounded execute and per-group readback succeeded" "$RESULT_PATH"
      consume_group_budget "$(new_groups_in_result "$RESULT_PATH")"
    fi
  else
    status=$?
    if [[ "$status" -eq 3 ]]; then
      update_stage fallbackRepair pending false "bounded chunk completed; more exact-plan groups remain" "$RESULT_PATH"
      defer_remaining_work "fallback repair chunk completed without replaying successful groups"
    fi
    update_stage fallbackRepair failed false "execute/readback failed status=$status" "$RESULT_PATH"
    write_state failed "fallback repair failed status=$status"
    exit "$status"
  fi
fi

QUEUE_STATUS="$(queue_value 'j.status' pending)"
if [[ "$QUEUE_STATUS" == "blocked" ]]; then
  write_state blocked "all executable repairs were processed; remaining links are safely blocked by current inventory/platform conditions"
  if run_final_readback; then
    QUEUE_STATUS="$(queue_value 'j.status' pending)"
    if [[ "$QUEUE_STATUS" == "blocked" ]]; then
      send_daily_group_report
    else
      write_state pending "final snapshot produced a non-terminal repair queue"
      echo "[cloud_marketing_repair] final snapshot produced a non-terminal repair queue"
      exit 0
    fi
  else
    status=$?
    write_state failed "terminal final snapshot/publication failed status=$status"
    exit "$status"
  fi
  echo "[cloud_marketing_repair] done with terminal business blockers after final live snapshot date=$DATE"
  exit 0
fi

if [[ "$QUEUE_STATUS" == "awaiting_final_readback" ]]; then
  ensure_fallback_start_budget
  if run_final_readback; then
    if [[ "$(queue_value 'j.status' pending)" == "completed" ]]; then
      write_state ok "all queued repairs passed final full-store live readback"
      send_daily_group_report
      echo "[cloud_marketing_repair] done ok date=$DATE"
      exit 0
    fi
    write_state pending "final readback produced a smaller/new exact repair queue"
    echo "[cloud_marketing_repair] final readback found remaining bounded work"
    exit 0
  fi
  status=$?
  write_state failed "final full-store readback failed status=$status"
  exit "$status"
fi

write_state pending "repair queue remains pending"
