#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TARGET="${1:-yesterday}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
LOG_DIR="${SHEIN_BI_LOG_DIR:-/srv/shein-bi/logs/cloud-link-business}"
METABASE_URL="${METABASE_URL:-http://127.0.0.1:3000}"
PORTAL_HEALTH_URL="${PORTAL_HEALTH_URL:-}"
PORTAL_INDEX_PATH="${PORTAL_INDEX_PATH:-$ROOT/outputs/bi-portal/index.html}"
PORTAL_DATA_PATH="${PORTAL_DATA_PATH:-$ROOT/outputs/bi-portal/data.json}"
LEASE_TASK="${SHEIN_LINK_BUSINESS_LEASE_TASK:-cloud-link-business}"
LEASE_RUN_ID="${SHEIN_LINK_BUSINESS_RUN_ID:-$(node -e 'console.log(require("node:crypto").randomUUID())')}"
LEASE_TTL_SEC="${SHEIN_LINK_BUSINESS_LEASE_TTL_SEC:-5400}"
LEASE_ACTIVE=0
export SHEIN_BI_BROWSER_LEASE_TASK="$LEASE_TASK"
export SHEIN_BI_BROWSER_LEASE_RUN_ID="$LEASE_RUN_ID"
FETCH_ONLY="${SHEIN_LINK_BUSINESS_FETCH_ONLY:-0}"
FINALIZE_ONLY="${SHEIN_LINK_BUSINESS_FINALIZE_ONLY:-0}"
CHUNK_RESULT_FILE="${SHEIN_LINK_BUSINESS_CHUNK_RESULT_FILE:-}"
RESUME_COMPLETED="${SHEIN_LINK_BUSINESS_RESUME_COMPLETED:-$FETCH_ONLY}"
PER_STORE_BROWSER_WRAPPER="${SHEIN_LINK_BUSINESS_PER_STORE_BROWSER_WRAPPER:-0}"
RESOURCE_RETRIES="${SHEIN_LINK_BUSINESS_RESOURCE_RETRIES:-12}"
RESOURCE_RETRY_SLEEP_SEC="${SHEIN_LINK_BUSINESS_RESOURCE_RETRY_SLEEP_SEC:-30}"
BROWSER_CONCURRENCY="${SHEIN_LINK_BUSINESS_BROWSER_CONCURRENCY:-2}"
LINK_PARTIAL_LOCK_FILE="${SHEIN_LINK_BUSINESS_PARTIAL_LOCK_FILE:-$ROOT/state/locks/link-business-partial.lock}"
LINK_PARTIAL_LOCK_WAIT_SEC="${SHEIN_LINK_BUSINESS_PARTIAL_LOCK_WAIT_SEC:-60}"
LINK_RUN_LOCK_FILE="${SHEIN_LINK_BUSINESS_RUN_LOCK_FILE:-$ROOT/state/locks/link-business-run.lock}"
LINK_RUN_LOCK_WAIT_SEC="${SHEIN_LINK_BUSINESS_RUN_LOCK_WAIT_SEC:-1800}"
# A finalize-only call normally remains a read/merge gate.  The morning chain
# may opt it into a bounded, metric-only recovery when all exact-date store
# artifacts exist but the platform has returned an all-zero readiness shape.
# The state file is keyed by the business date/run key so a service restart or
# the next five-minute coordinator pass cannot reset the retry budget/deadline.
METRIC_REFETCH_ON_NOT_READY="${SHEIN_LINK_BUSINESS_METRIC_REFETCH_ON_NOT_READY:-0}"
METRIC_REFETCH_MAX_ATTEMPTS="${SHEIN_LINK_BUSINESS_METRIC_REFETCH_MAX_ATTEMPTS:-12}"
METRIC_REFETCH_RETRY_SLEEP_SEC="${SHEIN_LINK_BUSINESS_METRIC_REFETCH_RETRY_SLEEP_SEC:-300}"
METRIC_REFETCH_BUDGET_SEC="${SHEIN_LINK_BUSINESS_METRIC_REFETCH_BUDGET_SEC:-900}"
METRIC_REFETCH_DEADLINE_EPOCH="${SHEIN_LINK_BUSINESS_METRIC_REFETCH_DEADLINE_EPOCH:-0}"
METRIC_REFETCH_RUN_KEY="${SHEIN_LINK_BUSINESS_METRIC_REFETCH_RUN_KEY:-}"
METRIC_REFETCH_STATE_FILE="${SHEIN_LINK_BUSINESS_METRIC_REFETCH_STATE_FILE:-$ROOT/state/cloud_ops_alerts/link-business-metric-refetch.json}"
METRIC_REFETCH_MAX_ALLOWED=24
METRIC_REFETCH_SLEEP_MAX_SEC=900
METRIC_REFETCH_BATCH_COMMITTED=0
METRIC_REFETCH_TRANSACTION_ROOT=""
METRIC_REFETCH_COMMITTED_STORES=()
METRIC_REFETCH_REPLACED_STORES=()
METRIC_REFETCH_FAILED_STORES=()
METRIC_REFETCH_DEFERRED_STORES=()
METRIC_REFETCH_PERSISTED_TRANSACTION_ROOT=""
METRIC_REFETCH_SKIP_PUBLISH=0
METRIC_REFETCH_SOURCE_STATUS=""
METRIC_REFETCH_SOURCE_FINGERPRINT=""
CANONICAL_METRIC_STORES="CX DL DX FY HL JSH JY LQ MZ NM QH QY TS TZ TZZ XC XL YJ ZL"

source "$ROOT/scripts/lib/shared_lock.sh"

is_true() {
  [[ "$1" == "1" || "$1" == "true" ]]
}

validate_metric_refetch_config() {
  is_true "$METRIC_REFETCH_ON_NOT_READY" || return 0
  [[ "$METRIC_REFETCH_MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || {
    echo "SHEIN_LINK_BUSINESS_METRIC_REFETCH_MAX_ATTEMPTS must be a positive integer" >&2
    exit 64
  }
  [[ "$METRIC_REFETCH_RETRY_SLEEP_SEC" =~ ^[0-9]+$ ]] || {
    echo "SHEIN_LINK_BUSINESS_METRIC_REFETCH_RETRY_SLEEP_SEC must be a non-negative integer" >&2
    exit 64
  }
  [[ "$METRIC_REFETCH_BUDGET_SEC" =~ ^[1-9][0-9]*$ ]] || {
    echo "SHEIN_LINK_BUSINESS_METRIC_REFETCH_BUDGET_SEC must be a positive integer" >&2
    exit 64
  }
  [[ "$METRIC_REFETCH_DEADLINE_EPOCH" =~ ^(0|[1-9][0-9]*)$ ]] || {
    echo "SHEIN_LINK_BUSINESS_METRIC_REFETCH_DEADLINE_EPOCH must be an epoch or 0" >&2
    exit 64
  }
  if (( METRIC_REFETCH_MAX_ATTEMPTS > METRIC_REFETCH_MAX_ALLOWED )); then
    echo "[cloud_link_business_sync] metric refetch attempts capped at $METRIC_REFETCH_MAX_ALLOWED (requested=$METRIC_REFETCH_MAX_ATTEMPTS)" >&2
    METRIC_REFETCH_MAX_ATTEMPTS="$METRIC_REFETCH_MAX_ALLOWED"
  fi
  if (( METRIC_REFETCH_RETRY_SLEEP_SEC > METRIC_REFETCH_SLEEP_MAX_SEC )); then
    echo "[cloud_link_business_sync] metric refetch interval capped at ${METRIC_REFETCH_SLEEP_MAX_SEC}s (requested=$METRIC_REFETCH_RETRY_SLEEP_SEC)" >&2
    METRIC_REFETCH_RETRY_SLEEP_SEC="$METRIC_REFETCH_SLEEP_MAX_SEC"
  fi
}

validate_metric_refetch_paths_and_stores() {
  is_true "$METRIC_REFETCH_ON_NOT_READY" || return 0
  ROOT="$ROOT" STATE_FILE="$METRIC_REFETCH_STATE_FILE" CANONICAL_STORES="$CANONICAL_METRIC_STORES" node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(process.env.ROOT || '');
const canonical = String(process.env.CANONICAL_STORES || '').split(/\s+/).filter(Boolean);
const canonicalSet = new Set(canonical);
const stateFile = path.resolve(process.env.STATE_FILE || '');
const allowedState = path.join(root, 'state', 'cloud_ops_alerts');
const contained = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
const rejectSymlinkAncestors = target => {
  let current = path.parse(target).root;
  for (const part of path.relative(path.parse(target).root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`symlink path component rejected: ${current}`);
  }
};
rejectSymlinkAncestors(root);
rejectSymlinkAncestors(allowedState);
fs.mkdirSync(allowedState, {recursive: true});
rejectSymlinkAncestors(allowedState);
rejectSymlinkAncestors(path.dirname(stateFile));
if (fs.existsSync(stateFile) && fs.lstatSync(stateFile).isSymbolicLink()) throw new Error(`state file symlink rejected: ${stateFile}`);
const stateParentReal = fs.realpathSync(path.dirname(stateFile));
if (!contained(allowedState, stateParentReal) || !contained(root, stateFile)) {
  throw new Error(`metric refetch state must remain under ${allowedState}: ${stateFile}`);
}
const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8'));
const configured = (config.stores || []).map(row => ({
  key: String(row?.storeKey || '').trim().toUpperCase(), enabled: row?.enabled !== false,
  biOnly: row?.enabled === false && row?.biEnabled === true,
}));
if (configured.some(row => !/^[A-Z][A-Z0-9]{1,7}$/.test(row.key))) throw new Error('illegal store key in config');
const enabled = configured.filter(row => row.enabled).map(row => row.key);
if (enabled.length !== canonical.length || new Set(enabled).size !== canonical.length
  || enabled.some(key => !canonicalSet.has(key)) || canonical.some(key => !enabled.includes(key))) {
  throw new Error(`store config drift: require exact canonical ${canonical.length} unique enabled keys; actual=${enabled.join(',')}`);
}
// BI-only onboarding stores do not participate in the canonical business source batch.
if (new Set(configured.map(row => row.key)).size !== configured.length) throw new Error('duplicate store key in config');
if (configured.some(row => !row.enabled && !row.biOnly)) throw new Error('disabled extra store must explicitly opt into BI-only visibility');
NODE
}

metric_refetch_deadline_reached() {
  [[ "$METRIC_REFETCH_DEADLINE_EPOCH" =~ ^[1-9][0-9]*$ ]] \
    && (( $(date +%s) >= METRIC_REFETCH_DEADLINE_EPOCH ))
}

metric_refetch_load_state() {
  is_true "$METRIC_REFETCH_ON_NOT_READY" || return 0
  mkdir -p "$(dirname "$METRIC_REFETCH_STATE_FILE")"
  local fields persisted_attempts persisted_deadline persisted_status persisted_transaction_root persisted_source_status persisted_source_fingerprint
  fields="$({
    DATE="$DATE" RUN_KEY="$METRIC_REFETCH_RUN_KEY" STATE_FILE="$METRIC_REFETCH_STATE_FILE" node - <<'NODE'
const fs = require('node:fs');
let state = null;
let raw = '';
try {
  raw = fs.readFileSync(process.env.STATE_FILE, 'utf8');
} catch (error) {
  if (error?.code !== 'ENOENT') {
    console.error(`metric refetch state read failed: ${error?.message || error}`);
    process.exit(75);
  }
}
if (raw) {
  try { state = JSON.parse(raw); } catch (error) {
    console.error(`metric refetch state is invalid JSON: ${error?.message || error}`);
    process.exit(75);
  }
}
if (!state || String(state.date || '') !== String(process.env.DATE || '')
  || String(state.runKey || '') !== String(process.env.RUN_KEY || '')) {
  process.stdout.write('0|0||||');
} else {
  process.stdout.write(`${Number(state.attempts) || 0}|${Number(state.deadlineEpoch) || 0}|${String(state.status || '')}|${String(state.transactionRoot || state.source?.transactionRoot || '')}|${String(state.source?.status || '')}|${String(state.source?.fingerprint || '')}`);
}
NODE
  })"
  IFS='|' read -r persisted_attempts persisted_deadline persisted_status persisted_transaction_root persisted_source_status persisted_source_fingerprint <<< "$fields"
  METRIC_REFETCH_ATTEMPTS="${persisted_attempts:-0}"
  METRIC_REFETCH_STATE_STATUS="${persisted_status:-}"
  METRIC_REFETCH_PERSISTED_TRANSACTION_ROOT="${persisted_transaction_root:-}"
  METRIC_REFETCH_SOURCE_STATUS="${persisted_source_status:-}"
  METRIC_REFETCH_SOURCE_FINGERPRINT="${persisted_source_fingerprint:-}"
  if [[ "$METRIC_REFETCH_STATE_STATUS" == "publish_completed" || "$METRIC_REFETCH_STATE_STATUS" == "ready" ]]; then
    METRIC_REFETCH_SKIP_PUBLISH=1
  fi
  local reuse_persisted_deadline=1
  case "$METRIC_REFETCH_STATE_STATUS" in
    deadline|exhausted|rolled_back)
      # A terminal/failed attempt must not poison a later retry with its old
      # absolute deadline or attempt counter. Active same-run phases still
      # reuse both so a service restart cannot extend an in-flight run.
      reuse_persisted_deadline=0
      METRIC_REFETCH_ATTEMPTS=0
      ;;
  esac
  if (( reuse_persisted_deadline )) && [[ "${persisted_deadline:-0}" =~ ^[1-9][0-9]*$ ]]; then
    if [[ "$METRIC_REFETCH_DEADLINE_EPOCH" == "0" || "$persisted_deadline" -lt "$METRIC_REFETCH_DEADLINE_EPOCH" ]]; then
      METRIC_REFETCH_DEADLINE_EPOCH="$persisted_deadline"
    fi
  fi
  if [[ "$METRIC_REFETCH_DEADLINE_EPOCH" == "0" ]]; then
    if [[ "${SHEIN_HOST_BROWSER_READ_DEADLINE_EPOCH:-}" =~ ^[1-9][0-9]*$ ]]; then
      METRIC_REFETCH_DEADLINE_EPOCH="$SHEIN_HOST_BROWSER_READ_DEADLINE_EPOCH"
    else
      METRIC_REFETCH_DEADLINE_EPOCH=$(( $(date +%s) + METRIC_REFETCH_BUDGET_SEC ))
    fi
  fi
}

