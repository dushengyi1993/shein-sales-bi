#!/usr/bin/env node

// Deterministic reliability contracts for the morning chain coordinator and
// the per-store browser read wrapper.  No real browser, business write or
// systemd state is required: the coordinator runs inside a stubbed sandbox
// root (the REAL run_cloud_session_manager_job.sh coordinator + a fake lane,
// so the strong-evidence --check-only gate is exercised, never re-implemented)
// and the wrapper runs against stub locks/node, so every scenario is
// reproducible on a plain Linux runner (or WSL).

import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const chain = read('scripts/cloud_morning_chain.sh');
const wrapper = read('scripts/run_host_browser_read_job.sh');

// ---------------------------------------------------------------------------
// Syntax gates
// ---------------------------------------------------------------------------
execFileSync('bash', ['-n', 'scripts/cloud_morning_chain.sh'], {cwd: root, stdio: 'inherit'});
execFileSync('bash', ['-n', 'scripts/run_host_browser_read_job.sh'], {cwd: root, stdio: 'inherit'});
execFileSync('bash', ['-n', 'scripts/run_cloud_session_manager_job.sh'], {cwd: root, stdio: 'inherit'});

// ---------------------------------------------------------------------------
// Source contracts: terminal-state convergence (TERM / INT / EXIT)
// ---------------------------------------------------------------------------
assert.match(chain, /trap 'on_error "\$LINENO" "\$\?"' ERR/);
assert.match(chain, /trap 'on_termination TERM 143' TERM/, 'SIGTERM must converge to a terminal non-running state');
assert.match(chain, /trap 'on_termination INT 130' INT/, 'SIGINT must converge to a terminal non-running state');
assert.match(chain, /trap 'converge_terminal_state/, 'the EXIT trap must converge only when no terminal state was recorded');
assert.match(chain, /converge_terminal_state\(\)/, 'the EXIT/TERM/INT handler must be idempotent');
assert.match(chain, /\[\[ "\$\{TERMINAL_STATE_WRITTEN:-0\}" == "1" \]\] && return 0/, 'repeated signals must converge once');
assert.match(chain, /\|running\|waiting\|waiting_resource\)/,
  'only non-terminal latest states (missing/running/waiting/waiting_resource) may be replaced with failed');
assert.doesNotMatch(chain.slice(chain.indexOf('converge_terminal_state()'), chain.indexOf('wait_for_catchup_startup_window()')),
  /ok[|)]/, 'the convergence handler must never rewrite an ok success state');
assert.match(chain, /write_marker "morning-\$STAGE" "failed"/,
  'termination must leave a failed pipeline marker, never a running marker');
