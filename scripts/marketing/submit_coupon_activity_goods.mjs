#!/usr/bin/env node
/**
 * Submit eligible goods for SHEIN platform coupon activity 34810.
 *
 * Important project invariant:
 * Coupon activity 34810 is a multi-level coupon activity. It must not be
 * submitted through the ordinary sign-up config page. The verified route is:
 *   coupon detail -> continue signup -> coupon rule signup/{levelRuleId}
 * This script submits the fixed 15% coupon tier from an audited target plan
 * intersected with the 15% rule's available goods list, then verifies against
 * the same rule's enrolled goods list. The verified write path is the
 * multi-level `partake` API with both `partake_rule_id` and `coupon_level_id`;
 * the Excel import success modal is only an async import acknowledgement and
 * is not treated as enrollment proof. Submitting every 15% available SKC is
 * intentionally blocked unless explicitly overridden.
 * By default, target SKCs that currently have active/future limited-discount
 * activity are also excluded so historical low-price discounts are not silently
 * stacked with a newly submitted 15% coupon.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ACTIVITY_ID_DEFAULT = 34810;
const COUPON_DETAIL_URL = id => `https://sso.geiwohuo.com/#/mbrs/marketing/coupon/detail/${id}`;
const OUT_DIR = path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-submit-results');
const TEMPLATE_XLSX = path.join(ROOT, 'scripts', 'marketing', 'templates', 'coupon-import-15pct-template.xlsx');
const PY_HELPER = path.join(ROOT, 'scripts', 'marketing', 'build_coupon_import_from_skc_list.py');
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const STORES = STORES_CONFIG.stores || [];
const COUPON_LEVEL_RULES = await readJsonIfExists(path.join(ROOT, 'config', 'marketing_coupon_level_rules.json'), {activities: {}});
const ACTIVE_OR_FUTURE_LIMITED_STATES = new Set(['2', '3']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const out = {
    stores: [],
    activityId: ACTIVITY_ID_DEFAULT,
    discountMax: 15,
    dryRun: false,
    noClose: false,
    noLaunch: false,
    waitMs: 60_000,
    pageSize: 200,
    targetPlan: null,
    allowAll15PctAvailable: false,
    allowLimitedDiscountOverlap: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stores') out.stores.push(...splitStores(argv[++i]));
    else if (a === '--activity-id') out.activityId = Number(argv[++i]);
    else if (a === '--discount-max') out.discountMax = Number(argv[++i]);
    else if (a === '--target-plan') out.targetPlan = argv[++i];
    else if (a === '--allow-all-15pct-available') out.allowAll15PctAvailable = true;
    else if (a === '--allow-limited-discount-overlap') out.allowLimitedDiscountOverlap = true;
    else if (a === '--dry-run' || a === '--no-submit') out.dryRun = true;
    else if (a === '--no-close' || a === '--keep-open') out.noClose = true;
    else if (a === '--no-launch') out.noLaunch = true;
    else if (a === '--wait-ms') out.waitMs = Number(argv[++i]);
    else if (a === '--page-size') out.pageSize = Number(argv[++i]);
    else if (!a.startsWith('--')) out.stores.push(...splitStores(a));
  }
  out.stores = [...new Set(out.stores.map(s => s.toUpperCase()))];
  if (!out.stores.length) throw new Error('Missing stores, e.g. --stores LQ or DL,DX,FY');
  if (!Number.isFinite(out.activityId) || out.activityId <= 0) throw new Error(`Invalid --activity-id ${out.activityId}`);
  if (out.activityId !== ACTIVITY_ID_DEFAULT) throw new Error('This script is currently only verified for activity 34810');
  if (out.discountMax !== 15) throw new Error('Only the fixed 15% coupon tier is allowed for activity 34810 in this workflow');
  if (!out.targetPlan && !out.allowAll15PctAvailable) {
    throw new Error('Coupon signup now requires --target-plan so paired coupon SKCs stay aligned with the ordinary marketing signup plan. Use --allow-all-15pct-available only for an explicitly audited all-SKC coupon campaign.');
  }
  if (!Number.isFinite(out.waitMs) || out.waitMs < 10_000) out.waitMs = 60_000;
  if (!Number.isFinite(out.pageSize) || out.pageSize < 20) out.pageSize = 200;
  return out;
}

function splitStores(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

async function readJsonIfExists(file, fallback) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
}

function configuredCouponLevelRuleId(storeKey, activityId) {
  const activityRules = COUPON_LEVEL_RULES?.activities?.[String(activityId)] || {};
  const storeRules = activityRules?.stores?.[String(storeKey || '').toUpperCase()] || {};
  const id = Number(storeRules.levelRuleId || 0);
  return Number.isFinite(id) && id > 0 ? id : 0;
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

function launchVisible(store, url) {
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'launch_store_browser.mjs'),
    store.storeKey,
    '--visible',
    '--url',
    url,
  ], {cwd: ROOT, encoding: 'utf8', timeout: 20_000});
  if (r.status !== 0) throw new Error(`launch visible failed for ${store.storeKey}: ${r.stderr || r.stdout}`);
}

function bringStoreWindowToFront(store) {
  if (process.platform !== 'win32') return;
  const profileNeedle = `persistent-${store.profileKey}-profile`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class Win32BringToFrontCouponSubmit {',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '}',
    '"@',
    `$needle = ${psSingleQuote(profileNeedle)}`,
    "$rootIds = @(Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$needle*\" } | Select-Object -ExpandProperty ProcessId)",
    "$wins = @(Get-Process chrome | Where-Object { $_.MainWindowHandle -ne 0 -and ($rootIds -contains $_.Id) })",
    "if (-not $wins -or $wins.Count -eq 0) { $wins = @(Get-Process chrome | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*SHEIN*' }) }",
    '$p = $wins | Select-Object -First 1',
    'if ($p) { [Win32BringToFrontCouponSubmit]::ShowWindowAsync($p.MainWindowHandle, 3) | Out-Null; Start-Sleep -Milliseconds 200; [Win32BringToFrontCouponSubmit]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }',
  ].join('\n');
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {cwd: ROOT, stdio: 'ignore', timeout: 20_000});
}

async function isCdpOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(2500)});
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBrowser(store, activityId, args) {
  const url = COUPON_DETAIL_URL(activityId);
  if (!args.noLaunch && !args.noClose) {
    closeExistingStoreChrome(store);
    await sleep(1800);
    launchVisible(store, url);
    await sleep(6000);
  } else if (!args.noLaunch && !(await isCdpOpen(store.port))) {
    launchVisible(store, url);
    await sleep(6000);
  }
  bringStoreWindowToFront(store);
  await sleep(800);
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, {signal: AbortSignal.timeout(8000), ...opts});
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return await res.json();
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
  await cdp.call('Runtime.enable');
  await cdp.call('DOM.enable');
  await cdp.call('Page.enable').catch(() => {});
  return cdp;
}

async function snapshot(cdp) {
  return await cdp.eval(`
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const text = document.body?.innerText || '';
    const buttons = [...document.querySelectorAll('button,[role=button]')]
      .filter(visible)
      .map(b => ({text: (b.innerText || b.textContent || '').trim(), disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true'}))
      .filter(x => x.text);
    return {
      href: location.href,
      title: document.title,
      hasLogin: text.includes('账号') && text.includes('密码') && text.includes('登录'),
      hasCouponDetail: location.href.includes('/marketing/coupon/detail/') || text.includes('优惠券活动管理') || text.includes('继续报名'),
      hasRuleSignup: location.href.includes('/marketing/coupon/rule/signup/'),
      buttons: buttons.slice(-60),
      tail: text.slice(-1500),
    };
  `);
}

async function gotoCouponDetail(cdp, activityId) {
  await cdp.eval(`
    location.href = __arg.url;
    return {href: location.href};
  `, {url: COUPON_DETAIL_URL(activityId)});
  const deadline = Date.now() + 35_000;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(800);
    last = await snapshot(cdp).catch(() => null);
    if (last?.hasLogin || last?.hasCouponDetail) return last;
  }
  return last || await snapshot(cdp).catch(err => ({error: err.message}));
}

async function clickContinueAndGetRuleId(cdp, activityId, discountMax, fallbackLevelRuleId = 0) {
  const info = await cdp.eval(`
    if (location.href.includes('/coupon/rule/signup/${activityId}/')) {
      return {found: true, href: location.href, alreadyOnSignup: true};
    }
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = el => (el?.innerText || el?.textContent || '').trim();
    const buttons = [...document.querySelectorAll('button,[role=button]')]
      .filter(visible)
      .map((el, index) => {
        let node = el;
        let ctx = '';
        for (let i = 0; i < 6 && node; i += 1) {
          ctx = textOf(node);
          if (ctx.length > 20 && ctx.length < 2500) break;
          node = node.parentElement;
        }
        return {el, index, text: textOf(el), ctx};
      })
      .filter(x => x.text === '继续报名' || x.text === '报名' || x.text === '去报名');
    if (!buttons.length) return {found: false, href: location.href, text: (document.body.innerText || '').slice(0, 3000)};
    const preferred = buttons.find(x => x.ctx.includes('15') || x.ctx.includes('1%-15') || x.ctx.includes('1%-15%')) || buttons[0];
    preferred.el.scrollIntoView({block: 'center', inline: 'center'});
    preferred.el.click();
    const started = Date.now();
    while (Date.now() - started < 25_000) {
      if (location.href.includes('/coupon/rule/signup/${activityId}/')) break;
      await new Promise(r => setTimeout(r, 500));
    }
    return {found: true, href: location.href, clickedText: preferred.text, clickedContext: preferred.ctx.slice(0, 1000), buttonCount: buttons.length};
  `);
  const m = String(info?.href || '').match(new RegExp(`/coupon/rule/signup/${activityId}/(\\d+)`));
  if (!m && fallbackLevelRuleId) {
    const fallbackInfo = await cdp.eval(`
      location.href = __arg.url;
      const started = Date.now();
      while (Date.now() - started < 10_000) {
        if (location.href.includes('/coupon/rule/signup/' + __arg.activityId + '/' + __arg.levelRuleId)) break;
        await new Promise(r => setTimeout(r, 500));
      }
      return {href: location.href};
    `, {
      activityId,
      levelRuleId: fallbackLevelRuleId,
      url: `https://sso.geiwohuo.com/#/mbrs/marketing/coupon/rule/signup/${activityId}/${fallbackLevelRuleId}?from=detail`,
    });
    const fallbackMatch = String(fallbackInfo?.href || '').match(new RegExp(`/coupon/rule/signup/${activityId}/(\\d+)`));
    if (fallbackMatch) {
      return {
        ...info,
        fallbackFrom: 'config',
        fallbackReason: 'continue signup button did not reach rule route; used configured per-store levelRuleId',
        fallbackHref: fallbackInfo.href,
        levelRuleId: Number(fallbackMatch[1]),
        discountMax,
      };
    }
  }
  if (!m) throw new Error(`continue signup route not reached: ${JSON.stringify(info)}`);
  return {...info, levelRuleId: Number(m[1]), discountMax};
}

async function fetchActivity(cdp, activityId) {
  return await cdp.eval(`
    const headers = {
      'content-type': 'application/json',
      'Origin-Url': location.href,
      'x-bbl-route': location.hash.replace(/^#/, ''),
      'x-req-zone-id': 'Asia/Shanghai',
      'x-lt-language': 'CN',
      'LAN': 'CN',
    };
    const res = await fetch('/mrs-api-prefix/mbrs/activity/get_activity_list?page_num=1&page_size=100', {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify({}),
    });
    const json = await res.json();
    const found = (json?.info?.activity_detail_list || []).find(x => Number(x.activity_id) === Number(__arg.activityId));
    return found ? {
      ok: true,
      activityId: Number(found.activity_id),
      allowGoodsNum: Number(found.allow_goods_num || 0),
      applyGoodsNum: Number(found.apply_goods_num || 0),
      multiLevelCoupon: !!found.multi_level_coupon_activity,
      rawState: found.state,
    } : {ok: false, code: json?.code, msg: json?.msg};
  `, {activityId});
}

async function queryLevelGoodsPage(cdp, activityId, levelRuleId, pageModule, pageNum, pageSize) {
  return await cdp.eval(`
    const headers = {
      'content-type': 'application/json;charset=UTF-8',
      'Origin-Url': location.href,
      'x-bbl-route': location.hash.replace(/^#/, ''),
      'x-req-zone-id': 'Asia/Shanghai',
      'x-lt-language': 'CN',
      'LAN': 'CN',
    };
    const res = await fetch('/mrs-api-prefix/mbrs/activity/multi-level/goods/query?page_num=' + __arg.pageNum + '&page_size=' + __arg.pageSize, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        activity_id: __arg.activityId,
        level_rule_id: __arg.levelRuleId,
        page: 'COUPON',
        page_module: __arg.pageModule,
        product_code_list: [],
        supplier_no_list: [],
      }),
    });
    const json = await res.json();
    const list = json?.info?.partake_goods_list || [];
    return {
      code: json?.code,
      msg: json?.msg,
      total: Number(json?.info?.total ?? list.length ?? 0),
      list: list.map(x => ({
        skc: x.skc,
        supplierNo: x.supplier_no,
        status: x.status || '',
        levelRuleId: x.level_rule_id || 0,
        couponRate: x.coupon_activity_discount_rate || 0,
        enrollTime: x.enroll_time || null,
      })),
    };
  `, {activityId, levelRuleId, pageModule, pageNum, pageSize});
}

async function queryLevelGoodsAll(cdp, activityId, levelRuleId, pageModule, pageSize) {
  const all = [];
  let total = 0;
  let last = null;
  for (let pageNum = 1; pageNum <= 100; pageNum += 1) {
    last = await queryLevelGoodsPage(cdp, activityId, levelRuleId, pageModule, pageNum, pageSize);
    if (last.code !== '0') return {...last, list: all, pageModule};
    total = last.total;
    all.push(...last.list);
    if (!last.list.length || all.length >= total) break;
  }
  const seen = new Set();
  const deduped = [];
  for (const item of all) {
    if (!item.skc || seen.has(item.skc)) continue;
    seen.add(item.skc);
    deduped.push(item);
  }
  return {code: '0', msg: last?.msg || 'OK', total, list: deduped, pageModule};
}

async function queryActiveOrFutureLimitedDiscountSkcs(cdp) {
  return await cdp.eval(`
    const headers = {
      'content-type': 'application/json;charset=UTF-8',
      'Origin-Url': location.href,
      'x-bbl-route': location.hash.replace(/^#/, '') || '/mbrs/marketing/coupon/detail',
      'x-req-zone-id': 'Asia/Shanghai',
      'x-lt-language': 'CN',
      'LAN': 'CN',
    };
    async function post(path, body) {
      const res = await fetch('/mrs-api-prefix' + path, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(body || {}),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {http: res.status, code: json?.code, msg: json?.msg || text.slice(0, 300), info: json?.info ?? json};
    }
    function arrayFrom(value) {
      if (Array.isArray(value)) return value;
      if (Array.isArray(value?.data)) return value.data;
      if (Array.isArray(value?.list)) return value.list;
      if (Array.isArray(value?.records)) return value.records;
      return [];
    }
    const limitedPageSize = 200;
    const listPackets = [];
    const activities = [];
    let listCode = '0';
    let listMsg = 'OK';
    let total = null;
    for (let pageNum = 1; pageNum <= 20; pageNum += 1) {
      const listPacket = await post('/promotion/obm/query_obm_activity_list', {page_num:pageNum, page_size:limitedPageSize, system:'mrs', ref_tools_id:175});
      const list = arrayFrom(listPacket.info);
      const totalFromInfo = Number(listPacket.info?.total ?? listPacket.info?.total_count ?? listPacket.info?.page_info?.total ?? NaN);
      if (Number.isFinite(totalFromInfo)) total = totalFromInfo;
      listPackets.push({pageNum, code: listPacket.code, msg: listPacket.msg, count: list.length, total});
      if (listPacket.code !== '0') {
        listCode = listPacket.code;
        listMsg = listPacket.msg;
        break;
      }
      activities.push(...list);
      if (!list.length || (total !== null && activities.length >= total) || list.length < limitedPageSize) break;
    }
    if (listCode !== '0') {
      return {code: listCode, msg: listMsg, listPackets, activities: [], rows: []};
    }
    const now = Date.now();
    const rows = [];
    for (const activity of activities) {
      const state = String(activity.state ?? '');
      const endMs = activity.end_time ? Date.parse(String(activity.end_time).replace(' ', 'T') + '+08:00') : NaN;
      const activeOrFuture = __arg.activeStates.includes(state) && (!Number.isFinite(endMs) || endMs >= now);
      if (!activeOrFuture) continue;
      const goodsPacket = await post('/promotion/simple_platform/query_activity_goods', {activity_id: activity.activity_id, page_num: 1, page_size: 1000});
      if (goodsPacket.code !== '0') {
        rows.push({activityId: activity.activity_id, activityName: activity.act_name || '', queryCode: goodsPacket.code, queryMsg: goodsPacket.msg, skc: ''});
        continue;
      }
      for (const good of arrayFrom(goodsPacket.info)) {
        const skc = String(good.skc || '').trim();
        if (!skc) continue;
        rows.push({
          skc,
          supplierNo: good.sku_supplier_no || '',
          activityId: activity.activity_id,
          activityName: activity.act_name || '',
          state: activity.state,
          startTime: activity.start_time || '',
          endTime: activity.end_time || '',
          limitedDiscountPrice: Number(good.product_act_price ?? NaN),
        });
      }
    }
    return {code: '0', msg: listMsg || 'OK', listPackets, activities: activities.length, rows};
  `, {activeStates: [...ACTIVE_OR_FUTURE_LIMITED_STATES]});
}

async function queryCouponLevelId(cdp, activityId, levelRuleId) {
  return await cdp.eval(`
    const headers = {
      'content-type': 'application/json;charset=UTF-8',
      'Origin-Url': location.href,
      'x-bbl-route': location.hash.replace(/^#/, ''),
      'x-req-zone-id': 'Asia/Shanghai',
      'x-lt-language': 'CN',
      'LAN': 'CN',
    };
    async function post(path, body) {
      const res = await fetch('/mrs-api-prefix' + path, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(body || {}),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {http: res.status, code: json?.code, msg: json?.msg || text.slice(0, 300), info: json?.info ?? json};
    }
    function firstCouponLevelFromGoods(list) {
      for (const good of list || []) {
        const fromLevel = Number(good?.level?.marketing_activity_id);
        if (Number.isFinite(fromLevel) && fromLevel > 0) return fromLevel;
        for (const site of good?.site_price_list || good?.goods_site_price_info_list || []) {
          for (const sku of site?.skc_price_warning?.sku_info_list || []) {
            for (const coupon of sku?.price_info?.coupon_info_list || []) {
              for (const id of coupon?.activity_id_list || []) {
                const n = Number(id);
                if (Number.isFinite(n) && n > 0) return n;
              }
            }
          }
        }
      }
      return null;
    }
    const modules = [
      'MULTI_LEVEL_ENROLLMENT_RECORD',
      'MULTI_LEVEL_ACTIVITY_ENROLLED_GOODS',
      'MULTI_LEVEL_RULE_GOODS',
      'MULTI_LEVEL_ACTIVITY_NOT_ENROLLED_GOODS',
    ];
    const attempts = [];
    for (const pageModule of modules) {
      const q = await post('/mbrs/activity/multi-level/goods/query?page_num=1&page_size=20', {
        activity_id: __arg.activityId,
        level_rule_id: __arg.levelRuleId,
        page: 'COUPON',
        page_module: pageModule,
        product_code_list: [],
        supplier_no_list: [],
      });
      const list = q.info?.partake_goods_list || [];
      const couponLevelId = firstCouponLevelFromGoods(list);
      attempts.push({pageModule, code: q.code, msg: q.msg, total: Number(q.info?.total ?? list.length ?? 0), couponLevelId});
      if (couponLevelId) {
        return {ok: true, couponLevelId, source: pageModule, attempts};
      }
    }
    return {ok: false, couponLevelId: null, attempts};
  `, {activityId, levelRuleId});
}

async function submitMultiLevelCouponGoods(cdp, activityId, levelRuleId, couponLevelId, skcs) {
  return await cdp.eval(`
    const headers = {
      'content-type': 'application/json;charset=UTF-8',
      'Origin-Url': location.href,
      'x-bbl-route': location.hash.replace(/^#/, ''),
      'x-req-zone-id': 'Asia/Shanghai',
      'x-lt-language': 'CN',
      'LAN': 'CN',
    };
    const payload = {
      activity_id: __arg.activityId,
      partake_rule: {
        partake_rule_id: __arg.levelRuleId,
        coupon_level_id: __arg.couponLevelId,
      },
      skc_info_list: __arg.skcs.map(skc => ({skc})),
    };
    const res = await fetch('/mrs-api-prefix/mbrs/activity/multi-level/partake', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const list = json?.info?.skc_partake_result_list || [];
    const failed = list.filter(x => x?.error_code || x?.error_msg);
    return {
      ok: res.ok && String(json?.code) === '0' && failed.length === 0,
      http: res.status,
      code: json?.code,
      msg: json?.msg || text.slice(0, 300),
      info: json?.info || null,
      request: {
        activityId: __arg.activityId,
        partakeRuleId: __arg.levelRuleId,
        couponLevelId: __arg.couponLevelId,
        skcCount: __arg.skcs.length,
        sample: __arg.skcs.slice(0, 20),
      },
      resultCount: list.length,
      failedCount: failed.length,
      failedSample: failed.slice(0, 20).map(x => ({skc: x.skc, errorCode: x.error_code, errorMsg: x.error_msg, failInfo: x.fail_info || null})),
      rawTextSample: text.slice(0, 1000),
    };
  `, {activityId, levelRuleId, couponLevelId, skcs});
}

async function waitForTargetEnrolled(cdp, activityId, levelRuleId, targetSkcs, waitMs, pageSize) {
  const targetSet = new Set(targetSkcs);
  const deadline = Date.now() + waitMs;
  const polls = [];
  let latest = null;
  while (Date.now() < deadline) {
    latest = await queryLevelGoodsAll(cdp, activityId, levelRuleId, 'MULTI_LEVEL_RULE_ENROLLED_GOODS', pageSize);
    const enrolledSet = new Set(latest.list.map(x => x.skc));
    const remaining = [...targetSet].filter(skc => !enrolledSet.has(skc));
    polls.push({at: new Date().toISOString(), enrolledTotal: latest.total, enrolledList: latest.list.length, remaining: remaining.length});
    if (latest.code === '0' && remaining.length === 0) return {ok: true, enrolled: latest, polls, remaining: []};
    await sleep(2500);
  }
  const enrolledSet = new Set((latest?.list || []).map(x => x.skc));
  return {ok: false, enrolled: latest, polls, remaining: [...targetSet].filter(skc => !enrolledSet.has(skc))};
}

async function loadTargetPlan(targetPlanPath) {
  if (!targetPlanPath) return null;
  const absolute = path.resolve(ROOT, targetPlanPath);
  const seen = new Set();
  const sources = [];
  async function loadItems(file) {
    const resolved = path.resolve(ROOT, file);
    if (seen.has(resolved)) return [];
    seen.add(resolved);
    const json = JSON.parse(await fs.readFile(resolved, 'utf8'));
    sources.push(resolved);
    if (Array.isArray(json?.ordinaryPlanPaths)) {
      const nested = [];
      for (const planPath of json.ordinaryPlanPaths) {
        nested.push(...await loadItems(planPath));
      }
      return nested;
    }
    if (Array.isArray(json)) return json;
    if (Array.isArray(json?.items)) return json.items;
    return [];
  }
  const items = await loadItems(absolute);
  const byStore = new Map();
  for (const item of items) {
    if (!item?.storeKey || !item?.skc || item.selected === false) continue;
    const key = String(item.storeKey).toUpperCase();
    if (!byStore.has(key)) byStore.set(key, new Set());
    byStore.get(key).add(String(item.skc));
  }
  const totalSkcs = [...byStore.values()].reduce((sum, set) => sum + set.size, 0);
  if (!totalSkcs) {
    throw new Error(`target plan has no selected SKCs: ${absolute}`);
  }
  return {path: absolute, sources, byStore};
}

function buildImportFile(storeKey, skcList) {
  if (!fsSync.existsSync(TEMPLATE_XLSX)) throw new Error(`missing coupon import template: ${TEMPLATE_XLSX}`);
  if (!fsSync.existsSync(PY_HELPER)) throw new Error(`missing coupon import helper: ${PY_HELPER}`);
  fsSync.mkdirSync(OUT_DIR, {recursive: true});
  const skcPath = path.join(OUT_DIR, `${storeKey}-34810-skc-list-${Date.now()}.json`);
  const xlsxPath = path.join(OUT_DIR, `${storeKey}-34810-import-15pct-${Date.now()}.xlsx`);
  fsSync.writeFileSync(skcPath, JSON.stringify(skcList, null, 2), 'utf8');
  const r = spawnSync('python', [PY_HELPER, TEMPLATE_XLSX, skcPath, xlsxPath], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(`build coupon import xlsx failed: ${r.stderr || r.stdout}`);
  return {skcPath, xlsxPath, helperOutput: r.stdout};
}

async function uploadAndSubmit(cdp, filePath) {
  const fileName = path.basename(filePath);
  const opened = await cdp.eval(`
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const btn = [...document.querySelectorAll('button,[role=button]')]
      .filter(visible)
      .find(b => (b.innerText || b.textContent || '').trim() === 'Excel批量报名活动');
    if (!btn) return {opened: false, tail: (document.body.innerText || '').slice(-1500)};
    btn.scrollIntoView({block: 'center', inline: 'center'});
    btn.click();
    return {opened: true};
  `);
  if (!opened.opened) throw new Error(`Excel import button not found: ${JSON.stringify(opened)}`);
  await sleep(900);
  const doc = await cdp.call('DOM.getDocument', {depth: -1, pierce: true});
  const fileInput = await cdp.call('DOM.querySelector', {nodeId: doc.root.nodeId, selector: 'input[type=file]'});
  if (!fileInput.nodeId) throw new Error('file input not found');
  await cdp.call('DOM.setFileInputFiles', {nodeId: fileInput.nodeId, files: [filePath]});
  await cdp.eval(`
    const input = document.querySelector('input[type=file]');
    if (!input) return {found: false};
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
    return {found: true, hasFileName: (document.body.innerText || '').includes(__arg.fileName), tail: (document.body.innerText || '').slice(-1000)};
  `, {fileName});
  await sleep(1200);
  const clicked = await cdp.eval(`
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = el => (el?.innerText || el?.textContent || '').trim();
    const buttons = [...document.querySelectorAll('button,[role=button]')]
      .filter(visible)
      .map(el => {
        let node = el;
        let ctx = '';
        for (let i = 0; i < 7 && node; i += 1) {
          ctx = textOf(node);
          if (ctx.includes('批量') || ctx.includes('上传') || ctx.includes(__arg.fileName)) break;
          node = node.parentElement;
        }
        return {el, text: textOf(el), ctx, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'};
      });
    const btn = buttons.find(x => !x.disabled && x.text === '确定' && (x.ctx.includes('批量') || x.ctx.includes('上传') || x.ctx.includes(__arg.fileName)))
      || buttons.find(x => !x.disabled && x.text === '确定');
    if (!btn) return {clicked: false, buttons: buttons.map(x => ({text: x.text, disabled: x.disabled})).slice(-30), tail: (document.body.innerText || '').slice(-1500)};
    btn.el.scrollIntoView({block: 'center', inline: 'center'});
    btn.el.click();
    return {clicked: true, text: btn.text, context: btn.ctx.slice(0, 500)};
  `, {fileName});
  if (!clicked.clicked) throw new Error(`modal confirm not found: ${JSON.stringify(clicked)}`);

  const deadline = Date.now() + 60_000;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(1200);
    last = await cdp.eval(`
      const text = document.body?.innerText || '';
      return {
        href: location.href,
        hasSuccessModal: text.includes('商品提交成功') || text.includes('提交成功'),
        hasProgress: text.includes('查看报名进度'),
        hasError: text.includes('失败') || text.includes('错误') || text.includes('异常'),
        tail: text.slice(-1600),
      };
    `);
    if (last.hasSuccessModal || last.hasProgress) return {ok: true, clicked, final: last};
  }
  throw new Error(`submit did not reach success modal: ${JSON.stringify(last)}`);
}

async function processStore(store, args, targetPlan) {
  const result = {
    store: store.storeKey,
    shopName: store.shopName,
    activityId: args.activityId,
    discountTier: '1-15%',
    startedAt: new Date().toISOString(),
    ok: false,
  };
  let cdp = null;
  try {
    await ensureBrowser(store, args.activityId, args);
    cdp = await connectStorePage(store);
    result.initialPage = await gotoCouponDetail(cdp, args.activityId);
    if (result.initialPage?.hasLogin) {
      result.reason = '营销子系统显示登录页，需人工登录';
      return result;
    }
    result.beforeActivity = await fetchActivity(cdp, args.activityId).catch(err => ({error: err.message}));
    result.rule = await clickContinueAndGetRuleId(
      cdp,
      args.activityId,
      args.discountMax,
      configuredCouponLevelRuleId(store.storeKey, args.activityId),
    );
    result.ruleSnapshot = await snapshot(cdp).catch(err => ({error: err.message}));

    const beforeAvailable = await queryLevelGoodsAll(cdp, args.activityId, result.rule.levelRuleId, 'MULTI_LEVEL_RULE_GOODS', args.pageSize);
    const beforeEnrolled = await queryLevelGoodsAll(cdp, args.activityId, result.rule.levelRuleId, 'MULTI_LEVEL_RULE_ENROLLED_GOODS', args.pageSize);
    result.beforeAvailable = {code: beforeAvailable.code, msg: beforeAvailable.msg, total: beforeAvailable.total, count: beforeAvailable.list.length, sample: beforeAvailable.list.slice(0, 10)};
    result.beforeEnrolled = {code: beforeEnrolled.code, msg: beforeEnrolled.msg, total: beforeEnrolled.total, count: beforeEnrolled.list.length, sample: beforeEnrolled.list.slice(0, 10)};
    if (beforeAvailable.code !== '0') {
      result.reason = `15% 可报集合查询失败: ${beforeAvailable.msg || beforeAvailable.code}`;
      return result;
    }
    if (beforeEnrolled.code !== '0') {
      result.reason = `15% 已报集合查询失败: ${beforeEnrolled.msg || beforeEnrolled.code}`;
      return result;
    }

    const availableSkcs = beforeAvailable.list.map(x => x.skc).filter(Boolean);
    const enrolledSetBefore = new Set(beforeEnrolled.list.map(x => x.skc));
    let targetSkcs = targetPlan ? [] : availableSkcs;
    const targetSetFromPlan = targetPlan?.byStore?.get(store.storeKey.toUpperCase()) || null;
    if (targetSetFromPlan) {
      targetSkcs = availableSkcs.filter(skc => targetSetFromPlan.has(skc));
      result.targetPlan = {path: targetPlan.path, plannedSkcs: targetSetFromPlan.size, matchedAvailable: targetSkcs.length};
    } else {
      result.targetPlan = targetPlan ? {path: targetPlan.path, plannedSkcs: 0, matchedAvailable: 0} : null;
    }
    targetSkcs = [...new Set(targetSkcs)];
    const targetBeforeLimitedGuard = targetSkcs;
    result.limitedDiscountGuard = {
      policy: args.allowLimitedDiscountOverlap ? 'allow-explicit-overlap' : 'exclude-active-or-future-limited-discount',
      checked: false,
      overlapCount: 0,
      excludedCount: 0,
      sample: [],
    };
    if (!args.allowLimitedDiscountOverlap) {
      const limited = await queryActiveOrFutureLimitedDiscountSkcs(cdp);
      result.limitedDiscountGuard.checked = true;
      result.limitedDiscountGuard.query = {code: limited.code, msg: limited.msg, activityCount: limited.activities, rowCount: limited.rows?.length || 0, listPackets: limited.listPackets || []};
      if (limited.code !== '0') {
        result.reason = `限时折扣保护查询失败，停止提交优惠券: ${limited.msg || limited.code}`;
        return result;
      }
      const limitedBySkc = new Map();
      for (const row of limited.rows || []) {
        if (!row.skc || limitedBySkc.has(row.skc)) continue;
        limitedBySkc.set(row.skc, row);
      }
      const overlapRows = targetSkcs
        .filter(skc => limitedBySkc.has(skc))
        .map(skc => limitedBySkc.get(skc));
      const overlapSet = new Set(overlapRows.map(row => row.skc));
      targetSkcs = targetSkcs.filter(skc => !overlapSet.has(skc));
      result.limitedDiscountGuard.overlapCount = overlapRows.length;
      result.limitedDiscountGuard.excludedCount = overlapRows.length;
      result.limitedDiscountGuard.sample = overlapRows.slice(0, 20);
    }
    const toSubmit = targetSkcs.filter(skc => !enrolledSetBefore.has(skc));
    result.target = {
      mode: targetPlan ? 'plan-intersection-15pct-available' : 'explicit-all-15pct-available',
      beforeLimitedDiscountGuard: targetBeforeLimitedGuard.length,
      targetCount: targetSkcs.length,
      excludedByLimitedDiscountGuard: result.limitedDiscountGuard.excludedCount,
      alreadyEnrolled: targetSkcs.length - toSubmit.length,
      toSubmit: toSubmit.length,
      sample: targetSkcs.slice(0, 15),
    };

    if (!targetSkcs.length) {
      result.ok = true;
      result.reason = targetPlan && !targetSetFromPlan
        ? 'target plan has no SKCs for this store; skipped instead of submitting all available goods'
        : result.limitedDiscountGuard.excludedCount > 0
          ? '目标商品均被 active/future 限时折扣保护排除，未提交优惠券'
        : '15% 券档当前没有需要提交的目标商品';
      return result;
    }
    if (args.dryRun) {
      result.ok = true;
      result.dryRun = true;
      result.reason = 'dry-run only';
      return result;
    }
    if (toSubmit.length > 0) {
      result.couponLevel = await queryCouponLevelId(cdp, args.activityId, result.rule.levelRuleId);
      if (!result.couponLevel.ok || !result.couponLevel.couponLevelId) {
        result.reason = `无法定位 15% 券档 coupon_level_id，停止提交: ${JSON.stringify(result.couponLevel.attempts || [])}`;
        return result;
      }
      result.submit = await submitMultiLevelCouponGoods(
        cdp,
        args.activityId,
        result.rule.levelRuleId,
        result.couponLevel.couponLevelId,
        toSubmit,
      );
      if (!result.submit.ok) {
        result.reason = `multi-level 直接报名接口失败: code=${result.submit.code || '-'} msg=${result.submit.msg || '-'} failed=${result.submit.failedCount || 0}`;
        return result;
      }
    } else {
      result.submit = {ok: true, skipped: true, reason: '目标商品已在 15% 券档已报集合中'};
    }

    result.wait = await waitForTargetEnrolled(cdp, args.activityId, result.rule.levelRuleId, targetSkcs, args.waitMs, args.pageSize);
    result.afterEnrolled = result.wait.enrolled ? {code: result.wait.enrolled.code, msg: result.wait.enrolled.msg, total: result.wait.enrolled.total, count: result.wait.enrolled.list.length, sample: result.wait.enrolled.list.slice(0, 10)} : null;
    result.afterActivity = await fetchActivity(cdp, args.activityId).catch(err => ({error: err.message}));
    result.ok = !!result.wait.ok;
    result.reason = result.ok ? '15% 券档目标商品均已进入已报/处理中集合' : `仍有 ${result.wait.remaining.length} 个目标 SKC 未进入已报集合`;
    result.remainingSample = result.wait.remaining.slice(0, 20);
    return result;
  } catch (err) {
    result.reason = err.message;
    result.stack = err.stack;
    return result;
  } finally {
    result.finishedAt = new Date().toISOString();
    cdp?.close();
    if (!args.noClose) closeExistingStoreChrome(store);
  }
}

await fs.mkdir(OUT_DIR, {recursive: true});
const args = parseArgs(process.argv.slice(2));
const targetPlan = await loadTargetPlan(args.targetPlan);
const selectedStores = args.stores.map(key => {
  const store = STORES.find(s => s.storeKey.toUpperCase() === key.toUpperCase());
  if (!store) throw new Error(`Unknown store ${key}`);
  return store;
});

const summary = {
  createdAt: new Date().toISOString(),
  activityId: args.activityId,
  discountTier: '1-15%',
  dryRun: args.dryRun,
  targetMode: targetPlan ? 'plan-intersection-15pct-available' : 'explicit-all-15pct-available',
  stores: [],
};

for (const store of selectedStores) {
  console.log(`\n[${store.storeKey}] 提交优惠券活动 ${args.activityId} 的 15% 券档可报名商品...`);
  const result = await processStore(store, args, targetPlan);
  summary.stores.push(result);
  const before = result.beforeEnrolled ? `${result.beforeEnrolled.count}/${result.beforeAvailable?.count ?? '-'}` : '-';
  const target = result.target ? `${result.target.alreadyEnrolled}+${result.target.toSubmit}/${result.target.targetCount}` : '-';
  const after = result.afterEnrolled ? `${result.afterEnrolled.count}` : '-';
  console.log(`[${store.storeKey}] ${result.ok ? 'OK' : 'FAIL'} beforeEnrolled/available=${before} target=${target} afterEnrolled=${after} ${result.reason || ''}`);
  await fs.writeFile(path.join(OUT_DIR, `${store.storeKey}-${args.activityId}.json`), JSON.stringify(result, null, 2), 'utf8');
}

summary.ok = summary.stores.every(s => s.ok);
summary.totals = summary.stores.reduce((acc, s) => {
  acc.targetCount += s.target?.targetCount || 0;
  acc.excludedByLimitedDiscountGuard += s.target?.excludedByLimitedDiscountGuard || 0;
  acc.toSubmit += s.target?.toSubmit || 0;
  acc.okStores += s.ok ? 1 : 0;
  acc.failedStores += s.ok ? 0 : 1;
  return acc;
}, {targetCount: 0, excludedByLimitedDiscountGuard: 0, toSubmit: 0, okStores: 0, failedStores: 0});
const summaryFile = path.join(OUT_DIR, `summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2), 'utf8');
console.log(`\nSUMMARY ${summaryFile}`);
process.exit(summary.ok ? 0 : 1);
