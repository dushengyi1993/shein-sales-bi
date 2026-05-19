#!/usr/bin/env node
/**
 * Bootstrap a cloud/headless Chrome profile from a saved SHEIN WebAPI session.
 *
 * This script is intentionally secret-safe: it reads Cookie headers from
 * state/shein_webapi_sessions/*.local.json, injects them into the matching
 * browser profile through CDP, and only prints counts/status. It never prints
 * cookie values or request headers.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const SESSION_DIR = path.join(ROOT, 'state', 'shein_webapi_sessions');
const BROWSER_SESSION_DIR = path.join(ROOT, 'state', 'shein_browser_sessions');
const ORIGIN_URL = 'https://sso.geiwohuo.com/';
const ORDER_URL = 'https://sso.geiwohuo.com/#/gsp/order-management/list';
const HOME_URL = 'https://sso.geiwohuo.com/#/gsp/home';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function parseArgs(argv) {
  const args = {
    stores: null,
    group: 'ALL',
    date: bjDate(0),
    sessionDir: SESSION_DIR,
    browserSessionDir: BROWSER_SESSION_DIR,
    launch: true,
    headless: true,
    probe: true,
    timeoutMs: 120_000,
    waitAfterLaunchMs: 2500,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store') args.stores = [argv[++i].trim().toUpperCase()];
    else if (a === '--stores') args.stores = argv[++i].split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (a === '--group') args.group = argv[++i].trim().toUpperCase();
    else if (a === '--date') args.date = argv[++i].trim();
    else if (a === '--session-dir') args.sessionDir = path.resolve(argv[++i]);
    else if (a === '--browser-session-dir') args.browserSessionDir = path.resolve(argv[++i]);
    else if (a === '--no-launch') args.launch = false;
    else if (a === '--visible') args.headless = false;
    else if (a === '--headless') args.headless = true;
    else if (a === '--no-probe') args.probe = false;
    else if (a === '--timeout-ms') args.timeoutMs = Math.max(10_000, Number(argv[++i] || args.timeoutMs));
    else if (a === '--wait-after-launch-ms') args.waitAfterLaunchMs = Math.max(0, Number(argv[++i] || args.waitAfterLaunchMs));
  }
  return args;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function selectStores(storesConfig, args) {
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

async function isCdpOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(1500)});
    return res.ok;
  } catch {
    return false;
  }
}

async function launchStore(store, args) {
  if (await isCdpOpen(store.port)) return {launched: false, alreadyOpen: true};
  if (!args.launch) return {launched: false, alreadyOpen: false, error: `CDP port ${store.port} is not open`};
  const launchArgs = [
    path.join(ROOT, 'scripts', 'launch_store_browser.mjs'),
    store.storeKey,
    args.headless ? '--headless' : '--visible',
    '--url',
    ORDER_URL,
  ];
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, launchArgs, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => resolve({ok: false, stdout, stderr: String(err?.stack || err)}));
    child.on('close', code => resolve({ok: code === 0, code, stdout, stderr}));
  });
  if (!result.ok) return {launched: false, alreadyOpen: false, error: result.stderr || result.stdout || `launch failed ${result.code}`};
  const deadline = Date.now() + args.timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (await isCdpOpen(store.port)) {
      await sleep(args.waitAfterLaunchMs);
      return {launched: true, alreadyOpen: false};
    }
  }
  return {launched: true, alreadyOpen: false, error: `CDP port ${store.port} did not open after launch`};
}

async function connectCdp(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(4000)})).json();
  const page = targets.find(t => t.type === 'page' && /geiwohuo|shein/i.test(t.url)) || targets.find(t => t.type === 'page');
  if (!page) throw new Error(`No Chrome page target on port ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once: true});
    ws.addEventListener('error', reject, {once: true});
  });
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 30_000);
      pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1365,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  }).catch(() => null);
  return {send, ws};
}

function parseCookieHeader(cookieHeader) {
  return String(cookieHeader || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const idx = part.indexOf('=');
      if (idx <= 0) return null;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1);
      if (!name) return null;
      return {name, value};
    })
    .filter(Boolean);
}

function cookieParamFromExported(cookie) {
  const out = {
    name: String(cookie.name || ''),
    value: String(cookie.value || ''),
    path: cookie.path || '/',
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  if (cookie.domain) out.domain = String(cookie.domain);
  else out.url = ORIGIN_URL;
  if (Number(cookie.expires) > 0) out.expires = Number(cookie.expires);
  if (cookie.sameSite && ['Strict', 'Lax', 'None'].includes(cookie.sameSite)) out.sameSite = cookie.sameSite;
  return out;
}

function cookieParamFromHeader(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    url: ORIGIN_URL,
    path: '/',
    secure: true,
  };
}

async function navigate(send, url, waitMs = 2500) {
  await send('Page.navigate', {url});
  await sleep(waitMs);
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

async function orderProbe(send, date) {
  return await evaluate(send, `(async () => {
    try {
      const res = await fetch('/gsp/orderPlus/listOrder', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json;Charset=utf-8',
          'Origin-Path': '/order-management/list',
          'Origin-Url': location.origin + '/#/gsp/order-management/list'
        },
        body: JSON.stringify({
          allocateTimeStart: '${date} 00:00:00',
          allocateTimeEnd: '${date} 23:59:59',
          excludeOrderType: 5,
          tabIndex: 1,
          page: 1,
          perPage: 5
        })
      });
      const json = await res.json();
      return {code: String(json.code), msg: String(json.msg || ''), count: json.info?.meta?.count ?? null, href: location.href};
    } catch (err) {
      return {error: String(err), href: location.href};
    }
  })()`);
}

async function bootstrapStore(store, args) {
  const browserSessionFile = path.join(args.browserSessionDir, `${store.storeKey}.local.json`);
  const webApiSessionFile = path.join(args.sessionDir, `${store.storeKey}.local.json`);
  const browserSession = fssync.existsSync(browserSessionFile) ? await readJson(browserSessionFile) : null;
  const webApiSession = fssync.existsSync(webApiSessionFile) ? await readJson(webApiSessionFile) : null;
  const candidates = [];
  if (browserSession) candidates.push({session: browserSession, sessionKind: 'browser', storageSession: browserSession});
  // WebAPI cookies are usually fresher for GSP/order, while the exported browser
  // session carries subsystem localStorage (SBN/SPMP/etc). Combine them so a
  // fresh WebAPI cookie bootstrap does not accidentally wipe the SBN login state
  // and make link/business sync fall back to the login page every day.
  if (webApiSession) candidates.push({session: webApiSession, sessionKind: 'webapi', storageSession: browserSession});
  if (!candidates.length) {
    return {storeKey: store.storeKey, ok: false, stage: 'session', error: `missing session file for ${store.storeKey}`};
  }
  const browser = await launchStore(store, args);
  if (browser.error) {
    return {storeKey: store.storeKey, ok: false, stage: 'browser', browser};
  }
  const {send, ws} = await connectCdp(store.port);
  try {
    let lastResult = null;
    for (const candidate of candidates) {
      const {session, sessionKind, storageSession} = candidate;
      const cookieParams = Array.isArray(session.cookies)
        ? session.cookies.filter(c => c?.name && c?.value !== undefined).map(cookieParamFromExported)
        : parseCookieHeader(session.cookieHeader).map(cookieParamFromHeader);
      if (!cookieParams.length) {
        lastResult = {storeKey: store.storeKey, ok: false, stage: 'session', sessionKind, error: 'session has no usable cookies'};
        continue;
      }
    if (session.userAgent) {
      await send('Network.setUserAgentOverride', {
        userAgent: session.userAgent,
        acceptLanguage: session.acceptLanguage || 'zh-CN,zh',
        platform: 'Windows',
      }).catch(() => null);
    }
    await send('Network.setCookies', {
      cookies: cookieParams,
    });
    if (storageSession && (storageSession.localStorage || storageSession.sessionStorage)) {
      await navigate(send, ORIGIN_URL, 1200);
      await evaluate(send, `(() => {
        const localEntries = ${JSON.stringify(storageSession.localStorage || {})};
        const sessionEntries = ${JSON.stringify(storageSession.sessionStorage || {})};
        for (const [k, v] of Object.entries(localEntries)) localStorage.setItem(k, String(v));
        for (const [k, v] of Object.entries(sessionEntries)) sessionStorage.setItem(k, String(v));
        return {local: Object.keys(localEntries).length, session: Object.keys(sessionEntries).length};
      })()`);
    }
    await navigate(send, HOME_URL, 2500);
    await navigate(send, ORDER_URL, 2500);
    const probe = args.probe ? await orderProbe(send, args.date) : null;
    const ok = !probe || probe.code === '0';
      const result = {
      storeKey: store.storeKey,
      ok,
      stage: ok ? 'ready' : 'probe',
      browser,
      sessionKind,
      cookieCount: cookieParams.length,
      localStorageCount: storageSession ? Object.keys(storageSession.localStorage || {}).length : 0,
      probe: probe ? {code: probe.code || '', msg: probe.msg || '', count: probe.count ?? null, hasError: Boolean(probe.error)} : null,
    };
      if (ok) return result;
      lastResult = result;
    }
    return lastResult || {storeKey: store.storeKey, ok: false, stage: 'session', error: 'no usable session candidate'};
  } finally {
    try { ws.close(); } catch {}
  }
}

const args = parseArgs(process.argv.slice(2));
const storesConfig = await readJson(STORES_PATH);
const stores = selectStores(storesConfig, args);
const results = [];
for (const store of stores) {
  try {
    const result = await bootstrapStore(store, args);
    results.push(result);
    console.log(`[${store.storeKey}] ${result.ok ? 'ready' : 'failed'} ${JSON.stringify({stage: result.stage, sessionKind: result.sessionKind || '', cookieCount: result.cookieCount || 0, localStorageCount: result.localStorageCount || 0, probe: result.probe || null})}`);
  } catch (err) {
    results.push({storeKey: store.storeKey, ok: false, error: String(err?.stack || err)});
    console.error(`[${store.storeKey}] ERROR ${err?.message || err}`);
  }
}
const summary = {
  ok: results.every(r => r.ok),
  date: args.date,
  stores: results.map(r => ({storeKey: r.storeKey, ok: r.ok, stage: r.stage || '', sessionKind: r.sessionKind || '', probe: r.probe || null, cookieCount: r.cookieCount || 0, localStorageCount: r.localStorageCount || 0})),
};
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
