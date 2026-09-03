#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
source "$ROOT/scripts/lib/shared_lock.sh"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
DATE="${SHEIN_BI_MARKETING_REPAIR_DATE:-$(TZ="$TZ_NAME" date +%F)}"
CURRENT_DATE="$(TZ="$TZ_NAME" date +%F)"
if [[ "$DATE" != "$CURRENT_DATE" ]]; then
  echo "[cloud_marketing_repair] refusing non-current repair queue date=$DATE current=$CURRENT_DATE" >&2
  exit 75
fi
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
LEASE_HEARTBEAT_INTERVAL_SEC="${SHEIN_BI_MARKETING_REPAIR_LEASE_HEARTBEAT_INTERVAL_SEC:-300}"
LEASE_ACQUIRED=0
LEASE_OWNER_PID="$$"
LEASE_HEARTBEAT_PID=""
LEASE_HEARTBEAT_FAILURE_FILE=""
LEASE_HEARTBEAT_WAIT_FD=""
LEASE_HEARTBEAT_WAKE_FD=""
LEASE_HEARTBEAT_WAKER_PROCESS_PID=""
MAX_GROUPS_OVERRIDE="${SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS:-}"
MAX_GROUPS="${MAX_GROUPS_OVERRIDE:-32}"
AUTOMATION_CONTEXT="${SHEIN_BI_MARKETING_AUTOMATION_CONTEXT:-}"
EXECUTION_LOCATION="${SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION:-cloud}"
CLOUD_FALLBACK_ENABLED="${SHEIN_BI_MARKETING_CLOUD_FALLBACK_ENABLED:-false}"
FALLBACK_MIN_START_BUDGET_SEC="${SHEIN_BI_MARKETING_REPAIR_MIN_START_BUDGET_SEC:-900}"
FALLBACK_GRACEFUL_CUTOFF_EPOCH="${SHEIN_BI_MARKETING_REPAIR_GRACEFUL_CUTOFF_EPOCH:-}"
FALLBACK_OUTER_HARD_DEADLINE_EPOCH="${SHEIN_BI_MARKETING_REPAIR_SLOT_HARD_DEADLINE_EPOCH:-}"
CONTINUATION_MODE=0
IMMEDIATE_CONTINUATION_MODE="${SHEIN_BI_MARKETING_IMMEDIATE_CONTINUATION:-0}"
RESUME_RECEIPT="${SHEIN_BI_MARKETING_REPAIR_RESUME_RECEIPT:-/srv/shein-bi/runtime/marketing-repair-resume/marketing-repair-${DATE}.json}"
IMMEDIATE_AUTHORIZATION_FILE="${SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE:-/srv/shein-bi/marketing-repair-immediate/authorization.json}"
IMMEDIATE_RUN_OVERRIDE="${SHEIN_BI_MARKETING_IMMEDIATE_RUN:-}"
IMMEDIATE_AUTHORIZATION_PRESENT=0
if [[ -e "$IMMEDIATE_AUTHORIZATION_FILE" || -L "$IMMEDIATE_AUTHORIZATION_FILE" ]]; then
  IMMEDIATE_AUTHORIZATION_PRESENT=1
fi
if (( IMMEDIATE_AUTHORIZATION_PRESENT == 1 )); then
  IMMEDIATE_MODE=1
elif [[ -z "$IMMEDIATE_RUN_OVERRIDE" || "$IMMEDIATE_RUN_OVERRIDE" == "false" ]]; then
  IMMEDIATE_MODE=0
elif [[ "$IMMEDIATE_RUN_OVERRIDE" == "true" ]]; then
  IMMEDIATE_MODE=1
else
  echo "[cloud_marketing_repair] invalid immediate-run flag: $IMMEDIATE_RUN_OVERRIDE" >&2
  exit 64
fi
IMMEDIATE_AUTHORIZATION_ID="${SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_ID:-}"
IMMEDIATE_AUTHORIZATION_FILE_SHA256="${SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE_SHA256:-}"
IMMEDIATE_RECEIPT_FILE="${SHEIN_BI_MARKETING_IMMEDIATE_RECEIPT_FILE:-}"
IMMEDIATE_RECEIPT_SHA256="${SHEIN_BI_MARKETING_IMMEDIATE_RECEIPT_SHA256:-}"
IMMEDIATE_AUTHORIZATION_DATE="${SHEIN_BI_MARKETING_IMMEDIATE_DATE:-}"
IMMEDIATE_QUEUE_STATE_SHA256="${SHEIN_BI_MARKETING_IMMEDIATE_QUEUE_STATE_SHA256:-}"
IMMEDIATE_QUEUE_FINGERPRINT="${SHEIN_BI_MARKETING_IMMEDIATE_QUEUE_FINGERPRINT:-}"
IMMEDIATE_SOURCE_GUARD_HASH="${SHEIN_BI_MARKETING_IMMEDIATE_SOURCE_GUARD_HASH:-}"
IMMEDIATE_MAX_GROUPS="${SHEIN_BI_MARKETING_IMMEDIATE_MAX_GROUPS:-}"
IMMEDIATE_GRACEFUL_CUTOFF_EPOCH="${SHEIN_BI_MARKETING_IMMEDIATE_GRACEFUL_CUTOFF_EPOCH:-}"
IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH="${SHEIN_BI_MARKETING_IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH:-}"
IMMEDIATE_REASON="${SHEIN_BI_MARKETING_IMMEDIATE_REASON:-}"
IMMEDIATE_RECEIPT_STATUS="${SHEIN_BI_MARKETING_IMMEDIATE_RECEIPT_STATUS:-}"
if [[ "$IMMEDIATE_CONTINUATION_MODE" == "1" ]]; then
  CONTINUATION_MODE=1
elif [[ "$IMMEDIATE_CONTINUATION_MODE" != "0" ]]; then
  echo "[cloud_marketing_repair] invalid immediate continuation flag: $IMMEDIATE_CONTINUATION_MODE" >&2
  exit 64
fi
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
  local active=() service probe_output probe_status state
  local show_output show_status line key value
  local active_state sub_state main_pid control_pid
  local active_state_count sub_state_count main_pid_count control_pid_count
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "[cloud_marketing_repair] ERROR systemctl is unavailable; busy-service admission cannot be proven inactive" >&2
    return 69
  fi
  for service in $BUSY_SERVICES; do
    if probe_output="$(systemctl is-active "$service" 2>&1)"; then
      probe_status=0
    else
      probe_status=$?
    fi
    state="${probe_output%%$'\n'*}"
    state="${state//$'\r'/}"
    case "$state" in
      inactive)
        if (( probe_status != 3 )); then
          echo "[cloud_marketing_repair] ERROR systemctl returned inactive with unexpected status=$probe_status service=$service" >&2
          return 69
        fi
        ;;
      active|activating|reloading|deactivating)
        active+=("$service:$state")
        ;;
      failed)
        if (( probe_status != 3 )); then
          echo "[cloud_marketing_repair] ERROR systemctl returned failed with unexpected status=$probe_status service=$service" >&2
          return 69
        fi
        if show_output="$(systemctl show --no-pager --property=ActiveState --property=SubState --property=MainPID --property=ControlPID "$service" 2>&1)"; then
          show_status=0
        else
          show_status=$?
        fi
        if (( show_status != 0 )); then
          echo "[cloud_marketing_repair] ERROR systemctl show failed service=$service status=$show_status output=${show_output:-empty}" >&2
          return 69
        fi
        active_state=""
        sub_state=""
        main_pid=""
        control_pid=""
        active_state_count=0
        sub_state_count=0
        main_pid_count=0
        control_pid_count=0
        while IFS= read -r line || [[ -n "$line" ]]; do
          line="${line//$'\r'/}"
          if [[ -z "$line" || "$line" != *=* ]]; then
            echo "[cloud_marketing_repair] ERROR failed service show format invalid service=$service line=${line:-empty}" >&2
            return 69
          fi
          key="${line%%=*}"
          value="${line#*=}"
          case "$key" in
            ActiveState) active_state="$value"; active_state_count=$((active_state_count + 1)) ;;
            SubState) sub_state="$value"; sub_state_count=$((sub_state_count + 1)) ;;
            MainPID) main_pid="$value"; main_pid_count=$((main_pid_count + 1)) ;;
            ControlPID) control_pid="$value"; control_pid_count=$((control_pid_count + 1)) ;;
            *)
              echo "[cloud_marketing_repair] ERROR failed service show returned unexpected field service=$service field=$key" >&2
              return 69
              ;;
          esac
        done <<< "$show_output"
        if (( active_state_count != 1 || sub_state_count != 1 || main_pid_count != 1 || control_pid_count != 1 )); then
          echo "[cloud_marketing_repair] ERROR failed service show fields missing or duplicated service=$service ActiveStateCount=$active_state_count SubStateCount=$sub_state_count MainPIDCount=$main_pid_count ControlPIDCount=$control_pid_count" >&2
          return 69
        fi
        if [[ "$active_state" != "failed" || "$sub_state" != "failed" ]]; then
          echo "[cloud_marketing_repair] ERROR failed service show state mismatch service=$service ActiveState=${active_state:-missing} SubState=${sub_state:-missing}" >&2
          return 69
        fi
        if [[ ! "$main_pid" =~ ^[0-9]+$ || ! "$control_pid" =~ ^[0-9]+$ ]]; then
          echo "[cloud_marketing_repair] ERROR failed service PID format invalid service=$service MainPID=${main_pid:-missing} ControlPID=${control_pid:-missing}" >&2
          return 69
        fi
        if [[ "$main_pid" != "0" || "$control_pid" != "0" ]]; then
          echo "[cloud_marketing_repair] ERROR failed service has non-zero PID service=$service MainPID=$main_pid ControlPID=$control_pid" >&2
          return 69
        fi
        ;;
      unknown)
        echo "[cloud_marketing_repair] ERROR busy-service probe is not trustworthy service=$service state=$state status=$probe_status" >&2
        return 69
        ;;
      *)
        echo "[cloud_marketing_repair] ERROR busy-service probe failed service=$service status=$probe_status output=${state:-empty}" >&2
        return 69
        ;;
    esac
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

