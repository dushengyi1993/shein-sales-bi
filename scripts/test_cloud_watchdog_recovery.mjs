#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  assessDailyProfitSectionRecovery,
  assessDailyLinkBusinessRecovery,
  assessDailyMarketingGuardHealth,
  assessDailyMarketingRepairHealth,
  assessDailyMarketingScanRecovery,
  assessDailyOpenapiSalesRecovery,
  assessDailyOpenapiProductRecovery,
  assessSystemdOneshotResult,
  resolveMarketingScanEvidencePath,
} from '../lib/cloud_watchdog_recovery.mjs';
import {
  applyWatchdogMaintenanceTransition,
  bindWatchdogMaintenanceRecoveryDelivery,
  detachMaintenanceHeldAlertState,
  markWatchdogMaintenanceRecoverySent,
  mergeMaintenanceRecoveryNotification,
  partitionWatchdogMaintenanceChecks,
  persistWatchdogMaintenanceState,
  sourceIntegrityIssueFor,
  summarizeWatchdogMaintenanceStatus,
  watchdogIssueMaintenanceClass,
  watchdogMaintenanceConfigurationIssue,
  withWatchdogSingleInstance,
} from './cloud_ops_watchdog.mjs';
import {
  NO_KEY_RETRY_PROTECTED_KINDS,
  shouldRetryLegacyNoKeyFallback,
} from './notify_sync_issue.mjs';
import {acquireCrossProcessTicketLock} from '../lib/cross_process_ticket_lock.mjs';
import {DEFAULT_CLOUD_MAINTENANCE_FILE} from '../lib/cloud_maintenance_mode.mjs';
import {spawn} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nowMs = Date.parse('2026-07-11T12:30:00+08:00');
const stores = ['DL', 'DX', 'QY'];

const businessMaintenance = summarizeWatchdogMaintenanceStatus({
  schemaVersion: 'cloud-maintenance-mode/v1',
  ok: true,
  exists: true,
  active: true,
  mode: 'business',
  generation: 7,
  hash: 'a'.repeat(64),
  markerFile: DEFAULT_CLOUD_MAINTENANCE_FILE,
});
const allMaintenance = summarizeWatchdogMaintenanceStatus({
  ...businessMaintenance,
  ok: true,
  active: true,
  mode: 'all',
  generation: 8,
  hash: 'b'.repeat(64),
});
const invalidMaintenance = summarizeWatchdogMaintenanceStatus({
  schemaVersion: 'cloud-maintenance-mode/v1',
  ok: false,
  exists: true,
  active: null,
  mode: 'unknown',
  generation: null,
  hash: 'c'.repeat(64),
  errorCode: 'MAINTENANCE_MARKER_INVALID_JSON',
  markerFile: DEFAULT_CLOUD_MAINTENANCE_FILE,
});
const maintenanceChecks = [
  {
    id: 'scheduled-timer',
    unitClass: 'scheduled',
    issue: '定时器未运行：shein-bi-cloud-yesterday.timer state=inactive result=success',
  },
  {
    id: 'infrastructure-disk',
    unitClass: 'infrastructure',
    issue: '服务器硬盘检查失败：fixture',
  },
  {
    id: 'always-portal',
    unitClass: 'always',
    issue: '常驻服务未运行：shein-bi-portal.service state=failed result=exit-code',
  },
  {
    id: 'always-query',
    unitClass: 'always',
    issue: '常驻服务未运行：shein-bi-query.service state=failed result=exit-code',
  },
];
const businessPartition = partitionWatchdogMaintenanceChecks(businessMaintenance, maintenanceChecks);
assert.deepEqual(businessPartition.suppressed.map(row => row.id), ['scheduled-timer']);
assert.deepEqual(businessPartition.runnable.map(row => row.id), ['infrastructure-disk', 'always-portal', 'always-query']);
const allPartition = partitionWatchdogMaintenanceChecks(allMaintenance, maintenanceChecks);
assert.deepEqual(allPartition.suppressed.map(row => row.id), ['scheduled-timer', 'infrastructure-disk']);
assert.deepEqual(allPartition.runnable.map(row => row.id), ['always-portal', 'always-query']);
const invalidPartition = partitionWatchdogMaintenanceChecks(invalidMaintenance, maintenanceChecks);
assert.deepEqual(invalidPartition.suppressed.map(row => row.id), ['scheduled-timer', 'infrastructure-disk']);
assert.deepEqual(invalidPartition.runnable.map(row => row.id), ['always-portal', 'always-query']);
const invalidIssues = [
  watchdogMaintenanceConfigurationIssue(invalidMaintenance),
  ...invalidPartition.runnable.map(row => row.issue),
].filter(Boolean);
assert.equal(invalidIssues.filter(issue => issue.startsWith('维护模式配置故障（高优先级）')).length, 1);
assert.ok(invalidIssues.some(issue => issue.includes('shein-bi-portal.service')),
  'an always Portal anomaly must remain actionable during invalid maintenance state');
assert.ok(invalidIssues.some(issue => issue.includes('shein-bi-query.service')),
  'the always query surface must remain actionable during invalid maintenance state');
