#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {acquireBrowserTaskLease, releaseBrowserTaskLease} from '../lib/browser_task_lease.mjs';
import {inspectManagedStoreSession, parseArgs, prepareReloginBrowser} from './auto_relogin_shein_store.mjs';
import {launchStore, closeStore, recoverMarketingLogin, normalizeManualResumeResult, isManualResumeResultSettled} from './marketing/batch_restore_manual_limited_discounts.mjs';
import {chromeProfileIdentity, readManagedChromeIdentity, runPowerShellUtf8, withChromeProfileStartup} from '../lib/chrome_profile_startup.mjs';
import {cleanupManagedStoreSession, parseArgs as parseCleanupArgs} from './cleanup_shein_store_browsers.mjs';
import {completeManagedLauncherStartup} from './launch_store_browser.mjs';

// No browser, network or production state is used. Real Windows PowerShell is
// permitted only for UTF-8 JSON roundtrip; all process mutation is injected.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-session-recovery-'));
const store = {storeKey: 'DL', profileKey: 'fixture-dl', port: 9321};
const profileDir = path.join(root, 'profiles', 'persistent-fixture-dl-profile');
const env = {SHEIN_BI_RUNTIME_ROOT: path.join(root, 'runtime')};
const command = [`--user-data-dir=${profileDir}`, '--remote-debugging-port=9321'];
let rows = [{pid: 12345, command, startedAt: 'fixture-start-1'}];
let running = true;
const inspect = (target, expected) => inspectManagedStoreSession(target, expected, {
  root, env, processes: async () => rows, probe: async () => running,
});
const url = 'https://sso.geiwohuo.com/#/mbrs/marketing/list';
let launcherCalls = 0;
let cleanupCalls = 0;
const forbidLauncher = async () => { throw new Error('unexpected second launcher'); };
try {
  await fs.mkdir(profileDir, {recursive: true});
  const localState = Buffer.from('{"sentinel":"profile must remain untouched"}\n');
  await fs.writeFile(path.join(profileDir, 'Local State'), localState);
  const sessionEvidence = await inspect(store);
  const initial = await launchStore('DL', {store, inspectSession: inspect, runCommand: async (_node, args, timeout, options) => {
    launcherCalls++;
    assert.deepEqual(args, ['scripts/launch_store_browser.mjs', 'DL', '--headless', '--url', url]);
    assert.equal(timeout, 60000);
    assert.equal(options.label, 'launch DL');
    return {ok: true, launcherPid: 1111, stdout: JSON.stringify({storeKey: 'DL', port: 9321, url, reused: false, pageReady: true, managedSession: sessionEvidence}), stderr: ''};
  }});
  assert.equal(initial.ok, true, initial.stderr);
  assert.equal(initial.evidence.launcherPid, 1111);
  assert.equal(initial.evidence.browserPid, 12345);
  assert.equal(initial.evidence.port, 9321);
  assert.equal(initial.evidence.url, url);
  assert.equal(JSON.stringify(initial.evidence).includes(profileDir), false, 'profile paths/command lines are not evidence');
  const original = initial.managedSession;

  const opts = parseArgs(['DL', '--headless', '--require-marketing', '--managed-session-json', JSON.stringify(original)]);
  const attached = await prepareReloginBrowser(store, opts, {inspectSession: inspect, launch: forbidLauncher});
  assert.deepEqual(attached.session, original);
  assert.equal(attached.launcherInvoked, false);
  assert.equal(attached.reused, true);
  assert.throws(() => parseArgs(['DL', '--managed-session-json', 'null']), /Invalid managed session/);
  assert.throws(() => parseArgs(['DX', '--managed-session-json', JSON.stringify(original)]), /Invalid managed session/);
  assert.throws(() => parseArgs(['DL', '--close-after', '--managed-session-json', JSON.stringify(original)]), /forbids/);
  assert.throws(() => parseArgs(['DL,DX', '--managed-session-json', JSON.stringify(original)]), /requires one store/);
  for (const args of [['DL'], ['DL', '--headless', '--require-marketing']]) {
    const legacy = parseArgs(args);
    let legacyLaunches = 0;
    await prepareReloginBrowser(store, legacy, {
      inspectSession: async () => { throw new Error('legacy caller must not require attachment evidence'); },
      launch: async (...received) => { legacyLaunches++; assert.deepEqual(received, ['DL', legacy.visible]); },
    });
    assert.equal(legacyLaunches, 1, 'other callers preserve their default launch path');
  }

  // Same physical profile through a junction/symlink and quoted Windows command
  // remains a legitimate reuse; a different port or PID never does.
  const alias = path.join(root, 'profile alias');
  await fs.symlink(profileDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  rows = [{pid: 12345, startedAt: 'fixture-start-1', command: `chrome.exe "--user-data-dir=${alias}" --remote-debugging-port=9321`}];
  assert.deepEqual(await inspect(store, original), original);
  rows = [{pid: 12345, startedAt: 'fixture-start-1', command: [`--user-data-dir=${profileDir}`, '--remote-debugging-port=9999']}];
  await assert.rejects(prepareReloginBrowser(store, opts, {inspectSession: inspect, launch: forbidLauncher}), /ownership mismatch/);
  await assert.rejects(closeStore('DL', initial, {runCommand: async (_node, args) => {
    const parsed = parseCleanupArgs(args.slice(1));
    assert.deepEqual(parsed.managedSession, original);
    return await cleanupManagedStoreSession(store, parsed.managedSession, {root, env, processes: async () => rows,
      alive: async () => true, signal: async () => { cleanupCalls++; }});
  }}), /ownership|ambiguous/);
  assert.equal(cleanupCalls, 0, 'real ownership mismatch never calls cleanup');
  rows = [{pid: 54321, startedAt: 'fixture-start-1', command}];
  await assert.rejects(inspect(store, original), /changed since initial launcher/);
  rows = [];
  running = false;
  await assert.rejects(prepareReloginBrowser(store, opts, {inspectSession: inspect, launch: forbidLauncher}), /relaunch forbidden/);
  running = true;
  rows = [{pid: 12345, startedAt: 'fixture-start-1', command}];
  const other = path.join(root, 'other-profile');
  await fs.mkdir(other);
  rows.push({pid: 55555, command: [`--user-data-dir=${other}`, '--remote-debugging-port=9321']});
  await assert.rejects(inspect(store, original), /ownership mismatch/);
  rows = [{pid: 12345, startedAt: 'fixture-start-1', command}];

  const lease = {root, storeKey: 'DL', task: 'fixture-owner', runId: 'fixture-run', ttlSec: 120};
  acquireBrowserTaskLease(lease);
  try {
    await assert.rejects(inspect(store, original), {code: 'PROFILE_LEASE_ACTIVE'});
    env.SHEIN_BI_BROWSER_LEASE_TASK = lease.task;
    env.SHEIN_BI_BROWSER_LEASE_RUN_ID = lease.runId;
    assert.deepEqual(await inspect(store, original), original);
  } finally { releaseBrowserTaskLease(lease); }

  let recoveryCalls = [];
  let identityOk = true;
  let attachment = attached;
  let reportMissing = false;
  let childOk = true;
  const recoveryDeps = {
    runCommand: async (_node, args) => {
      recoveryCalls.push(args[0]);
      assert.equal(args.includes('--execute'), false, 'login recovery never submits an activity');
      if (args[0] === 'scripts/auto_relogin_shein_store.mjs') {
        const parsed = parseArgs(args.slice(1));
        assert.deepEqual(parsed.managedSession, original, 'runner passes implemented flags and original evidence');
        const actual = await prepareReloginBrowser(store, parsed, {inspectSession: inspect, launch: forbidLauncher});
        assert.deepEqual(actual, attached);
        return {ok: childOk, stdout: JSON.stringify({reportFile: 'fixture-relogin.json'}), stderr: ''};
      }
      assert.deepEqual(args, ['scripts/marketing/check_store_profile_identity.mjs', '--stores', 'DL', '--no-launch', '--no-close', '--no-login-recovery']);
      return {ok: true, stdout: `JSON ${path.join(root, 'fixture-identity.json')}`, stderr: ''};
    },
    readJson: async file => file.endsWith('fixture-relogin.json')
      ? (reportMissing ? null : {results: [{storeKey: 'DL', ok: true, steps: attachment ? [attachment] : []}]})
      : {rows: [{storeKey: 'DL', ok: identityOk, identity: identityOk ? {} : {accountConflicts: ['fixture-other']}}]},
  };
  const recovered = await recoverMarketingLogin('DL', '2026-09-06', original, recoveryDeps);
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.sessionAttachment.session, original);
  assert.deepEqual(recoveryCalls, ['scripts/auto_relogin_shein_store.mjs', 'scripts/marketing/check_store_profile_identity.mjs']);
  identityOk = false;
  assert.equal((await recoverMarketingLogin('DL', '2026-09-06', original, recoveryDeps)).assessment.terminal, true);
  for (const failure of ['missing-attachment', 'wrong-pid', 'missing-report', 'failed-child']) {
    recoveryCalls = [];
    attachment = failure === 'missing-attachment' ? null : failure === 'wrong-pid'
      ? {...attached, session: {...original, browserPid: 88888}} : attached;
    reportMissing = failure === 'missing-report';
    childOk = failure !== 'failed-child';
    const blocked = await recoverMarketingLogin('DL', '2026-09-06', original, recoveryDeps);
    assert.equal(blocked.ok, false, failure);
    assert.deepEqual(recoveryCalls, ['scripts/auto_relogin_shein_store.mjs'], `${failure}: no identity or business retry after missing evidence`);
  }

  const absent = await closeStore('DL', {ok: false}, {runCommand: async () => { cleanupCalls++; }});
  assert.equal(absent.skipped, true);
  const cleaned = await closeStore('DL', initial, {store, inspectSession: inspect, runCommand: async (_node, args) => {
    cleanupCalls++;
    assert.equal(args[0], 'scripts/cleanup_shein_store_browsers.mjs');
    return {ok: true};
  }});
  assert.equal(cleaned.ok, true);
  assert.equal(cleanupCalls, 1);
  assert.equal(launcherCalls, 1, 'all recoveries attach without a second launcher');
  assert.equal(isManualResumeResultSettled(normalizeManualResumeResult({status: 'recoverable_login_pending', transaction: {writeAttempted: true}})), true, 'pending submission remains settled: never resubmit');

  // Exercise the actual PowerShell pipe, including a real Chinese directory.
  // A mocked spawn cannot detect Windows OEM output decoded as UTF-8.
  if (process.platform === 'win32') {
    const chineseAlias = path.join(root, '真实中文路径 店铺');
    await fs.symlink(profileDir, chineseAlias, 'junction');
    try {
      const line = `chrome.exe "--user-data-dir=${chineseAlias}" --remote-debugging-port=9321`;
      const stdout = runPowerShellUtf8("[pscustomobject]@{ProcessId=101;CommandLine=$env:SHEIN_FIXTURE_COMMAND;StartedAt='fixture-start-1'} | ConvertTo-Json -Compress", {
        env: {...process.env, SHEIN_FIXTURE_COMMAND: line},
      });
      assert.equal(stdout.includes('\uFFFD'), false);
      const returned = JSON.parse(stdout);
      assert.equal(returned.CommandLine, line, 'real PowerShell Chinese path must roundtrip exactly');
      const observed = [{pid: returned.ProcessId, command: returned.CommandLine, startedAt: returned.StartedAt}];
      assert.equal((await readManagedChromeIdentity({store, profileDir, observed})).browserPid, 101);
      console.log('PASS: real Windows PowerShell UTF-8 Chinese path roundtrip; replacement characters=0');
    } finally { await fs.unlink(chineseAlias); }
  } else console.log('SKIP: real Windows PowerShell roundtrip (non-Windows host)');

  const backup = `${profileDir}-backup`;
  await fs.mkdir(backup);
  const target = {pid: 101, startedAt: 'fixture-start-1', command: `chrome.exe "--user-data-dir=${alias}" --remote-debugging-port=9321`};
  const unrelated = {pid: 102, startedAt: 'fixture-start-2', command: [`--user-data-dir=${backup}`, '--remote-debugging-port=9999']};
  const exact = {...original, browserPid: 101};
  const singleton = path.join(profileDir, 'SingletonLock');
  const resetSingleton = () => fs.writeFile(singleton, 'fixture-lock');
  const assertSingleton = async () => assert.equal(await fs.readFile(singleton, 'utf8'), 'fixture-lock');

  let current = [target, unrelated];
  let signals = [];
  const cleanupOptions = {
    root, env, processes: async () => current,
    alive: async pid => current.some(row => row.pid === pid), killAfterSec: 0, exitTimeoutMs: 0,
    signal: async (pid, name) => { signals.push({pid, name}); current = current.filter(row => row.pid !== pid); },
  };
  await resetSingleton();
  const exactCleaned = await cleanupManagedStoreSession(store, exact, cleanupOptions);
  assert.equal(exactCleaned.ok, true);
  assert.deepEqual(signals, [{pid: 101, name: 'SIGTERM'}], 'alias PID101 only; never substring-matched backup PID102');
  assert.deepEqual(current, [unrelated]);
  await assert.rejects(fs.stat(singleton), {code: 'ENOENT'});

  // Inability to confirm exit forbids Singleton cleanup, even after SIGKILL.
  current = [target, unrelated]; signals = [];
  await resetSingleton();
  const stuck = await cleanupManagedStoreSession(store, exact, {...cleanupOptions,
    signal: async (pid, name) => { signals.push({pid, name}); },
  });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.reason, 'managed_target_exit_unconfirmed');
  assert.deepEqual(signals, [{pid: 101, name: 'SIGTERM'}, {pid: 101, name: 'SIGKILL'}]);
  await assertSingleton();

  // A recycled PID between TERM and KILL is a different process, even with the
  // same command line/profile. Never signal it or remove its Singleton files.
  signals = [];
  await assert.rejects(cleanupManagedStoreSession(store, exact, {...cleanupOptions,
    signal: async (pid, name) => { signals.push({pid, name}); current = [{...target, startedAt: 'new-process-same-pid'}, unrelated]; },
  }), /changed since initial launcher/);
  assert.deepEqual(signals, [{pid: 101, name: 'SIGTERM'}]);
  await assertSingleton();

  // A mismatch appearing after admission is caught at the termination point.
  current = [target, unrelated]; signals = [];
  let enumerations = 0;
  await assert.rejects(cleanupManagedStoreSession(store, exact, {...cleanupOptions,
    processes: async () => (++enumerations === 1 ? current : [{...target, command: unrelated.command}, unrelated]),
  }), /ambiguous|ownership/);
  assert.deepEqual(signals, []);
  await assertSingleton();
  await assert.rejects(cleanupManagedStoreSession(store, {...exact, profileIdentity: '0'.repeat(64)}, cleanupOptions), /physical profile changed/);
  assert.deepEqual(signals, []);

  // A newly acquired foreign lease before escalation blocks the second signal.
  const foreignLease = {root, storeKey: 'DL', task: 'foreign-cleanup-owner', runId: 'foreign-run', ttlSec: 120};
  try {
    await assert.rejects(cleanupManagedStoreSession(store, exact, {...cleanupOptions,
      signal: async (pid, name) => { signals.push({pid, name}); acquireBrowserTaskLease(foreignLease); },
    }), {code: 'PROFILE_LEASE_ACTIVE'});
    assert.deepEqual(signals, [{pid: 101, name: 'SIGTERM'}]);
    await assertSingleton();
  } finally { releaseBrowserTaskLease(foreignLease); }

  // A new process retaining this physical profile prevents Singleton cleanup.
  current = [target, unrelated]; signals = [];
  const stillInUse = await cleanupManagedStoreSession(store, exact, {...cleanupOptions,
    signal: async (pid, name) => { signals.push({pid, name}); current = [{...target, pid: 103}, unrelated]; },
  });
  assert.equal(stillInUse.reason, 'managed_profile_still_in_use');
  await assertSingleton();

  // Standalone launcher error path: ownership precedes page work, and the
  // actual exact cleanup implementation handles refresh failures/exceptions.
  for (const reused of [false, true]) {
    current = [target, unrelated]; signals = [];
    const events = [];
    let failure;
    try {
      await completeManagedLauncherStartup({
        start: async () => ({launched: !reused, reused, managedSession: exact}),
        inspect: async expected => {
          assert.deepEqual(expected, exact);
          return await readManagedChromeIdentity({store, profileDir, observed: current, expected});
        },
        emitOwnership: async receipt => { events.push('ownership'); assert.deepEqual(receipt.managedSession, exact); },
        ready: async () => { events.push('refresh'); throw new Error('fixture marketingRefresh failed'); },
        cleanup: session => cleanupManagedStoreSession(store, session, cleanupOptions),
      });
    } catch (error) { failure = error; }
    assert.equal(failure.message, 'fixture marketingRefresh failed');
    assert.deepEqual(events, ['ownership', 'refresh']);
    assert.deepEqual(failure.managedSession, exact);
    assert.equal(failure.cleanupReport.ok, !reused);
    assert.deepEqual(signals, reused ? [] : [{pid: 101, name: 'SIGTERM'}]);
    const failedLaunch = await launchStore('DL', {store, runCommand: async () => ({ok: false, launcherPid: 1111, stdout: JSON.stringify({
      storeKey: 'DL', port: 9321, url, reused, managedSession: exact, cleanup: failure.cleanupReport,
    }), stderr: ''}), inspectSession: async () => { throw new Error('failed readiness must not reconstruct identity'); }});
    assert.equal(failedLaunch.ok, false);
    assert.deepEqual(failedLaunch.managedSession, exact, 'readiness failure must retain ownership evidence');
    await closeStore('DL', failedLaunch, {runCommand: async (_node, args) => {
      const parsed = parseCleanupArgs(args.slice(1));
      assert.deepEqual(parsed.managedSession, exact);
      return cleanupManagedStoreSession(store, exact, cleanupOptions);
    }});
    assert.deepEqual(current, [unrelated]);
  }
  const interrupted = await launchStore('DL', {store, runCommand: async () => ({ok: false, stdout: '', stderr: JSON.stringify({
    event: 'managed-session-owned', storeKey: 'DL', port: 9321, url, managedSession: exact,
  })})});
  assert.deepEqual(interrupted.managedSession, exact, 'interrupted page work retains early stderr ownership receipt');
  assert.equal(interrupted.ok, false);

  // Real startup lock interleaving: B queues while A still holds the lock.
  // A captures 101, releases the lock, 101 exits, B launches 102, then A's
  // post-start inspection must reject 102 instead of adopting/cleaning it.
  current = []; signals = [];
  const trace = [];
  const replacement = {...target, pid: 102, startedAt: 'replacement-start'};
  let allowB;
  const aExited = new Promise(resolve => { allowB = resolve; });
  let bStart;
  let aEnumerations = 0;
  const commonStartup = {
    root, profileDir, storeKey: store.storeKey, port: store.port, env,
    captureManagedSession: true,
    probe: async () => current.some(row => row.pid === 101 || row === replacement),
    prepare: async () => {}, reuse: async () => {},
  };
  const cleanupRequests = [];
  let originalFailure;
  try {
    await completeManagedLauncherStartup({
      start: async () => {
        const first = await withChromeProfileStartup({...commonStartup,
          processes: async () => {
            if (++aEnumerations === 2) trace.push('A:capture101-under-lock');
            return current;
          },
          launch: async () => { trace.push('A:launch101'); current = [target]; },
          waitReady: async () => {
            bStart = withChromeProfileStartup({...commonStartup,
              processes: async () => { trace.push('B:enumerate-under-lock'); await aExited; return current; },
              launch: async () => { trace.push('B:launch102'); current = [replacement]; },
              waitReady: async () => {},
            });
          },
        });
        assert.equal(first.managedSession.browserPid, 101);
        current = [];
        trace.push('A:exit101-after-unlock');
        allowB();
        const second = await bStart;
        assert.equal(second.managedSession.browserPid, 102);
        return first;
      },
      inspect: async expected => {
        trace.push(`A:inspect-expected${expected.browserPid}`);
        assert.deepEqual(expected, exact);
        return await inspectManagedStoreSession(store, expected, {root, env, processes: async () => current, probe: async () => true});
      },
      emitOwnership: async ({managedSession}) => { assert.deepEqual(managedSession, exact); },
      ready: async () => { throw new Error('page work must not run after identity replacement'); },
      cleanup: async expected => {
        cleanupRequests.push(expected.browserPid);
        return await cleanupManagedStoreSession(store, expected, cleanupOptions);
      },
    });
  } catch (error) { originalFailure = error; }
  assert.match(originalFailure.message, /changed since initial launcher/);
  assert.deepEqual(originalFailure.managedSession, exact, 'failed readback retains A101; never substitutes B102');
  assert.deepEqual(cleanupRequests, [101]);
  assert.deepEqual(signals, [], 'A must never terminate B102');
  assert.deepEqual(current, [replacement]);
  assert.ok(trace.indexOf('A:capture101-under-lock') < trace.indexOf('B:enumerate-under-lock'));
  assert.ok(trace.indexOf('B:launch102') < trace.indexOf('A:inspect-expected101'));
  console.log(`PASS: startup ownership interleaving ${JSON.stringify({trace, cleanupRequests, signals, retainedPid: current[0].pid})}`);

  // Same-lock receipt also covers legitimate reuse; old callers opt out and
  // retain their exact two-field return protocol without another enumeration.
  const reusedReceipt = await withChromeProfileStartup({...commonStartup,
    processes: async () => current, launch: forbidLauncher, waitReady: async () => {},
  });
  assert.equal(reusedReceipt.reused, true);
  assert.equal(reusedReceipt.managedSession.browserPid, 102);
  let legacyEnumerations = 0;
  const legacyReceipt = await withChromeProfileStartup({...commonStartup, captureManagedSession: false,
    processes: async () => { legacyEnumerations++; return current; }, launch: forbidLauncher, waitReady: async () => {},
  });
  assert.deepEqual(legacyReceipt, {launched: false, reused: true});
  assert.equal(legacyEnumerations, 1);

  assert.deepEqual(await fs.readFile(path.join(profileDir, 'Local State')), localState);
  console.log('PASS: marketing startup evidence, real profile/port/PID/lease admission, original session attachment, identity and report failures, safe cleanup, no resubmission');
} finally {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('manual-session-recovery-'));
  // Detach the fixture junction before removing the exclusive temp tree.
  await fs.unlink(path.join(root, 'profile alias')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await fs.rm(root, {recursive: true, force: true});
}
