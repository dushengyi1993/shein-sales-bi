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
//    failed morning-all marker + cloud_ops_alert) and exits 76, so systemd can
//    record failure while RestartPreventExitStatus stops the loop;
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
assert.match(source, /midnight_deadline=.*\+ 1 day 00:00:00/, 'a fresh run deadline must never cross the runDate midnight');
assert.match(source, /SHEIN_BI_MORNING_RUN_DATE="\$run_date"/, 'run date must be injected immutably');
assert.match(source, /SHEIN_BI_MORNING_BUSINESS_DATE="\$business_date"/, 'business date must be injected immutably');
assert.match(source, /SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH="\$deadline"/, 'the persisted absolute deadline must be injected into the child');
assert.doesNotMatch(source, /\.done/, 'the wrapper must not depend on a second completion artifact (single-authority marker evidence)');
assert.match(source, /validate_daily_operating_refresh\.mjs/, 'completion uses the shared semantic validator');
assert.match(source, /--business-date "\$business_date"/, 'completion verifies the exact businessDate through the semantic validator');
assert.match(source, /clear_active_context/, 'context is cleared only after verified completion or self-heal');
assert.match(source, /RECOVERED_RUN_DATE/, 'an active older runDate is recovered first');
assert.match(source, /prev_day "\$RECOVERED_RUN_DATE"\)/, 'a recovered pair must satisfy businessDate == runDate - 1');
assert.match(source, /- 1 day/, 'the previous-day relationship must be calendar-derived');
assert.match(source, /write_terminal_deadline_failure/, 'an expired first-start deadline must converge to terminal evidence');
assert.match(source, /morning-chain-last\.json/, 'terminal convergence must write the cloud_ops_alert the watchdog surfaces');
assert.match(source, /return 76/, 'deadline failure must remain non-zero and systemd-visible');
assert.match(source, /flock -n 8/, 'the wrapper must serialize systemd and manual starts with one mutex');

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
mkdir -p "\$SB/scripts" "\$SB/config" "\$SB/state/cloud_morning_chain" "\$SB/state/pipeline-markers" "\$SB/runtime/plans" "\$SB/runtime/results"

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
node "\$SB/scripts/write_valid_bundle.mjs" "\$R" "\$B"
mkdir -p "\$SB/state/cloud_morning_chain"
printf "completed_at=now\\nbusiness_date=%s\\nlog=stub\\n" "\$B" > "\$SB/state/cloud_morning_chain/\$R.done"
exit 0
STUB
chmod +x "\$SB/scripts/cloud_morning_chain.sh"
cp "\$REPO/scripts/pipeline_marker.mjs" "\$SB/scripts/pipeline_marker.mjs"
cp "\$REPO/scripts/validate_daily_operating_refresh.mjs" "\$SB/scripts/validate_daily_operating_refresh.mjs"
cp "\$REPO/config/inventory_replenishment_policy.json" "\$SB/config/inventory_replenishment_policy.json"
cat > "\$SB/scripts/write_valid_bundle.mjs" <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const root = process.env.SB;
const [runDate, businessDate] = process.argv.slice(2);
const stores = ['CX','DL','DX','FY','HL','JSH','JY','LQ','MZ','NM','QH','QY','TS','TZ','TZZ','XC','XL','YJ','ZL'];
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hashValue = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(value, null, 2)+'\\n'); };
write(path.join(root, 'config', 'stores.json'), {stores: stores.map(storeKey => ({storeKey, enabled:true}))});
const artifacts = [];
for (const storeKey of stores) for (const domain of ['shein_links','shein_business_domains']) {
  const file = path.join(root, 'outputs', domain, storeKey, businessDate+'.json');
  write(file, {ok:true,date:businessDate,store:{storeKey}});
  const stat = fs.statSync(file);
  artifacts.push({storeKey,domain,path:path.relative(root,file).split(path.sep).join('/'),bytes:stat.size,sha256:hashFile(file)});
}
const morning = path.join(root, 'state', 'cloud_morning_chain', runDate+'-all.json');
write(morning, {schemaVersion:'shein-morning-resume-evidence/v1',ok:true,date:businessDate,generatedAt:new Date().toISOString(),source:'existing_exact_date_store_artifacts',expectedStoreCount:19,artifactCount:38,stores,domains:['shein_links','shein_business_domains'],artifacts});
const policy = JSON.parse(fs.readFileSync(path.join(root,'config','inventory_replenishment_policy.json'),'utf8'));
const fetchedAt = new Date().toISOString();
const sourceEvidence = [
  {store:'ET',file:'outputs/bi-portal/sections/inventoryTrend.json',fetchedAt,totalEtRows:1,matchedCurrentDayEtRows:1},
  {store:'BI_LINKS',file:'outputs/bi-portal/sections/linksData.json',fetchedAt},
  ...stores.map(store => ({store,file:'outputs/shein_openapi_products/'+store+'/latest.json',fetchedAt,stockFailedChunkCount:0})),
];
const plan = {schemaVersion:'daily-inventory-replenishment-plan/v1',date:runDate,policyVersion:policy.policyVersion,executable:true,blockers:[],actionable:[],lowEtAllocations:[],sourceEvidence,counts:{enabledStores:19}};
plan.payloadHash = hashValue({schemaVersion:plan.schemaVersion,date:plan.date,policyVersion:plan.policyVersion,actionable:plan.actionable,lowEtAllocations:plan.lowEtAllocations,sourceEvidence:plan.sourceEvidence});
const planFile = path.join(root,'runtime','plans','daily-inventory-replenishment-'+runDate+'.json');
const resultFile = path.join(root,'runtime','results','daily-inventory-replenishment-'+runDate+'.json');
write(planFile, plan);
write(resultFile, {schemaVersion:'daily-inventory-replenishment-result/v1',generatedAt:new Date().toISOString(),planHash:plan.payloadHash,policyVersion:plan.policyVersion,execute:true,executionMode:'automatic',authorizationId:policy.execution.automaticExecution.authorizationId,authorizationContext:policy.execution.automaticExecution.allowedContext,unresolvedIntents:[],results:[]});
const evidence = files => files.map(file => ({path:file,bytes:fs.statSync(file).size,sha256:hashFile(file)}));
const inventoryMarker = path.join(root,'state','pipeline-markers',runDate,'daily-inventory-guard.json');
write(inventoryMarker,{ok:true,stage:'daily-inventory-guard',status:'done',runDate,businessDate,completedAt:new Date().toISOString(),message:'complete',evidence:evidence([planFile,resultFile])});
const finalMarker = path.join(root,'state','pipeline-markers',runDate,'daily-operating-refresh.json');
write(finalMarker,{ok:true,stage:'daily-operating-refresh',status:'done',runDate,businessDate,completedAt:new Date().toISOString(),message:'complete',evidence:evidence([morning,inventoryMarker,planFile,resultFile])});
NODE

