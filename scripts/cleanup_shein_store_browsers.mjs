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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    all: false,
    stores: [],
    onlyHeadless: false,
    cleanupChromeTmp: false,
    dryRun: false,
    json: false,
    killAfterSec: 5,
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
  }
  return args;
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
  return path.join(ROOT, 'profiles', `persistent-${store.profileKey}-profile`);
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
  const liveCount = liveChromeProcessCount();
  const tmpRoot = '/tmp';
  const isChromeTmp = name => /^\.?com\.google\.Chrome\.[A-Za-z0-9_-]+$/.test(name);
  const before = fs.readdirSync(tmpRoot)
    .filter(isChromeTmp)
    .map(name => path.join(tmpRoot, name))
    .filter(p => {
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    })
    .sort();
  if (liveCount > 0) {
    return {enabled: true, skipped: 'live-chrome-processes', liveCount, beforeCount: before.length, afterCount: before.length, removed: []};
  }
  const removed = [];
  for (const dir of before) {
    if (args.dryRun) {
      removed.push({path: dir, dryRun: true});
      continue;
    }
    try {
      fs.rmSync(dir, {recursive: true, force: true});
      removed.push({path: dir});
    } catch (err) {
      removed.push({path: dir, error: err?.code || String(err?.message || err)});
    }
  }
  const after = fs.readdirSync(tmpRoot)
    .filter(isChromeTmp)
    .map(name => path.join(tmpRoot, name))
    .filter(p => {
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    });
  return {enabled: true, liveCount, beforeCount: before.length, afterCount: after.length, removed};
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

const args = parseArgs(process.argv.slice(2));
const stores = selectedStores(args);
let report;
if (process.platform === 'win32') {
  report = {ok: true, platform: process.platform, stores: stores.map(s => s.storeKey), ...cleanupWindows(stores, args), chromeTmp: cleanupChromeTmpDirs(args)};
} else {
  const before = linuxMatches(stores, args);
  const killed = cleanupLinux(before, args);
  const after = args.dryRun ? before : linuxMatches(stores, args);
  const chromeTmp = cleanupChromeTmpDirs(args);
  report = {
    ok: (after.length === 0 || args.dryRun) && (!chromeTmp.enabled || chromeTmp.afterCount === 0 || chromeTmp.skipped === 'live-chrome-processes' || args.dryRun),
    platform: process.platform,
    stores: stores.map(s => s.storeKey),
    onlyHeadless: args.onlyHeadless,
    dryRun: args.dryRun,
    beforeCount: before.length,
    afterCount: after.length,
    before: before.map(p => ({pid: p.pid, ppid: p.ppid, rssKb: p.rssKb, storeKey: p.storeKey, cmdline: p.cmdline.slice(0, 500)})),
    after: after.map(p => ({pid: p.pid, ppid: p.ppid, rssKb: p.rssKb, storeKey: p.storeKey, cmdline: p.cmdline.slice(0, 500)})),
    killed,
    chromeTmp,
  };
}

if (args.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`[cleanup_shein_store_browsers] stores=${report.stores.join(',')} before=${report.beforeCount ?? 0} after=${report.afterCount ?? 0} dryRun=${Boolean(args.dryRun)}`);
  for (const item of report.before || []) console.log(`- ${item.storeKey} pid=${item.pid} ppid=${item.ppid} rssKb=${item.rssKb}`);
  if (report.chromeTmp?.enabled) {
    const suffix = report.chromeTmp.skipped ? ` skipped=${report.chromeTmp.skipped}` : '';
    console.log(`[cleanup_shein_store_browsers] chromeTmp before=${report.chromeTmp.beforeCount ?? 0} after=${report.chromeTmp.afterCount ?? 0}${suffix}`);
  }
}
if (!report.ok) process.exitCode = 1;