assert.equal(invalidIssues.some(issue => issue.startsWith('定时器未运行：')), false);
assert.equal(watchdogIssueMaintenanceClass(maintenanceChecks[0].issue), 'scheduled');
assert.equal(watchdogIssueMaintenanceClass(maintenanceChecks[1].issue), 'infrastructure');
assert.equal(watchdogIssueMaintenanceClass(maintenanceChecks[2].issue), 'always');
assert.equal(watchdogIssueMaintenanceClass(maintenanceChecks[3].issue), 'always');
assert.equal(watchdogIssueMaintenanceClass('生产部署证明无效：schema_version_invalid'), 'infrastructure');
const heldAlertState = detachMaintenanceHeldAlertState({
  schemaVersion: 'cloud-watchdog-alert-state/v1',
  episodes: {
    scheduled: {status: 'alerted', lastRaw: maintenanceChecks[0].issue},
    always: {status: 'alerted', lastRaw: maintenanceChecks[2].issue},
  },
  outbox: {
    scheduledIntent: {family: 'scheduled', status: 'pending', dispatchId: 'mixed'},
    alwaysIntent: {family: 'always', status: 'pending', dispatchId: 'mixed'},
  },
  dispatches: {
    mixed: {id: 'mixed', status: 'pending', intentIds: ['scheduledIntent', 'alwaysIntent']},
  },
}, businessMaintenance);
assert.deepEqual(heldAlertState.heldFamilies, ['scheduled']);
assert.equal(Object.hasOwn(heldAlertState.activeState.episodes, 'scheduled'), false,
  'maintenance-held alerts cannot be converted into false recoveries');
assert.equal(Object.hasOwn(heldAlertState.activeState.episodes, 'always'), true);
assert.deepEqual(heldAlertState.activeState.dispatches.mixed.intentIds, ['alwaysIntent']);
assert.equal(Object.hasOwn(heldAlertState.held.outbox.scheduledIntent, 'dispatchId'), false);

const activeTransition = applyWatchdogMaintenanceTransition({
  previousState: null,
  maintenance: businessMaintenance,
  now: new Date('2026-08-17T01:00:00.000Z'),
});
assert.equal(activeTransition.recoveryCreated, null);
assert.equal(activeTransition.nextState.activeEpisode.generation, 7);
const inactiveMaintenance = summarizeWatchdogMaintenanceStatus({
  schemaVersion: 'cloud-maintenance-mode/v1',
  ok: true,
  exists: true,
  active: false,
  mode: 'none',
  generation: 8,
  hash: 'd'.repeat(64),
  markerFile: DEFAULT_CLOUD_MAINTENANCE_FILE,
});
const firstInactive = applyWatchdogMaintenanceTransition({
  previousState: JSON.parse(JSON.stringify(activeTransition.nextState)),
  maintenance: inactiveMaintenance,
  now: new Date('2026-08-17T02:00:00.000Z'),
});
assert.equal(firstInactive.recoveryCreated?.from.mode, 'business');
assert.equal(firstInactive.pendingRecovery?.status, 'pending');
const mergedRecovery = mergeMaintenanceRecoveryNotification(
  ['首页利润数据已恢复'],
  firstInactive.pendingRecovery,
);
assert.equal(mergedRecovery.coalesced, true);
assert.equal(mergedRecovery.issues.length, 2);
assert.match(mergedRecovery.issues[1], /云端维护模式已恢复：mode=business generation=7/);
assert.deepEqual(mergeMaintenanceRecoveryNotification(['普通恢复'], null), {
  issues: ['普通恢复'],
  coalesced: false,
});
const deliveryBound = bindWatchdogMaintenanceRecoveryDelivery(
  firstInactive.nextState,
  firstInactive.pendingRecovery.key,
  'shared-recovery-dispatch-key',
  new Date('2026-08-17T02:00:01.000Z'),
);
assert.equal(deliveryBound.pendingRecovery.deliveryIdempotencyKey, 'shared-recovery-dispatch-key');
assert.equal(
  bindWatchdogMaintenanceRecoveryDelivery(
    deliveryBound,
    firstInactive.pendingRecovery.key,
    'shared-recovery-dispatch-key',
  ).pendingRecovery.deliveryIdempotencyKey,
  'shared-recovery-dispatch-key',
);
assert.throws(
  () => bindWatchdogMaintenanceRecoveryDelivery(
    deliveryBound,
    firstInactive.pendingRecovery.key,
    'different-recovery-dispatch-key',
  ),
  /idempotency key drifted/,
);
const reactivatedBeforeDelivery = applyWatchdogMaintenanceTransition({
  previousState: firstInactive.nextState,
  maintenance: allMaintenance,
  now: new Date('2026-08-17T02:30:00.000Z'),
});
assert.equal(reactivatedBeforeDelivery.pendingRecovery, null,
  'a stale recovery notification is cancelled if maintenance becomes active again');
const maintenanceStateTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-watchdog-maintenance-state-'));
try {
  const maintenanceStateFile = path.join(maintenanceStateTemp, 'maintenance-state.json');
  assert.equal(await persistWatchdogMaintenanceState(
    maintenanceStateFile,
    firstInactive.nextState,
    {dryRun: true},
  ), false);
  assert.equal(fs.existsSync(maintenanceStateFile), false, 'dry-run must not write maintenance state');
  assert.equal(await persistWatchdogMaintenanceState(maintenanceStateFile, firstInactive.nextState), true);
  const persisted = JSON.parse(fs.readFileSync(maintenanceStateFile, 'utf8'));
  const repeatedInactive = applyWatchdogMaintenanceTransition({
    previousState: persisted,
    maintenance: inactiveMaintenance,
    now: new Date('2026-08-17T03:00:00.000Z'),
  });
  assert.equal(repeatedInactive.recoveryCreated, null, 'inactive observations must not create duplicate recovery notes');
  const sentState = markWatchdogMaintenanceRecoverySent(
    repeatedInactive.nextState,
    repeatedInactive.pendingRecovery.key,
    new Date('2026-08-17T03:01:00.000Z'),
  );
  const afterSent = applyWatchdogMaintenanceTransition({
    previousState: sentState,
    maintenance: inactiveMaintenance,
    now: new Date('2026-08-17T04:00:00.000Z'),
  });
  assert.equal(afterSent.recoveryCreated, null);
  assert.equal(afterSent.pendingRecovery, null, 'sent recovery remains persistently deduplicated');
} finally {
  fs.rmSync(maintenanceStateTemp, {recursive: true, force: true});
}

