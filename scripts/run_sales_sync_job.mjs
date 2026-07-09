#!/usr/bin/env node
/**
 * One-shot scheduled job entry for SHEIN store sales sync.
 *
 * It performs:
 *   1) ensure each selected store's workspace Chrome profile is open
 *   2) fetch the target Beijing business day
 *   3) sync daily fact/log records into Lark Base unless Feishu Base sync is paused
 *   4) refresh product daily fact and product daily wide display table
 *   5) refresh compact archive / product weekly-monthly wide tables
 *   6) refresh the corresponding monthly daily-sales display table
 *   7) refresh native Dashboard source tables
 *
 * Examples:
 *   node scripts/run_sales_sync_job.mjs --mode intraday --group DSY
 *   node scripts/run_sales_sync_job.mjs --mode yesterday-final --group DSY
 *   node scripts/run_sales_sync_job.mjs --date 2026-04-26 --status ???? --stores DL,DX
 *   node scripts/run_sales_sync_job.mjs --mode intraday --group DSY --visible-browser
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const JOB_LOG_DIR = path.join(ROOT, 'logs', 'jobs');
const CHECKPOINT_PATH = path.join(ROOT, 'state', 'shein_sync_checkpoint.json');
const FEISHU_BASE_PAUSE_FLAG = path.join(ROOT, 'state', 'feishu-base-sync-paused.flag');

const storesConfig = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));

function envTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = {
    mode: 'intraday',
    group: 'DSY',
    launchMissing: true,
    browserMode: 'headless',
    refreshMonthly: true,
    dsyOnlyMonthly: true,
    refreshProducts: true,
    refreshCompactDisplay: true,
    refreshDashboard: false,
    dashboardName: null,
    refreshAllDashboard: false,
    allDashboardName: 'SHEIN经营看板 v3-主看板',
    autoRelogin: true,
    reloginVisible: true,
    storeAttempts: 3,
    skipLarkBase: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') args.mode = argv[++i];
    else if (a === '--group') args.group = argv[++i].toUpperCase();
    else if (a === '--stores') args.stores = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--status') args.status = argv[++i];
    else if (a === '--no-launch') args.launchMissing = false;
    else if (a === '--visible-browser' || a === '--foreground-browser') args.browserMode = 'visible';
    else if (a === '--background-browser' || a === '--no-headless-browser') args.browserMode = 'background';
    else if (a === '--headless-browser') args.browserMode = 'headless';
    else if (a === '--no-monthly') args.refreshMonthly = false;
    else if (a === '--no-products') {
      args.refreshProducts = false;
      args.refreshCompactDisplay = false;
    }
    else if (a === '--no-compact-display' || a === '--no-compact') args.refreshCompactDisplay = false;
    else if (a === '--no-dashboard') args.refreshDashboard = false;
    else if (a === '--no-lark-base' || a === '--skip-lark-base') args.skipLarkBase = true;
    else if (a === '--dashboard-name') args.dashboardName = argv[++i];
    else if (a === '--refresh-all-dashboard') args.refreshAllDashboard = true;
    else if (a === '--all-dashboard-name') args.allDashboardName = argv[++i];
    else if (a === '--include-lgm-monthly') args.dsyOnlyMonthly = false;
    else if (a === '--no-auto-relogin') args.autoRelogin = false;
    else if (a === '--store-attempts') args.storeAttempts = Math.max(1, Number(argv[++i] || 1));
    else if (a === '--relogin-headless') {
      args.autoRelogin = true;
      args.reloginVisible = false;
    }
    else if (a === '--relogin-visible') {
      args.autoRelogin = true;
      args.reloginVisible = true;
    }
  }
  return args;
}

function bjDate(offsetDays = 0) {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const bj = new Date(utc + 8 * 3600_000);
  bj.setDate(bj.getDate() + offsetDays);
  const y = bj.getFullYear();
  const m = String(bj.getMonth() + 1).padStart(2, '0');
  const d = String(bj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function resolveJobDateAndStatus(args) {
  if (args.date) {
    return {date: args.date, status: args.status || '\u5386\u53f2\u56de\u8865'};
  }
  if (args.mode === 'intraday') {
    return {date: bjDate(0), status: args.status || '\u5f53\u5929\u540c\u6b65'};
  }
  if (args.mode === 'yesterday-final') {
    return {date: bjDate(-1), status: args.status || '\u524d\u65e5\u6700\u7ec8\u7248'};
  }
  throw new Error(`Unknown --mode: ${args.mode}`);
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
  const keys = args.group === 'ALL'
    ? storesConfig.stores.filter(s => s.enabled !== false).map(s => s.storeKey)
    : storesConfig.groups?.[args.group];
  if (!Array.isArray(keys)) throw new Error(`Unknown store group: ${args.group}`);
  return keys.map(key => {
    const store = enabled.find(s => s.storeKey === key);
    if (!store) throw new Error(`Configured group store is missing/disabled: ${key}`);
    return store;
  });
}

function runNode(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ok: code === 0, code, stdout, stderr}));
    child.on('error', err => resolve({ok: false, code: -1, stdout, stderr: String(err.stack || err)}));
  });
}

function runCommand(command, args, timeoutMs = 90_000) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
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
      resolve({ok: false, code: null, stdout, stderr: `${stderr}\n${command} timed out after ${timeoutMs}ms`.trim()});
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ok: code === 0, code, stdout, stderr});
    });
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ok: false, code: -1, stdout, stderr: String(err.stack || err)});
    });
  });
}

function parseJsonFromOutput(text) {
  const s = String(text || '').trim();
  const starts = [s.indexOf('{'), s.indexOf('[')].filter(i => i >= 0);
  if (!starts.length) return null;
  try { return JSON.parse(s.slice(Math.min(...starts))); } catch { return null; }
}

function isPseudoResult(result) {
  return String(result?.storeKey || '').startsWith('__');
}

function hasRealStoreFailures(job) {
  return job.results.some(r => !isPseudoResult(r) && r.error);
}

function hasAnyFailures(job) {
  return job.results.some(r => r.error);
}

function isLoginRedirectError(error) {
  return /20302|子系统登录重定向|login\/|账号登录|登录重定向/i.test(String(error || ''));
}

function isTransientFetchError(error) {
  return /CDP command timed out|Runtime\.enable|Runtime\.evaluate|Target page, context or browser has been closed|Target closed|browser has been closed|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed:\s*$|timed out after|Navigation timeout|Protocol error/i.test(String(error || ''));
}

async function closeStoreBrowser(store) {
  const script = path.join(ROOT, 'scripts', 'close_store_browsers.ps1');
  return await runCommand('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Stores',
    store.storeKey,
  ], 60_000);
}

async function isCdpOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(1500)});
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBrowser(store, launchMissing, browserMode = 'headless') {
  if (await isCdpOpen(store.port)) return {opened: true, launched: false};
  if (!launchMissing) return {opened: false, launched: false, error: `Chrome CDP port ${store.port} is not open`};
  async function launchAndWait(mode) {
    const launchArgs = [store.storeKey];
    if (mode === 'headless') launchArgs.push('--headless');
    else if (mode === 'background') launchArgs.push('--background');
    else launchArgs.push('--visible');
    const launch = await runNode('launch_store_browser.mjs', launchArgs);
    if (!launch.ok) return {opened: false, launched: false, mode, error: launch.stderr || launch.stdout};
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await isCdpOpen(store.port)) return {opened: true, launched: true, mode};
    }
    return {opened: false, launched: true, mode, error: `launched but CDP port ${store.port} did not open in time`};
  }
  const first = await launchAndWait(browserMode);
  if (first.opened || browserMode !== 'headless') return first;
  // Some real Chrome profiles can exit with code 13 in headless mode after a reboot
  // while the same profile works offscreen. Fall back to hidden background Chrome
  // before failing the store sync.
  const fallback = await launchAndWait('background');
  if (fallback.opened) return {...fallback, fallbackFrom: 'headless', firstError: first.error};
  return {
    opened: false,
    launched: true,
    mode: browserMode,
    fallbackMode: 'background',
    error: `${first.error}; background fallback failed: ${fallback.error}`,
  }
}

async function tryAutoRelogin(store, date, options) {
  if (!options.autoRelogin) {
    return {attempted: false, ok: false, skipped: true, reason: 'auto_relogin_disabled'};
  }
  const reloginArgs = [store.storeKey, '--date', date, options.reloginVisible ? '--visible' : '--headless'];
  const relogin = await runNode('auto_relogin_shein_store.mjs', reloginArgs);
  const parsed = parseJsonFromOutput(relogin.stdout);
  return {
    attempted: true,
    ok: relogin.ok && parsed?.ok !== false,
    code: relogin.code,
    mode: options.reloginVisible ? 'visible' : 'headless',
    stdoutTail: relogin.stdout.slice(-2000),
    stderrTail: relogin.stderr.slice(-2000),
    parsed,
  };
}

async function fetchStoreSales(store, date) {
  const fetchArgs = [store.storeKey, '--date', date];
  const transport = salesTransportForStore(store);
  if (transport && transport !== 'browser') fetchArgs.push('--transport', transport);
  const fetchResult = await runNode('fetch_shein_sales.mjs', fetchArgs);
  const fetchJson = fetchResult.ok ? parseJsonFromOutput(fetchResult.stdout) : null;
  return {
    ok: fetchResult.ok,
    stdoutTail: fetchResult.stdout.slice(-1200),
    stderrTail: fetchResult.stderr.slice(-1200),
    error: fetchResult.ok ? null : `fetch failed: ${fetchResult.stderr || fetchResult.stdout}`,
    salesSar: fetchJson?.totalSar ?? fetchJson?.daily?.[0]?.salesSar ?? null,
    transport: fetchJson?.transport || transport || 'browser',
  };
}

async function fetchStoreSalesWithOptions(store, date, options = {}) {
  const fetchArgs = [store.storeKey, '--date', date];
  const transport = options.transport || salesTransportForStore(store);
  if (transport === 'openapi') {
    const fetchResult = await runNode('fetch_shein_openapi_sales.mjs', [
      store.storeKey,
      '--date',
      date,
      '--out',
      path.join(ROOT, 'outputs', 'shein_fetch'),
    ]);
    const fetchJson = fetchResult.ok ? parseJsonFromOutput(fetchResult.stdout) : null;
    return {
      ok: fetchResult.ok,
      stdoutTail: fetchResult.stdout.slice(-1200),
      stderrTail: fetchResult.stderr.slice(-1200),
      error: fetchResult.ok ? null : `openapi fetch failed: ${fetchResult.stderr || fetchResult.stdout}`,
      salesSar: fetchJson?.outputs?.[0]?.summary?.salesSar ?? null,
      transport: 'openapi',
    };
  }
  if (transport && transport !== 'browser') fetchArgs.push('--transport', transport);
  if (options.refreshSession) fetchArgs.push('--refresh-session');
  const fetchResult = await runNode('fetch_shein_sales.mjs', fetchArgs);
  const fetchJson = fetchResult.ok ? parseJsonFromOutput(fetchResult.stdout) : null;
  return {
    ok: fetchResult.ok,
    stdoutTail: fetchResult.stdout.slice(-1200),
    stderrTail: fetchResult.stderr.slice(-1200),
    error: fetchResult.ok ? null : `fetch failed: ${fetchResult.stderr || fetchResult.stdout}`,
    salesSar: fetchJson?.totalSar ?? fetchJson?.daily?.[0]?.salesSar ?? null,
    transport: fetchJson?.transport || transport || 'browser',
  };
}

function salesTransportForStore(store) {
  const value = String(process.env.SHEIN_SALES_TRANSPORT || store.salesTransport || 'browser').trim().toLowerCase();
  return ['webapi', 'auto', 'browser', 'openapi'].includes(value) ? value : 'browser';
}

async function syncOneStore(store, date, status, options) {
  const result = {
    storeKey: store.storeKey,
    shopName: store.shopName,
    date,
    status,
    browser: null,
    fetchOk: false,
    syncOk: false,
    salesSar: null,
    error: null,
    autoRelogin: null,
    retryAttempts: [],
  };

  const maxAttempts = Math.max(1, Number(options.storeAttempts || 1));
  const salesTransport = salesTransportForStore(store);
  if (salesTransport === 'openapi') {
    const fetchResult = await fetchStoreSalesWithOptions(store, date, {transport: 'openapi'});
    result.fetchStdoutTail = fetchResult.stdoutTail;
    result.fetchStderrTail = fetchResult.stderrTail;
    result.fetchTransport = fetchResult.transport;
    if (!fetchResult.ok) {
      result.error = fetchResult.error || 'openapi fetch failed';
      return result;
    }
    result.fetchOk = true;
    result.salesSar = fetchResult.salesSar;
    result.browser = {opened: false, launched: false, skipped: true, reason: 'openapi_transport_succeeded_without_browser_launch'};
    result.syncOk = true;
    result.syncSkipped = true;
    result.syncSkipReason = 'openapi_transport_no_lark_base_sync';
    return result;
  }
  const webApiFirst = salesTransport === 'webapi' || salesTransport === 'auto';
  let fetchResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (webApiFirst) {
      fetchResult = await fetchStoreSalesWithOptions(store, date, {transport: salesTransport, refreshSession: false});
      result.fetchStdoutTail = fetchResult.stdoutTail;
      result.fetchStderrTail = fetchResult.stderrTail;
      result.fetchTransport = fetchResult.transport;
      if (fetchResult.ok) {
        result.browser = {opened: false, launched: false, skipped: true, reason: 'webapi_transport_succeeded_without_browser_launch'};
        break;
      }
      result.webApiFirstError = String(fetchResult.error || '').slice(0, 1000);
    }

    result.browser = await ensureBrowser(store, options.launchMissing, options.browserMode);
    if (!result.browser.opened) {
      result.error = webApiFirst
        ? `${fetchResult?.error || 'webapi fetch failed'}; browser fallback unavailable: ${result.browser.error}`
        : result.browser.error;
      return result;
    }

    fetchResult = await fetchStoreSalesWithOptions(store, date, {transport: salesTransport, refreshSession: webApiFirst});
    result.fetchStdoutTail = fetchResult.stdoutTail;
    result.fetchStderrTail = fetchResult.stderrTail;
    result.fetchTransport = fetchResult.transport;
    if (!fetchResult.ok && isLoginRedirectError(fetchResult.error)) {
      result.autoRelogin = await tryAutoRelogin(store, date, options);
      if (result.autoRelogin.ok) {
        fetchResult = await fetchStoreSalesWithOptions(store, date, {transport: salesTransport, refreshSession: webApiFirst});
        result.fetchStdoutTail = fetchResult.stdoutTail;
        result.fetchStderrTail = fetchResult.stderrTail;
        result.fetchTransport = fetchResult.transport;
      }
    }

    if (fetchResult.ok) break;

    const transient = isTransientFetchError(fetchResult.error);
    if (!transient || attempt >= maxAttempts) break;

    const close = await closeStoreBrowser(store);
    result.retryAttempts.push({
      attempt,
      reason: 'transient_fetch_error_restart_browser',
      error: String(fetchResult.error || '').slice(0, 500),
      closeOk: close.ok,
      closeCode: close.code,
      closeStdoutTail: close.stdout.slice(-1000),
      closeStderrTail: close.stderr.slice(-1000),
    });
    await new Promise(r => setTimeout(r, 3000));
  }

  if (!fetchResult?.ok) {
    const reloginNote = result.autoRelogin?.attempted
      ? `; auto relogin ${result.autoRelogin.ok ? 'succeeded but refetch failed' : 'failed'}`
      : '';
    const retryNote = result.retryAttempts.length
      ? `; transient retries=${result.retryAttempts.length}`
      : '';
    result.error = `${fetchResult?.error || 'fetch failed'}${reloginNote}${retryNote}`;
    return result;
    }
  result.fetchOk = true;
  result.salesSar = fetchResult.salesSar;

  const detailFile = path.join(ROOT, 'outputs', 'shein_fetch', store.storeKey, `${date}.json`);
  if (args.skipLarkBase) {
    result.syncOk = true;
    result.syncSkipped = true;
    result.syncSkipReason = 'feishu_base_paused';
    return result;
  }

  const syncResult = await runNode('sync_shein_daily_to_lark.mjs', ['--file', detailFile, '--status', status]);
  result.syncStdoutTail = syncResult.stdout.slice(-1200);
  result.syncStderrTail = syncResult.stderr.slice(-1200);
  if (!syncResult.ok) {
    result.error = `sync failed: ${syncResult.stderr || syncResult.stdout}`;
    return result;
  }
  result.syncOk = true;
  return result;
}

function jobLogFile(mode, date) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(JOB_LOG_DIR, `${stamp}-${mode}-${date}.json`);
}

async function writeJobLog(file, job) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, JSON.stringify(job, null, 2), 'utf8');
}

async function readCheckpoint() {
  try {
    return JSON.parse((await fs.readFile(CHECKPOINT_PATH, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err?.code === 'ENOENT') return {version: 1, groups: {}};
    throw err;
  }
}

async function writeCheckpoint(checkpoint) {
  await fs.mkdir(path.dirname(CHECKPOINT_PATH), {recursive: true});
  await fs.writeFile(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2), 'utf8');
}

async function updateCheckpointFromJob(job) {
  if (job.finalStatus !== 'done') return null;
  const checkpoint = await readCheckpoint();
  checkpoint.version = 1;
  checkpoint.updatedAt = new Date().toISOString();
  checkpoint.groups ||= {};
  checkpoint.groups[job.group] ||= {};
  const group = checkpoint.groups[job.group];
  group.lastSuccessAt = checkpoint.updatedAt;
  group.lastSuccessMode = job.mode;
  group.lastSuccessDate = job.date;
  if (job.mode === 'intraday') group.lastIntradayDate = job.date;
  if (job.mode === 'yesterday-final' || /\u6700\u7ec8/.test(job.status || '')) {
    if (!group.lastFinalDate || job.date > group.lastFinalDate) group.lastFinalDate = job.date;
  }
  await writeCheckpoint(checkpoint);
  return group;
}

const args = parseArgs(process.argv.slice(2));
args.skipLarkBase = args.skipLarkBase
  || envTruthy(process.env.SHEIN_FEISHU_BASE_PAUSED)
  || await fileExists(FEISHU_BASE_PAUSE_FLAG);
if (args.skipLarkBase) {
  args.refreshProducts = false;
  args.refreshCompactDisplay = false;
  args.refreshMonthly = false;
  args.refreshDashboard = false;
  args.refreshAllDashboard = false;
}
const {date, status} = resolveJobDateAndStatus(args);
const stores = selectedStores(args);
const month = date.slice(0, 7);
const logFile = jobLogFile(args.mode || 'date', date);
const job = {
  startedAt: new Date().toISOString(),
  mode: args.mode,
  date,
  status,
  group: args.group,
  browserMode: args.browserMode,
  feishuBasePaused: args.skipLarkBase,
  stores: stores.map(s => s.storeKey),
  results: [],
  productRefresh: null,
  compactDisplayRefresh: null,
  monthlyRefresh: null,
  dashboardRefresh: null,
  allDashboardRefresh: null,
  skippedDownstreamRefresh: false,
  skipReason: null,
  finalStatus: 'running',
};
await writeJobLog(logFile, job);

for (const store of stores) {
  const result = await syncOneStore(store, date, status, args);
  job.results.push(result);
  await writeJobLog(logFile, job);
  console.log(JSON.stringify({
    storeKey: result.storeKey,
    date,
    ok: result.fetchOk && result.syncOk,
    syncSkipped: !!result.syncSkipped,
    salesSar: result.salesSar,
    error: result.error,
  }));
}

const storeFailureBeforeRefresh = hasRealStoreFailures(job);
if (storeFailureBeforeRefresh) {
  job.skippedDownstreamRefresh = true;
  job.skipReason = '有店铺抓取或写入失败，已跳过产品/月表/看板刷新，避免用旧本地文件刷新出误导数据。';
} else if (args.refreshProducts) {
  const productArgs = ['--date', date, '--group', args.group, '--no-weekly', '--no-monthly'];
  const product = await runNode('sync_product_sales_to_lark.mjs', productArgs);
  job.productRefresh = {
    ok: product.ok,
    stdoutTail: product.stdout.slice(-4000),
    stderrTail: product.stderr.slice(-4000),
    parsed: parseJsonFromOutput(product.stdout),
  };
  if (!product.ok && !job.results.some(r => r.error)) {
    job.results.push({storeKey: '__products__', date, error: product.stderr || product.stdout});
  }
}

if (hasAnyFailures(job) && !job.skippedDownstreamRefresh) {
  job.skippedDownstreamRefresh = true;
  job.skipReason = '已有上游刷新环节失败，已跳过后续派生表/看板刷新，避免口径不一致。';
}

if (!hasAnyFailures(job) && args.refreshCompactDisplay) {
  const compactArgs = ['--group', args.group, '--current-month', month, '--recent-months', '3'];
  const compact = await runNode('generate_compact_display_tables.mjs', compactArgs);
  job.compactDisplayRefresh = {
    ok: compact.ok,
    stdoutTail: compact.stdout.slice(-4000),
    stderrTail: compact.stderr.slice(-4000),
    parsed: parseJsonFromOutput(compact.stdout),
  };
  if (!compact.ok && !job.results.some(r => r.error)) {
    job.results.push({storeKey: '__compact_display__', date, error: compact.stderr || compact.stdout});
  }
}

if (hasAnyFailures(job) && !job.skippedDownstreamRefresh) {
  job.skippedDownstreamRefresh = true;
  job.skipReason = '已有上游刷新环节失败，已跳过后续派生表/看板刷新，避免口径不一致。';
}

if (!hasAnyFailures(job) && args.refreshMonthly) {
  const monthlyArgs = ['--month', month];
  if (args.dsyOnlyMonthly) monthlyArgs.push('--dsy-only');
  else monthlyArgs.push('--include-lgm');
  const monthly = await runNode('generate_monthly_sales_table.mjs', monthlyArgs);
  job.monthlyRefresh = {
    ok: monthly.ok,
    stdoutTail: monthly.stdout.slice(-2000),
    stderrTail: monthly.stderr.slice(-2000),
    parsed: parseJsonFromOutput(monthly.stdout),
  };
  if (!monthly.ok && !job.results.some(r => r.error)) {
    job.results.push({storeKey: '__monthly__', date, error: monthly.stderr || monthly.stdout});
  }
}

if (hasAnyFailures(job) && !job.skippedDownstreamRefresh) {
  job.skippedDownstreamRefresh = true;
  job.skipReason = '已有上游刷新环节失败，已跳过后续派生表/看板刷新，避免口径不一致。';
}

if (!hasAnyFailures(job) && args.refreshDashboard) {
  const dashboardArgs = ['--group', args.group, '--month', month, '--no-create-dashboard'];
  if (args.dashboardName) dashboardArgs.push('--name', args.dashboardName);
  const dashboard = await runNode('setup_lark_dashboard_native.mjs', dashboardArgs);
  job.dashboardRefresh = {
    ok: dashboard.ok,
    stdoutTail: dashboard.stdout.slice(-4000),
    stderrTail: dashboard.stderr.slice(-4000),
    parsed: parseJsonFromOutput(dashboard.stdout),
  };
  if (!dashboard.ok && !job.results.some(r => r.error)) {
    job.results.push({storeKey: '__dashboard__', date, error: dashboard.stderr || dashboard.stdout});
  }
}

if (hasAnyFailures(job) && !job.skippedDownstreamRefresh) {
  job.skippedDownstreamRefresh = true;
  job.skipReason = '已有上游刷新环节失败，已跳过后续派生表/看板刷新，避免口径不一致。';
}

if (!hasAnyFailures(job) && args.refreshAllDashboard) {
  const allDashboardArgs = ['--month', month, '--name', args.allDashboardName];
  const allDashboard = await runNode('setup_lark_dashboard_main_v3.mjs', allDashboardArgs);
  job.allDashboardRefresh = {
    ok: allDashboard.ok,
    stdoutTail: allDashboard.stdout.slice(-4000),
    stderrTail: allDashboard.stderr.slice(-4000),
    parsed: parseJsonFromOutput(allDashboard.stdout),
  };
  if (!allDashboard.ok && !job.results.some(r => r.error)) {
    job.results.push({storeKey: '__all_dashboard__', date, error: allDashboard.stderr || allDashboard.stdout});
  }
}

job.finishedAt = new Date().toISOString();
job.finalStatus = job.results.some(r => r.error || (r.storeKey !== '__monthly__' && (!r.fetchOk || !r.syncOk)))
  ? 'finished_with_failures'
  : 'done';
job.checkpoint = await updateCheckpointFromJob(job);
await writeJobLog(logFile, job);

console.log(JSON.stringify({
  ok: job.finalStatus === 'done',
  finalStatus: job.finalStatus,
  date,
  status,
  stores: job.stores,
  failedStores: job.results
    .filter(r => !isPseudoResult(r) && r.error)
    .map(r => ({storeKey: r.storeKey, error: String(r.error || '').slice(0, 300)})),
  loginRequiredStores: job.results
    .filter(r => !isPseudoResult(r) && r.error && isLoginRedirectError(r.error))
    .map(r => r.storeKey),
  autoReloginStores: job.results
    .filter(r => !isPseudoResult(r) && r.autoRelogin?.attempted)
    .map(r => ({storeKey: r.storeKey, ok: !!r.autoRelogin.ok, mode: r.autoRelogin.mode})),
  totalSalesSar: job.results
    .filter(r => !isPseudoResult(r))
    .reduce((sum, r) => sum + Number(r.salesSar || 0), 0),
  skippedDownstreamRefresh: job.skippedDownstreamRefresh,
  skipReason: job.skipReason,
  feishuBasePaused: job.feishuBasePaused,
  logFile: path.relative(ROOT, logFile),
  monthlyTable: job.monthlyRefresh?.parsed?.tableName || null,
  monthlyOk: job.monthlyRefresh?.ok ?? null,
  productOk: job.productRefresh?.ok ?? null,
  compactDisplayOk: job.compactDisplayRefresh?.ok ?? null,
  productWideTables: job.compactDisplayRefresh?.parsed?.tables
    ?.filter(t => t.name === '产品周销量-宽表' || t.name === '产品月销量-宽表')
    ?.map(t => ({name: t.name, rowCount: t.rowCount, periods: t.periods})) || null,
  dashboardOk: job.dashboardRefresh?.ok ?? null,
  allDashboardOk: job.allDashboardRefresh?.ok ?? null,
  allDashboardUrl: job.allDashboardRefresh?.parsed?.dashboardUrl || null,
  dashboardSourceTables: job.dashboardRefresh?.parsed?.sourceResults?.length ?? null,
  productDailyRows: job.productRefresh?.parsed?.dailyRowCount ?? null,
  productDisplayTable: job.productRefresh?.parsed?.displayTable?.name || null,
}, null, 2));

if (job.finalStatus !== 'done') {
  process.exitCode = 1;
}
