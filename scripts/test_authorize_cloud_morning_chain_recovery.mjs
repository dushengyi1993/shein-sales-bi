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

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}

async function makeFixture({
  active = {},
  latest = {},
  maintenance = {ok: true, active: false, mode: 'none'},
  systemd = {},
  dailyOperatingRefresh = null,
  inventoryStarted = true,
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
  await writeJson(path.join(cloudState, 'active.json'), {
    runDate: RUN_DATE,
    businessDate: BUSINESS_DATE,
    deadlineEpoch: OLD_DEADLINE,
    startedAt: '2026-08-24T01:00:00.000Z',
    attempt: 3,
    ...active,
  });
  await fs.chmod(path.join(cloudState, 'active.json'), 0o600);
  await writeJson(path.join(cloudState, 'latest.json'), {
    date: RUN_DATE,
    businessDate: BUSINESS_DATE,
    status: 'failed',
    message: 'inventory guard failed before the inventory plan/result boundary',
    ...latest,
  });
  if (dailyOperatingRefresh !== null) {
    await writeJson(path.join(markerRoot, 'daily-operating-refresh.json'), dailyOperatingRefresh);
  }
  if (inventoryStarted) {
    await writeJson(path.join(markerRoot, 'inventory-started.json'), {
      ok: true,
      stage: 'inventory-started',
      status: 'done',
      runDate: RUN_DATE,
      businessDate: BUSINESS_DATE,
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
    if (systemd.job && unit.endsWith('.service')) {
      return {code: 0, stdout: 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nJob=123\n'};
    }
    return {
      code: 0,
      stdout: `LoadState=loaded\nActiveState=${unit.endsWith('.timer') ? 'active' : 'inactive'}\nSubState=${unit.endsWith('.timer') ? 'waiting' : 'dead'}\nJob=\n`,
    };
  };
  const lockCalls = [];
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
    writeJsonFileAtomic: writer,
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
    systemctlCalls,
    lockCalls,
    deps,
    readActive: () => fs.readFile(path.join(cloudState, 'active.json'), 'utf8'),
    readReceipt: () => fs.readFile(path.join(cloudState, 'recovery', `${RUN_DATE}.json`), 'utf8'),
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
      const fx = await makeFixture({inventoryStarted: false}); fixtures.push(fx);
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

    console.log('authorize_cloud_morning_chain_recovery: focused safety and idempotency cases passed');
  } finally {
    await Promise.all(fixtures.map(fx => fs.rm(fx.root, {recursive: true, force: true}).catch(() => {})));
  }
}

await main();