const profitWarning = {date: '2026-08-12', generatedAt: '2026-08-13T08:46:32+08:00', message: 'profit mart refresh failed status=3'};
assert.equal(assessDailyProfitSectionRecovery({
  dailyRefresh: profitWarning,
  profitSection: {ok: true, section: 'profit', cachedAt: '2026-08-13T10:53:10+08:00'},
  nowMs: Date.parse('2026-08-13T11:50:00+08:00'),
}).recovered, true);
assert.equal(assessDailyProfitSectionRecovery({
  dailyRefresh: profitWarning,
  profitSection: {ok: true, section: 'profit', cachedAt: '2026-08-13T08:40:00+08:00'},
  nowMs: Date.parse('2026-08-13T11:50:00+08:00'),
}).reason, 'profit_section_not_newer_than_warning');
assert.equal(assessDailyProfitSectionRecovery({
  dailyRefresh: profitWarning,
  profitSection: {ok: false, section: 'profit', cachedAt: '2026-08-13T10:53:10+08:00'},
  nowMs: Date.parse('2026-08-13T11:50:00+08:00'),
}).reason, 'profit_section_not_complete');

const expectedConditionSkip = assessSystemdOneshotResult({
  ActiveState: 'inactive',
  Result: 'exec-condition',
  ExecMainStatus: '0',
});
assert.equal(expectedConditionSkip.expectedConditionSkip, true);
assert.equal(expectedConditionSkip.resultOk, true);
assert.equal(expectedConditionSkip.abnormalExit, false);
assert.equal(expectedConditionSkip.abnormalState, false);

const timedOutOneshot = assessSystemdOneshotResult({
  ActiveState: 'failed',
  Result: 'timeout',
  ExecMainStatus: '124',
});
assert.equal(timedOutOneshot.resultOk, false);
assert.equal(timedOutOneshot.abnormalExit, true);
assert.equal(timedOutOneshot.abnormalState, true);

const openapiSalesDaily = {
  date: '2026-07-24',
  generatedAt: '2026-07-25T01:14:41.000Z',
  status: 'warning',
  message: 'openapi reconciliation failed',
};
const openapiSalesReport = {
  ok: true,
  date: '2026-07-24',
  generatedAt: '2026-07-25T03:44:17.000Z',
  requestedStores: stores,
  counts: {total: 3, succeeded: 3, failed: 0, matched: 3, warning: 0, missingBrowser: 0, skipped: 0},
  results: stores.map(storeKey => ({storeKey, ok: true, status: 'matched'})),
};
assert.equal(assessDailyOpenapiSalesRecovery({
  dailyRefresh: openapiSalesDaily,
  salesReport: openapiSalesReport,
  expectedStoreKeys: stores,
  nowMs: Date.parse('2026-07-25T12:00:00+08:00'),
}).recovered, true);
assert.equal(assessDailyOpenapiSalesRecovery({
  dailyRefresh: openapiSalesDaily,
  salesReport: {...openapiSalesReport, counts: {...openapiSalesReport.counts, matched: 2}},
  expectedStoreKeys: stores,
}).reason, 'openapi_sales_recovery_store_coverage_incomplete');

const guardRetryPending = assessDailyMarketingGuardHealth({
  guardState: {date: '2026-07-18', generatedAt: '2026-07-18T02:31:00.000Z', status: 'warning'},
  lastOkState: null,
  nowMs: Date.parse('2026-07-18T13:50:00+08:00'),
});
assert.equal(guardRetryPending.healthy, true);
assert.equal(guardRetryPending.pending, true);
assert.equal(guardRetryPending.reason, 'retry_window_open');

const guardFinalFailure = assessDailyMarketingGuardHealth({
  guardState: {date: '2026-07-18', generatedAt: '2026-07-18T08:45:00.000Z', status: 'warning'},
  lastOkState: {date: '2026-07-17', generatedAt: '2026-07-17T08:45:00.000Z', status: 'ok'},
  nowMs: Date.parse('2026-07-18T17:50:00+08:00'),
});
assert.equal(guardFinalFailure.healthy, false);
assert.equal(guardFinalFailure.reason, 'today_success_missing');

const guardFinalStillRunning = assessDailyMarketingGuardHealth({
  guardState: {date: '2026-07-18', generatedAt: '2026-07-18T08:31:00.000Z', status: 'warning'},
  lastOkState: {date: '2026-07-17', generatedAt: '2026-07-17T08:45:00.000Z', status: 'ok'},
  guardRunning: true,
  guardStartedAt: '2026-07-18T17:30:00+08:00',
  nowMs: Date.parse('2026-07-18T17:50:00+08:00'),
});
assert.equal(guardFinalStillRunning.healthy, true);
assert.equal(guardFinalStillRunning.pending, true);
assert.equal(guardFinalStillRunning.reason, 'final_run_active');
const guardOverdue = assessDailyMarketingGuardHealth({
  guardState: {date: '2026-07-18', status: 'warning'},
  guardRunning: true,
  guardStartedAt: '2026-07-18T16:00:00+08:00',
  nowMs: Date.parse('2026-07-18T17:50:00+08:00'),
});
assert.equal(guardOverdue.healthy, false);
assert.equal(guardOverdue.reason, 'final_run_overdue');

const guardFinalSuccess = assessDailyMarketingGuardHealth({
  guardState: {date: '2026-07-18', generatedAt: '2026-07-18T08:40:00.000Z', status: 'ok'},
  lastOkState: {date: '2026-07-18', generatedAt: '2026-07-18T08:40:00.000Z', status: 'ok'},
  nowMs: Date.parse('2026-07-18T17:50:00+08:00'),
});
assert.equal(guardFinalSuccess.healthy, true);
assert.equal(guardFinalSuccess.pending, false);
assert.equal(guardFinalSuccess.reason, 'today_success_verified');

