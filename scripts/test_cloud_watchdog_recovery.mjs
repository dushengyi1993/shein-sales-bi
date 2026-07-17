#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  assessDailyLinkBusinessRecovery,
  assessDailyMarketingScanRecovery,
  resolveMarketingScanEvidencePath,
} from '../lib/cloud_watchdog_recovery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nowMs = Date.parse('2026-07-11T12:30:00+08:00');
const stores = ['DL', 'DX', 'QY'];
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

const watchdogSource = fs.readFileSync(path.join(root, 'scripts', 'cloud_ops_watchdog.mjs'), 'utf8');
assert.match(watchdogSource, /assessDailyMarketingScanRecovery/);
assert.match(watchdogSource, /assessDailyLinkBusinessRecovery/);
assert.match(watchdogSource, /resolveMarketingScanEvidencePath/);
assert.match(watchdogSource, /recoveries,/);

const linkSyncSource = fs.readFileSync(path.join(root, 'scripts', 'cloud_link_business_sync.sh'), 'utf8');
assert.match(linkSyncSource, /link-business-last-success\.json/);
assert.match(linkSyncSource, /write_link_business_success true/);

console.log('cloud_watchdog_recovery: only newer complete all-store evidence resolves isolated marketing or link/business warnings');