assert.match(chain, /on_termination\(\) \{/, 'the TERM/INT handler must exist');
assert.match(chain, /converge_terminal_state "cloud_morning_chain received SIG/, 'TERM/INT must converge before exiting');
assert.match(chain, /owning service Restart resumes the same active run context/,
  'the TERM message must describe the automatic service Restart resume, never a next-timer retry');

// ---------------------------------------------------------------------------
// Source contracts: absolute run deadline handed to every per-store wrapper
// ---------------------------------------------------------------------------
assert.match(chain, /export SHEIN_HOST_BROWSER_READ_DEADLINE_EPOCH="\$PRE_INVENTORY_DEADLINE_EPOCH"/,
  'all pre-inventory browser work must stop at the inventory-reserve boundary');
assert.match(chain, /RUN_DEADLINE_EPOCH="\$\{SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH:-\$\(\(RUN_STARTED_EPOCH \+ RUN_BUDGET_SEC\)\)\}"\n/,
  'the persisted first-start absolute deadline must override the derived budget on every start');
assert.match(chain, /EXPECTED_BUSINESS_DATE="\$\(TZ="\$TZ_NAME" date -d "\$RUN_DATE - 1 day" \+%F\)"/,
  'the chain must derive the only acceptable business date from the run date');
assert.match(chain, /SESSION_RECOVERY_BUDGET_SEC="\$\{SHEIN_BI_MORNING_SESSION_RECOVERY_BUDGET_SEC:-1800\}"/,
  'morning session recovery must have a bounded configurable budget');
assert.match(chain, /LINK_COLLECTION_RESERVE_SEC="\$\{SHEIN_BI_MORNING_LINK_COLLECTION_RESERVE_SEC:-7200\}"/,
  'morning session recovery must reserve enough internal run budget for link collection');
assert.match(chain, /INVENTORY_RESERVE_SEC="\$\{SHEIN_BI_MORNING_INVENTORY_RESERVE_SEC:-4500\}"/,
  'the coordinator must reserve a real stock-refresh plus inventory-guard window');
assert.match(chain, /PRE_INVENTORY_DEADLINE_EPOCH=\$\(\(RUN_DEADLINE_EPOCH - INVENTORY_RESERVE_SEC\)\)/);
assert.match(chain, /timeout --signal=TERM --kill-after=30s "\$\{remaining\}s" bash scripts\/cloud_daily_refresh\.sh/,
  'supplements must be forcibly bounded by the pre-inventory deadline');
assert.match(chain, /--deadline-epoch "\$RUN_DEADLINE_EPOCH"/,
  'the inventory host-heavy lock and child must inherit the absolute run deadline');
assert.match(chain, /pipeline_marker_done "inventory-started"/,
  'a restart after entering the reserve must resume inventory instead of reapplying the pre-inventory cutoff');
assert.match(chain, /"\$INVENTORY_PLAN" "\$INVENTORY_RESULT"/,
  'the final marker must directly bind the real inventory plan and result');
assert.match(chain, /budget_deadline=\$\(\(now \+ SESSION_RECOVERY_BUDGET_SEC\)\)/);
assert.match(chain, /reserve_deadline=\$\(\(RUN_DEADLINE_EPOCH - LINK_COLLECTION_RESERVE_SEC\)\)/);
assert.match(chain, /--check-only/, 'the gate must reuse the session helper strong-evidence predicate');
assert.doesNotMatch(chain, /nightly_session_marker_status\(\)/,
  'the morning chain must not re-implement a weak marker-only predicate');
assert.match(chain, /run_cloud_session_manager_job\.sh[\s\S]*?--deadline-epoch "\$recovery_deadline"/,
  'the morning gate must call the shared coordinator with an explicit epoch deadline');
const sessionGateSource = chain.slice(
  chain.indexOf('run_nightly_session_readiness_gate()'),
  chain.indexOf('# Idempotent terminal-state convergence'),
);
assert.doesNotMatch(sessionGateSource, /--deadline-at/,
  'the morning gate must not pass the stale nightly 01:27 wall-clock deadline');
assert.ok((sessionGateSource.match(/run_cloud_session_manager_job\.sh/g) || []).length >= 2,
  'the gate uses --check-only before and after the single recovery coordinator invocation');
assert.match(sessionGateSource, /run_pipeline_stage\.sh" \\\n+\s*--stage nightly-session[\s\S]*?\/usr\/bin\/flock -w[\s\S]*?cloud_shein_session_manager\.sh/,
  'the coordinator inner command must preserve run_pipeline_stage nightly-session -> flock -> session manager');
assert.ok(
  chain.indexOf('if run_nightly_session_readiness_gate; then') < chain.indexOf('run_all_store_fetch "$RESULT_FILE"'),
  'session readiness/self-heal must finish before the all-store fetch starts',
);
assert.match(wrapper, /--deadline-epoch\).*EPOCH_DEADLINE="\$2"/, 'the wrapper must accept an absolute epoch deadline');
assert.match(wrapper, /SHEIN_HOST_BROWSER_READ_DEADLINE_EPOCH/, 'the wrapper must fall back to the coordinator-exported deadline');
assert.match(wrapper, /EPOCH_BUDGET_SEC=\$\(\(EPOCH_DEADLINE - NOW_EPOCH\)\)/, 'the epoch deadline must translate into a bounded budget');
assert.match(wrapper, /"\$EPOCH_BUDGET_SEC" -lt "\$CLOCK_BUDGET_SEC"/, 'the epoch deadline must clamp an existing clock deadline');
assert.match(wrapper, /reason=deadline_elapsed/, 'an already-elapsed deadline must defer instead of running');
assert.match(wrapper, /if \[\[ -n "\$BUDGET_SEC" \]\]; then[\s\S]*?TIMEOUT_ARGS=\(timeout/,
  'a deadline-less invocation must keep running the command without a timeout wrapper');

// ---------------------------------------------------------------------------
// Source contracts: deadline before any flock
// ---------------------------------------------------------------------------
const deadlineResolution = wrapper.slice(wrapper.indexOf('Effective deadline'), wrapper.indexOf('lock_wait_remaining()'));
assert.match(deadlineResolution, /CLOCK_EPOCH=/, 'the clock deadline must be resolved before any flock');
assert.match(deadlineResolution, /\$EPOCH_DEADLINE" -lt "\$DEADLINE_EPOCH/, 'the earlier of clock/epoch must win');
assert.match(deadlineResolution, /exit 75/, 'an already-elapsed deadline must defer with 75 before taking locks');
assert.match(wrapper, /lock_wait_remaining\(\)/, 'each lock wait must consult the remaining deadline');
assert.match(wrapper, /flock -s -w "\$\(lock_wait_remaining\)"/, 'host/project lock waits must be deadline-clamped');
assert.match(wrapper, /flock -w "\$\(lock_wait_remaining\)"/, 'the domain lock wait must be deadline-clamped');

// ---------------------------------------------------------------------------
// Source contracts: bounded consecutive no-progress store retries
// ---------------------------------------------------------------------------
assert.match(chain, /MAX_STORE_NO_PROGRESS_ROUNDS="\$\{SHEIN_BI_MORNING_STORE_NO_PROGRESS_MAX:-3\}"/,
  'the consecutive no-progress bound must be configurable with a sane default');
assert.match(chain, /PREV_MISSING_STORES="\$MISSING_STORES"/);
assert.match(chain, /if \[\[ "\$PREV_MISSING_STORES" == "\$MISSING_STORES" \]\]; then/, 'no-progress must compare the exact missing-store set');
assert.match(chain, /NO_PROGRESS_ROUNDS=\$\(\(NO_PROGRESS_ROUNDS \+ 1\)\)/);
assert.match(chain, /NO_PROGRESS_ROUNDS=0/, 'any progress must reset the no-progress counter');
assert.match(chain, /while \[\[ -n "\$MISSING_STORES" \]\]; do/, 'missing stores stay in the same coordinator as checkpoints');
assert.match(chain, /no-progress store retry bound reached after/, 'a bounded no-progress failure must carry a clear marker reason');
assert.match(chain, /exit 78/, 'the no-progress limit must exit with a dedicated code');

// ---------------------------------------------------------------------------
// Source contracts: old wrapper arguments stay accepted
// ---------------------------------------------------------------------------
assert.match(wrapper, /--deadline-at\)/, 'the legacy --deadline-at argument must remain supported');
assert.match(wrapper, /--deadline-minute\)/, 'the legacy --deadline-minute argument must remain supported');
assert.match(wrapper, /--deadline-next-hour\)/, 'the legacy --deadline-next-hour argument must remain supported');
assert.match(wrapper, /\[\[ -z "\$DEADLINE_MINUTE" && "\$DEADLINE_NEXT_HOUR" -eq 0 \]\]/, 'legacy argument validation must be preserved');

