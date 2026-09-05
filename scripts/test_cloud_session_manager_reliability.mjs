#!/usr/bin/env node

/**
 * Deterministic reliability contracts for the nightly session-manager run.
 *
 * No real systemd state, no browser and no SHEIN access are required:
 *  - the coordinator wrapper (run_cloud_session_manager_job.sh) is executed
 *    inside a stubbed sandbox root whose shared browser-read lane is a
 *    deterministic fake script, while pipeline markers, the store config and
 *    the cloud-session-manager-latest.json report are real (copied / written)
 *    implementations under the sandbox;
 *  - completion is the STRONG evidence predicate: an ok=true done marker with
 *    matching stage/runDate/businessDate PLUS a same-day ok=true report
 *    covering every enabled store.  A warning marker or a done marker without
 *    that evidence is NOT completed and never skips the run;
 *  - retry-max defaults to 0 (unlimited; the deadline is the only boundary);
 *    a non-zero value is an explicit test/emergency override;
 *  - --check-only exposes the same predicate read-only for the morning gate.
 *
 * Run directly:  node scripts/test_cloud_session_manager_reliability.mjs
 */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {classifyLoginBlocker} from './auto_relogin_shein_store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const toWslPath = value => {
  const match = /^([A-Za-z]):\\(.*)$/.exec(value);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}` : value.replace(/\\/g, '/');
};

if (process.platform === 'win32' && process.env.SHEIN_TEST_WSL_RELAY !== '1') {
  const result = spawnSync('wsl.exe', [
    '--cd', toWslPath(root),
    '--exec', '/usr/bin/env',
    'SHEIN_TEST_WSL_RELAY=1',
    '/usr/bin/node', 'scripts/test_cloud_session_manager_reliability.mjs',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    killSignal: 'SIGKILL',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const nodeBin = process.execPath;
let passed = 0;

function ok(label) {
  passed += 1;
  console.log(`PASS ${label}`);
}

function shanghaiDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}


function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sessionRow(storeKey = 'T1', {ok = true, probeOk = true} = {}) {
  return {
    storeKey,
    groupKey: 'TEST',
    shopName: storeKey,
    port: 1,
    ok,
    mode: 'check',
    startedAt: new Date(Date.now() - 1000).toISOString(),
    endedAt: new Date().toISOString(),
    warnings: probeOk ? [] : ['webapi_session_probe_not_verified'],
    profile: {
      path: `outputs/profiles/${storeKey}`,
      sizeBytesBefore: 0,
      sizeBefore: '0 B',
      sizeBytesAfter: 0,
      sizeAfter: '0 B',
      cleanup: [],
    },
    sessions: {browser: {exists: true}, webapi: {exists: true}},
    probe: {ok, failedStores: [], reportFile: '', date: shanghaiDate()},
    exportSession: ok && probeOk ? {stores: [{storeKey, webApiProbe: {ok: true}}]} : null,
  };
}

// Deterministic fake of the cloud-session-manager-latest.json schema written
// by cloud_shein_session_manager.mjs (report.date / generatedAt / summary /
// results with per-store ok + exportSession.stores[].webApiProbe.ok).
function writeReport(file, {
  generatedAt = new Date().toISOString(),
  date = shanghaiDate(),
  rows = [sessionRow('T1')],
  summary = null,
  ok = null,
} = {}) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const resolvedSummary = summary || {
    totalStores: rows.length,
    okStores: rows.filter(r => r.ok).length,
    failedStores: rows.filter(r => !r.ok).map(r => r.storeKey),
    profilesTotalBytes: 0,
    profilesTotalHuman: '0 B',
  };
  fs.writeFileSync(file, JSON.stringify({
    ok: ok === null
      ? resolvedSummary.failedStores.length === 0 && resolvedSummary.okStores === resolvedSummary.totalStores
      : ok,
    generatedAt,
    date,
    mode: 'check',
    summary: resolvedSummary,
    issues: [],
    warnings: [],
    results: rows,
  }, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Runtime prerequisites
// ---------------------------------------------------------------------------

const bashProbe = spawnSync('bash', ['--version'], {encoding: 'utf8'});
assert.equal(bashProbe.error, undefined, 'bash must be available for coordinator sandbox tests');
assert.match(String(bashProbe.stdout), /GNU bash/);
ok('bash runtime available');

// ---------------------------------------------------------------------------
// Syntax gates
// ---------------------------------------------------------------------------

const runWrapper = 'scripts/run_cloud_session_manager_job.sh';
spawnSync('bash', ['-n', runWrapper], {cwd: root, stdio: 'inherit'});
ok(`bash -n ${runWrapper}`);

spawnSync(nodeBin, ['--check', 'scripts/auto_relogin_shein_store.mjs'], {cwd: root, stdio: 'inherit'});
ok('node --check scripts/auto_relogin_shein_store.mjs');

// ---------------------------------------------------------------------------
// systemd unit/timer + coordinator static contracts
// ---------------------------------------------------------------------------

const service = fs.readFileSync(
  path.join(root, 'infra', 'systemd', 'shein-bi-cloud-session-manager.service'),
  'utf8',
);
const timer = fs.readFileSync(
  path.join(root, 'infra', 'systemd', 'shein-bi-cloud-session-manager.timer'),
  'utf8',
);
const coordinator = fs.readFileSync(
  path.join(root, 'scripts', 'run_cloud_session_manager_job.sh'),
  'utf8',
);

assert.doesNotMatch(service, /SuccessExitStatus=\s*75/,
  'unit must not silently treat exit 75 as a successful run');
assert.match(service, /ExecStart=.*run_cloud_session_manager_job\.sh/,
  'unit must start through the retry coordinator');
assert.match(service, /--deadline-at 01:27/,
  'the normal 00:45 unit path must keep its 01:27 wall-clock deadline');
assert.doesNotMatch(service, /--deadline-epoch/,
  'the normal unit must not invent a catch-up epoch deadline');
assert.match(service, /run_pipeline_stage\.sh --stage nightly-session/,
  'unit must keep the nightly-session pipeline stage under the coordinator');
assert.match(service, /SHEIN_BI_SESSION_MANAGER_RETRY_MAX=0/,
  'unit default retry-max must be 0 (unlimited; only the deadline bounds it)');
assert.match(service, /SHEIN_BI_SESSION_MANAGER_DEADLINE_SAFETY_SEC=30/,
  'unit must define the deadline safety margin');
assert.doesNotMatch(service, /SuccessExitStatus=/,
  'unit must not mask any special exit status');
ok('unit retry-max=0, no SuccessExitStatus, starts through the coordinator');

assert.match(timer, /Persistent=true/, 'timer must catch up after a missed schedule');
assert.match(timer, /OnCalendar=\*-\*-\* 00:45:00/, 'the single 00:45 window must be preserved');
assert.equal((timer.match(/OnCalendar=/g) || []).length, 1,
  'no second timer window / duplicate queue may be created');
assert.match(timer, /Unit=shein-bi-cloud-session-manager\.service/,
  'the timer must keep triggering the same single service');
ok('timer Persistent=true with a single 00:45 window');

assert.match(coordinator, /RETRY_MAX="\$\{SHEIN_BI_SESSION_MANAGER_RETRY_MAX:-0\}"/,
  'coordinator default retry-max must be 0 = unlimited');
assert.match(coordinator, /if \(\( RETRY_MAX > 0 && ATTEMPT >= RETRY_MAX \)\)/,
  'the retry budget must only apply to an explicit non-zero override');
assert.match(coordinator, /LANE_DEADLINE_ARGS=\(--deadline-at "\$DEADLINE_AT"\)/,
  'normal coordinator runs must pass only the wall-clock deadline to the lane');
assert.match(coordinator, /LANE_DEADLINE_ARGS=\(--deadline-epoch "\$DEADLINE_EPOCH"\)/,
  'explicit epoch runs must pass only the absolute deadline to the lane');
assert.match(coordinator, /--check-only\)/, 'coordinator must expose a check-only mode');
assert.match(coordinator, /nightly_session_completed\(\)/,
  'coordinator owns the strong completion predicate');
assert.match(coordinator, /marker\?\.status === 'done'/, 'completion needs status=done');
assert.match(coordinator, /summary\?\.failedStores/, 'completion checks the report store coverage');
assert.match(coordinator, /report\?\.date/, 'completion must check report.date against the run date');
assert.match(coordinator, /uniqueKeys/, 'completion must reject duplicate storeKey rows');
assert.match(coordinator, /const sortedResultKeys = \[\.\.\.resultKeys\]\.sort\(\)/,
  'exact enabled-store coverage must compare a sorted copy without mutating the uniqueness input');
assert.match(coordinator, /webApiProbe\?\.ok === true/, 'completion must require the per-store WebAPI probe proof the producer writes');
assert.match(coordinator, /expectedKeys\.length === 0/, 'an unreadable/empty enabled-store config must fail closed');
assert.match(coordinator, /completion_evidence_missing/,
  'inner exit 0 without strong evidence must fail closed');
assert.match(coordinator, /marker=\$current_status runDate=\$RUN_DATE is NOT a completed state/,
  'a warning marker must trigger a fresh attempt, never a skip');
ok('coordinator strong-evidence predicate and retry-max=0 default');

// ---------------------------------------------------------------------------
// Coordinator behavior in a stubbed sandbox (no real systemd/browser)
// ---------------------------------------------------------------------------

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'session-manager-reliability-'));
const sandboxScripts = path.join(sandbox, 'scripts');
const sandboxMsys = toWslPath(sandbox);
const markerRoot = path.join(sandbox, 'state', 'pipeline-markers');
const alertFile = path.join(sandbox, 'state', 'cloud_ops_alerts', 'session-manager-last.json');
const deferState = path.join(sandbox, 'runtime', 'host-scheduler', 'session-manager.latest.json');
const reportFile = path.join(sandbox, 'outputs', 'reports', 'cloud-session-manager-latest.json');
const laneLog = path.join(sandbox, 'lane.log');
const runDate = shanghaiDate();
fs.mkdirSync(sandboxScripts, {recursive: true});
fs.mkdirSync(path.join(sandbox, 'config'), {recursive: true});
fs.writeFileSync(path.join(sandbox, 'config', 'stores.json'), JSON.stringify({
  stores: [{storeKey: 'T1', enabled: true}],
}), 'utf8');

const fakeLane = String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
# Deterministic offline fake of run_host_browser_read_job.sh.
# Accepts the same CLI shape; defers (exit 75 + defer-state JSON), fails, or
# runs the inner command based on FAKE_LANE_PLAN_FILE (JSON array of steps
# {action: defer|fail|run, reason, exit}).
DEFER_STATE_FILE=""
SEEN_DEADLINE_AT=""
SEEN_DEADLINE_EPOCH=""
while (($#)); do
  case "$1" in
    --defer-state) (($# >= 2)) || exit 64; DEFER_STATE_FILE="$2"; shift 2 ;;
    --deadline-at) (($# >= 2)) || exit 64; SEEN_DEADLINE_AT="$2"; shift 2 ;;
    --deadline-epoch) (($# >= 2)) || exit 64; SEEN_DEADLINE_EPOCH="$2"; shift 2 ;;
    --domain|--lock-wait-sec) (($# >= 2)) || exit 64; shift 2 ;;
    --) shift; break ;;
    *) exit 64 ;;
  esac
done
if [[ "$FAKE_LANE_EXPECT_DEADLINE_MODE" == "epoch_only" ]]; then
  [[ -n "$SEEN_DEADLINE_EPOCH" && -z "$SEEN_DEADLINE_AT" ]] || {
    echo "expected epoch-only lane deadline; at=$SEEN_DEADLINE_AT epoch=$SEEN_DEADLINE_EPOCH" >&2
    exit 65
  }
elif [[ "$FAKE_LANE_EXPECT_DEADLINE_MODE" == "clock_only" ]]; then
  [[ -n "$SEEN_DEADLINE_AT" && -z "$SEEN_DEADLINE_EPOCH" ]] || {
    echo "expected clock-only lane deadline; at=$SEEN_DEADLINE_AT epoch=$SEEN_DEADLINE_EPOCH" >&2
    exit 65
  }
fi
LOG_FILE="$FAKE_LANE_LOG_FILE"
if [[ -z "$LOG_FILE" ]]; then
  echo "FAKE_LANE_LOG_FILE is required" >&2
  exit 2
fi
mkdir -p "$(dirname "$LOG_FILE")"
printf 'attempt_%s\n' "$(date +%s)" >> "$LOG_FILE"
STEP_INDEX=$(( $(wc -l < "$LOG_FILE") - 1 ))
ACTION=run
REASON=resource_pressure
EXIT_CODE=0
if [[ -n "$FAKE_LANE_PLAN_FILE" && -f "$FAKE_LANE_PLAN_FILE" ]]; then
  DECISION="$(FAKE_LANE_PLAN_FILE="$FAKE_LANE_PLAN_FILE" STEP_INDEX="$STEP_INDEX" node --input-type=module - <<'NODE'
import fs from 'node:fs';
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_LANE_PLAN_FILE, 'utf8'));
const index = Number(process.env.STEP_INDEX || 0);
const step = plan[Math.min(index, plan.length - 1)] || {};
const action = String(step.action || 'run');
const reason = String(step.reason || 'resource_pressure');
const exitCode = String(Number(step.exit || 0));
process.stdout.write(action + '\t' + reason + '\t' + exitCode);
NODE
)"
  IFS=$'\t' read -r ACTION REASON EXIT_CODE <<< "$DECISION"
fi
if [[ "$ACTION" == "defer" ]]; then
  if [[ -n "$DEFER_STATE_FILE" ]]; then
    DEFER_STATE_FILE="$DEFER_STATE_FILE" DEFER_REASON="$REASON" node --input-type=module - <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const file = process.env.DEFER_STATE_FILE;
fs.mkdirSync(path.dirname(file), {recursive: true});
const payload = {ok: false, status: 'deferred', reason: process.env.DEFER_REASON, domain: 'session-manager', generatedAt: new Date().toISOString()};
fs.writeFileSync(file, JSON.stringify(payload) + '\n');
NODE
  fi
  exit 75
fi
if [[ "$ACTION" == "fail" ]]; then
  exit "$EXIT_CODE"
fi
"$@"
`;
fs.writeFileSync(path.join(sandboxScripts, 'run_host_browser_read_job.sh'), fakeLane);

