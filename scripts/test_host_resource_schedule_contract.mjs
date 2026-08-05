#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  evaluateHostResourcePressure,
  HOST_RESOURCE_DEFER_EXIT_CODE,
  HOST_RESOURCE_PRESSURE_PROFILES,
  parseLoadAverage,
  parseMemAvailableMiB,
  parsePressureFullAvg10,
  parseUptimeSeconds,
} from './check_host_resource_pressure.mjs';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const unit = name => read(`infra/systemd/${name}`);
const calendars = value => [...value.matchAll(/^OnCalendar=(.*)$/gm)].map(match => match[1].trim());

assert.equal(parseUptimeSeconds('1200.5 20\n'), 1200.5);
assert.equal(parseLoadAverage('1.25 1.0 0.5 1/10 20\n'), 1.25);
assert.equal(parseMemAvailableMiB('MemAvailable: 3145728 kB\n'), 3072);
assert.equal(parsePressureFullAvg10('some avg10=4\nfull avg10=1.5 avg60=0\n'), 1.5);
assert.equal(HOST_RESOURCE_DEFER_EXIT_CODE, 75);
assert.equal(evaluateHostResourcePressure({
  uptimeSeconds: 3600,
  cpuCount: 2,
  load1: 0.8,
  availableMemoryMiB: 4096,
  memoryFullAvg10: 0,
  ioFullAvg10: 0,
}, HOST_RESOURCE_PRESSURE_PROFILES.browser).ready, true);

const slice = unit('shein-host-heavy-bi.slice');
assert.match(slice, /^CPUQuota=90%$/m);
assert.match(slice, /^MemoryHigh=2G$/m);
assert.match(slice, /^MemoryMax=3G$/m);
assert.match(slice, /^TasksMax=512$/m);

const hostWrapper = read('scripts/run_host_heavy_job.sh');
assert.ok(
  hostWrapper.indexOf('exec 9<>"$HOST_LOCK"') < hostWrapper.indexOf('exec 8<>"$PROJECT_LOCK"')
  && hostWrapper.indexOf('exec 8<>"$PROJECT_LOCK"') < hostWrapper.indexOf('exec 7<>"$DOMAIN_LOCK"')
  && hostWrapper.indexOf('exec 7<>"$DOMAIN_LOCK"') < hostWrapper.indexOf('check_host_resource_pressure.mjs'),
  'lock order must remain host -> project -> domain -> pressure -> command',
);
assert.match(hostWrapper, /--deadline-at/);
assert.match(hostWrapper, /status="deferred_to_local"/);
assert.doesNotMatch(hostWrapper, /touch -- "\$HOST_LOCK"/,
  'the half-managed project consumes the neutral host lock and must not recreate it');

const heavyUnits = [
  'shein-bi-cloud-session-manager.service',
  'shein-bi-db-backup.service',
  'shein-bi-cloud-yesterday.service',
  'shein-bi-cloud-morning-chain.service',
  'shein-bi-cloud-morning-link-chunk-2.service',
  'shein-bi-cloud-morning-supplements.service',
  'shein-bi-cloud-rtv-verify.service',
  'shein-bi-cloud-order-closure.service',
  'shein-bi-cloud-et-forwarder.service',
  'shein-bi-cloud-marketing-live-guard.service',
  'shein-bi-cloud-marketing-repair.service',
  'shein-bi-daily-inventory-replenishment-guard.service',
  'shein-bi-cloud-portal-section-queue.service',
  'shein-bi-cloud-manual-login-recovery.service',
];
for (const name of heavyUnits) {
  const content = unit(name);
  assert.match(content, /^Slice=shein-host-heavy-bi\.slice$/m, name);
  assert.match(content, /run_host_heavy_job\.sh/, name);
  assert.match(content, /^SuccessExitStatus=75$/m, name);
}

for (const name of [
  'shein-bi-cloud-today-sales-reconcile.service',
  'shein-bi-cloud-openapi-stock-refresh.service',
]) {
  const content = unit(name);
  assert.doesNotMatch(content, /shein-host-heavy|run_host_heavy_job|Slice=shein-host-heavy-bi/,
    `${name} is a lightweight current-business fast lane`);
}

