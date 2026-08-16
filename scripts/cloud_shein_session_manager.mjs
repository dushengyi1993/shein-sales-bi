#!/usr/bin/env node
/**
 * Cloud-side SHEIN session manager.
 *
 * Goals:
 * - Keep each store isolated in its own Chrome profile.
 * - Probe/restore both GSP order WebAPI login and SBN product-analysis login.
 * - Report profile/session size so cache growth is visible before it hurts disk.
 * - Never print cookie values, passwords, localStorage values, or request headers.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const DEFAULT_REPORT_DIR = process.env.SHEIN_SESSION_MANAGER_REPORT_DIR || path.join(ROOT, 'outputs', 'reports');
const DEFAULT_LOG_DIR = process.env.SHEIN_BI_LOG_DIR || '/srv/shein-bi/logs/cloud-session-manager';
const PROFILE_WARN_BYTES = 800 * 1024 * 1024;
const PROFILES_TOTAL_WARN_BYTES = 8 * 1024 * 1024 * 1024;
const CACHE_RELATIVE_PATHS = [
  'cache',
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'Crashpad',
  'OptGuideOnDeviceModel',
  path.join('Default', 'Cache'),
  path.join('Default', 'Code Cache'),
  path.join('Default', 'GPUCache'),
  path.join('Default', 'Service Worker', 'CacheStorage'),
  path.join('Default', 'Service Worker', 'ScriptCache'),
  path.join('Profile 1', 'Cache'),
  path.join('Profile 1', 'Code Cache'),
  path.join('Profile 1', 'GPUCache'),
  path.join('Profile 1', 'Service Worker', 'CacheStorage'),
  path.join('Profile 1', 'Service Worker', 'ScriptCache'),
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function bjDate(offsetDays = 0) {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
  const bj = new Date(utc + 8 * 3600_000);
  bj.setDate(bj.getDate() + offsetDays);
  return `${bj.getFullYear()}-${pad2(bj.getMonth() + 1)}-${pad2(bj.getDate())}`;
}

function stamp(d = new Date()) {
  const utc = d.getTime() + d.getTimezoneOffset() * 60_000;
  const bj = new Date(utc + 8 * 3600_000);
  return `${bj.getFullYear()}${pad2(bj.getMonth() + 1)}${pad2(bj.getDate())}-${pad2(bj.getHours())}${pad2(bj.getMinutes())}${pad2(bj.getSeconds())}`;
}

function parseBytes(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
}

function parseArgs(argv) {
  const args = {
    group: 'ALL',
    stores: null,
    storesSpecified: false,
    date: bjDate(0),
    restore: true,
    closeLaunched: true,
    cleanupCache: false,
    profileWarnBytes: PROFILE_WARN_BYTES,
    profilesTotalWarnBytes: PROFILES_TOTAL_WARN_BYTES,
    timeoutMs: 180_000,
    reportDir: DEFAULT_REPORT_DIR,
    logDir: DEFAULT_LOG_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--group') args.group = String(argv[++i] || args.group).toUpperCase();
    else if (a === '--store') {
      args.storesSpecified = true;
      args.stores = [String(argv[++i] || '').trim().toUpperCase()].filter(Boolean);
    } else if (a === '--stores') {
      args.storesSpecified = true;
      args.stores = String(argv[++i] || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    }
    else if (a === '--date') args.date = String(argv[++i] || args.date);
    else if (a === '--no-restore') args.restore = false;
    else if (a === '--restore') args.restore = true;
    else if (a === '--keep-open') args.closeLaunched = false;
    else if (a === '--close-launched') args.closeLaunched = true;
    else if (a === '--cleanup-cache') args.cleanupCache = true;
    else if (a === '--profile-warn-mb') args.profileWarnBytes = parseBytes(argv[++i], args.profileWarnBytes / 1024 / 1024) * 1024 * 1024;
    else if (a === '--profiles-total-warn-gb') args.profilesTotalWarnBytes = parseBytes(argv[++i], args.profilesTotalWarnBytes / 1024 / 1024 / 1024) * 1024 * 1024 * 1024;
    else if (a === '--timeout-ms') args.timeoutMs = Math.max(30_000, Number(argv[++i] || args.timeoutMs));
    else if (a === '--report-dir') args.reportDir = path.resolve(ROOT, String(argv[++i] || args.reportDir));
    else if (a === '--log-dir') args.logDir = path.resolve(String(argv[++i] || args.logDir));
  }
  return args;
}

// ---------------------------------------------------------------------------
// Report-scope protection
//
// The canonical `cloud-session-manager-latest.json` is all-store strong
// evidence consumed by the coordinator/wake-up gate and the cloud watchdog.
// It may be atomically replaced only by an invocation whose requested/result
// store set exactly equals the current enabled-store set (unique, no missing,
// no extra).  Every other invocation (single store, group, subset, duplicates
// or extra keys) is a partial run: it keeps its own timestamped report and an
// explicit `latest-partial` artifact, and can never overwrite the canonical
// latest evidence.
// ---------------------------------------------------------------------------

export function normalizeStoreKeyList(keys) {
  const unique = [];
  const duplicates = [];
  const seen = new Set();
  for (const raw of keys || []) {
    const key = String(raw || '').trim().toUpperCase();
    if (!key) continue;
    if (seen.has(key)) duplicates.push(key);
    else {
      seen.add(key);
      unique.push(key);
    }
  }
  return {unique, duplicates};
}

export function classifyStoreScope({enabledStoreKeys, coveredStoreKeys} = {}) {
  const expected = normalizeStoreKeyList(enabledStoreKeys).unique;
  const coveredInfo = normalizeStoreKeyList(coveredStoreKeys);
  const covered = coveredInfo.unique;
  const expectedSet = new Set(expected);
  const coveredSet = new Set(covered);
  const missingStoreKeys = expected.filter(key => !coveredSet.has(key));
  const extraStoreKeys = covered.filter(key => !expectedSet.has(key));
  const canonicalLatestAllowed = expected.length > 0
    && covered.length === expected.length
    && missingStoreKeys.length === 0
    && extraStoreKeys.length === 0
    && coveredInfo.duplicates.length === 0;
  return {
    kind: canonicalLatestAllowed ? 'all-enabled' : 'partial',
    canonicalLatestAllowed,
    expectedStoreKeys: expected,
    coveredStoreKeys: covered,
    missingStoreKeys,
    extraStoreKeys,
    duplicateStoreKeys: coveredInfo.duplicates,
  };
}

export function assertSelectionWithinEnabled({selectedStoreKeys, enabledStoreKeys} = {}) {
  const selected = normalizeStoreKeyList(selectedStoreKeys);
  const enabled = normalizeStoreKeyList(enabledStoreKeys).unique;
  if (selected.unique.length === 0) {
    throw new Error('Empty store selection: at least one enabled store is required');
  }
  if (selected.duplicates.length) {
    throw new Error(`Duplicate store selection rejected: ${[...new Set(selected.duplicates)].join(', ')}`);
  }
  const enabledSet = new Set(enabled);
  const unknown = selected.unique.filter(key => !enabledSet.has(key));
  if (unknown.length) {
    throw new Error(`Unknown or disabled store selection rejected: ${unknown.join(', ')}`);
  }
  return selected.unique;
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

function selectStores(config, args) {
  const enabled = config.stores.filter(s => s.enabled !== false);
  const enabledStoreKeys = enabled
    .map(s => String(s.storeKey || '').trim().toUpperCase())
    .filter(Boolean);
  const keys = args.storesSpecified
    ? args.stores
    : (args.group === 'ALL' ? enabledStoreKeys : (config.groups?.[args.group] || []).map(k => String(k).toUpperCase()));
  if (!Array.isArray(keys)) throw new Error(`Unknown store group: ${args.group}`);
  const selected = assertSelectionWithinEnabled({selectedStoreKeys: keys, enabledStoreKeys});
  return selected.map(key => {
    const store = enabled.find(s => s.storeKey.toUpperCase() === key);
    if (!store) throw new Error(`Unknown or disabled store: ${key}`);
    return store;
  });
}

function run(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...options,
    });
    let stdout = '';
    let stderr = '';
    let timer = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ok: false, code: -1, stdout, stderr: `${stderr}\n${String(err?.stack || err)}`.trim(), timedOut: false});
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ok: code === 0, code, stdout, stderr, timedOut: false});
    });
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        resolve({ok: false, code: -1, stdout, stderr, timedOut: true});
      }, options.timeoutMs);
    }
  });
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function fileMeta(file) {
  try {
    const st = await fs.stat(file);
    return {exists: true, sizeBytes: st.size, updatedAt: st.mtime.toISOString()};
  } catch {
    return {exists: false, sizeBytes: 0, updatedAt: null};
  }
}

async function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  await fs.writeFile(tmp, data, 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, {force: true}).catch(() => null);
    throw err;
  }
}

async function dirSizeBytes(dir) {
  if (!(await exists(dir))) return 0;
  if (process.platform !== 'win32') {
    const res = await run('du', ['-sk', dir], {timeoutMs: 60_000});
    const kb = Number(String(res.stdout || '').trim().split(/\s+/)[0]);
    if (res.ok && Number.isFinite(kb)) return kb * 1024;
  }
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(current, ent.name);
      try {
        if (ent.isDirectory()) stack.push(p);
        else if (ent.isFile()) total += (await fs.stat(p)).size;
      } catch {}
    }
  }
  return total;
}

function humanBytes(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

async function isCdpOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(1500)});
    return res.ok;
  } catch {
    return false;
  }
}

async function closeChromeByPort(port) {
  try {
    const meta = await (await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(2000)})).json();
    const wsUrl = meta.webSocketDebuggerUrl;
    if (!wsUrl) return {ok: false, error: 'missing webSocketDebuggerUrl'};
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, {once: true});
      ws.addEventListener('error', reject, {once: true});
    });
    ws.send(JSON.stringify({id: 1, method: 'Browser.close'}));
    await new Promise(resolve => setTimeout(resolve, 1200));
    try { ws.close(); } catch {}
    return {ok: true};
  } catch (err) {
    return {ok: false, error: String(err?.message || err)};
  }
}

function parseLastJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.lastIndexOf('\n{');
  if (start >= 0) {
    try {
      return JSON.parse(text.slice(start + 1));
    } catch {}
  }
  return null;
}

function profileDirForStore(store) {
  return path.join(ROOT, 'profiles', `persistent-${store.profileKey}-profile`);
}

function safeInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function cleanupProfileCache(profileDir) {
  const removed = [];
  for (const rel of CACHE_RELATIVE_PATHS) {
    const target = path.join(profileDir, rel);
    if (!safeInside(profileDir, target) || !(await exists(target))) continue;
    const before = await dirSizeBytes(target);
    try {
      await fs.rm(target, {recursive: true, force: true});
      removed.push({path: path.relative(ROOT, target), bytes: before, human: humanBytes(before)});
    } catch (err) {
      removed.push({path: path.relative(ROOT, target), bytes: before, human: humanBytes(before), error: String(err?.message || err)});
    }
  }
  return removed;
}

async function probeStore(store, args) {
  const profileDir = profileDirForStore(store);
  const beforeOpen = await isCdpOpen(store.port);
  const profileSizeBefore = await dirSizeBytes(profileDir);
  const browserSessionFile = path.join(ROOT, 'state', 'shein_browser_sessions', `${store.storeKey}.local.json`);
  const webApiSessionFile = path.join(ROOT, 'state', 'shein_webapi_sessions', `${store.storeKey}.local.json`);
  const commandArgs = args.restore
    ? [path.join(ROOT, 'scripts', 'restore_shein_store_session.mjs'), '--store', store.storeKey, '--date', args.date, '--headless', '--timeout-ms', String(args.timeoutMs)]
    : [path.join(ROOT, 'scripts', 'bootstrap_shein_browser_session.mjs'), '--store', store.storeKey, '--date', args.date, '--headless', '--timeout-ms', String(args.timeoutMs)];
  const startedAt = new Date().toISOString();
  const res = await run(process.execPath, commandArgs, {timeoutMs: args.timeoutMs + 30_000});
  const endedAt = new Date().toISOString();
  const parsed = parseLastJson(res.stdout);
  const afterOpen = await isCdpOpen(store.port);
  let closeResult = null;
  if (args.closeLaunched && !beforeOpen && afterOpen) {
    closeResult = await closeChromeByPort(store.port);
  }
  let cleanup = [];
  if (args.cleanupCache) {
    cleanup = await cleanupProfileCache(profileDir);
  }
  const profileSizeAfter = await dirSizeBytes(profileDir);
  const sessionMeta = {
    browser: await fileMeta(browserSessionFile),
    webapi: await fileMeta(webApiSessionFile),
  };
  const webApiExportedAtMs = Date.parse(sessionMeta.webapi.updatedAt || '');
  const runStartedAtMs = Date.parse(startedAt);
  const webApiSessionFresh = Number.isFinite(webApiExportedAtMs)
    && Number.isFinite(runStartedAtMs)
    && webApiExportedAtMs >= runStartedAtMs - 5_000;
  const webApiProbeOk = parsed?.exportSession?.stores?.some(entry =>
    String(entry?.storeKey || '').toUpperCase() === store.storeKey
    && entry?.webApiProbe?.ok === true
  ) === true;
  const okFromParsed = parsed ? Boolean(parsed.ok) : res.ok;
  const warnings = [];
  if (profileSizeAfter > args.profileWarnBytes) warnings.push(`profile_size_high:${humanBytes(profileSizeAfter)}`);
  if (!sessionMeta.browser.exists) warnings.push('missing_browser_session_export');
  if (!sessionMeta.webapi.exists) warnings.push('missing_webapi_session_export');
  if (!webApiSessionFresh) warnings.push('stale_webapi_session_export');
  if (!webApiProbeOk) warnings.push('webapi_session_probe_not_verified');
  if (closeResult && !closeResult.ok) warnings.push(`close_launched_chrome_failed:${closeResult.error || '-'}`);
  return {
    storeKey: store.storeKey,
    groupKey: store.groupKey,
    shopName: store.shopName,
    port: store.port,
    ok: res.ok && okFromParsed && webApiSessionFresh && webApiProbeOk,
    mode: args.restore ? 'restore' : 'check',
    startedAt,
    endedAt,
    beforeOpen,
    afterOpen,
    closeResult,
    profile: {
      path: path.relative(ROOT, profileDir),
      sizeBytesBefore: profileSizeBefore,
      sizeBefore: humanBytes(profileSizeBefore),
      sizeBytesAfter: profileSizeAfter,
      sizeAfter: humanBytes(profileSizeAfter),
      cleanup,
    },
    sessions: sessionMeta,
    command: {
      ok: res.ok,
      code: res.code,
      timedOut: res.timedOut,
      stderrPreview: String(res.stderr || '').slice(0, 1200),
    },
    probe: parsed ? {
      ok: parsed.ok,
      failedStores: parsed.failedStores || [],
      reportFile: parsed.reportFile || '',
      date: parsed.date || '',
    } : null,
    exportSession: parsed?.exportSession || null,
    warnings,
  };
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# SHEIN 云端登录态管家报告`);
  lines.push('');
  lines.push(`- 时间：${report.generatedAt}`);
  lines.push(`- 日期口径：${report.date}`);
  lines.push(`- 结果：${report.ok ? '通过' : '异常'}`);
  lines.push(`- 店铺：${report.summary.okStores}/${report.summary.totalStores} 通过`);
  const scopeText = report.scope?.kind === 'all-enabled'
    ? `全部启用店铺（${report.scope.expectedStoreKeys.length}/${report.scope.expectedStoreKeys.length}）`
    : `部分店铺（${report.scope?.coveredStoreKeys?.length || 0}/${report.scope?.expectedStoreKeys?.length || 0}${report.scope?.missingStoreKeys?.length ? `，缺 ${report.scope.missingStoreKeys.join('、')}` : ''}）`;
  lines.push(`- 范围：${scopeText}`);
  lines.push(`- profile 总占用：${report.summary.profilesTotalHuman}`);
  lines.push('');
  if (report.issues.length) {
    lines.push(`## 异常`);
    for (const issue of report.issues) lines.push(`- ${issue}`);
    lines.push('');
  }
  if (report.warnings.length) {
    lines.push(`## 提醒`);
    for (const warning of report.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  lines.push(`## 店铺明细`);
  lines.push(`| 店铺 | 结果 | Profile | Browser Session | WebAPI Session | 提醒 |`);
  lines.push(`|---|---:|---:|---:|---:|---|`);
  for (const r of report.results) {
    lines.push(`| ${r.storeKey} | ${r.ok ? '通过' : '失败'} | ${r.profile.sizeAfter} | ${r.sessions.browser.exists ? '有' : '缺'} | ${r.sessions.webapi.exists ? '有' : '缺'} | ${r.warnings.join('; ') || '-'} |`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Write the report artifacts for one invocation.
 *
 * Every invocation keeps its timestamped report.  Only a run whose
 * `report.scope.canonicalLatestAllowed === true` (exact all-enabled store set)
 * atomically replaces the canonical `cloud-session-manager-latest.json` and
 * `.md`.  Partial runs write `cloud-session-manager-partial-<name>.json` plus
 * `cloud-session-manager-latest-partial.json`/`.md` and never touch the
 * canonical latest evidence.
 */
