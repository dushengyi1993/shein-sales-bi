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
assert.equal(HOST_RESOURCE_PRESSURE_PROFILES['browser-secondary'].minimumAvailableMemoryMiB, 4096);
assert.equal(evaluateHostResourcePressure({
  uptimeSeconds: 3600,
  cpuCount: 2,
  load1: 0.8,
  availableMemoryMiB: 3900,
  memoryFullAvg10: 0,
  ioFullAvg10: 0,
}, HOST_RESOURCE_PRESSURE_PROFILES['browser-secondary']).ready, false);

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
  'shein-bi-cloud-rtv-verify.service',
  'shein-bi-cloud-order-closure.service',
  'shein-bi-cloud-et-forwarder.service',
  'shein-bi-et-low-inventory-guard.service',
  'shein-bi-et-low-inventory-recheck.service',
  'shein-bi-cloud-marketing-live-guard.service',
  'shein-bi-cloud-marketing-repair.service',
  'shein-bi-daily-inventory-replenishment-guard.service',
  'shein-bi-cloud-portal-section-queue.service',
  'shein-bi-cloud-manual-login-recovery.service',
];
for (const name of heavyUnits) {
  const content = unit(name);
  assert.match(content, /^Slice=shein-host-heavy-bi\.slice$/m, name);
  assert.match(content, /run_host_(?:heavy|browser_read)_job\.sh|run_cloud_(?:portal_section_queue|marketing_fallback)_slot\.sh|cloud_order_closure_coordinator\.sh/, name);
  assert.match(content, /^SuccessExitStatus=75$/m, name);
}

const dailyCoordinatorUnit = unit('shein-bi-cloud-morning-chain.service');
assert.match(dailyCoordinatorUnit, /^Slice=shein-host-heavy-bi\.slice$/m);
assert.match(dailyCoordinatorUnit, /cloud_morning_chain\.sh all/);
assert.doesNotMatch(dailyCoordinatorUnit, /--deadline-at|run_host_browser_read_job\.sh/,
  'the coordinator must not hold a browser token or be cut into an arbitrary clock slot');

const browserReadUnits = [
  'shein-bi-cloud-session-manager.service',
];
for (const name of browserReadUnits) {
  assert.match(unit(name), /run_host_browser_read_job\.sh/, name);
}
for (const name of [
  'shein-bi-cloud-rtv-verify.service',
  'shein-bi-cloud-et-forwarder.service',
  'shein-bi-cloud-et-storage-fee.service',
  'shein-bi-et-low-inventory-recheck.service',
]) {
  const content = unit(name);
  assert.doesNotMatch(content, /run_host_browser_read_job\.sh|--class browser/,
    `${name} has a direct WebAPI/HTTP implementation and must not reserve a browser lane`);
}
for (const name of [
  'shein-bi-cloud-marketing-repair.service',
  'shein-bi-daily-inventory-replenishment-guard.service',
  'shein-bi-cloud-portal-section-queue.service',
]) {
  assert.doesNotMatch(unit(name), /run_host_browser_read_job\.sh/,
    `${name} must remain exclusive because it writes business or materialized state`);
}

const browserReadWrapper = read('scripts/run_host_browser_read_job.sh');
assert.match(browserReadWrapper, /flock -s -w "\$LOCK_WAIT_SEC" 9/);
assert.match(browserReadWrapper, /flock -s -w "\$LOCK_WAIT_SEC" 8/,
  'read-only store workers may share the half-managed project lane while the two host browser slots enforce the machine cap');
