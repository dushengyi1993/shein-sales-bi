#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
  MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
  publishMarketingPlanRegistry,
  validateMarketingPlanPairDocuments,
} from '../lib/marketing_plan_registry.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const date = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const stores = Array.from({length: 19}, (_, index) => `S${String(index + 1).padStart(2, '0')}`);
const fixtureRoot = fs.mkdtempSync(path.join(repoRoot, 'tmp', `marketing-repair-worker-registry-${process.pid}-`));
const stateDir = path.join(fixtureRoot, 'state', 'cloud_marketing_live_guard');
const registryRoot = path.join(fixtureRoot, 'runtime', 'marketing-plans');
const registryFile = path.join(registryRoot, 'current.json');
const registryBPointer = path.join(fixtureRoot, 'source', 'current-b.json');
const storesConfig = path.join(fixtureRoot, 'config', 'stores.json');
const costMapPath = path.join(fixtureRoot, 'tmp', 'mbrs', 'marketing-cost-map.json');
const guardPath = path.join(fixtureRoot, 'outputs', 'reports', `marketing-daily-guard-${date}.json`);
const workerPath = path.join(fixtureRoot, 'scripts', 'cloud_marketing_repair_worker.sh');
const queuePath = path.join(stateDir, 'repair-queues', `marketing-repair-${date}.json`);
const binDir = path.join(fixtureRoot, 'bin');
const executorMarker = path.join(fixtureRoot, 'executor.marker');
const managerMarker = path.join(fixtureRoot, 'queue-manager.marker');
const registryPublishAttemptMarker = path.join(fixtureRoot, 'registry-publish-attempt.marker');
const queuePublishAttemptMarker = path.join(fixtureRoot, 'queue-publish-attempt.marker');
const leaseActionMarker = path.join(fixtureRoot, 'lease-actions.ndjson');
const resultPath = path.join(fixtureRoot, 'outputs', 'reports', `new-listing-7d-limited-discount-execution-summary-${date}.json`);

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, content, 'utf8');
  fs.chmodSync(file, 0o755);
}