WRAPPER="\$REPO/scripts/run_cloud_morning_chain_job.sh"
export SHEIN_BI_ROOT="\$SB"
export SHEIN_BI_MORNING_CHAIN_STATE_DIR="\$SB/state/cloud_morning_chain"
export SHEIN_BI_PIPELINE_MARKER_ROOT="\$SB/state/pipeline-markers"
export SHEIN_BI_MORNING_CHAIN_SCRIPT="\$SB/scripts/cloud_morning_chain.sh"
export SHEIN_BI_INVENTORY_RUNTIME_ROOT="\$SB/runtime"
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
write_done_marker() {
  node "\$SB/scripts/write_valid_bundle.mjs" "\$1" "\$2"
}

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
rm -f "\$CALLS_LOG" "\$STATE/latest.json"
rm -rf "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers"
write_done_marker "\$TODAY" "\$YESTERDAY"
CTX_DEADLINE=\$(( FIXED_DEADLINE + 1234 ))
cat > "\$STATE/active.json" <<JSON
{"runDate":"\$TODAY","businessDate":"\$YESTERDAY","deadlineEpoch":\$CTX_DEADLINE,"startedAt":"x","pid":1,"attempt":1}
JSON
export STUB_MODE=resume_skip
bash "\$WRAPPER" >/dev/null 2>&1
check t2_rc 0 "\$?"
check t2_calls "0" "\$(wc -l < "\$CALLS_LOG" 2>/dev/null || echo 0)"
[[ ! -e "\$STATE/active.json" ]] && echo 'PASS[t2 ctx cleared (self-heal, no livelock)]' || { echo 'FAIL[t2 ctx cleared]'; FAIL=1; }
check t2_latest_ok "ok" "\$(latest_status)"
check t2_latest_date "\$TODAY" "\$(json_field "\$STATE/latest.json" date)"
check t2_latest_business_date "\$YESTERDAY" "\$(json_field "\$STATE/latest.json" businessDate)"

# t2b: a metadata-correct marker with one arbitrary evidence file is not a
# completion record.  The child is invoked, its resume-skip cannot repair the
# invalid bundle, and wrapper exit remains non-zero with context retained.
rm -f "\$CALLS_LOG"
rm -rf "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers"
printf '{"ok":true}\n' > "\$SB/arbitrary.json"
node "\$SB/scripts/pipeline_marker.mjs" write --root "\$MARKER_ROOT" --stage daily-operating-refresh \
  --date "\$TODAY" --business-date "\$YESTERDAY" --status done --message fake --evidence "\$SB/arbitrary.json" >/dev/null