processed_result_value() {
  local result_path="$1" field="$2" default_value="${3:-}"
  JSON_FILE="$ROOT/$result_path" JSON_FIELD="$field" JSON_DEFAULT="$default_value" node <<'NODE'
const fs = require('node:fs');
try {
  const value = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
  const row = Array.isArray(value?.processedThisRunResults) ? value.processedThisRunResults[0] : null;
  const field = process.env.JSON_FIELD;
  const result = row?.[field];
  if (result === undefined || result === null) process.stdout.write(process.env.JSON_DEFAULT || '');
  else if (typeof result === 'boolean') process.stdout.write(result ? '1' : '0');
  else process.stdout.write(String(result));
} catch {
  process.stdout.write(process.env.JSON_DEFAULT || '');
}
NODE
}

result_top_level_value() {
  local result_path="$1" field="$2" default_value="${3:-}"
  JSON_FILE="$ROOT/$result_path" JSON_FIELD="$field" JSON_DEFAULT="$default_value" node <<'NODE'
const fs = require('node:fs');
try {
  const value = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
  const result = value?.[process.env.JSON_FIELD];
  if (result === undefined || result === null) process.stdout.write(process.env.JSON_DEFAULT || '');
  else process.stdout.write(String(result));
} catch {
  process.stdout.write(process.env.JSON_DEFAULT || '');
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

settled_result_disposition() {
  local stage="$1" result_path="$2" expected_fingerprint="$3"
  JSON_FILE="$ROOT/$result_path" RESULT_STAGE="$stage" EXPECTED_FINGERPRINT="$expected_fingerprint" node <<'NODE'
const fs = require('node:fs');

function count(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function finish(value) {
  process.stdout.write(value);
  process.exit(0);
}

let doc;
try {
  doc = JSON.parse(fs.readFileSync(process.env.JSON_FILE, 'utf8'));
} catch {
  finish('incomplete');
}
if (!doc || typeof doc !== 'object' || Array.isArray(doc)
    || String(doc.workFingerprint || '') !== String(process.env.EXPECTED_FINGERPRINT || '')
    || !Array.isArray(doc.results)) {
  finish('incomplete');
}

const stage = process.env.RESULT_STAGE;
const results = doc.results;
const totals = doc.totals && typeof doc.totals === 'object' ? doc.totals : {};

if (stage === 'highClickSpecial') {
  const planned = count(totals.planned);
  const processed = count(totals.processed);
  const processedThisRun = count(totals.processedThisRun);
  const resumed = count(totals.resumedItems);
  const remaining = count(totals.remainingItems);
  const recoverable = count(totals.recoverablePending);
  const blocked = count(totals.blocked);
  const failed = count(totals.failed);
  if (doc.execute !== true || [planned, processed, processedThisRun, resumed, remaining, recoverable, blocked, failed].includes(null)) finish('incomplete');
  if (remaining > 0) finish('pending');
  if (processedThisRun !== 0 || processed !== results.length || resumed !== results.length || planned !== results.length || recoverable !== 0) finish('incomplete');
  const settled = results.every(row => row?.ok === true || (row?.terminal === true && [
    'login_terminal_blocker',
    'inventory_transaction_restore_failed',
    'submitted_without_exact_readback',
  ].includes(String(row?.classification || ''))));
  if (!settled) finish('incomplete');
  if (failed > 0) finish('failed');
  if (blocked > 0) finish('blocked');
  finish(results.every(row => row?.ok === true) ? 'completed' : 'incomplete');
}

if (stage === 'manualSpecialRestore') {
  const processed = count(totals.processed);
  const processedThisRun = count(totals.processedThisRun);
  const resumed = count(totals.resumedItems);
  const remaining = count(totals.remainingItems);
  if (doc.dryRunOnly !== false || [processed, processedThisRun, resumed, remaining].includes(null)) finish('incomplete');
  if (remaining > 0) finish('pending');
  if (processedThisRun !== 0 || processed !== results.length || resumed !== results.length) finish('incomplete');
  if (!results.every(row => row?.ok === true || row?.terminalBlocked === true)) finish('incomplete');
  if (results.some(row => row?.terminalBlocked === true)) finish('blocked');
  finish(results.every(row => row?.ok === true) ? 'completed' : 'failed');
}

if (stage === 'driftRepair') {
  const deferred = count(doc.deferredGroups);
  // Older settled empty-result documents predate resumedGroups. Accept that
  // one unambiguous zero-result form while retaining strict evidence for every
  // non-empty crash-resume result.
  const resumed = count(doc.resumedGroups ?? (results.length === 0 ? 0 : null));
  const processed = count(totals.groupsProcessed);
  const completed = count(totals.completedGroups);
  const blocked = count(totals.businessBlockedGroups);
  const failed = count(totals.failedGroups);
  if (doc.dryRunOnly !== false || [deferred, resumed, processed, completed, blocked, failed].includes(null)) finish('incomplete');
  if (deferred > 0) finish('pending');
  if (doc.complete !== true || resumed !== results.length || processed !== results.length
      || completed + blocked + failed !== results.length) finish('incomplete');
  if (failed > 0) finish('failed');
  if (blocked > 0) finish('blocked');
  finish(completed === results.length ? 'completed' : 'incomplete');
}

if (stage === 'fallbackRepair') {
  const deferred = count(doc.deferredGroups);
  const resumed = count(doc.resumedGroups);
  const processed = count(totals.storesProcessed);
  const blocked = count(totals.storesBlocked);
  const failed = count(totals.storesFailed);
  if (doc.dryRunOnly !== false || [deferred, resumed, processed, blocked, failed].includes(null)) finish('incomplete');
  if (deferred > 0) finish('pending');
  if (doc.complete !== true || resumed !== results.length || processed !== results.length) finish('incomplete');
  const settled = results.every(row => row?.ok === true
    || (String(row?.status || '').startsWith('executed_subset_')
      && Number(row?.createdActivityId || 0) > 0
      && Array.isArray(row?.execute?.result?.desiredCoveredSkcs)
      && row.execute.result.desiredCoveredSkcs.length > 0)
    || (row?.blocked?.type === 'platform_or_inventory_blocked'
      && Array.isArray(row?.blocked?.blockedSkcs)
      && row.blocked.blockedSkcs.length > 0)
    || (row?.classification === 'submitted_without_exact_readback'
      && row?.terminal === true
      && row?.writeAttempted === true
      && row?.blocked?.type === 'submitted_without_exact_readback'));
  if (!settled) finish('incomplete');
  if (failed > 0) finish('failed');
  if (blocked > 0) finish('blocked');
  finish('completed');
}

finish('incomplete');
NODE
}

consume_group_budget() {
  local count="${1:-0}"
  [[ "$count" =~ ^[0-9]+$ ]] || count=0
  if (( count >= REMAINING_GROUPS )); then REMAINING_GROUPS=0; else REMAINING_GROUPS=$((REMAINING_GROUPS - count)); fi
}

lease_action() {
  node scripts/manage_browser_task_leases.mjs "$1" --root "$ROOT" --task "$LEASE_TASK" --run-id "$RUN_ID" --owner-pid "$LEASE_OWNER_PID" --ttl-sec "$LEASE_TTL_SEC" --group ALL
}

assert_browser_lease_healthy() {
  if [[ -n "$LEASE_HEARTBEAT_FAILURE_FILE" && -e "$LEASE_HEARTBEAT_FAILURE_FILE" ]]; then
    echo "[cloud_marketing_repair] ERROR browser lease heartbeat failed closed task=$LEASE_TASK runId=$RUN_ID" >&2
    return 75
  fi
  if [[ "$LEASE_ACQUIRED" == "1" && -n "$LEASE_HEARTBEAT_PID" ]] && ! kill -0 "$LEASE_HEARTBEAT_PID" 2>/dev/null; then
    echo "[cloud_marketing_repair] ERROR browser lease heartbeat process stopped unexpectedly task=$LEASE_TASK runId=$RUN_ID" >&2
    return 75
  fi
}

start_browser_lease_heartbeat() {
  if [[ ! "$LEASE_TTL_SEC" =~ ^[1-9][0-9]*$ || ! "$LEASE_HEARTBEAT_INTERVAL_SEC" =~ ^[1-9][0-9]*$ \
    || "$LEASE_HEARTBEAT_INTERVAL_SEC" -ge "$LEASE_TTL_SEC" ]]; then
    echo "[cloud_marketing_repair] ERROR lease heartbeat interval must be positive and shorter than TTL: interval=$LEASE_HEARTBEAT_INTERVAL_SEC ttl=$LEASE_TTL_SEC" >&2
    return 64
  fi
  LEASE_HEARTBEAT_FAILURE_FILE="$ROOT/state/browser_task_leases/.heartbeat-failed-${RUN_ID}"
  if ! mkdir -p -- "$ROOT/state/browser_task_leases"; then
    echo "[cloud_marketing_repair] ERROR could not prepare browser lease heartbeat directory" >&2
    return 75
  fi
  rm -f -- "$LEASE_HEARTBEAT_FAILURE_FILE"
  coproc LEASE_HEARTBEAT_WAKER { IFS= read -r wake_signal; printf '%s\n' "$wake_signal"; }
  LEASE_HEARTBEAT_WAKER_PROCESS_PID="$LEASE_HEARTBEAT_WAKER_PID"
  local coproc_read_fd="${LEASE_HEARTBEAT_WAKER[0]}"
  local coproc_write_fd="${LEASE_HEARTBEAT_WAKER[1]}"
  if ! exec {LEASE_HEARTBEAT_WAIT_FD}<&"$coproc_read_fd"; then
    kill "$LEASE_HEARTBEAT_WAKER_PROCESS_PID" 2>/dev/null || true
    wait "$LEASE_HEARTBEAT_WAKER_PROCESS_PID" 2>/dev/null || true
    LEASE_HEARTBEAT_WAKER_PROCESS_PID=""
    echo "[cloud_marketing_repair] ERROR could not duplicate browser lease heartbeat wait pipe" >&2
    return 75
  fi
  if ! exec {LEASE_HEARTBEAT_WAKE_FD}>&"$coproc_write_fd"; then
    exec {LEASE_HEARTBEAT_WAIT_FD}<&-
    LEASE_HEARTBEAT_WAIT_FD=""
    kill "$LEASE_HEARTBEAT_WAKER_PROCESS_PID" 2>/dev/null || true
    wait "$LEASE_HEARTBEAT_WAKER_PROCESS_PID" 2>/dev/null || true
    LEASE_HEARTBEAT_WAKER_PROCESS_PID=""
    echo "[cloud_marketing_repair] ERROR could not duplicate browser lease heartbeat wake pipe" >&2
    return 75
  fi
  exec {coproc_read_fd}<&-
  exec {coproc_write_fd}>&-
  (
    trap 'exit 0' TERM INT
    while true; do
      heartbeat_signal=""
      if IFS= read -r -t "$LEASE_HEARTBEAT_INTERVAL_SEC" heartbeat_signal <&"$LEASE_HEARTBEAT_WAIT_FD"; then
        [[ "$heartbeat_signal" == "stop" ]] && exit 0
        continue
      else
        wait_status=$?
      fi
      if (( wait_status <= 128 )); then
        printf '%s\n' "browser lease heartbeat wait failed status=$wait_status" >"$LEASE_HEARTBEAT_FAILURE_FILE"
        kill -TERM "$LEASE_OWNER_PID" 2>/dev/null || true
        exit 75
      fi
      if ! lease_action heartbeat >/dev/null; then
        printf '%s\n' "browser lease heartbeat failed at $(date -u +%FT%TZ)" >"$LEASE_HEARTBEAT_FAILURE_FILE"
        kill -TERM "$LEASE_OWNER_PID" 2>/dev/null || true
        exit 75
      fi
    done
  ) &
  LEASE_HEARTBEAT_PID="$!"
}

stop_browser_lease_heartbeat() {
  if [[ -n "$LEASE_HEARTBEAT_PID" ]]; then
    if [[ -n "$LEASE_HEARTBEAT_WAKE_FD" ]]; then
      printf 'stop\n' >&"$LEASE_HEARTBEAT_WAKE_FD" 2>/dev/null || true
    fi
    if kill -0 "$LEASE_HEARTBEAT_PID" 2>/dev/null; then
      kill "$LEASE_HEARTBEAT_PID" 2>/dev/null || true
    fi
    wait "$LEASE_HEARTBEAT_PID" 2>/dev/null || true
    LEASE_HEARTBEAT_PID=""
  fi
  if [[ -n "$LEASE_HEARTBEAT_WAIT_FD" ]]; then
    exec {LEASE_HEARTBEAT_WAIT_FD}<&-
    LEASE_HEARTBEAT_WAIT_FD=""
  fi
  if [[ -n "$LEASE_HEARTBEAT_WAKE_FD" ]]; then
    exec {LEASE_HEARTBEAT_WAKE_FD}>&-
    LEASE_HEARTBEAT_WAKE_FD=""
  fi
  if [[ -n "$LEASE_HEARTBEAT_WAKER_PROCESS_PID" ]]; then
    kill "$LEASE_HEARTBEAT_WAKER_PROCESS_PID" 2>/dev/null || true
    wait "$LEASE_HEARTBEAT_WAKER_PROCESS_PID" 2>/dev/null || true
    LEASE_HEARTBEAT_WAKER_PROCESS_PID=""
  fi
}

ensure_browser_lease() {
  if [[ "$LEASE_ACQUIRED" == "1" ]]; then
    return 0
  fi
  lease_action acquire || return $?
  LEASE_ACQUIRED=1
  if ! start_browser_lease_heartbeat; then
    lease_action release || true
    LEASE_ACQUIRED=0
    return 75
  fi
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
  local remaining now_epoch
  remaining="$(fallback_remaining_seconds)"
  if (( remaining < FALLBACK_MIN_START_BUDGET_SEC )); then
    now_epoch="$(date +%s)"
    if [[ "$FALLBACK_OUTER_HARD_DEADLINE_EPOCH" =~ ^[1-9][0-9]*$ ]] \
      && (( now_epoch < FALLBACK_OUTER_HARD_DEADLINE_EPOCH )); then
      CONTINUATION_MODE=1
      return 0
    fi
    defer_remaining_work "cloud emergency slot is outside the bounded continuation window; refuse all transaction work"
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
    if (( now_epoch < FALLBACK_OUTER_HARD_DEADLINE_EPOCH )); then
      CONTINUATION_MODE=1
      echo "[cloud_marketing_repair] graceful cutoff reached; only persisted recovery/compensation/readback continuations are permitted"
    else
      write_state deferred_to_local "cloud emergency fallback outer hard deadline elapsed; preserve the exact queue"
      exit 75
    fi
  fi
  if [[ "$IMMEDIATE_MODE" == "1" ]]; then
    echo "[cloud_marketing_repair] immediate authorization bypasses only the 20:45-22:55 clock gate; absolute deadline and group budget remain enforced"
    return 0
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

parse_immediate_consume_output() {
  local output="$1"
  local -a fields=()
  if ! mapfile -t fields < <(printf '%s' "$output" | node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(0, "utf8"));
const fields = [
  value.authorizationId,
  value.authorizationFileSha256,
  value.consumedReceiptFile,
  value.consumedReceiptSha256,
  value.date,
  value.queueStateSha256,
  value.queueFingerprint,
  value.sourceGuardHash,
  value.maxGroups,
  value.gracefulCutoffEpoch,
  value.outerHardDeadlineEpoch,
  value.reason,
];
if (fields.some(value => value === undefined || value === null || /[\r\n]/.test(String(value)))) {
  throw new Error("immediate consume output is incomplete or contains unsafe fields");
}
process.stdout.write(fields.map(value => String(value)).join("\n"));
'); then
    echo "[cloud_marketing_repair] immediate consume output could not be parsed" >&2
    return 64
  fi
  if [[ "${#fields[@]}" -ne 12 ]]; then
    echo "[cloud_marketing_repair] immediate consume output has an invalid field count" >&2
    return 64
  fi
  IMMEDIATE_AUTHORIZATION_ID="${fields[0]}"
  IMMEDIATE_AUTHORIZATION_FILE_SHA256="${fields[1]}"
  IMMEDIATE_RECEIPT_FILE="${fields[2]}"
  IMMEDIATE_RECEIPT_SHA256="${fields[3]}"
  IMMEDIATE_AUTHORIZATION_DATE="${fields[4]}"
  IMMEDIATE_QUEUE_STATE_SHA256="${fields[5]}"
  IMMEDIATE_QUEUE_FINGERPRINT="${fields[6]}"
  IMMEDIATE_SOURCE_GUARD_HASH="${fields[7]}"
  IMMEDIATE_MAX_GROUPS="${fields[8]}"
  IMMEDIATE_GRACEFUL_CUTOFF_EPOCH="${fields[9]}"
  IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH="${fields[10]}"
  IMMEDIATE_REASON="${fields[11]}"
}

verify_immediate_authorization() {
  [[ "$IMMEDIATE_MODE" == "1" ]] || return 0
  local verification_status=0 verification_output
  if [[ "$IMMEDIATE_CONTINUATION_MODE" == "1" ]]; then
    if verification_output="$(node "$ROOT/scripts/manage_cloud_marketing_immediate_run.mjs" verify-continuation \
        --date "$DATE" --queue "$QUEUE_FILE" --root "$ROOT" --time-zone "$TZ_NAME" \
        --receipt-file "$IMMEDIATE_RECEIPT_FILE" \
        --expected-receipt-sha256 "$IMMEDIATE_RECEIPT_SHA256" \
        --expected-authorization-id "$IMMEDIATE_AUTHORIZATION_ID" \
        --expected-queue-state-sha256 "$IMMEDIATE_QUEUE_STATE_SHA256" \
        --expected-queue-fingerprint "$IMMEDIATE_QUEUE_FINGERPRINT" \
        --expected-source-guard-hash "$IMMEDIATE_SOURCE_GUARD_HASH" \
        --expected-max-groups "$IMMEDIATE_MAX_GROUPS" \
        --expected-graceful-cutoff-epoch "$IMMEDIATE_GRACEFUL_CUTOFF_EPOCH" \
        --expected-outer-hard-deadline-epoch "$IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH" \
        --expected-reason "$IMMEDIATE_REASON")"; then
      :
    else
      verification_status=$?
      echo "[cloud_marketing_repair] immutable continuation receipt verification failed status=$verification_status" >&2
      return "$verification_status"
    fi
    if ! printf '%s' "$verification_output" | env \
        EXPECTED_RECEIPT="$IMMEDIATE_RECEIPT_FILE" EXPECTED_RECEIPT_SHA="$IMMEDIATE_RECEIPT_SHA256" \
        EXPECTED_STATUS="$IMMEDIATE_RECEIPT_STATUS" node -e '
const fs=require("node:fs");const v=JSON.parse(fs.readFileSync(0,"utf8"));
if(v.continuation!==true||v.receiptFile!==process.env.EXPECTED_RECEIPT||v.receiptSha256!==process.env.EXPECTED_RECEIPT_SHA||v.status!==process.env.EXPECTED_STATUS)throw new Error("continuation receipt drift");'; then
      echo "[cloud_marketing_repair] immutable continuation receipt differs from wrapper binding" >&2
      return 64
    fi
    if [[ -z "$MAX_GROUPS_OVERRIDE" ]]; then MAX_GROUPS="$IMMEDIATE_MAX_GROUPS"; fi
    if [[ "$MAX_GROUPS" != "$IMMEDIATE_MAX_GROUPS" || "$DATE" != "$IMMEDIATE_AUTHORIZATION_DATE" \
      || "$CLOUD_FALLBACK_ENABLED" != "true" \
      || "$FALLBACK_GRACEFUL_CUTOFF_EPOCH" != "$IMMEDIATE_GRACEFUL_CUTOFF_EPOCH" \
      || "$FALLBACK_OUTER_HARD_DEADLINE_EPOCH" != "$IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH" ]]; then
      echo "[cloud_marketing_repair] immutable continuation does not bind this worker/date/deadline" >&2
      return 64
    fi
    IMMEDIATE_AUTHORIZATION_CONSUMED=1
    CONTINUATION_MODE=1
    echo "[cloud_marketing_repair] immutable claimed/consumed receipt revalidated; continuation-only mode"
    return 0
  fi
  if verification_output="$(node "$ROOT/scripts/manage_cloud_marketing_immediate_run.mjs" verify-issued \
      --date "$DATE" --queue "$QUEUE_FILE" --root "$ROOT" --time-zone "$TZ_NAME" \
      --authorization-file "$IMMEDIATE_AUTHORIZATION_FILE")"; then
    :
  else
    verification_status=$?
    echo "[cloud_marketing_repair] immediate authorization pending verification failed status=$verification_status" >&2
    return "$verification_status"
  fi
  if ! printf '%s' "$verification_output" | \
      env \
      IMMEDIATE_EXPECTED_ID="$IMMEDIATE_AUTHORIZATION_ID" \
      IMMEDIATE_EXPECTED_FILE_SHA="$IMMEDIATE_AUTHORIZATION_FILE_SHA256" \
      IMMEDIATE_EXPECTED_DATE="${IMMEDIATE_AUTHORIZATION_DATE:-$DATE}" \
      IMMEDIATE_EXPECTED_QUEUE_SHA="${IMMEDIATE_QUEUE_STATE_SHA256:-}" \
      IMMEDIATE_EXPECTED_QUEUE_FINGERPRINT="${IMMEDIATE_QUEUE_FINGERPRINT:-}" \
      IMMEDIATE_EXPECTED_SOURCE_GUARD_HASH="${IMMEDIATE_SOURCE_GUARD_HASH:-}" \
      IMMEDIATE_EXPECTED_MAX_GROUPS="${IMMEDIATE_MAX_GROUPS:-}" \
      IMMEDIATE_EXPECTED_GRACEFUL="${IMMEDIATE_GRACEFUL_CUTOFF_EPOCH:-}" \
      IMMEDIATE_EXPECTED_OUTER="${IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH:-}" \
      IMMEDIATE_EXPECTED_REASON="${IMMEDIATE_REASON:-}" \
      node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(0, "utf8"));
const expected = {
  authorizationId: process.env.IMMEDIATE_EXPECTED_ID,
  authorizationFileSha256: process.env.IMMEDIATE_EXPECTED_FILE_SHA,
  date: process.env.IMMEDIATE_EXPECTED_DATE,
  queueStateSha256: process.env.IMMEDIATE_EXPECTED_QUEUE_SHA,
  queueFingerprint: process.env.IMMEDIATE_EXPECTED_QUEUE_FINGERPRINT,
  sourceGuardHash: process.env.IMMEDIATE_EXPECTED_SOURCE_GUARD_HASH,
  maxGroups: process.env.IMMEDIATE_EXPECTED_MAX_GROUPS,
  gracefulCutoffEpoch: process.env.IMMEDIATE_EXPECTED_GRACEFUL,
  outerHardDeadlineEpoch: process.env.IMMEDIATE_EXPECTED_OUTER,
  reason: process.env.IMMEDIATE_EXPECTED_REASON,
};
for (const [key, wanted] of Object.entries(expected)) {
  if (wanted && String(value[key]) !== String(wanted)) throw new Error(`immediate pending field drift: ${key}`);
}
process.stdout.write("ok");
'; then
    echo "[cloud_marketing_repair] immediate authorization pending metadata differs from wrapper verification" >&2
    return 64
  fi
  IMMEDIATE_AUTHORIZATION_ID="$(printf '%s' "$verification_output" | node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(v.authorizationId));')"
  IMMEDIATE_AUTHORIZATION_FILE_SHA256="$(printf '%s' "$verification_output" | node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(v.authorizationFileSha256));')"
  IMMEDIATE_AUTHORIZATION_DATE="$(printf '%s' "$verification_output" | node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(v.date));')"
  IMMEDIATE_QUEUE_STATE_SHA256="$(printf '%s' "$verification_output" | node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(v.queueStateSha256));')"
  IMMEDIATE_QUEUE_FINGERPRINT="$(printf '%s' "$verification_output" | node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(v.queueFingerprint));')"
  IMMEDIATE_SOURCE_GUARD_HASH="$(printf '%s' "$verification_output" | node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(v.sourceGuardHash));')"
  IMMEDIATE_MAX_GROUPS="$(printf '%s' "$verification_output" | node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(v.maxGroups));')"
  IMMEDIATE_GRACEFUL_CUTOFF_EPOCH="$(printf '%s' "$verification_output" | node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(v.gracefulCutoffEpoch));')"
  IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH="$(printf '%s' "$verification_output" | node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(v.outerHardDeadlineEpoch));')"
  IMMEDIATE_REASON="$(printf '%s' "$verification_output" | node -e 'const fs=require("node:fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(v.reason));')"
  if [[ -z "$MAX_GROUPS_OVERRIDE" ]]; then MAX_GROUPS="$IMMEDIATE_MAX_GROUPS"; fi
  if [[ "$MAX_GROUPS" != "$IMMEDIATE_MAX_GROUPS" ]]; then
    echo "[cloud_marketing_repair] immediate authorization maxGroups differs from worker execution budget" >&2
    return 64
  fi
  if [[ "$DATE" != "$IMMEDIATE_AUTHORIZATION_DATE" || "$CLOUD_FALLBACK_ENABLED" != "true" ]]; then
    echo "[cloud_marketing_repair] immediate authorization is not bound to this cloud worker/date" >&2
    return 64
  fi
  if [[ ! "$FALLBACK_MIN_START_BUDGET_SEC" =~ ^[1-9][0-9]*$ ]] || (( FALLBACK_MIN_START_BUDGET_SEC < 900 )); then
    echo "[cloud_marketing_repair] immediate authorization minimum group budget is invalid" >&2
    return 64
  fi
  if [[ "$FALLBACK_GRACEFUL_CUTOFF_EPOCH" != "$IMMEDIATE_GRACEFUL_CUTOFF_EPOCH" \
    || "$FALLBACK_OUTER_HARD_DEADLINE_EPOCH" != "$IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH" ]]; then
    echo "[cloud_marketing_repair] immediate authorization deadlines differ from worker binding" >&2
    return 64
  fi
  echo "[cloud_marketing_repair] immediate authorization revalidated without consuming the pending source"
}

consume_immediate_authorization_locked() {
  [[ "$IMMEDIATE_MODE" == "1" ]] || return 0
  if [[ "$IMMEDIATE_CONTINUATION_MODE" == "1" ]]; then
    IMMEDIATE_AUTHORIZATION_CONSUMED=1
    CONTINUATION_MODE=1
    echo "[cloud_marketing_repair] immutable continuation receipt already owns authorization; no reconsume"
    return 0
  fi
  [[ "${IMMEDIATE_AUTHORIZATION_CONSUMED:-0}" == "1" ]] && return 0
  local consume_output consume_status
  local expected_authorization_id="$IMMEDIATE_AUTHORIZATION_ID"
  local expected_authorization_file_sha256="$IMMEDIATE_AUTHORIZATION_FILE_SHA256"
  local expected_authorization_date="$IMMEDIATE_AUTHORIZATION_DATE"
  local expected_queue_state_sha256="$IMMEDIATE_QUEUE_STATE_SHA256"
  local expected_queue_fingerprint="$IMMEDIATE_QUEUE_FINGERPRINT"
  local expected_source_guard_hash="$IMMEDIATE_SOURCE_GUARD_HASH"
  local expected_max_groups="$IMMEDIATE_MAX_GROUPS"
  local expected_graceful_cutoff_epoch="$IMMEDIATE_GRACEFUL_CUTOFF_EPOCH"
  local expected_outer_hard_deadline_epoch="$IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH"
  local expected_reason="$IMMEDIATE_REASON"
  if consume_output="$(node "$ROOT/scripts/manage_cloud_marketing_immediate_run.mjs" consume \
      --date "$DATE" --queue "$QUEUE_FILE" --root "$ROOT" --time-zone "$TZ_NAME" \
      --authorization-file "$IMMEDIATE_AUTHORIZATION_FILE" \
      --expected-authorization-id "$expected_authorization_id" \
      --expected-authorization-file-sha256 "$expected_authorization_file_sha256" \
      --expected-queue-state-sha256 "$expected_queue_state_sha256" \
      --expected-queue-fingerprint "$expected_queue_fingerprint" \
      --expected-source-guard-hash "$expected_source_guard_hash" \
      --expected-max-groups "$expected_max_groups" \
      --expected-graceful-cutoff-epoch "$expected_graceful_cutoff_epoch" \
      --expected-outer-hard-deadline-epoch "$expected_outer_hard_deadline_epoch" \
      --expected-reason "$expected_reason")"; then
    :
  else
    consume_status=$?
    echo "[cloud_marketing_repair] immediate authorization consume failed after admission status=$consume_status" >&2
    return "$consume_status"
  fi
  parse_immediate_consume_output "$consume_output" || return $?
  if [[ "$IMMEDIATE_AUTHORIZATION_ID" != "$expected_authorization_id" \
    || "$IMMEDIATE_AUTHORIZATION_FILE_SHA256" != "$expected_authorization_file_sha256" \
    || "$IMMEDIATE_AUTHORIZATION_DATE" != "$expected_authorization_date" \
    || "$IMMEDIATE_QUEUE_STATE_SHA256" != "$expected_queue_state_sha256" \
    || "$IMMEDIATE_QUEUE_FINGERPRINT" != "$expected_queue_fingerprint" \
    || "$IMMEDIATE_SOURCE_GUARD_HASH" != "$expected_source_guard_hash" \
    || "$IMMEDIATE_MAX_GROUPS" != "$expected_max_groups" \
    || "$IMMEDIATE_GRACEFUL_CUTOFF_EPOCH" != "$expected_graceful_cutoff_epoch" \
    || "$IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH" != "$expected_outer_hard_deadline_epoch" \
    || "$IMMEDIATE_REASON" != "$expected_reason" \
    || "$IMMEDIATE_AUTHORIZATION_DATE" != "$DATE" \
    || "$IMMEDIATE_MAX_GROUPS" != "$MAX_GROUPS" \
    || "$IMMEDIATE_GRACEFUL_CUTOFF_EPOCH" != "$FALLBACK_GRACEFUL_CUTOFF_EPOCH" \
    || "$IMMEDIATE_OUTER_HARD_DEADLINE_EPOCH" != "$FALLBACK_OUTER_HARD_DEADLINE_EPOCH" ]]; then
    echo "[cloud_marketing_repair] consumed authorization differs from admitted worker binding" >&2
    return 64
  fi
  local verify_status=0
  if node "$ROOT/scripts/manage_cloud_marketing_immediate_run.mjs" verify-consumed \
      --date "$DATE" --queue "$QUEUE_FILE" --root "$ROOT" --time-zone "$TZ_NAME" \
      --receipt-file "$IMMEDIATE_RECEIPT_FILE" \
      --expected-authorization-id "$expected_authorization_id" \
      --expected-queue-state-sha256 "$expected_queue_state_sha256" \
      --expected-queue-fingerprint "$expected_queue_fingerprint" \
      --expected-source-guard-hash "$expected_source_guard_hash" \
      --expected-max-groups "$expected_max_groups" \
      --expected-graceful-cutoff-epoch "$expected_graceful_cutoff_epoch" \
      --expected-outer-hard-deadline-epoch "$expected_outer_hard_deadline_epoch" \
      --expected-reason "$expected_reason" \
      --expected-receipt-sha256 "$IMMEDIATE_RECEIPT_SHA256"; then
    :
  else
    verify_status=$?
    echo "[cloud_marketing_repair] consumed authorization receipt failed terminal verification status=$verify_status" >&2
    return "$verify_status"
  fi
  IMMEDIATE_AUTHORIZATION_CONSUMED=1
  echo "[cloud_marketing_repair] immediate authorization consumed after all admission and locked queue/registry checks"
}

on_exit() {
  local status="$?" lease_release_status=0 lock_release_status=0
  trap - EXIT
  set +e
  if [[ "$LEASE_ACQUIRED" == "1" ]]; then
    cleanup_store_browsers
    stop_browser_lease_heartbeat
    if lease_action release; then
      LEASE_ACQUIRED=0
    else
      lease_release_status=$?
      echo "[cloud_marketing_repair] ERROR browser lease release failed status=$lease_release_status task=$LEASE_TASK runId=$RUN_ID" >&2
    fi
  fi
  if [[ -n "$LEASE_HEARTBEAT_FAILURE_FILE" ]]; then
    rm -f -- "$LEASE_HEARTBEAT_FAILURE_FILE"
  fi
  if release_repair_critical_locks; then
    :
  else
    lock_release_status=$?
  fi
  if (( lease_release_status != 0 )); then
    write_state failed "browser lease release failed after bounded worker completion status=$lease_release_status" || true
    if (( status == 0 )); then status=75; fi
  elif (( lock_release_status != 0 && status == 0 )); then
    status=75
  fi
  exit "$status"
}

STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
RUN_ID="${SHEIN_BI_MARKETING_REPAIR_RUN_ID:-$(node -e 'console.log(require("node:crypto").randomUUID())')}"
LOG_FILE="$LOG_DIR/marketing-repair-${DATE}-${STAMP}.log"
GUARD_STAGE_DIR="$STATE_DIR/report-staging/${DATE}/${RUN_ID}"
GUARD_INPUT_OUT="$GUARD_OUT"
PRICE_LEADS_FILE="${SHEIN_BI_MARKETING_PRICE_LEADS_FILE:-$ROOT/outputs/bi-portal/marketing-price-leads.json}"
PRICE_LEADS_STAGE_FILE="$GUARD_STAGE_DIR/marketing-price-leads.json"
trap on_exit EXIT
if verify_immediate_authorization; then
  :
else
  status=$?
  exit "$status"
fi
mkdir -p "$LOG_DIR" "$STATE_DIR/repair-queues" "$ALERT_DIR"
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
if acquire_repair_critical_locks; then
  :
else
  status=$?
  write_state deferred_to_local "could not acquire artifact/registry/queue critical locks before queue pair capture status=$status"
  exit "$status"
fi
if verify_immediate_authorization; then
  :
else
  status=$?
  release_repair_critical_locks || true
  echo "[cloud_marketing_repair] immediate authorization changed before locked queue capture; refusing to consume a different queue" >&2
  exit "$status"
fi
if refresh_queue_pair_locked && assert_current_queue_registry_locked; then
  QUEUE_STATUS="$(queue_value 'j.status' missing)"
else
  status=$?
  release_repair_critical_locks || true
  if (( status == QUEUE_CONFLICT_STATUS )); then
    mark_queue_conflict initial before-execution
  else
    write_state failed "initial queue/registry capture failed status=$status"
  fi
  exit "$status"
fi
release_repair_critical_locks || true
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
ACTIVE_BUSY=""
if (( IS_CLOUD_EXECUTION == 1 || IMMEDIATE_MODE == 1 )); then
  if ACTIVE_BUSY="$(active_busy_services)"; then
    :
  else
    status=$?
    write_state deferred_to_local "busy-service admission probe failed closed status=$status; exact queue and immediate authorization preserved"
    echo "[cloud_marketing_repair] DEFER TO LOCAL busy-service admission probe failed status=$status" >&2
    exit "$status"
  fi
  if [[ -n "$ACTIVE_BUSY" ]]; then
    write_state deferred_to_local "cloud host is busy; keep the exact queue for local-browser continuation: $ACTIVE_BUSY"
    echo "[cloud_marketing_repair] DEFER TO LOCAL busy services active: $ACTIVE_BUSY"
    exit 75
  fi
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
validate_cloud_fallback_window

EXECUTOR_DEADLINE_ARGS=()
EXECUTOR_CONTINUATION_ARGS=()
if [[ -n "$FALLBACK_GRACEFUL_CUTOFF_EPOCH" || -n "$FALLBACK_OUTER_HARD_DEADLINE_EPOCH" ]]; then
  if [[ ! "$FALLBACK_GRACEFUL_CUTOFF_EPOCH" =~ ^[1-9][0-9]*$ ]] \
    || [[ ! "$FALLBACK_OUTER_HARD_DEADLINE_EPOCH" =~ ^[1-9][0-9]*$ ]]; then
    echo "[cloud_marketing_repair] executor deadline pair is incomplete or invalid" >&2
    exit 64
  fi
  EXECUTOR_DEADLINE_ARGS=(
    --graceful-cutoff-epoch "$FALLBACK_GRACEFUL_CUTOFF_EPOCH"
    --outer-hard-deadline-epoch "$FALLBACK_OUTER_HARD_DEADLINE_EPOCH"
  )
fi

refresh_executor_continuation_args() {
  ensure_fallback_start_budget
  if [[ "$CONTINUATION_MODE" == "1" ]]; then
    EXECUTOR_CONTINUATION_ARGS=(--continuation)
  else
    EXECUTOR_CONTINUATION_ARGS=()
  fi
}

REMAINING_GROUPS="$MAX_GROUPS"

# A local runner may have completed writes without mutating the cloud queue.
# The emergency cloud slot therefore rebuilds the exact queue from a fresh
# browserless 19-store snapshot before it is allowed to open any cloud Chrome.
# This prevents replaying work already completed on the owner's computer.
if (( IS_CLOUD_EXECUTION == 1 )) && [[ "$CLOUD_FALLBACK_ENABLED" == "true" ]]; then
  if [[ "$IMMEDIATE_MODE" == "1" ]]; then
    echo "[cloud_marketing_repair] immediate authorization has an exact queue identity; skip the no-rescan resume/rebuild phase"
  elif [[ -f "$RESUME_RECEIPT" ]]; then
    echo "[cloud_marketing_repair] consuming exact no-rescan resume receipt=$RESUME_RECEIPT"
    node scripts/marketing/manage_marketing_queue_resume_receipt.mjs consume \
      --queue "$QUEUE_FILE" --receipt "$RESUME_RECEIPT"
  else
    run_final_readback
  fi
  QUEUE_STATUS="$(queue_value 'j.status' pending)"
  if [[ "$QUEUE_STATUS" == "completed" ]]; then
    if [[ "$IMMEDIATE_MODE" == "1" ]]; then
      write_state ok "immediate authorization found the exact queue already completed; no rescan was performed"
    else
      write_state ok "local execution already covered all authorized repairs; cloud fallback only performed final readback"
    fi
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
  refresh_executor_continuation_args
fi

ensure_browser_lease

# Immediate authorization is consumed only after the service lock, busy-host
# check, reserved-minute check, exact queue/registry capture, and browser lease
# acquisition all pass. Reacquire the complete critical lock set immediately
# before the one-time claim, then release it only after the claim and receipt
# readback are closed. If consume fails, on_exit releases the acquired lease.
if [[ "$IMMEDIATE_MODE" == "1" ]]; then
  if acquire_repair_critical_locks; then
    :
  else
    status=$?
    write_state deferred_to_local "could not reacquire artifact/registry/queue locks before immediate authorization consume status=$status"
    exit "$status"
  fi
  if refresh_queue_pair_locked && assert_current_queue_registry_locked; then
    QUEUE_STATUS="$(queue_value 'j.status' missing)"
  else
    status=$?
    release_repair_critical_locks || true
    if (( status == QUEUE_CONFLICT_STATUS )); then
      mark_queue_conflict immediate-before-consume
    else
      write_state failed "immediate queue/registry revalidation failed before consume status=$status"
    fi
    exit "$status"
  fi
  if [[ "$QUEUE_STATUS" == "completed" || "$QUEUE_STATUS" == "blocked" ]]; then
    release_repair_critical_locks || true
    echo "[cloud_marketing_repair] exact queue became terminal before immediate consume; source authorization remains available"
    exit 0
  fi
  if consume_immediate_authorization_locked; then
    :
  else
    status=$?
    release_repair_critical_locks || true
    exit "$status"
  fi
  release_repair_critical_locks || true
fi

HIGH_CLICK_STATUS="$(queue_value 'j.stages?.highClickSpecial?.status' not_required)"
while (( REMAINING_GROUPS > 0 )) && [[ "$HIGH_CLICK_STATUS" != "not_required" && "$HIGH_CLICK_STATUS" != "completed" && "$HIGH_CLICK_STATUS" != "blocked" ]]; do
  assert_browser_lease_healthy || exit $?
  ensure_fallback_start_budget
  WORK_FINGERPRINT="$(queue_value 'j.stages?.highClickSpecial?.workFingerprint' '')"
  export SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH="$WORK_FINGERPRINT"
  GUARD_PATH="$ROOT/$(queue_value 'j.sourceGuard' '')"
  HIGH_CLICK_PLAN_PATH="$ROOT/$(queue_value 'j.stages?.highClickSpecial?.planPath' '')"
  RESULT_PATH="outputs/reports/high-click-low-conversion-special-execution-${DATE}.json"
  begin_stage_critical_section highClickSpecial || { status=$?; exit "$status"; }
  set +e
  node scripts/marketing/batch_apply_high_click_special_discounts.mjs \
    --date "$DATE" --guard "$GUARD_PATH" --plan "$HIGH_CLICK_PLAN_PATH" \
    --execute --max-items 1 --result "$ROOT/$RESULT_PATH" \
    --expected-work-fingerprint "$WORK_FINGERPRINT" \
    "${EXECUTOR_CONTINUATION_ARGS[@]}" "${EXECUTOR_DEADLINE_ARGS[@]}"
  status=$?
  set -e
  PROCESSED_ITEMS="$(processed_items_this_run "$RESULT_PATH")"
  if [[ "$PROCESSED_ITEMS" =~ ^[0-9]+$ ]] && (( PROCESSED_ITEMS == 0 )); then
    RESUME_DISPOSITION="$(settled_result_disposition highClickSpecial "$RESULT_PATH" "$WORK_FINGERPRINT")"
    case "$RESUME_DISPOSITION" in
      completed)
        update_stage highClickSpecial completed true "same-fingerprint persistent result already settled successfully before queue update; no replay" "$RESULT_PATH"
        HIGH_CLICK_STATUS="$(queue_value 'j.stages?.highClickSpecial?.status' not_required)"
        continue
        ;;
      blocked)
        update_stage highClickSpecial blocked false "same-fingerprint persistent result contains terminal item evidence; no replay" "$RESULT_PATH"
        write_state blocked "high-click persistent result closed with terminal item evidence"
        HIGH_CLICK_STATUS="$(queue_value 'j.stages?.highClickSpecial?.status' not_required)"
        continue
        ;;
      failed)
        update_stage highClickSpecial failed false "same-fingerprint persistent result contains explicit failure evidence; no replay" "$RESULT_PATH"
        write_state failed "high-click persistent result closed with explicit failure evidence"
        exit 2
        ;;
      incomplete)
        update_stage highClickSpecial failed false "processedThisRun=0 but persistent result evidence is incomplete or inconsistent" "$RESULT_PATH"
        write_state failed "high-click persistent result could not safely close crash-resume"
        exit 66
        ;;
    esac
  fi
  if [[ "$status" -eq 4 && "$PROCESSED_ITEMS" == "0" ]]; then
    update_stage highClickSpecial pending false "recoverable items were attempted once in this service run; deferred without replay while independent stages continue" "$RESULT_PATH"
    write_state pending "high-click recoverable items deferred to the next fresh service run; continuing independent repair stages"
    break
  fi
  if [[ ! "$PROCESSED_ITEMS" =~ ^[1-9][0-9]*$ ]] || (( PROCESSED_ITEMS != 1 )); then
    update_stage highClickSpecial failed false "single-item executor produced no exact new item status=$status" "$RESULT_PATH"
    write_state failed "high-click single-item executor made no durable progress status=$status"
    exit 66
  fi
  consume_group_budget "$PROCESSED_ITEMS"
  BLOCKED_TARGETS="$(result_total "$RESULT_PATH" blocked)"
  FAILED_TARGETS="$(result_total "$RESULT_PATH" failed)"
  REMAINING_ITEMS="$(result_total "$RESULT_PATH" remainingItems)"
  if (( FAILED_TARGETS > 0 )); then
    update_stage highClickSpecial failed false "single-item execute/readback failed status=$status" "$RESULT_PATH"
    write_state failed "high-click special execute failed status=$status"
    exit "$status"
  fi
  if (( REMAINING_ITEMS > 0 )); then
    if [[ "$status" -ne 0 && "$status" -ne 2 && "$status" -ne 3 ]]; then
      update_stage highClickSpecial failed false "unexpected single-item executor status=$status" "$RESULT_PATH"
      write_state failed "high-click special execute failed status=$status"
      exit "$status"
    fi
    update_stage highClickSpecial pending false "one exact item reached terminal readback or prewrite blocker; serial consumer continuing" "$RESULT_PATH"
  else
    if (( BLOCKED_TARGETS > 0 )); then
      update_stage highClickSpecial blocked false "all items accounted; one or more exact items are terminal prewrite blockers" "$RESULT_PATH"
      write_state blocked "high-click special has terminal prewrite blockers after independent items completed"
    else
      update_stage highClickSpecial completed true "serial single-item execute and per-item live readback succeeded" "$RESULT_PATH"
    fi
  fi
  HIGH_CLICK_STATUS="$(queue_value 'j.stages?.highClickSpecial?.status' not_required)"
