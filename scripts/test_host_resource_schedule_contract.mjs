#!/usr/bin/env node

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  calculateCpuBusyRatio,
  evaluateHostResourcePressure,
  HOST_RESOURCE_DEFER_EXIT_CODE,
  HOST_RESOURCE_PRESSURE_PROFILES,
  parseLoadAverage,
  parseMemAvailableMiB,
  parsePressureFullAvg10,
  parseCpuTimes,
  parseUptimeSeconds,
} from './check_host_resource_pressure.mjs';
import {
  executeBiLiveAccountingRefreshAttempt,
  liveAccountingQueuePlan,
  nextBiCanonicalAccountingCatchupDelay,
} from './serve_bi_portal.mjs';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const unit = name => read(`infra/systemd/${name}`);
const calendars = value => [...value.matchAll(/^OnCalendar=(.*)$/gm)].map(match => match[1].trim());
const calendarMinutes = entries => entries.flatMap(entry => {
  const [, clock] = entry.split(/\s+/);
  const [hours, minute] = clock.split(':');
  return hours.split(',').map(hour => Number(hour) * 60 + Number(minute));
});

assert.equal(parseUptimeSeconds('1200.5 20\n'), 1200.5);
assert.equal(parseLoadAverage('1.25 1.0 0.5 1/10 20\n'), 1.25);
assert.equal(parseMemAvailableMiB('MemAvailable: 3145728 kB\n'), 3072);
assert.equal(parsePressureFullAvg10('some avg10=4\nfull avg10=1.5 avg60=0\n'), 1.5);
assert.deepEqual(parseCpuTimes('cpu  100 0 50 850 0 0 0 0 0 0\n'), {total: 1000, idle: 850});
assert.equal(calculateCpuBusyRatio(
  {total: 1000, idle: 850},
  {total: 1200, idle: 1000},
), 0.25);
assert.equal(HOST_RESOURCE_DEFER_EXIT_CODE, 75);
assert.equal(evaluateHostResourcePressure({
  uptimeSeconds: 3600,
  cpuCount: 2,
  load1: 0.8,
  cpuBusyRatio: 0.9,
  availableMemoryMiB: 4096,
  memoryFullAvg10: 0,
  ioFullAvg10: 0,
}, HOST_RESOURCE_PRESSURE_PROFILES.browser).ready, true);
assert.equal(evaluateHostResourcePressure({
  uptimeSeconds: 3600,
  cpuCount: 2,
  load1: 3.2,
  cpuBusyRatio: 0.1,
  availableMemoryMiB: 4096,
  memoryFullAvg10: 0,
  ioFullAvg10: 0,
}, HOST_RESOURCE_PRESSURE_PROFILES.browser).ready, true,
'short-window idle CPU must override only the lagging load average');
assert.equal(evaluateHostResourcePressure({
  uptimeSeconds: 3600,
  cpuCount: 2,
  load1: 3.2,
  cpuBusyRatio: 0.8,
  availableMemoryMiB: 4096,
  memoryFullAvg10: 0,
  ioFullAvg10: 0,
}, HOST_RESOURCE_PRESSURE_PROFILES.browser).ready, false,
'high load plus high short-window CPU must still defer');
assert.equal(evaluateHostResourcePressure({
  uptimeSeconds: 3600,
  cpuCount: 2,
  load1: 3.2,
  cpuBusyRatio: 0.1,
  availableMemoryMiB: 2000,
  memoryFullAvg10: 0,
  ioFullAvg10: 0,
}, HOST_RESOURCE_PRESSURE_PROFILES.browser).ready, false,
'short-window CPU override must never bypass the memory floor');
assert.equal(HOST_RESOURCE_PRESSURE_PROFILES['browser-secondary'].minimumAvailableMemoryMiB, 4096);
assert.equal(evaluateHostResourcePressure({
  uptimeSeconds: 3600,
  cpuCount: 2,
  load1: 0.8,
  cpuBusyRatio: 0.1,
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
const sessionManagerCoordinator = read('scripts/run_cloud_session_manager_job.sh');
assert.ok(
  hostWrapper.indexOf('exec 9<>"$HOST_LOCK"') < hostWrapper.indexOf('exec 8<>"$PROJECT_LOCK"')
  && hostWrapper.indexOf('exec 8<>"$PROJECT_LOCK"') < hostWrapper.indexOf('exec 7<>"$DOMAIN_LOCK"')
  && hostWrapper.indexOf('exec 7<>"$DOMAIN_LOCK"') < hostWrapper.indexOf('check_host_resource_pressure.mjs'),
  'lock order must remain host -> project -> domain -> pressure -> command',
);
assert.match(hostWrapper, /--deadline-at/);
assert.match(hostWrapper, /--deadline-epoch/,
  'the morning inventory lane needs an immutable absolute deadline');
assert.equal((hostWrapper.match(/CURRENT_LOCK_WAIT="\$\(lock_wait_for_current_deadline\)"/g) || []).length, 3,
  'host, project and domain lock waits must each recompute the absolute deadline');
assert.match(hostWrapper, /if \(\( LOCK_WAIT_SEC > REMAINING_SEC \)\); then LOCK_WAIT_SEC="\$REMAINING_SEC"/,
  'lock wait must be clamped so it cannot consume the inventory window');
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
  assert.match(content, /run_host_(?:heavy|browser_read)_job\.sh|run_cloud_(?:portal_section_queue|marketing_fallback)_slot\.sh|run_cloud_session_manager_job\.sh|cloud_order_closure_coordinator\.sh/, name);
  if (name === 'shein-bi-cloud-session-manager.service') {
    assert.doesNotMatch(content, /^SuccessExitStatus=75$/m,
      'session-manager coordinator must convert terminal deferral to a real failed unit result');
  } else {
    assert.match(content, /^SuccessExitStatus=75$/m, name);
  }
}

const dailyCoordinatorUnit = unit('shein-bi-cloud-morning-chain.service');
assert.match(dailyCoordinatorUnit, /^Slice=shein-host-heavy-bi\.slice$/m);
assert.match(dailyCoordinatorUnit, /run_cloud_morning_chain_job\.sh/,
  'the morning-chain unit must start through the resume-aware wrapper');
assert.match(dailyCoordinatorUnit, /^Restart=on-failure$/m,
  'a failed/interrupted morning run must auto-restart the same service');
assert.match(dailyCoordinatorUnit, /^RestartSec=60$/m,
  'the restart must respect a reasonable backoff and never race the timer');
assert.doesNotMatch(dailyCoordinatorUnit, /--deadline-at|run_host_browser_read_job\.sh/,
  'the coordinator must not hold a browser token or be cut into an arbitrary clock slot');

assert.match(unit('shein-bi-cloud-session-manager.service'), /run_cloud_session_manager_job\.sh/,
  'session-manager service owns one bounded coordinator run');
assert.match(unit('shein-bi-cloud-session-manager.service'), /SHEIN_BI_SESSION_MANAGER_RETRY_MAX=0/,
  'the unit default retry-max must be unlimited (deadline is the only boundary)');
assert.match(sessionManagerCoordinator, /run_host_browser_read_job\.sh/,
  'the session-manager coordinator must reacquire the shared browser-read lane for each retry');
assert.match(sessionManagerCoordinator, /LANE_DEADLINE_ARGS=\(--deadline-at "\$DEADLINE_AT"\)/,
  'the normal 00:45 run keeps its wall-clock deadline');
assert.match(sessionManagerCoordinator, /LANE_DEADLINE_ARGS=\(--deadline-epoch "\$DEADLINE_EPOCH"\)/,
  'an explicit catch-up epoch must replace, not accompany, the stale wall-clock deadline');
assert.match(sessionManagerCoordinator, /--check-only/,
  'the coordinator must expose the strong-evidence helper for the morning gate');
assert.match(sessionManagerCoordinator, /nightly_session_completed\(\)/,
  'only the coordinator owns the strong 19/19 completion predicate');
assert.match(sessionManagerCoordinator, /RETRY_MAX="\$\{SHEIN_BI_SESSION_MANAGER_RETRY_MAX:-0\}"/,
  'the coordinator default retry-max must be unlimited');
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
assert.match(browserReadWrapper, /flock -s -w "\$\(lock_wait_remaining\)" 9/,
  'the host lock wait must be clamped to the remaining deadline');
assert.match(browserReadWrapper, /flock -s -w "\$\(lock_wait_remaining\)" 8/,
  'read-only store workers may share the half-managed project lane while the two host browser slots enforce the machine cap');
assert.match(browserReadWrapper, /flock -w "\$\(lock_wait_remaining\)" 7/,
  'the domain lock wait must be clamped to the remaining deadline');
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
assert.match(unit('shein-bi-cloud-session-manager.timer'), /^Persistent=true$/m,
  'the single daily session timer must catch up through the marker-idempotent coordinator');
assert.deepEqual(calendars(unit('shein-bi-cloud-et-forwarder.timer')), [
  '*-*-* 01:12:00',
  '*-*-* 04,07,10,13,17,20,23:20:00',
]);
assert.deepEqual(calendars(unit('shein-bi-et-low-inventory-recheck.timer')), [
  '*-*-* 00,02,05,06,08,09,11,12,15,16,18,19,22:20:00',
]);
assert.match(unit('shein-bi-cloud-et-forwarder.service'), /^OnSuccess=shein-bi-et-low-inventory-guard\.service$/m);
assert.deepEqual(calendars(unit('shein-bi-db-backup.timer')), ['*-*-* 01:45:00']);
assert.match(unit('shein-bi-db-backup.service'), /--deadline-at 02:37/,
  'database backup must retain a measured window and stop before the 02:45 yesterday-final lane');
assert.deepEqual(calendars(unit('shein-bi-cloud-yesterday.timer')), ['*-*-* 02:45:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-rtv-verify.timer')), ['*-*-* 04:50:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-morning-chain.timer')), ['*-*-* 07:10:00']);
assert.match(unit('shein-bi-cloud-morning-chain.timer'), /^Persistent=true$/m,
  'the single 07:10 morning timer is the only daily business catch-up exception');