write_metric_refetch_state() {
  is_true "$METRIC_REFETCH_ON_NOT_READY" || return 0
  local status="$1"
  local target_stores="${2:-}"
  local replaced_stores="${3:-}"
  local failed_stores="${4:-}"
  local deferred_stores="${5:-}"
  DATE="$DATE" \
  RUN_KEY="$METRIC_REFETCH_RUN_KEY" \
  STATE_FILE="$METRIC_REFETCH_STATE_FILE" \
  STATUS="$status" \
  ATTEMPTS="$METRIC_REFETCH_ATTEMPTS" \
  MAX_ATTEMPTS="$METRIC_REFETCH_MAX_ATTEMPTS" \
  DEADLINE_EPOCH="$METRIC_REFETCH_DEADLINE_EPOCH" \
  TARGET_STORES="$target_stores" \
  REPLACED_STORES="$replaced_stores" \
  FAILED_STORES="$failed_stores" \
  DEFERRED_STORES="$deferred_stores" \
  LOG_FILE="$LOG_FILE" \
  TRANSACTION_ROOT="${METRIC_REFETCH_TRANSACTION_ROOT:-${METRIC_REFETCH_PERSISTED_TRANSACTION_ROOT:-}}" \
  node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.STATE_FILE;
const split = value => String(value || '').split(/[\s,]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
let prior = null;
try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const sameRun = prior?.date === process.env.DATE && prior?.runKey === process.env.RUN_KEY;
const payload = {
  ...(sameRun ? prior : {}),
  schemaVersion: 'cloud-link-business-metric-refetch/v2',
  date: process.env.DATE,
  runKey: process.env.RUN_KEY,
  status: process.env.STATUS,
  attempts: Number(process.env.ATTEMPTS) || 0,
  maxAttempts: Number(process.env.MAX_ATTEMPTS) || 0,
  deadlineEpoch: Number(process.env.DEADLINE_EPOCH) || 0,
  targetStores: split(process.env.TARGET_STORES),
  replacedStores: split(process.env.REPLACED_STORES),
  failedStores: split(process.env.FAILED_STORES),
  deferredStores: split(process.env.DEFERRED_STORES),
  failedDomains: split(process.env.FAILED_STORES).length ? ['shein_links'] : [],
  startedAt: sameRun
    ? (prior.startedAt || new Date().toISOString()) : new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  logFile: process.env.LOG_FILE,
  transactionRoot: process.env.TRANSACTION_ROOT || (sameRun ? prior?.transactionRoot : '') || '',
  source: sameRun ? (prior?.source || {}) : {},
  phases: sameRun ? (prior?.phases || {}) : {},
};
fs.mkdirSync(path.dirname(file), {recursive: true});
const temporary = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {mode: 0o660});
fs.renameSync(temporary, file);
NODE
}

update_metric_refetch_source() {
  local source_status="$1"
  local source_fingerprint="${2:-}"
  local transaction_root="${3:-${METRIC_REFETCH_TRANSACTION_ROOT:-${METRIC_REFETCH_PERSISTED_TRANSACTION_ROOT:-}}}"
  SOURCE_STATUS="$source_status" SOURCE_FINGERPRINT="$source_fingerprint" TRANSACTION_ROOT="$transaction_root" \
    STATE_FILE="$METRIC_REFETCH_STATE_FILE" DATE="$DATE" RUN_KEY="$METRIC_REFETCH_RUN_KEY" node - <<'NODE'
const fs = require('node:fs');
const file = process.env.STATE_FILE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (state.date !== process.env.DATE || state.runKey !== process.env.RUN_KEY) throw new Error('metric state run mismatch');
const clearTransaction = process.env.SOURCE_STATUS === 'rolled_back';
state.source = {
  ...(state.source || {}), status: process.env.SOURCE_STATUS,
  fingerprint: process.env.SOURCE_FINGERPRINT || state.source?.fingerprint || '',
  transactionRoot: clearTransaction ? '' : (process.env.TRANSACTION_ROOT || state.source?.transactionRoot || ''),
  updatedAt: new Date().toISOString(),
};
state.transactionRoot = state.source.transactionRoot;
const preserveDownstreamStatus = process.env.SOURCE_STATUS === 'source_committed'
  && ['publish_completed', 'ready', 'downstream_link_completed', 'downstream_incomplete'].includes(String(state.status || ''));
state.status = preserveDownstreamStatus ? state.status
  : (process.env.SOURCE_STATUS === 'source_committed' ? 'source_committed' : process.env.SOURCE_STATUS);
state.updatedAt = new Date().toISOString();
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o660});
fs.renameSync(tmp, file);
NODE
  METRIC_REFETCH_SOURCE_STATUS="$source_status"
  METRIC_REFETCH_SOURCE_FINGERPRINT="$source_fingerprint"
  METRIC_REFETCH_PERSISTED_TRANSACTION_ROOT="$transaction_root"
}

metric_refetch_phase_status() {
  local phase="$1"
  STATE_FILE="$METRIC_REFETCH_STATE_FILE" PHASE="$phase" node - <<'NODE'
const fs = require('node:fs');
let state = {};
try { state = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8')); } catch {}
process.stdout.write(String(state?.phases?.[process.env.PHASE]?.status || ''));
NODE
}

update_metric_refetch_phase() {
  local phase="$1" status="$2" detail="${3:-}"
  STATE_FILE="$METRIC_REFETCH_STATE_FILE" PHASE="$phase" PHASE_STATUS="$status" PHASE_DETAIL="$detail" \
    DATE="$DATE" RUN_KEY="$METRIC_REFETCH_RUN_KEY" node - <<'NODE'
const fs = require('node:fs');
const file = process.env.STATE_FILE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (state.date !== process.env.DATE || state.runKey !== process.env.RUN_KEY
  || state.source?.status !== 'source_committed') throw new Error('phase update requires matching source_committed state');
state.phases ||= {};
const prior = state.phases[process.env.PHASE] || {};
state.phases[process.env.PHASE] = {
  ...prior, status: process.env.PHASE_STATUS, detail: process.env.PHASE_DETAIL || '',
  attempts: process.env.PHASE_STATUS === 'running' ? Number(prior.attempts || 0) + 1 : Number(prior.attempts || 0),
  updatedAt: new Date().toISOString(),
};
state.status = process.env.PHASE_STATUS === 'failed' ? 'downstream_incomplete' : state.status;
state.updatedAt = new Date().toISOString();
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o660});
fs.renameSync(tmp, file);
NODE
}

metric_refetch_sleep_before_next_attempt() {
  local remaining delay
  remaining=$((METRIC_REFETCH_DEADLINE_EPOCH - $(date +%s)))
  (( remaining > 0 )) || return 1
  delay="$METRIC_REFETCH_RETRY_SLEEP_SEC"
  if (( delay > remaining )); then delay="$remaining"; fi
  if (( delay > 0 )); then sleep "$delay"; fi
  return 0
}

metric_fetch_inner() {
  local root="$1"
  local store="$2"
  local date="$3"
  local output_root="$4"
  cd "$root"
  node scripts/restore_shein_store_session.mjs \
    --store "$store" \
    --date "$date" \
    --headless \
    --fast-start \
    --timeout-ms "${SHEIN_SESSION_RESTORE_TIMEOUT_MS:-180000}" \
    && node scripts/fetch_shein_links.mjs \
      --stores "$store" \
      --date "$date" \
      --page-size "${SHEIN_LINK_PAGE_SIZE:-100}" \
      --out-dir "$output_root" \
      --no-raw
}

run_metric_refetch_store() {
  local store="$1"
  local output_root="$2"
  local status=0
  close_one_store_browser "$store"
  if is_true "$PER_STORE_BROWSER_WRAPPER"; then
    local deadline_args=()
    if [[ "$METRIC_REFETCH_DEADLINE_EPOCH" =~ ^[1-9][0-9]*$ ]]; then
      deadline_args+=(--deadline-epoch "$METRIC_REFETCH_DEADLINE_EPOCH")
    fi
    set +e
    bash scripts/run_host_browser_read_job.sh \
      --domain "daily-link-metrics-${store,,}" \
      --lock-wait-sec "${SHEIN_LINK_BUSINESS_BROWSER_LOCK_WAIT_SEC:-600}" \
      --defer-state "$ROOT/state/cloud_ops_alerts/metric-refetch-${DATE}-${store}.json" \
      --defer-reason "link_metric_refetch" \
      "${deadline_args[@]}" \
      -- bash -c '
        set -Eeuo pipefail
        root="$1"
        store="$2"
        date="$3"
        output_root="$4"
        metric_restore_timeout="$5"
        link_page_size="$6"
        cd "$root"
        node scripts/restore_shein_store_session.mjs \
          --store "$store" --date "$date" --headless --fast-start \
          --timeout-ms "$metric_restore_timeout"
        node scripts/fetch_shein_links.mjs \
          --stores "$store" --date "$date" --page-size "$link_page_size" \
          --out-dir "$output_root" --no-raw
      ' _ "$ROOT" "$store" "$DATE" "$output_root" \
        "${SHEIN_SESSION_RESTORE_TIMEOUT_MS:-180000}" \
        "${SHEIN_LINK_PAGE_SIZE:-100}"
    status=$?
    set -e
  else
    set +e
    metric_fetch_inner "$ROOT" "$store" "$DATE" "$output_root"
    status=$?
    set -e
  fi
  close_one_store_browser "$store"
  return "$status"
}