assert.match(browserReadWrapper, /shein-browser-read-0\.lock/);
assert.match(browserReadWrapper, /shein-browser-read-1\.lock/);
assert.match(browserReadWrapper, /PRESSURE_CLASS=browser-secondary/);
assert.match(browserReadWrapper, /SHEIN_BI_HOST_RESOURCE_LANE=browser-read/);
assert.ok(
  browserReadWrapper.indexOf('exec 9<>"$HOST_LOCK"') < browserReadWrapper.indexOf('exec 8<>"$PROJECT_LOCK"')
  && browserReadWrapper.indexOf('exec 8<>"$PROJECT_LOCK"') < browserReadWrapper.indexOf('exec 7<>"$DOMAIN_LOCK"')
  && browserReadWrapper.indexOf('exec 7<>"$DOMAIN_LOCK"') < browserReadWrapper.indexOf('check_host_resource_pressure.mjs'),
  'browser read lock order must remain host -> project -> domain -> slot -> pressure',
);

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
assert.deepEqual(calendars(unit('shein-bi-et-low-inventory-recheck.timer')), [
  '*-*-* 00,02,05,06,08,09,11,12,15,16,18,19,22:20:00',
]);
assert.match(unit('shein-bi-cloud-et-forwarder.service'), /^OnSuccess=shein-bi-et-low-inventory-guard\.service$/m);
assert.deepEqual(calendars(unit('shein-bi-db-backup.timer')), ['*-*-* 01:45:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-yesterday.timer')), ['*-*-* 02:45:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-rtv-verify.timer')), ['*-*-* 04:50:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-morning-chain.timer')), ['*-*-* 07:10:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-openapi-stock-refresh.timer')), ['*-*-* *:12,45:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-today-sales-reconcile.timer')), ['*-*-* *:00,15,30,45:00']);

const morning = read('scripts/cloud_morning_chain.sh');
assert.match(morning, /SHEIN_LINK_BUSINESS_FETCH_ONLY=1/);
assert.match(morning, /SHEIN_LINK_BUSINESS_ALLOW_PARTIAL=1/,
  'one transient store failure must not prevent the other morning stores from being fetched');
assert.doesNotMatch(morning, /chunk-1\)|chunk-2\)|supplements\)/,
  'the production coordinator must not retain callable split-stage entry points');
assert.match(morning, /morning-links-ready/);
assert.match(morning, /SHEIN_BI_DAILY_LINK_BUSINESS_MODE=finalize/);
assert.match(morning, /SHEIN_BI_DAILY_REQUIRE_COMPLETE_LINK_BUSINESS=1/,
  'the unified coordinator must not publish when any store or metric readiness gate is incomplete');
assert.match(morning, /SHEIN_BI_DAILY_RTV_VERIFY=0/);
assert.match(morning, /cloud_morning_chain\.sh all|all\)/);
assert.match(morning, /SHEIN_LINK_BUSINESS_PER_STORE_BROWSER_WRAPPER=1/);
assert.match(morning, /previous complete BI snapshot stays visible until the run is complete/);
assert.match(morning, /retrying only those stores inside the same run/);
assert.match(morning, /while \[\[ -n "\$MISSING_STORES" \]\]/,
  'unfinished stores must remain checkpoints in the same coordinator until complete or the run safety budget expires');
assert.match(morning, /waiting platform readiness retryRound=/,
  'platform readiness must resume in the same run instead of creating another timer');
assert.match(morning, /run_inventory_stage/);
assert.match(morning, /pipeline_marker_done "morning-supplements"/,
  'a restarted coordinator must resume after the completed atomic publish checkpoint instead of rebuilding it');
assert.match(morning, /pipeline_marker_done "daily-operating-refresh"/,
  'a completed business date must be an idempotent no-op when the service is started again');
assert.match(morning, /resume-skip all-store fetch; exact-date evidence already exists for all enabled stores/,
  'a restarted failed morning publish must reuse complete exact-date store evidence');
assert.match(morning, /daily supplements failed status=\$SUPPLEMENT_STATUS; the previous complete BI snapshot remains active/,
  'a terminal supplement failure must not leave the coordinator state stuck at running');
assert.match(morning, /daily inventory guard is waiting for host capacity inside the same run/,
  'temporary resource pressure must keep the inventory stage in the same coordinator run');
assert.match(morning, /if SHEIN_BI_INVENTORY_REQUIRE_PIPELINE_MARKERS=1[\s\S]*inventory_status=\$\?/,
  'the inventory scheduler command must be conditional so exit 75 is handled instead of tripping the ERR trap');
const linkBusinessSync = read('scripts/cloud_link_business_sync.sh');
assert.match(linkBusinessSync, /SHEIN_LINK_BUSINESS_RESUME_COMPLETED/,
  'an internal retry must reuse exact-date completed store evidence instead of starting all stores over');
assert.match(linkBusinessSync, /SHEIN_LINK_BUSINESS_BROWSER_CONCURRENCY:-2/,
  'the one coordinator may use two bounded browser workers without becoming two business runs');
assert.match(linkBusinessSync, /NODE\n}\n\nrun_store_worker\(\)/,
  'the store worker must be executable shell code, not accidental content inside the evidence-check heredoc');