const guardFailedAfterSuccess = assessDailyMarketingGuardHealth({
  guardState: {date: '2026-07-18', generatedAt: '2026-07-18T09:00:00.000Z', status: 'failed'},
  lastOkState: {date: '2026-07-18', generatedAt: '2026-07-18T08:40:00.000Z', status: 'ok'},
  nowMs: Date.parse('2026-07-18T17:50:00+08:00'),
});
assert.equal(guardFailedAfterSuccess.healthy, false);
assert.equal(guardFailedAfterSuccess.reason, 'newer_failure_after_success');

const repairPending = assessDailyMarketingRepairHealth({
  queueState: {date: '2026-07-18', status: 'pending', counts: {totalRows: 61, totalGroups: 32}},
  nowMs: Date.parse('2026-07-18T18:30:00+08:00'),
});
assert.equal(repairPending.healthy, true);
assert.equal(repairPending.pending, true);
assert.equal(repairPending.reason, 'repair_windows_open');
const repairRunningAfterDeadline = assessDailyMarketingRepairHealth({
  queueState: {date: '2026-07-18', status: 'pending'},
  repairRunning: true,
  repairStartedAt: '2026-07-18T20:00:00+08:00',
  nowMs: Date.parse('2026-07-18T20:30:00+08:00'),
});
assert.equal(repairRunningAfterDeadline.reason, 'repair_worker_active');
const repairOverdueAfterDeadline = assessDailyMarketingRepairHealth({
  queueState: {date: '2026-07-18', status: 'pending'},
  repairRunning: true,
  repairStartedAt: '2026-07-18T19:00:00+08:00',
  nowMs: Date.parse('2026-07-18T20:30:00+08:00'),
});
assert.equal(repairOverdueAfterDeadline.healthy, false);
assert.equal(repairOverdueAfterDeadline.reason, 'repair_worker_overdue');
const repairFailedAfterDeadline = assessDailyMarketingRepairHealth({
  queueState: {date: '2026-07-18', status: 'failed'},
  repairState: {status: 'failed'},
  nowMs: Date.parse('2026-07-18T20:30:00+08:00'),
});
assert.equal(repairFailedAfterDeadline.healthy, false);
assert.equal(repairFailedAfterDeadline.reason, 'repair_queue_failed');
const repairCompleted = assessDailyMarketingRepairHealth({
  queueState: {date: '2026-07-18', status: 'completed', counts: {totalRows: 0, totalGroups: 0}},
  nowMs: Date.parse('2026-07-18T20:30:00+08:00'),
});
assert.equal(repairCompleted.healthy, true);
assert.equal(repairCompleted.reason, 'today_repair_queue_completed');
const repairBlocked = assessDailyMarketingRepairHealth({
  queueState: {date: '2026-07-18', status: 'blocked', counts: {totalRows: 7, totalGroups: 6}},
  repairState: {status: 'blocked'},
  nowMs: Date.parse('2026-07-18T20:30:00+08:00'),
});
assert.equal(repairBlocked.healthy, true);
assert.equal(repairBlocked.pending, false);
assert.equal(repairBlocked.reason, 'today_repair_queue_blocked_and_reported');
const repairDeferredToLocal = assessDailyMarketingRepairHealth({
  queueState: {date: '2026-07-18', status: 'pending', counts: {totalRows: 23, totalGroups: 13}},
  repairState: {date: '2026-07-18', status: 'deferred_to_local'},
  nowMs: Date.parse('2026-07-18T20:30:00+08:00'),
});
assert.equal(repairDeferredToLocal.healthy, true);
assert.equal(repairDeferredToLocal.pending, true);
assert.equal(repairDeferredToLocal.reason, 'today_repair_queue_deferred_to_local');
const dailyRefresh = {
  date: '2026-07-10',
  generatedAt: '2026-07-11T09:17:54+08:00',
  status: 'warning',
  message: 'marketing price scan failed',
};
const guardState = {
  date: '2026-07-11',
  generatedAt: '2026-07-11T02:49:44.862Z',
  status: 'warning',
  scanFile: '/opt/shein-bi/app/tmp/marketing-signup/current-price-live/current-marketing-price-live-final.json',
};
const scanSnapshot = {
  ok: true,
  partial: false,
  updatedAt: '2026-07-11T02:49:43.843Z',
  rowCount: stores.length,
  rows: stores.map(store => ({store})),
  stores: stores.map(store => ({store, ok: true, rows: [{store}]})),
};

const recovered = assessDailyMarketingScanRecovery({dailyRefresh, guardState, scanSnapshot, expectedStoreKeys: stores, nowMs});
assert.equal(recovered.recovered, true);
assert.equal(recovered.evidence.successfulStores, 3);
assert.equal(recovered.evidence.guardStatus, 'warning', 'an unrelated guard action warning must not invalidate a complete scan');

assert.equal(assessDailyMarketingScanRecovery({
  dailyRefresh: {...dailyRefresh, message: 'marketing price scan failed RTV failed'},
  guardState,
  scanSnapshot,
  expectedStoreKeys: stores,
  nowMs,
}).reason, 'daily_warning_not_scan_only');

assert.equal(assessDailyMarketingScanRecovery({
  dailyRefresh,
  guardState,
  scanSnapshot: {...scanSnapshot, stores: scanSnapshot.stores.map(row => row.store === 'QY' ? {...row, ok: false} : row)},
  expectedStoreKeys: stores,
  nowMs,
}).reason, 'recovery_store_coverage_incomplete');

assert.equal(assessDailyMarketingScanRecovery({
  dailyRefresh,
  guardState,
  scanSnapshot: {...scanSnapshot, stores: [...scanSnapshot.stores, {store: 'QY', ok: true}]},
  expectedStoreKeys: stores,
  nowMs,
}).reason, 'recovery_store_rows_duplicated');

assert.equal(assessDailyMarketingScanRecovery({
  dailyRefresh,
  guardState,
  scanSnapshot: {...scanSnapshot, rowCount: scanSnapshot.rowCount + 1},
  expectedStoreKeys: stores,
  nowMs,
}).reason, 'recovery_row_count_invalid');

