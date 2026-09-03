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

const TEMP_ROOT_CLEANUP_OPTIONS = {recursive: true, force: true, maxRetries: 10, retryDelay: 50};

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const conditionalCapturesStatus = (source, {command, statusVariable}) => {
  // Shell line continuations do not change command structure. Normalize them
  // so both a direct command and an env-prefixed continued command are checked
  // by the same strict conditional contract.
  const normalized = String(source).replace(/\\\r?\n[ \t]*/g, ' ');
  const assignment = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\n]*"|'[^'\n]*'|[^\s;]+)`;
  const commandPattern = escapeRegExp(command);
  const statusPattern = escapeRegExp(statusVariable);
  return new RegExp(
    String.raw`\bif\s+(?:${assignment}\s+)*${commandPattern}\s*;\s*then\s+${statusPattern}=0\b[\s\S]*?\belse\b\s+${statusPattern}=\$\?[\s\S]*?\bfi\b`,
  ).test(normalized);
};

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
assert.match(hostWrapper, /if \(\( wait > remaining \)\); then wait="\$remaining"/,
  'lock wait must be clamped so it cannot consume the remaining deadline');
assert.match(hostWrapper, /resolve_effective_deadline\(\)/,
  'all deadline forms must be resolved before any lock is opened');
assert.match(hostWrapper, /DEADLINE_LABEL="epoch=\$DEADLINE_EPOCH_INPUT"/,
  'the explicit epoch must participate in the earliest-deadline selection');
assert.match(hostWrapper, /if \[\[ -n "\$DEADLINE_EPOCH" \]\] && \(\( now_epoch >= DEADLINE_EPOCH \)\); then/,
  'an already expired absolute deadline must defer before lock preparation');
assert.ok(
  hostWrapper.indexOf('resolve_effective_deadline') < hostWrapper.indexOf('prepare_shared_lock_file'),
  'deadline resolution must precede project/domain lock preparation');
assert.ok(
  hostWrapper.indexOf('resolve_effective_deadline') < hostWrapper.indexOf('exec 9<>"$HOST_LOCK"'),
  'deadline resolution must precede host lock acquisition');
assert.match(hostWrapper, /defer_lock_busy\(\)/,
  'lock contention must report deadline elapsed when the clamped wait reaches the cutoff');