cat > "\$STATE/active.json" <<JSON
{"runDate":"\$TODAY","businessDate":"\$YESTERDAY","deadlineEpoch":\$CTX_DEADLINE,"startedAt":"x","pid":1,"attempt":1}
JSON
export STUB_MODE=resume_skip
bash "\$WRAPPER" >/dev/null 2>&1
check t2b_rc 78 "\$?"
check t2b_child_called "1" "\$(wc -l < "\$CALLS_LOG")"
[[ -e "\$STATE/active.json" ]] && echo 'PASS[t2b invalid marker context retained]' || { echo 'FAIL[t2b context missing]'; FAIL=1; }

# t3: an unfinished OLD runDate is never executed across midnight. The same
# activation records its terminal evidence, then starts TODAY only.
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
check t3_ctx_today "\$TODAY \$YESTERDAY" "\$(ctx_of)"
check t3_deadline_today "\$FIXED_DEADLINE" "\$(ctx_deadline)"
check t3_old_child_not_called "\$TODAY \$YESTERDAY" "\$(cut -d' ' -f1-2 "\$CALLS_LOG")"
export STUB_MODE=success
bash "\$WRAPPER" >/dev/null 2>&1
check t3_second_rc 0 "\$?"
check t3_calls "2" "\$(wc -l < "\$CALLS_LOG")"
check t3_today_pair "\$TODAY \$YESTERDAY" "\$(sed -n 2p "\$CALLS_LOG" | cut -d' ' -f1-2)"
check t3_today_deadline "\$FIXED_DEADLINE" "\$(sed -n 2p "\$CALLS_LOG" | cut -d' ' -f3)"
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

# t6: EXPIRED first-start deadline -> converge to terminal evidence, exit 76,
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
check t6_rc 76 "\$?"
check t6_no_child "0" "\$(wc -l < "\$CALLS_LOG" 2>/dev/null || echo 0)"
check t6_latest_failed "failed" "\$(latest_status)"
printf '%s' "\$(latest_message)" | grep -q 'deadline' && echo 'PASS[t6 latest reason mentions deadline]' || { echo 'FAIL[t6 latest reason]'; FAIL=1; }
[[ -f "\$SB/state/cloud_ops_alerts/morning-chain-last.json" ]] && echo 'PASS[t6 alert file written]' || { echo 'FAIL[t6 alert file]'; FAIL=1; }
check t6_marker_failed "failed" "\$(morning_all_marker_status "\$TODAY")"

# t7: a later explicit activation after terminal convergence is a new same-day
# attempt and may run the child; it cannot be silently suppressed as success.
rm -f "\$CALLS_LOG"
bash "\$WRAPPER" >/dev/null 2>&1
check t7_rc 0 "\$?"
check t7_child "1" "\$(wc -l < "\$CALLS_LOG")"
check t7_pair "\$TODAY \$YESTERDAY" "\$(cut -d' ' -f1-2 "\$CALLS_LOG")"

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
# the window) converges immediately, records terminal failure and exits 76
# without ever invoking the child.
rm -f "\$CALLS_LOG" "\$STATE/latest.json" "\$STATE/active.json"
rm -rf "\$SB/state/cloud_ops_alerts"
rm -rf "\$SB/state/pipeline-markers"
mkdir -p "\$SB/state/pipeline-markers"
export STUB_MODE=success
SHEIN_BI_MORNING_RUN_DEADLINE_EPOCH=\$(( NOW - 5 )) bash "\$WRAPPER" >/dev/null 2>&1
check t11_rc 76 "\$?"
check t11_no_child "0" "\$(wc -l < "\$CALLS_LOG" 2>/dev/null || echo 0)"
check t11_latest_failed "failed" "\$(latest_status)"
[[ -f "\$SB/state/cloud_ops_alerts/morning-chain-last.json" ]] && echo 'PASS[t11 alert file written]' || { echo 'FAIL[t11 alert file]'; FAIL=1; }

# t12: REAL counterexample: the child already wrote latest=failed before the
# persisted deadline expired.  Restart at the deadline must preserve that
# original latest failure reason, start NO child, exit 76, and independently
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
check t12_rc 76 "\$?"
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
# yesterday's logical run.  The wrapper must start no child, exit 76 and
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
check t13_rc 76 "\$?"
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

# t14: yesterday's unfinished run is refused and recorded, then TODAY starts
# independently in the same activation; the old child itself never runs.
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
touch "\$CALLS_LOG"
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
    'expired_deadline_converges_to_terminal_evidence_exit_76',
    'preexisting_failed_latest_still_gets_deadline_alert_and_marker',
    'stale_cross_day_failed_latest_rewritten_for_current_deadline_run',
    'unfinished_yesterday_child_is_refused_before_fresh_today_run',
    'businessDate_runDate_minus_1_fail_closed',
    'no_runDate_equals_businessDate',
    'fake_completion_rejected',
    'malformed_context_ignored',
  ],
}, null, 2));