done

if (( REMAINING_GROUPS <= 0 )); then
  defer_remaining_work "bounded group budget consumed"
fi

MANUAL_STATUS="$(queue_value 'j.stages?.manualSpecialRestore?.status' not_required)"
while (( REMAINING_GROUPS > 0 )) && [[ "$MANUAL_STATUS" != "not_required" && "$MANUAL_STATUS" != "completed" && "$MANUAL_STATUS" != "blocked" ]]; do
  assert_browser_lease_healthy || exit $?
  refresh_executor_continuation_args
  export SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH="$(queue_value 'j.stages?.manualSpecialRestore?.workFingerprint || j.stages?.manualSpecialRestore?.inputFingerprint' '')"
  WORK_FINGERPRINT="$(queue_value 'j.stages?.manualSpecialRestore?.workFingerprint' '')"
  GUARD_PATH="$ROOT/$(queue_value 'j.sourceGuard' '')"
  MANUAL_PLAN_PATH="$ROOT/$(queue_value 'j.stages?.manualSpecialRestore?.planPath' '')"
  MANUAL_OUT_DIR="$(dirname "$MANUAL_PLAN_PATH")"
  RESULT_PATH="tmp/marketing-signup/manual-limited-discount-restore/${DATE}/manual-limited-discount-restore-result.json"
  begin_stage_critical_section manualSpecialRestore || { status=$?; exit "$status"; }
  set +e
  node scripts/marketing/batch_restore_manual_limited_discounts.mjs \
    --guard "$GUARD_PATH" --out-dir "$MANUAL_OUT_DIR" --skip-build --execute \
    --max-items 1 --result "$ROOT/$RESULT_PATH" \
    --expected-work-fingerprint "$WORK_FINGERPRINT" \
    "${EXECUTOR_CONTINUATION_ARGS[@]}" "${EXECUTOR_DEADLINE_ARGS[@]}"
  status=$?
  set -e
  PROCESSED_ITEMS="$(processed_items_this_run "$RESULT_PATH")"
  DEADLINE_DEFERRED="$(result_total "$RESULT_PATH" deadlineDeferred)"
  REMAINING_ITEMS="$(result_total "$RESULT_PATH" remainingItems)"
  TERMINAL_BLOCKED="$(processed_result_value "$RESULT_PATH" terminalBlocked 0)"
  RECOVERABLE_DEFERRED="$(processed_result_value "$RESULT_PATH" recoverableDeferred 0)"
  if [[ ! "$PROCESSED_ITEMS" =~ ^[0-9]+$ ]] || (( PROCESSED_ITEMS > 1 )); then
    update_stage manualSpecialRestore failed false "single-item executor produced an invalid processedThisRun count=$PROCESSED_ITEMS status=$status" "$RESULT_PATH"
    write_state failed "manual special single-item executor produced an invalid progress count status=$status"
    exit 66
  fi
  if (( PROCESSED_ITEMS == 1 )); then
    consume_group_budget "$PROCESSED_ITEMS"
  fi
  if (( PROCESSED_ITEMS == 0 )); then
    RESUME_DISPOSITION="$(settled_result_disposition manualSpecialRestore "$RESULT_PATH" "$WORK_FINGERPRINT")"
    case "$RESUME_DISPOSITION" in
      completed)
        update_stage manualSpecialRestore completed true "same-fingerprint persistent result already settled successfully before queue update; no replay" "$RESULT_PATH"
        MANUAL_STATUS="$(queue_value 'j.stages?.manualSpecialRestore?.status' not_required)"
        continue
        ;;
      blocked)
        update_stage manualSpecialRestore blocked false "same-fingerprint persistent result contains terminal manual blockers; no replay" "$RESULT_PATH"
        write_state blocked "manual-special persistent result closed with terminal blockers"
        MANUAL_STATUS="$(queue_value 'j.stages?.manualSpecialRestore?.status' not_required)"
        continue
        ;;
      failed)
        update_stage manualSpecialRestore failed false "same-fingerprint persistent result contains explicit failure evidence; no replay" "$RESULT_PATH"
        write_state failed "manual-special persistent result closed with explicit failure evidence"
        exit 2
        ;;
      incomplete)
        update_stage manualSpecialRestore failed false "processedThisRun=0 but persistent result evidence is incomplete or inconsistent" "$RESULT_PATH"
        write_state failed "manual-special persistent result could not safely close crash-resume"
        exit 66
        ;;
    esac
  fi
  if [[ "$status" -eq 4 && ( "$PROCESSED_ITEMS" == "0" || "$DEADLINE_DEFERRED" =~ ^[1-9][0-9]*$ || "$RECOVERABLE_DEFERRED" == "1" ) ]]; then
    update_stage manualSpecialRestore pending false "deadline or recoverable item deferred; no new item will start in this slot" "$RESULT_PATH"
    write_state pending "manual-special repair paused at the deadline/recoverable boundary; exact queue preserved"
    break
  fi
  if (( PROCESSED_ITEMS == 0 )); then
    update_stage manualSpecialRestore failed false "single-item executor produced no exact new item status=$status" "$RESULT_PATH"
    write_state failed "manual special single-item executor made no durable progress status=$status"
    exit 66
  fi
  if [[ "$status" -eq 2 && "$TERMINAL_BLOCKED" != "1" ]]; then
    update_stage manualSpecialRestore failed false "execute/readback failed status=$status" "$RESULT_PATH"
    write_state failed "manual special restore failed status=$status"
    exit "$status"
  fi
  if (( REMAINING_ITEMS > 0 )); then
    if [[ "$status" -ne 0 && "$status" -ne 2 && "$status" -ne 3 && "$status" -ne 4 ]]; then
      update_stage manualSpecialRestore failed false "unexpected single-item executor status=$status" "$RESULT_PATH"
      write_state failed "manual special restore failed status=$status"
      exit "$status"
    fi
    update_stage manualSpecialRestore pending false "one exact manual item reached terminal readback/blocker; serial consumer continuing" "$RESULT_PATH"
  elif [[ "$status" -eq 4 || "$TERMINAL_BLOCKED" == "1" ]]; then
    update_stage manualSpecialRestore blocked false "all exact manual items accounted; terminal business blockers were preserved" "$RESULT_PATH"
    write_state blocked "manual special restore completed with terminal business blockers"
  else
    update_stage manualSpecialRestore completed true "serial single-item execute and per-item live readback succeeded" "$RESULT_PATH"
  fi
  MANUAL_STATUS="$(queue_value 'j.stages?.manualSpecialRestore?.status' not_required)"
