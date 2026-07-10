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
const ORDER_URL = 'https://sso.geiwohuo.com/#/gsp/order-management/list';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {
    stores: null,
    group: 'ALL',
    outDir: OUT_DIR,
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
  const result = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(() => {
      const dump = area => {
        const out = {};
        for (let i = 0; i < area.length; i++) {
          const key = area.key(i);
          out[key] = area.getItem(key);
        }
        return out;
      };
      return {localStorage: dump(localStorage), sessionStorage: dump(sessionStorage)};
    })()`,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value || {localStorage: {}, sessionStorage: {}};
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

async function exportStore(store, args) {
  const browser = await launchStore(store, args);
  if (browser.error) return {storeKey: store.storeKey, ok: false, stage: 'browser', browser};
  const {send, close} = await connectCdp(store.port, {targetTimeoutMs: 4000});
  await send('Network.enable');
  try {
    await navigate(send, ORDER_URL, args.waitMs);
    const cookies = (await send('Network.getAllCookies')).cookies
      .filter(c => /(^|\.)geiwohuo\.com$/i.test(String(c.domain || '').replace(/^\./, '')))
      .map(normalizeCookie);
    const storage = await exportStorage(send);
    const ua = await send('Runtime.evaluate', {returnByValue: true, expression: 'navigator.userAgent'});
    const payload = {
      version: 1,
      storeKey: store.storeKey,
      shopName: store.shopName,
      exportedAt: new Date().toISOString(),
      pageUrl: ORDER_URL,
      userAgent: ua.result?.value || '',
      cookieCount: cookies.length,
      localStorageCount: Object.keys(storage.localStorage || {}).length,
      sessionStorageCount: Object.keys(storage.sessionStorage || {}).length,
      cookies,
      localStorage: storage.localStorage || {},
      sessionStorage: storage.sessionStorage || {},
    };
    await fs.mkdir(args.outDir, {recursive: true});
    const file = path.join(args.outDir, `${store.storeKey}.local.json`);
    await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
    return {
      storeKey: store.storeKey,
      ok: true,
      file,
      cookieCount: payload.cookieCount,
      localStorageCount: payload.localStorageCount,
      sessionStorageCount: payload.sessionStorageCount,
    };
  } finally {
    close();
  }
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
  })),
};
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