assert.equal(assessDailyMarketingScanRecovery({
  dailyRefresh,
  guardState,
  scanSnapshot: {...scanSnapshot, stores: scanSnapshot.stores.map(row => row.store === 'QY' ? {...row, rows: []} : row)},
  expectedStoreKeys: stores,
  nowMs,
}).reason, 'recovery_store_payload_incomplete');

assert.equal(assessDailyMarketingScanRecovery({
  dailyRefresh,
  guardState,
  scanSnapshot: {...scanSnapshot, updatedAt: '2026-07-11T00:30:00.000Z'},
  expectedStoreKeys: stores,
  nowMs,
}).reason, 'recovery_not_newer_than_daily_warning');

assert.equal(assessDailyMarketingScanRecovery({
  dailyRefresh,
  guardState: {...guardState, generatedAt: '2026-07-11T10:00:00.000Z'},
  scanSnapshot: {...scanSnapshot, updatedAt: '2026-07-11T09:59:00.000Z'},
  expectedStoreKeys: stores,
  nowMs: Date.parse('2026-07-12T12:30:00+08:00'),
  maxScanAgeHours: 1,
}).reason, 'recovery_scan_stale');

const fakeRoot = path.join(os.tmpdir(), 'shein-watchdog-path-root');
const validPath = path.join(fakeRoot, 'tmp', 'marketing-signup', 'current-price-live', 'scan.json');
assert.equal(resolveMarketingScanEvidencePath(fakeRoot, validPath), path.resolve(validPath));
assert.equal(resolveMarketingScanEvidencePath(fakeRoot, path.join(fakeRoot, 'config', 'stores.json')), null);
assert.equal(resolveMarketingScanEvidencePath(fakeRoot, path.join(fakeRoot, 'tmp', 'marketing-signup', 'current-price-live', '..', '..', '..', 'config.json')), null);
assert.equal(resolveMarketingScanEvidencePath(fakeRoot, 'relative-scan.json'), null);

const dailyLinkRefresh = {
  date: '2026-07-16',
  generatedAt: '2026-07-17T02:50:00.000Z',
  status: 'warning',
  message: 'link-business partial',
};
const linkSuccess = {
  ok: true,
  date: '2026-07-16',
  generatedAt: '2026-07-17T08:30:00.000Z',
  successfulStores: stores,
  failedStores: [],
  metricReady: true,
  warehouseLoaded: true,
  portalRefreshed: true,
  logFile: '/srv/shein-bi/logs/cloud-link-business/repair.log',
};
const recoveredLink = assessDailyLinkBusinessRecovery({
  dailyRefresh: dailyLinkRefresh,
  linkSuccess,
  expectedStoreKeys: stores,
  nowMs: Date.parse('2026-07-17T17:00:00+08:00'),
});
assert.equal(recoveredLink.recovered, true);
assert.equal(recoveredLink.evidence.successfulStores, 3);
assert.equal(recoveredLink.evidence.portalRefreshed, true);

assert.equal(assessDailyLinkBusinessRecovery({
  dailyRefresh: {...dailyLinkRefresh, message: 'link-business partial RTV failed'},
  linkSuccess,
  expectedStoreKeys: stores,
}).reason, 'daily_warning_not_link_business_only');

assert.equal(assessDailyLinkBusinessRecovery({
  dailyRefresh: dailyLinkRefresh,
  linkSuccess: {...linkSuccess, generatedAt: '2026-07-17T02:40:00.000Z'},
  expectedStoreKeys: stores,
}).reason, 'link_business_recovery_not_newer_than_daily_warning');

assert.equal(assessDailyLinkBusinessRecovery({
  dailyRefresh: dailyLinkRefresh,
  linkSuccess: {...linkSuccess, portalRefreshed: false},
  expectedStoreKeys: stores,
  nowMs: Date.parse('2026-07-17T17:00:00+08:00'),
}).reason, 'link_business_recovery_not_complete');

assert.equal(assessDailyLinkBusinessRecovery({
  dailyRefresh: dailyLinkRefresh,
  linkSuccess: {...linkSuccess, date: '2026-07-15'},
  expectedStoreKeys: stores,
  nowMs: Date.parse('2026-07-17T17:00:00+08:00'),
}).reason, 'link_business_recovery_date_mismatch');

assert.equal(assessDailyLinkBusinessRecovery({
  dailyRefresh: dailyLinkRefresh,
  linkSuccess: {...linkSuccess, successfulStores: stores.slice(0, 2)},
  expectedStoreKeys: stores,
  nowMs: Date.parse('2026-07-17T17:00:00+08:00'),
}).reason, 'link_business_recovery_store_coverage_incomplete');

const dailyProductRefresh = {
  date: '2026-07-15',
  generatedAt: '2026-07-16T01:00:00.000Z',
  status: 'warning',
  message: 'openapi product reconciliation failed',
};
const productReport = {
  ok: true,
  generatedAt: '2026-07-17T01:00:00.000Z',
  ensure: {ok: true},
  counts: {failed: 0, matched: 2, warning: 1},
  results: stores.map(storeKey => ({storeKey, ok: true, status: 'matched'})),
};
const recoveredProduct = assessDailyOpenapiProductRecovery({
  dailyRefresh: dailyProductRefresh,
  productReport,
  expectedStoreKeys: stores,
  nowMs: Date.parse('2026-07-17T12:00:00.000Z'),
});
assert.equal(recoveredProduct.recovered, true);
assert.equal(recoveredProduct.evidence.successfulStores, 3);
assert.equal(assessDailyOpenapiProductRecovery({
  dailyRefresh: {...dailyProductRefresh, message: 'openapi product reconciliation failed RTV failed'},
  productReport,
  expectedStoreKeys: stores,
}).reason, 'daily_warning_not_openapi_product_only');
assert.equal(assessDailyOpenapiProductRecovery({
  dailyRefresh: dailyProductRefresh,
  productReport: {...productReport, results: productReport.results.slice(0, 2)},
  expectedStoreKeys: stores,
  nowMs: Date.parse('2026-07-17T12:00:00.000Z'),
}).reason, 'openapi_product_recovery_store_coverage_incomplete');