done

if (( REMAINING_GROUPS <= 0 )); then
  defer_remaining_work "bounded group budget consumed"
fi

DRIFT_STATUS="$(queue_value 'j.stages?.driftRepair?.status' not_required)"
while (( REMAINING_GROUPS > 0 )) && [[ "$DRIFT_STATUS" != "not_required" && "$DRIFT_STATUS" != "completed" && "$DRIFT_STATUS" != "blocked" ]]; do
  assert_browser_lease_healthy || exit $?
  refresh_executor_continuation_args
  WORK_FINGERPRINT="$(queue_value 'j.stages?.driftRepair?.workFingerprint' '')"
  export SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH="$WORK_FINGERPRINT"
  GUARD_PATH="$ROOT/$(queue_value 'j.sourceGuard' '')"
  RESULT_PATH="tmp/marketing-signup/limited-discount-rescue/batch-drift-fix-result-${DATE}.json"
  begin_stage_critical_section driftRepair || { status=$?; exit "$status"; }
  set +e
  node scripts/marketing/batch_fix_limited_discount_drift.mjs \
    --guard "$GUARD_PATH" --skip-build-plan --execute --max-groups 1 \
    --expected-work-fingerprint "$WORK_FINGERPRINT" \
    "${EXECUTOR_CONTINUATION_ARGS[@]}" "${EXECUTOR_DEADLINE_ARGS[@]}"
  status=$?
  set -e
  PROCESSED_GROUPS="$(new_groups_in_result "$RESULT_PATH")"
  DEADLINE_DEFERRED="$(result_top_level_value "$RESULT_PATH" deadlineDeferred 0)"
  if [[ ! "$PROCESSED_GROUPS" =~ ^[0-9]+$ ]] || (( PROCESSED_GROUPS > 1 )); then
    update_stage driftRepair failed false "single-group executor produced an invalid new-group count=$PROCESSED_GROUPS status=$status" "$RESULT_PATH"
    write_state failed "drift single-group executor produced an invalid progress count status=$status"
    exit 66
  fi
  if (( PROCESSED_GROUPS == 1 )); then
    consume_group_budget "$PROCESSED_GROUPS"
  fi
  if (( PROCESSED_GROUPS == 0 )); then
    RESUME_DISPOSITION="$(settled_result_disposition driftRepair "$RESULT_PATH" "$WORK_FINGERPRINT")"
    case "$RESUME_DISPOSITION" in
      completed)
        update_stage driftRepair completed true "same-fingerprint persistent result already settled successfully before queue update; no replay" "$RESULT_PATH"
        DRIFT_STATUS="$(queue_value 'j.stages?.driftRepair?.status' not_required)"
        continue
        ;;
      blocked)
        update_stage driftRepair blocked false "same-fingerprint persistent result contains terminal drift blockers; no replay" "$RESULT_PATH"
        write_state blocked "drift persistent result closed with terminal blockers"
        DRIFT_STATUS="$(queue_value 'j.stages?.driftRepair?.status' not_required)"
        continue
        ;;
      failed)
        update_stage driftRepair failed false "same-fingerprint persistent result contains explicit failure evidence; no replay" "$RESULT_PATH"
        write_state failed "drift persistent result closed with explicit failure evidence"
        exit 2
        ;;
      incomplete)
        update_stage driftRepair failed false "newGroups=0 but persistent result evidence is incomplete or inconsistent" "$RESULT_PATH"
        write_state failed "drift persistent result could not safely close crash-resume"
        exit 66
        ;;
    esac
  fi
  if [[ "$DEADLINE_DEFERRED" =~ ^[1-9][0-9]*$ ]]; then
    update_stage driftRepair pending false "deadline/recovery boundary reached; no new drift group will start in this slot" "$RESULT_PATH"
    write_state pending "drift repair paused at the deadline boundary; exact queue preserved"
    break
  fi
  if (( PROCESSED_GROUPS == 0 )); then
    update_stage driftRepair failed false "single-group executor produced no exact new group status=$status" "$RESULT_PATH"
    write_state failed "drift single-group executor made no durable progress status=$status"
    exit 66
  fi
  if [[ "$status" -eq 2 ]]; then
    update_stage driftRepair failed false "execute/readback failed status=$status" "$RESULT_PATH"
    write_state failed "drift repair failed status=$status"
    exit "$status"
  fi
  REMAINING_DRIFT_GROUPS="$(result_top_level_value "$RESULT_PATH" deferredGroups 0)"
  if (( REMAINING_DRIFT_GROUPS > 0 )); then
    if [[ "$status" -ne 0 && "$status" -ne 3 && "$status" -ne 4 ]]; then
      update_stage driftRepair failed false "unexpected single-group executor status=$status" "$RESULT_PATH"
      write_state failed "drift repair failed status=$status"
      exit "$status"
    fi
    update_stage driftRepair pending false "one exact drift group reached terminal readback/blocker; serial consumer continuing" "$RESULT_PATH"
  elif [[ "$status" -eq 4 ]]; then
    update_stage driftRepair blocked false "all exact drift groups accounted; terminal business blockers were preserved" "$RESULT_PATH"
    write_state blocked "drift repair completed with terminal business blockers"
  else
    update_stage driftRepair completed true "serial single-group execute and per-group readback succeeded" "$RESULT_PATH"
  fi
  DRIFT_STATUS="$(queue_value 'j.stages?.driftRepair?.status' not_required)"