assert.match(linkBusinessSync, /wait -n -p FINISHED_PID "\$\{WORKER_PIDS\[@\]\}"/,
  'parallel store workers must be reaped by pid without waiting for unrelated logger children');
assert.doesNotMatch(linkBusinessSync, /^\s*wait\s*(?:\|\|\s*true)?\s*$/m,
  'a bare wait deadlocks against the process-substitution tee that waits for coordinator stdout to close');
const dailyRefresh = read('scripts/cloud_daily_refresh.sh');
assert.match(dailyRefresh, /SHEIN_BI_DAILY_REQUIRE_COMPLETE_LINK_BUSINESS/);
assert.match(dailyRefresh, /prior complete Portal snapshot retained/);
assert.match(dailyRefresh, /if bash scripts\/refresh_inventory_cost_ledger\.sh; then[\s\S]*COST_LEDGER_STATUS=0[\s\S]*COST_LEDGER_STATUS=\$\?/,
  'an expected cost-ledger retry must be captured by a conditional instead of tripping the ERR trap');
assert.match(dailyRefresh, /if bash scripts\/refresh_profit_marts\.sh; then[\s\S]*PROFIT_MART_STATUS=0[\s\S]*PROFIT_MART_STATUS=\$\?/,
  'a retained prior profit mart must remain a warning rather than aborting the daily publish');
assert.match(dailyRefresh, /if node scripts\/audit_bi_warehouse\.mjs; then[\s\S]*AUDIT_STATUS=0[\s\S]*AUDIT_STATUS=\$\?/,
  'a nonzero audit result must still allow the Portal to publish its audit evidence');
const etForwarderSync = read('scripts/cloud_et_forwarder_sync.sh');
assert.match(etForwarderSync, /SHEIN_ET_SYNC_PREWARM_SECTIONS-orders,waybills,afterSales/,
  'the ET checkpoint must not synchronously wait for the multi-minute inventory trend projection');
assert.match(etForwarderSync, /SHEIN_ET_SYNC_PREWARM_SECTION_TIMEOUT_SECONDS:-45/,
  'synchronous ET projections must stay inside the checkpoint deadline');
assert.match(etForwarderSync, /--sections "\$PORTAL_REFRESH_SECTIONS"/,
  'every ET-dependent section must be handed to the bounded queue after warehouse commit');
assert.match(linkBusinessSync, /write_chunk_result "warning"/,
  'fetch-only chunks must preserve partial progress as warning evidence instead of aborting at the first store');
assert.match(read('scripts/cloud_link_business_store_fetch.sh'), /--fast-start/);
assert.match(read('scripts/cloud_link_business_store_fetch.sh'), /--page-size "\$\{SHEIN_LINK_PAGE_SIZE:-100\}"/);

const rtvVerify = read('scripts/cloud_rtv_verify.sh');
assert.doesNotMatch(rtvVerify, /node scripts\/generate_bi_portal\.mjs/,
  'a successful long RTV verification must not fail later on a duplicate full portal build');
assert.match(rtvVerify, /enqueue_bi_portal_sections\.sh/,
  'RTV post-processing must use the host-locked section queue');
const rtvVerifyUnit = unit('shein-bi-cloud-rtv-verify.service');
assert.match(rtvVerifyUnit, /^Environment=SHEIN_RTV_VERIFY_TIMEOUT_MS=1500000$/m,
  'RTV must stop cleanly before the 05:27 browser-lane deadline');
assert.match(rtvVerifyUnit, /^Environment=SHEIN_RTV_LIMIT=80$/m);
assert.match(rtvVerifyUnit, /^Environment=SHEIN_RTV_CASE_LIMIT=8$/m);

const inventory = read('scripts/cloud_daily_inventory_replenishment_guard.sh');
assert.match(inventory, /--stage morning-links-ready/);
assert.match(inventory, /--stage stock-refresh/);
assert.match(inventory, /T15:11:00\+08:00/);
assert.match(inventory, /SHEIN_BI_INVENTORY_STOCK_NOT_BEFORE/);

const etForwarder = read('scripts/fetch_et_forwarder.mjs');
assert.match(etForwarder, /SHEIN_ET_HTTP_READ_ATTEMPTS/);
assert.match(etForwarder, /SHEIN_ET_HTTP_READ_TIMEOUT_MS/);

