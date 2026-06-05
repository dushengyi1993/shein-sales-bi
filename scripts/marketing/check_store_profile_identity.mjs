#!/usr/bin/env node
/**
 * Read-only SHEIN profile identity audit.
 *
 * It opens/connects each configured store Chrome profile, reads the seller
 * center page header, extracts the actual "半托管店铺" name, and compares it
 * with config/stores.json. No marketing submission/cancel/budget API is called.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {extractShopNameFromText, validateStoreIdentity} from '../../lib/shein_store_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIST_URL = 'https://sso.geiwohuo.com/#/mbrs/marketing/list';
const OUT_DIR = path.join(ROOT, 'tmp', 'marketing-signup', 'profile-identity');
const storesConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const accountTruth = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'store_account_truth.json'), 'utf8'));
const STORES = storesConfig.stores || [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function splitStores(value) {
  return String(value || '').split(',').map(x => x.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const out = {stores: [], noLaunch: false, noClose: false};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stores') out.stores.push(...splitStores(argv[++i]));
    else if (a === '--no-launch') out.noLaunch = true;
    else if (a === '--no-close' || a === '--keep-open') out.noClose = true;
    else if (!a.startsWith('--')) out.stores.push(...splitStores(a));
  }
  out.stores = [...new Set(out.stores.map(s => s.toUpperCase()))];
  if (!out.stores.length) {
    out.stores = STORES.filter(s => s.enabled !== false).map(s => String(s.storeKey).toUpperCase());
  }
  return out;
}

function psSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function closeExistingStoreChrome(store) {
  if (process.platform !== 'win32') return;
  const profileNeedle = `persistent-${store.profileKey}-profile`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$needle = ${psSingleQuote(profileNeedle)}`,
    "$procs = Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$needle*\" }",
    'foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join('\n');
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {cwd: ROOT, stdio: 'ignore', timeout: 20_000});
}

function launchVisible(store) {
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'launch_store_browser.mjs'),
    store.storeKey,
    '--visible',
    '--url',
    LIST_URL,
  ], {cwd: ROOT, encoding: 'utf8', timeout: 20_000});
  if (r.status !== 0) throw new Error(`launch visible failed for ${store.storeKey}: ${r.stderr || r.stdout}`);
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, {signal: AbortSignal.timeout(8000), ...opts});
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return await res.json();
}

async function isCdpOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(2500)});
    return res.ok;
  } catch {
    return false;
  }
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once: true});
      this.ws.addEventListener('error', reject, {once: true});
    });
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const item = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(item.timer);
        msg.error ? item.reject(new Error(JSON.stringify(msg.error))) : item.resolve(msg.result);
      }
    });
    await this.call('Runtime.enable');
  }
  call(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60_000);
      this.pending.set(id, {resolve, reject, timer});
    });
  }
  async eval(body, arg = undefined) {
    const encoded = arg === undefined ? 'undefined' : JSON.stringify(arg).replace(/</g, '\\u003c');
    const expression = `(async () => { const __arg = ${encoded}; ${body} })()`;
    const res = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails);
      throw new Error(desc);
    }
    return res.result?.value;
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function connectStorePage(store) {
  const targets = await httpJson(`http://127.0.0.1:${store.port}/json/list`);
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('sso.geiwohuo.com'))
    || targets.find(t => t.type === 'page');
  if (!page) throw new Error(`port ${store.port} no page target`);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

async function readPage(cdp) {
  return await cdp.eval(`
    function add(set, value) {
      if (value === null || value === undefined || value === '') return;
      set.add(String(value).trim());
    }
    function collectFromObject(obj, out, source) {
      if (!obj || typeof obj !== 'object') return;
      add(out.rawSources, source);
      add(out.userNames, obj.userName || obj.username || obj.name || obj.enName);
      add(out.mainUserNames, obj.mainUserName);
      add(out.supplierUserNames, obj.supplierUserName);
      add(out.supplierIds, obj.supplierId || obj.supplier_id);
      add(out.externalIds, obj.externalId);
      add(out.emplids, obj.emplid);
      add(out.companyNames, obj.company_name || obj.commonData?.company_name);
      for (const v of [obj.userName, obj.username, obj.name, obj.enName, obj.mainUserName, obj.supplierUserName]) {
        if (/^GS\\d+$/i.test(String(v || '').trim())) add(out.accountNos, String(v).trim().toUpperCase());
      }
      if (obj.commonData && typeof obj.commonData === 'object') collectFromObject(obj.commonData, out, source + '.commonData');
    }
    function parseMaybeJson(value) {
      if (!value || typeof value !== 'string') return null;
      try { return JSON.parse(value); } catch { return null; }
    }
    const out = {
      accountNos: new Set(),
      userNames: new Set(),
      mainUserNames: new Set(),
      supplierUserNames: new Set(),
      supplierIds: new Set(),
      externalIds: new Set(),
      emplids: new Set(),
      companyNames: new Set(),
      rawSources: new Set(),
    };
    for (const storageName of ['localStorage', 'sessionStorage']) {
      const storage = window[storageName];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (!/(userInfo|userinfo|auth_login|page-spy|MBRS_USER_INFO|login_info)/i.test(key || '')) continue;
        const parsed = parseMaybeJson(storage.getItem(key));
        collectFromObject(parsed, out, storageName + ':' + key);
      }
    }
    const text = document.body?.innerText || '';
    return {
      href: location.href,
      title: document.title,
      isLogin: location.href.includes('/login/') || (text.includes('账号登录') && text.includes('密码') && text.includes('登录')),
      textHead: text.slice(0, 2200),
      textTail: text.slice(-1200),
      storageIdentity: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]])),
    };
  `);
}

async function clickLoginOnce(cdp) {
  return await cdp.eval(`
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = el => (el?.innerText || el?.textContent || '').trim();
    const buttons = [...document.querySelectorAll('button,[role=button],a')]
      .filter(visible)
      .map(el => ({el, text: textOf(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'}));
    const target = buttons.find(x => !x.disabled && x.text === '我已知晓，继续登录')
      || buttons.find(x => !x.disabled && x.text.includes('继续登录') && x.text.length <= 20)
      || buttons.find(x => !x.disabled && x.text === '登录')
      || buttons.find(x => !x.disabled && x.text.includes('登录') && x.text.length <= 12);
    if (!target) return {clicked: false, buttons: buttons.map(x => x.text).filter(Boolean).slice(0, 20)};
    target.el.scrollIntoView({block: 'center', inline: 'center'});
    target.el.click();
    return {clicked: true, text: target.text};
  `);
}

async function auditStore(store, args) {
  const result = {
    storeKey: store.storeKey,
    profileKey: store.profileKey,
    port: store.port,
    expectedShopName: store.shopName || '',
    ok: false,
    launched: false,
  };
  let cdp = null;
  try {
    if (!args.noLaunch && !(await isCdpOpen(store.port))) {
      launchVisible(store);
      result.launched = true;
      await sleep(6500);
    }
    cdp = await connectStorePage(store);
    await cdp.eval(`location.href = __arg.url; return {href: location.href};`, {url: LIST_URL});
    await sleep(2500);
    let page = await readPage(cdp);
    result.beforeLogin = {href: page.href, title: page.title, isLogin: page.isLogin};
    if (page.isLogin) {
      result.loginClick = await clickLoginOnce(cdp);
      await sleep(4500);
      page = await readPage(cdp);
    }
    const textForIdentity = `${page.textHead || ''}\n${page.textTail || ''}`;
    const check = validateStoreIdentity({
      store,
      truth: accountTruth.stores?.[store.storeKey],
      text: textForIdentity,
      storageIdentity: page.storageIdentity,
      href: page.href,
      context: 'profile_identity_audit',
      requireActual: true,
    });
    result.href = page.href;
    result.title = page.title;
    result.isLogin = page.isLogin;
    result.actualShopName = extractShopNameFromText(textForIdentity);
    result.storageIdentity = page.storageIdentity;
    result.identity = check;
    result.ok = check.ok && !page.isLogin;
    result.reason = page.isLogin ? 'login_required' : (check.ok ? 'matched' : check.reason);
    return result;
  } catch (error) {
    result.reason = error.message;
    result.stack = error.stack;
    return result;
  } finally {
    cdp?.close();
    if (result.launched && !args.noClose) closeExistingStoreChrome(store);
  }
}

await fs.mkdir(OUT_DIR, {recursive: true});
const args = parseArgs(process.argv.slice(2));
const selected = args.stores.map(key => {
  const store = STORES.find(s => String(s.storeKey).toUpperCase() === key);
  if (!store) throw new Error(`Unknown store ${key}`);
  return store;
});
const rows = [];
for (const store of selected) {
  console.log(`[${store.storeKey}] profile=${store.profileKey} expected=${store.shopName || '-'}`);
  const row = await auditStore(store, args);
  rows.push(row);
  console.log(`[${store.storeKey}] ${row.ok ? 'OK' : 'FAIL'} actual=${row.actualShopName || '-'} reason=${row.reason || ''}`);
}
const summary = {
  createdAt: new Date().toISOString(),
  rows,
  okCount: rows.filter(r => r.ok).length,
  failCount: rows.filter(r => !r.ok).length,
  failedStores: rows.filter(r => !r.ok).map(r => r.storeKey),
};
const out = path.join(OUT_DIR, `profile-identity-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(out, JSON.stringify(summary, null, 2), 'utf8');
console.log(`\nJSON ${out}`);
console.log(`OK ${summary.okCount}`);
console.log(`FAIL ${summary.failCount}`);
if (summary.failCount) process.exitCode = 2;