metric_candidate_is_ready() {
  local candidate="$1"
  local store="$2"
  CANDIDATE="$candidate" STORE="$store" DATE="$DATE" node - <<'NODE'
const fs = require('node:fs');
let payload;
try { payload = JSON.parse(fs.readFileSync(process.env.CANDIDATE, 'utf8')); } catch { process.exit(1); }
const store = String(process.env.STORE || '').trim().toUpperCase();
const date = String(process.env.DATE || '');
if (payload?.ok !== true || String(payload?.date || '') !== date
  || String(payload?.store?.storeKey || '').trim().toUpperCase() !== store) process.exit(1);

const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const finiteMetric = (object, names) => {
  const key = names.find(name => own(object, name));
  if (!key) return null;
  const value = object[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
};
const rows = Array.isArray(payload.performanceRows) ? payload.performanceRows : [];
const diagnoseDay = finiteMetric(payload.counts, ['diagnoseDay']);
const performanceCount = finiteMetric(payload.counts, ['performanceRows']);
const requiredFields = [
  ['epsUv', 'eps_uv'],
  ['goodsUv', 'goods_uv'],
  ['saleCnt', 'sale_cnt'],
  ['payOrderCnt', 'pay_order_cnt'],
];
const fieldsComplete = rows.every(row => requiredFields.every(names => finiteMetric(row, names) !== null));

// A numeric zero in a required metric field is legitimate only after the
// normal fetch contract proves the daily performance source succeeded: ok=true,
// exact identity, a positive performance row count, and a matching row count.
// diagnoseDay is a diagnostic count; zero is a valid empty result, but a
// missing or malformed count is still not evidence of a successful fetch.
const sourceProven = Number.isInteger(diagnoseDay)
  && Number.isInteger(performanceCount)
  && performanceCount > 0 && performanceCount === rows.length
  && rows.length > 0;
process.exit(sourceProven && fieldsComplete ? 0 : 2);
NODE
}

run_metric_refetch_round() {
  local target_stores="$1"
  local output_root="$2"
  METRIC_REFETCH_FAILED_STORES=()
  METRIC_REFETCH_DEFERRED_STORES=()
  local store candidate
  for store in $target_stores; do
    if metric_refetch_deadline_reached; then
      METRIC_REFETCH_DEFERRED_STORES+=("$store")
      continue
    fi
    candidate="$output_root/$store/$DATE.json"
    if ! run_metric_refetch_store "$store" "$output_root"; then
      METRIC_REFETCH_FAILED_STORES+=("$store")
      continue
    fi
    if ! metric_candidate_is_ready "$candidate" "$store"; then
      METRIC_REFETCH_FAILED_STORES+=("$store")
      continue
    fi
  done
}

metric_refetch_pending_candidates() {
  local batch_stores="$1"
  local output_root="$2"
  local store candidate
  local pending=()
  for store in $batch_stores; do
    candidate="$output_root/$store/$DATE.json"
    if ! metric_candidate_is_ready "$candidate" "$store"; then
      pending+=("$store")
    fi
  done
  printf '%s' "${pending[*]}"
}

append_metric_refetch_journal() {
  local event="$1"
  local store="${2:-}"
  local detail="${3:-}"
  [[ -n "${METRIC_REFETCH_TRANSACTION_ROOT:-}" ]] || return 0
  JOURNAL_FILE="$METRIC_REFETCH_TRANSACTION_ROOT/journal.ndjson" \
  JOURNAL_EVENT="$event" \
  JOURNAL_STORE="$store" \
  JOURNAL_DETAIL="$detail" \
  node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.JOURNAL_FILE;
fs.mkdirSync(path.dirname(file), {recursive: true});
fs.appendFileSync(file, `${JSON.stringify({
  at: new Date().toISOString(),
  event: process.env.JOURNAL_EVENT || '',
  store: process.env.JOURNAL_STORE || '',
  detail: process.env.JOURNAL_DETAIL || '',
})}\n`, {mode: 0o660});
NODE
}

metric_refetch_transaction() {
  local action="$1"
  local transaction_root="$2"
  local candidate_root="${3:-}"
  local batch_stores="${4:-$CANONICAL_METRIC_STORES}"
  ROOT="$ROOT" DATE="$DATE" ACTION="$action" TRANSACTION_ROOT="$transaction_root" \
    CANDIDATE_ROOT="$candidate_root" BATCH_STORES="$batch_stores" \
    CANONICAL_STORES="$CANONICAL_METRIC_STORES" \
    TEST_COMMIT_FAIL_AFTER="${SHEIN_LINK_BUSINESS_TEST_COMMIT_FAIL_AFTER:-}" \
    TEST_ROLLBACK_FAIL_STORE="${SHEIN_LINK_BUSINESS_TEST_ROLLBACK_FAIL_STORE:-}" \
    TEST_REMOVE_BACKUP_STORE="${SHEIN_LINK_BUSINESS_TEST_REMOVE_BACKUP_STORE:-}" node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = fs.realpathSync(process.env.ROOT || '');
const stateRoot = fs.realpathSync(path.join(root, 'state'));
const date = String(process.env.DATE || '');
const action = String(process.env.ACTION || '');
const canonical = String(process.env.CANONICAL_STORES || '').split(/\s+/).filter(Boolean);
const batch = String(process.env.BATCH_STORES || '').split(/\s+/).filter(Boolean);
const transactionInput = path.resolve(process.env.TRANSACTION_ROOT || '');
const contained = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);
const rejectSymlinkAncestors = target => {
  let current = path.parse(target).root;
  for (const part of path.relative(path.parse(target).root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`symlink path component rejected: ${current}`);
  }
};
rejectSymlinkAncestors(transactionInput);
if (!fs.existsSync(transactionInput) || fs.lstatSync(transactionInput).isSymbolicLink()
  || !fs.lstatSync(transactionInput).isDirectory()) throw new Error(`unsafe transaction root: ${transactionInput}`);
const transactionRoot = fs.realpathSync(transactionInput);
if (path.dirname(transactionRoot) !== stateRoot
  || !path.basename(transactionRoot).startsWith('.link-business-metric-refetch.')) {
  throw new Error(`transaction root escapes state root: ${transactionRoot}`);
}
if (!contained(root, transactionRoot)) throw new Error(`transaction root escapes application root: ${transactionRoot}`);
const manifestFile = path.join(transactionRoot, 'manifest.json');
const journalFile = path.join(transactionRoot, 'journal.ndjson');
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const atomicJson = payload => {
  const tmp = `${manifestFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {mode: 0o660});
  fs.renameSync(tmp, manifestFile);
};
const event = (name, detail = {}) => fs.appendFileSync(journalFile,
  `${JSON.stringify({at: new Date().toISOString(), event: name, ...detail})}\n`, {mode: 0o660});
const regular = file => fs.existsSync(file) && fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink();
const batchFingerprint = records => crypto.createHash('sha256')
  .update(records.map(row => `${row.store}:${row.posthash}`).sort().join('\n')).digest('hex');
const saveStatus = (manifest, status, error = '') => {
  manifest.status = status;
  manifest.error = error;
  manifest.updatedAt = new Date().toISOString();
  atomicJson(manifest);
  event(status, error ? {error} : {});
};
const validateManifestRecords = manifest => {
  const records = Array.isArray(manifest?.records) ? manifest.records : [];
  if (records.length !== canonical.length) throw new Error(`manifest requires exactly ${canonical.length} records`);
  const seen = new Set();
  for (const [index, row] of records.entries()) {
    const store = canonical[index];
    if (!row || row.store !== store || seen.has(row.store)) throw new Error(`manifest canonical store mapping invalid at index=${index}`);
    seen.add(row.store);
    const expectedTarget = path.join(root, 'outputs', 'shein_links', store, `${date}.json`);
    const expectedBackup = path.join(transactionRoot, 'backups', store, `${date}.json`);
    if (row.target !== expectedTarget) throw new Error(`manifest target path mismatch for ${store}`);
    if (row.backup !== expectedBackup) throw new Error(`manifest backup path mismatch for ${store}`);
    rejectSymlinkAncestors(path.dirname(expectedTarget));
    rejectSymlinkAncestors(path.dirname(expectedBackup));
  }
  if (seen.size !== canonical.length) throw new Error('manifest store mapping has missing or duplicate rows');
  return records;
};
const rollback = manifest => {
  const records = validateManifestRecords(manifest);
  if (process.env.TEST_REMOVE_BACKUP_STORE) {
    const row = records.find(item => item.store === process.env.TEST_REMOVE_BACKUP_STORE);
    if (row && fs.existsSync(row.backup)) fs.unlinkSync(row.backup);
  }
  for (const row of records) {
    if (!regular(row.backup) || hashFile(row.backup) !== row.prehash) {
      throw new Error(`missing or invalid expected backup for ${row.store}`);
    }
  }
  for (const [index, row] of records.entries()) {
    if (process.env.TEST_ROLLBACK_FAIL_STORE === row.store) throw new Error(`injected rollback write failure for ${row.store}`);
    const tmp = path.join(path.dirname(row.target), `.${date}.metric-rollback-${process.pid}-${index}`);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    fs.copyFileSync(row.backup, tmp, fs.constants.COPYFILE_EXCL);
    fs.renameSync(tmp, row.target);
    if (hashFile(row.target) !== row.prehash) throw new Error(`restored hash mismatch for ${row.store}`);
    event('rolled_back', {store: row.store, target: row.target, prehash: row.prehash});
  }
  for (const row of records) if (hashFile(row.target) !== row.prehash) throw new Error(`rollback verification failed for ${row.store}`);
};

if (action === 'commit') {
  if (batch.length !== canonical.length || new Set(batch).size !== canonical.length
    || canonical.some((store, index) => batch[index] !== store)) {
    throw new Error(`source commit requires canonical ordered ${canonical.length}-store batch`);
  }
  const candidateRoot = fs.realpathSync(process.env.CANDIDATE_ROOT || '');
  if (!contained(transactionRoot, candidateRoot)) throw new Error('candidate root escapes transaction root');
  const records = canonical.map(store => {
    const candidate = path.join(candidateRoot, store, `${date}.json`);
    const target = path.join(root, 'outputs', 'shein_links', store, `${date}.json`);
    const backup = path.join(transactionRoot, 'backups', store, `${date}.json`);
    rejectSymlinkAncestors(path.dirname(candidate));
    rejectSymlinkAncestors(path.dirname(target));
    if (!regular(candidate) || !regular(target)) throw new Error(`candidate/formal artifact invalid for ${store}`);
    return {store, candidate, target, backup, prehash: hashFile(target), posthash: hashFile(candidate)};
  });
  const manifest = {
    schemaVersion: 'metric-source-transaction/v2', date, status: 'preparing',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    records, committed: [], fingerprint: batchFingerprint(records),
  };
  atomicJson(manifest);
  try {
    for (const row of records) {
      fs.mkdirSync(path.dirname(row.backup), {recursive: true});
      rejectSymlinkAncestors(path.dirname(row.backup));
      fs.copyFileSync(row.target, row.backup, fs.constants.COPYFILE_EXCL);
      if (hashFile(row.backup) !== row.prehash) throw new Error(`backup hash mismatch for ${row.store}`);
      event('backed_up', {store: row.store, target: row.target, backup: row.backup, prehash: row.prehash, posthash: row.posthash});
    }
    saveStatus(manifest, 'backups_verified');
    for (const [index, row] of records.entries()) {
      if (process.env.TEST_COMMIT_FAIL_AFTER !== '' && index >= Number(process.env.TEST_COMMIT_FAIL_AFTER)) {
        throw new Error(`injected commit failure after ${index} targets`);
      }
      const tmp = path.join(path.dirname(row.target), `.${date}.metric-commit-${process.pid}-${index}`);
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      fs.copyFileSync(row.candidate, tmp, fs.constants.COPYFILE_EXCL);
      if (hashFile(tmp) !== row.posthash) throw new Error(`staged copy hash mismatch for ${row.store}`);
      fs.renameSync(tmp, row.target);
      if (hashFile(row.target) !== row.posthash) throw new Error(`committed hash mismatch for ${row.store}`);
      manifest.committed.push(row.store);
      atomicJson(manifest);
      event('committed', {store: row.store, target: row.target, backup: row.backup, prehash: row.prehash, posthash: row.posthash});
    }
    for (const row of records) if (hashFile(row.target) !== row.posthash) throw new Error(`full posthash verification failed for ${row.store}`);
    saveStatus(manifest, 'source_committed');
    process.stdout.write(manifest.fingerprint);
  } catch (error) {
    try {
      saveStatus(manifest, 'rollback_started', String(error?.message || error));
      rollback(manifest);
      saveStatus(manifest, 'rolled_back', String(error?.message || error));
      console.error(`source commit failed and verified rollback completed: ${error?.message || error}`);
      process.exit(75);
    } catch (rollbackError) {
      saveStatus(manifest, 'rollback_failed', `${error?.message || error}; rollback=${rollbackError?.message || rollbackError}`);
      console.error(`source commit rollback_failed: ${rollbackError?.message || rollbackError}`);
      process.exit(70);
    }
  }
} else {
  if (!regular(manifestFile)) {
    if (action === 'recover') {
      event('rolled_back', {detail: 'no manifest; no formal commit evidence'});
      process.stdout.write('rolled_back');
      process.exit(0);
    }
    throw new Error(`transaction manifest missing: ${manifestFile}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.date !== date) throw new Error('transaction manifest date invalid');
  const manifestRecords = validateManifestRecords(manifest);
  if (manifest.status === 'source_committed') {
    for (const row of manifestRecords) {
      if (!regular(row.target) || hashFile(row.target) !== row.posthash) throw new Error(`source_committed target drift for ${row.store}`);
    }
    const fingerprint = batchFingerprint(manifestRecords);
    if (fingerprint !== manifest.fingerprint) throw new Error('source_committed fingerprint mismatch');
    process.stdout.write(`source_committed|${fingerprint}`);
  } else if (action === 'recover') {
    try {
      saveStatus(manifest, 'rollback_started', `restart recovery from ${manifest.status}`);
      rollback(manifest);
      saveStatus(manifest, 'rolled_back');
      process.stdout.write('rolled_back');
    } catch (error) {
      saveStatus(manifest, 'rollback_failed', String(error?.message || error));
      console.error(`restart rollback_failed: ${error?.message || error}`);
      process.exit(70);
    }
  } else {
    throw new Error(`source is not committed: ${manifest.status}`);
  }
}
NODE
}