assert.match(hostWrapper, /CHILD_FD_CLEAN_COMMAND=\(/,
  'the child must run through one descriptor-sanitizing command path');
assert.match(hostWrapper, /exec 7>&- 8>&- 9>&-/,
  'the child copy of all shared lock descriptors must be closed');
assert.match(hostWrapper, /"\$\{TIMEOUT_ARGS\[@\]\}" "\$\{CHILD_FD_CLEAN_COMMAND\[@\]\}" "\$@"/,
  'the timeout path must sanitize descriptors before executing the child');
assert.match(hostWrapper, /"\$\{CHILD_FD_CLEAN_COMMAND\[@\]\}" "\$@"/,
  'the no-timeout path must sanitize descriptors before executing the child');

// Dynamic regression: an already elapsed epoch must return 75 before the
// wrapper opens the neutral host lock or executes the child command. Skip only
// when this machine has no Bash runtime capable of running the shell wrapper.
const hostDeadlineBash = spawnSync('bash', ['-lc', 'command -v flock'], {encoding: 'utf8'});
if (hostDeadlineBash.status === 0) {
  const deadlineProbeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-host-heavy-deadline-probe-'));
  try {
    const hostLock = path.join(deadlineProbeRoot, 'host.lock');
    const ranMarker = path.join(deadlineProbeRoot, 'child-ran');
    fs.writeFileSync(hostLock, '');
    const bashPath = value => process.platform === 'win32'
      ? value.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replaceAll('\\', '/')
      : value;
    const expiredEpoch = Math.floor(Date.now() / 1000) - 60;
    const deadlineRun = spawnSync('bash', [bashPath(path.join(path.dirname(fileURLToPath(import.meta.url)), 'run_host_heavy_job.sh')),
      '--domain', 'deadline-before-lock',
      '--lock-wait-sec', '60',
      '--deadline-epoch', String(expiredEpoch),
      '--', 'bash', '-c', `touch ${bashPath(ranMarker)}`,
    ], {
      cwd: deadlineProbeRoot,
      env: {
        ...process.env,
        SHEIN_BI_ROOT: bashPath(deadlineProbeRoot),
        SHEIN_HOST_HEAVY_LOCK_FILE: bashPath(hostLock),
      },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(deadlineRun.error, undefined, deadlineRun.stderr || deadlineRun.stdout);
    assert.equal(deadlineRun.status, HOST_RESOURCE_DEFER_EXIT_CODE,
      `expired deadline must defer before lock acquisition: ${deadlineRun.stderr || deadlineRun.stdout}`);
    assert.equal(fs.existsSync(ranMarker), false,
      'expired deadline must not execute the child command');
    console.log('PASS deadline-before-lock dynamic regression');
  } finally {
    fs.rmSync(deadlineProbeRoot, TEMP_ROOT_CLEANUP_OPTIONS);
  }
} else {
  console.log('SKIP deadline-before-lock dynamic regression (bash/flock unavailable)');
}

// Dynamic regression: a child that starts a background descendant and exits
// must not leak the wrapper's 7/8/9 lock descriptors into that descendant.
// The second instance must acquire the same lock immediately after the first
// wrapper reaches its terminal child status, for both execution paths.
const hostFdBash = spawnSync('bash', ['-lc', 'command -v flock && command -v timeout'], {encoding: 'utf8'});
if (hostFdBash.status === 0) {
  const fdWrapperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run_host_heavy_job.sh');
  const bashPath = value => process.platform === 'win32'
    ? value.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replaceAll('\\', '/')
    : value;
  for (const withTimeout of [false, true]) {
    const fdProbeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-host-heavy-fd-inheritance-'));
    try {
      const scriptsLib = path.join(fdProbeRoot, 'scripts', 'lib');
      const hostLock = path.join(fdProbeRoot, 'host.lock');
      const childStarted = path.join(fdProbeRoot, 'child-started');
      const childPid = path.join(fdProbeRoot, 'child-pid');
      const secondStarted = path.join(fdProbeRoot, 'second-started');
      fs.mkdirSync(scriptsLib, {recursive: true});
      fs.writeFileSync(hostLock, '');
      fs.writeFileSync(path.join(scriptsLib, 'shared_lock.sh'), [
        '#!/usr/bin/env bash',
        'prepare_shared_lock_file() {',
        '  mkdir -p "$(dirname -- "$1")"',
        '  [[ -e "$1" ]] || : > "$1"',
        '}',
        '',
      ].join('\n'));
      fs.writeFileSync(path.join(fdProbeRoot, 'scripts', 'check_host_resource_pressure.mjs'), 'process.exit(0);\n');
      const probeEnv = {
        SHEIN_BI_ROOT: bashPath(fdProbeRoot),
        SHEIN_HOST_HEAVY_LOCK_FILE: bashPath(hostLock),
      };
      const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
      const runWithProbeEnv = (args, timeout) => {
        const exports = Object.entries(probeEnv).map(([name, value]) => `export ${name}=${shellQuote(value)}`);
        const command = [
          'set -Eeuo pipefail',
          ...exports,
          `exec bash ${shellQuote(args[0])} ${args.slice(1).map(shellQuote).join(' ')}`,
        ].join('; ');
        return spawnSync('bash', ['-c', command], {
          cwd: os.tmpdir(),
          encoding: 'utf8',
          timeout,
        });
      };
      const backgroundChildPath = path.join(fdProbeRoot, 'background-child.sh');
      fs.writeFileSync(backgroundChildPath, [
        '#!/usr/bin/env bash',
        'set -Eeuo pipefail',
        `printf "started\\n" > ${shellQuote(bashPath(childStarted))}`,
        'sleep 2 &',
        'background_pid=$!',
        `printf "%s\\n" "$background_pid" > ${shellQuote(bashPath(childPid))}`,
        'exit 0',
      ].join('\n'));
      const secondChildPath = path.join(fdProbeRoot, 'second-child.sh');
      fs.writeFileSync(secondChildPath, [
        '#!/usr/bin/env bash',
        'set -Eeuo pipefail',
        `printf "second\\n" > ${shellQuote(bashPath(secondStarted))}`,
      ].join('\n'));
      const firstArgs = [
        bashPath(fdWrapperPath),
        '--domain',
        withTimeout ? 'fd-descendant-timeout' : 'fd-descendant-no-timeout',
        '--lock-wait-sec', '1',
      ];
      if (withTimeout) firstArgs.push('--deadline-epoch', String(Math.floor(Date.now() / 1000) + 30));
      firstArgs.push('--', 'bash', bashPath(backgroundChildPath));
      const first = runWithProbeEnv(firstArgs, 5_000);
      assert.equal(first.error, undefined, first.stderr || first.stdout);
      assert.equal(first.status, 0,
        `background-child ${withTimeout ? 'timeout' : 'no-timeout'} first run failed: ${first.stderr || first.stdout}`);
      assert.equal(fs.existsSync(childStarted), true, 'the background-child probe must start its child');
      assert.match(fs.readFileSync(childPid, 'utf8').trim(), /^\d+$/,
        'the child must have started a real background descendant');

      const second = runWithProbeEnv([
        bashPath(fdWrapperPath),
        '--domain',
        withTimeout ? 'fd-descendant-timeout' : 'fd-descendant-no-timeout',
        '--lock-wait-sec', '1',
        '--', 'bash', bashPath(secondChildPath),
      ], 5_000);
      assert.equal(second.error, undefined, second.stderr || second.stdout);
      assert.equal(second.status, 0,
        `second instance must acquire locks after ${withTimeout ? 'timeout' : 'no-timeout'} child terminal state: ${second.stderr || second.stdout}`);
      assert.equal(fs.existsSync(secondStarted), true,
        'the second instance must run immediately instead of waiting for the detached descendant');
      console.log(`PASS child-fd-inheritance dynamic regression (${withTimeout ? 'timeout' : 'no-timeout'})`);
    } finally {
      fs.rmSync(fdProbeRoot, TEMP_ROOT_CLEANUP_OPTIONS);
    }
  }
} else {
  console.log('SKIP child-fd-inheritance dynamic regression (bash/flock/timeout unavailable)');
}

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
  'shein-bi-cloud-marketing-repair.service',
  'shein-bi-daily-inventory-replenishment-guard.service',
  'shein-bi-cloud-portal-section-queue.service',
  'shein-bi-cloud-manual-login-recovery.service',
];
for (const name of heavyUnits) {
  const content = unit(name);
  assert.match(content, /^Slice=shein-host-heavy-bi\.slice$/m, name);
  assert.match(content, /run_host_(?:heavy|browser_read)_job\.sh|run_cloud_(?:portal_section_queue|marketing_fallback)_slot\.sh|run_cloud_session_manager_job\.sh|cloud_order_closure_coordinator\.sh/, name);
  if (name === 'shein-bi-cloud-session-manager.service'
    || name === 'shein-bi-db-backup.service') {
    assert.doesNotMatch(content, /^SuccessExitStatus=75$/m,
      'session-manager and database backup deferrals must remain real failed unit results');
  } else {
    assert.match(content, /^SuccessExitStatus=75$/m, name);
  }
}

const orderClosureCoordinator = read('scripts/cloud_order_closure_coordinator.sh');
assert.ok(orderClosureCoordinator.includes('late candidates remain unclaimed for the next authorized activation" >&2\n    exit 75'),
  'late unclaimed candidates after the start deadline must defer the service instead of failing it');
assert.ok(orderClosureCoordinator.includes('resource deferral persisted until $START_DEADLINE attempts=$ATTEMPT" >&2\n    exit 75'),
  'resource deferral that reaches the start deadline must defer the service instead of failing it');
assert.ok(orderClosureCoordinator.includes('order lifecycle closure failed with exit=$status"\n    exit "$status"'),
  'non-deferral order closure failures must still propagate as failures');

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
assert.match(
  unit('shein-bi-cloud-today-sales-reconcile.service'),
  /^TimeoutStartSec=600$/m,
  'today-sales-reconcile service timeout must remain 600s to cover 19-store OpenAPI reconciliation without being killed at 120s',
);
assert.doesNotMatch(unit('shein-bi-cloud-today-sales-reconcile.service'), /^TimeoutStartSec=120$/m);

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
assert.deepEqual(calendars(unit('shein-bi-db-backup.timer')), [
  '*-*-* 01:45:00',
  '*-*-* 02:05:00',
  '*-*-* 02:25:00',
]);
assert.match(unit('shein-bi-db-backup.timer'), /^Persistent=true$/m,
  'the single database backup timer must catch up through its same-day marker contract');
assert.match(unit('shein-bi-db-backup.service'), /--deadline-at 02:37/,
  'database backup must retain a measured window and stop before the 02:45 yesterday-final lane');
assert.deepEqual(calendars(unit('shein-bi-cloud-yesterday.timer')), [
  '*-*-* 02:45:00',
  '*-*-* 03:05:00',
  '*-*-* 03:20:00',
]);
assert.deepEqual(calendars(unit('shein-bi-cloud-rtv-verify.timer')), ['*-*-* 04:50:00']);
assert.deepEqual(calendars(unit('shein-bi-cloud-morning-chain.timer')), ['*-*-* 07:10:00']);
assert.match(unit('shein-bi-cloud-morning-chain.timer'), /^Persistent=true$/m,
  'the single 07:10 morning timer is the only daily business catch-up exception');
assert.deepEqual(calendars(unit('shein-bi-cloud-openapi-stock-refresh.timer')), ['*-*-* *:18,48:00']);
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
assert.match(morning, /daily_operating_refresh_warning/,
  'a date completed with warning must be an idempotent no-op and preserve warning state without re-running');
assert.match(morning, /resume-skip all-store fetch; exact-date evidence already exists for all enabled stores/,
  'a restarted failed morning publish must reuse complete exact-date store evidence');
assert.match(morning, /daily supplements failed status=\$SUPPLEMENT_STATUS; the previous complete BI snapshot remains active/,
  'a terminal supplement failure must not leave the coordinator state stuck at running');
assert.match(morning, /daily inventory guard is waiting for host capacity inside the same run/,
  'temporary resource pressure must keep the inventory stage in the same coordinator run');
assert.match(morning, /if SHEIN_BI_INVENTORY_REQUIRE_PIPELINE_MARKERS=1[\s\S]*inventory_status=\$\?/,
  'the inventory scheduler command must be conditional so exit 75 is handled instead of tripping the ERR trap');
assert.match(morning, /inventory_marker_warning/,
  'the coordinator must recognize inventory guard warning markers on exit 2');
assert.match(morning, /if inventory_marker_warning; then[\s\S]*bypassing expired catch-up startup window/,
  'a completed inventory warning must bypass the expired startup window during final-marker convergence');
assert.match(morning, /if run_inventory_stage; then\s+INVENTORY_STAGE_STATUS=0\s+else\s+INVENTORY_STAGE_STATUS=\$\?/,
  'the expected inventory warning exit must be captured conditionally instead of tripping the ERR trap before marker publication');
assert.match(morning, /write_marker "daily-operating-refresh" "warning"/,
  'the coordinator must record daily-operating-refresh warning when inventory completed with item-level blockers');
assert.match(morning, /write_state "warning"/,
  'the coordinator state must record warning instead of failing the daily operating refresh');
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
const safeCostLedgerConditional = `
if SHEIN_INVENTORY_COST_LOGICAL_RUN_KEY="\${RUN_KEY}:inventory-cost" \\
  bash scripts/refresh_inventory_cost_ledger.sh; then
  COST_LEDGER_STATUS=0
else
  COST_LEDGER_STATUS=$?
fi`;
const unsafeCostLedgerInvocation = `
SHEIN_INVENTORY_COST_LOGICAL_RUN_KEY="\${RUN_KEY}:inventory-cost" \\
  bash scripts/refresh_inventory_cost_ledger.sh
COST_LEDGER_STATUS=$?`;
assert.equal(conditionalCapturesStatus(safeCostLedgerConditional, {
  command: 'bash scripts/refresh_inventory_cost_ledger.sh', statusVariable: 'COST_LEDGER_STATUS',
}), true, 'the contract detector must accept a per-invocation env prefix inside the if condition');
assert.equal(conditionalCapturesStatus(unsafeCostLedgerInvocation, {
  command: 'bash scripts/refresh_inventory_cost_ledger.sh', statusVariable: 'COST_LEDGER_STATUS',
}), false, 'the contract detector must reject an uncaptured cost-ledger invocation');
assert.equal(conditionalCapturesStatus(dailyRefresh, {
  command: 'bash scripts/refresh_inventory_cost_ledger.sh', statusVariable: 'COST_LEDGER_STATUS',
}), true,
  'an expected cost-ledger retry must be captured by a conditional instead of tripping the ERR trap');
assert.doesNotMatch(dailyRefresh, /^\s*export\s+SHEIN_INVENTORY_COST_LOGICAL_RUN_KEY=/m,
  'the stable logical run key must remain scoped to the single ledger invocation');
const safeCostLedgerProbeScript = [
  'set -Eeuo pipefail',
  'unset SCHEDULE_CONTRACT_PROBE_KEY',
  "trap 'exit 97' ERR",
  'COST_LEDGER_STATUS=0',
  'ledger_probe() { [[ "$SCHEDULE_CONTRACT_PROBE_KEY" == expected ]] && return 37; return 41; }',
  'if SCHEDULE_CONTRACT_PROBE_KEY=expected ledger_probe; then',
  '  COST_LEDGER_STATUS=0',
  'else',
  '  COST_LEDGER_STATUS=$?',
  'fi',
  'printf \'%s|%s\' "$COST_LEDGER_STATUS" "${SCHEDULE_CONTRACT_PROBE_KEY-unset}"',
].join('\n');
const unsafeCostLedgerProbeScript = [
  'set -Eeuo pipefail',
  "trap 'exit 97' ERR",
  'ledger_probe() { return 37; }',
  'SCHEDULE_CONTRACT_PROBE_KEY=expected ledger_probe',
  'COST_LEDGER_STATUS=$?',
].join('\n');
const costLedgerProbeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-ledger-conditional-probe-'));
try {
  // Windows' legacy bash.exe launcher can pre-expand shell variables passed in
  // a `-c` argument. Execute files instead so $? and env scoping are measured
  // by the target Bash process exactly as they are in the scheduled script.
  const bashProbePath = value => process.platform === 'win32'
    ? value.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replaceAll('\\', '/')
    : value;
  const safeCostLedgerProbePath = path.join(costLedgerProbeRoot, 'safe.sh');
  fs.writeFileSync(safeCostLedgerProbePath, safeCostLedgerProbeScript);
  const safeCostLedgerProbe = spawnSync('bash', [bashProbePath(safeCostLedgerProbePath)], {encoding: 'utf8'});
  assert.equal(safeCostLedgerProbe.status, 0, safeCostLedgerProbe.stderr);
  assert.equal(safeCostLedgerProbe.stdout, '37|unset',
    'conditional failure must enter else, preserve the exact status, avoid ERR trap, and not leak the env prefix');

  const unsafeCostLedgerProbePath = path.join(costLedgerProbeRoot, 'unsafe.sh');
  fs.writeFileSync(unsafeCostLedgerProbePath, unsafeCostLedgerProbeScript);
  const unsafeCostLedgerProbe = spawnSync('bash', [bashProbePath(unsafeCostLedgerProbePath)], {encoding: 'utf8'});
  assert.equal(unsafeCostLedgerProbe.status, 97,
    'the uncaptured counterexample must trip ERR handling before status assignment');
} finally {
  fs.rmSync(costLedgerProbeRoot, {recursive: true, force: true});
}
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
assert.match(unit('shein-bi-cloud-portal-section-queue.timer'), /^\s*OnCalendar=\*-\*-\* \*:02,32:00$/m);
const portalQueueUnit = unit('shein-bi-cloud-portal-section-queue.service');
const portalQueueWorker = read('scripts/cloud_portal_section_queue_worker.sh');
const portalQueueSlot = read('scripts/run_cloud_portal_section_queue_slot.sh');
assert.match(portalQueueUnit, /^Environment=SHEIN_BI_PORTAL_SECTION_QUEUE_PRODUCT_SALES_DAILY_TIMEOUT_SEC=600$/m,
  'productSalesDaily timeout must cover the observed ledger refresh plus volatility headroom');
assert.match(portalQueueUnit, /^Environment=SHEIN_BI_PORTAL_SECTION_QUEUE_PRODUCT_SALES_DAILY_MIN_RUNTIME_SEC=630$/m,
  'productSalesDaily min runtime must preserve 30s terminal-readback budget after the 600s curl cap');
assert.match(portalQueueWorker, /PRODUCT_SALES_DAILY_TIMEOUT_SEC="\$\{SHEIN_BI_PORTAL_SECTION_QUEUE_PRODUCT_SALES_DAILY_TIMEOUT_SEC:-600\}"/,
  'worker default productSalesDaily timeout must match the unit');
assert.match(portalQueueWorker, /PRODUCT_SALES_DAILY_MIN_RUNTIME_SEC="\$\{SHEIN_BI_PORTAL_SECTION_QUEUE_PRODUCT_SALES_DAILY_MIN_RUNTIME_SEC:-630\}"/,
  'worker default productSalesDaily min runtime must match the unit');
assert.match(portalQueueWorker, /PRODUCT_SALES_DAILY_TIMEOUT_SEC \+ 30 <= PRODUCT_SALES_DAILY_MIN_RUNTIME_SEC/,
  'productSalesDaily timeout must retain at least 30s for terminal evidence');
const portalQueueConditionMatch = portalQueueUnit.match(
  /^ExecCondition=\/usr\/bin\/bash -c '(.+)'$/m,
);
assert.ok(portalQueueConditionMatch, 'Portal queue unit must expose a parseable static schedule condition');
assert.match(portalQueueUnit, /date \+%%H/,
  'Portal queue unit must preserve systemd escaping for the hour format');
assert.match(portalQueueUnit, /date \+%%M/,
  'Portal queue unit must preserve systemd escaping for the minute format');
const portalQueueCondition = portalQueueConditionMatch[1].replaceAll('%%', '%');
assert.match(portalQueueUnit, /run_cloud_portal_section_queue_slot\.sh/);
assert.doesNotMatch(portalQueueUnit, /--deadline-next-hour/);
assert.match(portalQueueSlot, /DEADLINE_MINUTE=14/);
assert.match(portalQueueSlot, /DEADLINE_MINUTE=44/);
assert.match(portalQueueSlot, /HEAVY_ALLOWED=0/);
assert.match(portalQueueSlot, /HEAVY_ALLOWED=1/);
assert.doesNotMatch(portalQueueSlot, /MAX_SECTIONS=1/,
  'the managed slot must not retain the old one-section throughput cap');
assert.match(portalQueueSlot, /DEADLINE_MINUTE=14[\s\S]*MAX_SECTIONS=8[\s\S]*HEAVY_ALLOWED=0/,
  'the :02 slot must allow a bounded serial batch while remaining light-only');
assert.match(portalQueueSlot, /SHEIN_BI_PORTAL_SECTION_QUEUE_SCHEDULED=1/);
assert.match(portalQueueSlot, /daily_operating_refresh_active/);
assert.match(portalQueueSlot, /case "\$HOUR" in\s+2\|3\|7\)/,
  'the :02 slot must statically reject 02:02/03:02/07:02 maintenance windows');
assert.match(portalQueueSlot, /HOUR == 1/,
  'the slot itself must defense-in-depth reject the full 01:00 hour');
assert.match(portalQueueSlot, /reason=special_reserved_window/);
assert.match(portalQueueSlot, /MINUTE >= 1 && MINUTE <= 4/);
assert.match(portalQueueSlot, /MINUTE >= 31 && MINUTE <= 34/);
assert.match(portalQueueSlot, /--lock-wait-sec 0/);
assert.match(portalQueueWorker, /for \(\(index=1; index<=MAX_SECTIONS; index\+=1\)\);/,
  'the section worker must consume the bounded batch serially');
assert.match(portalQueueWorker, /EXCLUDED_SECTIONS\+=\(profit homeRankings productSalesDaily rankings inventoryTrend\)/,
  'the light slot must keep all five accounting-heavy sections excluded');
const hostWrapperExec = portalQueueSlot.indexOf('exec "$ROOT/scripts/run_host_heavy_job.sh"');
assert.ok(
  hostWrapperExec > portalQueueSlot.indexOf('yield_to_daily_coordinator'),
  'the daily coordinator guard must precede the host wrapper',
);

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const toPosixPath = value => {
  const normalized = path.resolve(value).replaceAll('\\', '/');
  return /^[A-Za-z]:\//.test(normalized)
    ? `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2)}`
    : normalized;
};

assert.match(portalQueueWorker, /case "\$START_HOUR:\$START_MINUTE" in/);
assert.match(portalQueueWorker, /01:\*\|02:0\[1-4\]\|03:0\[1-4\]\|07:0\[1-4\]\)/,
  'the worker must keep 01 blocked and reject the special :02 maintenance windows');