const watchdogSource = fs.readFileSync(path.join(root, 'scripts', 'cloud_ops_watchdog.mjs'), 'utf8');
assert.equal(
  (watchdogSource.match(/await readCloudMaintenanceStatus\(/g) || []).length,
  1,
  'each watchdog run must read the canonical maintenance marker exactly once',
);
assert.match(watchdogSource, /maintenanceHeldIssueCount/);
assert.match(watchdogSource, /maintenanceRecoveryCoalesced/);
assert.ok(watchdogSource.includes('await writeJsonFileAtomic(file, value);'),
  'watchdog maintenance/alert outbox state must use the fsyncing atomic publisher');
assert.match(watchdogSource, /deployedReleaseValidation/);
assert.match(watchdogSource, /kind: 'cloud-watchdog-recovery'/);
assert.match(watchdogSource, /intentionalSuppressed/);
assert.match(watchdogSource, /state=not-found result=.*ALWAYS_RUNNING_UNITS|ALWAYS_RUNNING_UNITS[\s\S]*state=not-found result=/);
assert.match(watchdogSource, /if \(!args\.dryRun\) \{/);
assert.match(watchdogSource, /assessDailyMarketingScanRecovery/);
assert.match(watchdogSource, /assessDailyMarketingGuardHealth/);
assert.match(watchdogSource, /assessDailyMarketingRepairHealth/);
assert.match(watchdogSource, /assessDailyLinkBusinessRecovery/);
assert.match(watchdogSource, /assessDailyOpenapiProductRecovery/);
assert.match(watchdogSource, /assessOpenapiProductReport/);
assert.match(watchdogSource, /productReconciliationHealth/);
assert.match(watchdogSource, /inspectReleaseSourceState/);
assert.match(watchdogSource, /deployed_release\.json/);
assert.match(watchdogSource, /releaseSourceState/);
assert.match(watchdogSource, /systemdSnapshot\.ok/);
assert.match(watchdogSource, /systemd 批量快照不完整/);
assert.match(watchdogSource, /assessDailyOpenapiSalesRecovery/);
assert.match(watchdogSource, /daily_link_openapi_sales_recovery/);
assert.match(watchdogSource, /resolveMarketingScanEvidencePath/);
assert.match(watchdogSource, /recoveries,/);

// Source integrity must fail closed for every kind of tracked-source drift,
// including the dirty/hidden cases the old logic silently downgraded to a
// quiet ops-group note. Each raw field is asserted independently so a stale
// truthy ok flag can never produce a watchdog false green.
const cleanSourceState = {
  ok: true,
  commitMatches: true,
  dirtyEntries: [],
  hiddenIndexEntries: [],
  missingTrackedFiles: [],
};
assert.equal(sourceIntegrityIssueFor(cleanSourceState), null, 'a clean tracked source must stay green');
const dirtyOnly = sourceIntegrityIssueFor({
  ...cleanSourceState,
  ok: false,
  dirtyEntries: [' M scripts/serve_bi_portal.mjs'],
});
assert.ok(dirtyOnly && /dirty=1/.test(dirtyOnly), `a dirty tracked edit must issue, got: ${dirtyOnly}`);
const hiddenOnly = sourceIntegrityIssueFor({
  ...cleanSourceState,
  ok: false,
  hiddenIndexEntries: ['scripts/config.json'],
});
assert.ok(hiddenOnly && /hidden=1/.test(hiddenOnly), `a hidden index entry must issue, got: ${hiddenOnly}`);
const missingOnly = sourceIntegrityIssueFor({
  ...cleanSourceState,
  ok: false,
  missingTrackedFiles: ['scripts/missing.mjs'],
});
assert.ok(missingOnly && /missing=1/.test(missingOnly), `a missing tracked file must issue, got: ${missingOnly}`);
const commitDrift = sourceIntegrityIssueFor({...cleanSourceState, ok: false, commitMatches: false});
assert.ok(commitDrift && /commitMatch=false/.test(commitDrift), `commit drift must issue, got: ${commitDrift}`);
const combined = sourceIntegrityIssueFor({
  ...cleanSourceState,
  ok: false,
  commitMatches: false,
  dirtyEntries: [' M a'],
  hiddenIndexEntries: ['b'],
  missingTrackedFiles: ['c'],
});
assert.match(combined, /commitMatch=false dirty=1 hidden=1 missing=1/);
assert.ok(sourceIntegrityIssueFor({...cleanSourceState, dirtyEntries: [' M x']}),
  'a stale truthy ok flag with dirty entries must never stay green');
assert.ok(sourceIntegrityIssueFor({ok: false, error: 'boom'}),
  'an inspection failure shape must fail closed instead of degrading to a note');
assert.equal(watchdogSource.indexOf('服务器运行目录有未发布改动'), -1,
  'tracked source drift must never be downgraded to a silent ops-group note');
assert.match(watchdogSource, /const sourceIntegrityIssue = sourceIntegrityIssueFor\(releaseSourceState\);\n\s*if \(sourceIntegrityIssue\) issues\.push\(sourceIntegrityIssue\);/,
  'the source-integrity issue must be pushed directly without a maintenance-suppression wrapper');
assert.match(watchdogSource, /const classIsSuppressed = unitClass => maintenanceGuardAudit\.ok\s*\n\s*&& watchdogMaintenanceBlocksClass/,
  'class-level suppression must remain disabled whenever loaded maintenance guards are unproven');

const linkSyncSource = fs.readFileSync(path.join(root, 'scripts', 'cloud_link_business_sync.sh'), 'utf8');
assert.match(linkSyncSource, /link-business-last-success\.json/);
assert.match(linkSyncSource, /write_link_business_success true/);
assert.match(linkSyncSource, /targeted recovery completed prior partial/);
assert.match(linkSyncSource, /failed\.some\(store => !current\.has\(store\)\)/);
assert.match(linkSyncSource, /expected\.some\(store => !merged\.has\(store\)\)/);

function runWatchdogCli(args = [], {timeoutMs = 0} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/cloud_ops_watchdog.mjs', ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs) : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({code, stdout, stderr, timedOut});
    });
  });
}