assert.deepEqual(calendars(unit('shein-bi-cloud-openapi-stock-refresh.timer')), ['*-*-* *:12,45:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-today-sales-reconcile.timer')), ['*-*-* *:00,15,30,45:00']);

const morning = read('scripts/cloud_morning_chain.sh');
assert.match(morning, /SHEIN_LINK_BUSINESS_FETCH_ONLY=1/);
assert.match(morning, /SHEIN_LINK_BUSINESS_ALLOW_PARTIAL=1/,
  'one transient store failure must not prevent the other morning stores from being fetched');
assert.doesNotMatch(morning, /chunk-1\)|chunk-2\)|supplements\)/,
  'the production coordinator must not retain callable split-stage entry points');
assert.match(morning, /morning-links-ready/);
assert.match(morning, /resume-skip all-store fetch[\s\S]*build_morning_resume_evidence\.mjs/);

const morningWrapper = read('scripts/run_cloud_morning_chain_job.sh');
assert.match(morningWrapper, /cloud_morning_chain\.sh/, 'the wrapper must invoke the single daily chain');
assert.match(morningWrapper, /active\.json/, 'the wrapper must persist the active run context');
assert.match(morningWrapper, /SHEIN_BI_MORNING_RUN_DATE/, 'the wrapper must inject the immutable run date');
assert.match(morningWrapper, /SHEIN_BI_MORNING_BUSINESS_DATE/, 'the wrapper must inject the immutable business date');
assert.match(morningWrapper, /validate_daily_operating_refresh\.mjs/, 'the wrapper must verify the complete semantic evidence bundle');
assert.match(morningWrapper, /exit 0/, 'a completed idempotent skip must exit 0 so Restart can never loop');
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
assert.match(morning, /daily_operating_refresh_done/,
  'a semantically completed business date must be an idempotent no-op when the service is started again');
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
assert.match(etForwarderSync, /PORTAL_REFRESH_SECTIONS="\$\{SHEIN_ET_REFRESH_SECTIONS:-orders,waybills,afterSales,inventoryTrend\}"/,
  'inventoryTrend stays in the async section queue and is never part of the synchronous checkpoint');
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
const portalEtWindow = portalQueueSlot.match(
  /if \(\( MINUTE >= 13 && MINUTE <= 16 \)\); then\s+if is_et_hour; then\s+DEADLINE_MINUTE=(\d+)/,
);
assert.ok(portalEtWindow, 'the ET-hour Portal :14 branch must set an explicit early deadline');
const etCalendarMinutes = calendarMinutes(calendars(unit('shein-bi-cloud-et-forwarder.timer')));
assert.ok(etCalendarMinutes.includes(4 * 60 + 20),
  'the ET calendar must include the 04:20 checkpoint');