recover_interrupted_metric_refetch_transaction() {
  local transaction_root="$METRIC_REFETCH_PERSISTED_TRANSACTION_ROOT"
  [[ -n "$transaction_root" ]] || return 0
  local outcome status recovery_action="recover"
  if [[ "$METRIC_REFETCH_SOURCE_STATUS" == "source_committed" || "$METRIC_REFETCH_SOURCE_STATUS" == "source_revalidation_required" ]]; then
    recovery_action="verify"
  fi
  set +e
  outcome="$(metric_refetch_transaction "$recovery_action" "$transaction_root")"
  status=$?
  set -e
  if (( status != 0 )); then
    if [[ "$recovery_action" == "verify" ]]; then
      invalidate_metric_refetch_source "restart source fingerprint verification failed"
      return 70
    else
      write_metric_refetch_state "rollback_failed" "$CANONICAL_METRIC_STORES" "" "$CANONICAL_METRIC_STORES" ""
      update_metric_refetch_source "rollback_failed" "$METRIC_REFETCH_SOURCE_FINGERPRINT" "$transaction_root"
      return "$status"
    fi
  fi
  if [[ "$outcome" == source_committed\|* ]]; then
    METRIC_REFETCH_SOURCE_STATUS="source_committed"
    METRIC_REFETCH_SOURCE_FINGERPRINT="${outcome#source_committed|}"
    METRIC_REFETCH_SKIP_PUBLISH=0
    update_metric_refetch_source "source_committed" "$METRIC_REFETCH_SOURCE_FINGERPRINT" "$transaction_root"
    if [[ "$METRIC_REFETCH_STATE_STATUS" == "source_revalidation_required" ]]; then
      write_metric_refetch_state "source_committed" "$CANONICAL_METRIC_STORES" "$CANONICAL_METRIC_STORES" "" ""
      METRIC_REFETCH_STATE_STATUS="source_committed"
    fi
    echo "[cloud_link_business_sync] verified prior source_committed transaction=$transaction_root"
  else
    METRIC_REFETCH_SKIP_PUBLISH=0
    write_metric_refetch_state "rolled_back" "$CANONICAL_METRIC_STORES" "" "" ""
    update_metric_refetch_source "rolled_back" "" "$transaction_root"
    METRIC_REFETCH_PERSISTED_TRANSACTION_ROOT=""
    METRIC_REFETCH_TRANSACTION_ROOT=""
    echo "[cloud_link_business_sync] verified interrupted source rollback transaction=$transaction_root"
  fi
}

rollback_metric_refetch_batch() {
  echo "[cloud_link_business_sync] source rollback is only legal inside pre-source-commit transaction manager" >&2
  return 70
}

commit_metric_refetch_batch() {
  local batch_stores="$1"
  local candidate_root="$2"
  local fingerprint status
  set +e
  fingerprint="$(metric_refetch_transaction commit "$METRIC_REFETCH_TRANSACTION_ROOT" "$candidate_root" "$batch_stores")"
  status=$?
  set -e
  if (( status != 0 )); then
    if (( status == 70 )); then
      update_metric_refetch_source "rollback_failed" "" "$METRIC_REFETCH_TRANSACTION_ROOT"
    else
      update_metric_refetch_source "rolled_back" "" "$METRIC_REFETCH_TRANSACTION_ROOT"
    fi
    return "$status"
  fi
  METRIC_REFETCH_BATCH_COMMITTED=1
  METRIC_REFETCH_REPLACED_STORES=($CANONICAL_METRIC_STORES)
  METRIC_REFETCH_SOURCE_FINGERPRINT="$fingerprint"
  update_metric_refetch_source "source_committed" "$fingerprint" "$METRIC_REFETCH_TRANSACTION_ROOT"
  printf '%s' "$fingerprint" >/dev/null
}

invalidate_metric_refetch_source() {
  local reason="$1"
  STATE_FILE="$METRIC_REFETCH_STATE_FILE" DATE="$DATE" RUN_KEY="$METRIC_REFETCH_RUN_KEY" REASON="$reason" node - <<'NODE'
const fs = require('node:fs');
const file = process.env.STATE_FILE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (state.date !== process.env.DATE || state.runKey !== process.env.RUN_KEY) throw new Error('source invalidation run mismatch');
state.status = 'source_revalidation_required';
state.ready = false;
state.source = {...(state.source || {}), status: 'source_revalidation_required', invalidatedAt: new Date().toISOString(), invalidationReason: process.env.REASON};
state.phases = {};
state.updatedAt = new Date().toISOString();
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o660});
fs.renameSync(tmp, file);
NODE
  METRIC_REFETCH_SOURCE_STATUS="source_revalidation_required"
  METRIC_REFETCH_STATE_STATUS="source_revalidation_required"
  METRIC_REFETCH_SKIP_PUBLISH=0
}

verify_metric_refetch_source_fingerprint() {
  [[ "$METRIC_REFETCH_SOURCE_STATUS" == "source_committed" ]] || return 70
  local transaction_root="${METRIC_REFETCH_PERSISTED_TRANSACTION_ROOT:-${METRIC_REFETCH_TRANSACTION_ROOT:-}}"
  local outcome status fingerprint
  if [[ -z "$transaction_root" ]]; then
    invalidate_metric_refetch_source "source_committed transaction root missing"
    return 70
  fi
  set +e
  outcome="$(metric_refetch_transaction verify "$transaction_root")"
  status=$?
  set -e
  if (( status != 0 )) || [[ "$outcome" != source_committed\|* ]]; then
    invalidate_metric_refetch_source "canonical formal artifact hash/readback drift"
    return 70
  fi
  fingerprint="${outcome#source_committed|}"
  if [[ ! "$fingerprint" =~ ^[a-f0-9]{64}$ || "$fingerprint" != "$METRIC_REFETCH_SOURCE_FINGERPRINT" ]]; then
    invalidate_metric_refetch_source "aggregate source fingerprint mismatch"
    return 70
  fi
  return 0
}

metric_refetch_target_stores() {
  METRIC_READY_JSON="$1" node - <<'NODE'
let payload = {};
try { payload = JSON.parse(process.env.METRIC_READY_JSON || '{}'); } catch {}
const values = payload?.metrics?.refetchStores || [];
process.stdout.write([...new Set(values.map(x => String(x || '').trim().toUpperCase()).filter(Boolean))].join(' '));
NODE
}

write_metric_not_ready_alert() {
  local readiness_json="$1"
  local target_stores="${2:-}"
  local refetch_status="${3:-disabled}"
  mkdir -p "$ROOT/state/cloud_ops_alerts"
  DATE="$DATE" \
  LOG_FILE="$LOG_FILE" \
  METRIC_READY_JSON="$readiness_json" \
  METRIC_REFETCH_ENABLED="$METRIC_REFETCH_ON_NOT_READY" \
  METRIC_REFETCH_STATUS="$refetch_status" \
  METRIC_REFETCH_ATTEMPTS="${METRIC_REFETCH_ATTEMPTS:-0}" \
  METRIC_REFETCH_MAX_ATTEMPTS="$METRIC_REFETCH_MAX_ATTEMPTS" \
  METRIC_REFETCH_DEADLINE_EPOCH="$METRIC_REFETCH_DEADLINE_EPOCH" \
  METRIC_REFETCH_TARGET_STORES="$target_stores" \
  METRIC_REFETCH_REPLACED_STORES="${METRIC_REFETCH_REPLACED_STORES[*]:-}" \
  METRIC_REFETCH_FAILED_STORES="${METRIC_REFETCH_FAILED_STORES[*]:-}" \
  METRIC_REFETCH_DEFERRED_STORES="${METRIC_REFETCH_DEFERRED_STORES[*]:-}" \
  node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
let readiness = {};
try { readiness = JSON.parse(process.env.METRIC_READY_JSON || '{}'); } catch {}
const split = value => String(value || '').split(/[\s,]+/).map(x => x.trim().toUpperCase()).filter(Boolean);
const failedStores = split(process.env.METRIC_REFETCH_FAILED_STORES);
const payload = {
  date: process.env.DATE,
  generatedAt: new Date().toISOString(),
  logFile: process.env.LOG_FILE,
  readiness,
  refetch: {
    enabled: ['1', 'true'].includes(String(process.env.METRIC_REFETCH_ENABLED || '').toLowerCase()),
    status: process.env.METRIC_REFETCH_STATUS || 'disabled',
    attempts: Number(process.env.METRIC_REFETCH_ATTEMPTS) || 0,
    maxAttempts: Number(process.env.METRIC_REFETCH_MAX_ATTEMPTS) || 0,
    deadlineEpoch: Number(process.env.METRIC_REFETCH_DEADLINE_EPOCH) || 0,
    targetStores: split(process.env.METRIC_REFETCH_TARGET_STORES),
    replacedStores: split(process.env.METRIC_REFETCH_REPLACED_STORES),
    failedStores,
    deferredStores: split(process.env.METRIC_REFETCH_DEFERRED_STORES),
    failedDomains: failedStores.length ? ['shein_links'] : [],
  },
};
const file = path.join(root, 'state', 'cloud_ops_alerts', 'link-business-last-metric-not-ready.json');
const temporary = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {mode: 0o660});
fs.renameSync(temporary, file);
NODE
}

if is_true "$FETCH_ONLY" && is_true "$FINALIZE_ONLY"; then
  echo "SHEIN_LINK_BUSINESS_FETCH_ONLY and SHEIN_LINK_BUSINESS_FINALIZE_ONLY are mutually exclusive" >&2
  exit 64
fi

resolve_date() {
  local target="$1"
  case "$target" in
    today)
      TZ="$TZ_NAME" date +%F
      ;;
    yesterday)
      TZ="$TZ_NAME" date -d 'yesterday' +%F
      ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
      printf '%s\n' "$target"
      ;;
    *)
      echo "Unsupported date target: $target" >&2
      exit 64
      ;;
  esac
}

check_portal_health() {
  if [[ ! -s "$PORTAL_INDEX_PATH" ]]; then
    echo "BI Portal index is missing or empty: $PORTAL_INDEX_PATH" >&2
    exit 1
  fi
  if [[ ! -s "$PORTAL_DATA_PATH" ]]; then
    echo "BI Portal data is missing or empty: $PORTAL_DATA_PATH" >&2
    exit 1
  fi
  if [[ -n "$PORTAL_HEALTH_URL" ]]; then
    curl -fsS --max-time 15 "$PORTAL_HEALTH_URL" >/dev/null
  else
    echo "[cloud_link_business_sync] portal files ok index=$PORTAL_INDEX_PATH data=$PORTAL_DATA_PATH"
  fi
}

close_store_browsers() {
  cd "$ROOT"
  local owned_args=()
  local selection_args=(--all)
  if [[ "$LEASE_ACTIVE" == "1" ]]; then
    owned_args+=(--owned-lease-task "$LEASE_TASK" --owned-lease-run-id "$LEASE_RUN_ID")
  fi
  if [[ -n "${SHEIN_LINK_BUSINESS_STORES:-}" ]]; then
    selection_args=(--stores "$SHEIN_LINK_BUSINESS_STORES")
  fi
  node scripts/cleanup_shein_store_browsers.mjs "${selection_args[@]}" --cleanup-chrome-tmp --kill-after-sec 5 "${owned_args[@]}" || true
}

lease_action() {
  local selection_args=(--group ALL)
  if [[ -n "${SHEIN_LINK_BUSINESS_STORES:-}" ]]; then
    selection_args=(--stores "$SHEIN_LINK_BUSINESS_STORES")
  fi
  node scripts/manage_browser_task_leases.mjs "$1" --root "$ROOT" --task "$LEASE_TASK" \
    --run-id "$LEASE_RUN_ID" --owner-pid "$$" --ttl-sec "$LEASE_TTL_SEC" "${selection_args[@]}"
}

on_exit() {
  local exit_status=$?
  set +e
  if [[ "$LEASE_ACTIVE" == "1" ]]; then
    close_store_browsers
    lease_action release >/dev/null 2>&1 || true
    LEASE_ACTIVE=0
  fi
}

write_link_business_success() {
  local portal_refreshed="$1"
  mkdir -p "$ROOT/state/cloud_ops_alerts"
  DATE="$DATE" \
  LOG_FILE="$LOG_FILE" \
  PORTAL_REFRESHED="$portal_refreshed" \
  SUCCESS_STORES="${SUCCESS_STORES[*]}" \
  node - <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const successfulStores = String(process.env.SUCCESS_STORES || '')
  .split(/\s+/)
  .map(value => value.trim().toUpperCase())
  .filter(Boolean);
const payload = {
  ok: true,
  date: process.env.DATE,
  generatedAt: new Date().toISOString(),
  successfulStores,
  failedStores: [],
  metricReady: true,
  warehouseLoaded: true,
  portalRefreshed: ['1', 'true'].includes(String(process.env.PORTAL_REFRESHED || '').toLowerCase()),
  logFile: process.env.LOG_FILE,
};
const file = path.join(root, 'state', 'cloud_ops_alerts', 'link-business-last-success.json');
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
fs.renameSync(tmp, file);
NODE
}