function singleInstanceTicketCount(stateDir) {
  const ticketDir = path.join(stateDir, 'cloud-ops-watchdog.single-instance.lock.tickets');
  if (!fs.existsSync(ticketDir)) return 0;
  return fs.readdirSync(ticketDir).filter(name => name.endsWith('.json')).length;
}

// Cross-process single-instance lock: a concurrent duplicate must skip fast
// with an explicit already-running report and must never change watchdog
// state or logs.  Normal and exception paths must release the ticket.
const singleInstanceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-watchdog-single-instance-'));
try {
  const skipStateDir = path.join(singleInstanceRoot, 'skip-state');
  const skipLogDir = path.join(singleInstanceRoot, 'skip-logs');
  const skipLockPath = path.join(skipStateDir, 'cloud-ops-watchdog.single-instance.lock');
  const holder = await acquireCrossProcessTicketLock(skipLockPath, {timeoutMs: 15_000});
  try {
    const skipped = await withWatchdogSingleInstance(
      {stateDir: skipStateDir, logDir: skipLogDir},
      () => { throw new Error('watchdog body must never run while another instance holds the lock'); },
      {lockTimeoutMs: 200},
    );
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.lockPath, skipLockPath);
    assert.equal(fs.existsSync(path.join(skipStateDir, 'maintenance-state.json')), false,
      'a skipped duplicate must not write maintenance state');
    assert.equal(fs.existsSync(path.join(skipStateDir, 'alert-state.json')), false,
      'a skipped duplicate must not write alert state');
    assert.equal(fs.existsSync(path.join(skipStateDir, 'last-issue-key.txt')), false,
      'a skipped duplicate must not write the legacy marker');
    assert.equal(fs.existsSync(skipLogDir) ? fs.readdirSync(skipLogDir).length : 0, 0,
      'a skipped duplicate must not write watchdog logs');
  } finally {
    await holder();
  }
  assert.equal(singleInstanceTicketCount(skipStateDir), 0,
    'a skipped duplicate must leave no lock ticket behind');

  const ranBody = [];
  const acquiredOutcome = await withWatchdogSingleInstance(
    {stateDir: path.join(singleInstanceRoot, 'run-state')},
    () => { ranBody.push('body'); return 42; },
  );
  assert.equal(acquiredOutcome.skipped, false);
  assert.equal(acquiredOutcome.result, 42);
  assert.deepEqual(ranBody, ['body']);
  assert.equal(singleInstanceTicketCount(path.join(singleInstanceRoot, 'run-state')), 0,
    'a completed run must release its lock ticket');

  await assert.rejects(
    withWatchdogSingleInstance(
      {stateDir: path.join(singleInstanceRoot, 'exception-state')},
      () => { throw new Error('simulated watchdog body failure'); },
    ),
    /simulated watchdog body failure/,
  );
  assert.equal(singleInstanceTicketCount(path.join(singleInstanceRoot, 'exception-state')), 0,
    'an exception inside the watchdog body must still release the lock');

  // CLI-level: a concurrent duplicate of the real invocation must report
  // already-running with exit 0 and write no state or logs.
  const cliStateDir = path.join(singleInstanceRoot, 'cli-state');
  const cliLogDir = path.join(singleInstanceRoot, 'cli-logs');
  const cliHolder = await acquireCrossProcessTicketLock(
    path.join(cliStateDir, 'cloud-ops-watchdog.single-instance.lock'),
    {timeoutMs: 15_000},
  );
  let cliResult;
  try {
    cliResult = await runWatchdogCli([
      '--state-dir', cliStateDir,
      '--log-dir', cliLogDir,
      '--portal-data', path.join(singleInstanceRoot, 'data.json'),
      '--maintenance-file', path.join(singleInstanceRoot, 'maintenance.json'),
      '--lock-timeout-ms', '200',
    ]);
  } finally {
    await cliHolder();
  }
  assert.equal(cliResult.code, 0, cliResult.stderr);
  const cliJson = cliResult.stdout.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop();
  const cliParsed = JSON.parse(cliJson);
  assert.equal(cliParsed.ok, true);
  assert.equal(cliParsed.skipped, true);
  assert.equal(cliParsed.alreadyRunning, true);
  assert.match(cliParsed.reason, /already running/);
  assert.match(cliParsed.lockPath, /cloud-ops-watchdog\.single-instance\.lock$/);
  assert.equal(fs.existsSync(path.join(cliStateDir, 'maintenance-state.json')), false,
    'the skipped CLI duplicate must not write maintenance state');
  assert.equal(fs.existsSync(path.join(cliStateDir, 'alert-state.json')), false);
  assert.equal(fs.existsSync(path.join(cliStateDir, 'last-issue-key.txt')), false);
  assert.equal(fs.existsSync(cliLogDir) ? fs.readdirSync(cliLogDir).length : 0, 0,
    'the skipped CLI duplicate must not write logs');
  assert.equal(singleInstanceTicketCount(cliStateDir), 0,
    'release must clear the ticket directory after the CLI duplicate exits');
} finally {
  fs.rmSync(singleInstanceRoot, {recursive: true, force: true});
}