assert.deepEqual(calendars(unit('shein-bi-cloud-session-manager.timer')), ['*-*-* 00:45:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-et-forwarder.timer')), [
  '*-*-* 01,04:12:00',
  '*-*-* 07,10,13,17,20,23:20:00',
]);
assert.deepEqual(calendars(unit('shein-bi-db-backup.timer')), ['*-*-* 01:45:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-yesterday.timer')), ['*-*-* 02:45:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-rtv-verify.timer')), ['*-*-* 04:50:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-morning-chain.timer')), ['*-*-* 08:00:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-morning-link-chunk-2.timer')), ['*-*-* 08:45:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-morning-supplements.timer')), ['*-*-* 09:12:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-openapi-stock-refresh.timer')), ['*-*-* *:12,45:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-today-sales-reconcile.timer')), ['*-*-* *:00,15,30,45:00']);
assert.deepEqual(calendars(unit('shein-bi-daily-inventory-replenishment-guard.timer')), ['*-*-* 11:18:00']);

const morning = read('scripts/cloud_morning_chain.sh');
assert.match(morning, /SHEIN_BI_MORNING_CHUNK_1_STORES:-DL,DX,FY,LQ,NM,HL,JY,ZL,TS,MZ,CX,YJ/);
assert.match(morning, /SHEIN_BI_MORNING_CHUNK_2_STORES:-XL,QY,QH,TZ,JSH,TZZ,XC/);
assert.match(morning, /SHEIN_LINK_BUSINESS_FETCH_ONLY=1/);
assert.match(morning, /SHEIN_LINK_BUSINESS_FINALIZE_ONLY=1/);
assert.match(morning, /morning-links-ready/);
assert.match(morning, /SHEIN_BI_DAILY_LINK_BUSINESS_MODE=skip/);
assert.match(morning, /SHEIN_BI_DAILY_RTV_VERIFY=0/);
assert.match(read('scripts/cloud_link_business_sync.sh'), /SHEIN_LINK_BUSINESS_RESUME_COMPLETED/,
  'a deadline retry must reuse exact-date completed store evidence instead of starting all stores over');
assert.match(unit('shein-bi-cloud-morning-supplements.service'), /^Environment=SHEIN_BI_DAILY_OPENAPI_PRODUCT_RECONCILIATION=0$/m,
  'the daily bounded 07:12 stock/detail pass owns product enrichment');

const rtvVerify = read('scripts/cloud_rtv_verify.sh');
assert.doesNotMatch(rtvVerify, /node scripts\/generate_bi_portal\.mjs/,
  'a successful long RTV verification must not fail later on a duplicate full portal build');
assert.match(rtvVerify, /enqueue_bi_portal_sections\.sh/,
  'RTV post-processing must use the host-locked section queue');

const inventory = read('scripts/cloud_daily_inventory_replenishment_guard.sh');
assert.match(inventory, /--stage morning-links-ready/);
assert.match(inventory, /--stage stock-refresh/);
assert.match(inventory, /T09:11:00\+08:00/);

const automatedShell = fs.readdirSync(new URL('./', import.meta.url))
  .filter(name => name.endsWith('.sh'))
  .map(name => read(`scripts/${name}`))
  .join('\n');
assert.doesNotMatch(automatedShell, /nohup[^\n]*prewarm_bi_portal_sections/,
  'automated jobs must enqueue bounded section refreshes instead of detached 16-section fan-out');
assert.match(automatedShell, /enqueue_bi_portal_sections\.sh/);
assert.match(unit('shein-bi-cloud-portal-section-queue.timer'), /^\s*OnCalendar=\*-\*-\* \*:52:00$/m);

const repair = read('scripts/cloud_marketing_repair_worker.sh');
assert.match(repair, /write_state deferred_to_local/);
assert.match(unit('shein-bi-cloud-marketing-repair.service'), /--defer-reason deferred_to_local/);

const portal = read('scripts/serve_bi_portal.mjs');
const liveWorker = portal.slice(
  portal.indexOf('const runLiveAccountingRefresh = async () =>'),
  portal.indexOf('const mergeLiveAccountingRefreshEvent ='),
);
assert.ok(
  liveWorker.indexOf("generateBiSection(args, root, 'liveSalesToday'") < liveWorker.indexOf('enqueueHostLockedBiSection(section, generatedAt'),
  'liveSalesToday must publish before canonical accounting enters the host-locked queue',
);
assert.match(liveWorker, /if \(!canonicalAccountingRequired\) return;/);
assert.match(liveWorker, /liveProjectionRefreshed: true/);
assert.doesNotMatch(liveWorker, /ensureProfitMartCacheFresh/,
  'the Portal live fast lane must never rebuild the cost ledger itself');

console.log(JSON.stringify({ok: true, heavyUnits: heavyUnits.length}));