export async function writeSessionManagerArtifacts({reportDir, logDir, name, report}) {
  const isPartial = report?.scope?.canonicalLatestAllowed !== true;
  const prefix = isPartial ? 'cloud-session-manager-partial' : 'cloud-session-manager';
  const latestBase = isPartial ? 'cloud-session-manager-latest-partial' : 'cloud-session-manager-latest';
  await fs.mkdir(reportDir, {recursive: true});
  const json = JSON.stringify(report, null, 2);
  const md = renderMarkdown(report);
  const reportFile = path.join(reportDir, `${prefix}-${name}.json`);
  const latestJson = path.join(reportDir, `${latestBase}.json`);
  const latestMd = path.join(reportDir, `${latestBase}.md`);
  await atomicWrite(reportFile, json);
  await atomicWrite(latestJson, json);
  await atomicWrite(latestMd, md);
  if (logDir) {
    await fs.mkdir(logDir, {recursive: true}).catch(() => null);
    if (fssync.existsSync(logDir)) {
      await atomicWrite(path.join(logDir, `${prefix}-${name}.json`), json).catch(() => null);
    }
  }
  return {
    reportFile: path.relative(ROOT, reportFile),
    latestJson: path.relative(ROOT, latestJson),
    latestMd: path.relative(ROOT, latestMd),
    partial: isPartial,
    canonicalLatestUpdated: !isPartial,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await readJson(STORES_PATH);
  const enabledStoreKeys = (config.stores || [])
    .filter(s => s.enabled !== false)
    .map(s => String(s.storeKey || '').trim().toUpperCase())
    .filter(Boolean);
  const stores = selectStores(config, args);
  await fs.mkdir(args.reportDir, {recursive: true});
  await fs.mkdir(args.logDir, {recursive: true}).catch(() => null);

  const results = [];
  for (const store of stores) {
    const result = await probeStore(store, args);
    results.push(result);
    const state = result.ok ? 'ok' : 'failed';
    console.error(`[cloud_session_manager] ${store.storeKey} ${state} profile=${result.profile.sizeAfter} warnings=${result.warnings.length}`);
  }
  const profilesTotalBytes = results.reduce((sum, r) => sum + Number(r.profile.sizeBytesAfter || 0), 0);
  const issues = [];
  const warnings = [];
  for (const r of results) {
    if (!r.ok) issues.push(`${r.storeKey} 登录态恢复/巡检失败`);
    for (const w of r.warnings) warnings.push(`${r.storeKey}: ${w}`);
  }
  if (profilesTotalBytes > args.profilesTotalWarnBytes) warnings.push(`profiles_total_size_high:${humanBytes(profilesTotalBytes)}`);
  const scope = classifyStoreScope({
    enabledStoreKeys,
    coveredStoreKeys: results.map(r => String(r.storeKey || '').trim().toUpperCase()),
  });
  const report = {
    ok: issues.length === 0,
    generatedAt: new Date().toISOString(),
    date: args.date,
    mode: args.restore ? 'restore' : 'check',
    scope,
    canonicalLatestUpdated: scope.canonicalLatestAllowed,
    closeLaunched: args.closeLaunched,
    cleanupCache: args.cleanupCache,
    summary: {
      totalStores: results.length,
      okStores: results.filter(r => r.ok).length,
      failedStores: results.filter(r => !r.ok).map(r => r.storeKey),
      profilesTotalBytes,
      profilesTotalHuman: humanBytes(profilesTotalBytes),
    },
    issues,
    warnings,
    results,
  };
  const artifacts = await writeSessionManagerArtifacts({
    reportDir: args.reportDir,
    logDir: args.logDir,
    name: stamp(),
    report,
  });
  console.log(JSON.stringify({
    ok: report.ok,
    generatedAt: report.generatedAt,
    date: report.date,
    mode: report.mode,
    scope: report.scope,
    canonicalLatestUpdated: report.canonicalLatestUpdated,
    summary: report.summary,
    issues: report.issues,
    warnings: report.warnings.slice(0, 30),
    reportFile: artifacts.reportFile,
    latestJson: artifacts.latestJson,
    latestMd: artifacts.latestMd,
    partial: artifacts.partial,
  }, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  });
}