// A watchdog --dry-run must be strictly zero-write: it may read state, logs,
// and live sources, but it must not create the single-instance lock, its
// ticket directory, state markers, caches, or logs. The controlled runtime
// tree must stay byte/mtime/hash identical around the run.
const dryRunRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-watchdog-dryrun-zero-write-'));
try {
  fs.writeFileSync(path.join(dryRunRoot, 'data.json'), '{}');
  fs.writeFileSync(path.join(dryRunRoot, 'maintenance.json'), '{}');
  const snapshotDryRunTree = () => {
    const rows = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        const stat = fs.statSync(full);
        rows.push({
          relative: path.relative(dryRunRoot, full),
          kind: entry.isDirectory() ? 'dir' : 'file',
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha: entry.isDirectory()
            ? ''
            : crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
        });
        if (entry.isDirectory()) walk(full);
      }
    };
    walk(dryRunRoot);
    return rows.sort((a, b) => String(a.relative).localeCompare(String(b.relative)));
  };
  const dryRunStateDir = path.join(dryRunRoot, 'state');
  const dryRunLogDir = path.join(dryRunRoot, 'logs');
  const beforeDryRunTree = snapshotDryRunTree();
  const dryRunResult = await runWatchdogCli([
    '--dry-run',
    '--state-dir', dryRunStateDir,
    '--log-dir', dryRunLogDir,
    '--portal-data', path.join(dryRunRoot, 'data.json'),
    '--maintenance-file', path.join(dryRunRoot, 'maintenance.json'),
  ], {timeoutMs: 90_000});
 assert.equal(dryRunResult.timedOut, false, 'a dry-run must complete within the bound');
 assert.equal(dryRunResult.code, 0, dryRunResult.stderr);
 const dryRunParsed = JSON.parse(
    dryRunResult.stdout.slice(
      dryRunResult.stdout.indexOf('{'),
      dryRunResult.stdout.lastIndexOf('}') + 1,
    ),
 );
  assert.equal(dryRunParsed.maintenance.dryRunStateWriteSuppressed, true);
  assert.deepEqual(
    snapshotDryRunTree(),
    beforeDryRunTree,
    'a watchdog dry-run must leave the controlled tree, bytes, mtimes, and hashes identical',
  );
  assert.equal(fs.existsSync(dryRunStateDir), false, 'a dry-run must not create the state directory');
  assert.equal(fs.existsSync(dryRunLogDir), false, 'a dry-run must not create the log directory');
  assert.equal(
    fs.existsSync(path.join(dryRunRoot, 'state', 'cloud-ops-watchdog.single-instance.lock.tickets')),
    false,
    'a dry-run must not create the single-instance lock ticket directory',
  );
} finally {
  fs.rmSync(dryRunRoot, {recursive: true, force: true});
}

// notify_sync_issue retry policy: cloud-watchdog / cloud-watchdog-recovery /
// webhook must never retry a failed send without --idempotency-key, while
// ordinary kinds keep the legacy no-key fallback for field-validation errors.
assert.deepEqual(
  [...NO_KEY_RETRY_PROTECTED_KINDS].sort(),
  ['cloud-watchdog', 'cloud-watchdog-recovery', 'webhook'],
);
for (const kind of NO_KEY_RETRY_PROTECTED_KINDS) {
  assert.equal(
    shouldRetryLegacyNoKeyFallback({kind, ok: false, output: 'lark-cli: field validation failed: as'}),
    false,
    `${kind} must never drop --idempotency-key after a field validation failure`,
  );
}
assert.equal(shouldRetryLegacyNoKeyFallback({kind: 'Cloud-Watchdog', ok: false, output: 'FIELD VALIDATION FAILED: x'}), false,
  'kind matching must be case-insensitive and stay protected');
assert.equal(shouldRetryLegacyNoKeyFallback({kind: 'sync', ok: false, output: 'field validation failed: as'}), true,
  'an ordinary sync kind keeps the legacy no-key fallback');
assert.equal(shouldRetryLegacyNoKeyFallback({kind: 'marketing', ok: false, output: 'field validation failed: as'}), true,
  'an ordinary marketing kind keeps the legacy no-key fallback');
assert.equal(shouldRetryLegacyNoKeyFallback({kind: '', ok: false, output: 'field validation failed: as'}), true,
  'an unspecified kind keeps the legacy no-key fallback');
assert.equal(shouldRetryLegacyNoKeyFallback({kind: 'sync', ok: false, output: 'other error'}), false,
  'a non-field-validation failure never triggers the no-key fallback');
assert.equal(shouldRetryLegacyNoKeyFallback({kind: 'cloud-watchdog', ok: true, output: 'field validation failed'}), false,
  'a successful send never retries');

// The operative guard in notify_sync_issue.mjs must exclude all three
// protected kinds from the no-key retry while ordinary kinds keep the
// legacy fallback.
const notifySource = fs.readFileSync(path.join(root, 'scripts', 'notify_sync_issue.mjs'), 'utf8');
assert.match(notifySource, /if \(!isWebhook && !res\.ok && !isCloudWatchdog && !isCloudWatchdogRecovery/,
  'the operative no-key retry guard must exclude webhook, cloud-watchdog and cloud-watchdog-recovery');
assert.doesNotMatch(notifySource, /!res\.ok && \/field validation failed\//,
  'the guard must no longer retry a protected kind directly without an idempotency key');

console.log(JSON.stringify({
  ok: true,
  checks: [
    'existing_business_recovery_contracts',
    'maintenance_business_suppression',
    'maintenance_all_suppression',
    'invalid_marker_single_fail_closed_issue',
    'always_portal_and_query_remain_actionable',
    'maintenance_alert_episode_hold',
    'maintenance_recovery_once',
    'maintenance_dry_run_no_state_write',
    'canonical_marker_single_read',
    'source_integrity_dirty_hidden_fail_closed',
    'single_instance_lock_skip_clean',
    'single_instance_lock_release_and_exception',
    'watchdog_dry_run_zero_write',
    'notify_protected_kinds_no_nokey_retry',
    'notify_ordinary_kinds_unaffected',
  ],
}, null, 2));