assert.match(portalQueueWorker, /\*:0\[1-4\]\|\*:3\[1-4\]\) SAFE_START=1/,
  'the worker must allow the :02/:32 slot windows outside the special hours');

// Execute the actual slot script with deterministic date/systemctl/host-wrapper
// stubs. This catches a guard that is only present in an unused function, a
// missing ET hour, and an active-path defer that happens after host execution.
const bashProbe = spawnSync('bash', ['--version'], {encoding: 'utf8'});
assert.equal(bashProbe.error, undefined,
  'slot behavior contract requires bash to execute the shell entrypoint');

// Execute both static schedule gates with deterministic date/queue stubs. The
// worker must reach its queue-empty path only for the same cases accepted by
// the unit condition; no cloud or Portal process is contacted here.
const portalScheduleBehaviorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-portal-schedule-behavior-'));
try {
  const portalScheduleBin = path.join(portalScheduleBehaviorRoot, 'bin');
  const portalScheduleLib = path.join(portalScheduleBehaviorRoot, 'scripts', 'lib');
  const portalScheduleDate = path.join(portalScheduleBin, 'date');
  const portalScheduleNode = path.join(portalScheduleBin, 'node');
  const portalScheduleFlock = path.join(portalScheduleBin, 'flock');
  const portalScheduleWorker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cloud_portal_section_queue_worker.sh');
  const portalScheduleLock = path.join(portalScheduleBehaviorRoot, 'state', 'locks', 'portal.lock');
  fs.mkdirSync(portalScheduleLib, {recursive: true});
  fs.mkdirSync(portalScheduleBin, {recursive: true});
  fs.writeFileSync(portalScheduleDate, `#!/usr/bin/env bash
set -Eeuo pipefail
case "\${1:-}" in
  +%H) printf '%s\\n' "\${SHEIN_TEST_SCHEDULE_HOUR:?}" ;;
  +%M) printf '%s\\n' "\${SHEIN_TEST_SCHEDULE_MINUTE:?}" ;;
  +%s) printf '0\\n' ;;
  +%Y-%m-%dT%H) printf '2026-08-22T%s\\n' "\${SHEIN_TEST_SCHEDULE_HOUR:?}" ;;
  -d) printf '9999\\n' ;;
  *) exit 64 ;;
esac
`);
  fs.writeFileSync(path.join(portalScheduleLib, 'shared_lock.sh'), `#!/usr/bin/env bash
prepare_shared_lock_file() {
  mkdir -p "$(dirname "$1")"
  : > "$1"
}
`);
  fs.writeFileSync(portalScheduleNode, `#!/usr/bin/env bash
set -Eeuo pipefail
[[ "\${1:-}" == scripts/manage_bi_portal_section_queue.mjs ]] || exit 64
printf '%s\\n' '{"counts":{"pending":0}}'
exit 75
`);
  fs.writeFileSync(portalScheduleFlock, '#!/usr/bin/env bash\nexit 0\n');

  const spawnScheduleProcess = (hour, minute, body) => spawnSync('bash', ['-c', [
    'set -Eeuo pipefail',
    `chmod +x ${shellQuote(toPosixPath(portalScheduleDate))} ${shellQuote(toPosixPath(portalScheduleNode))} ${shellQuote(toPosixPath(portalScheduleFlock))}`,
    `export PATH=${shellQuote(toPosixPath(portalScheduleBin))}:"$PATH"`,
    'hash -r',
    `export SHEIN_TEST_SCHEDULE_HOUR=${shellQuote(hour)}`,
    `export SHEIN_TEST_SCHEDULE_MINUTE=${shellQuote(minute)}`,
    `export SHEIN_BI_ROOT=${shellQuote(toPosixPath(portalScheduleBehaviorRoot))}`,
    `export SHEIN_BI_PORTAL_SECTION_QUEUE_SCHEDULED=1`,
     `export SHEIN_BI_PORTAL_SECTION_QUEUE_DEADLINE_MINUTE=14`,
    `export SHEIN_BI_PORTAL_SECTION_QUEUE_MAX_SECTIONS=1`,
    `export SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE=${shellQuote(toPosixPath(portalScheduleLock))}`,
    body,
  ].join('; ')], {
    cwd: path.dirname(portalScheduleWorker),
    encoding: 'utf8',
    timeout: 30_000,
  });

  const runPortalScheduleCase = ({label, hour, minute, expectedUnitExit, expectedWorkerExit}) => {
    const unitConditionForCase = portalQueueCondition
      .replace('$(date +%H)', hour)
      .replace('$(date +%M)', minute);
    const unitResult = spawnScheduleProcess(hour, minute,
      `eval ${shellQuote(unitConditionForCase)}`);
    assert.equal(unitResult.error, undefined, `${label}: unit condition failed to start`);
    assert.equal(unitResult.status, expectedUnitExit,
      `${label}: unexpected unit condition exit=${unitResult.status} condition=${portalQueueCondition} stdout=${unitResult.stdout} stderr=${unitResult.stderr}`);

    const workerResult = spawnScheduleProcess(hour, minute,
      `exec bash ${shellQuote(toPosixPath(portalScheduleWorker))}`);
    assert.equal(workerResult.error, undefined, `${label}: worker failed to start`);
    assert.equal(workerResult.status, expectedWorkerExit,
      `${label}: unexpected worker exit=${workerResult.status} stdout=${workerResult.stdout} stderr=${workerResult.stderr}`);
  };

  for (const specialHour of ['02', '03', '07']) {
    runPortalScheduleCase({
      label: `${specialHour}:02 special maintenance rejection`, hour: specialHour, minute: '02',
      expectedUnitExit: 1, expectedWorkerExit: 75,
    });
  }
  runPortalScheduleCase({
    label: '06:02 light window', hour: '06', minute: '02', expectedUnitExit: 0, expectedWorkerExit: 0,
  });
  runPortalScheduleCase({
    label: '06:32 heavy window', hour: '06', minute: '32', expectedUnitExit: 0, expectedWorkerExit: 0,
  });
  runPortalScheduleCase({
    label: '01:02 full-hour rejection', hour: '01', minute: '02', expectedUnitExit: 1, expectedWorkerExit: 75,
  });
  runPortalScheduleCase({
    label: '06:14 outside new slots', hour: '06', minute: '14', expectedUnitExit: 1, expectedWorkerExit: 75,
  });
} finally {
  fs.rmSync(portalScheduleBehaviorRoot, {recursive: true, force: true});
}

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
if [[ "\${1:-}" == show && "\${2:-}" == --no-pager && "\${3:-}" == --property=ActiveState && "\${4:-}" == --value && "\${5:-}" == shein-bi-cloud-morning-chain.service ]]; then
  if [[ "\${SHEIN_TEST_MORNING_SHOW_FAILURE:-0}" == 1 ]]; then exit 1; fi
  printf '%s\\n' "\${SHEIN_TEST_MORNING_STATE-inactive}"
