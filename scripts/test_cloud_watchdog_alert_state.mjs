#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  applyWatchdogAlertState,
  deriveWatchdogIssueFamily,
  legacyIssueSetKey,
  markWatchdogOutboxSent,
  markWatchdogDispatchSent,
  migrateLegacyWatchdogState,
  pendingWatchdogDispatches,
  prepareWatchdogDispatches,
} from '../lib/cloud_watchdog_alert_state.mjs';

const BASE_MS = new Date('2026-08-13T00:50:00+08:00').getTime();
const at = hour => new Date(BASE_MS + hour * 3_600_000);
const run = (state, issues, hour, extra = {}) => applyWatchdogAlertState({previousState: state, issues, now: at(hour), ...extra});
const stockA = '服务异常：shein-bi-cloud-openapi-stock-refresh.service state=failed result=exit-code exit=1 code=1';
const stockB = '服务异常：shein-bi-cloud-openapi-stock-refresh.service state=inactive result=timeout exit=2 code=9';
const et = '服务异常：shein-bi-et-low-inventory-recheck.service state=failed result=exit-code exit=2 code=1';
const product = '商品 OpenAPI 对账需处理：TZ 店商品对账未完成：fetch_failed。';
const profit = '日更补采异常：date=2026-08-12 status=warning message=profit mart refresh failed status=3 log=/srv/x.log';
const critical = '服务异常：shein-bi-portal.service state=failed result=exit-code exit=1 code=1';
const liveUpdatesCritical = 'BI 实时更新通道未连接：enabled=true connected=false';

assert.equal(deriveWatchdogIssueFamily(stockA), deriveWatchdogIssueFamily(stockB), 'service exit details must not create a new family');
assert.equal(deriveWatchdogIssueFamily(product), 'openapi-product-reconciliation');
assert.equal(
  deriveWatchdogIssueFamily('云端源码不一致：commitMatch=false dirty=0 hidden=0 missing=1'),
  deriveWatchdogIssueFamily('云端源码不一致：commitMatch=false dirty=3 hidden=1 missing=9'),
);
assert.equal(
  deriveWatchdogIssueFamily('BI 覆盖不足：SHEIN 销售日报 覆盖不足：1 天、2 个店铺日缺口'),
  deriveWatchdogIssueFamily('BI 覆盖不足：SHEIN 销售日报 覆盖不足：3 天、8 个店铺日缺口'),
);

let state;
let step = run(state, [stockA], 0);
state = step.nextState;
assert.equal(step.toAlert.length, 0, 'first stock failure waits for automatic retry');
step = run(state, [], 1);
assert.equal(step.toAlert.length, 0);
assert.equal(step.toRecover.length, 0, 'a pending transient recovery stays quiet');

step = run(undefined, [critical], 2);
assert.equal(step.toAlert.length, 1, 'critical portal failure alerts immediately');
step = run(undefined, [liveUpdatesCritical], 2.5);
assert.equal(step.toAlert.length, 1, 'critical live-update failure alerts immediately');

state = undefined;
for (let h = 3; h <= 5; h += 1) {
  step = run(state, [et], h);
  state = step.nextState;
  assert.equal(step.toAlert.length, 0, 'ET recheck waits through its retry window');
}
step = run(state, [et], 6);
state = step.nextState;
assert.equal(step.toAlert.length, 1, 'ET alerts on fourth consecutive watchdog observation');
const alertIntent = step.toAlert[0];
state = markWatchdogOutboxSent(state, [alertIntent.id], at(6));
step = run(state, [], 7);
state = step.nextState;
assert.equal(step.toRecover.length, 1, 'an alerted issue emits one recovery');
const recoveryId = step.toRecover[0].id;
state = markWatchdogOutboxSent(state, [recoveryId], at(7));
step = run(state, [], 8);
assert.equal(step.toRecover.length, 0, 'recovery is emitted once');

state = undefined;
for (let h = 9; h <= 10; h += 1) {
  step = run(state, [profit], h);
  state = step.nextState;
  assert.equal(step.toAlert.length, 0);
}
step = run(state, [profit], 11);
assert.equal(step.toAlert.length, 1, 'daily refresh waits three observations');

state = undefined;
step = run(state, [stockA, product], 12); state = step.nextState;
step = run(state, [stockB, product], 13); state = step.nextState;
assert.equal(step.toAlert.length, 2, 'separate service and product families alert independently');
state = markWatchdogOutboxSent(state, step.toAlert.map(row => row.id), at(13));
step = run(state, [product], 14);
assert.equal(step.toRecover.length, 1);
assert.equal(step.toRecover[0].family, 'service:shein-bi-cloud-openapi-stock-refresh.service', 'partial recovery does not recover the remaining issue');

state = undefined;
step = run(state, [stockA], 15); state = step.nextState;
step = run(state, [stockA], 16); state = step.nextState;
assert.equal(step.toAlert.length, 1);
state = markWatchdogOutboxSent(state, step.toAlert.map(row => row.id), at(16));
for (let h = 17; h < 28; h += 1) {
  step = run(state, [stockB], h); state = step.nextState;
  assert.equal(step.toAlert.length, 0, 'volatile exit details do not repeat the alert');
}
step = run(state, [stockA], 28);
assert.equal(step.toAlert.length, 1, 'a reminder is rate-limited to twelve later observations');

const legacyIssues = [profit];
const legacy = migrateLegacyWatchdogState({legacyKey: legacyIssueSetKey(legacyIssues), previousIssues: legacyIssues, now: at(20)});
step = run(legacy, [], 21);
assert.equal(step.toRecover.length, 1, 'legacy alerted issue can migrate into a recovery notification');

step = run({schemaVersion: 'broken'}, [critical], 22);
assert.equal(step.toAlert.length, 1, 'corrupt state fails open for critical incidents');
assert.match(step.toAlert[0].idempotencyKey, /^sync-watchdog-alert-/);

state = undefined;
step = run(state, [stockA], 23); state = step.nextState;
step = run(state, [stockA], 24); state = step.nextState;
assert.equal(step.toAlert.length, 1);
step = run(state, [], 25);
assert.equal(step.toRecover.length, 0, 'failed/unsent alert is cancelled without a misleading recovery');

state = undefined;
step = run(state, [critical], 26);
state = prepareWatchdogDispatches(step.nextState, at(26));
let dispatches = pendingWatchdogDispatches(state);
assert.equal(dispatches.length, 1);
const stableDispatchKey = dispatches[0].idempotencyKey;
state = prepareWatchdogDispatches(state, at(27));
dispatches = pendingWatchdogDispatches(state);
assert.equal(dispatches[0].idempotencyKey, stableDispatchKey, 'a retry keeps the same delivery idempotency key');
state = markWatchdogDispatchSent(state, dispatches[0].id, at(27));
assert.equal(pendingWatchdogDispatches(state).length, 0);
step = run(state, [], 28);
state = prepareWatchdogDispatches(step.nextState, at(28));
assert.equal(pendingWatchdogDispatches(state).filter(row => row.kind === 'recovery').length, 1);

console.log(JSON.stringify({ok: true, checks: 24}, null, 2));
