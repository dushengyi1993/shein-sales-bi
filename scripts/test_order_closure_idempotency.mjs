#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

import {PIPELINE_MARKER_SCHEMA, computeWorkFingerprint, markerPath, readMarker, requireMarker, writeMarker} from './pipeline_marker.mjs';
import {candidateSnapshotSql, computeCandidateWorksetDigest} from './recheck_order_statuses.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = 'order-closure';
const SCOPE = 'order-closure';
const SEMANTIC_VERSION = 'order-closure/v5-zero-zero-done-candidates-v1-portal-queue-v1';
const RUN_DATE = '2026-08-22';
const BUSINESS_DATE = '2026-08-21';

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const toPosixPath = value => {
  const normalized = path.resolve(value).replaceAll('\\', '/');
  return /^[A-Za-z]:\//.test(normalized) ? `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2)}` : normalized;
};
const readLines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean) : [];

function copyScript(source, target) {
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.copyFileSync(source, target);
}

function writeExecutable(file, lines) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  fs.chmodSync(file, 0o755);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readCoordinatorState(root, runDate = RUN_DATE) {
  return readJson(path.join(root, `coordinator-${runDate}.json`));
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function fixturePaths(root) {
  return {
    markerRoot: path.join(root, 'custom-marker-root'),
    candidates: path.join(root, 'candidates.json'),
    failures: path.join(root, 'failed-pairs.json'),
    recheck: path.join(root, 'recheck.log'),
    portal: path.join(root, 'portal.log'),
    queue: path.join(root, 'queue.log'),
  };
}

function stageIdentityArgs(root, maxPairs = 500) {
  return [
    '--skip-if-done',
    '--work-fingerprint-scope', SCOPE,
    '--work-semantic-version', SEMANTIC_VERSION,
    '--work-parameter', 'transport=openapi',
    '--work-parameter', `maxPairs=${maxPairs}`,
    '--work-parameter', 'minAgeDays=2',
    '--work-parameter', 'cooldownHours=20',
    '--workset-digest-program', 'node',
    '--workset-digest-arg', toPosixPath(path.join(root, 'scripts', 'recheck_order_statuses.mjs')),
    '--workset-digest-arg', '--candidate-digest',
    '--workset-digest-arg', '--max-pairs',
    '--workset-digest-arg', String(maxPairs),
  ];
}

function coordinatorWorkParameters(maxPairs = 500) {
  return {
    stage: 'order-closure',
    transport: 'openapi',
    maxPairs: String(maxPairs),
    minAgeDays: '2',
    cooldownHours: '20',
    portalUrl: 'http://127.0.0.1:8787',
    portalTimeoutSec: '240',
    portalRefreshSection: 'orders',
    queueSections: 'afterSales,homeRankings,homeProfit',
    queuePriority: '20',
    queueReason: 'order-closure',
  };
}

function runStage({
  root,
  paths,
  runDate,
  businessDate,
  sideEffect,
  sourceCommit,
  maxPairs = 500,
  stage = STAGE,
  extraArgs = [],
  includeStageIdentity = true,
}) {
  const identityArgs = includeStageIdentity ? stageIdentityArgs(root, maxPairs) : [];
  const args = [
    '--stage', stage,
    '--run-date', runDate,
    '--business-date', businessDate,
    ...extraArgs,
    ...identityArgs,
    '--source-commit', sourceCommit,
    '--', 'bash', '-c', `printf 'executed\\n' >> ${shellQuote(toPosixPath(sideEffect))}`,
  ];
  const command = [
    `export SHEIN_BI_ROOT=${shellQuote(toPosixPath(root))}`,
    `export SHEIN_BI_PIPELINE_MARKER_ROOT=${shellQuote(toPosixPath(paths.markerRoot))}`,
    `export SHEIN_TEST_CANDIDATES=${shellQuote(toPosixPath(paths.candidates))}`,
    `exec bash ${[toPosixPath(path.join(root, 'scripts', 'run_pipeline_stage.sh')), ...args].map(shellQuote).join(' ')}`,
  ].join('; ');
  return spawnSync('bash', ['-c', command], {cwd: root, encoding: 'utf8', timeout: 30_000});
}

function runCoordinator({
  root,
  paths,
  deadlineEpoch,
  runDate = RUN_DATE,
  businessDate = BUSINESS_DATE,
  maxPairs = 500,
  forcedPairCount = null,
}) {
  return new Promise((resolve, reject) => {
    const exports = {
      SHEIN_BI_ROOT: toPosixPath(root),
      SHEIN_BI_PIPELINE_MARKER_ROOT: toPosixPath(paths.markerRoot),
      SHEIN_BI_TZ: 'Asia/Shanghai',
      SHEIN_BI_ORDER_CLOSURE_RUN_DATE: runDate,
      SHEIN_BI_ORDER_CLOSURE_BUSINESS_DATE: businessDate,
      SHEIN_BI_ORDER_CLOSURE_DEADLINE_EPOCH: String(deadlineEpoch),
      SHEIN_BI_ORDER_CLOSURE_START_DEADLINE: '23:59',
      SHEIN_BI_ORDER_CLOSURE_RETRY_DELAY_SEC: '1',
      SHEIN_BI_ORDER_CLOSURE_COORDINATOR_STATE: toPosixPath(path.join(root, `coordinator-${runDate}.json`)),
      SHEIN_BI_ORDER_CLOSURE_DEFER_STATE: toPosixPath(path.join(root, `defer-${runDate}.json`)),
      SHEIN_ORDER_CLOSURE_MAX_PAIRS: String(maxPairs),
      SHEIN_ORDER_CLOSURE_OUTCOME_FILE: toPosixPath(path.join(root, 'state', 'order_closure_last_outcome.json')),
      SHEIN_TEST_DOMAIN_LOCK: toPosixPath(path.join(root, 'domain.lock')),
      SHEIN_TEST_LOCK_HELD: toPosixPath(path.join(root, 'domain-lock-held')),
      SHEIN_TEST_CANDIDATES: toPosixPath(paths.candidates),
      SHEIN_TEST_FAILED_PAIRS: toPosixPath(paths.failures),
      SHEIN_TEST_RECHECK_LOG: toPosixPath(paths.recheck),
      SHEIN_TEST_PORTAL_LOG: toPosixPath(paths.portal),
      SHEIN_TEST_QUEUE_LOG: toPosixPath(paths.queue),
    };
    if (forcedPairCount !== null) exports.SHEIN_TEST_FORCED_PAIR_COUNT = String(forcedPairCount);
    const command = [
      ...Object.entries(exports).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
      `exec bash ${shellQuote(toPosixPath(path.join(root, 'scripts', 'cloud_order_closure_coordinator.sh')))}`,
    ].join('; ');
    const child = spawn('bash', ['-c', command], {cwd: root});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({status, stdout, stderr}));
  });
}

