#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  assessDailyLinkBusinessRecovery,
  assessDailyMarketingGuardHealth,
  assessDailyMarketingRepairHealth,
  assessDailyMarketingScanRecovery,
  assessDailyOpenapiSalesRecovery,
  assessDailyOpenapiProductRecovery,
  assessSystemdOneshotResult,
  resolveMarketingScanEvidencePath,
} from '../lib/cloud_watchdog_recovery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nowMs = Date.parse('2026-07-11T12:30:00+08:00');
const stores = ['DL', 'DX', 'QY'];

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
assert.match(watchdogSource, /assessDailyOpenapiSalesRecovery/);
assert.match(watchdogSource, /daily_link_openapi_sales_recovery/);
assert.match(watchdogSource, /resolveMarketingScanEvidencePath/);
assert.match(watchdogSource, /recoveries,/);

const linkSyncSource = fs.readFileSync(path.join(root, 'scripts', 'cloud_link_business_sync.sh'), 'utf8');
assert.match(linkSyncSource, /link-business-last-success\.json/);
assert.match(linkSyncSource, /write_link_business_success true/);
assert.match(linkSyncSource, /targeted recovery completed prior partial/);
assert.match(linkSyncSource, /failed\.some\(store => !current\.has\(store\)\)/);
assert.match(linkSyncSource, /expected\.some\(store => !merged\.has\(store\)\)/);

console.log('cloud_watchdog_recovery: only newer complete all-store evidence resolves isolated marketing, link/business, or OpenAPI product warnings');