write_chunk_result() {
  local status="$1"
  local message="$2"
  [[ -n "$CHUNK_RESULT_FILE" ]] || return 0
  mkdir -p "$(dirname "$CHUNK_RESULT_FILE")"
  DATE="$DATE" \
  STATUS="$status" \
  MESSAGE="$message" \
  SUCCESS_STORES="${SUCCESS_STORES[*]}" \
  FAILED_STORES="${FAILED_STORES[*]}" \
  LOG_FILE="$LOG_FILE" \
  CHUNK_RESULT_FILE="$CHUNK_RESULT_FILE" \
  node - <<'NODE'
const fs = require('fs');
const split = value => String(value || '')
  .split(/[\s,]+/)
  .map(item => item.trim().toUpperCase())
  .filter(Boolean);
const payload = {
  ok: process.env.STATUS === 'done',
  status: process.env.STATUS,
  date: process.env.DATE,
  generatedAt: new Date().toISOString(),
  successfulStores: split(process.env.SUCCESS_STORES),
  failedStores: split(process.env.FAILED_STORES),
  message: process.env.MESSAGE || '',
  logFile: process.env.LOG_FILE,
};
const temporary = `${process.env.CHUNK_RESULT_FILE}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {mode: 0o660});
fs.renameSync(temporary, process.env.CHUNK_RESULT_FILE);
NODE
}

store_profile_dir() {
  local key="$1"
  STORE_KEY="$key" node -e "const fs=require('fs'); const path=require('path'); const cfg=JSON.parse(fs.readFileSync('config/stores.json','utf8')); const s=(cfg.stores||[]).find(x=>String(x.storeKey).toUpperCase()===process.env.STORE_KEY.toUpperCase()); if(!s) process.exit(2); console.log(path.join(process.cwd(),'profiles',\`persistent-\${s.profileKey}-profile\`));"
}

close_one_store_browser() {
  local key="$1"
  local owned_args=()
  if [[ "$LEASE_ACTIVE" == "1" ]]; then
    owned_args+=(--owned-lease-task "$LEASE_TASK" --owned-lease-run-id "$LEASE_RUN_ID")
  fi
  node scripts/cleanup_shein_store_browsers.mjs --store "$key" --cleanup-chrome-tmp --kill-after-sec 5 "${owned_args[@]}" || true
}

run_store_fetch() {
  local store="$1"
  if is_true "$PER_STORE_BROWSER_WRAPPER"; then
    bash scripts/run_host_browser_read_job.sh \
      --domain "daily-link-${store,,}" \
      --lock-wait-sec "${SHEIN_LINK_BUSINESS_BROWSER_LOCK_WAIT_SEC:-600}" \
      --defer-state "/srv/shein-bi/runtime/host-scheduler/daily-link-${store,,}.latest.json" \
      -- bash scripts/cloud_link_business_store_fetch.sh "$store" "$DATE"
    return $?
  fi

  node scripts/restore_shein_store_session.mjs \
    --store "$store" \
    --date "$DATE" \
    --headless \
    --timeout-ms "${SHEIN_SESSION_RESTORE_TIMEOUT_MS:-180000}" \
    && node scripts/fetch_shein_links.mjs \
      --stores "$store" \
      --date "$DATE" \
      --page-size "${SHEIN_LINK_PAGE_SIZE:-50}" \
    && node scripts/fetch_shein_business_domains.mjs \
      --store "$store" \
      --date "$DATE" \
      --domains "${SHEIN_BUSINESS_DOMAINS:-home,afterSales,waybill,fulfillment,productInventory,management,marketing,quality,comments}" \
      --wait-ms "${SHEIN_BUSINESS_WAIT_MS:-2000}" \
      --max-pages "${SHEIN_BUSINESS_MAX_PAGES:-20}" \
      --store-attempts "${SHEIN_BUSINESS_STORE_ATTEMPTS:-2}" \
      --relogin-headless \
      --json
}

store_keys() {
  if [[ -n "${SHEIN_LINK_BUSINESS_STORES:-}" ]]; then
    echo "$SHEIN_LINK_BUSINESS_STORES" | tr ',' ' '
    return 0
  fi
  node -e "const fs=require('fs'); const cfg=JSON.parse(fs.readFileSync('config/stores.json','utf8')); console.log((cfg.stores||[]).filter(s=>s.enabled!==false).map(s=>s.storeKey).join(' '));"
}

store_evidence_is_complete() {
  local store="$1"
  DATE="$DATE" STORE="$store" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const date = process.env.DATE;
const store = String(process.env.STORE || '').trim().toUpperCase();
const files = [
  path.join(process.cwd(), 'outputs', 'shein_links', store, `${date}.json`),
  path.join(process.cwd(), 'outputs', 'shein_business_domains', store, `${date}.json`),
];
for (const file of files) {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { process.exit(1); }
  const payloadStore = String(payload?.store?.storeKey || '').trim().toUpperCase();
  if (payload?.ok !== true || String(payload?.date || '') !== date || payloadStore !== store) process.exit(1);
}
NODE
}

run_store_worker() {
  local store="$1"
  local status_dir="$2"
  local store_ok=0
  local max_attempts="${SHEIN_LINK_BUSINESS_STORE_ATTEMPTS:-3}"

  if is_true "$RESUME_COMPLETED" && store_evidence_is_complete "$store"; then
    echo "success" > "$status_dir/$store"
    echo "[cloud_link_business_sync] store=$store resume-skip exact-date link/business evidence already complete"
    return 0
  fi

  local attempt resource_attempt store_status
  for attempt in $(seq 1 "$max_attempts"); do
    lease_action heartbeat >/dev/null
    echo "[cloud_link_business_sync] store=$store attempt=$attempt/$max_attempts bootstrap/fetch start"
    close_one_store_browser "$store"
    resource_attempt=0
    while true; do
      set +e
      run_store_fetch "$store"
      store_status=$?
      set -e
      if [[ "$store_status" == "75" && "$resource_attempt" -lt "$RESOURCE_RETRIES" ]]; then
        resource_attempt=$((resource_attempt + 1))
        echo "[cloud_link_business_sync] store=$store waiting for browser capacity retry=$resource_attempt/$RESOURCE_RETRIES"
        sleep "$RESOURCE_RETRY_SLEEP_SEC"
        continue
      fi
      break
    done
    close_one_store_browser "$store"
    if [[ "$store_status" == "0" ]]; then
      store_ok=1
      echo "[cloud_link_business_sync] store=$store done"
      break
    fi
    echo "[cloud_link_business_sync] store=$store attempt=$attempt failed; will retry after short cooldown" >&2
    sleep 10
  done

  if [[ "$store_ok" == "1" ]]; then
    echo "success" > "$status_dir/$store"
  else
    echo "failed" > "$status_dir/$store"
    echo "[cloud_link_business_sync] store=$store failed after $max_attempts attempts" >&2
  fi
  return 0
}

DATE="$(resolve_date "$TARGET")"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/link-business-${DATE}-${STAMP}.log"

exec > >(tee -a "$LOG_FILE") 2>&1

echo "[cloud_link_business_sync] start target=$TARGET date=$DATE root=$ROOT"
cd "$ROOT"
validate_metric_refetch_config
prepare_shared_lock_file "$LINK_PARTIAL_LOCK_FILE"
prepare_shared_lock_file "$LINK_RUN_LOCK_FILE"
if ! is_true "$FETCH_ONLY"; then
  exec 8>"$LINK_RUN_LOCK_FILE"
  flock -w "$LINK_RUN_LOCK_WAIT_SEC" 8 || {
    echo "[cloud_link_business_sync] could not acquire full-run/publish lifecycle lock" >&2
    exit 75
  }
fi
if is_true "$METRIC_REFETCH_ON_NOT_READY"; then
  METRIC_REFETCH_RUN_KEY="${METRIC_REFETCH_RUN_KEY:-$DATE}"
  validate_metric_refetch_paths_and_stores
  metric_refetch_load_state
  recover_interrupted_metric_refetch_transaction
  echo "[cloud_link_business_sync] metric refetch guard enabled runKey=$METRIC_REFETCH_RUN_KEY attempts=$METRIC_REFETCH_ATTEMPTS/$METRIC_REFETCH_MAX_ATTEMPTS deadline=$METRIC_REFETCH_DEADLINE_EPOCH"
fi

export SHEIN_BI_PORTAL_TIMEOUT_MS="${SHEIN_BI_PORTAL_TIMEOUT_MS:-1800000}"
export SHEIN_BI_PORTAL_DATA_MODE="${SHEIN_BI_PORTAL_DATA_MODE:-api}"

trap on_exit EXIT
STORES="$(store_keys)"
FAILED_STORES=()
SUCCESS_STORES=()
ALLOW_PARTIAL="${SHEIN_LINK_BUSINESS_ALLOW_PARTIAL:-1}"
if is_true "$FINALIZE_ONLY"; then
  echo "[cloud_link_business_sync] finalize-only validate current-date all-store evidence"
  while IFS='|' read -r STATUS STORE REASON; do
    [[ -n "$STORE" ]] || continue
    if [[ "$STATUS" == "ok" ]]; then
      SUCCESS_STORES+=("$STORE")
    else
      FAILED_STORES+=("$STORE")
      echo "[cloud_link_business_sync] finalize evidence missing store=$STORE reason=$REASON" >&2
    fi
  done < <(
    DATE="$DATE" STORES="$STORES" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const date = process.env.DATE;
const stores = String(process.env.STORES || '').split(/\s+/).map(value => value.trim().toUpperCase()).filter(Boolean);
for (const store of stores) {
  const files = [
    path.join(process.cwd(), 'outputs', 'shein_links', store, `${date}.json`),
    path.join(process.cwd(), 'outputs', 'shein_business_domains', store, `${date}.json`),
  ];
  let reason = '';
  for (const file of files) {
    try {
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      const payloadStore = String(payload?.store?.storeKey || '').trim().toUpperCase();
      if (payload?.ok !== true) reason = `not_ok:${path.basename(path.dirname(file))}`;
      else if (String(payload?.date || '') !== date) reason = `date_mismatch:${path.basename(path.dirname(file))}`;
      else if (payloadStore !== store) reason = `store_mismatch:${path.basename(path.dirname(file))}`;
    } catch (error) {
      reason = error?.code === 'ENOENT' ? `missing:${file}` : `invalid:${file}`;
    }
    if (reason) break;
  }
  process.stdout.write(`${reason ? 'failed' : 'ok'}|${store}|${reason}\n`);
}
NODE
  )
else
  lease_action acquire
  LEASE_ACTIVE=1
  close_store_browsers
  if is_true "$PER_STORE_BROWSER_WRAPPER" && [[ "$BROWSER_CONCURRENCY" =~ ^[0-9]+$ ]] && (( BROWSER_CONCURRENCY > 1 )); then
    STATUS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/shein-link-business-status.XXXXXX")"
    WORKER_PIDS=()
    for STORE in $STORES; do
      run_store_worker "$STORE" "$STATUS_DIR" &
      WORKER_PIDS+=("$!")
      if (( ${#WORKER_PIDS[@]} >= BROWSER_CONCURRENCY )); then
        FINISHED_PID=""
        wait -n -p FINISHED_PID "${WORKER_PIDS[@]}" || true
        REMAINING_PIDS=()
        for WORKER_PID in "${WORKER_PIDS[@]}"; do
          [[ "$WORKER_PID" == "$FINISHED_PID" ]] || REMAINING_PIDS+=("$WORKER_PID")
        done
        WORKER_PIDS=("${REMAINING_PIDS[@]}")
      fi
    done
    # Do not use bare `wait` here. This script logs through a process-substitution
    # `tee`, which is also a shell child and only exits after this script closes
    # stdout. Waiting for every child would deadlock the coordinator and tee.
    for WORKER_PID in "${WORKER_PIDS[@]}"; do
      wait "$WORKER_PID" || true
    done
    for STORE in $STORES; do
      if [[ "$(cat "$STATUS_DIR/$STORE" 2>/dev/null || true)" == "success" ]]; then
        SUCCESS_STORES+=("$STORE")
      else
        FAILED_STORES+=("$STORE")
      fi
    done
    rm -rf -- "$STATUS_DIR"
    write_chunk_result "running" "parallel store workers completed inside the same coordinator run"
  else
    for STORE in $STORES; do
    if is_true "$RESUME_COMPLETED" && store_evidence_is_complete "$STORE"; then
      SUCCESS_STORES+=("$STORE")
      echo "[cloud_link_business_sync] store=$STORE resume-skip exact-date link/business evidence already complete"
      write_chunk_result "running" "incremental progress saved after resume-skip: $STORE"
      continue
    fi
    STORE_OK=0
    MAX_ATTEMPTS="${SHEIN_LINK_BUSINESS_STORE_ATTEMPTS:-3}"
    for ATTEMPT in $(seq 1 "$MAX_ATTEMPTS"); do
      lease_action heartbeat >/dev/null
      echo "[cloud_link_business_sync] store=$STORE attempt=$ATTEMPT/$MAX_ATTEMPTS bootstrap/fetch start"
      close_one_store_browser "$STORE"
      RESOURCE_ATTEMPT=0
      while true; do
        set +e
        run_store_fetch "$STORE"
        STORE_STATUS=$?
        set -e
        if [[ "$STORE_STATUS" == "75" && "$RESOURCE_ATTEMPT" -lt "$RESOURCE_RETRIES" ]]; then
          RESOURCE_ATTEMPT=$((RESOURCE_ATTEMPT + 1))
          echo "[cloud_link_business_sync] store=$STORE waiting for browser capacity retry=$RESOURCE_ATTEMPT/$RESOURCE_RETRIES"
          sleep "$RESOURCE_RETRY_SLEEP_SEC"
          continue
        fi
        break
      done
      if [[ "$STORE_STATUS" == "0" ]]; then
        STORE_OK=1
        close_one_store_browser "$STORE"
        echo "[cloud_link_business_sync] store=$STORE done"
        SUCCESS_STORES+=("$STORE")
        write_chunk_result "running" "incremental progress saved after store: $STORE"
        break
      fi
      close_one_store_browser "$STORE"
      echo "[cloud_link_business_sync] store=$STORE attempt=$ATTEMPT failed; will retry after short cooldown" >&2
      sleep 10
    done
    if [[ "$STORE_OK" != "1" ]]; then
      echo "[cloud_link_business_sync] store=$STORE failed after $MAX_ATTEMPTS attempts" >&2
      FAILED_STORES+=("$STORE")
      write_chunk_result "running" "incremental failed-store progress saved after store: $STORE"
      if ! is_true "$ALLOW_PARTIAL"; then
        write_chunk_result "failed" "store fetch failed"
        exit 1
      fi
    fi
    done
  fi
fi

if is_true "$FETCH_ONLY"; then
  if [[ "${#FAILED_STORES[@]}" -gt 0 ]]; then
    if is_true "$ALLOW_PARTIAL"; then
      write_chunk_result "warning" "one or more stores failed; completed stores are preserved for the next chunk"
      echo "[cloud_link_business_sync] fetch-only partial stores=${SUCCESS_STORES[*]} failed=${FAILED_STORES[*]}" >&2
      exit 0
    fi
    write_chunk_result "failed" "one or more stores failed"
    echo "[cloud_link_business_sync] fetch-only failed stores=${FAILED_STORES[*]}" >&2
    exit 1
  fi
  write_chunk_result "done" "selected stores fetched; global merge intentionally deferred"
  echo "[cloud_link_business_sync] fetch-only done date=$DATE stores=${SUCCESS_STORES[*]} log=$LOG_FILE"
  exit 0
fi

# Targeted manual-login recovery runs select exactly the stores recorded in the
# canonical partial.  They may never publish a one-store subset: when a
# same-date partial exists and the targeted store succeeded, it is atomically
# moved from failed to success in the partial; if other failed stores remain
# the reduced partial is persisted and the run exits before any warehouse/portal
# publication.  Only when the combined evidence exactly covers every enabled
# store with an empty failed set may the run proceed once to full
# merge/load/publish.
if [[ -n "${SHEIN_LINK_BUSINESS_STORES:-}" ]]; then
  TARGETED_RECOVERY=1
else
  TARGETED_RECOVERY=0
fi

if [[ "$TARGETED_RECOVERY" == "1" && "${#FAILED_STORES[@]}" -eq 0 ]]; then
  if [[ ! -e "$ROOT/state/cloud_ops_alerts/link-business-last-partial.json" ]]; then
    echo "[cloud_link_business_sync] targeted run has no canonical partial to reconcile; refusing warehouse/portal publication of a store subset" >&2
    check_portal_health
    exit 0
  fi
  if [[ ! -s "$ROOT/state/cloud_ops_alerts/link-business-last-partial.json" ]]; then
    echo "[cloud_link_business_sync] canonical partial exists but is empty; refusing recovery" >&2
    exit 1
  fi
  # The canonical partial read-modify-write and the hold/publish decision are
  # one critical section under the shared partial lock: no concurrent fallback
  # seed, targeted update or final decision can observe a half-written partial.
  TARGETED_RECOVERY_OUTCOME="$(
    {
      flock -w "$LINK_PARTIAL_LOCK_WAIT_SEC" 9 || {
        echo "[cloud_link_business_sync] could not acquire canonical partial lock; aborting targeted recovery update" >&2
        exit 75
      }
      DATE="$DATE" CURRENT_SUCCESS_STORES="${SUCCESS_STORES[*]}" CURRENT_FAILED_STORES="${FAILED_STORES[*]}" LOG_FILE="$LOG_FILE" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const split = value => (Array.isArray(value) ? value : String(value || '').split(/[\s,]+/))
  .map(item => String(item || '').trim().toUpperCase())
  .filter(Boolean);
const file = path.join(root, 'state', 'cloud_ops_alerts', 'link-business-last-partial.json');
const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!prior || String(prior.date || '') !== String(process.env.DATE || '')) {
  process.stdout.write('nomatch|no_same_date_partial');
  process.exit(0);
}
const success = new Set(split(prior.successStores));
const failed = new Set(split(prior.failedStores));
for (const store of split(process.env.CURRENT_SUCCESS_STORES)) {
  success.add(store);
  failed.delete(store);
}
for (const store of split(process.env.CURRENT_FAILED_STORES)) {
  failed.add(store);
  success.delete(store);
}
const payload = {
  date: process.env.DATE,
  generatedAt: new Date().toISOString(),
  failedStores: [...failed].sort().join(' '),
  successStores: [...success].sort().join(' '),
  logFile: process.env.LOG_FILE,
  recoveryRunId: process.env.SHEIN_LINK_BUSINESS_RUN_ID || '',
};
const temporary = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
fs.renameSync(temporary, file);
if (failed.size > 0) {
  process.stdout.write('hold|failed_stores_remain');
  process.exit(0);
}
const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8'));
const expected = (config.stores || [])
  .filter(store => store.enabled !== false)
  .map(store => String(store.storeKey || '').trim().toUpperCase())
  .filter(Boolean)
  .sort();
const merged = [...success].sort();
if (expected.length !== merged.length || expected.some((store, index) => store !== merged[index])) {
  process.stdout.write('hold|store_set_not_exact');
  process.exit(0);
}
process.stdout.write(`publish ${expected.join(' ')}`);
NODE
    } 9>"$LINK_PARTIAL_LOCK_FILE"
  )"
  case "$TARGETED_RECOVERY_OUTCOME" in
    publish*)
      SUCCESS_STORES=(${TARGETED_RECOVERY_OUTCOME#publish })
      echo "[cloud_link_business_sync] targeted recovery completed prior partial; merged all-store evidence: ${SUCCESS_STORES[*]}"
      ;;
    hold*)
      echo "[cloud_link_business_sync] targeted recovery recorded in canonical partial; other failed stores remain; skipping BI warehouse/portal refresh" >&2
      check_portal_health
      exit 0
      ;;
    nomatch*)
      echo "[cloud_link_business_sync] targeted run cannot reconcile with the canonical partial; refusing BI warehouse/portal refresh" >&2
      check_portal_health
      exit 0
      ;;
    *)
      echo "[cloud_link_business_sync] targeted recovery outcome unrecognized (${TARGETED_RECOVERY_OUTCOME:-empty}); refusing BI warehouse/portal refresh" >&2
      check_portal_health
      exit 0
      ;;
  esac
fi

if [[ "${#FAILED_STORES[@]}" -gt 0 ]]; then
  echo "[cloud_link_business_sync] WARN failed stores: ${FAILED_STORES[*]}" >&2
  mkdir -p "$ROOT/state/cloud_ops_alerts"
  (
    flock -w "$LINK_PARTIAL_LOCK_WAIT_SEC" 9 || {
      echo "[cloud_link_business_sync] could not acquire canonical partial lock; aborting partial update" >&2
      exit 75
    }
    DATE="$DATE" \
    GENERATED_AT="$(TZ="$TZ_NAME" date --iso-8601=seconds)" \
    FAILED_STORES="${FAILED_STORES[*]}" \
    SUCCESS_STORES="${SUCCESS_STORES[*]}" \
    LOG_FILE="$LOG_FILE" \
    node - <<'NODE'
const fs = require('fs');
const path = require('path');
const file = path.join(process.cwd(), 'state', 'cloud_ops_alerts', 'link-business-last-partial.json');
const split = value => (Array.isArray(value) ? value : String(value || '').split(/[\s,]+/))
  .map(item => String(item || '').trim().toUpperCase())
  .filter(Boolean);
const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const sameDate = String(prior?.date || '') === String(process.env.DATE || '');
const success = new Set(sameDate ? split(prior?.successStores) : []);
const failed = new Set(sameDate ? split(prior?.failedStores) : []);
for (const store of split(process.env.SUCCESS_STORES)) {
  success.add(store);
  failed.delete(store);
}
for (const store of split(process.env.FAILED_STORES)) {
  failed.add(store);
  success.delete(store);
}
const payload = {
  date: process.env.DATE,
  generatedAt: process.env.GENERATED_AT,
  failedStores: [...failed].join(' '),
  successStores: [...success].join(' '),
  logFile: process.env.LOG_FILE,
  recoveryRunId: process.env.SHEIN_LINK_BUSINESS_RUN_ID || '',
};
const temporary = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
fs.renameSync(temporary, file);
NODE
  ) 9>"$LINK_PARTIAL_LOCK_FILE"
  if [[ "${SHEIN_LINK_BUSINESS_LOAD_PARTIAL:-0}" != "1" && "${SHEIN_LINK_BUSINESS_LOAD_PARTIAL:-0}" != "true" ]]; then
    echo "[cloud_link_business_sync] partial result recorded; skip BI warehouse/portal refresh to avoid presenting incomplete link/business date" >&2
    check_portal_health
    echo "[cloud_link_business_sync] done with partial failures date=$DATE failed=${FAILED_STORES[*]} log=$LOG_FILE"
    if is_true "$FINALIZE_ONLY" && ! is_true "$ALLOW_PARTIAL"; then
      exit 1
    fi
    exit 0
  fi
fi

# A targeted retry should be able to close an earlier all-store partial run
# without re-opening the other 18 browser profiles. Merge only when the prior
# partial is for the same date, every formerly failed store succeeded now, and
# the combined set exactly covers every enabled store. The downstream metric,
# warehouse and portal checks still run over the merged all-store evidence.
if [[ "${#FAILED_STORES[@]}" -eq 0 && -s "$ROOT/state/cloud_ops_alerts/link-business-last-partial.json" ]]; then
  MERGED_RECOVERY_STORES="$(
    DATE="$DATE" CURRENT_SUCCESS_STORES="${SUCCESS_STORES[*]}" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const stateFile = path.join(root, 'state', 'cloud_ops_alerts', 'link-business-last-partial.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
if (String(state.date || '') !== String(process.env.DATE || '')) process.exit(0);
const split = value => (Array.isArray(value) ? value : String(value || '').split(/[\s,]+/))
  .map(item => String(item || '').trim().toUpperCase())
  .filter(Boolean);
const current = new Set(split(process.env.CURRENT_SUCCESS_STORES));
const failed = split(state.failedStores);
if (!failed.length || failed.some(store => !current.has(store))) process.exit(0);
const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8'));
const expected = (config.stores || [])
  .filter(store => store.enabled !== false)
  .map(store => String(store.storeKey || '').trim().toUpperCase())
  .filter(Boolean);
const merged = new Set([...split(state.successStores), ...current]);
if (expected.some(store => !merged.has(store)) || [...merged].some(store => !expected.includes(store))) process.exit(0);
process.stdout.write(expected.join(' '));
NODE
  )"
  if [[ -n "$MERGED_RECOVERY_STORES" ]]; then
    SUCCESS_STORES=($MERGED_RECOVERY_STORES)
    echo "[cloud_link_business_sync] targeted recovery completed prior partial; merged all-store evidence: ${SUCCESS_STORES[*]}"
  fi
fi

# Final publish gate: before any full merge/load/publish, every enabled store
# must have exact-date link and business evidence files with a valid
# ok/date/storeKey schema (same predicate as store_evidence_is_complete).
# Missing, corrupt or stale evidence keeps the canonical partial (the invalid
# stores are recorded back as failed under the shared partial lock) and exits
# before any warehouse/portal publication.
if [[ "${#FAILED_STORES[@]}" -eq 0 ]]; then
  EVIDENCE_OUTCOME="$(
    DATE="$DATE" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const date = process.env.DATE;
const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8'));
const invalid = [];
for (const row of config.stores || []) {
  if (row.enabled === false) continue;
  const store = String(row.storeKey || '').trim().toUpperCase();
  let complete = Boolean(store);
  for (const domain of ['shein_links', 'shein_business_domains']) {
    const file = path.join(root, 'outputs', domain, store, `${date}.json`);
    try {
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      const payloadStore = String(payload?.store?.storeKey || '').trim().toUpperCase();
      if (payload?.ok !== true || String(payload?.date || '') !== date || payloadStore !== store) complete = false;
    } catch {
      complete = false;
    }
  }
  if (!complete) invalid.push(store);
}
process.stdout.write(invalid.length ? `evidence-missing|${invalid.join(' ')}` : 'evidence-ok');
NODE
  )"
  if [[ "$EVIDENCE_OUTCOME" != "evidence-ok" ]]; then
    INVALID_EVIDENCE_STORES="${EVIDENCE_OUTCOME#evidence-missing|}"
    echo "[cloud_link_business_sync] final publish blocked: exact-date link/business evidence invalid for ${INVALID_EVIDENCE_STORES}; keeping canonical partial" >&2
    (
      flock -w "$LINK_PARTIAL_LOCK_WAIT_SEC" 9 || {
        echo "[cloud_link_business_sync] could not acquire canonical partial lock; aborting evidence partial update" >&2
        exit 75
      }
      DATE="$DATE" \
      GENERATED_AT="$(TZ="$TZ_NAME" date --iso-8601=seconds)" \
      INVALID_EVIDENCE_STORES="$INVALID_EVIDENCE_STORES" \
      LOG_FILE="$LOG_FILE" \
      node - <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const file = path.join(root, 'state', 'cloud_ops_alerts', 'link-business-last-partial.json');
const split = value => (Array.isArray(value) ? value : String(value || '').split(/[\s,]+/))
  .map(item => String(item || '').trim().toUpperCase())
  .filter(Boolean);
const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8'));
const enabled = (config.stores || [])
  .filter(store => store.enabled !== false)
  .map(store => String(store.storeKey || '').trim().toUpperCase())
  .filter(Boolean);
const invalid = new Set(split(process.env.INVALID_EVIDENCE_STORES));
const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const sameDate = String(prior?.date || '') === String(process.env.DATE || '');
const success = new Set(sameDate ? split(prior?.successStores) : []);
const failed = new Set(sameDate ? split(prior?.failedStores) : []);
for (const store of enabled) {
  if (invalid.has(store)) {
    failed.add(store);
    success.delete(store);
  } else {
    success.add(store);
    failed.delete(store);
  }
}
const payload = {
  date: process.env.DATE,
  generatedAt: process.env.GENERATED_AT,
  failedStores: [...failed].join(' '),
  successStores: [...success].join(' '),
  logFile: process.env.LOG_FILE,
  recoveryRunId: process.env.SHEIN_LINK_BUSINESS_RUN_ID || '',
};
const temporary = `${file}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
fs.renameSync(temporary, file);
NODE
    ) 9>"$LINK_PARTIAL_LOCK_FILE"
    check_portal_health
    echo "[cloud_link_business_sync] done with evidence-incomplete date=$DATE invalid=${INVALID_EVIDENCE_STORES} log=$LOG_FILE"
    exit 0
  fi
