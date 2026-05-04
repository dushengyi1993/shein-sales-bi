#!/usr/bin/env node
/**
 * Scheduled/one-shot entry for SHEIN link-management sync.
 *
 * Steps:
 * 1) ensure selected store browsers are running
 * 2) fetch link-management data locally
 * 3) generate local link/BI data artifacts.  Lark Base link-management sync is
 *    deprecated and disabled by default.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const JOB_LOG_DIR = path.join(ROOT, 'logs', 'jobs');
const storesConfig = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));

function pad2(n) { return String(n).padStart(2, '0'); }
function bjDate(offsetDays = 0) {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600_000);
  bj.setDate(bj.getDate() + offsetDays);
  return `${bj.getFullYear()}-${pad2(bj.getMonth() + 1)}-${pad2(bj.getDate())}`;
}
function parseArgs(argv) {
  const args = {
    date: bjDate(-1),
    group: 'ALL',
    stores: null,
    launchMissing: true,
    browserMode: 'headless',
    autoRelogin: true,
    reloginVisible: true,
    allowPartial: false,
    syncLark: false,
    setupDashboard: false,
    skipLinkMainUpdates: true,
    generateWebDashboard: true,
    larkSyncTimeoutMs: 2_700_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--group') args.group = argv[++i].toUpperCase();
    else if (a === '--stores') args.stores = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--store') args.stores = [argv[++i].trim().toUpperCase()];
    else if (a === '--no-launch') args.launchMissing = false;
    else if (a === '--visible-browser' || a === '--foreground-browser') args.browserMode = 'visible';
    else if (a === '--background-browser') args.browserMode = 'background';
    else if (a === '--headless-browser') args.browserMode = 'headless';
    else if (a === '--no-auto-relogin') args.autoRelogin = false;
    else if (a === '--relogin-headless') { args.autoRelogin = true; args.reloginVisible = false; }
    else if (a === '--relogin-visible') { args.autoRelogin = true; args.reloginVisible = true; }
    else if (a === '--allow-partial') args.allowPartial = true;
    else if (a === '--no-lark') args.syncLark = false;
    else if (a === '--lark') args.syncLark = true;
    else if (a === '--dashboard') args.setupDashboard = true;
    else if (a === '--no-dashboard') args.setupDashboard = false;
    else if (a === '--no-web-dashboard') args.generateWebDashboard = false;
    else if (a === '--update-link-main') args.skipLinkMainUpdates = false;
    else if (a === '--lark-sync-timeout-ms') args.larkSyncTimeoutMs = Math.max(60_000, Number(argv[++i] || 0));
  }
  return args;
}
function selectedStores(args) {
  const enabled = storesConfig.stores.filter(s => s.enabled !== false);
  if (args.stores?.length) {
    return args.stores.map(key => {
      const store = enabled.find(s => s.storeKey.toUpperCase() === key);
      if (!store) throw new Error(`Unknown or disabled store: ${key}`);
      return store;
    });
  }
  const keys = args.group === 'ALL' ? enabled.map(s => s.storeKey) : storesConfig.groups?.[args.group];
  if (!Array.isArray(keys)) throw new Error(`Unknown store group: ${args.group}`);
  return keys.map(key => {
    const store = enabled.find(s => s.storeKey === key);
    if (!store) throw new Error(`Configured group store is missing/disabled: ${key}`);
    return store;
  });
}
function runNode(script, args, timeoutMs = 600_000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ok: false, code: null, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim()});
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; process.stdout.write(d); });
    child.stderr.on('data', d => { stderr += d; process.stderr.write(d); });
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ok: false, code: null, stdout, stderr: String(err?.stack || err)});
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ok: code === 0, code, stdout, stderr});
    });
  });
}
function parseJsonFromOutput(text) {
  const s = String(text || '').trim();
  const starts = [s.indexOf('{'), s.indexOf('[')].filter(i => i >= 0);
  if (!starts.length) return null;
  try { return JSON.parse(s.slice(Math.min(...starts))); } catch { return null; }
}
async function isCdpOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(1500)});
    return res.ok;
  } catch {
    return false;
  }
}
async function ensureBrowser(store, args) {
  if (await isCdpOpen(store.port)) return {opened: true, launched: false};
  if (!args.launchMissing) return {opened: false, launched: false, error: `Chrome CDP port ${store.port} is not open`};
  const launchArgs = [store.storeKey];
  if (args.browserMode === 'headless') launchArgs.push('--headless');
  else if (args.browserMode === 'background') launchArgs.push('--background');
  else launchArgs.push('--visible');
  const launch = await runNode('launch_store_browser.mjs', launchArgs, 60_000);
  if (!launch.ok) return {opened: false, launched: false, error: launch.stderr || launch.stdout};
  for (let i = 0; i < 18; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await isCdpOpen(store.port)) return {opened: true, launched: true, mode: args.browserMode};
  }
  return {opened: false, launched: true, mode: args.browserMode, error: `launched but CDP port ${store.port} did not open in time`};
}
function isLoginError(text) {
  return /20302|登录重定向|login|账号登录|重新登录|未捕获到商品分析接口 x-gw-auth/i.test(String(text || ''));
}
async function relogin(store, date, args) {
  if (!args.autoRelogin) return {attempted: false, ok: false, skipped: true};
  const reloginArgs = [store.storeKey, '--date', date, args.reloginVisible ? '--visible' : '--headless'];
  const result = await runNode('auto_relogin_shein_store.mjs', reloginArgs, 240_000);
  const parsed = parseJsonFromOutput(result.stdout);
  return {attempted: true, ok: result.ok && parsed?.ok !== false, code: result.code, parsed, stderrTail: result.stderr.slice(-1000)};
}
async function fetchStore(store, args) {
  const browser = await ensureBrowser(store, args);
  if (!browser.opened) return {storeKey: store.storeKey, ok: false, stage: 'browser', browser};
  const fetchArgs = ['--stores', store.storeKey, '--date', args.date, '--page-size', '50'];
  let fetch = await runNode('fetch_shein_links.mjs', fetchArgs, 420_000);
  if (!fetch.ok && isLoginError(`${fetch.stdout}\n${fetch.stderr}`)) {
    const reloginResult = await relogin(store, args.date, args);
    if (reloginResult.ok) fetch = await runNode('fetch_shein_links.mjs', fetchArgs, 420_000);
    return {storeKey: store.storeKey, ok: fetch.ok, stage: 'fetch', browser, relogin: reloginResult, code: fetch.code, stdoutTail: fetch.stdout.slice(-1500), stderrTail: fetch.stderr.slice(-1500)};
  }
  return {storeKey: store.storeKey, ok: fetch.ok, stage: 'fetch', browser, code: fetch.code, stdoutTail: fetch.stdout.slice(-1500), stderrTail: fetch.stderr.slice(-1500)};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(JOB_LOG_DIR, {recursive: true});
  const stores = selectedStores(args);
  const startedAt = new Date().toISOString();
  const results = [];
  for (const store of stores) {
    console.log(`\n=== link fetch ${store.storeKey} ${args.date} ===`);
    results.push(await fetchStore(store, args));
  }
  const failed = results.filter(r => !r.ok);
  let sync = null;
  let webDashboard = null;
  if (!failed.length || args.allowPartial) {
    const okStores = results.filter(r => r.ok).map(r => r.storeKey).join(',');
    if (args.syncLark) {
      const syncArgs = ['--date', args.date, '--stores', okStores];
      if (!args.setupDashboard) syncArgs.push('--no-dashboard');
      if (args.skipLinkMainUpdates) syncArgs.push('--skip-link-main-updates');
      console.log(`\n=== sync link data to deprecated Lark link tables (${okStores}) ===`);
      sync = await runNode('sync_shein_links_to_lark.mjs', syncArgs, args.larkSyncTimeoutMs);
    } else {
      console.log('\n=== skip deprecated Lark link-management sync; BI/local data only ===');
    }
    if (args.generateWebDashboard) {
      console.log(`\n=== generate link web dashboard (${okStores}) ===`);
      webDashboard = await runNode('generate_link_ops_web_dashboard.mjs', ['--date', args.date, '--stores', okStores], 120_000);
    }
  } else {
    console.error(`Skip Lark sync because ${failed.length}/${stores.length} store(s) failed.`);
  }
  const summary = {
    ok: failed.length === 0 && (!sync || sync.ok) && (!webDashboard || webDashboard.ok),
    date: args.date,
    group: args.group,
    stores: results,
    sync: sync ? {ok: sync.ok, code: sync.code, stdoutTail: sync.stdout.slice(-2000), stderrTail: sync.stderr.slice(-2000)} : null,
    webDashboard: webDashboard ? {ok: webDashboard.ok, code: webDashboard.code, stdoutTail: webDashboard.stdout.slice(-2000), stderrTail: webDashboard.stderr.slice(-2000)} : null,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  const summaryFile = path.join(JOB_LOG_DIR, `link-management-${args.date}-${Date.now()}.json`);
  await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify({...summary, summaryFile}, null, 2));
  if (!summary.ok) process.exit(1);
}

await main();