assert.ok(4 * 60 + Number(portalEtWindow[1]) < 4 * 60 + 20,
  'the 04:14 Portal deadline must precede the 04:20 ET checkpoint');
assert.match(portalQueueSlot,
  /if \(\( HOUR == 4 && MINUTE >= 43 && MINUTE <= 46 \)\); then\s+if systemctl is-active --quiet shein-bi-cloud-rtv-verify\.timer; then\s+echo "\[portal-section-slot\] defer reason=rtv_verify_timer_active hour=\$HOUR minute=\$MINUTE" >&2\s+exit 75\s+fi\s+fi/,
  'the 04:43-04:46 Portal slot must yield explicitly while the RTV timer is active');
assert.match(portalQueueSlot, /--lock-wait-sec 0/,
  'the RTV yield must not add lock waiting to the Portal slot');
const slotClassification = portalQueueSlot.indexOf('if (( MINUTE >= 13 && MINUTE <= 16 )); then');
const rtvGuardCall = portalQueueSlot.search(/\r?\nyield_to_rtv_verify_timer\r?\n/);
const hostWrapperExec = portalQueueSlot.indexOf('exec "$ROOT/scripts/run_host_heavy_job.sh"');
assert.ok(
  slotClassification >= 0 && rtvGuardCall > slotClassification && hostWrapperExec > rtvGuardCall,
  'the RTV guard call must follow slot classification and precede the host wrapper',
);

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const toPosixPath = value => {
  const normalized = path.resolve(value).replaceAll('\\', '/');
  return /^[A-Za-z]:\//.test(normalized)
    ? `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2)}`
    : normalized;
};