fi

calculate_metric_readiness() {
  local staging_root="${1:-}"
  local staging_stores="${2:-}"
  DATE="$DATE" \
  SUCCESS_STORES="${SUCCESS_STORES[*]}" \
  METRIC_STAGING_ROOT="$staging_root" \
  METRIC_STAGING_STORES="$staging_stores" \
  node - <<'NODE'
const fs = require('fs');
const path = require('path');

const date = process.env.DATE;
const successStores = String(process.env.SUCCESS_STORES || '')
  .split(/\s+/)
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);
const successSet = new Set(successStores);
const stagingRoot = String(process.env.METRIC_STAGING_ROOT || '');
const stagingStores = new Set(String(process.env.METRIC_STAGING_STORES || '')
  .split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean));
  const expectedStores = 'CX DL DX FY HL JSH JY LQ MZ NM QH QY TS TZ TZZ XC XL YJ ZL'.split(' ');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
  const finiteMetric = (object, names) => {
    const key = names.find(name => own(object, name));
    if (!key) {
      return {ok: false, value: null, reason: 'missing'};
    }
    const value = object[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return {ok: false, value: null, reason: 'not_finite_json_number'};
    }
    return {ok: true, value, reason: ''};
};
const requiredFields = [
  {name: 'epsUv', aliases: ['epsUv', 'eps_uv']},
  {name: 'goodsUv', aliases: ['goodsUv', 'goods_uv']},
  {name: 'saleCnt', aliases: ['saleCnt', 'sale_cnt']},
  {name: 'payOrderCnt', aliases: ['payOrderCnt', 'pay_order_cnt']},
];