done


if (( REMAINING_GROUPS <= 0 )); then
  defer_remaining_work "bounded group budget consumed"
fi

FALLBACK_STATUS="$(queue_value 'j.stages?.fallbackRepair?.status' not_required)"
while (( REMAINING_GROUPS > 0 )) && [[ "$FALLBACK_STATUS" != "not_required" && "$FALLBACK_STATUS" != "completed" && "$FALLBACK_STATUS" != "blocked" ]]; do
  assert_browser_lease_healthy || exit $?
  refresh_executor_continuation_args
  WORK_FINGERPRINT="$(queue_value 'j.stages?.fallbackRepair?.workFingerprint' '')"
  export SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH="$WORK_FINGERPRINT"
  GUARD_PATH="$ROOT/$(queue_value 'j.sourceGuard' '')"
  RESULT_PATH="outputs/reports/new-listing-7d-limited-discount-execution-summary-${DATE}.json"
  begin_stage_critical_section fallbackRepair || { status=$?; exit "$status"; }
  set +e
  node scripts/marketing/batch_apply_new_listing_limited_discount.mjs \
    --date "$DATE" --guard "$GUARD_PATH" --skip-build --execute --max-groups 1 \
    --graceful-cutoff-epoch "$FALLBACK_GRACEFUL_CUTOFF_EPOCH" \
    --outer-hard-deadline-epoch "$FALLBACK_OUTER_HARD_DEADLINE_EPOCH" \
    --min-start-budget-sec "$FALLBACK_MIN_START_BUDGET_SEC" \
    --expected-work-fingerprint "$WORK_FINGERPRINT" \
    "${EXECUTOR_CONTINUATION_ARGS[@]}"
  status=$?
  set -e
  PROCESSED_GROUPS="$(new_groups_in_result "$RESULT_PATH")"
  DEADLINE_DEFERRED="$(result_top_level_value "$RESULT_PATH" deadlineDeferred 0)"
  if [[ ! "$PROCESSED_GROUPS" =~ ^[0-9]+$ ]] || (( PROCESSED_GROUPS > 1 )); then
    update_stage fallbackRepair failed false "single-group executor produced an invalid new-group count=$PROCESSED_GROUPS status=$status" "$RESULT_PATH"
    write_state failed "fallback single-group executor produced an invalid progress count status=$status"
    exit 66
  fi
  if (( PROCESSED_GROUPS == 1 )); then
    consume_group_budget "$PROCESSED_GROUPS"
  fi
  if (( PROCESSED_GROUPS == 0 )); then
    RESUME_DISPOSITION="$(settled_result_disposition fallbackRepair "$RESULT_PATH" "$WORK_FINGERPRINT")"
    case "$RESUME_DISPOSITION" in
      completed)
        update_stage fallbackRepair completed true "same-fingerprint persistent result already settled successfully before queue update; no replay" "$RESULT_PATH"
        FALLBACK_STATUS="$(queue_value 'j.stages?.fallbackRepair?.status' not_required)"
        continue
        ;;
      blocked)
        update_stage fallbackRepair blocked false "same-fingerprint persistent result contains terminal fallback blockers; no replay" "$RESULT_PATH"
        write_state blocked "fallback persistent result closed with terminal blockers"
        FALLBACK_STATUS="$(queue_value 'j.stages?.fallbackRepair?.status' not_required)"
        continue
        ;;
      failed)
        update_stage fallbackRepair failed false "same-fingerprint persistent result contains explicit failure evidence; no replay" "$RESULT_PATH"
        write_state failed "fallback persistent result closed with explicit failure evidence"
        exit 2
        ;;
      incomplete)
        update_stage fallbackRepair failed false "newGroups=0 but persistent result evidence is incomplete or inconsistent" "$RESULT_PATH"
        write_state failed "fallback persistent result could not safely close crash-resume"
        exit 66
        ;;
    esac
  fi
  if [[ "$DEADLINE_DEFERRED" =~ ^[1-9][0-9]*$ ]]; then
    update_stage fallbackRepair pending false "deadline/recovery boundary reached; no new fallback group will start in this slot" "$RESULT_PATH"
    write_state pending "fallback repair paused at the deadline boundary; exact queue preserved"
    break
  fi
  if (( PROCESSED_GROUPS == 0 )); then
    update_stage fallbackRepair failed false "single-group executor produced no exact new group status=$status" "$RESULT_PATH"
    write_state failed "fallback single-group executor made no durable progress status=$status"
    exit 66
  fi
  if [[ "$status" -eq 0 ]]; then
    BLOCKED_TARGETS="$(result_total "$RESULT_PATH" blockedTargetCount)"
    FAILED_TARGETS="$(result_total "$RESULT_PATH" failedTargetCount)"
    if (( BLOCKED_TARGETS > 0 && FAILED_TARGETS == 0 )); then
      update_stage fallbackRepair blocked false "preflight reached terminal inventory/platform blockers; no unsafe write attempted" "$RESULT_PATH"
      write_state blocked "fallback repair safely blocked by current inventory/platform conditions"
      echo "[cloud_marketing_repair] terminal fallback blockers recorded; final snapshot still required date=$DATE rows=$BLOCKED_TARGETS"
    else
      update_stage fallbackRepair completed true "serial single-group execute and per-group readback succeeded" "$RESULT_PATH"
    fi
  elif [[ "$status" -eq 3 ]]; then
    update_stage fallbackRepair pending false "one exact group completed; serial consumer continuing" "$RESULT_PATH"
  else
    update_stage fallbackRepair failed false "single-group execute/readback failed status=$status" "$RESULT_PATH"
    write_state failed "fallback repair failed status=$status"
    exit "$status"
  fi
  FALLBACK_STATUS="$(queue_value 'j.stages?.fallbackRepair?.status' not_required)"
done

if (( REMAINING_GROUPS <= 0 )) && [[ "$FALLBACK_STATUS" == "pending" ]]; then
  defer_remaining_work "bounded serial group budget consumed"
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
