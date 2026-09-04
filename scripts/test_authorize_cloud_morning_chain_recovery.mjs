#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {writeJsonFileAtomic} from '../lib/atomic_file_publish.mjs';
import {
  authorizeCloudMorningChainRecovery,
  MORNING_CHAIN_RECOVERY_CONFIRMATION,
  MorningChainRecoveryError,
} from './authorize_cloud_morning_chain_recovery.mjs';

const RUN_DATE = '2026-08-24';
const BUSINESS_DATE = '2026-08-23';
const NOW = Math.floor(Date.parse('2026-08-24T10:30:00+08:00') / 1_000);
const OLD_DEADLINE = Math.floor(Date.parse('2026-08-24T10:00:00+08:00') / 1_000);
const NEW_DEADLINE = Math.floor(Date.parse('2026-08-24T12:30:00+08:00') / 1_000);
const REASON = 'root fix deployed; resume the same-day morning chain';
const TERMINAL_ALERT = {
  date: RUN_DATE,
  businessDate: BUSINESS_DATE,
  stage: 'all',
  status: 'failed',
  message: 'first-start absolute deadline expired (deadlineEpoch=' + OLD_DEADLINE + ') before runDate=' + RUN_DATE + ' businessDate=' + BUSINESS_DATE + ' could complete; no further automatic attempts in this window',
  deadlineEpoch: OLD_DEADLINE,
};
const MORNING_ALL_MARKER = {
  schema: 4,
  schemaVersion: 4,
  ok: false,
  stage: 'morning-all',
  status: 'failed',
  runDate: RUN_DATE,
  businessDate: BUSINESS_DATE,
  message: 'first-start absolute deadline expired deadlineEpoch=' + OLD_DEADLINE + ' runDate=' + RUN_DATE + ' businessDate=' + BUSINESS_DATE + '; no further automatic attempts in this window',
};
const STOCK_REFRESH_MARKER = {
  ok: true,
  stage: 'stock-refresh',
  status: 'done',
  runDate: RUN_DATE,
  businessDate: RUN_DATE,
};
const NESTED_METRIC_DEADLINE = OLD_DEADLINE - 31_623;
const METRIC_REFETCH_STATE = {
  schemaVersion: 'cloud-link-business-metric-refetch/v2',
  date: BUSINESS_DATE,
  runKey: `${RUN_DATE}:${BUSINESS_DATE}`,
  status: 'deadline',
  attempts: 1,
  maxAttempts: 12,
  deadlineEpoch: NESTED_METRIC_DEADLINE,
  targetStores: Array.from({length: 19}, (_, index) => `STORE_${index + 1}`),
  replacedStores: [],
  failedStores: [],
  deferredStores: [],
  startedAt: '2026-08-24T01:30:00.000Z',
  updatedAt: '2026-08-24T02:00:00.000Z',
  transactionRoot: '',
  source: {status: 'rolled_back', fingerprint: '', transactionRoot: ''},
  phases: {},
};

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}