const metrics = {
  date,
  successStores,
  expectedStores,
  expectedStoreCount: expectedStores.length,
  files: 0,
  performanceRows: 0,
  diagnoseDayRows: 0,
  readyStores: [],
  unavailableStores: [],
  unavailableByStore: {},
  refetchStores: [],
  epsUv: 0,
  goodsUv: 0,
  saleCnt: 0,
  payOrderCnt: 0,
  sourceContract: {
    identity: 'ok=true and exact date/store',
    diagnoseDay: 'present finite nonnegative diagnostic count; zero is valid; performanceRows is the readiness proof',
    performanceRows: 'present array with counts.performanceRows equal to array length and length > 0',
    requiredFields: ['epsUv', 'goodsUv', 'saleCnt', 'payOrderCnt'],
    zeroSemantics: 'finite JSON number zero is valid only when identity and source-count contract are proven; strings/null/arrays/objects/missing are unavailable',
  },
};
const evidenceIssues = [];

for (const store of expectedStores) {
  if (!successSet.has(store)) {
    evidenceIssues.push(`${store}:not_in_exact_success_set`);
    continue;
  }
  const file = stagingRoot && stagingStores.has(store)
    ? path.join(stagingRoot, store, `${date}.json`)
    : path.join(process.cwd(), 'outputs', 'shein_links', store, `${date}.json`);
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) {
    evidenceIssues.push(`${store}:artifact_missing_or_symlink`);
    continue;
  }
  let payload;
  try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    evidenceIssues.push(`${store}:artifact_invalid_json`);
    continue;
  }
  if (payload?.ok !== true || String(payload?.date || '') !== date
    || String(payload?.store?.storeKey || '').trim().toUpperCase() !== store) {
    evidenceIssues.push(`${store}:artifact_identity_invalid`);
    continue;
  }
  metrics.files += 1;
  const storeIssues = [];
  const rows = Array.isArray(payload.performanceRows) ? payload.performanceRows : null;
  if (!rows) storeIssues.push('performanceRows:not_array');
  const diagnoseDay = finiteMetric(payload.counts, ['diagnoseDay']);
  const performanceCount = finiteMetric(payload.counts, ['performanceRows']);
  if (!diagnoseDay.ok) storeIssues.push(`counts.diagnoseDay:${diagnoseDay.reason}`);
  else if (!Number.isInteger(diagnoseDay.value)) storeIssues.push('counts.diagnoseDay:invalid');
  if (!performanceCount.ok) storeIssues.push(`counts.performanceRows:${performanceCount.reason}`);
  else if (!Number.isInteger(performanceCount.value)) storeIssues.push('counts.performanceRows:not_integer');
  if (rows && rows.length === 0) storeIssues.push('performanceRows:empty');
  if (rows && performanceCount.ok && performanceCount.value !== rows.length) {
    storeIssues.push('counts.performanceRows:row_count_mismatch');
  }

  for (const [index, row] of (rows || []).entries()) {
    for (const field of requiredFields) {
      const parsed = finiteMetric(row, field.aliases);
      if (!parsed.ok) storeIssues.push(`performanceRows[${index}].${field.name}:${parsed.reason}`);
      else metrics[field.name] += parsed.value;
    }
  }

  metrics.performanceRows += (rows || []).length;
  if (diagnoseDay.ok) metrics.diagnoseDayRows += diagnoseDay.value;
  if (storeIssues.length) {
    metrics.unavailableStores.push(store);
    metrics.unavailableByStore[store] = storeIssues;
  } else {
    metrics.readyStores.push(store);
  }
}

metrics.refetchStores = [...metrics.unavailableStores];
const ok = evidenceIssues.length === 0 && metrics.refetchStores.length === 0
  && metrics.readyStores.length === expectedStores.length;
const status = evidenceIssues.length ? 3 : (ok ? 0 : 2);
console.log(JSON.stringify({
  ok,
  reason: evidenceIssues.length ? 'exact_store_evidence_incomplete'
    : (ok ? '' : 'daily_link_metrics_unavailable'),
  evidenceIssues,
  metrics,
}));
process.exit(status);
NODE
}

set +e
METRIC_READY_JSON="$(calculate_metric_readiness)"
METRIC_READY_STATUS=$?
set -e
echo "[cloud_link_business_sync] link metric readiness: $METRIC_READY_JSON"
if [[ "$METRIC_READY_STATUS" != "0" && "$METRIC_REFETCH_SOURCE_STATUS" == "source_committed" ]]; then
  write_metric_refetch_state "source_committed_readiness_mismatch" "$CANONICAL_METRIC_STORES" \
    "$CANONICAL_METRIC_STORES" "$CANONICAL_METRIC_STORES" ""
  write_metric_not_ready_alert "$METRIC_READY_JSON" "$CANONICAL_METRIC_STORES" "source-committed-readiness-mismatch"
  echo "[cloud_link_business_sync] CRITICAL verified source_committed state disagrees with readiness; block downstream and never refetch/promote this run" >&2
  exit 70
fi
if [[ "$METRIC_READY_STATUS" != "0" ]]; then
  METRIC_REFETCH_SKIP_PUBLISH=0
  if [[ "$METRIC_READY_STATUS" == "2" ]] && is_true "$METRIC_REFETCH_ON_NOT_READY"; then
    METRIC_PRE_REFETCH_READY_JSON="$METRIC_READY_JSON"
    METRIC_REFETCH_TARGET_STORES="$(metric_refetch_target_stores "$METRIC_READY_JSON")"
    METRIC_REFETCH_BATCH_TARGET_STORES="$CANONICAL_METRIC_STORES"
    METRIC_REFETCH_TRANSACTION_ROOT="$(mktemp -d "$ROOT/state/.link-business-metric-refetch.XXXXXX")"
    METRIC_REFETCH_CANDIDATE_ROOT="$METRIC_REFETCH_TRANSACTION_ROOT/candidates"
    mkdir -p "$METRIC_REFETCH_CANDIDATE_ROOT"
    for store in $CANONICAL_METRIC_STORES; do
      mkdir -p "$METRIC_REFETCH_CANDIDATE_ROOT/$store"
      cp -p -- "$ROOT/outputs/shein_links/$store/$DATE.json" "$METRIC_REFETCH_CANDIDATE_ROOT/$store/$DATE.json"
    done
    append_metric_refetch_journal "transaction_created" "" "$METRIC_REFETCH_BATCH_TARGET_STORES"
    while true; do
      if metric_refetch_deadline_reached; then
        write_metric_refetch_state "deadline" "$METRIC_REFETCH_BATCH_TARGET_STORES" \
          "${METRIC_REFETCH_REPLACED_STORES[*]:-}" \
          "${METRIC_REFETCH_FAILED_STORES[*]:-}" \
          "${METRIC_REFETCH_DEFERRED_STORES[*]:-}"
        write_metric_not_ready_alert "$METRIC_READY_JSON" "$METRIC_REFETCH_BATCH_TARGET_STORES" "deadline"
        echo "[cloud_link_business_sync] metric refetch deadline reached; retain prior complete link artifacts" >&2
        check_portal_health
        exit 75
      fi
      if (( METRIC_REFETCH_ATTEMPTS >= METRIC_REFETCH_MAX_ATTEMPTS )); then
        write_metric_refetch_state "exhausted" "$METRIC_REFETCH_BATCH_TARGET_STORES" \
          "${METRIC_REFETCH_REPLACED_STORES[*]:-}" \
          "${METRIC_REFETCH_FAILED_STORES[*]:-}" \
          "${METRIC_REFETCH_DEFERRED_STORES[*]:-}"
        write_metric_not_ready_alert "$METRIC_READY_JSON" "$METRIC_REFETCH_BATCH_TARGET_STORES" "exhausted"
        echo "[cloud_link_business_sync] metric refetch attempt bound reached; retain prior complete link artifacts" >&2
        check_portal_health
        exit 75
      fi
      if [[ -z "$METRIC_REFETCH_TARGET_STORES" ]]; then
        write_metric_refetch_state "failed" "" "" "" ""
        write_metric_not_ready_alert "$METRIC_READY_JSON" "" "no-targets"
        echo "[cloud_link_business_sync] metric readiness was not refetchable; retain prior complete link artifacts" >&2
        check_portal_health
        exit 75
      fi

      METRIC_REFETCH_ATTEMPTS=$((METRIC_REFETCH_ATTEMPTS + 1))
      write_metric_refetch_state "running" "$METRIC_REFETCH_BATCH_TARGET_STORES" "" "$METRIC_REFETCH_TARGET_STORES" ""
      run_metric_refetch_round "$METRIC_REFETCH_TARGET_STORES" "$METRIC_REFETCH_CANDIDATE_ROOT"
      METRIC_REFETCH_TARGET_STORES="$(metric_refetch_pending_candidates \
        "$METRIC_REFETCH_TARGET_STORES" "$METRIC_REFETCH_CANDIDATE_ROOT")"
      METRIC_REFETCH_FAILED_STORES=($METRIC_REFETCH_TARGET_STORES)

      if [[ -n "$METRIC_REFETCH_TARGET_STORES" ]]; then
        write_metric_refetch_state "waiting" "$METRIC_REFETCH_BATCH_TARGET_STORES" "" \
          "${METRIC_REFETCH_FAILED_STORES[*]:-}" \
          "${METRIC_REFETCH_DEFERRED_STORES[*]:-}"
        write_metric_not_ready_alert "$METRIC_READY_JSON" "$METRIC_REFETCH_BATCH_TARGET_STORES" "waiting"
        if ! metric_refetch_sleep_before_next_attempt; then
          continue
        fi
        continue
      fi

      set +e
      METRIC_READY_JSON="$(calculate_metric_readiness \
        "$METRIC_REFETCH_CANDIDATE_ROOT" "$METRIC_REFETCH_BATCH_TARGET_STORES")"
      METRIC_READY_STATUS=$?
      set -e
      echo "[cloud_link_business_sync] staged link metric readiness after refetch attempt=$METRIC_REFETCH_ATTEMPTS: $METRIC_READY_JSON"
      if [[ "$METRIC_READY_STATUS" != "0" ]]; then
        write_metric_refetch_state "staging_invalid" "$METRIC_REFETCH_BATCH_TARGET_STORES" "" \
          "$METRIC_REFETCH_BATCH_TARGET_STORES" ""
        write_metric_not_ready_alert "$METRIC_READY_JSON" "$METRIC_REFETCH_BATCH_TARGET_STORES" "staging-invalid"
        check_portal_health
        exit 75
      fi

      if metric_refetch_deadline_reached; then
        continue
      fi
      set +e
      commit_metric_refetch_batch "$METRIC_REFETCH_BATCH_TARGET_STORES" "$METRIC_REFETCH_CANDIDATE_ROOT"
      METRIC_COMMIT_STATUS=$?
      set -e
      if (( METRIC_COMMIT_STATUS != 0 )); then
        if [[ "$METRIC_REFETCH_SOURCE_STATUS" == "rollback_failed" ]]; then
          write_metric_refetch_state "rollback_failed" "$METRIC_REFETCH_BATCH_TARGET_STORES" "" \
            "$METRIC_REFETCH_BATCH_TARGET_STORES" ""
        else
          write_metric_refetch_state "commit_failed_rolled_back" "$METRIC_REFETCH_BATCH_TARGET_STORES" "" \
            "$METRIC_REFETCH_BATCH_TARGET_STORES" ""
        fi
        write_metric_not_ready_alert "$METRIC_PRE_REFETCH_READY_JSON" \
          "$METRIC_REFETCH_BATCH_TARGET_STORES" "commit-failed"
        echo "[cloud_link_business_sync] metric batch commit failed; pre-run formal artifacts restored or retained" >&2
        exit "$METRIC_COMMIT_STATUS"
      fi

      set +e
      METRIC_READY_JSON="$(calculate_metric_readiness)"
      METRIC_READY_STATUS=$?
      set -e
      if [[ "$METRIC_READY_STATUS" != "0" ]]; then
        write_metric_refetch_state "source_committed_posthash_readiness_mismatch" \
          "$METRIC_REFETCH_BATCH_TARGET_STORES" "${METRIC_REFETCH_REPLACED_STORES[*]:-}" \
          "$METRIC_REFETCH_BATCH_TARGET_STORES" ""
        write_metric_not_ready_alert "$METRIC_PRE_REFETCH_READY_JSON" \
          "$METRIC_REFETCH_BATCH_TARGET_STORES" "source-committed-posthash-readiness-mismatch"
        echo "[cloud_link_business_sync] CRITICAL source_committed hashes verified but readiness revalidation disagreed; source is retained and downstream is blocked" >&2
        exit 75
      fi
      write_metric_refetch_state "source_committed" "$METRIC_REFETCH_BATCH_TARGET_STORES" \
        "${METRIC_REFETCH_REPLACED_STORES[*]:-}" "" ""
      break
    done
  else
    write_metric_not_ready_alert "$METRIC_READY_JSON" "" "disabled"
    echo "[cloud_link_business_sync] link daily metrics are not ready; skip BI warehouse/portal refresh to avoid writing all-zero traffic date" >&2
    check_portal_health
    echo "[cloud_link_business_sync] done with metric-not-ready date=$DATE log=$LOG_FILE"
    exit 0
  fi
