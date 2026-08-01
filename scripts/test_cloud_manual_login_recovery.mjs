#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  assessLinkRecoveryCompletion,
  assessSessionManagerManualRecovery,
  planManualLoginLinkRecovery,
} from '../lib/cloud_manual_login_recovery.mjs';

const plan = planManualLoginLinkRecovery({
  storeKey: 'dx',
  partialState: {
    date: '2026-07-31',
    failedStores: 'DX QY',
    successStores: 'DL FY',
    logFile: '/srv/shein-bi/logs/partial.log',
  },
});
assert.equal(plan.required, true);
assert.equal(plan.storeKey, 'DX');
assert.equal(plan.date, '2026-07-31');

assert.deepEqual(
  planManualLoginLinkRecovery({
    storeKey: 'HL',
    partialState: {date: '2026-07-31', failedStores: ['DX']},
  }),
  {
    required: false,
    reason: 'store_not_in_partial_failure',
    date: '2026-07-31',
    failedStores: ['DX'],
  },
);

const failedReport = {
  ok: false,
  generatedAt: '2026-08-01T02:39:51.000Z',
  summary: {failedStores: ['DX']},
};
const failedUnit = {
  ExecMainExitTimestamp: 'Sat 2026-08-01 10:39:51 CST',
  StateChangeTimestamp: 'Sat 2026-08-01 10:39:51 CST',
};
const recovered = assessSessionManagerManualRecovery({
  sessionReport: failedReport,
  unitStatus: failedUnit,
  manualLoginState: {
    sessions: [{
      storeKey: 'DX',
      status: 'completed',
      completedAt: '2026-08-01T07:48:39.022Z',
      finish: {export: {ok: true}, probe: {ok: true}},
    }],
  },
});
assert.equal(recovered.recovered, true);
assert.deepEqual(recovered.recoveredStores, ['DX']);

assert.equal(assessSessionManagerManualRecovery({
  sessionReport: failedReport,
  unitStatus: failedUnit,
  manualLoginState: {
    sessions: [{
      storeKey: 'DX',
      status: 'completed',
      completedAt: '2026-08-01T07:48:39.022Z',
      finish: {export: {ok: true}, probe: {ok: false}},
    }],
  },
}).recovered, false);

assert.equal(assessSessionManagerManualRecovery({
  sessionReport: failedReport,
  unitStatus: failedUnit,
  manualLoginState: {
    sessions: [{
      storeKey: 'DX',
      status: 'completed',
      completedAt: '2026-08-01T01:48:39.022Z',
      finish: {export: {ok: true}, probe: {ok: true}},
    }],
  },
}).recovered, false);

assert.equal(assessSessionManagerManualRecovery({
  sessionReport: {
    ok: true,
    generatedAt: '2026-08-01T11:12:55.054Z',
    summary: {failedStores: []},
  },
  unitStatus: failedUnit,
  manualLoginState: {sessions: []},
}).recovered, true);

const completion = assessLinkRecoveryCompletion({
  plan: {storeKey: 'DX', date: '2026-07-31'},
  startedAt: '2026-08-01T11:13:00.000Z',
  successState: {
    ok: true,
    date: '2026-07-31',
    generatedAt: '2026-08-01T11:16:28.417Z',
    successfulStores: ['DL', 'DX', 'FY'],
    failedStores: [],
    metricReady: true,
    warehouseLoaded: true,
  },
  partialState: null,
});
assert.equal(completion.complete, true);

assert.equal(assessLinkRecoveryCompletion({
  plan: {storeKey: 'DX', date: '2026-07-31'},
  startedAt: '2026-08-01T11:13:00.000Z',
  successState: {
    ok: true,
    date: '2026-07-31',
    generatedAt: '2026-08-01T11:16:28.417Z',
    successfulStores: ['DX'],
    failedStores: [],
    metricReady: true,
    warehouseLoaded: true,
  },
  partialState: {date: '2026-07-31', failedStores: 'DX'},
}).complete, false);

const manualScript = fs.readFileSync(new URL('./cloud_manual_login_session.mjs', import.meta.url), 'utf8');
assert.match(manualScript, /finishResult\?\.export\?\.ok === true && finishResult\?\.probe\?\.ok === true/);
assert.match(manualScript, /scheduleLinkRecovery\(session, args\)/);
assert.match(manualScript, /shein-manual-login-recovery-queue\/v1/);

const linkScript = fs.readFileSync(new URL('./cloud_link_business_sync.sh', import.meta.url), 'utf8');
assert.match(linkScript, /selection_args=\(--stores "\$SHEIN_LINK_BUSINESS_STORES"\)/);
assert.match(linkScript, /const success = new Set\(sameDate/);
assert.match(linkScript, /const failed = new Set\(sameDate/);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-login-recovery-queue-'));
try {
  const runtimeDir = path.join(temp, 'runtime');
  const logDir = path.join(temp, 'logs');
  const empty = spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'cloud_manual_login_recovery_queue.mjs'),
    '--runtime-dir', runtimeDir,
    '--log-dir', logDir,
  ], {cwd: process.cwd(), encoding: 'utf8'});
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).processed, 0);

  const queueDir = path.join(runtimeDir, 'queue');
  fs.writeFileSync(path.join(queueDir, 'bad.json'), JSON.stringify({schemaVersion: 'wrong'}), 'utf8');
  const invalid = spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'cloud_manual_login_recovery_queue.mjs'),
    '--runtime-dir', runtimeDir,
    '--log-dir', logDir,
  ], {cwd: process.cwd(), encoding: 'utf8'});
  assert.equal(invalid.status, 2);
  assert.equal(fs.existsSync(path.join(runtimeDir, 'failed', 'bad.json')), true);
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}

const serviceUnit = fs.readFileSync(new URL('../infra/systemd/shein-bi-cloud-manual-login-recovery.service', import.meta.url), 'utf8');
const pathUnit = fs.readFileSync(new URL('../infra/systemd/shein-bi-cloud-manual-login-recovery.path', import.meta.url), 'utf8');
const timerUnit = fs.readFileSync(new URL('../infra/systemd/shein-bi-cloud-manual-login-recovery.timer', import.meta.url), 'utf8');
assert.match(serviceUnit, /User=sheinops/);
assert.match(serviceUnit, /MemoryMax=3400M/);
assert.match(serviceUnit, /cloud_manual_login_recovery_queue\.mjs/);
assert.match(serviceUnit, /ExecCondition=.*shein-bi-cloud-daily-refresh\.service/);
assert.match(pathUnit, /DirectoryNotEmpty=\/srv\/shein-bi\/runtime\/cloud_manual_login_recovery\/queue/);
assert.match(timerUnit, /OnUnitInactiveSec=2min/);

console.log(JSON.stringify({ok: true, tests: 23}, null, 2));
