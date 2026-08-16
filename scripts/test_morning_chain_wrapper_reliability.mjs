#!/usr/bin/env node

// Deterministic reliability contracts for the morning-chain wrapper
// (scripts/run_cloud_morning_chain_job.sh).  The wrapper is executed inside a
// stubbed sandbox whose child cloud_morning_chain.sh is a controlled fake, so
// every resume/interruption/deadline scenario is reproducible without any real
// systemd state, browser or business write.
//
// Covered contracts (one deterministic counter-example each):
//  - single-authority completion: only the exact daily-operating-refresh
//    marker counts.  A crash between "marker done" and any other file (the
//    historical .done split) can never wedge a completed child: the resumed
//    child self-heals and the wrapper clears the context (no livelock), while
//    exit 0 without the marker still stays a failure;
//  - first-start absolute deadline: persisted in active.json, injected into
//    the child and IDENTICAL across a fail -> Restart -> resume sequence;
//    once expired the run converges to terminal evidence (failed latest.json +
//    failed morning-all marker + cloud_ops_alert) and exits 0, so systemd can
//    never restart forever past the deadline, and the incomplete run is never
//    reported as success;
//  - businessDate == runDate - 1 enforced for every accepted context:
//    runDate == businessDate or any other mismatched pair fails closed and is
//    replaced by a correctly derived fresh pair;
//  - idempotent-skip completion and malformed/future context handling.

import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

execFileSync('bash', ['-n', 'scripts/run_cloud_morning_chain_job.sh'], {cwd: root, stdio: 'inherit'});
execFileSync('bash', ['-n', 'scripts/cloud_morning_chain.sh'], {cwd: root, stdio: 'inherit'});

const source = fs.readFileSync(path.join(root, 'scripts', 'run_cloud_morning_chain_job.sh'), 'utf8');
assert.match(source, /ACTIVE_FILE="\$STATE_DIR\/active\.json"/, 'active context lives under state/cloud_morning_chain');
assert.match(source, /mode: 0o660/, 'persisted context must be mode 0660');
assert.match(source, /fs\.renameSync\(temporary, file\)/, 'context persistence must be atomic tmp+rename');
assert.match(source, /deadlineEpoch: Number\(process\.env\.DEADLINE_EPOCH/, 'first-start deadline must be persisted in the context');
assert.match(source, /SHEIN_BI_MORNING_RUN_DATE="\$run_date"/, 'run date must be injected immutably');
assert.match(source, /SHEIN_BI_MORNING_BUSINESS_DATE="\$business_date"/, 'business date must be injected immutably');
assert.match(source, /SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH="\$deadline"/, 'the persisted absolute deadline must be injected into the child');
assert.doesNotMatch(source, /\.done/, 'the wrapper must not depend on a second completion artifact (single-authority marker evidence)');
assert.match(source, /daily-operating-refresh\.json/, 'completion verifies the exact daily-operating-refresh marker');
assert.match(source, /marker\?\.businessDate === process\.env\.BUSINESS_DATE/, 'completion verifies the exact businessDate on the marker');
assert.match(source, /clear_active_context/, 'context is cleared only after verified completion or self-heal');
assert.match(source, /RECOVERED_RUN_DATE/, 'an active older runDate is recovered first');
assert.match(source, /prev_day "\$RECOVERED_RUN_DATE"\)/, 'a recovered pair must satisfy businessDate == runDate - 1');
assert.match(source, /- 1 day/, 'the previous-day relationship must be calendar-derived');
assert.match(source, /write_terminal_deadline_failure/, 'an expired first-start deadline must converge to terminal evidence');
assert.match(source, /morning-chain-last\.json/, 'terminal convergence must write the cloud_ops_alert the watchdog surfaces');
assert.match(source, /exit 0/, 'success / convergent terminal paths exit 0 so Restart=on-failure cannot spin forever');

// ---------------------------------------------------------------------------
// Behavioral harness
// ---------------------------------------------------------------------------