function toBashPath(file) {
  const normalized = path.resolve(file).replaceAll('\\', '/');
  if (normalized.startsWith('/')) return normalized;
  return `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
}

function bashQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function rows(label, priceOffset = 0) {
  return stores.map((storeKey, index) => ({
    storeKey,
    activityId: 79000,
    skc: `repair-worker-${label}-${String(index).padStart(3, '0')}`,
    targetPrice: 25 + priceOffset + index / 100,
    finalTargetPrice: 25 + priceOffset + index / 100,
    cost: 10,
    storageUnitCostSar: 0.5,
    selected: true,
  }));
}

function writePair(sourceDir, label, priceOffset) {
  const selectionPath = path.join(sourceDir, `${label}-selection.json`);
  const pricesPath = path.join(sourceDir, `${label}-prices.json`);
  const selectionRows = rows(label, priceOffset);
  const pricesRows = selectionRows.map(row => ({...row}));
  const validated = validateMarketingPlanPairDocuments({
    selection: {items: selectionRows},
    prices: {items: pricesRows},
    requireCurrentBaseline: false,
    expectedStoreCount: 19,
    expectedStoreKeys: stores,
  });
  const metadata = {
    status: 'current_baseline',
    supersededBy: null,
    activityBatch: `repair-worker-${label}`,
    promotedAt: '2026-08-24T01:02:03.000Z',
    selectionPayloadHash: validated.selectionPayloadHash,
    pricePayloadHash: validated.pricePayloadHash,
    workFingerprint: validated.workFingerprint,
  };
  const decorate = items => ({
    items,
    baselineForNextOrdinaryActivity: true,
    baselineForLimitedDiscountFallback: true,
    executionStatus: 'completed',
    planMetadata: metadata,
  });
  writeJson(selectionPath, decorate(selectionRows));
  writeJson(pricesPath, decorate(pricesRows));
  return {selectionPath, pricesPath};
}

async function publishPair(pair, baselineId) {
  return publishMarketingPlanRegistry({
    selectionPath: pair.selectionPath,
    priceOverridesPath: pair.pricesPath,
    expectedSelectionSha256: sha256File(pair.selectionPath),
    expectedPriceOverridesSha256: sha256File(pair.pricesPath),
    registryRoot,
    registryFile,
    baselineId,
    confirm: MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
    expectedStoreKeys: stores,
  });
}

function writeGuard(registryHash, priceOverrides, priceOverridesHash) {
  writeJson(guardPath, {
    schemaVersion: 1,
    mode: 'read-only',
    reportDate: date,
    targetPlanSelection: {
      strategy: 'registry_current_baseline',
      selectionSource: 'durable_current_baseline_registry',
      registryHash,
      priceOverrides: toBashPath(priceOverrides),
      priceOverridesHash,
    },
    marketingCostMapSource: {
      path: toBashPath(costMapPath),
      sha256: sha256File(costMapPath),
      expectedSha256: sha256File(costMapPath),
      verified: true,
    },
  });
  fs.writeFileSync(guardPath.replace(/\.json$/, '.md'), '# fixture guard\n', 'utf8');
}

function writeQueue() {
  const sourceGuard = path.relative(fixtureRoot, guardPath).replaceAll(path.sep, '/');
  writeJson(queuePath, {
    schemaVersion: 1,
    date,
    status: 'pending',
    sourceGuard,
    sourceGuardHash: sha256File(guardPath),
    queueFingerprint: sha256Text('queue-fixture'),
    counts: {totalRows: 1, totalGroups: 1},
    stages: {
      highClickSpecial: {status: 'not_required'},
      manualSpecialRestore: {status: 'not_required'},
      driftRepair: {status: 'not_required'},
      fallbackRepair: {
        status: 'pending',
        rows: 1,
        groups: 1,
        workFingerprint: sha256Text('fallback-work'),
      },
    },
  });
}

function installFixtureScripts() {
  fs.mkdirSync(path.dirname(workerPath), {recursive: true});
  fs.mkdirSync(path.join(fixtureRoot, 'scripts', 'lib'), {recursive: true});
  fs.mkdirSync(path.join(fixtureRoot, 'lib'), {recursive: true});
  const workerSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'cloud_marketing_repair_worker.sh'), 'utf8');
  assert.doesNotMatch(workerSource, /while\s+sleep\s+"?\$LEASE_HEARTBEAT_INTERVAL_SEC/,
    'heartbeat timer must not spawn an external sleep that can inherit worker output pipes');
  fs.writeFileSync(workerPath, workerSource, 'utf8');
  writeExecutable(path.join(fixtureRoot, 'scripts', 'lib', 'shared_lock.sh'), [
    '#!/usr/bin/env bash',
    'prepare_shared_lock_file() { mkdir -p "$(dirname -- "$1")"; touch -- "$1"; }',
    '',
  ].join('\n'));
  fs.copyFileSync(path.join(repoRoot, 'lib', 'marketing_plan_registry.mjs'), path.join(fixtureRoot, 'lib', 'marketing_plan_registry.mjs'));
  fs.copyFileSync(path.join(repoRoot, 'lib', 'atomic_file_publish.mjs'), path.join(fixtureRoot, 'lib', 'atomic_file_publish.mjs'));
  writeJson(storesConfig, {stores: stores.map(storeKey => ({storeKey}))});
  writeExecutable(path.join(binDir, 'systemctl'), '#!/usr/bin/env bash\nexit 1\n');
  writeExecutable(path.join(fixtureRoot, 'scripts', 'manage_browser_task_leases.mjs'), [
    "import fs from 'node:fs';",
    "const action = process.argv[2] || '';",
    "if (process.env.SHEIN_TEST_LEASE_ACTION_MARKER) fs.appendFileSync(process.env.SHEIN_TEST_LEASE_ACTION_MARKER, `${JSON.stringify({action, at: Date.now()})}\\n`);",
    'process.exit(0);',
    '',
  ].join('\n'));
  writeExecutable(path.join(fixtureRoot, 'scripts', 'cleanup_shein_store_browsers.mjs'), 'process.exit(0);\n');
  writeExecutable(path.join(fixtureRoot, 'scripts', 'marketing', 'manage_marketing_repair_queue.mjs'), [
    "import crypto from 'node:crypto';",
    "import fs from 'node:fs';",
    "const argv = process.argv.slice(2);",
    "const value = name => argv[argv.indexOf(name) + 1] || '';",
    "const command = argv[0] || '';",
    "const queuePath = value('--queue');",
    "const lockPath = `${queuePath}.mutation.lock`;",
    "const lockToken = value('--queue-lock-token');",
    "const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');",
    "if (command === 'acquire-lock') { fs.mkdirSync(lockPath, {recursive: false}); fs.writeFileSync(`${lockPath}/owner`, `${lockToken}\\n`); process.stdout.write(JSON.stringify({ok: true})); process.exit(0); }",
    "if (command === 'release-lock') { if (fs.readFileSync(`${lockPath}/owner`, 'utf8').trim() !== lockToken) process.exit(75); fs.unlinkSync(`${lockPath}/owner`); fs.rmdirSync(lockPath); process.exit(0); }",
    "if (command !== 'update-stage') process.exit(2);",
    "const bytesBefore = fs.readFileSync(queuePath);",
    "if (hash(bytesBefore) !== value('--expected-queue-state-sha256')) process.exit(73);",
    "const queue = JSON.parse(bytesBefore.toString('utf8'));",
    "if (queue.queueFingerprint !== value('--expected-queue-fingerprint') || queue.sourceGuardHash !== value('--expected-source-guard-hash')) process.exit(73);",
    "queue.stages[value('--stage')].status = value('--status');",
    "queue.status = 'completed';",
    "const bytesAfter = Buffer.from(`${JSON.stringify(queue, null, 2)}\\n`);",
    "fs.writeFileSync(queuePath, bytesAfter);",
    "fs.appendFileSync(process.env.SHEIN_TEST_QUEUE_MANAGER_MARKER, 'update-stage\\n');",
    "process.stdout.write(JSON.stringify({ok: true, queueStateSha256: hash(bytesAfter), queueFingerprint: queue.queueFingerprint, sourceGuardHash: queue.sourceGuardHash}));",
    '',
  ].join('\n'));
  writeExecutable(path.join(fixtureRoot, 'scripts', 'marketing', 'batch_apply_new_listing_limited_discount.mjs'), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const blocked = (marker, lockPath) => { try { fs.mkdirSync(lockPath); fs.writeFileSync(`${lockPath}/unexpected`, 'replacement\\n'); fs.rmSync(lockPath, {recursive: true, force: false}); } catch (error) { if (error.code !== 'EEXIST') throw error; fs.appendFileSync(marker, 'blocked\\n'); } };",
    "blocked(process.env.SHEIN_TEST_REGISTRY_PUBLISH_ATTEMPT_MARKER, path.join(path.dirname(process.env.SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE), '.publish.lock'));",
    "blocked(process.env.SHEIN_TEST_QUEUE_PUBLISH_ATTEMPT_MARKER, `${process.env.SHEIN_TEST_QUEUE_PATH}.mutation.lock`);",
    "fs.appendFileSync(process.env.SHEIN_TEST_EXECUTOR_MARKER, 'executor\\n');",
    "if (process.env.SHEIN_TEST_SWITCH_REGISTRY_TO) fs.copyFileSync(process.env.SHEIN_TEST_SWITCH_REGISTRY_TO, process.env.SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE);",
    "fs.mkdirSync(path.dirname(process.env.SHEIN_TEST_RESULT_PATH), {recursive: true});",
    "fs.writeFileSync(process.env.SHEIN_TEST_RESULT_PATH, JSON.stringify({results: [{}], resumedGroups: 0, totals: {processedThisRun: 1}, blockedTargetCount: 0, failedTargetCount: 0}));",
    '',
  ].join('\n'));
}

function resetRuntime(pointerBytes, {missingRegistry = false} = {}) {
  fs.mkdirSync(path.dirname(registryFile), {recursive: true});
  if (missingRegistry) fs.rmSync(registryFile, {force: true});
  else fs.writeFileSync(registryFile, pointerBytes);
  fs.rmSync(executorMarker, {force: true});
  fs.rmSync(managerMarker, {force: true});
  fs.rmSync(registryPublishAttemptMarker, {force: true});
  fs.rmSync(queuePublishAttemptMarker, {force: true});
  fs.rmSync(`${queuePath}.mutation.lock`, {recursive: true, force: true});
  fs.rmSync(path.join(registryRoot, '.publish.lock'), {recursive: true, force: true});
  fs.rmSync(path.join(fixtureRoot, 'state', 'cloud_ops_alerts'), {recursive: true, force: true});
  fs.rmSync(resultPath, {force: true});
  fs.rmSync(leaseActionMarker, {force: true});
  writeQueue();
}

function runWorker({pointerBytes, missingRegistry = false, switchDuringExecutor = false, runId}) {
  resetRuntime(pointerBytes, {missingRegistry});
  const values = {
    SHEIN_BI_ROOT: toBashPath(fixtureRoot),
    SHEIN_BI_MARKETING_REPAIR_DATE: date,
    SHEIN_BI_MARKETING_REPAIR_RUN_ID: runId,
    SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION: 'local',
    SHEIN_BI_MARKETING_CLOUD_FALLBACK_ENABLED: 'false',
    SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS: '1',
    SHEIN_BI_MARKETING_REPAIR_LEASE_TTL_SEC: '10',
    SHEIN_BI_MARKETING_REPAIR_LEASE_HEARTBEAT_INTERVAL_SEC: '1',
    SHEIN_BI_MARKETING_REPAIR_BUSY_SERVICES: '',
    SHEIN_BI_MARKETING_LIVE_STATE_DIR: toBashPath(stateDir),
    SHEIN_BI_MARKETING_REPAIR_LOG_DIR: toBashPath(path.join(fixtureRoot, 'logs')),
    SHEIN_BI_MARKETING_REPAIR_LOCK_FILE: toBashPath(path.join(fixtureRoot, 'state', 'locks', 'repair.lock')),
    SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_FILE: toBashPath(path.join(fixtureRoot, 'state', 'locks', 'publication.lock')),
    SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_WAIT_SEC: '0',
    SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE: toBashPath(registryFile),
    SHEIN_BI_MARKETING_PLAN_REGISTRY_ROOT: toBashPath(registryRoot),
    SHEIN_BI_MARKETING_COST_MAP_PATH: toBashPath(costMapPath),
    SHEIN_TEST_EXECUTOR_MARKER: toBashPath(executorMarker),
    SHEIN_TEST_QUEUE_MANAGER_MARKER: toBashPath(managerMarker),
    SHEIN_TEST_REGISTRY_PUBLISH_ATTEMPT_MARKER: toBashPath(registryPublishAttemptMarker),
    SHEIN_TEST_QUEUE_PUBLISH_ATTEMPT_MARKER: toBashPath(queuePublishAttemptMarker),
    SHEIN_TEST_QUEUE_PATH: toBashPath(queuePath),
    SHEIN_TEST_RESULT_PATH: toBashPath(resultPath),
    SHEIN_TEST_LEASE_ACTION_MARKER: toBashPath(leaseActionMarker),
    PATH: `${toBashPath(binDir)}:/usr/bin:/bin`,
  };
  if (switchDuringExecutor) values.SHEIN_TEST_SWITCH_REGISTRY_TO = toBashPath(registryBPointer);
  const input = [
    ...Object.entries(values).map(([name, value]) => `export ${name}=${bashQuote(value)}`),
    `bash ${bashQuote(toBashPath(workerPath))}`,
    '',
  ].join('\n');
  return spawnSync('bash', [], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    input,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15_000,
  });
}

function restoreFixturePermissions(root) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`fixture cleanup root must be a real directory: ${root}`);
  }

  const restoreOwnerAccess = current => {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.chmodSync(current, (stat.mode & 0o777) | 0o700);
      for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
        restoreOwnerAccess(path.join(current, entry.name));
      }
      return;
    }
    if (stat.isFile()) fs.chmodSync(current, (stat.mode & 0o777) | 0o600);
  };

  restoreOwnerAccess(root);
}

let repairWorkerRegistryTestError = null;
let repairWorkerRegistryCleanupError = null;
try {
  fs.mkdirSync(path.dirname(costMapPath), {recursive: true});
  fs.writeFileSync(costMapPath, '{"costMap":{}}\n', 'utf8');
  fs.mkdirSync(path.dirname(registryBPointer), {recursive: true});
  installFixtureScripts();
  const sourceDir = path.join(fixtureRoot, 'source');
  const pairA = writePair(sourceDir, 'a', 0);
  const publishedA = await publishPair(pairA, 'repair-worker-a');
  const pointerA = fs.readFileSync(registryFile);
  const pairB = writePair(sourceDir, 'b', 1);
  const publishedB = await publishPair(pairB, 'repair-worker-b');
  fs.copyFileSync(registryFile, registryBPointer);
  writeGuard(publishedA.registryHash, publishedA.priceOverrides, publishedA.priceOverridesHash);

  const missing = runWorker({missingRegistry: true, runId: 'missing-current'});
  assert.notEqual(missing.status, 0, `${missing.stdout}\n${missing.stderr}`);
  assert.doesNotMatch(`${missing.stdout}\n${missing.stderr}`, /executor\n/);
  assert.equal(fs.existsSync(executorMarker), false, 'missing current.json must block before the executor');

  const mismatched = runWorker({pointerBytes: fs.readFileSync(registryBPointer), runId: 'registry-b-before-executor'});
  assert.equal(mismatched.status, 73, `${mismatched.stdout}\n${mismatched.stderr}`);
  assert.match(`${mismatched.stdout}\n${mismatched.stderr}`, /current managed registry drift/);
  assert.equal(fs.existsSync(executorMarker), false, 'A guard plus B current.json must block before the executor');

  const validStartedAt = Date.now();
  const valid = runWorker({pointerBytes: pointerA, runId: 'registry-a-control'});
  const validElapsedMs = Date.now() - validStartedAt;
  assert.equal(valid.error, undefined, `matching worker must exit without heartbeat pipe timeout: ${valid.error?.message || ''}`);
  assert.ok(validElapsedMs < 12_000, `matching worker must stop heartbeat promptly, elapsed=${validElapsedMs}ms`);
  assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
  assert.equal(fs.readFileSync(executorMarker, 'utf8'), 'executor\n', 'matching current.json must allow the guarded stage to reach its executor');
  assert.equal(fs.readFileSync(registryPublishAttemptMarker, 'utf8'), 'blocked\n', 'registry replacement attempt must be blocked by .publish.lock before executor mutation');
  assert.equal(fs.readFileSync(queuePublishAttemptMarker, 'utf8'), 'blocked\n', 'queue replacement attempt must be blocked by queue mutation lock before executor mutation');
  const leaseActionsAtExit = fs.readFileSync(leaseActionMarker, 'utf8');
  assert.match(leaseActionsAtExit, /"action":"acquire"/);
  assert.match(leaseActionsAtExit, /"action":"release"/);
  await new Promise(resolve => setTimeout(resolve, 1_300));
  assert.equal(fs.readFileSync(leaseActionMarker, 'utf8'), leaseActionsAtExit,
    'worker exit must leave no heartbeat process or inherited sleep that can act after release');

  const boundary = runWorker({pointerBytes: pointerA, switchDuringExecutor: true, runId: 'registry-switch-boundary'});
  assert.equal(boundary.status, 73, `${boundary.stdout}\n${boundary.stderr}`);
  assert.equal(fs.readFileSync(executorMarker, 'utf8'), 'executor\n');
  assert.equal(fs.existsSync(managerMarker), false, 'registry switch after executor must block the stage-boundary queue mutation');
  const queueAfterBoundary = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.equal(queueAfterBoundary.status, 'pending');
  assert.equal(queueAfterBoundary.stages.fallbackRepair.status, 'pending');
  assert.match(`${boundary.stdout}\n${boundary.stderr}`, /current managed registry drift/);

  console.log(JSON.stringify({
    ok: true,
    missingCurrentBlocksBeforeExecutor: true,
    mismatchedCurrentBlocksBeforeExecutor: true,
    matchingCurrentAllowsExecutor: true,
    registryReplacementBlockedDuringCriticalSection: true,
    queueReplacementBlockedDuringCriticalSection: true,
    registrySwitchBlocksStageBoundaryMutation: true,
    heartbeatStopsPromptlyWithoutResidualProcess: true,
    validWorkerElapsedMs: validElapsedMs,
    registryA: publishedA.registryHash,
    registryB: publishedB.registryHash,
  }));
} catch (error) {
  repairWorkerRegistryTestError = error;
} finally {
  try {
    restoreFixturePermissions(fixtureRoot);
    fs.rmSync(fixtureRoot, {recursive: true, force: true});
  } catch (error) {
    repairWorkerRegistryCleanupError = error;
  }
}

if (repairWorkerRegistryTestError && repairWorkerRegistryCleanupError) {
  throw new AggregateError(
    [repairWorkerRegistryTestError, repairWorkerRegistryCleanupError],
    'marketing repair worker registry test and cleanup both failed',
  );
}
if (repairWorkerRegistryTestError) throw repairWorkerRegistryTestError;
if (repairWorkerRegistryCleanupError) throw repairWorkerRegistryCleanupError;