const automatedShell = fs.readdirSync(new URL('./', import.meta.url))
  .filter(name => name.endsWith('.sh'))
  .map(name => read(`scripts/${name}`))
  .join('\n');
assert.doesNotMatch(automatedShell, /nohup[^\n]*prewarm_bi_portal_sections/,
  'automated jobs must enqueue bounded section refreshes instead of detached 16-section fan-out');
assert.match(automatedShell, /enqueue_bi_portal_sections\.sh/);
assert.match(unit('shein-bi-cloud-portal-section-queue.timer'), /^\s*OnCalendar=\*-\*-\* \*:14,44:00$/m);
const portalQueueUnit = unit('shein-bi-cloud-portal-section-queue.service');
const portalQueueWorker = read('scripts/cloud_portal_section_queue_worker.sh');
const portalQueueSlot = read('scripts/run_cloud_portal_section_queue_slot.sh');
assert.match(portalQueueUnit, /run_cloud_portal_section_queue_slot\.sh/);
assert.doesNotMatch(portalQueueUnit, /--deadline-next-hour/);
assert.match(portalQueueSlot, /DEADLINE_MINUTE=17/);
assert.match(portalQueueSlot, /DEADLINE_MINUTE=27/);
assert.match(portalQueueSlot, /DEADLINE_MINUTE=57/);
assert.match(portalQueueSlot, /SHEIN_BI_PORTAL_SECTION_QUEUE_SCHEDULED=1/);
assert.match(portalQueueSlot, /daily_operating_refresh_active/);
assert.match(portalQueueWorker, /unscheduled_direct_entry/);
assert.match(portalQueueWorker, /10#\$START_MINUTE >= 13/);
assert.match(portalQueueWorker, /10#\$START_MINUTE >= 43/);
assert.match(portalQueueWorker, /outside_safe_start_window/);
assert.match(portalQueueWorker, /stop before next core lane/);

const repair = read('scripts/cloud_marketing_repair_worker.sh');
const repairSlot = read('scripts/run_cloud_marketing_fallback_slot.sh');
assert.match(repair, /write_state deferred_to_local/);
assert.match(unit('shein-bi-cloud-marketing-repair.service'), /run_cloud_marketing_fallback_slot\.sh/);
assert.match(repairSlot, /--defer-reason deferred_to_local/);
assert.match(repairSlot, /HARD_DEADLINE_MINUTE=57/);
assert.match(repairSlot, /HARD_DEADLINE_MINUTE=27/);
assert.match(repairSlot, /HOUR == 20/);
assert.match(repairSlot, /HOUR == 21/);
assert.match(unit('shein-bi-cloud-marketing-repair.service'), /SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS=1/);
assert.match(unit('shein-bi-cloud-marketing-repair.service'), /SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION=cloud/);
assert.match(unit('shein-bi-cloud-marketing-repair.service'), /SHEIN_BI_MARKETING_CLOUD_FALLBACK_ENABLED=true/);
assert.match(repair, /CURRENT_MINUTE >= 23 && CURRENT_MINUTE <= 42/);
assert.match(repair, /remaining exact queue preserved for local-browser continuation/);
assert.match(repair, /IS_CLOUD_EXECUTION=1/);
assert.doesNotMatch(repair, /AUTOMATION_CONTEXT.*== "cloud_timer"/);
assert.match(repair, /SHEIN_BI_MARKETING_CLOUD_WRITE_GATE=bounded-repair-v1/);
assert.match(repair, /fallback readback found no remaining work/);
assert.match(repair, /refuse to start another transaction/);
assert.match(repair, /outside 20:45-20:57 \/ 21:15-21:27/);

const nodeWrapper = read('infra/bin/shein-bi-node');
const cloudWriteGate = read('lib/cloud_marketing_write_gate.mjs');
assert.match(hostWrapper, /SHEIN_BI_HOST_HEAVY_WRAPPED=1/);
assert.match(hostWrapper, /SHEIN_BI_HOST_HEAVY_DOMAIN="\$DOMAIN"/);
assert.match(nodeWrapper, /cloud-marketing-write-gate/);
assert.match(nodeWrapper, /shared host wrapper is not an ancestor/);
assert.match(nodeWrapper, /cloud batch limit must be exactly one/);
assert.match(cloudWriteGate, /cloud_marketing_write_requires_shared_host_wrapper/);
assert.match(cloudWriteGate, /cloud_marketing_write_wrapper_ancestor_missing/);

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