function installFixture(root) {
  const scripts = path.join(root, 'scripts');
  copyScript(path.join(ROOT, 'scripts', 'pipeline_marker.mjs'), path.join(scripts, 'pipeline_marker.mjs'));
  copyScript(path.join(ROOT, 'scripts', 'run_pipeline_stage.sh'), path.join(scripts, 'run_pipeline_stage.sh'));
  copyScript(path.join(ROOT, 'scripts', 'cloud_order_closure_coordinator.sh'), path.join(scripts, 'cloud_order_closure_coordinator.sh'));
  writeExecutable(path.join(scripts, 'run_host_heavy_job.sh'), [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    'exec 9>"${SHEIN_TEST_DOMAIN_LOCK:?}"',
    'flock -x 9',
    'while (($#)); do',
    '  if [[ "$1" == -- ]]; then shift; break; fi',
    '  shift',
    'done',
    'printf held > "${SHEIN_TEST_LOCK_HELD:?}"',
    'trap \'rm -f "${SHEIN_TEST_LOCK_HELD:?}"\' EXIT',
    '"$@"',
  ]);
  writeExecutable(path.join(scripts, 'cloud_order_closure.sh'), [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    'set +e',
    'node scripts/recheck_order_statuses.mjs --max-pairs "${SHEIN_ORDER_CLOSURE_MAX_PAIRS:-30}"',
    'status=$?',
    'set -e',
    'STATUS="$status" OUTCOME_FILE="${SHEIN_ORDER_CLOSURE_OUTCOME_FILE:?}" FAILED_FILE="${SHEIN_TEST_FAILED_PAIRS:?}" node --input-type=module - <<\'NODE\'',
    'import fs from "node:fs";',
    'import path from "node:path";',
    'const failed = JSON.parse(fs.readFileSync(process.env.FAILED_FILE, "utf8"));',
    'const payload = {qualityStatus: failed.length ? "partial" : "complete", ok: Number(process.env.STATUS) === 0, finishedAt: new Date().toISOString()};',
    'fs.mkdirSync(path.dirname(process.env.OUTCOME_FILE), {recursive: true});',
    'fs.writeFileSync(process.env.OUTCOME_FILE, JSON.stringify(payload) + "\\n");',
    'NODE',
    'if [[ "$status" -ne 0 ]]; then exit "$status"; fi',
    'printf \'portal-refresh\\n\' >> "${SHEIN_TEST_PORTAL_LOG:?}"',
    'printf \'enqueue\\n\' >> "${SHEIN_TEST_QUEUE_LOG:?}"',
    'sleep 0.15',
  ]);
  writeExecutable(path.join(scripts, 'recheck_order_statuses.mjs'), [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    "import {createHash} from 'node:crypto';",
    "const value = name => { const i=process.argv.indexOf(name); return i >= 0 ? process.argv[i+1] : ''; };",
    "const maxPairs = Math.max(1, Number(value('--max-pairs') || 500));",
    "if (process.env.SHEIN_TEST_LOCK_HELD && !fs.existsSync(process.env.SHEIN_TEST_LOCK_HELD)) { console.error('work outside domain lock'); process.exit(70); }",
    "const rows = JSON.parse(fs.readFileSync(process.env.SHEIN_TEST_CANDIDATES, 'utf8'));",
    "const key = row => `${String(row.createdDate||'')}|${String(row.storeKey||'').toUpperCase()}`;",
    "const pairMap = new Map(); for (const row of rows) pairMap.set(key(row), (pairMap.get(key(row)) || 0) + 1);",
    "const pairs = [...pairMap].map(([pairKey,count]) => ({pairKey,count})).sort((a,b) => { const [ad,as]=a.pairKey.split('|'); const [bd,bs]=b.pairKey.split('|'); return ad < bd ? -1 : ad > bd ? 1 : b.count-a.count || (as < bs ? -1 : as > bs ? 1 : 0); });",
    "const selected = pairs.slice(0, maxPairs);",
    "const forcedPairCount = /^\\d+$/.test(process.env.SHEIN_TEST_FORCED_PAIR_COUNT || '') ? Number(process.env.SHEIN_TEST_FORCED_PAIR_COUNT) : null;",
    "const normalized = rows.map(row => ({storeKey:String(row.storeKey||'').toUpperCase(),createdDate:String(row.createdDate||''),orderItemKey:String(row.orderItemKey||''),lastCheckedAt:row.lastCheckedAt == null ? null : String(row.lastCheckedAt)})).sort((a,b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);",
    "const worksetDigest = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');",
    "if (process.argv.includes('--candidate-digest')) { console.log(JSON.stringify({ok:true,mode:'candidate-digest',worksetDigest,candidateCount:normalized.length,pairCount:forcedPairCount ?? selected.length})); process.exit(0); }",
    "const failed = fs.existsSync(process.env.SHEIN_TEST_FAILED_PAIRS) ? new Set(JSON.parse(fs.readFileSync(process.env.SHEIN_TEST_FAILED_PAIRS, 'utf8'))) : new Set();",
    "const selectedKeys = new Set(selected.map(pair => pair.pairKey));",
    "const succeededKeys = new Set([...selectedKeys].filter(pairKey => !failed.has(pairKey)));",
    "const remaining = rows.filter(row => !succeededKeys.has(key(row)));",
    "const temporary = `${process.env.SHEIN_TEST_CANDIDATES}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(remaining,null,2)}\\n`); fs.renameSync(temporary, process.env.SHEIN_TEST_CANDIDATES);",
    "fs.appendFileSync(process.env.SHEIN_TEST_RECHECK_LOG, `${JSON.stringify({selected:[...selectedKeys],succeeded:[...succeededKeys],failed:[...selectedKeys].filter(pairKey=>failed.has(pairKey))})}\\n`);",
    "const failedCount = [...selectedKeys].filter(pairKey => failed.has(pairKey)).length; const succeededCount = succeededKeys.size;",
    "const qualityStatus = failedCount && succeededCount ? 'partial' : failedCount ? 'failed' : 'complete';",
    "console.log(JSON.stringify({ok:failedCount===0 || succeededCount>0,qualityStatus,selectedPairs:selectedKeys.size,succeededPairs:succeededCount,failedPairs:failedCount}));",
    "if (failedCount && !succeededCount) process.exitCode = 1;",
  ]);
}

function makeFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  installFixture(root);
  const paths = fixturePaths(root);
  writeJson(paths.candidates, []);
  writeJson(paths.failures, []);
  return {root, paths};
}

function installSuccessfulStageStub(root) {
  writeExecutable(path.join(root, 'scripts', 'run_pipeline_stage.sh'), [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    'exit 0',
  ]);
}

function assertDoneMarker(marker) {
  assert.equal(marker?.schema, PIPELINE_MARKER_SCHEMA);
  assert.equal(marker?.status, 'done');
  assert.equal(marker?.ok, true);
  assert.equal(marker?.worksetCandidateCount, 0);
  assert.equal(marker?.worksetPairCount, 0);
}

async function main() {
  assert.equal(spawnSync('bash', ['--version'], {encoding: 'utf8'}).error, undefined,
    'order idempotency regression requires bash');
  const futureDeadline = () => Math.floor(Date.now() / 1_000) + 120;
  const rowA = {storeKey: 'DL', createdDate: '2026-08-01', orderItemKey: 'item-1', lastCheckedAt: null};
  const rowB = {storeKey: 'FY', createdDate: '2026-08-02', orderItemKey: 'item-2', lastCheckedAt: null};

  const digestOne = computeCandidateWorksetDigest([rowA]);
  assert.notEqual(computeCandidateWorksetDigest([rowA, rowB]), digestOne, 'new candidate must change digest');
  assert.notEqual(computeCandidateWorksetDigest([{...rowA, lastCheckedAt: '2026-08-22T01:02:03.000000Z'}]), digestOne,
    'last_checked_at must change digest');
  const fingerprint = computeWorkFingerprint({
    scope: SCOPE, semanticVersion: SEMANTIC_VERSION,
    parameters: {maxPairs: '1', transport: 'openapi'}, worksetDigest: digestOne,
  });
  assert.equal(fingerprint, computeWorkFingerprint({
    scope: SCOPE, semanticVersion: SEMANTIC_VERSION,
    parameters: {transport: 'openapi', maxPairs: '1'}, worksetDigest: digestOne,
  }));
  assert.notEqual(fingerprint, computeWorkFingerprint({
    scope: SCOPE, semanticVersion: SEMANTIC_VERSION,
    parameters: {maxPairs: '2', transport: 'openapi'}, worksetDigest: digestOne,
  }));
  const emptyFixtureDigest = createHash('sha256').update(JSON.stringify([])).digest('hex');
  const zeroOneFingerprint = computeWorkFingerprint({
    scope: SCOPE,
    semanticVersion: SEMANTIC_VERSION,
    parameters: {maxPairs: '1', transport: 'openapi'},
    worksetDigest: emptyFixtureDigest,
  });
  await assert.rejects(writeMarker({
    root: path.join(os.tmpdir(), 'must-not-write-nonempty-order-done'),
    stage: STAGE,
    date: RUN_DATE,
    businessDate: BUSINESS_DATE,
    status: 'done',
    workFingerprint: zeroOneFingerprint,
    workFingerprintScope: SCOPE,
    workSemanticVersion: SEMANTIC_VERSION,
    workParameters: {maxPairs: '1', transport: 'openapi'},
    worksetDigest: emptyFixtureDigest,
    worksetCandidateCount: 0,
    worksetPairCount: 1,
  }), /PIPELINE_MARKER_DONE_WORKSET_NOT_EMPTY/);
  const sql = candidateSnapshotSql({maxPairs: 1, minAgeDays: 2, cooldownHours: 20});
  for (const field of ['store_key', 'created_date', 'order_item_key', 'last_checked_at']) assert.match(sql, new RegExp(field));
  assert.match(sql, /candidate_workset/);
  const coordinatorSource = fs.readFileSync(path.join(ROOT, 'scripts', 'cloud_order_closure_coordinator.sh'), 'utf8');
  assert.match(coordinatorSource, /late candidates remain unclaimed for the next authorized activation/);
  assert.doesNotMatch(coordinatorSource, /--implementation|--queue-dependency/);
  assert.match(coordinatorSource, /pipeline_marker\.mjs.*STAGE_OUTCOME_ARGS/,
    'coordinator must consume central marker outcome validation');
  assert.doesNotMatch(coordinatorSource, /pipeline_marker\.mjs" read/,
    'coordinator must not classify a raw marker read');
  assert.match(coordinatorSource, /export SHEIN_ORDER_CLOSURE_MAX_PAIRS="\$MAX_PAIRS"/,
    'coordinator must export SHEIN_ORDER_CLOSURE_MAX_PAIRS for child stage and digest parity');

  const fixtures = [];
  try {
    const intrinsic = makeFixture('shein-order-intrinsic-marker-');
    fixtures.push(intrinsic.root);
    const intrinsicParameters = coordinatorWorkParameters(500);
    const buildIntrinsicMarker = ({
      semanticVersion = SEMANTIC_VERSION,
      candidateCount = 0,
      pairCount = 0,
      status = 'done',
    } = {}) => ({
      schema: PIPELINE_MARKER_SCHEMA,
      schemaVersion: PIPELINE_MARKER_SCHEMA,
      ok: ['done', 'warning'].includes(status),
      stage: STAGE,
      status,
      runDate: RUN_DATE,
      businessDate: BUSINESS_DATE,
      completedAt: new Date().toISOString(),
      message: 'plain require intrinsic marker fixture',
      evidence: [],
      workFingerprint: computeWorkFingerprint({
        scope: SCOPE,
        semanticVersion,
        parameters: intrinsicParameters,
        worksetDigest: emptyFixtureDigest,
      }),
      workFingerprintScope: SCOPE,
      workSemanticVersion: semanticVersion,
      workParameters: intrinsicParameters,
      worksetDigest: emptyFixtureDigest,
      worksetCandidateCount: candidateCount,
      worksetPairCount: pairCount,
    });
    const plainRequire = async (marker, statuses = ['done']) => {
      writeJson(markerPath(intrinsic.paths.markerRoot, RUN_DATE, STAGE), marker);
      return requireMarker({root: intrinsic.paths.markerRoot, stage: STAGE, date: RUN_DATE, statuses});
    };
    assert.equal((await plainRequire(buildIntrinsicMarker())).ok, true,
      'valid numeric zero/zero order marker must pass plain require');
    let plainResult = await plainRequire(buildIntrinsicMarker({candidateCount: 0, pairCount: 1}));
    assert.equal(plainResult.ok, false);
    assert.equal(plainResult.reason, 'marker_done_workset_not_empty');
    plainResult = await plainRequire(buildIntrinsicMarker({candidateCount: '0', pairCount: 0}));
    assert.equal(plainResult.reason, 'marker_workset_candidate_count_invalid');
    plainResult = await plainRequire(buildIntrinsicMarker({candidateCount: null, pairCount: 0}));
    assert.equal(plainResult.reason, 'marker_workset_candidate_count_invalid');
    const missingPairCount = buildIntrinsicMarker();
    delete missingPairCount.worksetPairCount;
    plainResult = await plainRequire(missingPairCount);
    assert.equal(plainResult.reason, 'marker_workset_pair_count_invalid');
    plainResult = await plainRequire(buildIntrinsicMarker({
      semanticVersion: 'order-closure/v4-empty-done-candidates-v1-portal-queue-v1',
    }));
    assert.equal(plainResult.reason, 'marker_order_semantic_version_stale');
    plainResult = await plainRequire(buildIntrinsicMarker({status: 'partial'}), ['partial']);
    assert.equal(plainResult.reason, 'marker_partial_workset_empty');

    const adversarialCases = [
      {
        name: 'fabricated-fingerprint-missing-schema-work-parameters',
        build() {
          const marker = buildIntrinsicMarker();
          delete marker.schema;
          delete marker.schemaVersion;
          delete marker.workParameters;
          marker.workFingerprint = 'f'.repeat(64);
          return marker;
        },
      },
      {
        name: 'partial-zero-zero',
        build: () => buildIntrinsicMarker({status: 'partial'}),
      },
      {
        name: 'done-zero-one',
        build: () => buildIntrinsicMarker({candidateCount: 0, pairCount: 1}),
      },
      {
        name: 'failed-positive-workset',
        build: () => buildIntrinsicMarker({status: 'failed', candidateCount: 1, pairCount: 1}),
      },
      {
        name: 'fingerprint-mismatch',
        build() {
          const marker = buildIntrinsicMarker();
          marker.workFingerprint = 'f'.repeat(64);
          return marker;
        },
      },
      {
        name: 'old-semantic-version',
        build: () => buildIntrinsicMarker({
          semanticVersion: 'order-closure/v4-empty-done-candidates-v1-portal-queue-v1',
        }),
      },
    ];
    for (const adversarial of adversarialCases) {
      const fixture = makeFixture(`shein-order-outcome-${adversarial.name}-`);
      fixtures.push(fixture.root);
      installSuccessfulStageStub(fixture.root);
      writeJson(markerPath(fixture.paths.markerRoot, RUN_DATE, STAGE), adversarial.build());
      const result = await runCoordinator({...fixture, deadlineEpoch: futureDeadline()});
      assert.notEqual(result.status, 0,
        `${adversarial.name} must fail coordinator\n${result.stdout}\n${result.stderr}`);
      const state = readCoordinatorState(fixture.root);
      assert.equal(state.status, 'failed', `${adversarial.name} must write failed coordinator state`);
      assert.equal(state.ok, false, `${adversarial.name} failed state must not be ok`);
      assert.notEqual(state.status, 'done');
      assert.notEqual(state.status, 'partial');
    }

    const concurrency = makeFixture('shein-order-concurrency-');
    fixtures.push(concurrency.root);
    writeJson(concurrency.paths.candidates, [rowA]);
    const first = runCoordinator({...concurrency, deadlineEpoch: futureDeadline()});
    await delay(30);
    const second = runCoordinator({...concurrency, deadlineEpoch: futureDeadline()});
    const concurrentResults = await Promise.all([first, second]);
    for (const result of concurrentResults) assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readLines(concurrency.paths.recheck).length, 1, 'domain lock must allow exactly one execution');
    assert.equal(readLines(concurrency.paths.portal).length, 1, 'skip must not refresh Portal');
    assert.equal(readLines(concurrency.paths.queue).length, 1, 'skip must not enqueue');
    assertDoneMarker(readMarker({root: concurrency.paths.markerRoot, stage: STAGE, date: RUN_DATE}));
    fs.appendFileSync(path.join(concurrency.root, 'scripts', 'cloud_order_closure_coordinator.sh'), '\n# unrelated comment\n');
    const unchanged = await runCoordinator({...concurrency, deadlineEpoch: futureDeadline()});
    assert.equal(unchanged.status, 0, `${unchanged.stdout}\n${unchanged.stderr}`);
    assert.equal(readLines(concurrency.paths.recheck).length, 1, 'empty unchanged workset and comments must skip');
    writeJson(concurrency.paths.candidates, [rowB]);
    const newCandidate = await runCoordinator({...concurrency, deadlineEpoch: futureDeadline()});
    assert.equal(newCandidate.status, 0, `${newCandidate.stdout}\n${newCandidate.stderr}`);
    assert.equal(readLines(concurrency.paths.recheck).length, 2, 'new candidate after done must execute');

    const bounded = makeFixture('shein-order-maxpairs-');
    fixtures.push(bounded.root);
    writeJson(bounded.paths.candidates, [rowA, rowB]);
    const boundedFirst = await runCoordinator({...bounded, maxPairs: 1, deadlineEpoch: futureDeadline()});
    assert.equal(boundedFirst.status, 0, `${boundedFirst.stdout}\n${boundedFirst.stderr}`);
    let marker = readMarker({root: bounded.paths.markerRoot, stage: STAGE, date: RUN_DATE});
    assertDoneMarker(marker);
    assert.equal(readJson(bounded.paths.candidates).length, 0, 'same activation must continue bounded batches to completion');
    let coordinatorState = readCoordinatorState(bounded.root);
    assert.equal(coordinatorState.status, 'done', 'same activation must finish all bounded batches');
    assert.equal(coordinatorState.ok, true);
    const boundedSecond = await runCoordinator({...bounded, maxPairs: 1, deadlineEpoch: futureDeadline()});
    assert.equal(boundedSecond.status, 0, `${boundedSecond.stdout}\n${boundedSecond.stderr}`);
    assertDoneMarker(readMarker({root: bounded.paths.markerRoot, stage: STAGE, date: RUN_DATE}));
    coordinatorState = readCoordinatorState(bounded.root);
    assert.equal(coordinatorState.status, 'done', 'zero workset must promote coordinator state to done');
    assert.equal(coordinatorState.ok, true, 'zero workset done coordinator state must be ok');
    assert.equal(readLines(bounded.paths.recheck).length, 2, 'two pairs with maxPairs=1 require two executions');
    const boundedThird = await runCoordinator({...bounded, maxPairs: 1, deadlineEpoch: futureDeadline()});
    assert.equal(boundedThird.status, 0, `${boundedThird.stdout}\n${boundedThird.stderr}`);
    assert.equal(readLines(bounded.paths.recheck).length, 2, 'third unchanged activation must skip');

    const partial = makeFixture('shein-order-partial-');
    fixtures.push(partial.root);
    writeJson(partial.paths.candidates, [rowA, rowB]);
    writeJson(partial.paths.failures, ['2026-08-02|FY']);
    const partialFirst = await runCoordinator({...partial, maxPairs: 2, deadlineEpoch: futureDeadline()});
    assert.equal(partialFirst.status, 0, `${partialFirst.stdout}\n${partialFirst.stderr}`);
    assert.match(partialFirst.stdout, /"qualityStatus":"partial"/);
    marker = readMarker({root: partial.paths.markerRoot, stage: STAGE, date: RUN_DATE});
    assert.equal(marker?.status, 'partial', 'status 0 quality partial must not write done');
    assert.equal(marker?.worksetCandidateCount, 1);
    assert.equal(readJson(partial.paths.candidates)[0].orderItemKey, 'item-2');
    coordinatorState = readCoordinatorState(partial.root);
    assert.equal(coordinatorState.status, 'partial', 'mixed failure coordinator state must be partial');
    assert.equal(coordinatorState.ok, false, 'mixed failure coordinator state must be incomplete');
    assert.match(coordinatorState.message, /remainingCandidates=1/);
    writeJson(partial.paths.failures, []);
    const partialSecond = await runCoordinator({...partial, maxPairs: 2, deadlineEpoch: futureDeadline()});
    assert.equal(partialSecond.status, 0, `${partialSecond.stdout}\n${partialSecond.stderr}`);
    assertDoneMarker(readMarker({root: partial.paths.markerRoot, stage: STAGE, date: RUN_DATE}));
    coordinatorState = readCoordinatorState(partial.root);
    assert.equal(coordinatorState.status, 'done', 'mixed failure final zero workset must become done');
    assert.equal(coordinatorState.ok, true);
    assert.equal(readLines(partial.paths.recheck).length, 2, 'failed pair must execute on the next activation');

    const zeroOne = makeFixture('shein-order-zero-one-');
    fixtures.push(zeroOne.root);
    const zeroOneParameters = coordinatorWorkParameters(500);
    const malformedFingerprint = computeWorkFingerprint({
      scope: SCOPE,
      semanticVersion: SEMANTIC_VERSION,
      parameters: zeroOneParameters,
      worksetDigest: emptyFixtureDigest,
    });
    writeJson(markerPath(zeroOne.paths.markerRoot, RUN_DATE, STAGE), {
      schema: PIPELINE_MARKER_SCHEMA,
      schemaVersion: PIPELINE_MARKER_SCHEMA,
      ok: true,
      stage: STAGE,
      status: 'done',
      runDate: RUN_DATE,
      businessDate: BUSINESS_DATE,
      completedAt: new Date().toISOString(),
      message: 'malformed zero-candidate one-pair done fixture',
      evidence: [],
      workFingerprint: malformedFingerprint,
      workFingerprintScope: SCOPE,
      workSemanticVersion: SEMANTIC_VERSION,
      workParameters: zeroOneParameters,
      worksetDigest: emptyFixtureDigest,
      worksetCandidateCount: 0,
      worksetPairCount: 1,
    });
    const malformedRequired = await requireMarker({
      root: zeroOne.paths.markerRoot,
      stage: STAGE,
      date: RUN_DATE,
      businessDate: BUSINESS_DATE,
      statuses: ['done'],
      workFingerprint: malformedFingerprint,
      workFingerprintScope: SCOPE,
      workSemanticVersion: SEMANTIC_VERSION,
      workParameters: zeroOneParameters,
      worksetDigest: emptyFixtureDigest,
      worksetCandidateCount: 0,
      worksetPairCount: 1,
      requireOk: true,
    });
    assert.equal(malformedRequired.ok, false, 'zero/one done marker must not be reusable through marker API');
    assert.equal(malformedRequired.reason, 'marker_done_workset_not_empty');
    const zeroOneRun = await runCoordinator({
      ...zeroOne,
      forcedPairCount: 1,
      deadlineEpoch: futureDeadline(),
    });
    assert.equal(zeroOneRun.status, 0, `${zeroOneRun.stdout}\n${zeroOneRun.stderr}`);
    assert.equal(readLines(zeroOne.paths.recheck).length, 1, 'stage must execute instead of reusing malformed zero/one done marker');
    marker = readMarker({root: zeroOne.paths.markerRoot, stage: STAGE, date: RUN_DATE});
    assert.equal(marker?.status, 'partial', 'post zero/one workset must write partial');
    assert.equal(marker?.worksetCandidateCount, 0);
    assert.equal(marker?.worksetPairCount, 1);
    coordinatorState = readCoordinatorState(zeroOne.root);
    assert.equal(coordinatorState.status, 'partial', 'coordinator must not report done for zero/one workset');
    assert.equal(coordinatorState.ok, false);

    const deadline = makeFixture('shein-order-deadline-');
    fixtures.push(deadline.root);
    const onTime = await runCoordinator({...deadline, deadlineEpoch: futureDeadline()});
    assert.equal(onTime.status, 0, `${onTime.stdout}\n${onTime.stderr}`);
    const sameDayMarkerFile = markerPath(deadline.paths.markerRoot, RUN_DATE, STAGE);
    const markerBeforeLateCandidate = fs.readFileSync(sameDayMarkerFile, 'utf8');
    writeJson(deadline.paths.candidates, [rowA]);
    const late = await runCoordinator({...deadline, deadlineEpoch: Math.floor(Date.now() / 1_000) - 1});
    assert.notEqual(late.status, 0, 'post-deadline activation must fail/stop');
    assert.match(`${late.stdout}\n${late.stderr}`, /late candidates remain unclaimed/);
    assert.equal(readLines(deadline.paths.recheck).length, 1, 'deadline stop must not enter a second heavy run');
    assert.equal(readJson(deadline.paths.candidates).length, 1, 'late candidate must remain actionable');
    assert.equal(fs.readFileSync(sameDayMarkerFile, 'utf8'), markerBeforeLateCandidate,
      'deadline stop must not rewrite the earlier empty done marker to claim a late candidate');
    const nextAuthorized = await runCoordinator({
      ...deadline,
      runDate: '2026-08-23',
      businessDate: '2026-08-22',
      deadlineEpoch: futureDeadline(),
    });
    assert.equal(nextAuthorized.status, 0, `${nextAuthorized.stdout}\n${nextAuthorized.stderr}`);
    assert.equal(readLines(deadline.paths.recheck).length, 2, 'next authorized activation must process late candidate');
    assertDoneMarker(readMarker({root: deadline.paths.markerRoot, stage: STAGE, date: '2026-08-23'}));

    const compatibility = makeFixture('shein-order-compatibility-');
    fixtures.push(compatibility.root);
    const legacyDate = '2026-08-24';
    const legacyBusinessDate = '2026-08-23';
    writeJson(markerPath(compatibility.paths.markerRoot, legacyDate, STAGE), {
      ok: true, stage: STAGE, status: 'done', runDate: legacyDate,
      businessDate: legacyBusinessDate, completedAt: new Date().toISOString(),
    });
    const effect = path.join(compatibility.root, 'effect.log');
    const upgrade = runStage({
      root: compatibility.root, paths: compatibility.paths, runDate: legacyDate,
      businessDate: legacyBusinessDate, sideEffect: effect, sourceCommit: 'audit-one',
    });
    assert.equal(upgrade.status, 0, `${upgrade.stdout}\n${upgrade.stderr}`);
    assert.equal(readLines(effect).length, 1, 'legacy marker must execute once');
    assertDoneMarker(readMarker({root: compatibility.paths.markerRoot, stage: STAGE, date: legacyDate}));
    const auditOnly = runStage({
      root: compatibility.root, paths: compatibility.paths, runDate: legacyDate,
      businessDate: legacyBusinessDate, sideEffect: effect, sourceCommit: 'audit-two',
    });
    assert.equal(auditOnly.status, 0, `${auditOnly.stdout}\n${auditOnly.stderr}`);
    assert.equal(readLines(effect).length, 1, 'sourceCommit change must not execute');
    assert.equal(fs.existsSync(path.join(compatibility.root, 'state', 'pipeline-markers', legacyDate, `${STAGE}.json`)), false,
      'custom marker root must be honored');

    const runDateDependency = makeFixture('shein-run-date-dependency-');
    fixtures.push(runDateDependency.root);
    const dependencyRunDate = '2026-08-31';
    const dependencyBusinessDate = '2026-08-31';
    const dependentBusinessDate = '2026-08-30';
    const dependencyStage = 'nightly-backup';
    writeJson(markerPath(runDateDependency.paths.markerRoot, dependencyRunDate, dependencyStage), {
      ok: true, stage: dependencyStage, status: 'done', runDate: dependencyRunDate,
      businessDate: dependencyBusinessDate, completedAt: new Date().toISOString(),
    });
    const runDateDependencyEffect = path.join(runDateDependency.root, 'effect.log');
    const strictBusinessDateDependency = runStage({
      root: runDateDependency.root, paths: runDateDependency.paths,
      runDate: dependencyRunDate, businessDate: dependentBusinessDate,
      sideEffect: runDateDependencyEffect, sourceCommit: 'dependency-audit-one', stage: 'yesterday-final',
      extraArgs: ['--require', dependencyStage],
      includeStageIdentity: false,
    });
    assert.equal(strictBusinessDateDependency.status, 75,
      `plain --require must reject businessDate mismatch\n${strictBusinessDateDependency.stdout}\n${strictBusinessDateDependency.stderr}`);
    assert.equal(readLines(runDateDependencyEffect).length, 0,
      'plain --require businessDate mismatch must not execute command');
    const runDateOnlyDependency = runStage({
      root: runDateDependency.root, paths: runDateDependency.paths,
      runDate: dependencyRunDate, businessDate: dependentBusinessDate,
      sideEffect: runDateDependencyEffect, sourceCommit: 'dependency-audit-two', stage: 'yesterday-final',
      extraArgs: ['--require-run-date', dependencyStage],
      includeStageIdentity: false,
    });
    assert.equal(runDateOnlyDependency.status, 0,
      `--require-run-date must accept same runDate with different businessDate\n${runDateOnlyDependency.stdout}\n${runDateOnlyDependency.stderr}`);
    assert.equal(readLines(runDateDependencyEffect).length, 1,
      '--require-run-date must execute command when dependency is done for the same runDate');
    writeJson(markerPath(runDateDependency.paths.markerRoot, dependencyRunDate, dependencyStage), {
      ok: false, stage: dependencyStage, status: 'deferred', runDate: dependencyRunDate,
      businessDate: dependencyBusinessDate, completedAt: new Date().toISOString(),
    });
    const notDoneDependency = runStage({
      root: runDateDependency.root, paths: runDateDependency.paths,
      runDate: dependencyRunDate, businessDate: dependentBusinessDate,
      sideEffect: runDateDependencyEffect, sourceCommit: 'dependency-audit-three', stage: 'yesterday-final',
      extraArgs: ['--require-run-date', dependencyStage],
      includeStageIdentity: false,
    });
    assert.equal(notDoneDependency.status, 75,
      `--require-run-date must defer when dependency is not done/warning\n${notDoneDependency.stdout}\n${notDoneDependency.stderr}`);
    assert.equal(readLines(runDateDependencyEffect).length, 1,
      'not-ready run-date dependency must not execute command');
    fs.rmSync(markerPath(runDateDependency.paths.markerRoot, dependencyRunDate, dependencyStage), {force: true});
    const missingDependency = runStage({
      root: runDateDependency.root, paths: runDateDependency.paths,
      runDate: dependencyRunDate, businessDate: dependentBusinessDate,
      sideEffect: runDateDependencyEffect, sourceCommit: 'dependency-audit-four', stage: 'yesterday-final',
      extraArgs: ['--require-run-date', dependencyStage],
      includeStageIdentity: false,
    });
    assert.equal(missingDependency.status, 75,
      `--require-run-date must defer when dependency marker is missing\n${missingDependency.stdout}\n${missingDependency.stderr}`);
    assert.equal(readLines(runDateDependencyEffect).length, 1,
      'missing run-date dependency must not execute command');
  } finally {
    for (const root of fixtures) fs.rmSync(root, {recursive: true, force: true});
  }

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'locked-concurrency', 'skip-no-side-effects', 'new-candidate-after-done',
      'plain-require-intrinsic-structured-validation',
      'coordinator-central-outcome-adversarial-rejection',
      'maxPairs-one-two-pair-consecutive-runs', 'status-zero-quality-partial-retry',
      'zero-candidate-one-pair-rejected-everywhere',
      'deadline-stop-next-authorized-activation', 'legacy-upgrade', 'sourceCommit-audit-only',
      'custom-marker-root', 'run-date-dependency-business-date-mismatch',
    ],
  }, null, 2));
}

main().catch(error => {
  console.error(String(error?.stack || error));
  process.exitCode = 1;
});
