#!/usr/bin/env node
/**
 * Cleanup SHEIN store Chrome profiles used by cloud/manual automation.
 *
 * Targets only Chrome/Chromium processes whose command line contains this
 * project's `profiles/persistent-*-profile` directories.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {readBrowserLeases, reclaimStaleBrowserLeases} from '../lib/browser_task_lease.mjs';
import {cleanupOwnedChromeTmpDirectories} from '../lib/chrome_tmp_hygiene.mjs';
import {
  assertChromeProfileLeaseOwner, chromeProfileIdentity, chromeProcessOwnsProfile,
  listChromeProcesses, readManagedChromeIdentity, validateManagedSession, withChromeProfileLock,
} from '../lib/chrome_profile_startup.mjs';
import {resolvePersistentStoreProfile, resolveSheinPrimaryWorkspace} from '../lib/shein_workspace_paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv) {
  const args = {
    all: false,
    stores: [],
    onlyHeadless: false,
    cleanupChromeTmp: false,
    dryRun: false,
    json: false,
    killAfterSec: 5,
    ownedLeaseTask: '',
    ownedLeaseRunId: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--store') args.stores.push(String(argv[++i] || '').trim().toUpperCase());
    else if (a === '--stores') args.stores.push(...String(argv[++i] || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean));
    else if (a === '--only-headless') args.onlyHeadless = true;
    else if (a === '--cleanup-chrome-tmp') args.cleanupChromeTmp = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--kill-after-sec') args.killAfterSec = Number(argv[++i] || args.killAfterSec);
    else if (a === '--owned-lease-task') args.ownedLeaseTask = String(argv[++i] || '').trim();
    else if (a === '--owned-lease-run-id') args.ownedLeaseRunId = String(argv[++i] || '').trim();
    else if (a === '--managed-session-json') args.managedSession = JSON.parse(argv[++i] || 'null');
  }
  if (args.managedSession !== undefined) {
    if (args.all || args.stores.length !== 1) throw new Error('Exact managed cleanup requires one --store');
    validateManagedSession(args.managedSession, args.stores[0]);
  }
  return args;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// Exact opt-in path. Do not route this through legacy store/sub-string cleanup.
// The physical profile lock spans terminal revalidation, signals, exit readback
// and Singleton cleanup. All signals target only the original browser PID.
export async function cleanupManagedStoreSession(store, session, {
  root = ROOT, env = process.env, processes = listChromeProcesses,
  alive = pidAlive, signal = (pid, name) => process.kill(pid, name),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  killAfterSec = 5, exitTimeoutMs = 5000, dryRun = false,
} = {}) {
  validateManagedSession(session, store.storeKey);
  if (Number(store.port) !== session.port) throw new Error('Managed cleanup configured port mismatch');
  const workspaceOptions = path.resolve(root) === ROOT ? {} : {primaryWorkspace: root};
  const profileWorkspace = resolveSheinPrimaryWorkspace({env, ...workspaceOptions});
  const dir = resolvePersistentStoreProfile(store, {requireExistingRoot: true, primaryWorkspace: profileWorkspace});
  const killed = [];
  return await withChromeProfileLock({root: profileWorkspace, profileDir: dir, storeKey: store.storeKey, env}, async () => {
    const assertProfile = async () => {
      assertChromeProfileLeaseOwner({root: profileWorkspace, storeKey: store.storeKey, env});
      if (await chromeProfileIdentity(dir) !== session.profileIdentity) throw new Error('Managed cleanup physical profile changed');
    };
    const targetPresent = async () => {
      await assertProfile();
      const observed = await processes();
      if (!observed.some(row => row.pid === session.browserPid)) {
        if (await alive(session.browserPid)) throw new Error('Managed cleanup PID is alive without matching Chrome identity');
        return false;
      }
      await readManagedChromeIdentity({store, profileDir: dir, observed, expected: session});
      await assertProfile();
      return true;
    };
    const waitForExit = async timeoutMs => {
      const deadline = performance.now() + Math.max(0, timeoutMs);
      while (await alive(session.browserPid)) {
        if (performance.now() >= deadline) return false;
        await sleep(Math.min(100, Math.max(1, deadline - performance.now())));
      }
      return true;
    };
    if (await targetPresent()) {
      if (dryRun) return {ok: true, dryRun: true, stores: [store.storeKey], targetPid: session.browserPid, killed: [], profileSingletons: {removed: []}};
      // Repeat at the termination boundary; never trust an earlier admission.
      if (await targetPresent()) {
        await signal(session.browserPid, 'SIGTERM');
        killed.push({pid: session.browserPid, signal: 'SIGTERM'});
      }
      if (!await waitForExit(Math.max(0, Number(killAfterSec) || 0) * 1000)) {
        if (await targetPresent()) {
          await signal(session.browserPid, 'SIGKILL');
          killed.push({pid: session.browserPid, signal: 'SIGKILL'});
        }
        if (!await waitForExit(exitTimeoutMs)) return {ok: false, stores: [store.storeKey], reason: 'managed_target_exit_unconfirmed', killed, profileSingletons: {removed: []}};
      }
    }
    if (dryRun) return {ok: true, dryRun: true, stores: [store.storeKey], killed: [], profileSingletons: {removed: []}};
    await assertProfile();
    const remaining = await processes();
    if (await alive(session.browserPid)) throw new Error('Managed cleanup target exit unconfirmed');
    for (const row of remaining) {
      if (await chromeProcessOwnsProfile(row, dir)) {
        return {ok: false, stores: [store.storeKey], reason: 'managed_profile_still_in_use', killed, profileSingletons: {removed: []}};
      }
    }
    await assertProfile();
    const removed = [];
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const file = path.join(dir, name);
      if (path.dirname(file) !== dir) throw new Error('Unsafe managed Singleton path');
      try {
        if (fs.lstatSync(file).isDirectory()) throw new Error('Managed Singleton is unexpectedly a directory');
        fs.rmSync(file);
        removed.push({storeKey: store.storeKey, name});
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return {ok: true, stores: [store.storeKey], exited: true, killed, profileSingletons: {removed, errorCount: 0}};
  });
}

function storesConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
}

function selectedStores(args) {
  const enabled = (storesConfig().stores || []).filter(s => s.enabled !== false);
  if (args.all || !args.stores.length) return enabled;
  return args.stores.map(key => {
    const store = enabled.find(s => String(s.storeKey).toUpperCase() === key);
    if (!store) throw new Error(`Unknown or disabled store: ${key}`);
    return store;
  });
}

function profileDir(store) {
  return resolvePersistentStoreProfile(store, {requireExistingRoot: true});
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function cmdline(pid) {
  return readText(`/proc/${pid}/cmdline`).replace(/\0/g, ' ').trim();
}

function status(pid) {
  const raw = readText(`/proc/${pid}/status`);
  return {
    ppid: Number(raw.match(/^PPid:\s+(\d+)/m)?.[1] || 0),
    rssKb: Number(raw.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0),
  };
}

function linuxMatches(stores, args) {
  const targets = stores.map(store => ({storeKey: store.storeKey, profileDir: profileDir(store)}));
  return fs.readdirSync('/proc')
    .filter(x => /^\d+$/.test(x))
    .map(Number)
    .flatMap(pid => {
      const cmd = cmdline(pid);
      if (!cmd || !/chrome|chromium/i.test(cmd)) return [];
      if (args.onlyHeadless && !cmd.includes('--headless')) return [];
      const target = targets.find(t => cmd.includes(`--user-data-dir=${t.profileDir}`) || cmd.includes(t.profileDir));
      if (!target) return [];
      const s = status(pid);
      return [{pid, ppid: s.ppid, rssKb: s.rssKb, storeKey: target.storeKey, profileDir: target.profileDir, cmdline: cmd}];
    })
    .sort((a, b) => a.pid - b.pid);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cleanupLinux(matches, args) {
  const killed = [];
  const pids = [...new Set(matches.map(p => p.pid))];
  for (const pid of pids) {
    if (args.dryRun) {
      killed.push({pid, signal: 'DRY_RUN'});
      continue;
    }
    try { process.kill(pid, 'SIGTERM'); killed.push({pid, signal: 'SIGTERM'}); }
    catch (err) { killed.push({pid, signal: 'SIGTERM', error: err?.code || String(err?.message || err)}); }
  }
  if (!args.dryRun && pids.length && args.killAfterSec > 0) {
    sleepSync(Math.max(0, args.killAfterSec) * 1000);
    for (const pid of pids) {
      if (!fs.existsSync(`/proc/${pid}`)) continue;
      try { process.kill(pid, 'SIGKILL'); killed.push({pid, signal: 'SIGKILL'}); }
      catch (err) { killed.push({pid, signal: 'SIGKILL', error: err?.code || String(err?.message || err)}); }
    }
  }
  return killed;
}

function liveChromeProcessCount() {
  return fs.readdirSync('/proc')
    .filter(x => /^\d+$/.test(x))
    .map(pid => readText(`/proc/${pid}/comm`).trim())
    .filter(name => /^(chrome|chromium|chromium-browser|google-chrome|google-chrome-stable)$/i.test(name))
    .length;
}

function cleanupChromeTmpDirs(args) {
  if (process.platform === 'win32' || !args.cleanupChromeTmp) {
    return {enabled: Boolean(args.cleanupChromeTmp), skipped: process.platform === 'win32' ? 'unsupported-platform' : 'disabled', beforeCount: 0, afterCount: 0, removed: []};
  }
  return cleanupOwnedChromeTmpDirectories({
    enabled: true,
    dryRun: args.dryRun,
    liveCount: liveChromeProcessCount(),
    tmpRoot: '/tmp',
    ownerUid: typeof process.getuid === 'function' ? process.getuid() : null,
  });
}

function cleanupProfileSingletons(stores, args, remainingMatches = [], protectedStoreKeys = new Set()) {
  const liveStoreKeys = new Set(remainingMatches.map(item => String(item.storeKey || '').toUpperCase()));
  const names = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  const removed = [];
  for (const store of stores) {
    if (liveStoreKeys.has(String(store.storeKey).toUpperCase()) || protectedStoreKeys.has(String(store.storeKey).toUpperCase())) continue;
    const dir = profileDir(store);
    for (const name of names) {
      const file = path.join(dir, name);
      try { fs.lstatSync(file); } catch { continue; }
      if (args.dryRun) {
        removed.push({storeKey: store.storeKey, path: file, dryRun: true});
        continue;
      }
      try {
        fs.rmSync(file, {force: true});
        removed.push({storeKey: store.storeKey, path: file});
      } catch (err) {
        removed.push({storeKey: store.storeKey, path: file, error: err?.code || String(err?.message || err)});
      }
    }
  }
  return {
    removed,
    errorCount: removed.filter(item => item.error).length,
  };
}

function cleanupWindows(stores, args) {
  if (args.dryRun) return {matches: [], killed: [], note: `dry-run stores=${stores.map(s => s.storeKey).join(',')}`};
  const res = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(ROOT, 'scripts', 'close_store_browsers.ps1'),
    '-Stores',
    stores.map(s => s.storeKey).join(','),
  ], {cwd: ROOT, encoding: 'utf8', timeout: 30_000});
  return {matches: [], killed: [], code: res.status, stdout: res.stdout, stderr: res.stderr};
}

async function main(argv = process.argv.slice(2)) {
const args = parseArgs(argv);
const stores = selectedStores(args);
if (args.managedSession) {
  const env = {...process.env};
  if (args.ownedLeaseTask || args.ownedLeaseRunId) {
    env.SHEIN_BI_BROWSER_LEASE_TASK = args.ownedLeaseTask;
    env.SHEIN_BI_BROWSER_LEASE_RUN_ID = args.ownedLeaseRunId;
  }
  const report = await cleanupManagedStoreSession(stores[0], args.managedSession, {env, killAfterSec: args.killAfterSec, dryRun: args.dryRun});
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
  return;
}
const reclaimedLeases = reclaimStaleBrowserLeases({root: ROOT});
const activeLeases = readBrowserLeases({root: ROOT}).filter(item => item.valid);
const isOwnedLease = item => Boolean(
  args.ownedLeaseTask
  && args.ownedLeaseRunId
  && item.lease.task === args.ownedLeaseTask
  && item.lease.runId === args.ownedLeaseRunId
);
const protectingLeases = activeLeases.filter(item => !isOwnedLease(item));
const protectedStoreKeys = new Set(protectingLeases.map(item => String(item.lease.storeKey).toUpperCase()));
const protectedPids = new Set(protectingLeases.map(item => Number(item.lease.owner?.pid || 0)).filter(pid => pid > 0));
const protectedStoreLeases = activeLeases.map(item => ({
  task: item.lease.task,
  storeKey: item.lease.storeKey,
  runId: item.lease.runId,
  ownerPid: item.lease.owner?.pid || null,
    expiresAt: item.lease.expiresAt,
    ownedByCleanupCaller: isOwnedLease(item),
}));
let report;
if (process.platform === 'win32') {
  const orphanStores = stores.filter(store => !protectedStoreKeys.has(String(store.storeKey).toUpperCase()));
  const browserCleanup = cleanupWindows(orphanStores, args);
  const closeSucceeded = args.dryRun || browserCleanup.code === 0;
  const singletonProtected = closeSucceeded
    ? protectedStoreKeys
    : new Set(stores.map(store => String(store.storeKey).toUpperCase()));
  const profileSingletons = cleanupProfileSingletons(stores, args, [], singletonProtected);
  report = {
    ok: closeSucceeded && profileSingletons.errorCount === 0,
    platform: process.platform,
    stores: stores.map(s => s.storeKey),
    protectedStoreLeases,
    reclaimedLeases,
    ...browserCleanup,
    profileSingletons,
    chromeTmp: cleanupChromeTmpDirs(args),
  };
} else {
  const before = linuxMatches(stores, args);
  const protectedMatches = before.filter(item => protectedStoreKeys.has(String(item.storeKey).toUpperCase()) || protectedPids.has(item.pid));
  const orphanBefore = before.filter(item => !protectedMatches.includes(item));
  const killed = cleanupLinux(orphanBefore, args);
  const after = args.dryRun ? before : linuxMatches(stores, args);
  const orphanAfter = after.filter(item => !protectedStoreKeys.has(String(item.storeKey).toUpperCase()) && !protectedPids.has(item.pid));
  const profileSingletons = cleanupProfileSingletons(stores, args, after, protectedStoreKeys);
  const chromeTmp = cleanupChromeTmpDirs(args);
  report = {
    ok: (orphanAfter.length === 0 || args.dryRun)
      && profileSingletons.errorCount === 0
      && (!chromeTmp.enabled || chromeTmp.afterCount === 0 || chromeTmp.skipped === 'live-chrome-processes' || args.dryRun),
    platform: process.platform,
    stores: stores.map(s => s.storeKey),
    protectedStoreLeases,
    reclaimedLeases,
    onlyHeadless: args.onlyHeadless,
    dryRun: args.dryRun,
    beforeCount: before.length,
    afterCount: after.length,
    orphanBeforeCount: orphanBefore.length,
    orphanAfterCount: orphanAfter.length,
    before: before.map(p => ({pid: p.pid, ppid: p.ppid, rssKb: p.rssKb, storeKey: p.storeKey, cmdline: p.cmdline.slice(0, 500)})),
    after: after.map(p => ({pid: p.pid, ppid: p.ppid, rssKb: p.rssKb, storeKey: p.storeKey, cmdline: p.cmdline.slice(0, 500)})),
    protected: protectedMatches.map(p => ({pid: p.pid, storeKey: p.storeKey, reason: protectedStoreKeys.has(String(p.storeKey).toUpperCase()) ? 'active_store_lease' : 'active_owner_lease'})),
    killed,
    profileSingletons,
    chromeTmp,
  };
}

if (args.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`[cleanup_shein_store_browsers] stores=${report.stores.join(',')} before=${report.beforeCount ?? 0} orphanBefore=${report.orphanBeforeCount ?? 0} orphanAfter=${report.orphanAfterCount ?? report.afterCount ?? 0} protectedLeases=${report.protectedStoreLeases?.length ?? 0} dryRun=${Boolean(args.dryRun)}`);
  for (const item of report.before || []) console.log(`- ${item.storeKey} pid=${item.pid} ppid=${item.ppid} rssKb=${item.rssKb}`);
  if (report.chromeTmp?.enabled) {
    const suffix = report.chromeTmp.skipped ? ` skipped=${report.chromeTmp.skipped}` : '';
    console.log(`[cleanup_shein_store_browsers] chromeTmp ownedBefore=${report.chromeTmp.beforeCount ?? 0} ownedAfter=${report.chromeTmp.afterCount ?? 0} foreignIgnored=${report.chromeTmp.foreignCount ?? 0} unsafeIgnored=${report.chromeTmp.unsafeCount ?? 0}${suffix}`);
  }
  if (report.profileSingletons?.removed?.length) {
    console.log(`[cleanup_shein_store_browsers] profileSingletons removed=${report.profileSingletons.removed.length} errors=${report.profileSingletons.errorCount}`);
  }
}
if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(String(error?.message || error)); process.exitCode = 1; });
}