// Execute the actual slot script with deterministic date/systemctl/host-wrapper
// stubs. This catches a guard that is only present in an unused function, a
// missing ET hour, and an active-path defer that happens after host execution.
const bashProbe = spawnSync('bash', ['--version'], {encoding: 'utf8'});
assert.equal(bashProbe.error, undefined,
  'slot behavior contract requires bash to execute the shell entrypoint');
const slotBehaviorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-portal-slot-behavior-'));
try {
const slotBehaviorBin = path.join(slotBehaviorRoot, 'bin');
const slotBehaviorScripts = path.join(slotBehaviorRoot, 'scripts');
const slotBehaviorHostLog = path.join(slotBehaviorRoot, 'host-wrapper.log');
const slotBehaviorSystemctlLog = path.join(slotBehaviorRoot, 'systemctl.log');
const slotScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run_cloud_portal_section_queue_slot.sh');
fs.mkdirSync(slotBehaviorBin, {recursive: true});
fs.mkdirSync(slotBehaviorScripts, {recursive: true});
fs.writeFileSync(path.join(slotBehaviorBin, 'date'), `#!/usr/bin/env bash
set -Eeuo pipefail
case "\${1:-}" in
  +%H) printf '%s\\n' "\${SHEIN_TEST_SLOT_HOUR:?}" ;;
  +%M) printf '%s\\n' "\${SHEIN_TEST_SLOT_MINUTE:?}" ;;
  *) exit 64 ;;
esac
`);
fs.writeFileSync(path.join(slotBehaviorBin, 'systemctl'), `#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' "$*" >> "\${SHEIN_TEST_SYSTEMCTL_LOG:?}"
if [[ "\${1:-}" != is-active || "\${2:-}" != --quiet ]]; then exit 64; fi
case "\${3:-}" in
  shein-bi-cloud-rtv-verify.timer) [[ "\${SHEIN_TEST_RTV_ACTIVE:-0}" == 1 ]] ;;
  shein-bi-cloud-morning-chain.service) exit 1 ;;
  *) exit 1 ;;
esac
`);
const slotBehaviorHostWrapper = path.join(slotBehaviorScripts, 'run_host_heavy_job.sh');
fs.writeFileSync(slotBehaviorHostWrapper, `#!/usr/bin/env bash
set -Eeuo pipefail
{
  printf 'args='
  printf '%q ' "$@"
  printf '\\n'
  printf 'deadline=%s\\n' "\${SHEIN_BI_PORTAL_SECTION_QUEUE_DEADLINE_MINUTE:-}"
  printf 'max=%s\\n' "\${SHEIN_BI_PORTAL_SECTION_QUEUE_MAX_SECTIONS:-}"
  printf 'scheduled=%s\\n' "\${SHEIN_BI_PORTAL_SECTION_QUEUE_SCHEDULED:-}"
} > "\${SHEIN_TEST_HOST_LOG:?}"
`);

const runSlotBehaviorCase = ({label, hour, minute, rtvActive, expectedExit, expectedHost, expectedDeadline, expectedMax, expectRtvCheck, expectRtvDefer = false}) => {
  fs.rmSync(slotBehaviorHostLog, {force: true});
  fs.writeFileSync(slotBehaviorSystemctlLog, '');
  const command = [
    'set -Eeuo pipefail',
    `chmod +x ${shellQuote(toPosixPath(path.join(slotBehaviorBin, 'date')))} ${shellQuote(toPosixPath(path.join(slotBehaviorBin, 'systemctl')))} ${shellQuote(toPosixPath(slotBehaviorHostWrapper))}`,
    `export PATH=${shellQuote(toPosixPath(slotBehaviorBin))}:"$PATH"`,
    `export SHEIN_BI_ROOT=${shellQuote(toPosixPath(slotBehaviorRoot))}`,
    `export SHEIN_TEST_SLOT_HOUR=${shellQuote(hour)}`,
    `export SHEIN_TEST_SLOT_MINUTE=${shellQuote(minute)}`,
    `export SHEIN_TEST_RTV_ACTIVE=${shellQuote(rtvActive ? 1 : 0)}`,
    `export SHEIN_TEST_HOST_LOG=${shellQuote(toPosixPath(slotBehaviorHostLog))}`,
    `export SHEIN_TEST_SYSTEMCTL_LOG=${shellQuote(toPosixPath(slotBehaviorSystemctlLog))}`,
    `exec bash ${shellQuote(toPosixPath(slotScript))}`,
  ].join('; ');
  const result = spawnSync('bash', ['-c', command], {
    cwd: path.dirname(slotScript),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, `${label}: bash failed to start: ${result.error?.message || ''}`);
  assert.equal(result.status, expectedExit,
    `${label}: unexpected exit=${result.status} stdout=${result.stdout} stderr=${result.stderr}`);

  const output = `${result.stdout}\n${result.stderr}`;
  const systemctlLog = fs.readFileSync(slotBehaviorSystemctlLog, 'utf8');
  if (expectRtvCheck) {
    assert.match(systemctlLog, /shein-bi-cloud-rtv-verify\.timer/, `${label}: RTV status must be checked`);
  } else {
    assert.doesNotMatch(systemctlLog, /shein-bi-cloud-rtv-verify\.timer/, `${label}: RTV guard must not run`);
  }
  if (expectedHost) {
    assert.equal(fs.existsSync(slotBehaviorHostLog), true, `${label}: host wrapper must run`);
    const hostLog = fs.readFileSync(slotBehaviorHostLog, 'utf8');
    assert.match(hostLog, /--domain portal-sections/);
    assert.match(hostLog, /--class materializer/);
    assert.match(hostLog, /--lock-wait-sec 0/);
    assert.match(hostLog, new RegExp(`--deadline-minute ${expectedDeadline}`));
    assert.match(hostLog, new RegExp(`deadline=${expectedDeadline}`));
    assert.match(hostLog, new RegExp(`max=${expectedMax}`));
    assert.match(hostLog, /scheduled=1/);
  } else {
    assert.equal(fs.existsSync(slotBehaviorHostLog), false, `${label}: host wrapper must not run`);
  }
  if (expectRtvDefer) {
    assert.match(output, /defer reason=rtv_verify_timer_active/,
      `${label}: active RTV timer must produce the recognizable defer reason`);
  } else {
    assert.doesNotMatch(output, /defer reason=rtv_verify_timer_active/,
      `${label}: inactive/non-04 slot must not produce the RTV defer reason`);
  }
};

  runSlotBehaviorCase({
    label: '04:14 ET hour', hour: 4, minute: 14, rtvActive: false,
    expectedExit: 0, expectedHost: true, expectedDeadline: 17, expectedMax: 1, expectRtvCheck: false,
  });
  runSlotBehaviorCase({
    label: '04:44 RTV active', hour: 4, minute: 44, rtvActive: true,
    expectedExit: 75, expectedHost: false, expectRtvCheck: true, expectRtvDefer: true,
  });
  runSlotBehaviorCase({
    label: '04:44 RTV inactive', hour: 4, minute: 44, rtvActive: false,
    expectedExit: 0, expectedHost: true, expectedDeadline: 57, expectedMax: 2, expectRtvCheck: true,
  });
  runSlotBehaviorCase({
    label: '01:44 non-RTV hour', hour: 1, minute: 44, rtvActive: true,
    expectedExit: 0, expectedHost: true, expectedDeadline: 57, expectedMax: 2, expectRtvCheck: false,
  });
  runSlotBehaviorCase({
    label: '05:44 non-04 hour', hour: 5, minute: 44, rtvActive: true,
    expectedExit: 0, expectedHost: true, expectedDeadline: 57, expectedMax: 2, expectRtvCheck: false,
  });
} finally {
  fs.rmSync(slotBehaviorRoot, {recursive: true, force: true});
}

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
assert.equal(
  nextBiCanonicalAccountingCatchupDelay(Date.parse('2026-08-18T12:31:00.000Z')),
  11 * 60_000,
  'the canonical accounting stale check must align to :42 before the :44 external queue slot',
);
const currentDayOrder = {
  kind: 'order',
  entityId: 'schedule-contract-current-day-order',
  businessDate: '2026-08-18',
  occurredAt: '2026-08-18T12:00:00.000Z',
  receivedAt: '2026-08-18T12:00:01.000Z',
};
assert.deepEqual(liveAccountingQueuePlan(currentDayOrder), [],
  'current-day orders must stay on the lightweight live lane instead of advancing a heavy queue revision');

const currentDayCalls = [];
const currentDayResult = await executeBiLiveAccountingRefreshAttempt({
  sourceEvent: currentDayOrder,
  allowGenerateSections: true,
  readCoreMeta: async () => ({mode: 'api', generatedAt: '2026-08-18T19:59:00.000+08:00'}),
  generateLiveProjection: async generatedAt => currentDayCalls.push(['generate-live', generatedAt]),
  clearLiveProjectionFailure: () => currentDayCalls.push(['clear-live-failure']),
  publish: event => currentDayCalls.push(['publish-live', event]),
  persistAccountingPlan: async () => { throw new Error('current-day live lane must not persist heavy accounting'); },
  now: () => new Date('2026-08-18T12:00:01.000Z'),
});
assert.equal(currentDayResult.accountingQueued, false);
assert.deepEqual(currentDayCalls.map(call => call[0]), ['generate-live', 'clear-live-failure', 'publish-live']);

const historicalOrder = {
  ...currentDayOrder,
  entityId: 'schedule-contract-historical-order',
  businessDate: '2026-08-17',
  refreshHistoricalSections: true,
};
const canonicalAccountingPlan = liveAccountingQueuePlan(historicalOrder);
assert.deepEqual(canonicalAccountingPlan, [
  {section: 'profit', priority: 5},
  {section: 'homeRankings', priority: 5},
  {section: 'homeProfit', priority: 5},
  {section: 'orders', priority: 10},
  {section: 'afterSales', priority: 10},
  {section: 'productSalesDaily', priority: 50},
  {section: 'inventoryTrend', priority: 50},
  {section: 'rankings', priority: 50},
], 'historical order mutations must retain the complete canonical accounting plan');

const liveAccountingCalls = [];
const executeHistoricalOrder = persistAccountingPlan => executeBiLiveAccountingRefreshAttempt({
  sourceEvent: historicalOrder,
  allowGenerateSections: true,
  readCoreMeta: async () => ({mode: 'api', generatedAt: '2026-08-18T19:59:00.000+08:00'}),
  generateLiveProjection: async generatedAt => liveAccountingCalls.push(['generate-live', generatedAt]),
  clearLiveProjectionFailure: () => liveAccountingCalls.push(['clear-live-failure']),
  publish: event => liveAccountingCalls.push([event.accountingQueued ? 'publish-accounting-queued' : 'publish-live', event]),
  persistAccountingPlan,
  now: () => new Date('2026-08-18T12:00:01.000Z'),
});

const queueFailure = new Error('host-locked accounting queue unavailable');
let firstIdempotencyKey = '';
let firstCoalesceKey = '';
await assert.rejects(() => executeHistoricalOrder(async (plan, generatedAt, options) => {
  liveAccountingCalls.push(['persist-accounting-failed', plan, generatedAt, options]);
  firstIdempotencyKey = options.idempotencyKey;
  firstCoalesceKey = options.coalesceKey;
  throw queueFailure;
}), error => error === queueFailure && error.liveProjectionRefreshed === true,
'a queue failure after live publication must remain retryable without losing projection state');
assert.deepEqual(liveAccountingCalls.map(call => call[0]), [
  'generate-live',
  'clear-live-failure',
  'publish-live',
  'persist-accounting-failed',
], 'liveSalesToday must publish before canonical accounting enters the host-locked queue');

liveAccountingCalls.length = 0;
let retryIdempotencyKey = '';
let retryCoalesceKey = '';
const retryResult = await executeHistoricalOrder(async (plan, generatedAt, options) => {
  liveAccountingCalls.push(['persist-accounting', plan, generatedAt, options]);
  retryIdempotencyKey = options.idempotencyKey;
  retryCoalesceKey = options.coalesceKey;
});
assert.deepEqual(liveAccountingCalls.map(call => call[0]), [
  'generate-live',
  'clear-live-failure',
  'publish-live',
  'persist-accounting',
  'publish-accounting-queued',
]);
assert.deepEqual(liveAccountingCalls[3][1], canonicalAccountingPlan);
assert.equal(retryResult.accountingQueued, true);
assert.match(firstIdempotencyKey, /^portal-live:sha256:/);
assert.equal(retryIdempotencyKey, firstIdempotencyKey,
  'a retry of the same event and generation must reuse one queue identity');
assert.match(firstCoalesceKey, /^portal-generation:sha256:/);
assert.equal(retryCoalesceKey, firstCoalesceKey,
  'all retries in the same core generation must reuse one pending/running coalesce group');
assert.match(portal, /liveAccountingRefreshStopped \|\| liveAccountingRefreshRunning \|\| !liveAccountingRefreshPendingEvent/,
  'the live accounting runner must reject parallel duplicate execution');
assert.match(portal, /liveAccountingRefreshPendingEvent \|\|= sourceEvent[\s\S]*setTimeout\(runLiveAccountingRefresh, liveAccountingRetryMs\)/,
  'a failed queue persistence must retain the event for the single bounded retry timer');

console.log(JSON.stringify({ok: true, heavyUnits: heavyUnits.length}));