const HARNESS = `
#!/usr/bin/env bash
set -u
export TZ=Asia/Shanghai
REPO="\$PWD"
SB="\$(mktemp -d /tmp/shein-morning-wrapper-test.XXXXXX)"
trap 'rm -rf -- "\$SB"' EXIT
mkdir -p "\$SB/scripts" "\$SB/state/cloud_morning_chain" "\$SB/state/pipeline-markers"

TODAY="\$(TZ=Asia/Shanghai date +%F)"
YESTERDAY="\$(TZ=Asia/Shanghai date -d yesterday +%F)"
PREV_YESTERDAY="\$(TZ=Asia/Shanghai date -d "yesterday - 1 day" +%F)"
NOW="\$(date +%s)"
FIXED_DEADLINE=\$(( NOW + 60000 ))

cat > "\$SB/scripts/cloud_morning_chain.sh" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
echo "\$SHEIN_BI_MORNING_RUN_DATE \$SHEIN_BI_MORNING_BUSINESS_DATE \$SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH" >> "\$CALLS_LOG"
R="\$SHEIN_BI_MORNING_RUN_DATE"
B="\$SHEIN_BI_MORNING_BUSINESS_DATE"
if [[ "\$STUB_MODE" == "fail_all" ]]; then
  exit 23
fi
if [[ "\$STUB_MODE" == "fail_once" && ! -f "\$SB/failed.ran" ]]; then
  touch "\$SB/failed.ran"
  exit 17
fi
if [[ "\$STUB_MODE" == "evidence_missing" ]]; then
  exit 0
fi
if [[ "\$STUB_MODE" == "resume_skip" ]]; then
  # Mirrors the real chain's marker-done resume-skip path: exits 0 without a
  # single child-side write; the wrapper must accept the pre-existing marker.
  exit 0
fi
mkdir -p "\$SB/state/pipeline-markers/\$R"
cat > "\$SB/state/pipeline-markers/\$R/daily-operating-refresh.json" <<JSON
{"ok":true,"status":"done","stage":"daily-operating-refresh","runDate":"\$R","businessDate":"\$B","completedAt":"now"}
JSON
mkdir -p "\$SB/state/cloud_morning_chain"
printf "completed_at=now\\nbusiness_date=%s\\nlog=stub\\n" "\$B" > "\$SB/state/cloud_morning_chain/\$R.done"
exit 0
STUB
chmod +x "\$SB/scripts/cloud_morning_chain.sh"
cp "\$REPO/scripts/pipeline_marker.mjs" "\$SB/scripts/pipeline_marker.mjs"

WRAPPER="\$REPO/scripts/run_cloud_morning_chain_job.sh"
export SHEIN_BI_ROOT="\$SB"
export SHEIN_BI_MORNING_CHAIN_STATE_DIR="\$SB/state/cloud_morning_chain"
export SHEIN_BI_PIPELINE_MARKER_ROOT="\$SB/state/pipeline-markers"
export SHEIN_BI_MORNING_CHAIN_SCRIPT="\$SB/scripts/cloud_morning_chain.sh"
export SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH="\$FIXED_DEADLINE"
export CALLS_LOG="\$SB/calls.log"
export SB
STATE="\$SB/state/cloud_morning_chain"
MARKER_ROOT="\$SB/state/pipeline-markers"
FAIL=0
check() {
  local name="\$1" want="\$2" got="\$3"
  if [[ "\$got" != "\$want" ]]; then
    echo "FAIL[\$name] got=\$got want=\$want"
    FAIL=1
  else
    echo "PASS[\$name]"
  fi
}
ctx_of() { node --input-type=module -e 'import fs from "node:fs";const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(p.runDate||"")+" "+String(p.businessDate||""))' "\$STATE/active.json" 2>/dev/null; }
ctx_deadline() { node --input-type=module -e 'import fs from "node:fs";const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(p.deadlineEpoch||""))' "\$STATE/active.json" 2>/dev/null; }
latest_status() { node --input-type=module -e 'import fs from "node:fs";try{const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(p.status||""))}catch{process.stdout.write("missing")}' "\$STATE/latest.json"; }
latest_message() { node --input-type=module -e 'import fs from "node:fs";try{const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(p.message||""))}catch{process.stdout.write("")}' "\$STATE/latest.json"; }
morning_all_marker_status() { node --input-type=module -e 'import fs from "node:fs";try{const p=JSON.parse(fs.readFileSync(process.argv[1]+"/"+process.argv[2]+"/morning-all.json","utf8"));process.stdout.write(String(p.status||""))}catch{process.stdout.write("missing")}' "\$MARKER_ROOT" "\$1"; }
json_field() { node --input-type=module -e 'import fs from "node:fs";try{const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(p[process.argv[2]]??""))}catch{process.stdout.write("missing")}' "\$1" "\$2"; }
alert_field() { json_field "\$SB/state/cloud_ops_alerts/morning-chain-last.json" "\$1"; }
morning_all_marker_field() { json_field "\$MARKER_ROOT/\$1/morning-all.json" "\$2"; }

# t1: fresh run -> exactly one today call with a correct pair (business==run-1),
# the injected deadline, context cleared, rc 0.
rm -f "\$CALLS_LOG" "\$STATE/latest.json"
rm -rf "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers"
export STUB_MODE=success
bash "\$WRAPPER" >/dev/null 2>&1
check t1_rc 0 "\$?"
check t1_calls "1" "\$(wc -l < "\$CALLS_LOG")"
check t1_pair "\$TODAY \$YESTERDAY" "\$(cut -d' ' -f1-2 "\$CALLS_LOG")"
check t1_deadline "\$FIXED_DEADLINE" "\$(cut -d' ' -f3 "\$CALLS_LOG")"
[[ ! -e "\$STATE/active.json" ]] && echo 'PASS[t1 ctx cleared]' || { echo 'FAIL[t1 ctx cleared]'; FAIL=1; }

# t2: recovered TODAY with a FUTURE persisted deadline and already-done marker:
# the child self-heals (resume-skip, exit 0 with no child write), the wrapper
# accepts the SINGLE marker evidence, clears the context and exits 0.  No
# second artifact (.done) may participate: this is the anti-livelock case.
rm -f "\$CALLS_LOG"
rm -rf "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers/\$TODAY"
cat > "\$MARKER_ROOT/\$TODAY/daily-operating-refresh.json" <<JSON
{"ok":true,"status":"done","stage":"daily-operating-refresh","runDate":"\$TODAY","businessDate":"\$YESTERDAY","completedAt":"now"}
JSON
CTX_DEADLINE=\$(( FIXED_DEADLINE + 1234 ))
cat > "\$STATE/active.json" <<JSON
{"runDate":"\$TODAY","businessDate":"\$YESTERDAY","deadlineEpoch":\$CTX_DEADLINE,"startedAt":"x","pid":1,"attempt":1}
JSON
export STUB_MODE=resume_skip
bash "\$WRAPPER" >/dev/null 2>&1
check t2_rc 0 "\$?"
check t2_calls "1" "\$(wc -l < "\$CALLS_LOG")"
check t2_pair "\$TODAY \$YESTERDAY" "\$(cut -d' ' -f1-2 "\$CALLS_LOG")"
check t2_deadline_immutable "\$CTX_DEADLINE" "\$(cut -d' ' -f3 "\$CALLS_LOG")"
[[ ! -e "\$STATE/active.json" ]] && echo 'PASS[t2 ctx cleared (self-heal, no livelock)]' || { echo 'FAIL[t2 ctx cleared]'; FAIL=1; }

# t3: interrupted OLD runDate + restart.  The first attempt fails; the second
# reuses the SAME persisted deadline (never reset), then today's fresh window
# gets its OWN new deadline.  businessDate == runDate-1 on every line.
rm -f "\$CALLS_LOG" "\$SB/failed.ran"
rm -rf "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers"
D="\$YESTERDAY"
B="\$PREV_YESTERDAY"
OLD_DEADLINE=\$(( FIXED_DEADLINE + 2222 ))
cat > "\$STATE/active.json" <<JSON
{"runDate":"\$D","businessDate":"\$B","deadlineEpoch":\$OLD_DEADLINE,"startedAt":"x","pid":1,"attempt":1}
JSON
export STUB_MODE=fail_once
bash "\$WRAPPER" >/dev/null 2>&1
check t3_first_rc 17 "\$?"
check t3_ctx_kept "\$D \$B" "\$(ctx_of)"
check t3_ctx_deadline_kept "\$OLD_DEADLINE" "\$(ctx_deadline)"
check t3_cover_first "1" "\$(wc -l < "\$CALLS_LOG")"
check t3_first_pair "\$D \$B" "\$(cut -d' ' -f1-2 "\$CALLS_LOG")"
check t3_first_deadline "\$OLD_DEADLINE" "\$(cut -d' ' -f3 "\$CALLS_LOG")"
export STUB_MODE=success
bash "\$WRAPPER" >/dev/null 2>&1
check t3_second_rc 0 "\$?"
check t3_calls "3" "\$(wc -l < "\$CALLS_LOG")"
check t3_line1_deadline "\$OLD_DEADLINE" "\$(sed -n 1p "\$CALLS_LOG" | cut -d' ' -f3)"
check t3_line2_pair "\$D \$B" "\$(sed -n 2p "\$CALLS_LOG" | cut -d' ' -f1-2)"
check t3_line2_deadline "\$OLD_DEADLINE" "\$(sed -n 2p "\$CALLS_LOG" | cut -d' ' -f3)"
check t3_line3_pair "\$TODAY \$YESTERDAY" "\$(sed -n 3p "\$CALLS_LOG" | cut -d' ' -f1-2)"
check t3_line3_fresh_deadline "\$FIXED_DEADLINE" "\$(sed -n 3p "\$CALLS_LOG" | cut -d' ' -f3)"
[[ ! -e "\$STATE/active.json" ]] && echo 'PASS[t3 ctx cleared]' || { echo 'FAIL[t3 ctx cleared]'; FAIL=1; }
while IFS= read -r line; do
  RUN="\$(printf '%s\\n' "\$line" | cut -d' ' -f1)"
  BIZ="\$(printf '%s\\n' "\$line" | cut -d' ' -f2)"
  WANT="\$(TZ=Asia/Shanghai date -d "\$RUN - 1 day" +%F)"
  if [[ "\$BIZ" != "\$WANT" || "\$RUN" == "\$BIZ" ]]; then
    echo "FAIL[t3 date relation] line=\$line want biz=\$WANT"
    FAIL=1
  fi
done < "\$CALLS_LOG"
echo 'PASS[t3 all child date pairs satisfy businessDate == runDate - 1]'

# t4: child exits 0 WITHOUT the completion marker -> real failure (exit 78),
# context kept with the same deadline: a fake completion can never pass.
rm -f "\$CALLS_LOG"
rm -rf "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers"
export STUB_MODE=evidence_missing
bash "\$WRAPPER" >/dev/null 2>&1
check t4_rc 78 "\$?"
check t4_ctx_kept "\$TODAY \$YESTERDAY" "\$(ctx_of)"
check t4_ctx_deadline "\$FIXED_DEADLINE" "\$(ctx_deadline)"
check t4_calls "1" "\$(wc -l < "\$CALLS_LOG")"

# t5: persistent child failure with a FUTURE deadline -> failure returned,
# context kept; the same window continues to use the same deadline (restart
# loop is deadline-bounded, never budget-resetting).
rm -f "\$CALLS_LOG"
export STUB_MODE=fail_all
bash "\$WRAPPER" >/dev/null 2>&1
check t5_rc 23 "\$?"
check t5_ctx_kept "\$TODAY \$YESTERDAY" "\$(ctx_of)"
check t5_ctx_deadline "\$FIXED_DEADLINE" "\$(ctx_deadline)"

# t6: EXPIRED first-start deadline -> converge to terminal evidence, exit 0,
# NO child invocation, latest.json failed, alert file + failed morning-all
# marker written.  The incomplete run is never reported as success.
rm -f "\$CALLS_LOG" "\$STATE/latest.json"
rm -rf "\$SB/state/cloud_ops_alerts"
rm -rf "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers"
EXPIRED=\$(( NOW - 10 ))
cat > "\$STATE/active.json" <<JSON
{"runDate":"\$TODAY","businessDate":"\$YESTERDAY","deadlineEpoch":\$EXPIRED,"startedAt":"x","pid":1,"attempt":1}
JSON
export STUB_MODE=success
bash "\$WRAPPER" >/dev/null 2>&1
check t6_rc 0 "\$?"
check t6_no_child "0" "\$(wc -l < "\$CALLS_LOG" 2>/dev/null || echo 0)"
check t6_latest_failed "failed" "\$(latest_status)"
printf '%s' "\$(latest_message)" | grep -q 'deadline' && echo 'PASS[t6 latest reason mentions deadline]' || { echo 'FAIL[t6 latest reason]'; FAIL=1; }
[[ -f "\$SB/state/cloud_ops_alerts/morning-chain-last.json" ]] && echo 'PASS[t6 alert file written]' || { echo 'FAIL[t6 alert file]'; FAIL=1; }
check t6_marker_failed "failed" "\$(morning_all_marker_status "\$TODAY")"

# t7: idempotent convergence - a second invocation with the same expired
# context converges again without child calls and without overwriting the
# previous failed terminal record.
rm -f "\$CALLS_LOG"
bash "\$WRAPPER" >/dev/null 2>&1
check t7_rc 0 "\$?"
check t7_no_child "0" "\$(wc -l < "\$CALLS_LOG" 2>/dev/null || echo 0)"
check t7_latest_still_failed "failed" "\$(latest_status)"

# t8: malformed active context is ignored; a fresh correct today run replaces
# it (single call, correct pair).
rm -f "\$CALLS_LOG"
rm -f "\$STATE/latest.json"
rm -rf "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers"
printf '{broken json' > "\$STATE/active.json"
export STUB_MODE=success
bash "\$WRAPPER" >/dev/null 2>&1
check t8_rc 0 "\$?"
check t8_calls "1" "\$(wc -l < "\$CALLS_LOG")"
check t8_pair "\$TODAY \$YESTERDAY" "\$(cut -d' ' -f1-2 "\$CALLS_LOG")"

# t9: runDate == businessDate context must fail closed (ignored) and never be
# executed; the fresh today pair is the only thing ever run.
rm -f "\$CALLS_LOG"
rm -f "\$STATE/latest.json"
rm -rf "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers"
cat > "\$STATE/active.json" <<JSON
{"runDate":"\$TODAY","businessDate":"\$TODAY","deadlineEpoch":\$FIXED_DEADLINE,"startedAt":"x","pid":1,"attempt":1}
JSON
export STUB_MODE=success
bash "\$WRAPPER" >/dev/null 2>&1
check t9_rc 0 "\$?"
check t9_calls "1" "\$(wc -l < "\$CALLS_LOG")"
check t9_pair "\$TODAY \$YESTERDAY" "\$(cut -d' ' -f1-2 "\$CALLS_LOG")"

# t10: non-adjacent mismatched pair (businessDate == runDate - 2) must also
# fail closed and be replaced by the correct fresh pair.
rm -f "\$CALLS_LOG"
rm -f "\$STATE/latest.json"
rm -rf "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers"
WRONG_BIZ="\$(TZ=Asia/Shanghai date -d "yesterday - 1 day" +%F)"
cat > "\$STATE/active.json" <<JSON
{"runDate":"\$TODAY","businessDate":"\$WRONG_BIZ","deadlineEpoch":\$FIXED_DEADLINE,"startedAt":"x","pid":1,"attempt":1}
JSON
export STUB_MODE=success
bash "\$WRAPPER" >/dev/null 2>&1
check t10_rc 0 "\$?"
check t10_calls "1" "\$(wc -l < "\$CALLS_LOG")"
check t10_pair "\$TODAY \$YESTERDAY" "\$(cut -d' ' -f1-2 "\$CALLS_LOG")"

# t11: fresh start with an already-expired deadline (first attempt starts past
# the window) converges immediately, records terminal failure and exits 0
# without ever invoking the child.
rm -f "\$CALLS_LOG" "\$STATE/latest.json" "\$STATE/active.json"
rm -rf "\$SB/state/cloud_ops_alerts"
rm -rf "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers"
export STUB_MODE=success
SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH=\$(( NOW - 5 )) bash "\$WRAPPER" >/dev/null 2>&1
check t11_rc 0 "\$?"
check t11_no_child "0" "\$(wc -l < "\$CALLS_LOG" 2>/dev/null || echo 0)"
check t11_latest_failed "failed" "\$(latest_status)"
[[ -f "\$SB/state/cloud_ops_alerts/morning-chain-last.json" ]] && echo 'PASS[t11 alert file written]' || { echo 'FAIL[t11 alert file]'; FAIL=1; }

# t12: REAL counterexample: the child already wrote latest=failed before the
# persisted deadline expired.  Restart at the deadline must preserve that
# original latest failure reason, start NO child, exit 0, and independently
# ensure an explicit deadline alert + date-scoped failed morning-all marker.
rm -f "\$CALLS_LOG"
rm -rf "\$SB/state/cloud_ops_alerts" "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers"
cat > "\$STATE/latest.json" <<JSON
{"date":"\$TODAY","businessDate":"\$YESTERDAY","status":"failed","message":"original child failure reason must remain"}
JSON
cat > "\$STATE/active.json" <<JSON
{"runDate":"\$TODAY","businessDate":"\$YESTERDAY","deadlineEpoch":\$EXPIRED,"startedAt":"x","pid":1,"attempt":9}
JSON
export STUB_MODE=success
bash "\$WRAPPER" >/dev/null 2>&1
check t12_rc 0 "\$?"
check t12_no_child "0" "\$(wc -l < "\$CALLS_LOG" 2>/dev/null || echo 0)"
check t12_latest_failed "failed" "\$(latest_status)"
check t12_latest_reason_preserved "original child failure reason must remain" "\$(latest_message)"
check t12_alert_status "failed" "\$(alert_field status)"
check t12_alert_date "\$TODAY" "\$(alert_field date)"
check t12_alert_business_date "\$YESTERDAY" "\$(alert_field businessDate)"
printf '%s' "\$(alert_field message)" | grep -q "deadline.*runDate=\$TODAY businessDate=\$YESTERDAY" \
  && echo 'PASS[t12 alert has deadline/date pair]' || { echo 'FAIL[t12 alert deadline/date pair]'; FAIL=1; }
check t12_marker_status "failed" "\$(morning_all_marker_field "\$TODAY" status)"
check t12_marker_run_date "\$TODAY" "\$(morning_all_marker_field "\$TODAY" runDate)"
check t12_marker_business_date "\$YESTERDAY" "\$(morning_all_marker_field "\$TODAY" businessDate)"
printf '%s' "\$(morning_all_marker_field "\$TODAY" message)" | grep -q "deadline.*runDate=\$TODAY businessDate=\$YESTERDAY" \
  && echo 'PASS[t12 marker has deadline/date pair]' || { echo 'FAIL[t12 marker deadline/date pair]'; FAIL=1; }

# t13: stale cross-day terminal latest must NOT be preserved.  Active is the
# current run (TODAY/YESTERDAY) and expired, but latest still describes
# yesterday's logical run.  The wrapper must start no child, exit 0 and
# atomically replace latest with TODAY's explicit deadline failure while alert
# and marker carry the same current date pair.
rm -f "\$CALLS_LOG"
rm -rf "\$SB/state/cloud_ops_alerts" "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers"
cat > "\$STATE/latest.json" <<JSON
{"date":"\$YESTERDAY","businessDate":"\$PREV_YESTERDAY","status":"failed","message":"stale yesterday failure must be replaced"}
JSON
cat > "\$STATE/active.json" <<JSON
{"runDate":"\$TODAY","businessDate":"\$YESTERDAY","deadlineEpoch":\$EXPIRED,"startedAt":"x","pid":1,"attempt":10}
JSON
export STUB_MODE=success
bash "\$WRAPPER" >/dev/null 2>&1
check t13_rc 0 "\$?"
check t13_no_child "0" "\$(wc -l < "\$CALLS_LOG" 2>/dev/null || echo 0)"
check t13_latest_status "failed" "\$(latest_status)"
check t13_latest_date "\$TODAY" "\$(json_field "\$STATE/latest.json" date)"
check t13_latest_business_date "\$YESTERDAY" "\$(json_field "\$STATE/latest.json" businessDate)"
printf '%s' "\$(latest_message)" | grep -q "deadline.*runDate=\$TODAY businessDate=\$YESTERDAY" \
  && echo 'PASS[t13 latest rewritten to current deadline failure]' || { echo 'FAIL[t13 latest deadline/date pair]'; FAIL=1; }
check t13_alert_status "failed" "\$(alert_field status)"
check t13_alert_date "\$TODAY" "\$(alert_field date)"
check t13_alert_business_date "\$YESTERDAY" "\$(alert_field businessDate)"
check t13_marker_status "failed" "\$(morning_all_marker_field "\$TODAY" status)"
check t13_marker_run_date "\$TODAY" "\$(morning_all_marker_field "\$TODAY" runDate)"
check t13_marker_business_date "\$YESTERDAY" "\$(morning_all_marker_field "\$TODAY" businessDate)"

# t14: yesterday's expired failed run converges its alert/marker, then TODAY
# starts as a fresh logical run.  The old failure can never permanently block
# the next day's run, and the old child itself is not started again.
rm -f "\$CALLS_LOG"
rm -rf "\$SB/state/cloud_ops_alerts" "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers"
cat > "\$STATE/latest.json" <<JSON
{"date":"\$YESTERDAY","businessDate":"\$PREV_YESTERDAY","status":"failed","message":"yesterday child failed"}
JSON
cat > "\$STATE/active.json" <<JSON
{"runDate":"\$YESTERDAY","businessDate":"\$PREV_YESTERDAY","deadlineEpoch":\$EXPIRED,"startedAt":"x","pid":1,"attempt":9}
JSON
export STUB_MODE=success
bash "\$WRAPPER" >/dev/null 2>&1
check t14_rc 0 "\$?"
check t14_one_child "1" "\$(wc -l < "\$CALLS_LOG")"
check t14_today_pair "\$TODAY \$YESTERDAY" "\$(cut -d' ' -f1-2 "\$CALLS_LOG")"
check t14_alert_status "failed" "\$(alert_field status)"
check t14_alert_date "\$YESTERDAY" "\$(alert_field date)"
check t14_alert_business_date "\$PREV_YESTERDAY" "\$(alert_field businessDate)"
check t14_marker_status "failed" "\$(morning_all_marker_field "\$YESTERDAY" status)"
check t14_marker_run_date "\$YESTERDAY" "\$(morning_all_marker_field "\$YESTERDAY" runDate)"
check t14_marker_business_date "\$PREV_YESTERDAY" "\$(morning_all_marker_field "\$YESTERDAY" businessDate)"
[[ ! -e "\$STATE/active.json" ]] && echo 'PASS[t14 today context cleared]' || { echo 'FAIL[t14 today context not cleared]'; FAIL=1; }

# t15: the wrapper itself must never emit runDate == businessDate: every
# recorded child call across the whole harness satisfies the -1 relation.
while IFS= read -r line; do
  if [[ -z "\$line" ]]; then continue; fi
  RUN="\$(printf '%s\\n' "\$line" | cut -d' ' -f1)"
  BIZ="\$(printf '%s\\n' "\$line" | cut -d' ' -f2)"
  WANT="\$(TZ=Asia/Shanghai date -d "\$RUN - 1 day" +%F)"
  if [[ "\$BIZ" != "\$WANT" || "\$RUN" == "\$BIZ" ]]; then
    echo "FAIL[t15 date relation] line=\$line"
    FAIL=1
  fi
done < "\$CALLS_LOG"
echo 'PASS[t15 wrapper never generates runDate == businessDate or a wrong offset]'

if [[ "\$FAIL" -eq 0 ]]; then echo 'WRAPPER_HARNESS_OK'; exit 0; fi
exit 1
`;

const result = spawnSync('bash', ['-s'], {
  cwd: root,
  input: HARNESS,
  encoding: 'utf8',
  timeout: 90_000,
  maxBuffer: 16 * 1024 * 1024,
});
assert.equal(result.status, 0, `wrapper harness failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
assert.ok(result.stdout.includes('WRAPPER_HARNESS_OK'), `wrapper harness did not complete\n${result.stdout}`);

console.log(JSON.stringify({
  ok: true,
  checks: [
    'single_authority_marker_evidence_self_heal_no_livelock',
    'first_start_absolute_deadline_persisted_and_immutable_across_restart',
    'expired_deadline_converges_to_terminal_evidence_exit_0',
    'preexisting_failed_latest_still_gets_deadline_alert_and_marker',
    'stale_cross_day_failed_latest_rewritten_for_current_deadline_run',
    'expired_yesterday_failure_does_not_block_fresh_today_run',
    'businessDate_runDate_minus_1_fail_closed',
    'no_runDate_equals_businessDate',
    'fake_completion_rejected',
    'malformed_context_ignored',
  ],
}, null, 2));