// The stub session manager writes the real cloud-session-manager-latest.json
// (strong evidence) unless FAKE_SESSION_MODE=no_report, matching production.
const fakeSessionManager = String.raw`#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$SHEIN_FAKE_SESSION_MODE" == "no_report" ]]; then
  exit 0
fi
REPORT_DIR="$PWD/outputs/reports"
mkdir -p "$REPORT_DIR"
export TZ=Asia/Shanghai
cat > "$REPORT_DIR/cloud-session-manager-latest.json" <<JSON
{"ok":true,"generatedAt":"$(date --iso-8601=seconds)","date":"$(date +%F)","mode":"check","closeLaunched":true,"cleanupCache":false,"summary":{"totalStores":1,"okStores":1,"failedStores":[],"profilesTotalBytes":0,"profilesTotalHuman":"0 B"},"issues":[],"warnings":[],"results":[{"storeKey":"T1","groupKey":"TEST","ok":true,"mode":"check","warnings":[],"sessions":{"browser":{"exists":true},"webapi":{"exists":true}},"probe":{"ok":true,"failedStores":[],"reportFile":"","date":"$(date +%F)"},"exportSession":{"stores":[{"storeKey":"T1","webApiProbe":{"ok":true}}]}}]}
JSON
exit 0
`;
fs.writeFileSync(path.join(sandboxScripts, 'fake_session_manager.sh'), fakeSessionManager);
fs.copyFileSync(path.join(root, 'scripts', 'run_pipeline_stage.sh'), path.join(sandboxScripts, 'run_pipeline_stage.sh'));
fs.copyFileSync(path.join(root, 'scripts', 'pipeline_marker.mjs'), path.join(sandboxScripts, 'pipeline_marker.mjs'));
spawnSync('bash', ['-n', toWslPath(path.join(sandboxScripts, 'run_host_browser_read_job.sh'))], {stdio: 'inherit'});
ok('fake lane script parses');

