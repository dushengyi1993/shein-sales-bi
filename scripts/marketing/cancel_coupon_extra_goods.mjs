#!/usr/bin/env node
/**
 * Cancel erroneous extra goods from SHEIN platform coupon activity 34810.
 *
 * Project invariant:
 * Coupon activity 34810 is a multi-level coupon activity. For this campaign,
 * only SKCs that are paired with the ordinary marketing signup plan should
 * remain in the fixed 15% coupon tier. This script cancels only SKCs listed in
 * the audited "extra vs ordinary plan" file, and refuses to cancel anything
 * that appears in the ordinary signup plans.
 *
 * Safety:
 * - Dry-run by default. Real cancellation requires --execute.
 * - Only activity 34810 and 15% tier list are supported.
 * - Uses current 15% enrolled-goods query to resolve the activity goods id.
 * - Verifies active extra SKCs are gone or no longer active after cancellation.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ACTIVITY_ID_DEFAULT = 34810;
const DEFAULT_EXTRA_LIST = path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-submit-results', 'coupon-extra-vs-ordinary-plan-2026-06-03.json');
const OUT_DIR = path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-cancel-results');
const COUPON_GOODS_URL = (activityId, levelRuleId) => `https://sso.geiwohuo.com/#/mbrs/marketing/coupon/rule/goods/${activityId}/${levelRuleId}`;
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const STORES = STORES_CONFIG.stores || [];
const ACTIVE_STATUSES = new Set(['0', '1']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function splitStores(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    stores: [],
    activityId: ACTIVITY_ID_DEFAULT,
    extraList: DEFAULT_EXTRA_LIST,
    execute: false,
    noClose: false,
    noLaunch: false,
    waitMs: 45_000,
    pageSize: 200,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stores') out.stores.push(...splitStores(argv[++i]));
    else if (a === '--activity-id') out.activityId = Number(argv[++i]);
    else if (a === '--extra-list') out.extraList = argv[++i];
    else if (a === '--execute') out.execute = true;
    else if (a === '--dry-run' || a === '--no-execute') out.execute = false;
    else if (a === '--no-close' || a === '--keep-open') out.noClose = true;
    else if (a === '--no-launch') out.noLaunch = true;
    else if (a === '--wait-ms') out.waitMs = Number(argv[++i]);
    else if (a === '--page-size') out.pageSize = Number(argv[++i]);
    else if (!a.startsWith('--')) out.stores.push(...splitStores(a));
  }
  out.stores = [...new Set(out.stores.map(s => s.toUpperCase()))];
  if (!out.stores.length) throw new Error('Missing stores, e.g. --stores TZ or DL,DX,FY');
  if (out.activityId !== ACTIVITY_ID_DEFAULT) throw new Error('This cancel workflow is only verified for coupon activity 34810');
  if (!Number.isFinite(out.waitMs) || out.waitMs < 10_000) out.waitMs = 45_000;
  if (!Number.isFinite(out.pageSize) || out.pageSize < 20) out.pageSize = 200;
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
    'public class Win32BringToFrontCouponCancel {',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '}',
    '"@',
    `$needle = ${psSingleQuote(profileNeedle)}`,
    "$rootIds = @(Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$needle*\" } | Select-Object -ExpandProperty ProcessId)",
    "$wins = @(Get-Process chrome | Where-Object { $_.MainWindowHandle -ne 0 -and ($rootIds -contains $_.Id) })",
    "if (-not $wins -or $wins.Count -eq 0) { $wins = @(Get-Process chrome | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*SHEIN*' }) }",
    '$p = $wins | Select-Object -First 1',
    'if ($p) { [Win32BringToFrontCouponCancel]::ShowWindowAsync($p.MainWindowHandle, 3) | Out-Null; Start-Sleep -Milliseconds 200; [Win32BringToFrontCouponCancel]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }',
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

async function ensureBrowser(store, activityId, levelRuleId, args) {
  const url = COUPON_GOODS_URL(activityId, levelRuleId);
  if (!args.noLaunch && !args.noClose) {
    closeExistingStoreChrome(store);
    await sleep(1800);
    launchVisible(store, url);
    await sleep(6500);
  } else if (!args.noLaunch && !(await isCdpOpen(store.port))) {
    launchVisible(store, url);
    await sleep(6500);
  }
  bringStoreWindowToFront(store);
  await sleep(900);
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
  return cdp;
}

async function gotoCouponRule(cdp, activityId, levelRuleId) {
  const target = COUPON_GOODS_URL(activityId, levelRuleId);
  await cdp.eval(`
    location.href = __arg.target;
    return {href: location.href};
  `, {target});
  const deadline = Date.now() + 35_000;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(800);
    last = await cdp.eval(`
      const text = document.body?.innerText || '';
      return {
        href: location.href,
        title: document.title,
        hasLogin: location.href.includes('/login/') || text.includes('请输入账号') || text.includes('请输入密码'),
        hasRule: location.href.includes('/coupon/rule/goods/') || text.includes('已报名商品') || text.includes('取消报名'),
        tail: text.slice(-1200),
      };
    `);
    if (last.hasLogin || last.hasRule) return last;
  }
  return last;
}

async function clickLoginOnce(cdp) {
  const target = await cdp.eval(`
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textOf = el => (el?.innerText || el?.textContent || '').trim();
    const buttons = [...document.querySelectorAll('button,[role=button],a')]
      .filter(visible)
      .map(el => ({el, text: textOf(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'}));
    const btn = buttons.find(x => !x.disabled && x.text === '登录')
      || buttons.find(x => !x.disabled && x.text.includes('登录') && x.text.length <= 12);
    if (!btn) return {found: false, href: location.href, buttons: buttons.map(x => x.text).filter(Boolean).slice(0, 20), tail: (document.body?.innerText || '').slice(-800)};
    btn.el.scrollIntoView({block: 'center', inline: 'center'});
    const rect = btn.el.getBoundingClientRect();
    return {found: true, href: location.href, text: btn.text, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  `);
  if (!target.found) return {clicked: false, ...target};
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x: target.x, y: target.y, button: 'none'});
  await cdp.call('Input.dispatchMouseEvent', {type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1});
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1});
  return {clicked: true, ...target};
}

async function recoverLoginIfNeeded(cdp, activityId, levelRuleId) {
  const before = await cdp.eval(`
    const text = document.body?.innerText || '';
    return {
      href: location.href,
      isLogin: location.href.includes('/login/') || text.includes('请输入账号') || text.includes('请输入密码') || (text.includes('账号登录') && text.includes('密码') && text.includes('登录')),
      tail: text.slice(-1000),
    };
  `);
  if (!before.isLogin) return {needed: false, before};

  const attempts = [];
  attempts.push(await clickLoginOnce(cdp));
  await sleep(4500);
  let after = await cdp.eval(`
    const text = document.body?.innerText || '';
    return {href: location.href, isLogin: location.href.includes('/login/') || text.includes('请输入账号') || text.includes('请输入密码'), tail: text.slice(-1000)};
  `);
  if (after.isLogin) {
    await cdp.eval(`location.reload(); return {href: location.href};`);
    await sleep(3500);
    attempts.push(await clickLoginOnce(cdp));
    await sleep(6500);
    after = await cdp.eval(`
      const text = document.body?.innerText || '';
      return {href: location.href, isLogin: location.href.includes('/login/') || text.includes('请输入账号') || text.includes('请输入密码'), tail: text.slice(-1000)};
    `);
  }
  const page = await gotoCouponRule(cdp, activityId, levelRuleId);
  return {needed: true, before, attempts, after, page};
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(String(status ?? ''));
}

function normalizeSkc(skc) {
  return String(skc || '').trim();
}

function numericId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function queryLevelGoodsPageRaw(cdp, activityId, levelRuleId, pageModule, pageNum, pageSize) {
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
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const list = json?.info?.partake_goods_list || [];
    return {
      httpStatus: res.status,
      code: json?.code,
      msg: json?.msg,
      total: Number(json?.info?.total ?? list.length ?? 0),
      list: list.map(x => ({
        id: x.id ?? x.partake_good_id ?? x.partake_goods_id ?? x.activity_goods_id ?? x.partake_rule_good_id ?? null,
        idCandidates: {
          id: x.id ?? null,
          partake_good_id: x.partake_good_id ?? null,
          partake_goods_id: x.partake_goods_id ?? null,
          activity_goods_id: x.activity_goods_id ?? null,
          partake_rule_good_id: x.partake_rule_good_id ?? null,
        },
        partakeGoodId: x.partake_good_id ?? null,
        partakeRuleGoodId: x.partake_rule_good_id ?? null,
        partakeLevelRuleId: x.level_rule_id ?? levelRuleId,
        skc: x.skc,
        supplierNo: x.supplier_no,
        status: x.status ?? '',
        levelRuleId: x.level_rule_id || 0,
        couponRate: x.coupon_activity_discount_rate || 0,
        enrollTime: x.enroll_time || null,
        rawKeys: Object.keys(x || {}).sort(),
      })),
      rawTextSample: json ? '' : text.slice(0, 1000),
    };
  `, {activityId, levelRuleId, pageModule, pageNum, pageSize});
}

async function queryLevelGoodsAllRaw(cdp, activityId, levelRuleId, pageModule, pageSize) {
  const all = [];
  let total = 0;
  let last = null;
  for (let pageNum = 1; pageNum <= 100; pageNum += 1) {
    last = await queryLevelGoodsPageRaw(cdp, activityId, levelRuleId, pageModule, pageNum, pageSize);
    if (last.code !== '0') return {...last, list: all, pageModule};
    total = last.total;
    all.push(...last.list);
    if (!last.list.length || all.length >= total) break;
  }
  const seen = new Set();
  const deduped = [];
  for (const item of all) {
    const skc = normalizeSkc(item.skc);
    if (!skc || seen.has(skc)) continue;
    seen.add(skc);
    deduped.push({...item, skc});
  }
  return {code: '0', msg: last?.msg || 'OK', total, list: deduped, pageModule};
}

async function queryPartakeRecordsPage(cdp, activityId, skcList, pageNum, pageSize) {
  return await cdp.eval(`
    const headers = {
      'content-type': 'application/json;charset=UTF-8',
      'Origin-Url': location.href,
      'x-bbl-route': location.hash.replace(/^#/, ''),
      'x-req-zone-id': 'Asia/Shanghai',
      'x-lt-language': 'CN',
      'LAN': 'CN',
    };
    const body = JSON.stringify({
      activity_id_list: [__arg.activityId],
      query_coupon: true,
      skc_list: __arg.skcList,
      audit_status: [0, 1],
    });
    const endpoints = [
      '/mrs-api-prefix/mbrs/activity/get_partake_activity_goods_list',
      '/mrs-api-prefix/mbbs/activity/supplier_query_partaken_goods',
    ];
    const attempts = [];
    for (const base of endpoints) {
      const endpoint = base + '?page_num=' + __arg.pageNum + '&page_size=' + __arg.pageSize;
      const res = await fetch(endpoint, {method: 'POST', credentials: 'include', headers, body});
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      const list = json?.info?.data || [];
      const attempt = {
        endpoint: base,
        httpStatus: res.status,
        code: json?.code,
        msg: json?.msg,
        total: Number(json?.info?.meta?.total ?? json?.info?.total ?? list.length ?? 0),
        list,
        rawTextSample: json ? '' : text.slice(0, 1000),
      };
      attempts.push({...attempt, list: undefined, listCount: list.length});
      if (json?.code === '0' && list.length) {
        return {
          endpoint: base,
          attempts,
          httpStatus: attempt.httpStatus,
          code: attempt.code,
          msg: attempt.msg,
          total: attempt.total,
          list: list.map(x => ({
            id: x.id ?? null,
            skc: x.skc,
            supplierNo: x.supplier_no,
            activityId: x.activity_id,
            activityName: x.activity_name,
            auditStatus: x.audit_status,
            auditStatusDesc: x.audit_status_desc,
            goodsAuditStatus: x.goods_audit_status,
            couponActivity: x.coupon_activity,
            insertTime: x.insert_time || null,
            rawKeys: Object.keys(x || {}).sort(),
          })),
          rawTextSample: '',
        };
      }
    }
    const successfulEmpty = attempts.find(x => x.code === '0');
    const last = attempts[attempts.length - 1] || {};
    return {
      endpoint: '',
      attempts,
      httpStatus: successfulEmpty?.httpStatus ?? last.httpStatus,
      code: successfulEmpty?.code || last.code || '0',
      msg: successfulEmpty?.msg || last.msg || 'OK',
      total: 0,
      list: [],
      rawTextSample: last.rawTextSample || '',
    };
  `, {activityId, skcList, pageNum, pageSize});
}

async function queryPartakeRecordsAll(cdp, activityId, skcList, pageSize) {
  const all = [];
  let total = 0;
  let last = null;
  for (let pageNum = 1; pageNum <= 20; pageNum += 1) {
    last = await queryPartakeRecordsPage(cdp, activityId, skcList, pageNum, pageSize);
    if (last.code !== '0') return {...last, list: all};
    total = last.total;
    all.push(...last.list);
    if (!last.list.length || all.length >= total) break;
  }
  const wanted = new Set(skcList.map(normalizeSkc));
  const filtered = all.filter(item => wanted.has(normalizeSkc(item.skc)) && Number(item.activityId) === Number(activityId));
  return {code: '0', msg: last?.msg || 'OK', total, list: filtered};
}

async function cancelMultiLevelPartake(cdp, activityId, cancelPartakeInfos) {
  return await cdp.eval(`
    const headers = {
      'content-type': 'application/json;charset=UTF-8',
      'Origin-Url': location.href,
      'x-bbl-route': location.hash.replace(/^#/, ''),
      'x-req-zone-id': 'Asia/Shanghai',
      'x-lt-language': 'CN',
      'LAN': 'CN',
    };
    const body = JSON.stringify({
      activity_id: __arg.activityId,
      cancel_partake_infos: __arg.cancelPartakeInfos,
    });
    const endpoint = '/mrs-api-prefix/mbrs/activity/multi-level/partake/cancel';
    const res = await fetch(endpoint, {method: 'POST', credentials: 'include', headers, body});
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const cancelResults = json?.info?.cancel_results || [];
    return {
      endpoint,
      httpStatus: res.status,
      code: json?.code,
      msg: json?.msg,
      info: json?.info ?? null,
      cancelResults,
      textSample: json ? '' : text.slice(0, 500),
    };
  `, {activityId, cancelPartakeInfos});
}

async function cancelTargets(cdp, activityId, targets) {
  const cancelPartakeInfos = targets.map(x => x.cancelPartakeInfo);
  const response = await cancelMultiLevelPartake(cdp, activityId, cancelPartakeInfos);
  const failList = (response.cancelResults || []).map(x => ({
    skc: normalizeSkc(x.skc),
    id: numericId(x.partake_good_id),
    fail_reason: x.fail_reason || '',
  }));
  const failedSkcs = new Set(failList.map(x => x.skc).filter(Boolean));
  const successCnt = response.code === '0'
    ? targets.filter(x => !failedSkcs.has(normalizeSkc(x.skc))).length
    : 0;
  return {
    ok: successCnt === targets.length,
    strategy: 'multi_level_partake_cancel',
    response: {
      endpoint: response.endpoint,
      httpStatus: response.httpStatus,
      code: successCnt === targets.length ? '0' : 'PARTIAL',
      msg: successCnt === targets.length ? 'OK' : 'partial failure',
      info: {success_cnt: successCnt, fail_cnt: failList.length, fail_list: failList},
    },
    rawResponse: response,
    info: {success_cnt: successCnt, fail_cnt: failList.length, fail_list: failList},
  };
}

async function waitForExtrasInactive(cdp, activityId, levelRuleId, targetSkcs, waitMs, pageSize) {
  const deadline = Date.now() + waitMs;
  const targetSet = new Set(targetSkcs.map(normalizeSkc));
  const polls = [];
  let latest = null;
  while (Date.now() < deadline) {
    latest = await queryLevelGoodsAllRaw(cdp, activityId, levelRuleId, 'MULTI_LEVEL_RULE_ENROLLED_GOODS', pageSize);
    const bySkc = new Map((latest.list || []).map(x => [normalizeSkc(x.skc), x]));
    const activeRemaining = [...targetSet]
      .map(skc => bySkc.get(skc))
      .filter(x => x && isActiveStatus(x.status))
      .map(x => ({skc: x.skc, id: x.id, status: x.status}));
    polls.push({at: new Date().toISOString(), enrolledTotal: latest.total, enrolledList: latest.list?.length || 0, activeRemaining: activeRemaining.length});
    if (latest.code === '0' && activeRemaining.length === 0) {
      return {ok: true, enrolled: latest, polls, activeRemaining: []};
    }
    await sleep(2500);
  }
  const bySkc = new Map((latest?.list || []).map(x => [normalizeSkc(x.skc), x]));
  const activeRemaining = [...targetSet]
    .map(skc => bySkc.get(skc))
    .filter(x => x && isActiveStatus(x.status))
    .map(x => ({skc: x.skc, id: x.id, status: x.status}));
  return {ok: false, enrolled: latest, polls, activeRemaining};
}

async function loadJson(file) {
  const absolute = path.resolve(ROOT, file);
  return JSON.parse(await fs.readFile(absolute, 'utf8'));
}

async function loadExtraAndPlans(extraListPath) {
  const absolute = path.resolve(ROOT, extraListPath);
  const extraDoc = await loadJson(absolute);
  const rows = Array.isArray(extraDoc) ? extraDoc : (extraDoc.rows || []);
  const ordinaryPlanPaths = Array.isArray(extraDoc.ordinaryPlanPaths) ? extraDoc.ordinaryPlanPaths : [];
  const planByStore = new Map();
  for (const planPath of ordinaryPlanPaths) {
    const planDoc = await loadJson(planPath);
    const items = Array.isArray(planDoc) ? planDoc : (planDoc.items || []);
    for (const item of items) {
      if (!item?.storeKey || !item?.skc || item.selected === false) continue;
      const storeKey = String(item.storeKey).toUpperCase();
      if (!planByStore.has(storeKey)) planByStore.set(storeKey, new Set());
      planByStore.get(storeKey).add(normalizeSkc(item.skc));
    }
  }
  return {path: absolute, rows, ordinaryPlanPaths, planByStore};
}

function groupRowsByStore(rows, selectedStores, activityId) {
  const selected = new Set(selectedStores);
  const byStore = new Map();
  for (const row of rows) {
    const storeKey = String(row.storeKey || '').toUpperCase();
    const skc = normalizeSkc(row.skc);
    if (!storeKey || !skc || (selected.size && !selected.has(storeKey))) continue;
    if (Number(row.activityId || activityId) !== Number(activityId)) continue;
    if (!byStore.has(storeKey)) byStore.set(storeKey, []);
    byStore.get(storeKey).push({...row, storeKey, skc});
  }
  for (const [storeKey, storeRows] of byStore) {
    const seen = new Set();
    byStore.set(storeKey, storeRows.filter(row => {
      if (seen.has(row.skc)) return false;
      seen.add(row.skc);
      return true;
    }));
  }
  return byStore;
}

async function processStore(store, args, rows, planByStore, extraListPath) {
  const result = {
    store: store.storeKey,
    shopName: store.shopName,
    activityId: args.activityId,
    mode: args.execute ? 'execute' : 'dry-run',
    extraList: extraListPath,
    startedAt: new Date().toISOString(),
    ok: false,
  };
  const planSet = planByStore.get(store.storeKey.toUpperCase()) || new Set();
  let cdp = null;
  try {
    if (!rows.length) {
      result.ok = true;
      result.reason = 'no extra rows for store';
      return result;
    }

    const unsafePlanRows = rows.filter(row => planSet.has(row.skc));
    result.input = {
      extraRows: rows.length,
      plannedSkcs: planSet.size,
      unsafePlanRows: unsafePlanRows.length,
      levelRuleIds: [...new Set(rows.map(row => Number(row.levelRuleId)).filter(Boolean))],
      sample: rows.slice(0, 10).map(row => ({skc: row.skc, supplierNo: row.supplierNo, levelRuleId: row.levelRuleId, status: row.status})),
    };
    if (unsafePlanRows.length) {
      result.reason = `safety stop: ${unsafePlanRows.length} extra rows are also in ordinary signup plan`;
      result.unsafePlanRows = unsafePlanRows.slice(0, 20);
      return result;
    }
    if (result.input.levelRuleIds.length !== 1) {
      result.reason = `safety stop: expected one 15% levelRuleId, got ${result.input.levelRuleIds.join(',') || '(none)'}`;
      return result;
    }
    const levelRuleId = result.input.levelRuleIds[0];

    await ensureBrowser(store, args.activityId, levelRuleId, args);
    cdp = await connectStorePage(store);
    result.initialPage = await gotoCouponRule(cdp, args.activityId, levelRuleId);
    if (result.initialPage?.hasLogin) {
      result.loginRecovery = await recoverLoginIfNeeded(cdp, args.activityId, levelRuleId);
      result.initialPage = result.loginRecovery.page || await gotoCouponRule(cdp, args.activityId, levelRuleId);
      if (result.initialPage?.hasLogin) {
        result.reason = '营销子系统显示登录页，自动点登录后仍未恢复，需人工登录';
        return result;
      }
    }

    let beforeEnrolled = await queryLevelGoodsAllRaw(cdp, args.activityId, levelRuleId, 'MULTI_LEVEL_RULE_ENROLLED_GOODS', args.pageSize);
    if (beforeEnrolled.code === '20302') {
      result.loginRecovery = await recoverLoginIfNeeded(cdp, args.activityId, levelRuleId);
      beforeEnrolled = await queryLevelGoodsAllRaw(cdp, args.activityId, levelRuleId, 'MULTI_LEVEL_RULE_ENROLLED_GOODS', args.pageSize);
    }
    result.beforeEnrolled = {
      code: beforeEnrolled.code,
      msg: beforeEnrolled.msg,
      total: beforeEnrolled.total,
      count: beforeEnrolled.list.length,
      rawKeysSample: beforeEnrolled.list[0]?.rawKeys || [],
      sample: beforeEnrolled.list.slice(0, 10),
    };
    if (beforeEnrolled.code !== '0') {
      result.reason = `15% 已报集合查询失败: ${beforeEnrolled.msg || beforeEnrolled.code}`;
      return result;
    }

    const bySkc = new Map(beforeEnrolled.list.map(item => [item.skc, item]));
    const targetSkcs = rows.map(row => row.skc);
    const recordList = await queryPartakeRecordsAll(cdp, args.activityId, targetSkcs, args.pageSize);
    result.partakeRecords = {
      code: recordList.code,
      msg: recordList.msg,
      total: recordList.total,
      count: recordList.list.length,
      rawKeysSample: recordList.list[0]?.rawKeys || [],
      sample: recordList.list.slice(0, 10),
    };
    if (recordList.code !== '0') {
      result.reason = `报名记录查询失败: ${recordList.msg || recordList.code}`;
      return result;
    }
    const recordBySkc = new Map(recordList.list.map(item => [normalizeSkc(item.skc), item]));
    const targets = [];
    const missing = [];
    const notActive = [];
    const missingId = [];
    const missingRecord = [];
    for (const row of rows) {
      const found = bySkc.get(row.skc);
      if (!found) {
        missing.push({skc: row.skc, supplierNo: row.supplierNo});
        continue;
      }
      if (!isActiveStatus(found.status)) {
        notActive.push({skc: row.skc, supplierNo: row.supplierNo, status: found.status, id: found.id});
        continue;
      }
      const record = recordBySkc.get(row.skc);
      const recordId = numericId(record?.id);
      if (!recordId) missingRecord.push({skc: row.skc, supplierNo: row.supplierNo, record: record || null, goodsQueryId: found.id});
      const partakeGoodId = numericId(found.partakeGoodId ?? found.idCandidates?.partake_good_id ?? found.id);
      const partakeLevelRuleId = numericId(found.partakeLevelRuleId ?? found.levelRuleId ?? row.levelRuleId);
      const partakeRuleGoodId = numericId(found.partakeRuleGoodId ?? found.idCandidates?.partake_rule_good_id);
      if (!partakeGoodId || !partakeLevelRuleId || !partakeRuleGoodId) {
        missingId.push({skc: row.skc, supplierNo: row.supplierNo, found, record: record || null});
        continue;
      }
      targets.push({
        id: partakeGoodId,
        idSource: 'multi-level.partake_good_id',
        skc: row.skc,
        supplierNo: row.supplierNo,
        status: found.status,
        goodsQueryId: found.id,
        ruleGoodsId: partakeRuleGoodId,
        partakeLevelRuleId,
        recordAuditStatus: record?.auditStatus ?? null,
        cancelPartakeInfo: {
          partake_good_id: partakeGoodId,
          partake_level_rule_id: partakeLevelRuleId,
          partake_rule_good_id: partakeRuleGoodId,
          skc: row.skc,
        },
      });
    }

    const plannedBefore = [...planSet].filter(skc => {
      const item = bySkc.get(skc);
      return item && isActiveStatus(item.status);
    });
    result.target = {
      cancelTargetCount: targets.length,
      missingFromEnrolled: missing.length,
      alreadyInactive: notActive.length,
      missingId: missingId.length,
      missingRecord: missingRecord.length,
      plannedActiveBefore: plannedBefore.length,
      goodsListSample: targets.slice(0, 10),
      missingSample: missing.slice(0, 10),
      inactiveSample: notActive.slice(0, 10),
      missingIdSample: missingId.slice(0, 5),
      missingRecordSample: missingRecord.slice(0, 5),
    };

    if (missingId.length) {
      result.reason = `safety stop: ${missingId.length} active target rows lack any cancel id candidate`;
      return result;
    }
    if (targets.length === 0) {
      result.ok = true;
      result.reason = 'extra SKCs are already absent or inactive in 15% enrolled list';
      return result;
    }
    if (!args.execute) {
      result.ok = true;
      result.dryRun = true;
      result.reason = `dry-run only: would cancel ${targets.length} active extra SKCs`;
      return result;
    }

    result.cancel = await cancelTargets(cdp, args.activityId, targets);
    const successCnt = Number(result.cancel?.response?.info?.success_cnt ?? result.cancel?.info?.success_cnt ?? 0);
    const failCnt = Number(result.cancel?.response?.info?.fail_cnt ?? result.cancel?.info?.fail_cnt ?? 0);
    result.cancelSummary = {
      ok: !!result.cancel?.ok,
      usedEndpoint: result.cancel?.usedEndpoint || '',
      successCnt,
      failCnt,
      failList: result.cancel?.response?.info?.fail_list || [],
    };
    if (!result.cancel?.ok || successCnt !== targets.length || failCnt !== 0) {
      result.reason = `cancel API did not fully succeed: success=${successCnt}, fail=${failCnt}, target=${targets.length}`;
      return result;
    }

    result.wait = await waitForExtrasInactive(cdp, args.activityId, levelRuleId, targets.map(x => x.skc), args.waitMs, args.pageSize);
    const afterList = result.wait.enrolled?.list || [];
    const afterBySkc = new Map(afterList.map(item => [item.skc, item]));
    const plannedAfter = [...planSet].filter(skc => {
      const item = afterBySkc.get(skc);
      return item && isActiveStatus(item.status);
    });
    result.afterEnrolled = {
      code: result.wait.enrolled?.code,
      msg: result.wait.enrolled?.msg,
      total: result.wait.enrolled?.total,
      count: afterList.length,
      plannedActiveAfter: plannedAfter.length,
      activeExtraRemaining: result.wait.activeRemaining.length,
      activeExtraRemainingSample: result.wait.activeRemaining.slice(0, 20),
      plannedActiveBefore: plannedBefore.length,
      plannedLost: plannedBefore.filter(skc => !plannedAfter.includes(skc)).slice(0, 20),
    };
    result.ok = !!result.wait.ok && plannedAfter.length >= plannedBefore.length;
    result.reason = result.ok
      ? `extra active SKCs cancelled; ordinary planned active count preserved (${plannedBefore.length} -> ${plannedAfter.length})`
      : `verification failed: activeExtraRemaining=${result.wait.activeRemaining.length}, plannedActive ${plannedBefore.length}->${plannedAfter.length}`;
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
const extra = await loadExtraAndPlans(args.extraList);
const selectedStores = args.stores.map(key => {
  const store = STORES.find(s => String(s.storeKey).toUpperCase() === key.toUpperCase());
  if (!store) throw new Error(`Unknown store ${key}`);
  return store;
});
const byStore = groupRowsByStore(extra.rows, args.stores, args.activityId);
const summary = {
  createdAt: new Date().toISOString(),
  activityId: args.activityId,
  mode: args.execute ? 'execute' : 'dry-run',
  extraList: extra.path,
  ordinaryPlanPaths: extra.ordinaryPlanPaths,
  stores: [],
};

for (const store of selectedStores) {
  const rows = byStore.get(store.storeKey.toUpperCase()) || [];
  console.log(`\n[${store.storeKey}] ${args.execute ? '取消' : 'dry-run'} 优惠券额外报名项: inputExtra=${rows.length}`);
  const result = await processStore(store, args, rows, extra.planByStore, extra.path);
  summary.stores.push(result);
  const targetCount = result.target?.cancelTargetCount ?? '-';
  const afterRemain = result.afterEnrolled?.activeExtraRemaining ?? '-';
  console.log(`[${store.storeKey}] ${result.ok ? 'OK' : 'FAIL'} target=${targetCount} afterActiveExtra=${afterRemain} ${result.reason || ''}`);
  await fs.writeFile(path.join(OUT_DIR, `${store.storeKey}-${args.activityId}-cancel-extra.json`), JSON.stringify(result, null, 2), 'utf8');
}

summary.ok = summary.stores.every(s => s.ok);
summary.totals = summary.stores.reduce((acc, s) => {
  acc.inputExtraRows += s.input?.extraRows || 0;
  acc.cancelTargets += s.target?.cancelTargetCount || 0;
  acc.missingFromEnrolled += s.target?.missingFromEnrolled || 0;
  acc.alreadyInactive += s.target?.alreadyInactive || 0;
  acc.successCnt += s.cancelSummary?.successCnt || 0;
  acc.failCnt += s.cancelSummary?.failCnt || 0;
  acc.okStores += s.ok ? 1 : 0;
  acc.failedStores += s.ok ? 0 : 1;
  return acc;
}, {inputExtraRows: 0, cancelTargets: 0, missingFromEnrolled: 0, alreadyInactive: 0, successCnt: 0, failCnt: 0, okStores: 0, failedStores: 0});

const summaryFile = path.join(OUT_DIR, `summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2), 'utf8');
console.log(`\nSUMMARY ${summaryFile}`);
process.exit(summary.ok ? 0 : 1);
