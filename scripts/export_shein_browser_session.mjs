#!/usr/bin/env node
/**
 * Export logged-in SHEIN browser state from an existing Chrome profile.
 *
 * The output is a sensitive local runtime file under state/ and must not be
 * committed. The console output is secret-safe and only prints counts.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {connectCdp} from '../lib/shein_browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const OUT_DIR = path.join(ROOT, 'state', 'shein_browser_sessions');
const WEBAPI_OUT_DIR = path.join(ROOT, 'state', 'shein_webapi_sessions');
const ORDER_URL = 'https://sso.geiwohuo.com/#/gsp/order-management/list';
const GSP_ORIGIN = 'https://sso.geiwohuo.com';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {
    stores: null,
    group: 'ALL',
    outDir: OUT_DIR,
    webApiOutDir: WEBAPI_OUT_DIR,
    launch: true,
    headless: true,
    waitMs: 2500,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store') args.stores = [argv[++i].trim().toUpperCase()];
    else if (a === '--stores') args.stores = argv[++i].split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (a === '--group') args.group = argv[++i].trim().toUpperCase();
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--webapi-out-dir') args.webApiOutDir = path.resolve(argv[++i]);
    else if (a === '--no-launch') args.launch = false;
    else if (a === '--visible') args.headless = false;
    else if (a === '--headless') args.headless = true;
    else if (a === '--wait-ms') args.waitMs = Math.max(0, Number(argv[++i] || args.waitMs));
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
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await isCdpOpen(store.port)) return {launched: true, alreadyOpen: false};
  }
  return {launched: true, alreadyOpen: false, error: `CDP port ${store.port} did not open after launch`};
}


async function navigate(send, url, waitMs) {
  await send('Page.navigate', {url});
  await sleep(waitMs);
}

async function exportStorage(send) {
  const keyResult = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(() => ({
      localStorage: Array.from({length: localStorage.length}, (_, i) => localStorage.key(i)),
      sessionStorage: Array.from({length: sessionStorage.length}, (_, i) => sessionStorage.key(i))
    }))()`,
  });
  if (keyResult.exceptionDetails) throw new Error(JSON.stringify(keyResult.exceptionDetails));
  const keySets = keyResult.result.value || {localStorage: [], sessionStorage: []};
  const readArea = async (areaName, keys) => {
    const out = {};
    for (let offset = 0; offset < keys.length; offset += 8) {
      const chunk = keys.slice(offset, offset + 8);
      const result = await send('Runtime.evaluate', {
        awaitPromise: true,
        returnByValue: true,
        expression: `(() => {
          const area = ${areaName};
          const keys = ${JSON.stringify(chunk)};
          return Object.fromEntries(keys.map(key => [key, area.getItem(key)]));
        })()`,
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      Object.assign(out, result.result.value || {});
    }
    return out;
  };
  return {
    localStorage: await readArea('localStorage', keySets.localStorage || []),
    sessionStorage: await readArea('sessionStorage', keySets.sessionStorage || []),
  };
}

function normalizeCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    expires: cookie.expires,
    size: cookie.size,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    session: cookie.session,
    sameSite: cookie.sameSite,
    priority: cookie.priority,
    sameParty: cookie.sameParty,
    sourceScheme: cookie.sourceScheme,
    sourcePort: cookie.sourcePort,
  };
}

function cookieHeaderFromCookies(cookies) {
  return cookies
    .filter(cookie => cookie?.name && cookie?.value !== undefined)
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function formatSecChUa(brands) {
  if (!Array.isArray(brands) || !brands.length) return '';
  return brands
    .filter(brand => brand?.brand && brand?.version)
    .map(brand => `"${String(brand.brand).replace(/"/g, '\\"')}";v="${String(brand.version).replace(/"/g, '')}"`)
    .join(', ');
}

function shanghaiDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

async function validateWebApiSession(session) {
  const date = shanghaiDate();
  const response = await fetch(`${GSP_ORIGIN}/gsp/orderPlus/listOrder`, {
    method: 'POST',
    credentials: 'omit',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'User-Agent': session.userAgent || 'Mozilla/5.0',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': session.acceptLanguage || 'zh-CN,zh;q=0.9,en;q=0.8',
      'Content-Type': 'application/json;charset=UTF-8',
      'Origin': GSP_ORIGIN,
      'Referer': `${GSP_ORIGIN}/`,
      'Cookie': session.cookieHeader,
      'Origin-Path': '/order-management/list',
      'Origin-Url': `${GSP_ORIGIN}/#/gsp/order-management/list`,
      'build-version': '2026-04-23 11:38',
      ...(session.clientHints?.secChUa ? {'sec-ch-ua': session.clientHints.secChUa} : {}),
      ...(session.clientHints?.secChUaMobile ? {'sec-ch-ua-mobile': session.clientHints.secChUaMobile} : {}),
      ...(session.clientHints?.secChUaPlatform ? {'sec-ch-ua-platform': session.clientHints.secChUaPlatform} : {}),
    },
    body: JSON.stringify({
      allocateTimeStart: `${date} 00:00:00`,
      allocateTimeEnd: `${date} 23:59:59`,
      excludeOrderType: 5,
      tabIndex: 1,
      page: 1,
      perPage: 1,
    }),
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  const code = String(body?.code ?? '');
  if (!body || code !== '0') {
    throw new Error(`exported_webapi_session_probe_failed:http=${response.status}:code=${code || 'non_json'}`);
  }
  return {ok: true, code, count: Number(body?.info?.meta?.count || 0)};
}

async function writeJsonAtomic(file, payload) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(payload, null, 2), {encoding: 'utf8', mode: 0o600});
  await fs.rename(temp, file);
}

async function exportStore(store, args) {
  const browser = await launchStore(store, args);
  if (browser.error) return {storeKey: store.storeKey, ok: false, stage: 'browser', browser};
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let connection = null;
    let stage = 'connect';
    try {
      connection = await connectCdp(store.port, {targetTimeoutMs: 4000});
      const {send} = connection;
      stage = 'network-enable';
      await send('Network.enable');
      stage = 'navigate';
      await navigate(send, ORDER_URL, args.waitMs);
      stage = 'cookies';
      const cookies = (await send('Network.getAllCookies')).cookies
        .filter(c => /(^|\.)geiwohuo\.com$/i.test(String(c.domain || '').replace(/^\./, '')))
        .map(normalizeCookie);
      stage = 'storage';
      const storage = await exportStorage(send);
      stage = 'browser-info';
      const browserInfo = await send('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => ({
          userAgent: navigator.userAgent,
          language: navigator.language || '',
          languages: Array.from(navigator.languages || []),
          platform: navigator.userAgentData?.platform || navigator.platform || '',
          mobile: Boolean(navigator.userAgentData?.mobile),
          brands: navigator.userAgentData?.brands || []
        }))()`,
      });
      const hints = browserInfo.result?.value || {};
      const exportedAt = new Date().toISOString();
      const payload = {
        version: 1,
        storeKey: store.storeKey,
        shopName: store.shopName,
        exportedAt,
        pageUrl: ORDER_URL,
        userAgent: hints.userAgent || '',
        cookieCount: cookies.length,
        localStorageCount: Object.keys(storage.localStorage || {}).length,
        sessionStorageCount: Object.keys(storage.sessionStorage || {}).length,
        cookies,
        localStorage: storage.localStorage || {},
        sessionStorage: storage.sessionStorage || {},
      };
      const webApiPayload = {
        version: 1,
        storeKey: store.storeKey,
        shopName: store.shopName,
        source: 'export_shein_browser_session.cdp',
        exportedAt,
        pageUrl: ORDER_URL,
        cookieCount: cookies.length,
        cookieHeader: cookieHeaderFromCookies(cookies),
        userAgent: hints.userAgent || '',
        acceptLanguage: Array.isArray(hints.languages) && hints.languages.length
          ? hints.languages.join(',')
          : (hints.language || 'zh-CN,zh;q=0.9,en;q=0.8'),
        clientHints: {
          secChUa: formatSecChUa(hints.brands),
          secChUaMobile: hints.mobile ? '?1' : '?0',
          secChUaPlatform: hints.platform ? `"${String(hints.platform).replace(/"/g, '')}"` : '',
        },
      };
      if (!webApiPayload.cookieHeader) throw new Error('exported_webapi_session_has_no_geiwohuo_cookies');
      stage = 'webapi-probe';
      const webApiProbe = await validateWebApiSession(webApiPayload);
      stage = 'write-session';
      const file = path.join(args.outDir, `${store.storeKey}.local.json`);
      const webApiFile = path.join(args.webApiOutDir, `${store.storeKey}.local.json`);
      await writeJsonAtomic(file, payload);
      await writeJsonAtomic(webApiFile, webApiPayload);
      return {
        storeKey: store.storeKey,
        ok: true,
        file,
        webApiFile,
        webApiProbe,
        cookieCount: payload.cookieCount,
        localStorageCount: payload.localStorageCount,
        sessionStorageCount: payload.sessionStorageCount,
        cdpAttempts: attempt,
      };
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      const retryable = /CDP websocket|CDP target list|No Chrome page target|not open on port|open timed out/i.test(message);
      if (retryable) console.error(`[${store.storeKey}] CDP retry ${attempt}/5 stage=${stage} error=${message}`);
      if (!retryable || attempt >= 5) throw error;
      await sleep(attempt * 750);
    } finally {
      connection?.close();
    }
  }
  throw lastError || new Error(`CDP export failed on port ${store.port}`);
}

const args = parseArgs(process.argv.slice(2));
const storesConfig = await readJson(STORES_PATH);
const stores = selectStores(storesConfig, args);
const results = [];
for (const store of stores) {
  try {
    const result = await exportStore(store, args);
    results.push(result);
    console.log(`[${store.storeKey}] ${result.ok ? 'exported' : 'failed'} ${JSON.stringify({cookieCount: result.cookieCount || 0, localStorageCount: result.localStorageCount || 0, sessionStorageCount: result.sessionStorageCount || 0})}`);
  } catch (err) {
    results.push({storeKey: store.storeKey, ok: false, error: String(err?.stack || err)});
    console.error(`[${store.storeKey}] ERROR ${err?.message || err}`);
  }
}
const summary = {
  ok: results.every(r => r.ok),
  stores: results.map(r => ({
    storeKey: r.storeKey,
    ok: r.ok,
    cookieCount: r.cookieCount || 0,
    localStorageCount: r.localStorageCount || 0,
    sessionStorageCount: r.sessionStorageCount || 0,
    file: r.file ? path.relative(ROOT, r.file).replace(/\\/g, '/') : '',
    webApiFile: r.webApiFile ? path.relative(ROOT, r.webApiFile).replace(/\\/g, '/') : '',
    webApiProbe: r.webApiProbe || null,
  })),
};
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