fi

PUBLISH_FAILURE_STEP=""
PUBLISH_FAILURE_STATUS=0
run_link_publish_step() {
  local step="$1"
  shift
  local status=0
  if is_true "$METRIC_REFETCH_ON_NOT_READY" && [[ "$METRIC_REFETCH_SOURCE_STATUS" == "source_committed" ]]; then
    if ! verify_metric_refetch_source_fingerprint; then
      PUBLISH_FAILURE_STEP="source-revalidation-before-$step"
      PUBLISH_FAILURE_STATUS=70
      return 1
    fi
    if [[ "$(metric_refetch_phase_status "$step")" == "completed" ]]; then
      echo "[cloud_link_business_sync] phase=$step already completed for runKey=$METRIC_REFETCH_RUN_KEY; reuse receipt"
      return 0
    fi
    update_metric_refetch_phase "$step" "running" "deterministic same-date invocation"
  fi
  set +e
  "$@"
  status=$?
  set -e
  if (( status != 0 )); then
    if is_true "$METRIC_REFETCH_ON_NOT_READY" && [[ "$METRIC_REFETCH_SOURCE_STATUS" == "source_committed" ]]; then
      update_metric_refetch_phase "$step" "failed" "exit=$status"
    fi
    PUBLISH_FAILURE_STEP="$step"
    PUBLISH_FAILURE_STATUS="$status"
    return 1
  fi
  if [[ "${SHEIN_LINK_BUSINESS_TEST_CRASH_AFTER_PHASE:-}" == "$step" ]]; then
    echo "[cloud_link_business_sync] injected crash after phase=$step before receipt" >&2
    exit 75
  fi
  if is_true "$METRIC_REFETCH_ON_NOT_READY" && [[ "$METRIC_REFETCH_SOURCE_STATUS" == "source_committed" ]]; then
    update_metric_refetch_phase "$step" "completed" "exit=0; deterministic same-date operation"
  fi
}

handle_link_publish_failure() {
  echo "[cloud_link_business_sync] publish step failed step=$PUBLISH_FAILURE_STEP status=$PUBLISH_FAILURE_STATUS" >&2
  if [[ "$METRIC_REFETCH_SOURCE_STATUS" == "source_committed" ]]; then
    write_metric_refetch_state "downstream_incomplete" "$CANONICAL_METRIC_STORES" \
      "${METRIC_REFETCH_REPLACED_STORES[*]:-$CANONICAL_METRIC_STORES}" "" ""
    echo "[cloud_link_business_sync] source_committed retained; next same-run invocation resumes phase=$PUBLISH_FAILURE_STEP" >&2
    exit 75
  fi
  exit "$PUBLISH_FAILURE_STATUS"
}

if [[ "$METRIC_REFETCH_SKIP_PUBLISH" == "1" && "$METRIC_REFETCH_BATCH_COMMITTED" != "1" ]]; then
  echo "[cloud_link_business_sync] same-run metric publish already complete; skip duplicate dashboard/warehouse/load/export"
else
  if ! run_link_publish_step "dashboard" node scripts/generate_link_ops_web_dashboard.mjs \
    --date "$DATE" \
    --group ALL; then
    handle_link_publish_failure
  fi

  if ! run_link_publish_step "warehouse" node scripts/load_bi_warehouse.mjs \
    --sales-date 2099-01-01 \
    --link-date "$DATE" \
    --dashboard-json "outputs/link-dashboard/link-ops-dashboard-${DATE}.json"; then
    handle_link_publish_failure
  fi

  if ! run_link_publish_step "business-domain-load" node scripts/load_bi_business_domains.mjs \
    --date "$DATE"; then
    handle_link_publish_failure
  fi

  if ! run_link_publish_step "marketing-export" node scripts/marketing/export_marketing_price_leads_for_bi.mjs; then
    if [[ "$METRIC_REFETCH_SOURCE_STATUS" == "source_committed" ]]; then
      handle_link_publish_failure
    fi
    echo "[cloud_link_business_sync] WARN marketing export failed status=$PUBLISH_FAILURE_STATUS" >&2
  fi
fi

if [[ "$METRIC_REFETCH_SOURCE_STATUS" == "source_committed" ]]; then
  if ! verify_metric_refetch_source_fingerprint; then
    echo "[cloud_link_business_sync] source fingerprint drift before downstream-link completion; ready is forbidden" >&2
    exit 70
  fi
  if [[ "$METRIC_REFETCH_STATE_STATUS" == "publish_completed" || "$METRIC_REFETCH_STATE_STATUS" == "ready" ]]; then
    echo "[cloud_link_business_sync] preserve terminal same-run status=$METRIC_REFETCH_STATE_STATUS"
  else
    append_metric_refetch_journal "downstream_link_completed" "" "dashboard warehouse business-domain-load marketing-export"
    write_metric_refetch_state "downstream_link_completed" "$CANONICAL_METRIC_STORES" \
      "${METRIC_REFETCH_REPLACED_STORES[*]:-}" "" ""
  fi
  METRIC_REFETCH_BATCH_COMMITTED=0
fi
rm -f "$ROOT/state/cloud_ops_alerts/link-business-last-metric-not-ready.json" 2>/dev/null || true

if [[ "${SHEIN_LINK_BUSINESS_REFRESH_PORTAL:-1}" != "1" && "${SHEIN_LINK_BUSINESS_REFRESH_PORTAL:-1}" != "true" ]]; then
  echo "[cloud_link_business_sync] warehouse load done; skip portal refresh because SHEIN_LINK_BUSINESS_REFRESH_PORTAL=${SHEIN_LINK_BUSINESS_REFRESH_PORTAL:-}"
  if [[ "${#FAILED_STORES[@]}" -eq 0 ]]; then
    (
      flock -w "$LINK_PARTIAL_LOCK_WAIT_SEC" 9 || {
        echo "[cloud_link_business_sync] could not acquire canonical partial lock; aborting partial removal" >&2
        exit 75
      }
      rm -f "$ROOT/state/cloud_ops_alerts/link-business-last-partial.json"
    ) 9>"$LINK_PARTIAL_LOCK_FILE"
    write_link_business_success false
  fi
  echo "[cloud_link_business_sync] done date=$DATE log=$LOG_FILE"
  exit 0
fi

if node scripts/audit_bi_warehouse.mjs; then
  AUDIT_STATUS=0
else
  AUDIT_STATUS=$?
  echo "[cloud_link_business_sync] WARN warehouse audit failed status=$AUDIT_STATUS; continuing Portal generation and enqueue" >&2
fi

node scripts/generate_bi_portal.mjs \
  --metabase-url "$METABASE_URL"

node scripts/generate_bi_portal_shell.mjs

if command -v systemctl >/dev/null 2>&1; then
  # Structured proof only: start the portal when LoadState=loaded AND
  # ActiveState=inactive.  Any unknown/error state fails closed (no start).
  PORTAL_LOAD_STATE="$(systemctl show --no-pager --property=LoadState --value shein-bi-portal.service 2>/dev/null || true)"
  PORTAL_ACTIVE_STATE="$(systemctl show --no-pager --property=ActiveState --value shein-bi-portal.service 2>/dev/null || true)"
  if [[ "$PORTAL_LOAD_STATE" == "loaded" && "$PORTAL_ACTIVE_STATE" == "inactive" ]]; then
    systemctl start shein-bi-portal.service || true
  else
    echo "[cloud_link_business_sync] portal start skipped: structured state load=$PORTAL_LOAD_STATE active=$PORTAL_ACTIVE_STATE (start only on loaded+inactive)" >&2
  fi
fi

if [[ "$SHEIN_BI_PORTAL_DATA_MODE" == "api" && "${SHEIN_BI_PORTAL_PREWARM_DISABLED:-0}" != "1" ]]; then
  bash scripts/enqueue_bi_portal_sections.sh \
    --sections linksData,productState,productTrafficDaily,homeTrafficDaily \
    --priority 20 \
    --reason "link-business-$DATE"
  bash scripts/enqueue_bi_portal_sections.sh \
    --sections afterSales,waybills,comments,actions \
    --priority 50 \
    --reason "link-business-$DATE"
  echo "[cloud_link_business_sync] portal sections queued for bounded host-locked refresh"
fi

check_portal_health

if [[ "${#FAILED_STORES[@]}" -gt 0 ]]; then
  echo "[cloud_link_business_sync] done with partial failures date=$DATE failed=${FAILED_STORES[*]} log=$LOG_FILE"
else
  (
    flock -w "$LINK_PARTIAL_LOCK_WAIT_SEC" 9 || {
      echo "[cloud_link_business_sync] could not acquire canonical partial lock; aborting partial removal" >&2
      exit 75
    }
    rm -f "$ROOT/state/cloud_ops_alerts/link-business-last-partial.json"
  ) 9>"$LINK_PARTIAL_LOCK_FILE"
  write_link_business_success true
  echo "[cloud_link_business_sync] done date=$DATE log=$LOG_FILE"
fi