else
  exit 64
fi
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
  printf 'heavy=%s\\n' "\${SHEIN_BI_PORTAL_SECTION_QUEUE_HEAVY_ALLOWED:-}"
} > "\${SHEIN_TEST_HOST_LOG:?}"
`);

const runSlotBehaviorCase = ({
  label,
  hour,
  minute,
  morningState = 'inactive',
  morningShowFailure = false,
  expectedExit,
  expectedHost,
  expectedDeadline,
  expectedMax,
  expectedHeavy,
  expectMorningDefer = false,
  expectMorningUnknownDefer = false,
}) => {
  fs.rmSync(slotBehaviorHostLog, {force: true});
  fs.writeFileSync(slotBehaviorSystemctlLog, '');
  const command = [
    'set -Eeuo pipefail',
    `chmod +x ${shellQuote(toPosixPath(path.join(slotBehaviorBin, 'date')))} ${shellQuote(toPosixPath(path.join(slotBehaviorBin, 'systemctl')))} ${shellQuote(toPosixPath(slotBehaviorHostWrapper))}`,
    `export PATH=${shellQuote(toPosixPath(slotBehaviorBin))}:"$PATH"`,
    `export SHEIN_BI_ROOT=${shellQuote(toPosixPath(slotBehaviorRoot))}`,
    `export SHEIN_TEST_SLOT_HOUR=${shellQuote(hour)}`,
    `export SHEIN_TEST_SLOT_MINUTE=${shellQuote(minute)}`,
    `export SHEIN_TEST_MORNING_STATE=${shellQuote(morningState)}`,
    `export SHEIN_TEST_MORNING_SHOW_FAILURE=${shellQuote(morningShowFailure ? 1 : 0)}`,
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
    if (expectedHeavy !== undefined) assert.match(hostLog, new RegExp(`heavy=${expectedHeavy}`));
  } else {
    assert.equal(fs.existsSync(slotBehaviorHostLog), false, `${label}: host wrapper must not run`);
  }
  if (expectMorningDefer) {
    assert.match(result.stderr, /defer reason=daily_operating_refresh_active/,
      `${label}: active morning chain must produce the recognizable defer reason`);
  } else {
    assert.doesNotMatch(output, /defer reason=daily_operating_refresh_active/,
      `${label}: inactive morning chain must not produce the morning defer reason`);
  }
  if (expectMorningUnknownDefer) {
    assert.match(result.stderr, /defer reason=daily_operating_refresh_state_unknown/,
      `${label}: unknown or failed morning state must produce the fail-closed defer reason`);
  } else {
    assert.doesNotMatch(output, /defer reason=daily_operating_refresh_state_unknown/,
      `${label}: known morning state must not produce the unknown-state defer reason`);
  }
};

  runSlotBehaviorCase({
    label: '06:02 light-only', hour: 6, minute: 2,
    expectedExit: 0, expectedHost: true, expectedDeadline: 14, expectedMax: 8, expectedHeavy: 0,
  });
  runSlotBehaviorCase({
    label: '08:32 morning active', hour: 8, minute: 32, morningState: 'active',
    expectedExit: 75, expectedHost: false, expectMorningDefer: true,
  });
  runSlotBehaviorCase({
    label: '08:32 morning activating', hour: 8, minute: 32, morningState: 'activating',
    expectedExit: 75, expectedHost: false, expectMorningDefer: true,
  });
  runSlotBehaviorCase({
    label: '08:32 morning reloading', hour: 8, minute: 32, morningState: 'reloading',
    expectedExit: 75, expectedHost: false, expectMorningDefer: true,
  });
  runSlotBehaviorCase({
    label: '08:32 morning unknown state', hour: 8, minute: 32, morningState: 'deactivating',
    expectedExit: 75, expectedHost: false, expectMorningUnknownDefer: true,
  });
  runSlotBehaviorCase({
    label: '08:32 morning empty state', hour: 8, minute: 32, morningState: '',
    expectedExit: 75, expectedHost: false, expectMorningUnknownDefer: true,
  });
  runSlotBehaviorCase({
    label: '08:32 morning state query failure', hour: 8, minute: 32, morningShowFailure: true,
    expectedExit: 75, expectedHost: false, expectMorningUnknownDefer: true,
  });
  runSlotBehaviorCase({
    label: '08:32 morning inactive', hour: 8, minute: 32,
    expectedExit: 0, expectedHost: true, expectedDeadline: 44, expectedMax: 8, expectedHeavy: 1,
  });
  runSlotBehaviorCase({
    label: '08:32 morning failed', hour: 8, minute: 32, morningState: 'failed',
    expectedExit: 0, expectedHost: true, expectedDeadline: 44, expectedMax: 8,
  });
  for (const specialHour of [2, 3, 7]) {
    runSlotBehaviorCase({
      label: `${String(specialHour).padStart(2, '0')}:02 special maintenance rejection`,
      hour: specialHour, minute: 2, expectedExit: 75, expectedHost: false,
    });
  }
  runSlotBehaviorCase({
    label: '01:02 full-hour rejection', hour: 1, minute: 2,
    expectedExit: 75, expectedHost: false,
  });
  runSlotBehaviorCase({
    label: '06:14 old slot rejection', hour: 6, minute: 14,
    expectedExit: 75, expectedHost: false,
  });
} finally {
  fs.rmSync(slotBehaviorRoot, {recursive: true, force: true});
}

assert.match(portalQueueWorker, /unscheduled_direct_entry/);
assert.match(portalQueueWorker, /case "\$START_HOUR:\$START_MINUTE" in/);
assert.match(portalQueueWorker, /01:\*\|02:0\[1-4\]\|03:0\[1-4\]\|07:0\[1-4\]\)/);
assert.match(portalQueueWorker, /\*:0\[1-4\]\|\*:3\[1-4\]\) SAFE_START=1/);
assert.match(portalQueueWorker, /outside_safe_start_window/);
assert.match(portalQueueWorker, /stop before next core lane/);
assert.match(portalQueueWorker,
  /MIN_REMAINING_RUNTIME_SEC="\$\{SHEIN_BI_PORTAL_SECTION_QUEUE_MIN_REMAINING_RUNTIME_SEC:-120\}"/,
  'the worker must default the generic remaining-time guard to 120 seconds');
assert.match(portalQueueWorker,
  /\[\[ "\$MIN_REMAINING_RUNTIME_SEC" =~ \^\[1-9\]\[0-9\]\*\$ \]\] \|\| exit 64/,
  'the generic remaining-time guard must reject invalid configuration');
assert.match(portalQueueWorker,
  /if \(\( REMAINING_SEC < MIN_REMAINING_RUNTIME_SEC \)\); then[\s\S]*stop before next section[\s\S]*break/,
  'the worker must stop before a new claim below the generic 120-second budget');
assert.match(portalQueueWorker, /if \(\( REMAINING_SEC <= 10 \)\); then/,
  'the hard deadline guard must remain in place');

for (const sec of ['PROFIT', 'PRODUCT_SALES_DAILY', 'HOME_RANKINGS', 'RANKINGS', 'INVENTORY_TREND']) {
  const envName = `SHEIN_BI_PORTAL_SECTION_QUEUE_${sec}_MIN_RUNTIME_SEC`;
  assert.match(portalQueueUnit, new RegExp(`^Environment=${envName}=630$`, 'm'));
  assert.ok(portalQueueWorker.includes(`${sec}_MIN_RUNTIME_SEC="\${${envName}:-630}"`));
}
assert.match(portalQueueUnit, /^Environment=SHEIN_BI_PORTAL_SECTION_QUEUE_PRODUCT_SALES_DAILY_TIMEOUT_SEC=600$/m);
assert.ok(portalQueueWorker.includes('PRODUCT_SALES_DAILY_TIMEOUT_SEC="${SHEIN_BI_PORTAL_SECTION_QUEUE_PRODUCT_SALES_DAILY_TIMEOUT_SEC:-600}"'));
assert.match(portalQueueWorker, /EXCLUDED_SECTIONS\+=\(profit homeRankings productSalesDaily rankings inventoryTrend\)/,
  'the light slot must exclude all accounting-heavy sections');
assert.match(portalQueueWorker, /REMAINING_SEC < RANKINGS_MIN_RUNTIME_SEC[\s\S]*EXCLUDED_SECTIONS\+=\(rankings\)/);
assert.match(portalQueueWorker, /REMAINING_SEC < INVENTORY_TREND_MIN_RUNTIME_SEC[\s\S]*EXCLUDED_SECTIONS\+=\(inventoryTrend\)/);

const repair = read('scripts/cloud_marketing_repair_worker.sh');
const repairSlot = read('scripts/run_cloud_marketing_fallback_slot.sh');
const normalizedRepair = repair.replace(/\r\n/g, '\n');
const leaseHelperStart = normalizedRepair.indexOf('ensure_browser_lease() {');
const leaseHelperEnd = normalizedRepair.indexOf('\n}\n\nupdate_stage()', leaseHelperStart);
assert.ok(leaseHelperStart >= 0 && leaseHelperEnd > leaseHelperStart,
  'repair worker must keep a bounded browser lease helper');
const leaseHelper = normalizedRepair.slice(leaseHelperStart, leaseHelperEnd);
assert.match(leaseHelper, /if \[\[ "\$LEASE_ACQUIRED" == "1" \]\]; then[\s\S]*return 0/,
  'browser lease helper must be idempotent after the first acquire');
assert.match(leaseHelper, /lease_action acquire \|\| return \$\?/,
  'browser lease helper must own the guarded acquire');
assert.match(leaseHelper, /export SHEIN_BI_BROWSER_LEASE_TASK="\$LEASE_TASK"/);
assert.match(leaseHelper, /export SHEIN_BI_BROWSER_LEASE_RUN_ID="\$RUN_ID"/);
assert.match(leaseHelper, /cleanup_store_browsers/);
const finalSnapshotStart = normalizedRepair.indexOf('run_terminal_final_snapshot() {');
const finalSnapshotEnd = normalizedRepair.indexOf('\n}\n\nrun_final_readback()', finalSnapshotStart);
assert.ok(finalSnapshotStart >= 0 && finalSnapshotEnd > finalSnapshotStart,
  'repair worker must keep a bounded terminal snapshot function for lease ordering checks');
const finalSnapshot = normalizedRepair.slice(finalSnapshotStart, finalSnapshotEnd);
const firstHeartbeatAt = finalSnapshot.indexOf('lease_action heartbeat');
assert.ok(
  finalSnapshot.indexOf('ensure_browser_lease || return $?') >= 0
    && finalSnapshot.indexOf('ensure_browser_lease || return $?') < firstHeartbeatAt,
  'terminal final snapshot must ensure the browser lease before its first heartbeat',
);
assert.equal(
  [...normalizedRepair.matchAll(/^[ \t]*lease_action acquire \|\| return \$\?[ \t]*$/gm)].length,
  1,
  'repair worker must keep acquire behind one idempotent lease helper',
);
const mainRemainingGroupsAt = normalizedRepair.indexOf('\nREMAINING_GROUPS="$MAX_GROUPS"');
const mainEnsureAt = normalizedRepair.indexOf('\nensure_browser_lease', mainRemainingGroupsAt);
const immediateConsumeAt = normalizedRepair.indexOf('consume_immediate_authorization_locked', mainRemainingGroupsAt);
const firstExecuteAt = normalizedRepair.indexOf(' --execute', mainRemainingGroupsAt);
const firstGroupProcessingAt = normalizedRepair.indexOf('while (( REMAINING_GROUPS > 0 ))', mainRemainingGroupsAt);
assert.ok(mainRemainingGroupsAt >= 0,
  'repair worker must initialize REMAINING_GROUPS in the main execution path');
assert.ok(mainEnsureAt > mainRemainingGroupsAt,
  'main execution path must ensure_browser_lease after REMAINING_GROUPS initialization');
assert.ok(immediateConsumeAt > mainEnsureAt,
  'main execution path must ensure_browser_lease before immediate authorization consume');
assert.ok(firstExecuteAt > mainEnsureAt,
  'main execution path must ensure_browser_lease before any execute operation');
assert.ok(firstGroupProcessingAt > mainEnsureAt,
  'main execution path must ensure_browser_lease before group processing loops');
assert.match(repair, /write_state deferred_to_local/);
assert.match(unit('shein-bi-cloud-marketing-repair.service'), /run_cloud_marketing_fallback_slot\.sh/);
assert.match(repairSlot, /--defer-reason deferred_to_local/);
assert.match(repairSlot, /GRACEFUL_CUTOFF_EPOCH/);
assert.match(repairSlot, /OUTER_HARD_DEADLINE_EPOCH/);
assert.match(repairSlot, /date -d .*22:55:00/);
assert.match(repairSlot, /date -d .*23:10:00/);
assert.match(repairSlot, /--deadline-epoch/);
assert.match(repairSlot, /HOUR == 20/);
assert.match(repairSlot, /HOUR == 21/);
assert.match(unit('shein-bi-cloud-marketing-repair.service'), /SHEIN_BI_MARKETING_REPAIR_MAX_GROUPS=32/);
assert.match(unit('shein-bi-cloud-marketing-repair.service'), /SHEIN_BI_MARKETING_REPAIR_MIN_START_BUDGET_SEC=900/);
const marketingRepairUnit = unit('shein-bi-cloud-marketing-repair.service');
const marketingRepairTimeoutMatch = marketingRepairUnit.match(/^TimeoutStartSec=([0-9]+)$/m);
assert.ok(marketingRepairTimeoutMatch,
  'marketing repair service must expose a parseable TimeoutStartSec');
const marketingRepairTimeoutStartSec = Number(marketingRepairTimeoutMatch[1]);
assert.ok(marketingRepairTimeoutStartSec >= 9000,
  'marketing repair service timeout must still cover at least the legacy 9000s recovery envelope');
assert.equal(marketingRepairTimeoutStartSec, 26400,
  'marketing repair service timeout must cover the current 20:45 to 04:05 recovery contract without expanding the write window');
assert.match(unit('shein-bi-cloud-marketing-repair.service'), /SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION=cloud/);
assert.match(unit('shein-bi-cloud-marketing-repair.service'), /SHEIN_BI_MARKETING_CLOUD_FALLBACK_ENABLED=true/);
assert.match(repair, /CURRENT_MINUTE >= 23 && CURRENT_MINUTE <= 42/);
assert.match(repair, /remaining exact queue preserved for local-browser continuation/);
assert.match(repair, /IS_CLOUD_EXECUTION=1/);
assert.doesNotMatch(repair, /AUTOMATION_CONTEXT.*== "cloud_timer"/);
assert.match(repair, /SHEIN_BI_MARKETING_CLOUD_WRITE_GATE=bounded-repair-v1/);
assert.match(repair, /fallback readback found no remaining work/);
assert.match(repair, /refuse all transaction work/);
assert.match(repair, /outside 20:45-22:55 same-day window/);

const fallbackBatch = read('scripts/marketing/batch_apply_new_listing_limited_discount.mjs');
assert.match(fallbackBatch, /DEFAULT_MIN_START_BUDGET_SEC = 15 \* 60/);
assert.match(fallbackBatch, /--graceful-cutoff-epoch|--deadline-epoch/);
assert.match(fallbackBatch, /Absolute graceful cutoff epoch must be a future safe integer/);
const groupGateAt = fallbackBatch.indexOf('const startBudget = groupStartBudget(args);');
const groupLaunchAt = fallbackBatch.indexOf('launchSummary = summarizeRaw(await launchStore(storeKey));');
const groupProcessAt = fallbackBatch.indexOf('const result = await processStore({');
assert.ok(groupGateAt >= 0 && groupGateAt < groupLaunchAt && groupGateAt < groupProcessAt,
  'graceful cutoff must gate every group before browser launch and transaction entry');
assert.match(fallbackBatch, /processedSelectedKeys/);
assert.match(fallbackBatch, /selectedEntries\.filter\(entry => \{[\s\S]*!processedSelectedKeys\.has\(key\)/,
  'groups skipped by the graceful cutoff must be selected by explicit unprocessed keys');
assert.doesNotMatch(fallbackBatch, /selectedEntries\.slice\(selectedCursor\)/,
  'deferred accounting must not depend on a store-group cursor');
assert.match(fallbackBatch, /for \(const file of storeEntries\)[\s\S]*await processStore/,
  'multiple groups must remain serial through one awaited processStore path');
const processStoreStart = fallbackBatch.indexOf('async function processStore(');
const processStoreEnd = fallbackBatch.indexOf('\n}\n\nfunction summarizeTotals', processStoreStart);
const processStoreSource = fallbackBatch.slice(processStoreStart, processStoreEnd);
assert.match(processStoreSource, /executeLimitedDiscountWithInventoryTransaction/);
assert.match(processStoreSource, /finally \{[\s\S]*closeStore\(storeKey\)/,
  'an in-progress group must retain its terminal inventory transaction and cleanup path');
assert.deepEqual(calendars(unit('shein-bi-cloud-marketing-repair.timer')), [
  '*-*-* 20:45:00',
  '*-*-* 21:15:00',
]);

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
  'the canonical accounting stale check must preserve its deterministic :42 phase independently of the :02/:32 external queue slots',
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