// ---------------------------------------------------------------------------
// Behavioral harnesses (sandboxed; skipped cleanly when the host lacks tools)
// ---------------------------------------------------------------------------
function bashAvailable() {
  try {
    execFileSync('bash', ['-lc', 'command -v flock && command -v timeout'], {stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

function realNodeAvailable() {
  try {
    execFileSync('bash', ['-lc', 'command -v node'], {stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

function runHarness(script, label) {
  const result = spawnSync('bash', ['-s'], {
    cwd: root,
    input: script,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

const WRAPPER_HARNESS = `
#!/usr/bin/env bash
set -u
export TZ=Asia/Shanghai
REPO="\$PWD"
SB="\$(mktemp -d /tmp/shein-browser-wrapper-test.XXXXXX)"
trap 'rm -rf -- "\$SB"' EXIT
mkdir -p "\$SB/bin" "\$SB/scripts/lib" "\$SB/state/locks"
cp "\$REPO/scripts/lib/shared_lock.sh" "\$SB/scripts/lib/shared_lock.sh"
cat > "\$SB/bin/node" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "\$SB/bin/node"
export PATH="\$SB/bin:\$PATH"
export SHEIN_BI_ROOT="\$SB"
export SHEIN_HOST_HEAVY_LOCK_FILE="\$SB/host.lock"
export SHEIN_BROWSER_READ_SLOT_0="\$SB/slot0.lock"
export SHEIN_BROWSER_READ_SLOT_1="\$SB/slot1.lock"
export SHEIN_BI_HOST_PROJECT_LOCK_FILE="\$SB/project.lock"
export SHEIN_BI_HOST_DOMAIN_LOCK_FILE="\$SB/domain.lock"
for f in host slot0 slot1 project domain; do
  : > "\$SB/\$f.lock"
  chmod 660 "\$SB/\$f.lock"
done
if ! flock -w 3 "\$SB/host.lock" true; then
  echo 'SKIP flock unavailable on this host'
  exit 0
fi
WRAPPER="\$REPO/scripts/run_host_browser_read_job.sh"
FAIL=0
check_rc() {
  local name="\$1" want="\$2" got="\$3"
  if [[ "\$got" -ne "\$want" ]]; then
    echo "FAIL[\$name] rc got=\$got want=\$want"
    FAIL=1
  else
    echo "PASS[\$name] rc=\$got"
  fi
}
budget_of() { grep -o 'budgetSec=[0-9][0-9]*' | tail -1 | cut -d= -f2; }
in_range() {
  local name="\$1" budget="\$2" low="\$3" high="\$4"
  if [[ -n "\$budget" && "\$budget" -ge "\$low" && "\$budget" -le "\$high" ]]; then
    echo "PASS[\$name budget=\$budget]"
  else
    echo "FAIL[\$name budget=\$budget]"
    FAIL=1
  fi
}

NOW="\$(date +%s)"
OUT="\$(bash "\$WRAPPER" --domain epoch-future --lock-wait-sec 1 --deadline-epoch \$(( NOW + 300 )) -- bash -c 'true' 2>&1)"
RC=\$?
check_rc c1_future_epoch 0 "\$RC"
in_range c1_future_epoch "\$(printf '%s\\n' "\$OUT" | budget_of)" 290 300

RAN="\$SB/c2.ran"
OUT="\$(bash "\$WRAPPER" --domain epoch-expired --lock-wait-sec 1 --deadline-epoch \$(( NOW - 60 )) -- bash -c "touch '\$RAN'" 2>&1)"
RC=\$?
check_rc c2_expired_epoch 75 "\$RC"
printf '%s\\n' "\$OUT" | grep -q 'deadline_elapsed' && echo 'PASS[c2 reason]' || { echo 'FAIL[c2 reason]'; FAIL=1; }
if [[ ! -e "\$RAN" ]]; then echo 'PASS[c2 not-ran]'; else echo 'FAIL[c2 not-ran]'; FAIL=1; fi

NEXT3="\$(date -d '+7 min')"
if [[ "\$(date -d "\$NEXT3" +%F)" == "\$(date +%F)" ]]; then
  AT3="\$(date -d "\$NEXT3" +%H:%M)"
  OUT="\$(bash "\$WRAPPER" --domain epoch-clamp --lock-wait-sec 1 --deadline-epoch \$(( NOW + 120 )) --deadline-at "\$AT3" -- bash -c 'true' 2>&1)"
  RC=\$?
  check_rc c3_clamp 0 "\$RC"
  in_range c3_clamp "\$(printf '%s\\n' "\$OUT" | budget_of)" 110 120
else
  echo 'SKIP c3 clamp crosses midnight'
fi

OUT="\$(SHEIN_HOST_BROWSER_READ_DEADLINE_EPOCH=\$(( NOW + 90 )) bash "\$WRAPPER" --domain epoch-env --lock-wait-sec 1 -- bash -c 'true' 2>&1)"
RC=\$?
check_rc c4_env_epoch 0 "\$RC"
in_range c4_env_epoch "\$(printf '%s\\n' "\$OUT" | budget_of)" 80 90

NEXT5="\$(date -d '+30 min')"
if [[ "\$(date -d "\$NEXT5" +%F)" == "\$(date +%F)" ]]; then
  AT5="\$(date -d "\$NEXT5" +%H:%M)"
  OUT="\$(bash "\$WRAPPER" --domain compat-at --lock-wait-sec 1 --deadline-at "\$AT5" -- bash -c 'true' 2>&1)"
  RC=\$?
  check_rc c5_legacy_deadline_at 0 "\$RC"
  in_range c5_legacy_deadline_at "\$(printf '%s\\n' "\$OUT" | budget_of)" 1680 1920
  if printf '%s\\n' "\$OUT" | grep -q 'domain=compat-at epoch='; then
    echo 'FAIL[c5 epoch line leaked into legacy path]'
    FAIL=1
  else
    echo 'PASS[c5 no epoch line]'
  fi
else
  echo 'SKIP c5 legacy --deadline-at crosses midnight'
fi

OUT="\$(bash "\$WRAPPER" --domain no-deadline --lock-wait-sec 1 -- bash -c 'true' 2>&1)"
RC=\$?
check_rc c6_no_deadline 0 "\$RC"
if printf '%s\\n' "\$OUT" | grep -q 'budgetSec='; then
  echo 'FAIL[c6 unexpected budget]'
  FAIL=1
else
  echo 'PASS[c6 no budget]'
fi

# c7: hold the host lock while the deadline is only a few seconds away.  The
# lock wait must be clamped to the remaining seconds (defer at the deadline),
# never a full LOCK_WAIT_SEC wait (which would be ~3x the deadline here).
exec 9<>"\$SB/host.lock"
flock 9
T0="\$(date +%s)"
OUT="\$(bash "\$WRAPPER" --domain held-lock --lock-wait-sec 60 --deadline-epoch \$(( T0 + 3 )) -- bash -c 'true' 2>&1)"
RC=\$?
T1="\$(date +%s)"
ELAPSED=\$((T1 - T0))
exec 9>&-
check_rc c7_held_lock_deadline 75 "\$RC"
printf '%s\\n' "\$OUT" | grep -q 'deadline_elapsed' && echo 'PASS[c7 reason]' || { echo 'FAIL[c7 reason]'; FAIL=1; }
if (( ELAPSED >= 2 && ELAPSED <= 8 )); then
  echo "PASS[c7 clamped wait elapsed=\${ELAPSED}s]"
else
  echo "FAIL[c7 elapsed=\${ELAPSED}s should be clamped to the ~3s deadline, not LOCK_WAIT]"
  FAIL=1
fi

if [[ "\$FAIL" -eq 0 ]]; then echo 'WRAPPER_HARNESS_OK'; exit 0; fi
exit 1
`;

const CHAIN_HARNESS_T1 = `
#!/usr/bin/env bash
set -u
export TZ=Asia/Shanghai
REPO="\$PWD"
SB="\$(mktemp -d /tmp/shein-morning-chain-test.XXXXXX)"
trap 'rm -rf -- "\$SB"' EXIT
mkdir -p "\$SB/scripts" "\$SB/config" "\$SB/state/cloud_morning_chain" "\$SB/state/locks" "\$SB/logs"
cat > "\$SB/config/stores.json" <<'EOF'
{"stores":[{"storeKey":"T1"}]}
EOF
cp "\$REPO/scripts/pipeline_marker.mjs" "\$SB/scripts/pipeline_marker.mjs"
cp "\$REPO/scripts/run_pipeline_stage.sh" "\$SB/scripts/run_pipeline_stage.sh"
cp "\$REPO/scripts/run_cloud_session_manager_job.sh" "\$SB/scripts/run_cloud_session_manager_job.sh"
cat > "\$SB/scripts/build_morning_resume_evidence.mjs" <<'EOF'
#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const dateAt = process.argv.indexOf('--date');
const outAt = process.argv.indexOf('--out');
const date = dateAt > 0 ? process.argv[dateAt + 1] : '';
const out = outAt > 0 ? process.argv[outAt + 1] : '';
if (out) {
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify({ok: true, date, artifactCount: 0}, null, 2) + '\\n');
}
process.exit(0);
EOF
for stub in cloud_daily_refresh cloud_openapi_stock_refresh; do
  cat > "\$SB/scripts/\$stub.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "\$SB/scripts/\$stub.sh"
done
cat > "\$SB/scripts/run_host_heavy_job.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
while ((\$#)); do
  if [[ "\$1" == "--" ]]; then shift; break; fi
  shift
done
exec "\$@"
EOF
cat > "\$SB/scripts/cloud_daily_inventory_replenishment_guard.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
R="\$SHEIN_BI_INVENTORY_RUN_DATE"
B="\$SHEIN_BI_INVENTORY_BUSINESS_DATE"
IR="\$SHEIN_BI_INVENTORY_RUNTIME_ROOT"
mkdir -p "\$IR/plans" "\$IR/results"
PLAN="\$IR/plans/daily-inventory-replenishment-\$R.json"
RESULT="\$IR/results/daily-inventory-replenishment-\$R.json"
printf '{"date":"%s","payloadHash":"%064d","executable":true}\n' "\$R" 0 > "\$PLAN"
printf '{"planHash":"%064d","execute":true,"executionMode":"automatic","results":[]}\n' 0 > "\$RESULT"
node "\$SHEIN_BI_ROOT/scripts/pipeline_marker.mjs" write --stage daily-inventory-guard \
  --date "\$R" --business-date "\$B" --status done --message complete \
  --evidence "\$PLAN" --evidence "\$RESULT" >/dev/null
EOF
chmod +x "\$SB/scripts/run_host_heavy_job.sh" "\$SB/scripts/cloud_daily_inventory_replenishment_guard.sh"
cat > "\$SB/scripts/cloud_link_business_sync.sh" <<'STUB'
#!/usr/bin/env bash
echo "$0" >> "$SYNC_COUNT_FILE"
if [[ -n "\${DEADLINE_EXPORT_LOG:-}" ]]; then
  echo "$SHEIN_HOST_BROWSER_READ_DEADLINE_EPOCH" >> "$DEADLINE_EXPORT_LOG"
fi
case "$STUB_SYNC_MODE" in
  complete)
    mkdir -p "outputs/shein_links/T1" "outputs/shein_business_domains/T1"
    for dom in shein_links shein_business_domains; do
      cat > "outputs/$dom/T1/$1.json" <<'EOF'
{"ok":true,"date":"DATE_PLACEHOLDER","store":{"storeKey":"T1"}}
EOF
      sed -i "s/DATE_PLACEHOLDER/$1/" "outputs/$dom/T1/$1.json"
    done
    if [[ -n "$SHEIN_LINK_BUSINESS_CHUNK_RESULT_FILE" ]]; then
      mkdir -p "$(dirname "$SHEIN_LINK_BUSINESS_CHUNK_RESULT_FILE")"
      cat > "$SHEIN_LINK_BUSINESS_CHUNK_RESULT_FILE" <<'EOF'
{"ok":true,"status":"done","date":"DATE_PLACEHOLDER"}
EOF
      sed -i "s/DATE_PLACEHOLDER/$1/" "$SHEIN_LINK_BUSINESS_CHUNK_RESULT_FILE"
    fi
    ;;
  sleep)
    touch "$STARTED_FILE"
    sleep 865
    ;;
  never)
    ;;
esac
exit 0
STUB
chmod +x "\$SB/scripts/cloud_link_business_sync.sh"
# Fake shared browser-read lane: accepts the coordinator CLI shape, records
# invocations + the received epoch deadline (never a stale clock deadline) and
# runs the inner command (run_pipeline_stage -> flock -> session-manager stub).
cat > "\$SB/scripts/run_host_browser_read_job.sh" <<'STUB'
#!/usr/bin/env bash
set -u
printf 'lane\n' >> "$LANE_COUNT_FILE"
DEADLINE_EPOCH=""
while (($#)); do
  case "$1" in
    --deadline-epoch) DEADLINE_EPOCH="$2"; shift 2 ;;
    --deadline-at) echo 'forbidden stale --deadline-at passed to lane' >&2; exit 64 ;;
    --domain|--lock-wait-sec|--defer-state) shift 2 ;;
    --) shift; break ;;
    *) echo "unexpected lane argument: $1" >&2; exit 64 ;;
  esac
done
printf '%s\n' "$DEADLINE_EPOCH" > "$LANE_DEADLINE_LOG"
"$@"
STUB
chmod +x "\$SB/scripts/run_host_browser_read_job.sh"
# Session-manager stub writes the strong cloud-session-manager-latest.json
# report on success (or fails with the mode below).  The report mirrors what
# cloud_shein_session_manager.mjs actually produces: per-store results with
# ok=true and the WebAPI probe proof carried in
# exportSession.stores[].webApiProbe.ok for the exact enabled store (T1).
cat > "\$SB/scripts/cloud_shein_session_manager.sh" <<'STUB'
#!/usr/bin/env bash
set -u
echo inner >> "$SESSION_INNER_LOG"
if [[ "$STUB_SESSION_MODE" == "fail" ]]; then
  exit 42
fi
mkdir -p "$PWD/outputs/reports"
export TZ=Asia/Shanghai
cat > "$PWD/outputs/reports/cloud-session-manager-latest.json" <<JSON
{"ok":true,"generatedAt":"$(date --iso-8601=seconds)","date":"$(date +%F)","mode":"check","summary":{"totalStores":1,"okStores":1,"failedStores":[],"profilesTotalBytes":0,"profilesTotalHuman":"0 B"},"issues":[],"warnings":[],"results":[{"storeKey":"T1","groupKey":"TEST","shopName":"T1","port":1,"ok":true,"mode":"check","warnings":[],"sessions":{"browser":{"exists":true},"webapi":{"exists":true}},"probe":{"ok":true,"failedStores":[],"reportFile":"","date":"$(date +%F)"},"exportSession":{"stores":[{"storeKey":"T1","webApiProbe":{"ok":true}}]}}]}
JSON
exit 0
STUB
chmod +x "\$SB/scripts/cloud_shein_session_manager.sh"

export SHEIN_BI_ROOT="\$SB"
export SHEIN_BI_MORNING_CHAIN_STATE_DIR="\$SB/state/cloud_morning_chain"
export SHEIN_BI_MORNING_CHAIN_LOG_DIR="\$SB/logs"
export SHEIN_BI_MORNING_CATCHUP_MIN_UPTIME_SEC=0
export SHEIN_BI_MORNING_SESSION_DEFER_STATE="\$SB/runtime/host-scheduler/session-manager.latest.json"
export SHEIN_BI_MORNING_SESSION_ALERT_FILE="\$SB/state/cloud_ops_alerts/session-manager-last.json"
export SHEIN_BI_INVENTORY_RUNTIME_ROOT="\$SB/state/inventory-runtime"

RUN_DATE="\$(TZ=Asia/Shanghai date +%F)"
CHAIN_STATE="\$SB/state/cloud_morning_chain"
PIPE="\$SB/state/pipeline-markers/\$RUN_DATE"
CHAIN="\$REPO/scripts/cloud_morning_chain.sh"

write_session_marker() {
  node "\$SB/scripts/pipeline_marker.mjs" write \
    --stage nightly-session \
    --date "\$RUN_DATE" \
    --status "\$1" \
    --root "\$SB/state/pipeline-markers" >/dev/null
}

# t1: SIGTERM must converge latest.json and the pipeline marker away from
# running even though the strong gate first performs one session recovery.
export STUB_SYNC_MODE=sleep
export SYNC_COUNT_FILE="\$SB/t1-count.txt"
export STARTED_FILE="\$SB/t1-started.txt"
export LANE_COUNT_FILE="\$SB/t1-lane.txt"
export LANE_DEADLINE_LOG="\$SB/t1-lane-deadline.txt"
export SESSION_INNER_LOG="\$SB/t1-inner.txt"
export STUB_SESSION_MODE=success
rm -rf "\$SB/outputs" "\$SB/state/cloud_morning_chain" "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/cloud_morning_chain"
write_session_marker done
bash "\$CHAIN" all > "\$SB/t1.out" 2>&1 &
CHAIN_PID=\$!
FOUND=0
for i in \$(seq 1 150); do
  [[ -e "\$STARTED_FILE" ]] && { FOUND=1; break; }
  sleep 0.1
done
if [[ "\$FOUND" -ne 1 ]]; then
  echo 'FAIL[t1 never reached the store fetch stage]'
  cat "\$SB/t1.out"
  exit 1
fi
# Mirror systemd KillMode=control-group: the coordinator and its store-fetch
# child all receive SIGTERM; a foreground child delays the shell's TERM trap,
# so the sleeping stub must also be terminated or the trap waits for it.
kill -TERM "\$CHAIN_PID"
pkill -TERM -f 'sleep 865' 2>/dev/null || true
WAITED=0
for i in \$(seq 1 100); do
  if [[ -s "\$PIPE/morning-all.json" ]]; then WAITED=1; break; fi
  sleep 0.1
done
if [[ "\$WAITED" -ne 1 ]]; then
  echo 'FAIL[t1 marker never written]'
  kill -9 "\$CHAIN_PID" 2>/dev/null || true
  pkill -9 -f 'sleep 865' 2>/dev/null || true
  wait "\$CHAIN_PID" 2>/dev/null || true
  cat "\$SB/t1.out"
  exit 1
fi
RC=0
wait "\$CHAIN_PID" || RC=\$?
if [[ "\$RC" -ne 143 ]]; then echo "FAIL[t1 exit=\$RC want=143]"; exit 1; fi
grep -q '"status": "failed"' "\$CHAIN_STATE/latest.json" || { echo 'FAIL[t1 latest still running]'; exit 1; }
grep -q 'SIGTERM' "\$CHAIN_STATE/latest.json" || { echo 'FAIL[t1 latest reason missing]'; exit 1; }
grep -q '"status": "failed"' "\$PIPE/morning-all.json" || { echo 'FAIL[t1 marker not failed]'; exit 1; }
echo 'PASS[t1 TERM terminal convergence]'
pkill -f 'sleep 865' 2>/dev/null || true

`;

// The t2..t5 scenarios belong to the same sandbox harness as t1.
const CHAIN_HARNESS_T2 = `
# t2: a warning marker WITHOUT the 19/19 report must trigger one recovery
# (never a skip); after recovery the same run completes with ok.
export STUB_SYNC_MODE=complete
export SYNC_COUNT_FILE="\$SB/t2-count.txt"
export STARTED_FILE="\$SB/t2-started.txt"
export LANE_COUNT_FILE="\$SB/t2-lane.txt"
export LANE_DEADLINE_LOG="\$SB/t2-lane-deadline.txt"
export SESSION_INNER_LOG="\$SB/t2-inner.txt"
export STUB_SESSION_MODE=success
rm -rf "\$SB/outputs" "\$SB/state/cloud_morning_chain" "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/cloud_morning_chain"
write_session_marker warning
bash "\$CHAIN" all > "\$SB/t2.out" 2>&1
RC=\$?
if [[ "\$RC" -ne 0 ]]; then echo "FAIL[t2 exit=\$RC]"; cat "\$SB/t2.out"; exit 1; fi
[[ "\$(wc -l < "\$LANE_COUNT_FILE")" -eq 1 ]] || { echo "FAIL[t2 lane recovery count]"; exit 1; }
[[ "\$(wc -l < "\$SESSION_INNER_LOG")" -eq 1 ]] || { echo "FAIL[t2 inner session count]"; exit 1; }
grep -q '"status": "ok"' "\$CHAIN_STATE/latest.json" || { echo 'FAIL[t2 ok state missing]'; exit 1; }
grep -q '"status": "done"' "\$PIPE/daily-operating-refresh.json" || { echo 'FAIL[t2 resume marker missing]'; exit 1; }
[[ -f "\$CHAIN_STATE/\$RUN_DATE.done" ]] || { echo 'FAIL[t2 done file missing]'; exit 1; }
if [[ -e "\$PIPE/morning-all.json" ]]; then echo 'FAIL[t2 EXIT trap wrote a failed marker over success]'; exit 1; fi
grep -q '"status": "done"' "\$PIPE/morning-supplements.json" || { echo 'FAIL[t2 supplements marker missing]'; exit 1; }
echo 'PASS[t2 warning marker triggers recovery, run completes ok]'

# t3: consecutive no-progress retries must stop after the bound.
export STUB_SYNC_MODE=never
export SYNC_COUNT_FILE="\$SB/t3-count.txt"
export STARTED_FILE="\$SB/t3-started.txt"
export LANE_COUNT_FILE="\$SB/t3-lane.txt"
export LANE_DEADLINE_LOG="\$SB/t3-lane-deadline.txt"
export SESSION_INNER_LOG="\$SB/t3-inner.txt"
export STUB_SESSION_MODE=success
export SHEIN_BI_MORNING_STORE_RETRY_DELAY_SEC=0
rm -rf "\$SB/outputs" "\$SB/state/cloud_morning_chain" "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/cloud_morning_chain"
write_session_marker done
bash "\$CHAIN" all > "\$SB/t3.out" 2>&1
RC=\$?
if [[ "\$RC" -ne 78 ]]; then echo "FAIL[t3 exit=\$RC want=78]"; cat "\$SB/t3.out"; exit 1; fi
COUNT="\$(wc -l < "\$SYNC_COUNT_FILE")"
if [[ "\$COUNT" -ne 4 ]]; then echo "FAIL[t3 sync calls=\$COUNT want=4]"; exit 1; fi
grep -q '"status": "failed"' "\$CHAIN_STATE/latest.json" || { echo 'FAIL[t3 latest not failed]'; exit 1; }
grep -q 'no progress' "\$CHAIN_STATE/latest.json" || { echo 'FAIL[t3 latest reason missing]'; exit 1; }
grep -q 'no-progress' "\$PIPE/morning-all.json" || { echo 'FAIL[t3 marker reason missing]'; exit 1; }
echo 'PASS[t3 zero-progress bound]'

# t4: a missing marker invokes exactly one recovery (lane + inner once) with
# the reserved link-collection budget intact, then continues to link sync.
export STUB_SYNC_MODE=complete
export SYNC_COUNT_FILE="\$SB/t4-count.txt"
export STARTED_FILE="\$SB/t4-started.txt"
export LANE_COUNT_FILE="\$SB/t4-lane.txt"
export LANE_DEADLINE_LOG="\$SB/t4-lane-deadline.txt"
export SESSION_INNER_LOG="\$SB/t4-inner.txt"
export STUB_SESSION_MODE=success
export SHEIN_BI_MORNING_RUN_BUDGET_SEC=1000
export SHEIN_BI_MORNING_SESSION_RECOVERY_BUDGET_SEC=900
export SHEIN_BI_MORNING_LINK_COLLECTION_RESERVE_SEC=600
export SHEIN_BI_MORNING_INVENTORY_RESERVE_SEC=300
rm -rf "\$SB/outputs" "\$SB/state/cloud_morning_chain" "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/cloud_morning_chain"
T4_BEFORE="\$(date +%s)"
bash "\$CHAIN" all > "\$SB/t4.out" 2>&1
RC=\$?
if [[ "\$RC" -ne 0 ]]; then echo "FAIL[t4 exit=\$RC]"; cat "\$SB/t4.out"; exit 1; fi
[[ "\$(wc -l < "\$LANE_COUNT_FILE")" -eq 1 ]] || { echo 'FAIL[t4 lane count]'; exit 1; }
[[ "\$(wc -l < "\$SYNC_COUNT_FILE")" -eq 1 ]] || { echo 'FAIL[t4 link sync count]'; exit 1; }
[[ "\$(wc -l < "\$SESSION_INNER_LOG")" -eq 1 ]] || { echo 'FAIL[t4 inner session count]'; exit 1; }
grep -q '"status": "done"' "\$PIPE/nightly-session.json" || { echo 'FAIL[t4 recovery marker missing]'; exit 1; }
T4_DEADLINE="\$(cat "\$LANE_DEADLINE_LOG")"
T4_DELTA=\$((T4_DEADLINE - T4_BEFORE))
if (( T4_DELTA < 385 || T4_DELTA > 420 )); then
  echo "FAIL[t4 deadline delta=\$T4_DELTA want about 400s]"
  exit 1
fi
if (( 1000 - T4_DELTA < 595 )); then
  echo "FAIL[t4 link reserve remaining=\$((1000 - T4_DELTA))]"
  exit 1
fi
echo 'PASS[t4 missing marker one-shot recovery and reserved link budget]'

# t5: failed recovery is terminal and blocks link collection immediately.
export STUB_SYNC_MODE=complete
export SYNC_COUNT_FILE="\$SB/t5-count.txt"
export STARTED_FILE="\$SB/t5-started.txt"
export LANE_COUNT_FILE="\$SB/t5-lane.txt"
export LANE_DEADLINE_LOG="\$SB/t5-lane-deadline.txt"
export SESSION_INNER_LOG="\$SB/t5-inner.txt"
export STUB_SESSION_MODE=fail
rm -rf "\$SB/outputs" "\$SB/state/cloud_morning_chain" "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/cloud_morning_chain"
bash "\$CHAIN" all > "\$SB/t5.out" 2>&1
RC=\$?
if [[ "\$RC" -ne 42 ]]; then echo "FAIL[t5 exit=\$RC want=42]"; cat "\$SB/t5.out"; exit 1; fi
[[ "\$(wc -l < "\$LANE_COUNT_FILE")" -eq 1 ]] || { echo 'FAIL[t5 lane count]'; exit 1; }
[[ ! -e "\$SYNC_COUNT_FILE" ]] || { echo 'FAIL[t5 link sync started after session failure]'; exit 1; }
grep -q '"status": "failed"' "\$CHAIN_STATE/latest.json" || { echo 'FAIL[t5 latest not failed]'; exit 1; }
grep -q 'nightly session recovery failed status=42' "\$CHAIN_STATE/latest.json" || { echo 'FAIL[t5 clear failure state missing]'; exit 1; }
grep -q 'nightly-session recovery failed status=42' "\$PIPE/morning-all.json" || { echo 'FAIL[t5 clear failure marker missing]'; exit 1; }
echo 'PASS[t5 recovery failure blocks link sync]'

# t6: an injected businessDate that is NOT runDate - 1 (here runDate ==
# businessDate) must fail closed with exit 64 before any lane / session / link
# work starts: the runDate=businessDate pair can never be executed.
export STUB_SYNC_MODE=complete
export SYNC_COUNT_FILE="\$SB/t6-count.txt"
export STARTED_FILE="\$SB/t6-started.txt"
export LANE_COUNT_FILE="\$SB/t6-lane.txt"
export LANE_DEADLINE_LOG="\$SB/t6-lane-deadline.txt"
export SESSION_INNER_LOG="\$SB/t6-inner.txt"
export STUB_SESSION_MODE=success
rm -rf "\$SB/outputs" "\$SB/state/cloud_morning_chain" "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/cloud_morning_chain"
SHEIN_BI_MORNING_RUN_DATE="\$RUN_DATE" SHEIN_BI_MORNING_BUSINESS_DATE="\$RUN_DATE" \
  bash "\$CHAIN" all > "\$SB/t6.out" 2>&1
RC=\$?
if [[ "\$RC" -ne 64 ]]; then echo "FAIL[t6 exit=\$RC want=64]"; cat "\$SB/t6.out"; exit 1; fi
[[ ! -e "\$LANE_COUNT_FILE" && ! -e "\$SYNC_COUNT_FILE" && ! -e "\$SESSION_INNER_LOG" ]] \
  || { echo 'FAIL[t6 lane/session/sync started on a mismatched date pair]'; exit 1; }
grep -q 'does not equal runDate' "\$SB/t6.out" || { echo 'FAIL[t6 fail-closed reason missing]'; cat "\$SB/t6.out"; exit 1; }
echo 'PASS[t6 businessDate != runDate-1 exits 64 fail closed]'

# t7: the injected first-start ABSOLUTE deadline is observable in the child
# (exported to every store wrapper as SHEIN_HOST_BROWSER_READ_DEADLINE_EPOCH)
# and stays identical across two separate starts: the chain must never
# recompute the run deadline from its own start time (no restart reset).
export STUB_SYNC_MODE=complete
export SYNC_COUNT_FILE="\$SB/t7-count.txt"
export STARTED_FILE="\$SB/t7-started.txt"
export LANE_COUNT_FILE="\$SB/t7-lane.txt"
export LANE_DEADLINE_LOG="\$SB/t7-lane-deadline.txt"
export SESSION_INNER_LOG="\$SB/t7-inner.txt"
export DEADLINE_EXPORT_LOG="\$SB/t7-deadline-export.txt"
export STUB_SESSION_MODE=success
export SHEIN_BI_MORNING_STORE_RETRY_DELAY_SEC=0
export SHEIN_BI_MORNING_SESSION_RECOVERY_BUDGET_SEC=900
export SHEIN_BI_MORNING_LINK_COLLECTION_RESERVE_SEC=600
export SHEIN_BI_MORNING_INVENTORY_RESERVE_SEC=300
INJECTED_DEADLINE=\$(( $(date +%s) + 2500 ))
rm -rf "\$SB/outputs" "\$SB/state/cloud_morning_chain" "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/cloud_morning_chain"
write_session_marker done
SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH="\$INJECTED_DEADLINE" bash "\$CHAIN" all > "\$SB/t7.out" 2>&1
RC=\$?
if [[ "\$RC" -ne 0 ]]; then echo "FAIL[t7 exit=\$RC]"; cat "\$SB/t7.out"; exit 1; fi
SEEN="\$(cat "\$DEADLINE_EXPORT_LOG")"
EXPECTED_PRE_INVENTORY_DEADLINE=\$(( INJECTED_DEADLINE - 300 ))
if [[ "\$SEEN" != "\$EXPECTED_PRE_INVENTORY_DEADLINE" ]]; then
  echo "FAIL[t7 exported deadline=\$SEEN want=\$EXPECTED_PRE_INVENTORY_DEADLINE]"
  exit 1
fi
sleep 1
rm -rf "\$SB/outputs" "\$SB/state/cloud_morning_chain" "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/cloud_morning_chain"
write_session_marker done
rm -f "\$DEADLINE_EXPORT_LOG"
SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH="\$INJECTED_DEADLINE" bash "\$CHAIN" all > "\$SB/t7b.out" 2>&1
RC=\$?
if [[ "\$RC" -ne 0 ]]; then echo "FAIL[t7b exit=\$RC]"; cat "\$SB/t7b.out"; exit 1; fi
SEEN2="\$(cat "\$DEADLINE_EXPORT_LOG")"
if [[ "\$SEEN2" != "\$EXPECTED_PRE_INVENTORY_DEADLINE" ]]; then
  echo "FAIL[t7b deadline was reset: seen=\$SEEN2 want=\$EXPECTED_PRE_INVENTORY_DEADLINE]"
  exit 1
fi
echo 'PASS[t7 first-start absolute deadline injected and not reset across starts]'

echo 'CHAIN_HARNESS_OK'
`;

const CHAIN_HARNESS = CHAIN_HARNESS_T1 + CHAIN_HARNESS_T2;

function runBehavioral(label, harness) {
  if (!bashAvailable()) {
    console.log(`SKIP ${label}: bash/flock/timeout unavailable`);
    return 'SKIP';
  }
  const output = runHarness(harness, label);
  if (output.includes('SKIP')) {
    console.log(`SKIP ${label}: ${output.trim().split('\n').filter(line => line.startsWith('SKIP')).join('; ')}`);
  }
  return output;
}

const wrapperOutput = runBehavioral('run_host_browser_read_job.sh', WRAPPER_HARNESS);
if (typeof wrapperOutput === 'string' && wrapperOutput.includes('WRAPPER_HARNESS_OK')) {
  console.log('wrapper behavioral: budget clamp, epoch defer, env fallback, legacy args and held-lock deadline clamp verified');
}

if (realNodeAvailable()) {
  const chainOutput = runBehavioral('cloud_morning_chain.sh', CHAIN_HARNESS);
  if (typeof chainOutput === 'string' && chainOutput.includes('CHAIN_HARNESS_OK')) {
    console.log('chain behavioral: TERM convergence, strong-evidence recovery/skip, deadline budget, session gate/failure and no-progress bound verified');
  }
} else {
  console.log('SKIP chain behavioral: real node unavailable inside bash');
}

console.log(JSON.stringify({ok: true}));