async function makeFixture({
  active = {},
  terminalDeadlineAlert = null,
  morningAllMarker = null,
  latest = {},
  maintenance = {ok: true, active: false, mode: 'none'},
  systemd = {},
  dailyOperatingRefresh = null,
  inventoryStarted = true,
  stockRefresh = null,
  metricRefetch = null,
  metricManifest = false,
  metricJournal = [{event: 'transaction_created'}],
  dailyInventoryGuard = null,
  artifact = '',
  writer = writeJsonFileAtomic,
  lock = null,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'morning-chain-recovery-test-'));
  const stateRoot = path.join(root, 'state');
  const inventoryRuntimeRoot = path.join(root, 'inventory-runtime');
  const cloudState = path.join(stateRoot, 'cloud_morning_chain');
  const markerRoot = path.join(stateRoot, 'pipeline-markers', RUN_DATE);
  const inventoryPlanFile = path.join(
    inventoryRuntimeRoot,
    'plans',
    `daily-inventory-replenishment-${RUN_DATE}.json`,
  );
  const inventoryResultFile = path.join(
    inventoryRuntimeRoot,
    'results',
    `daily-inventory-replenishment-${RUN_DATE}.json`,
  );
  const inventoryJournalFile = `${inventoryResultFile}.journal.ndjson`;
  await fs.mkdir(path.join(cloudState, 'recovery'), {recursive: true});
  await fs.mkdir(markerRoot, {recursive: true});
  if (active !== null) {
    await writeJson(path.join(cloudState, 'active.json'), {
      runDate: RUN_DATE,
      businessDate: BUSINESS_DATE,
      deadlineEpoch: OLD_DEADLINE,
      startedAt: '2026-08-24T01:00:00.000Z',
      attempt: 3,
      ...active,
    });
    await fs.chmod(path.join(cloudState, 'active.json'), 0o600);
  }
  await writeJson(path.join(cloudState, 'latest.json'), {
    date: RUN_DATE,
    businessDate: BUSINESS_DATE,
    status: 'failed',
    message: 'inventory guard failed before the inventory plan/result boundary',
    ...latest,
  });
  if (terminalDeadlineAlert !== null) {
    await writeJson(path.join(stateRoot, 'cloud_ops_alerts', 'morning-chain-last.json'), terminalDeadlineAlert);
  }
  if (morningAllMarker !== null) {
    await writeJson(path.join(markerRoot, 'morning-all.json'), morningAllMarker);
  }
  if (dailyOperatingRefresh !== null) {
    await writeJson(path.join(markerRoot, 'daily-operating-refresh.json'), dailyOperatingRefresh);
  }
  if (inventoryStarted) {
    await writeJson(path.join(markerRoot, 'inventory-started.json'), inventoryStarted === true ? {
      ok: true,
      stage: 'inventory-started',
      status: 'done',
      runDate: RUN_DATE,
      businessDate: BUSINESS_DATE,
    } : inventoryStarted);
  }
  if (stockRefresh !== null) {
    await writeJson(path.join(markerRoot, 'stock-refresh.json'), stockRefresh);
  }
  if (metricRefetch !== null) {
    const metricTransactionRoot = metricRefetch.transactionRoot
      || path.join(stateRoot, '.link-business-metric-refetch.fixture');
    await fs.mkdir(metricTransactionRoot, {recursive: true});
    if (metricManifest) {
      await writeJson(path.join(metricTransactionRoot, 'manifest.json'), {status: 'created'});
    }
    await fs.writeFile(
      path.join(metricTransactionRoot, 'journal.ndjson'),
      `${metricJournal.map(event => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
    await writeJson(path.join(stateRoot, 'cloud_ops_alerts', 'link-business-metric-refetch.json'), {
      ...metricRefetch,
      transactionRoot: metricRefetch.transactionRoot || metricTransactionRoot,
    });
  }
  if (dailyInventoryGuard !== null) {
    await writeJson(path.join(markerRoot, 'daily-inventory-guard.json'), dailyInventoryGuard);
  }
  if (artifact === 'plan') await writeJson(inventoryPlanFile, {date: RUN_DATE});
  if (artifact === 'result') await writeJson(inventoryResultFile, {date: RUN_DATE});
  if (artifact === 'journal') {
    await fs.mkdir(path.dirname(inventoryJournalFile), {recursive: true});
    await fs.writeFile(inventoryJournalFile, '{"kind":"intent"}\n', 'utf8');
  }

  const systemctlCalls = [];
  const systemctlRunner = async ({unit, args}) => {
    systemctlCalls.push({unit, args});
    if (systemd.activeService && unit.endsWith('.service')) {
      return {code: 0, stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nJob=\n'};
    }
    if (systemd.interruptedService && unit.endsWith('.service')) {
      return {code: 0, stdout: 'LoadState=loaded\nActiveState=failed\nSubState=failed\nResult=signal\nExecMainCode=2\nExecMainStatus=15\nMainPID=0\nJob=\n'};
    }
    if (systemd.job && unit.endsWith('.service')) {
      return {code: 0, stdout: 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nJob=123\n'};
    }
    return {
      code: 0,
      stdout: `LoadState=loaded\nActiveState=${unit.endsWith('.timer') ? 'active' : 'inactive'}\nSubState=${unit.endsWith('.timer') ? 'waiting' : 'dead'}\nJob=\n`,
    };
  };
  const lockCalls = [];
  const writerCalls = [];
  const writerOptions = [];
  const withExclusiveLock = async (lockPath, callback) => {
    lockCalls.push(lockPath);
    if (lock) throw new MorningChainRecoveryError('lock is already held', {code: 'MORNING_CHAIN_RECOVERY_LOCK_CONFLICT', exitCode: 75});
    return callback();
  };
  const deps = {
    runDate: RUN_DATE,
    newDeadlineEpoch: NEW_DEADLINE,
    reason: REASON,
    confirm: MORNING_CHAIN_RECOVERY_CONFIRMATION,
    stateRoot,
    inventoryRuntimeRoot,
    now: () => NOW,
    maintenanceStatusReader: async () => maintenance,
    systemctlRunner,
    withExclusiveLock,
    writeJsonFileAtomic: async (file, value, options) => {
      writerCalls.push(path.basename(file));
      writerOptions.push({file: path.basename(file), options: {...(options || {})}});
      return writer(file, value, options);
    },
  };
  return {
    root,
    stateRoot,
    inventoryRuntimeRoot,
    cloudState,
    markerRoot,
    inventoryPlanFile,
    inventoryResultFile,
    inventoryJournalFile,
    writerCalls,
    writerOptions,
    systemctlCalls,
    lockCalls,
    deps,
    readActive: () => fs.readFile(path.join(cloudState, 'active.json'), 'utf8'),
    readReceipt: () => fs.readFile(path.join(cloudState, 'recovery', `${RUN_DATE}.json`), 'utf8'),
    readMetricRefetch: () => fs.readFile(path.join(stateRoot, 'cloud_ops_alerts', 'link-business-metric-refetch.json'), 'utf8'),
    readMetricRefetchStat: () => fs.stat(path.join(stateRoot, 'cloud_ops_alerts', 'link-business-metric-refetch.json')),
    readActiveStat: () => fs.stat(path.join(cloudState, 'active.json')),
    readReceiptStat: () => fs.stat(path.join(cloudState, 'recovery', `${RUN_DATE}.json`)),
  };
}

async function expectCode(run, code) {
  await assert.rejects(run, error => {
    assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
    return true;
  });
}

async function main() {
  const fixtures = [];
  try {
    // Missing confirmation is rejected before a lock or any state read.
    {
      const fx = await makeFixture(); fixtures.push(fx);
      const deps = {...fx.deps, confirm: ''};
      await expectCode(() => authorizeCloudMorningChainRecovery(deps), 'MORNING_CHAIN_RECOVERY_CONFIRMATION_REQUIRED');
      assert.equal(fx.lockCalls.length, 0);
    }

    // Maintenance must be a valid inactive marker, and the exact service/timer
    // systemctl proof must show no running service and no queued job.
    {
      const fx = await makeFixture({maintenance: {ok: true, active: true, mode: 'all'}}); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_MAINTENANCE_ACTIVE');
    }
    {
      const fx = await makeFixture({systemd: {activeService: true}}); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_SERVICE_ACTIVE');
      assert.equal(fx.systemctlCalls[0].args[0], 'show');
      assert.ok(fx.systemctlCalls.every(call => !call.args.includes('start')));
    }
    {
      const fx = await makeFixture({systemd: {job: true}}); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_SYSTEMD_JOB_ACTIVE');
    }

    // Date and deadline gates are checked against the injected current clock.
    {
      const fx = await makeFixture(); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery({...fx.deps, runDate: '2026-08-23'}), 'MORNING_CHAIN_RECOVERY_RUN_DATE_NOT_TODAY');
    }
    {
      const fx = await makeFixture({active: {businessDate: '2026-08-22'}}); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_BUSINESS_DATE_MISMATCH');
    }
    {
      const fx = await makeFixture({active: {deadlineEpoch: NOW + 60}}); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_DEADLINE_NOT_EXPIRED');
    }
    {
      const fx = await makeFixture(); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery({...fx.deps, newDeadlineEpoch: NOW + 10_801}), 'MORNING_CHAIN_RECOVERY_DEADLINE_BUDGET_EXCEEDED');
      await expectCode(() => authorizeCloudMorningChainRecovery({...fx.deps, newDeadlineEpoch: Math.floor(Date.parse('2026-08-24T23:31:00+08:00') / 1_000)}), 'MORNING_CHAIN_RECOVERY_DEADLINE_OUT_OF_DAY');
    }

    // Completion, missing checkpoint, and post-inventory evidence all fail
    // closed without creating a receipt or touching active.json.
    {
      const fx = await makeFixture({latest: {status: 'done'}}); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_COMPLETION_DONE');
    }
    {
      const fx = await makeFixture({
        latest: {status: 'waiting', date: RUN_DATE, businessDate: BUSINESS_DATE, stage: 'all'},
      }); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_LATEST_NOT_FAILED');
    }
    {
      const fx = await makeFixture({
        latest: {status: 'waiting', date: RUN_DATE, businessDate: BUSINESS_DATE, stage: 'all'},
        systemd: {interruptedService: true},
      }); fixtures.push(fx);
      const result = await authorizeCloudMorningChainRecovery(fx.deps);
      assert.equal(result.status, 'authorized');
      assert.ok(result.canonicalHash);
    }
    {
      const fx = await makeFixture({inventoryStarted: false}); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_MARKER_MISSING');
    }
    for (const [label, marker] of [
      ['wrong runDate', {...STOCK_REFRESH_MARKER, runDate: BUSINESS_DATE}],
      ['wrong businessDate', {...STOCK_REFRESH_MARKER, businessDate: BUSINESS_DATE}],
      ['non-done status', {...STOCK_REFRESH_MARKER, status: 'warning'}],
      ['inventory-started exists but is not done', null],
    ]) {
      const fx = await makeFixture({
        inventoryStarted: label === 'inventory-started exists but is not done'
          ? {ok: false, stage: 'inventory-started', status: 'running', runDate: RUN_DATE, businessDate: BUSINESS_DATE}
          : false,
        stockRefresh: marker,
      }); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_MARKER_MISSING');
    }
    {
      const fx = await makeFixture({latest: {phase: 'inventory-plan'}}); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_FAILURE_AFTER_INVENTORY');
    }
    {
      const fx = await makeFixture({dailyOperatingRefresh: {ok: true, stage: 'daily-operating-refresh', status: 'done', runDate: RUN_DATE, businessDate: BUSINESS_DATE}}); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_COMPLETION_DONE');
    }
    {
      const fx = await makeFixture({dailyInventoryGuard: {ok: false, stage: 'daily-inventory-guard', status: 'failed'}}); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_EVIDENCE_EXISTS');
    }
    for (const artifact of ['plan', 'result', 'journal']) {
      const fx = await makeFixture({artifact}); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_EVIDENCE_EXISTS');
    }

    // Lock conflict is terminal and does not permit a preflight read.
    {
      const fx = await makeFixture({lock: true}); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_LOCK_CONFLICT');
      assert.equal(fx.systemctlCalls.length, 0);
    }

    // The receipt is published first.  An injected active publish failure must
    // leave the old active bytes intact and allow the same exact request to be
    // replayed, while a different deadline is rejected by the receipt binding.
    {
      const calls = [];
      const fx = await makeFixture({
        writer: async (file, value, options) => {
          calls.push(path.basename(file));
          if (path.basename(file) === 'active.json') throw new Error('injected active atomic failure');
          return writeJsonFileAtomic(file, value, options);
        },
      }); fixtures.push(fx);
      const before = await fx.readActive();
      await assert.rejects(() => authorizeCloudMorningChainRecovery(fx.deps), /injected active atomic failure/u);
      assert.equal(await fx.readActive(), before);
      assert.deepEqual(calls, [`${RUN_DATE}.json`, 'active.json']);
      const retry = await authorizeCloudMorningChainRecovery({...fx.deps, writeJsonFileAtomic});
      assert.equal(retry.status, 'authorized');
      await expectCode(
        () => authorizeCloudMorningChainRecovery({...fx.deps, writeJsonFileAtomic, newDeadlineEpoch: NEW_DEADLINE + 1}),
        'MORNING_CHAIN_RECOVERY_RECEIPT_CONFLICT',
      );
    }

    // Successful authorization binds the exact before hash, deadline, reason,
    // and generation in both receipt and active context; replay is a no-op.
    {
      const fx = await makeFixture(); fixtures.push(fx);
      const before = await fx.readActive();
      const beforeStat = await fx.readActiveStat();
      const result = await authorizeCloudMorningChainRecovery(fx.deps);
      const active = JSON.parse(await fx.readActive());
      const receipt = JSON.parse(await fx.readReceipt());
      assert.equal(result.status, 'authorized');
      assert.equal(result.canonicalHash, receipt.canonicalHash);
      assert.equal(receipt.beforeHash, (await import('node:crypto')).createHash('sha256').update(before).digest('hex'));
      assert.equal(receipt.oldDeadlineEpoch, OLD_DEADLINE);
      assert.equal(receipt.newDeadlineEpoch, NEW_DEADLINE);
      assert.equal(receipt.reason, REASON);
      assert.equal(receipt.recoveryGeneration, 1);
      assert.equal(active.deadlineEpoch, NEW_DEADLINE);
      assert.equal(active.previousDeadline, OLD_DEADLINE);
      assert.equal(active.recoveryGeneration, 1);
      assert.equal(active.receiptHash, receipt.canonicalHash);
      const [activeStat, receiptStat] = await Promise.all([fx.readActiveStat(), fx.readReceiptStat()]);
      assert.equal(activeStat.mode & 0o777, beforeStat.mode & 0o777);
      assert.equal(receiptStat.mode & 0o777, beforeStat.mode & 0o777);
      if (process.platform !== 'win32') {
        assert.equal(receiptStat.uid, activeStat.uid);
        assert.equal(receiptStat.gid, activeStat.gid);
      }
      const replay = await authorizeCloudMorningChainRecovery(fx.deps);
      assert.equal(replay.status, 'already-authorized');
      assert.deepEqual(JSON.parse(await fx.readReceipt()), receipt);
    }

    // An absent active context can be rebuilt only from the exact same-day
    // structured deadline alert, failed morning-all marker, and matching
    // pre-inventory latest failure.  Its checkpoint accepts either the
    // original inventory-started done marker or the exact same-day
    // stock-refresh done marker.  The rebuild is idempotent.
    {
      const fx = await makeFixture({
        active: null,
        terminalDeadlineAlert: TERMINAL_ALERT,
        morningAllMarker: MORNING_ALL_MARKER,
        inventoryStarted: false,
        stockRefresh: STOCK_REFRESH_MARKER,
      }); fixtures.push(fx);
      const result = await authorizeCloudMorningChainRecovery(fx.deps);
      const receipt = JSON.parse(await fx.readReceipt());
      const active = JSON.parse(await fx.readActive());
      assert.equal(result.status, 'authorized');
      assert.equal(receipt.oldDeadlineEpoch, OLD_DEADLINE);
      assert.equal(receipt.newDeadlineEpoch, NEW_DEADLINE);
      assert.equal(active.runDate, RUN_DATE);
      assert.equal(active.businessDate, BUSINESS_DATE);
      assert.equal(active.deadlineEpoch, NEW_DEADLINE);
      assert.equal(active.previousDeadline, OLD_DEADLINE);
      assert.equal(active.recoveryGeneration, 1);
      assert.equal(active.receiptHash, receipt.canonicalHash);
      assert.ok(fx.systemctlCalls.every(call => call.args[0] === 'show'));
      assert.ok(fx.systemctlCalls.every(call => !call.args.includes('start')));
      const durableReceipt = await fx.readReceipt();
      await fs.unlink(path.join(fx.cloudState, 'active.json'));
      const crashContinuation = await authorizeCloudMorningChainRecovery(fx.deps);
      assert.equal(crashContinuation.status, 'already-authorized');
      const rebuiltActive = JSON.parse(await fx.readActive());
      assert.equal(rebuiltActive.deadlineEpoch, NEW_DEADLINE);
      assert.equal(rebuiltActive.previousDeadline, OLD_DEADLINE);
      assert.equal(rebuiltActive.receiptHash, receipt.canonicalHash);
      assert.equal(await fx.readReceipt(), durableReceipt);
      const replay = await authorizeCloudMorningChainRecovery(fx.deps);
      assert.equal(replay.status, 'already-authorized');
      assert.deepEqual(JSON.parse(await fx.readReceipt()), receipt);
    }

    // Missing or mismatched structured terminal evidence fails closed.
    {
      const fx = await makeFixture({active: null}); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_REBUILD_EVIDENCE_MISMATCH');
    }
    {
      const fx = await makeFixture({
        active: null,
        terminalDeadlineAlert: {...TERMINAL_ALERT, date: BUSINESS_DATE},
        morningAllMarker: MORNING_ALL_MARKER,
      }); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_REBUILD_EVIDENCE_MISMATCH');
    }
    {
      const fx = await makeFixture({
        active: null,
        terminalDeadlineAlert: TERMINAL_ALERT,
        morningAllMarker: {...MORNING_ALL_MARKER, message: MORNING_ALL_MARKER.message.replace(String(OLD_DEADLINE), String(OLD_DEADLINE - 1))},
      }); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_REBUILD_DEADLINE_MISMATCH');
    }
    {
      const fx = await makeFixture({
        active: null,
        terminalDeadlineAlert: TERMINAL_ALERT,
        morningAllMarker: MORNING_ALL_MARKER,
        latest: {date: BUSINESS_DATE},
      }); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), 'MORNING_CHAIN_RECOVERY_LATEST_DATE_MISMATCH');
    }

    // Structured-evidence rebuild still refuses any inventory write evidence.
    for (const [option, expectedCode] of [
      [{dailyInventoryGuard: {status: 'failed'}}, 'MORNING_CHAIN_RECOVERY_EVIDENCE_EXISTS'],
      [{artifact: 'plan'}, 'MORNING_CHAIN_RECOVERY_EVIDENCE_EXISTS'],
      [{artifact: 'result'}, 'MORNING_CHAIN_RECOVERY_EVIDENCE_EXISTS'],
      [{artifact: 'journal'}, 'MORNING_CHAIN_RECOVERY_EVIDENCE_EXISTS'],
    ]) {
      const fx = await makeFixture({
        active: null,
        terminalDeadlineAlert: TERMINAL_ALERT,
        morningAllMarker: MORNING_ALL_MARKER,
        ...option,
      }); fixtures.push(fx);
      await expectCode(() => authorizeCloudMorningChainRecovery(fx.deps), expectedCode);
    }

    // The nested metric deadline is advanced atomically to the outer recovery
    // deadline.  The stale candidate root is unbound but never deleted, and
    // attempts/max/target identity are preserved.
    {
      const fx = await makeFixture({metricRefetch: METRIC_REFETCH_STATE}); fixtures.push(fx);
      const candidateRoot = path.join(fx.stateRoot, '.link-business-metric-refetch.fixture');
      const result = await authorizeCloudMorningChainRecovery(fx.deps);
      const receipt = JSON.parse(await fx.readReceipt());
      const active = JSON.parse(await fx.readActive());
      const metric = JSON.parse(await fx.readMetricRefetch());
      const metricWrite = fx.writerOptions.find(({file}) => file === 'link-business-metric-refetch.json');
      assert.equal(result.status, 'authorized');
      assert.deepEqual(fx.writerCalls, ['link-business-metric-refetch.json', `${RUN_DATE}.json`, 'active.json']);
      assert.equal(metricWrite.options.mode, 0o660);
      if (process.platform !== 'win32') {
        const [activeStat, metricStat] = await Promise.all([
          fx.readActiveStat(),
          fx.readMetricRefetchStat(),
        ]);
        assert.equal(metricStat.uid, activeStat.uid);
        assert.equal(metricStat.gid, activeStat.gid);
        if (process.getuid?.() === 0) {
          assert.equal(metricWrite.options.uid, activeStat.uid);
          assert.equal(metricWrite.options.gid, activeStat.gid);
        } else {
          assert.equal(metricWrite.options.uid, undefined);
          assert.equal(metricWrite.options.gid, undefined);
        }
      }
      assert.equal(metric.status, 'recovery_authorized');
      assert.equal(metric.previousDeadlineEpoch, NESTED_METRIC_DEADLINE);
      assert.equal(metric.deadlineEpoch, NEW_DEADLINE);
      assert.equal(metric.morningRecoveryReceiptHash, receipt.canonicalHash);
      assert.equal(metric.transactionRoot, '');
      assert.equal(metric.source.transactionRoot, '');
      assert.equal(metric.attempts, 1);
      assert.equal(metric.maxAttempts, 12);
      assert.equal(metric.targetStores.length, 19);
      assert.equal(active.deadlineEpoch, NEW_DEADLINE);
      assert.equal(active.receiptHash, receipt.canonicalHash);
      assert.equal(await fs.stat(candidateRoot).then(() => true, () => false), true);
      assert.equal(await fs.stat(path.join(candidateRoot, 'manifest.json')).then(() => true, () => false), false);
      const replay = await authorizeCloudMorningChainRecovery(fx.deps);
      assert.equal(replay.status, 'already-authorized');
      assert.equal(JSON.parse(await fx.readMetricRefetch()).attempts, 1);
      assert.deepEqual(JSON.parse(await fx.readReceipt()), receipt);
    }

    // Production compatibility: an older-version outer authorization may
    // already be bound when the nested metric deadline appears later.  The
    // next authorize call must backfill only the nested state.
    {
      const fx = await makeFixture(); fixtures.push(fx);
      await authorizeCloudMorningChainRecovery(fx.deps);
      const outerReceipt = await fx.readReceipt();
      const outerActive = await fx.readActive();
      const candidateRoot = path.join(fx.stateRoot, '.link-business-metric-refetch.late');
      await fs.mkdir(candidateRoot, {recursive: true});
      await fs.writeFile(
        path.join(candidateRoot, 'journal.ndjson'),
        `${JSON.stringify({event: 'transaction_created'})}\n`,
        'utf8',
      );
      await writeJson(path.join(fx.stateRoot, 'cloud_ops_alerts', 'link-business-metric-refetch.json'), {
        ...METRIC_REFETCH_STATE,
        transactionRoot: candidateRoot,
      });
      fx.writerCalls.length = 0;
      const lateBinding = await authorizeCloudMorningChainRecovery(fx.deps);
      const receipt = JSON.parse(outerReceipt);
      const metric = JSON.parse(await fx.readMetricRefetch());
      assert.equal(lateBinding.status, 'already-authorized');
      assert.deepEqual(fx.writerCalls, ['link-business-metric-refetch.json']);
      assert.equal(await fx.readReceipt(), outerReceipt);
      assert.equal(await fx.readActive(), outerActive);
      assert.equal(metric.status, 'recovery_authorized');
      assert.equal(metric.previousDeadlineEpoch, NESTED_METRIC_DEADLINE);
      assert.equal(metric.deadlineEpoch, receipt.newDeadlineEpoch);
      assert.equal(metric.morningRecoveryReceiptHash, receipt.canonicalHash);
      assert.equal(metric.transactionRoot, '');
      assert.equal(metric.attempts, 1);
      assert.equal(await fs.stat(candidateRoot).then(() => true, () => false), true);
      fx.writerCalls.length = 0;
      const replay = await authorizeCloudMorningChainRecovery(fx.deps);
      assert.equal(replay.status, 'already-authorized');
      assert.deepEqual(fx.writerCalls, []);
    }

    // Production replay may legitimately observe waiting while the exact
    // nested metric deadline is pending.  Outer receipt/active bytes must not
    // move; only the nested state is backfilled.  Waiting without nested, or
    // with the wrong stage, still fails closed.
    {
      const fx = await makeFixture(); fixtures.push(fx);
      await authorizeCloudMorningChainRecovery(fx.deps);
      const outerReceipt = await fx.readReceipt();
      const outerActive = await fx.readActive();
      const candidateRoot = path.join(fx.stateRoot, '.link-business-metric-refetch.waiting');
      await fs.mkdir(candidateRoot, {recursive: true});
      await fs.writeFile(
        path.join(candidateRoot, 'journal.ndjson'),
        `${JSON.stringify({event: 'transaction_created'})}\n`,
        'utf8',
      );
      const nestedState = {...METRIC_REFETCH_STATE, transactionRoot: candidateRoot};
      const nestedFile = path.join(fx.stateRoot, 'cloud_ops_alerts', 'link-business-metric-refetch.json');
      const latestFile = path.join(fx.cloudState, 'latest.json');
      await writeJson(nestedFile, nestedState);
      await writeJson(latestFile, {
        date: RUN_DATE,
        businessDate: BUSINESS_DATE,
        stage: 'link-sync',
        status: 'waiting',
      });
      fx.writerCalls.length = 0;
      await expectCode(
        () => authorizeCloudMorningChainRecovery(fx.deps),
        'MORNING_CHAIN_RECOVERY_LATEST_STAGE_MISMATCH',
      );
      assert.deepEqual(fx.writerCalls, []);
      assert.equal(await fx.readReceipt(), outerReceipt);
      assert.equal(await fx.readActive(), outerActive);
      assert.equal(JSON.parse(await fx.readMetricRefetch()).status, 'deadline');
      await writeJson(latestFile, {
        date: RUN_DATE,
        businessDate: BUSINESS_DATE,
        stage: 'all',
        status: 'waiting',
      });
      const waitingRecovery = await authorizeCloudMorningChainRecovery(fx.deps);
      const metric = JSON.parse(await fx.readMetricRefetch());
      assert.equal(waitingRecovery.status, 'already-authorized');
      assert.deepEqual(fx.writerCalls, ['link-business-metric-refetch.json']);
      assert.equal(await fx.readReceipt(), outerReceipt);
      assert.equal(await fx.readActive(), outerActive);
      assert.equal(metric.status, 'recovery_authorized');
      assert.equal(metric.previousDeadlineEpoch, NESTED_METRIC_DEADLINE);
      assert.equal(metric.morningRecoveryReceiptHash, JSON.parse(outerReceipt).canonicalHash);
      assert.equal(await fs.stat(candidateRoot).then(() => true, () => false), true);
      fx.writerCalls.length = 0;
      const replay = await authorizeCloudMorningChainRecovery(fx.deps);
      assert.equal(replay.status, 'already-authorized');
      assert.deepEqual(fx.writerCalls, []);
    }

    // If crash occurs after nested publication but before receipt, the exact
    // retry reconstructs the same receipt from nested.updatedAt and finishes
    // without changing attempts or touching the candidate directory.
    {
      const calls = [];
      const fx = await makeFixture({
        metricRefetch: METRIC_REFETCH_STATE,
        writer: async (file, value, options) => {
          const name = path.basename(file);
          calls.push(name);
          if (name === `${RUN_DATE}.json`) throw new Error('injected receipt atomic failure');
          return writeJsonFileAtomic(file, value, options);
        },
      }); fixtures.push(fx);
      const beforeActive = await fx.readActive();
      await assert.rejects(() => authorizeCloudMorningChainRecovery(fx.deps), /injected receipt atomic failure/u);
      assert.deepEqual(calls, ['link-business-metric-refetch.json', `${RUN_DATE}.json`]);
      assert.equal(await fx.readActive(), beforeActive);
      assert.equal(await fx.readReceipt().then(() => true, () => false), false);
      const candidateRoot = path.join(fx.stateRoot, '.link-business-metric-refetch.fixture');
      assert.equal(await fs.stat(candidateRoot).then(() => true, () => false), true);
      const retry = await authorizeCloudMorningChainRecovery({...fx.deps, writeJsonFileAtomic});
      const receipt = JSON.parse(await fx.readReceipt());
      const metric = JSON.parse(await fx.readMetricRefetch());
      assert.equal(retry.status, 'authorized');
      assert.equal(metric.morningRecoveryReceiptHash, receipt.canonicalHash);
      assert.equal(metric.attempts, 1);
      assert.equal(await fs.stat(candidateRoot).then(() => true, () => false), true);
    }

    // Every forbidden nested identity/state/transaction condition fails
    // closed before receipt, active, or nested publication.
    const nestedFailures = [
      ['wrong date', {...METRIC_REFETCH_STATE, date: RUN_DATE}],
      ['wrong runKey', {...METRIC_REFETCH_STATE, runKey: `${BUSINESS_DATE}:${RUN_DATE}`}],
      ['wrong status', {...METRIC_REFETCH_STATE, status: 'running'}],
      ['attempts exhausted', {...METRIC_REFETCH_STATE, attempts: 12}],
      ['future nested deadline', {...METRIC_REFETCH_STATE, deadlineEpoch: NEW_DEADLINE}],
      ['committed source', {...METRIC_REFETCH_STATE, source: {...METRIC_REFETCH_STATE.source, status: 'source_committed'}}],
      ['source fingerprint', {...METRIC_REFETCH_STATE, source: {...METRIC_REFETCH_STATE.source, fingerprint: 'a'.repeat(64)}}],
      ['non-empty phases', {...METRIC_REFETCH_STATE, phases: {fetch: {status: 'done'}}}],
      ['failed result array', {...METRIC_REFETCH_STATE, failedStores: ['STORE_1']}],
      ['candidate manifest', {...METRIC_REFETCH_STATE}, {manifest: true}],
      ['dangerous journal', {...METRIC_REFETCH_STATE}, {journal: [{event: 'transaction_created'}, {event: 'source_committed'}]}],
    ];
    for (const [label, state, options = {}] of nestedFailures) {
      const fx = await makeFixture({
        metricRefetch: state,
        metricManifest: options.manifest === true,
        metricJournal: options.journal || [{event: 'transaction_created'}],
      }); fixtures.push(fx);
      const beforeActive = await fx.readActive();
      const beforeMetric = await fx.readMetricRefetch();
      await assert.rejects(() => authorizeCloudMorningChainRecovery(fx.deps));
      assert.equal(await fx.readActive(), beforeActive, label);
      assert.equal(await fx.readMetricRefetch(), beforeMetric, label);
      assert.deepEqual(fx.writerCalls, [], label);
      assert.equal(await fx.readReceipt().then(() => true, () => false), false, label);
    }

    console.log('authorize_cloud_morning_chain_recovery: focused safety and idempotency cases passed');
  } finally {
    await Promise.all(fixtures.map(fx => fs.rm(fx.root, {recursive: true, force: true}).catch(() => {})));
  }
}

await main();