function writePlan(steps) {
  const file = path.join(sandbox, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(steps), 'utf8');
  return file;
}

function laneAttempts() {
  try {
    return fs.readFileSync(laneLog, 'utf8').split('\n').filter(line => line.trim()).length;
  } catch {
    return 0;
  }
}

function markerPath() {
  return path.join(markerRoot, runDate, 'nightly-session.json');
}

function writeMarker(status) {
  const result = spawnSync(nodeBin, [
    path.join(sandboxScripts, 'pipeline_marker.mjs'),
    'write', '--stage', 'nightly-session', '--date', runDate,
    '--status', status, '--root', markerRoot,
    '--message', `test marker ${status}`,
  ], {cwd: sandbox, encoding: 'utf8'});
  assert.equal(result.status, 0, `marker write failed: ${result.stderr}`);
}

function runCoordinator({
  plan,
  retryMax = 0,
  deadlineEpoch = String(Math.floor(Date.now() / 1000) + 600),
  expectMarkerRoot = markerRoot,
  fakeSessionMode = '',
} = {}) {
  const planFile = writePlan(plan);
  const args = [
    toWslPath(path.join(root, runWrapper)),
    '--root', sandboxMsys,
    '--domain', 'session-manager',
    '--lock-wait-sec', '1',
    '--deadline-at', '01:27',
    '--deadline-epoch', deadlineEpoch,
    '--defer-state', toWslPath(deferState),
    '--marker-stage', 'nightly-session',
    '--marker-root', toWslPath(expectMarkerRoot),
    '--alert-file', toWslPath(alertFile),
    '--report-file', toWslPath(reportFile),
    '--run-date', runDate,
    '--retry-max', String(retryMax),
    '--retry-backoff-sec', '0',
    '--retry-backoff-max-sec', '0',
    '--deadline-safety-sec', '0',
    '--',
    'bash', toWslPath(path.join(sandboxScripts, 'run_pipeline_stage.sh')),
    '--stage', 'nightly-session',
    '--message', 'offline test completed',
    '--',
    'bash', toWslPath(path.join(sandboxScripts, 'fake_session_manager.sh')),
  ];
  const result = spawnSync('bash', args, {
    cwd: sandbox,
    env: {
      ...process.env,
      SHEIN_BI_ROOT: sandboxMsys,
      SHEIN_FAKE_SESSION_MODE: fakeSessionMode,
      WSLENV: 'FAKE_LANE_PLAN_FILE:FAKE_LANE_LOG_FILE:FAKE_LANE_EXPECT_DEADLINE_MODE:SHEIN_FAKE_SESSION_MODE',
      FAKE_LANE_PLAN_FILE: toWslPath(planFile),
      FAKE_LANE_LOG_FILE: toWslPath(laneLog),
      FAKE_LANE_EXPECT_DEADLINE_MODE: 'epoch_only',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.error, undefined, `coordinator spawn failed: ${result.error}`);
  if (result.status !== 0) {
    console.error(`[coordinator stderr] ${String(result.stderr).trim()}`);
  }
  return result;
}

function runCheckOnly() {
  const args = [
    toWslPath(path.join(root, runWrapper)),
    '--check-only',
    '--root', sandboxMsys,
    '--marker-stage', 'nightly-session',
    '--marker-root', toWslPath(markerRoot),
    '--report-file', toWslPath(reportFile),
    '--run-date', runDate,
  ];
  const result = spawnSync('bash', args, {
    cwd: sandbox,
    env: {...process.env, SHEIN_BI_ROOT: sandboxMsys},
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, `check-only spawn failed: ${result.error}`);
  return result;
}

function previewMarker() {
  const file = markerPath();
  return fs.existsSync(file) ? readJson(file) : null;
}

// --- check-only: the strong predicate shared with the morning gate ---------

// cs1 missing marker + missing report.
assert.equal(runCheckOnly().status, 1, 'missing evidence must fail check-only');
ok('cs1 check-only fails with no marker and no report');

// cs2 warning marker without the 19/19 report must NOT be completed.
writeMarker('warning');
assert.equal(runCheckOnly().status, 1, 'warning marker without report must fail check-only');
ok('cs2 warning marker alone is not completed');

// cs3 done marker + same-day full-store report -> completed.
writeMarker('done');
writeReport(reportFile);
assert.equal(runCheckOnly().status, 0, 'done marker + fresh full-store report must pass check-only');
ok('cs3 check-only passes with done marker + same-day 19/19 report');

// cs4 done marker + stale report is not fresh -> not completed.
const stale = new Date(Date.now() - 26 * 3600_000).toISOString();
writeReport(reportFile, {generatedAt: stale});
assert.equal(runCheckOnly().status, 1, 'stale report must fail check-only');
ok('cs4 stale report fails check-only');

// cs5 done marker + partial coverage (okStores<total, failed stores) -> not completed.
writeReport(reportFile, {rows: [sessionRow('T1', {ok: false})]});
assert.equal(runCheckOnly().status, 1, 'partial coverage report must fail check-only');
ok('cs5 partial 18/19-style report fails check-only');

// cs6 FORGED summary 19/19 with results=[] must fail: the per-store evidence
// (exact enabled store set, per-store ok and WebAPI probe proof) is required.
writeMarker('done');
writeReport(reportFile, {
  rows: [],
  summary: {totalStores: 1, okStores: 1, failedStores: [], profilesTotalBytes: 0, profilesTotalHuman: '0 B'},
  ok: true,
});
assert.equal(runCheckOnly().status, 1, 'forged 19/19 summary with results=[] must fail check-only');
ok('cs6 forged summary 19/19 + results=[] fails');

// cs7 duplicate storeKey rows must fail (unique storeKey per enabled store).
writeMarker('done');
writeReport(reportFile, {
  rows: [sessionRow('T1'), sessionRow('T1')],
  summary: {totalStores: 2, okStores: 2, failedStores: [], profilesTotalBytes: 0, profilesTotalHuman: '0 B'},
  ok: true,
});
assert.equal(runCheckOnly().status, 1, 'duplicate storeKey rows must fail check-only');
ok('cs7 duplicate storeKey rows fail');

// cs8 a store that is not in the enabled config must fail (exact set check).
writeMarker('done');
writeReport(reportFile, {
  rows: [sessionRow('T1'), sessionRow('T2')],
  summary: {totalStores: 2, okStores: 2, failedStores: [], profilesTotalBytes: 0, profilesTotalHuman: '0 B'},
  ok: true,
});
assert.equal(runCheckOnly().status, 1, 'a non-enabled extra store must fail check-only');
ok('cs8 extra store outside the enabled set fails');

// cs9 a per-store ok=false row must fail even when the summary claims full
// success (summary fields alone are never evidence).
writeMarker('done');
writeReport(reportFile, {
  rows: [sessionRow('T1', {ok: false})],
  summary: {totalStores: 1, okStores: 1, failedStores: [], profilesTotalBytes: 0, profilesTotalHuman: '0 B'},
  ok: true,
});
assert.equal(runCheckOnly().status, 1, 'per-store ok=false with a forged ok summary must fail');
ok('cs9 per-store ok=false fails despite forged summary');

// cs10 an ok row without the WebAPI probe proof (exportSession missing / probe
// not ok) must fail: the current producer only marks a store ok when the probe
// passed, so absence of proof is absence of evidence.
writeMarker('done');
writeReport(reportFile, {
  rows: [sessionRow('T1', {probeOk: false})],
  summary: {totalStores: 1, okStores: 1, failedStores: [], profilesTotalBytes: 0, profilesTotalHuman: '0 B'},
  ok: true,
});
assert.equal(runCheckOnly().status, 1, 'ok row without the WebAPI probe proof must fail');
ok('cs10 proof-less ok row fails');

// cs11 report.date mismatch with the run date must fail.
writeMarker('done');
writeReport(reportFile, {date: '2026-08-01'});
assert.equal(runCheckOnly().status, 1, 'report.date != run date must fail check-only');
ok('cs11 report.date mismatch fails');

// cs12 missing / empty enabled-store config fails closed: even a complete
// marker + plausible report cannot prove 19/19 without the authoritative
// enabled-store set.
{
  const noConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-manager-noconfig-'));
  const noConfigMsys = toWslPath(noConfigRoot);
  const noConfigMarker = path.join(noConfigRoot, 'state', 'pipeline-markers');
  const noConfigReport = path.join(noConfigRoot, 'outputs', 'reports', 'cloud-session-manager-latest.json');
  fs.mkdirSync(path.join(noConfigMarker, runDate), {recursive: true});
  fs.mkdirSync(path.dirname(noConfigReport), {recursive: true});
  fs.copyFileSync(markerPath(), path.join(noConfigMarker, runDate, 'nightly-session.json'));
  writeReport(noConfigReport);
  const result = spawnSync('bash', [
    toWslPath(path.join(root, runWrapper)),
    '--check-only',
    '--root', noConfigMsys,
    '--marker-stage', 'nightly-session',
    '--marker-root', toWslPath(noConfigMarker),
    '--report-file', toWslPath(noConfigReport),
    '--run-date', runDate,
  ], {
    // Do not make the child process hold the directory that this test removes
    // immediately afterwards; Windows/WSL can otherwise surface a false EPERM.
    cwd: os.tmpdir(),
    env: {...process.env, SHEIN_BI_ROOT: noConfigMsys},
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, `no-config check-only spawn failed: ${result.error}`);
  assert.equal(result.status, 1, 'check-only without an authoritative enabled-store config must fail closed');
  fs.rmSync(noConfigRoot, {recursive: true, force: true});
  ok('cs12 missing enabled-store config fails closed');
}

// cs13 done marker + real per-store evidence -> still completed (guard that
// the hardened predicate never rejects the genuine full-store report).
writeMarker('done');
writeReport(reportFile);
assert.equal(runCheckOnly().status, 0, 'done marker + same-day full-store per-store report must pass check-only');
ok('cs13 hardened predicate accepts the genuine per-store report');

// cs14 producer results preserve config order, which is not necessarily
// alphabetical (production starts DL, DX, ...).  Exact coverage is a set
// contract: a valid report in non-alphabetical config order must pass while
// uniqueness remains checked against the original resultKeys array.
fs.writeFileSync(path.join(sandbox, 'config', 'stores.json'), JSON.stringify({
  stores: [
    {storeKey: 'T2', enabled: true},
    {storeKey: 'T1', enabled: true},
  ],
}), 'utf8');
writeMarker('done');
writeReport(reportFile, {rows: [sessionRow('T2'), sessionRow('T1')]});
assert.equal(runCheckOnly().status, 0,
  'valid producer results in non-alphabetical config order must pass exact-set coverage');
ok('cs14 non-alphabetical config/result order passes exact enabled-store set check');
fs.writeFileSync(path.join(sandbox, 'config', 'stores.json'), JSON.stringify({
  stores: [{storeKey: 'T1', enabled: true}],
}), 'utf8');

// --- coordinator full-run behavior ------------------------------------------

// s1 unlimited retry-max (0): six fast resource defers, the 7th attempt
// succeeds before the deadline -> exit 0 with strong evidence.
fs.rmSync(laneLog, {force: true});
fs.rmSync(markerRoot, {recursive: true, force: true});
fs.rmSync(reportFile, {force: true});
let result = runCoordinator({
  plan: [
    {action: 'defer', reason: 'host_browser_read_unavailable:resource_pressure'},
    {action: 'defer', reason: 'host_browser_read_unavailable:host_exclusive_busy'},
    {action: 'defer', reason: 'host_browser_read_unavailable:project_lock_busy'},
    {action: 'defer', reason: 'host_browser_read_unavailable:resource_pressure'},
    {action: 'defer', reason: 'host_browser_read_unavailable:browser_slots_busy'},
    {action: 'defer', reason: 'host_browser_read_unavailable:resource_pressure'},
    {action: 'run'},
  ],
  retryMax: 0,
});
assert.equal(result.status, 0, `expected success after 6 defers, got ${result.status}`);
assert.equal(laneAttempts(), 7, 'retry-max=0 must keep retrying to the deadline, not cap at 6');
const alert = readJson(alertFile);
assert.equal(alert.status, 'ok');
assert.equal(alert.attempt, 7);
assert.equal(readJson(path.join(sandbox, 'state', 'cloud_ops_alerts', 'session-manager-last-ok.json')).status, 'ok');
const doneMarker = previewMarker();
assert.equal(doneMarker?.status, 'done');
assert.equal(doneMarker?.stage, 'nightly-session');
assert.equal(runCheckOnly().status, 0, 'post-run strong evidence must hold');
ok('s1 six defers then 7th success with retry-max=0 (deadline-bounded retry)');

// s2 warning marker without evidence must trigger recovery, never a skip.
fs.rmSync(laneLog, {force: true});
fs.rmSync(markerRoot, {recursive: true, force: true});
fs.rmSync(reportFile, {force: true});
writeMarker('warning');
result = runCoordinator({plan: [{action: 'run'}]});
assert.equal(result.status, 0, `warning recovery should succeed, got ${result.status}`);
assert.equal(laneAttempts(), 1, 'a warning marker must not skip the lane');
assert.equal(previewMarker()?.status, 'done');
assert.equal(readJson(alertFile).status, 'ok');
ok('s2 warning marker triggers recovery and completes with strong evidence');

// s3 done marker but stale/partial report -> recovery, then strong evidence.
fs.rmSync(laneLog, {force: true});
fs.rmSync(markerRoot, {recursive: true, force: true});
fs.rmSync(reportFile, {force: true});
writeMarker('done');
writeReport(reportFile, {rows: [sessionRow('T1', {ok: false})]});
result = runCoordinator({plan: [{action: 'run'}]});
assert.equal(result.status, 0, `done marker with bad report must not skip; recovery got ${result.status}`);
assert.equal(laneAttempts(), 1, 'a done marker with bad evidence must not skip the lane');
assert.equal(readJson(alertFile).status, 'ok');
ok('s3 done marker without full-store evidence retries instead of skipping');

// s4 strong completion present -> idempotent skip, no lane invocation.
fs.rmSync(laneLog, {force: true});
fs.rmSync(alertFile, {force: true});
writeMarker('done');
writeReport(reportFile);
result = runCoordinator({plan: [{action: 'run'}], retryMax: 3});
assert.equal(result.status, 0, `expected idempotent skip, got ${result.status}`);
assert.equal(laneAttempts(), 0, 'no lane invocation may happen when strong evidence already exists');
const skipAlert = readJson(alertFile);
assert.equal(skipAlert.status, 'skipped');
assert.match(skipAlert.reason, /completion_evidence_present/);
ok('s4 strong done + fresh 19/19 report is skipped idempotently');

// s5 numeric retry budget (explicit emergency/test override) still bounds.
fs.rmSync(laneLog, {force: true});
fs.rmSync(markerRoot, {recursive: true, force: true});
fs.rmSync(reportFile, {force: true});
result = runCoordinator({
  plan: [
    {action: 'defer', reason: 'host_browser_read_unavailable:resource_pressure'},
    {action: 'defer', reason: 'host_browser_read_unavailable:host_exclusive_busy'},
    {action: 'defer', reason: 'host_browser_read_unavailable:resource_pressure'},
  ],
  retryMax: 2,
});
assert.equal(result.status, 1);
assert.equal(laneAttempts(), 2, 'the explicit retry-max override must bound attempts');
const budgetMarker = previewMarker();
assert.equal(budgetMarker?.status, 'deferred');
const budgetAlert = readJson(alertFile);
assert.equal(budgetAlert.status, 'deferred');
assert.equal(budgetAlert.reason, 'retry_budget_exhausted');
assert.equal(budgetAlert.attempt, 2);
ok('s5 explicit non-zero retry-max bounds attempts (emergency/test override)');

// s6 the run clock crosses the deadline before any attempt.
fs.rmSync(laneLog, {force: true});
fs.rmSync(markerRoot, {recursive: true, force: true});
fs.rmSync(reportFile, {force: true});
result = runCoordinator({
  plan: [{action: 'run'}],
  deadlineEpoch: String(Math.floor(Date.now() / 1000) - 10),
});
assert.equal(result.status, 1);
assert.equal(laneAttempts(), 0, 'an already-elapsed deadline must not start the lane');
assert.equal(previewMarker()?.status, 'deferred');
ok('s6 clock deadline elapsed before attempt -> deferred marker, no run');

// s7 the lane reports deadline_elapsed before starting -> deferred, no retry.
fs.rmSync(laneLog, {force: true});
fs.rmSync(markerRoot, {recursive: true, force: true});
fs.rmSync(reportFile, {force: true});
result = runCoordinator({
  plan: [{action: 'defer', reason: 'host_browser_read_unavailable:deadline_elapsed'}],
});
assert.notEqual(result.status, 0, 'deferral to the deadline must return a real non-success');
assert.equal(result.status, 1);
assert.equal(laneAttempts(), 1, 'deadline_elapsed must not be retried');
assert.equal(previewMarker()?.status, 'deferred');
ok('s7 lane deadline_elapsed -> deferred marker + alert, exit 1, no retry');

// s8 a run killed at the mid-run deadline is reported partial, not success.
fs.rmSync(laneLog, {force: true});
fs.rmSync(markerRoot, {recursive: true, force: true});
fs.rmSync(reportFile, {force: true});
result = runCoordinator({plan: [{action: 'fail', exit: 124}], retryMax: 3});
assert.equal(result.status, 124);
assert.equal(readJson(alertFile).status, 'partial');
assert.equal(readJson(alertFile).lastExit, 124);
ok('s8 mid-run deadline kill is reported partial with the real exit code');

// s9 a failed marker does NOT skip: the next window retries.
fs.rmSync(laneLog, {force: true});
fs.rmSync(markerRoot, {recursive: true, force: true});
fs.rmSync(reportFile, {force: true});
writeMarker('failed');
result = runCoordinator({
  plan: [{action: 'defer', reason: 'host_browser_read_unavailable:resource_pressure'}],
  retryMax: 1,
});
assert.equal(result.status, 1);
assert.equal(laneAttempts(), 1, 'a failed marker must not suppress a fresh attempt');
ok('s9 failed/deferred markers do not block a rerun');

// s10 inner exit 0 without the report evidence must fail closed.
fs.rmSync(laneLog, {force: true});
fs.rmSync(markerRoot, {recursive: true, force: true});
fs.rmSync(reportFile, {force: true});
result = runCoordinator({
  plan: [{action: 'run'}],
  fakeSessionMode: 'no_report',
});
assert.equal(result.status, 1, 'exit 0 without report evidence must be a real failure');
const missingAlert = readJson(alertFile);
assert.equal(missingAlert.status, 'failed');
assert.match(missingAlert.reason, /completion_evidence_missing/);
ok('s10 inner exit 0 without strong evidence fails closed');

// ---------------------------------------------------------------------------
// auto_relogin blocker classifier (pure function, no browser)
// ---------------------------------------------------------------------------

const loginPage = {
  href: 'https://sso.geiwohuo.com/#/login/GMPSSO/abc',
  hasLoginText: true,
  title: '登录',
  textPreview: '账号 密码 登录 忘记密码',
  inputs: [
    {type: 'text', placeholder: '', hasValue: true, visible: true},
    {type: 'password', placeholder: '', hasValue: false, visible: true},
  ],
  buttons: [{text: '登录', disabled: false}],
};

const savedPassword = classifyLoginBlocker({pages: [loginPage], probeCodes: ['20302']});
assert.equal(savedPassword.blocker, 'saved_password_unavailable',
  'the exact 20302/hasPasswordValue=false evidence must resolve deterministically');
assert.equal(savedPassword.details.sawPasswordInput, true);
assert.equal(savedPassword.details.sawPasswordValue, false);
ok('login page with an empty password input -> saved_password_unavailable');

const captchaPage = {
  ...loginPage,
  hasLoginText: true,
  textPreview: '账号 密码 验证码 登录',
};
assert.equal(classifyLoginBlocker({pages: [captchaPage]}).blocker, 'verification_code_required');
ok('login page with a verification-code marker -> verification_code_required');

const securityPage = {
  ...loginPage,
  textPreview: '账号 密码 安全验证 滑动验证 登录',
};
assert.equal(classifyLoginBlocker({pages: [securityPage]}).blocker, 'security_verification_required');
ok('login page with a security-verification marker -> security_verification_required');

const redirectOnly = classifyLoginBlocker({
  pages: [{href: 'https://sso.geiwohuo.com/#/login/GMPSSO/abc', hasLoginText: false, inputs: []}],
  probeCodes: ['20302', '20302'],
});
assert.equal(redirectOnly.blocker, 'session_expired');
ok('expired session without an observed login form -> session_expired');

assert.equal(classifyLoginBlocker({pages: [loginPage], bootstrapError: 'CDP timeout'}).blocker, 'bootstrap_failed');
assert.equal(classifyLoginBlocker({pages: []}).blocker, 'bootstrap_failed');
ok('browser/CDP failure before page state -> bootstrap_failed');

const filledPasswordStalled = classifyLoginBlocker({
  pages: [{
    ...loginPage,
    inputs: [
      {type: 'text', placeholder: '', hasValue: true, visible: true},
      {type: 'password', placeholder: '', hasValue: true, visible: true},
    ],
  }],
  probeCodes: ['20302'],
});
assert.equal(filledPasswordStalled.blocker, 'session_expired');
ok('filled password without captcha and without restore -> session_expired');

// ---------------------------------------------------------------------------

fs.rmSync(sandbox, {recursive: true, force: true});
console.log(JSON.stringify({ok: true, passed}, null, 2));
