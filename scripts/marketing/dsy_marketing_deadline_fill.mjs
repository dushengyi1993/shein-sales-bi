#!/usr/bin/env node
// SHEIN 营销活动报名半自动助手：
// - 只做商品勾选、活动价/降幅预填和页面复核。
// - 不点击最终“提交报名”；最终提交必须由用户在可见前端人工确认。
// - 运行前先执行 scripts/marketing/build_marketing_cost_map.py 生成本地成本映射。
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {normalizeGoodsSnDetailed} from '../../lib/product_sku_normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIST_URL = 'https://sso.geiwohuo.com/#/mbrs/marketing/list';
const STORES = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8')).stores;
const COSTS = JSON.parse(await fs.readFile(path.join(ROOT, 'tmp', 'mbrs', 'marketing-cost-map.json'), 'utf8')).costMap;
const OUT_DIR = path.join(ROOT, 'tmp', 'mbrs', 'deadline-fill-results');
await fs.mkdir(OUT_DIR, {recursive: true});

const args = parseArgs(process.argv.slice(2));
const now = new Date();
const deadlineMs = now.getTime() + (args.hours * 3600_000);

const DEFAULT_MARGIN_TARGET = 0.30;
const FIXED_PRICE_JITTER = {min: -2, max: 1};
const MARGIN_TARGET_JITTER = {min: -0.02, max: 0.01};

const fixedPriceBase = [
  ['SK-999食品料理机', 110],
  ['SM-961厨师机', 227],
  ['PA4-6L便携式冰箱', 160],
  ['SM-505A电动缝纫机', 110],
  ['TXSM-505A电动缝纫机', 110],
  ['SK-03012台式榨汁机', 96],
  ['SK-03038制冰机', 330],
  ['SK-04031胶囊咖啡机', 233],
  ['SK-GT-3065蒸汽熨烫机', 90],
  ['SK-3378杆式吸尘器', 150],
  ['SK-10075电油炸锅', 150],
  ['SK-6863半自动意式咖啡机', 300],
  ['SK-6810半自动意式咖啡机', 165],
  ['CM-121E美式咖啡机', 135],
  ['SK-11041蒸汽熨烫机', 70],
  ['SK-223三明治机和早餐机', 85],
  ['KF-JN-02便携咖啡机', 96],
  ['SK-185台式榨汁机', 91],
];
const marginRuleBase = [
  ['FZ-666颈部按摩器', 0.15],
  ['SK-7025A绞肉机', 0.25],
  ['SK-7027绞肉机', 0.25],
  ['SK-7028绞肉机', 0.25],
];
const fixedPriceRules = new Map();
const marginRules = new Map();
const priceOverrideRules = new Map();
const storePriceOverrideRules = new Map();

function registerRuleKeys(map, label, value) {
  const keys = [
    compact(label),
    compact(normalizeGoodsSnDetailed(label, {goodsTitle: label}).canonical),
    compact(modelCode(label)),
  ].filter(Boolean);
  for (const key of keys) map.set(key, value);
}

for (const [label, value] of fixedPriceBase) registerRuleKeys(fixedPriceRules, label, value);
for (const [label, value] of marginRuleBase) registerRuleKeys(marginRules, label, value);
await loadPriceOverrides();

function parseArgs(argv) {
  const out = {stores: [], activityIds: [], hours: 48, allOpen: false, includeCoupon: false, dryRun: false, noClose: false, minDiscountFallback: [], priceOverrides: ''};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stores') out.stores = String(argv[++i] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--activity') out.activityIds = String(argv[++i] || '').split(',').map(s => Number(s.trim())).filter(Boolean);
    else if (a === '--hours') out.hours = Number(argv[++i] || 48);
    else if (a === '--all-open') out.allOpen = true;
    else if (a === '--include-coupon') out.includeCoupon = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-close') out.noClose = true;
    else if (a === '--min-discount-fallback') out.minDiscountFallback = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--price-overrides') out.priceOverrides = path.resolve(argv[++i] || '');
  }
  return out;
}

function compact(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, '').replace(/[()（）【】\[\]_:：/\\]/g, '').toUpperCase();
}

function modelCode(s) {
  return String(s || '').match(/^[A-Z]{1,5}-?\d+[A-Z]?(?:-\d+)?/i)?.[0] || '';
}

async function loadPriceOverrides() {
  if (!args.priceOverrides) return;
  const doc = JSON.parse(await fs.readFile(args.priceOverrides, 'utf8'));
  const items = Array.isArray(doc.items) ? doc.items : [];
  for (const item of items) {
    const label = item.canonical || item.goodsSn || item.supplierNo || '';
    if (!label || item.targetPrice === undefined || item.targetPrice === null) continue;
    const storeKeys = [
      ...(Array.isArray(item.storeKeys) ? item.storeKeys : []),
      ...(item.storeKey ? [item.storeKey] : []),
    ].map(x => String(x || '').trim().toUpperCase()).filter(Boolean);
    if (storeKeys.length) {
      const before = new Map();
      registerRuleKeys(before, label, item);
      for (const key of item.keys || []) before.set(compact(key), item);
      for (const storeKey of storeKeys) {
        for (const key of before.keys()) storePriceOverrideRules.set(`${storeKey}:${key}`, item);
      }
    } else {
      registerRuleKeys(priceOverrideRules, label, item);
      for (const key of item.keys || []) priceOverrideRules.set(compact(key), item);
    }
  }
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function floor2(n) {
  return Math.floor((Number(n) + 1e-9) * 100) / 100;
}

function stableRandom(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function randomBetween(seed, min, max) {
  return min + stableRandom(seed) * (max - min);
}

function findManualRule(keys) {
  for (const k of keys) {
    if (fixedPriceRules.has(k)) {
      return {
        ruleType: 'fixed_price',
        source: 'fixed_price',
        base: Number(fixedPriceRules.get(k)),
        marginTarget: null,
      };
    }
    if (marginRules.has(k)) {
      const marginTarget = Number(marginRules.get(k));
      return {
        ruleType: 'margin',
        source: `${Math.round(marginTarget * 100)}pct_profit`,
        base: null,
        marginTarget,
      };
    }
  }
  return null;
}

function discountPctForTarget(current, minDiscount, target) {
  if (!(current > 0)) return minDiscount;
  const raw = (1 - target / current) * 100;
  const pct = Math.floor(raw + 1e-9);
  return Math.max(minDiscount, pct);
}

function parseTime(s) {
  if (!s || s === '长期有效') return null;
  const raw = String(s).trim();
  const d = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)
    ? new Date(raw.replace(/\//g, '-').replace(' ', 'T'))
    : new Date(raw.replace(/\//g, '-').replace(' ', 'T') + '+08:00');
  return Number.isNaN(d.getTime()) ? null : d;
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
    "foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }",
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
  if (r.status !== 0) {
    throw new Error(`launch visible failed for ${store.storeKey}: ${r.stderr || r.stdout}`);
  }
}

function bringStoreWindowToFront(store) {
  if (process.platform !== 'win32') return;
  const profileNeedle = `persistent-${store.profileKey}-profile`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type @\"",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class Win32BringToFront {",
    "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
    "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
    "}",
    "\"@",
    `$needle = ${psSingleQuote(profileNeedle)}`,
    "$rootIds = @(Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$needle*\" } | Select-Object -ExpandProperty ProcessId)",
    "$wins = @(Get-Process chrome | Where-Object { $_.MainWindowHandle -ne 0 -and ($rootIds -contains $_.Id) })",
    "if (-not $wins -or $wins.Count -eq 0) { $wins = @(Get-Process chrome | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*SHEIN*' }) }",
    "$p = $wins | Select-Object -First 1",
    "if ($p) { [Win32BringToFront]::ShowWindowAsync($p.MainWindowHandle, 3) | Out-Null; Start-Sleep -Milliseconds 200; [Win32BringToFront]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }",
  ].join('\n');
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {cwd: ROOT, stdio: 'ignore', timeout: 20_000});
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
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
        const {resolve, reject} = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  call(method, params = {}, sessionId = undefined) {
    const id = ++this.id;
    const payload = {id, method, params};
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30_000);
    });
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function connectStore(store) {
  const version = await httpJson(`http://127.0.0.1:${store.port}/json/version`);
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

async function newPage(cdp, url) {
  const {targetId} = await cdp.call('Target.createTarget', {url, newWindow: false});
  const {sessionId} = await cdp.call('Target.attachToTarget', {targetId, flatten: true});
  await cdp.call('Runtime.enable', {}, sessionId);
  await cdp.call('Page.enable', {}, sessionId);
  try {
    const win = await cdp.call('Browser.getWindowForTarget', {targetId});
    await cdp.call('Browser.setWindowBounds', {windowId: win.windowId, bounds: {windowState: 'maximized'}});
  } catch {}
  return {targetId, sessionId};
}

async function evalJs(cdp, sessionId, body, arg = undefined) {
  const encoded = arg === undefined ? 'undefined' : JSON.stringify(arg).replace(/</g, '\\u003c');
  const expression = `(async () => { const __arg = ${encoded}; ${body} })()`;
  const res = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId);
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.text || JSON.stringify(res.exceptionDetails));
  }
  return res.result?.value;
}

async function waitFor(cdp, sessionId, predicateBody, timeoutMs = 25_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await evalJs(cdp, sessionId, `return Boolean(${predicateBody});`).catch(() => false);
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function realClick(cdp, sessionId, rect) {
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return false;
  const x = rect.x + (rect.w || 0) / 2;
  const y = rect.y + (rect.h || 0) / 2;
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y, button: 'none'}, sessionId);
  await cdp.call('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1}, sessionId);
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1}, sessionId);
  return true;
}

async function setPageSize500(cdp, sessionId) {
  const before = await evalJs(cdp, sessionId, `
    const textOf = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const rectOf = el => {
      const r = el.getBoundingClientRect();
      return {x: r.left, y: r.top, w: r.width, h: r.height};
    };
    const totalText = ([...document.querySelectorAll('*')].map(textOf).find(t => /总计\\s*\\d+\\s*个/.test(t)) || '');
    const totalGoods = Number((totalText.match(/总计\\s*(\\d+)\\s*个/) || [])[1] || 0);
    const current = [...document.querySelectorAll('.soui-pagination-size-list, .soui-select-wrapper, div, span')]
      .filter(el => /\\d+\\s*条\\/页/.test(textOf(el)))
      .sort((a,b) => {
        const score = el => {
          const cls = String(el.className || '');
          if (cls.includes('soui-pagination-size-list')) return 0;
          if (cls.includes('soui-select-wrapper')) return 1;
          return 2;
        };
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (score(a) - score(b)) || (br.y - ar.y) || (br.x - ar.x);
      })[0];
    return {
      totalGoods,
      currentText: textOf(current),
      rect: current ? rectOf(current) : null,
    };
  `);
  if (!before?.rect) return {ok: false, skipped: true, reason: '未找到每页条数控件', ...before};
  if (/500\s*条\/页/.test(before.currentText || '')) return {ok: true, changed: false, ...before};
  await realClick(cdp, sessionId, before.rect);
  await sleep(500);
  const option = await evalJs(cdp, sessionId, `
    const textOf = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const rectOf = el => {
      const r = el.getBoundingClientRect();
      return {x: r.left, y: r.top, w: r.width, h: r.height};
    };
    const options = [...document.querySelectorAll('li, div, span')]
      .filter(el => /^500\\s*条\\/页$/.test(textOf(el)))
      .map(el => ({el, rect: rectOf(el), text: textOf(el), cls: String(el.className || '')}))
      .filter(x => x.rect.w > 0 && x.rect.h > 0)
      .sort((a,b) => {
        const score = x => (x.el.tagName === 'LI' ? 0 : 1) + (String(x.cls).includes('soui-select-option') ? -1 : 0);
        return score(a) - score(b);
      });
    const picked = options[0];
    return picked ? {text: picked.text, rect: picked.rect, cls: picked.cls} : null;
  `);
  if (!option?.rect) return {ok: false, changed: false, reason: '未找到500条/页选项', before};
  await realClick(cdp, sessionId, option.rect);
  await sleep(1200);
  const after = await evalJs(cdp, sessionId, `
    const textOf = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const sizeText = ([...document.querySelectorAll('.soui-pagination-size-list, .soui-select-wrapper, div, span')]
      .map(textOf)
      .find(t => /^500\\s*条\\/页$/.test(t)) || '');
    const totalText = ([...document.querySelectorAll('*')].map(textOf).find(t => /总计\\s*\\d+\\s*个/.test(t)) || '');
    const totalGoods = Number((totalText.match(/总计\\s*(\\d+)\\s*个/) || [])[1] || 0);
    return {sizeText, totalGoods};
  `);
  return {ok: /500\s*条\/页/.test(after?.sizeText || ''), changed: true, before, optionText: option.text, after};
}

async function fetchActivities(cdp, sessionId) {
  await waitFor(cdp, sessionId, `document.body && document.body.innerText.includes('营销活动报名')`, 30_000);
  const data = await evalJs(cdp, sessionId, `
    const r = await fetch('/mrs-api-prefix/mbrs/activity/get_activity_list?page_num=1&page_size=30', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{}',
    });
    return await r.json();
  `);
  const list = data?.info?.activity_detail_list || [];
  return list.map(a => ({
    activityId: Number(a.activity_id),
    name: a.activity_name || '',
    backendCate: a.backend_cate,
    label: a.text_tag_content || '',
    signStart: a.activity_start_zone_time || '',
    signEnd: a.activity_end_zone_time || '',
    eventStart: a.start_zone_time || '',
    eventEnd: a.end_zone_time || '',
    allowGoodsNum: Number(a.allow_goods_num || 0),
    applyGoodsNum: Number(a.apply_goods_num || 0),
    raw: a,
  }));
}

function isCouponActivity(a) {
  const text = [a.name, a.label, a.backendCate].filter(Boolean).join(' ');
  return /coupon|优惠券/i.test(text);
}

function withinDeadline(a) {
  if (args.activityIds.length && !args.activityIds.includes(a.activityId)) return false;
  if (!args.includeCoupon && isCouponActivity(a)) return false;
  if (!args.activityIds.length) {
    if (a.allowGoodsNum <= 0) return false;
    if (a.applyGoodsNum >= a.allowGoodsNum) return false;
  }
  const end = parseTime(a.signEnd);
  if (!end) return false;
  if (end.getTime() < now.getTime()) return false;
  if (args.activityIds.length || args.allOpen) return true;
  return end.getTime() <= deadlineMs;
}

async function selectAllGoodsAndNext(cdp, sessionId) {
  const ready = await waitFor(cdp, sessionId, `
    document.body && (document.body.innerText.includes('可报名商品') || document.body.innerText.includes('提报的活动价格'))
  `, 30_000);
  if (!ready) return {ok: false, reason: '商品页未加载'};

  const mode = await evalJs(cdp, sessionId, `
    const t = document.body.innerText || '';
    if (t.includes('提报的活动价格')) return 'edit';
    if (t.includes('可报名商品')) return 'choose';
    return 'unknown';
  `);
  if (mode === 'edit') return {ok: true, mode: 'edit'};
  if (mode !== 'choose') return {ok: false, mode, reason: '未知页面'};

  const pageSize = await setPageSize500(cdp, sessionId);
  await sleep(500);

  const result = await evalJs(cdp, sessionId, `
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const isDisabled = el => !el || el.disabled || el.getAttribute('aria-disabled') === 'true' ||
      !!el.closest('.ant-pagination-disabled,.soui-pagination-disabled,.disabled') ||
      String(el.className || '').includes('soui-button-disabled');
    const fire = el => {
      if (!el) return false;
      const target = el.matches?.('input[type=checkbox]')
        ? (el.closest('.soui-checkbox-wrapper,.merchant-ui-checkbox') || el.parentElement || el)
        : el;
      target.scrollIntoView({block:'center', inline:'center'});
      target.click();
      return true;
    };
    const headerCheckbox = () => {
      const th = [...document.querySelectorAll('th')].find(x => x.querySelector('input[type=checkbox]'));
      return th?.querySelector('input[type=checkbox]');
    };
    const pageButtons = () => [...document.querySelectorAll('.soui-pagination-buttons button, button')]
      .filter(b => /^\\d+$/.test((b.innerText || '').trim()));
    const activePage = () => {
      const b = pageButtons().find(x => String(x.className || '').includes('soui-button-primary'));
      return Number((b?.innerText || '1').trim()) || 1;
    };
    const maxPage = () => Math.max(1, ...pageButtons().map(b => Number((b.innerText || '').trim()) || 1));
    const gotoPage = async n => {
      const btn = pageButtons().find(b => Number((b.innerText || '').trim()) === n);
      if (!btn || isDisabled(btn)) return activePage() === n;
      fire(btn);
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        if (activePage() === n) return true;
      }
      return activePage() === n;
    };
    const parseSelected = () => {
      const t = [...document.querySelectorAll('*')].map(x => x.innerText || '').find(t => /已选商品\\d+个/.test(t)) || '';
      const checkedRows = [...document.querySelectorAll('tbody tr input[type=checkbox]')]
        .filter(x => x.checked && !isDisabled(x)).length;
      const fromText = Number((t.match(/已选商品(\\d+)个/) || [])[1] || 0);
      const selectedCount = fromText || checkedRows;
      return {
        selectedText: (t.match(/已选商品\\d+个/) || [])[0] || (selectedCount ? ('已选商品' + selectedCount + '个') : ''),
        selectedCount,
      };
    };
    const parseTotal = () => {
      const t = [...document.querySelectorAll('*')].map(x => x.innerText || '').find(t => /总计\\s*\\d+\\s*个/.test(t)) || '';
      return {
        totalText: (t.match(/总计\\s*\\d+\\s*个/) || [])[0] || '',
        totalGoods: Number((t.match(/总计\\s*(\\d+)\\s*个/) || [])[1] || 0),
      };
    };
    const selectUncheckedVisibleRows = async () => {
      let clicks = 0;
      const rowChecks = [...document.querySelectorAll('tr input[type=checkbox]')]
        .filter(x => !x.checked && !isDisabled(x));
      for (const rowCb of rowChecks) {
        fire(rowCb);
        clicks++;
        await sleep(100);
      }
      return clicks;
    };
    const tableScroller = () => [...document.querySelectorAll('div,main,section')]
      .filter(el => el.querySelectorAll('tr input[type=checkbox]').length >= 2 && el.scrollHeight > el.clientHeight + 40)
      .sort((a,b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
    const sweepVirtualRows = async totalGoods => {
      const scroller = tableScroller();
      if (!scroller) return 0;
      let clicks = 0;
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      for (let top = 0, guard = 0; guard < 80 && top <= max + 30; guard++, top += 360) {
        scroller.scrollTop = Math.min(top, max);
        scroller.dispatchEvent(new Event('scroll', {bubbles:true}));
        await sleep(260);
        clicks += await selectUncheckedVisibleRows();
        const selectedNow = parseSelected().selectedCount;
        if (totalGoods && selectedNow >= totalGoods) break;
      }
      return clicks;
    };
    let pages = 0;
    let selectedClicks = 0;
    const totalPages = maxPage();
    const total = parseTotal();
    for (let page = 1; page <= totalPages; page++) {
      await gotoPage(page);
      await sleep(500);
      const cb = headerCheckbox();
      if (cb && !cb.checked) {
        fire(cb);
        selectedClicks++;
        await sleep(600);
      }
      selectedClicks += await selectUncheckedVisibleRows();
      if (total.totalGoods && parseSelected().selectedCount < total.totalGoods) {
        selectedClicks += await sweepVirtualRows(total.totalGoods);
      }
      pages++;
    }
    const selected = parseSelected();
    const nextStep = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '下一步');
    const canNext = nextStep && !nextStep.disabled;
    if (canNext) fire(nextStep);
    return {pages, totalPages, selectedClicks, clickedNext: Boolean(canNext), ...total, ...selected};
  `);

  const editReady = await waitFor(cdp, sessionId, `document.body && document.body.innerText.includes('提报的活动价格')`, 30_000);
  const selectedOk = !result.totalGoods || result.selectedCount >= result.totalGoods;
  return {...result, pageSize, ok: editReady && selectedOk, mode: editReady ? 'edit' : 'choose', reason: selectedOk ? undefined : `只选中 ${result.selectedCount}/${result.totalGoods} 个商品`};
}

function computeTarget(storeKey, activityId, row) {
  const supplier = row.supplierNo || '';
  const normalized = normalizeGoodsSnDetailed(supplier, {goodsTitle: row.goodsName || ''});
  const canonical = normalized.canonical || supplier;
  const keys = [
    compact(supplier),
    compact(canonical),
    compact(modelCode(supplier)),
    compact(modelCode(canonical)),
    compact(normalized.rawGoodsSn),
  ].filter(Boolean);
  const minDiscountFallbackNeedles = (args.minDiscountFallback || []).map(compact).filter(Boolean);
  const useMinDiscountFallback = minDiscountFallbackNeedles.some(needle => keys.some(k => k.includes(needle) || needle.includes(k)));
  const seed = `${storeKey}:${activityId}:${row.skc}:${supplier}`;
  const current = Number(row.currentPrice || 0);
  const minDiscount = Number(row.minDiscount || 10);
  const manualRule = findManualRule(keys);
  const override = manualRule
    ? null
    : (keys.map(k => storePriceOverrideRules.get(`${storeKey}:${k}`)).find(Boolean)
      || keys.map(k => priceOverrideRules.get(k)).find(Boolean));
  if (override) {
    const targetBase = Number(override.targetPrice);
    const cost = override.cost === null || override.cost === undefined ? null : Number(override.cost);
    const marginFloor = override.minMarginFloor === null || override.minMarginFloor === undefined ? null : Number(override.minMarginFloor);
    if (!Number.isFinite(targetBase) || targetBase <= 0) {
      return {ok: false, reason: '覆盖价无效', supplierNo: supplier, canonical};
    }
    let target = round2(targetBase);
    let platformAdjusted = false;
    if (current > 0 && minDiscount > 0) {
      const maxPrice = floor2(current * (1 - minDiscount / 100));
      if (target > maxPrice) {
        target = maxPrice;
        platformAdjusted = true;
      }
    }
    const projectedMargin = cost && target > 0 ? (target - cost) / target : null;
    const floorBreached = marginFloor !== null && projectedMargin !== null && projectedMargin < marginFloor;
    const discountPct = discountPctForTarget(current, minDiscount, target);
    return {
      ok: true,
      supplierNo: supplier,
      canonical,
      source: override.rule || 'price_override',
      ruleType: 'price_override',
      basePrice: targetBase,
      randomOffset: 0,
      marginTarget: null,
      marginUsed: projectedMargin === null ? null : round2(projectedMargin * 100),
      currentPrice: current,
      targetPrice: target,
      targetPriceText: target.toFixed(2),
      discountPct,
      minDiscount,
      platformAdjusted,
      minMarginFloor: marginFloor === null ? null : round2(marginFloor * 100),
      floorBreached,
    };
  }
  let source = '30pct_profit';
  let ruleType = 'margin';
  let base = null;
  let marginTarget = DEFAULT_MARGIN_TARGET;
  let marginUsed = null;
  if (manualRule) {
    base = manualRule.base;
    ruleType = manualRule.ruleType;
    source = manualRule.source;
    marginTarget = manualRule.marginTarget;
  }
  let cost = null;
  if (base === null) {
    for (const k of keys) {
      if (COSTS[k] !== undefined) {
        cost = Number(COSTS[k]);
        break;
      }
    }
    if (cost === null || !Number.isFinite(cost)) {
      if (useMinDiscountFallback) {
        const current = Number(row.currentPrice || 0);
        const minDiscount = Number(row.minDiscount || 10);
        if (current > 0 && minDiscount > 0) {
          const target = floor2(current * (1 - minDiscount / 100));
          return {
            ok: true,
            supplierNo: supplier,
            canonical,
            source: 'min_discount_fallback',
            ruleType: 'min_discount_fallback',
            basePrice: current,
            randomOffset: 0,
            marginTarget: null,
            marginUsed: null,
            currentPrice: current,
            targetPrice: target,
            targetPriceText: target.toFixed(2),
            discountPct: minDiscount,
            minDiscount,
            platformAdjusted: true,
            fallbackReason: 'missing_cost_min_discount',
          };
        }
      }
      return {ok: false, reason: '缺成本', supplierNo: supplier, canonical};
    }
    marginUsed = Math.min(0.95, Math.max(0.01, marginTarget + randomBetween(seed, MARGIN_TARGET_JITTER.min, MARGIN_TARGET_JITTER.max)));
    base = cost / (1 - marginTarget);
  } else {
    base = Number(base);
  }
  const offset = ruleType === 'fixed_price'
    ? randomBetween(seed, FIXED_PRICE_JITTER.min, FIXED_PRICE_JITTER.max)
    : (marginUsed - marginTarget);
  let target = ruleType === 'fixed_price'
    ? round2(base + offset)
    : round2(cost / (1 - marginUsed));
  let platformAdjusted = false;
  if (current > 0 && minDiscount > 0) {
    const maxPrice = floor2(current * (1 - minDiscount / 100));
    if (target > maxPrice) {
      target = maxPrice;
      platformAdjusted = true;
    }
  }
  const discountPct = discountPctForTarget(current, minDiscount, target);
  return {
    ok: true,
    supplierNo: supplier,
    canonical,
    source,
    ruleType,
    basePrice: round2(base),
    randomOffset: round2(offset),
    marginTarget: marginTarget === null ? null : round2(marginTarget * 100),
    marginUsed: marginUsed === null ? null : round2(marginUsed * 100),
    currentPrice: current,
    targetPrice: target,
    targetPriceText: target.toFixed(2),
    discountPct,
    minDiscount,
    platformAdjusted,
  };
}

async function collectVisibleRows(cdp, sessionId) {
  return await evalJs(cdp, sessionId, `
    const rows = [];
    for (const tr of document.querySelectorAll('tr')) {
      const cells = [...tr.querySelectorAll('td')].map(td => td.innerText || '');
      if (cells.length < 6) continue;
      const rowText = tr.innerText || cells.join('\\n');
      const idx = Number(((cells[0] || rowText).match(/\\d+/) || [])[0]);
      const info = rowText;
      const inputs = [...tr.querySelectorAll('input')];
      const skc = (info.match(/SKC:\\s*([a-z]{2}\\d+)/i) || [])[1] || '';
      const supplierNo = (info.match(/供方货号:\\s*([^\\n\\t]+)/) || [])[1]?.trim() || '';
      const priceCell = cells.find(c => /SAR\\s*[\\d.]+/i.test(c)) || '';
      const currentPrice = Number((priceCell.match(/SAR\\s*([\\d.]+)/i) || (cells[3] || '').match(/([\\d.]+)/) || [])[1] || 0);
      const textInputs = inputs.filter(x => /^(text|number)$/.test(x.type || 'text'));
      const radioInputs = inputs.filter(x => x.type === 'radio');
      const discountText = cells.join(' ');
      const discountMatches = [...discountText.matchAll(/(\\d+(?:\\.\\d+)?)%\\s*价格降幅/g)].map(m => Number(m[1]));
      let minDiscount = Number(((cells[5] || '').match(/降幅要求[:：]\\s*(\\d+(?:\\.\\d+)?)%/) || [])[1] || 0);
      if (!minDiscount && discountMatches.length) minDiscount = Math.max(...discountMatches);
      if (!minDiscount) minDiscount = 10;
      let editMode = 'price';
      if (radioInputs.length >= 2 && /VIP档|普通档/.test(discountText)) editMode = 'vip_discount';
      if (!idx || !skc || textInputs.length < 1) continue;
      rows.push({idx, skc, supplierNo, currentPrice, minDiscount, editMode, goodsName: info.slice(0, 200)});
    }
    return rows;
  `);
}

async function fillVisibleRows(cdp, sessionId, fills) {
  return await evalJs(cdp, sessionId, `
    const fills = new Map(__arg.map(x => [Number(x.idx), x]));
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const setNativeValue = (el, value) => {
      const v = String(value);
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      el.dispatchEvent(new FocusEvent('blur', {bubbles:true}));
    };
    const clickInput = el => {
      if (!el) return;
      el.click();
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
    };
    const done = [];
    for (const tr of document.querySelectorAll('tr')) {
      const cells = [...tr.querySelectorAll('td')].map(td => td.innerText || '');
      const rowText = tr.innerText || cells.join('\\n');
      const idx = Number(((cells[0] || rowText).match(/\\d+/) || [])[0]);
      if (!fills.has(idx)) continue;
      const inputs = [...tr.querySelectorAll('input')];
      const textInputs = inputs.filter(x => /^(text|number)$/.test(x.type || 'text'));
      const radioInputs = inputs.filter(x => x.type === 'radio');
      if (textInputs.length < 1) continue;
      const f = fills.get(idx);
      if (f.editMode === 'vip_discount') {
        clickInput(radioInputs[1] || radioInputs[0]);
        await sleep(30);
        const freshTextInputs = [...tr.querySelectorAll('input')].filter(x => /^(text|number)$/.test(x.type || 'text'));
        const discountInput = freshTextInputs.find(x => !String(x.className || '').includes('ant-input-number-input')) || freshTextInputs[0];
        setNativeValue(discountInput, String(f.discountPct));
        await sleep(160);
        done.push({idx, price: f.targetPriceText, discount: String(f.discountPct), editMode: f.editMode});
      } else {
        const priceInput = textInputs[0];
        const discountInput = textInputs[1] || inputs[1];
        setNativeValue(discountInput, String(f.discountPct));
        await sleep(30);
        setNativeValue(priceInput, f.targetPriceText);
        await sleep(220);
        if (f.ruleType === 'fixed_price') {
          setNativeValue(priceInput, f.targetPriceText);
          await sleep(80);
        }
        done.push({idx, price: f.targetPriceText, discount: String(f.discountPct), editMode: f.editMode || 'price'});
      }
    }
    return done;
  `, fills);
}

async function getScrollInfo(cdp, sessionId) {
  return await evalJs(cdp, sessionId, `
    const candidates = [...document.querySelectorAll('div,main,section')]
      .filter(el => el.querySelectorAll('tr input').length >= 2)
      .sort((a,b) => (b.scrollHeight-b.clientHeight) - (a.scrollHeight-a.clientHeight));
    const el = candidates.find(x => x.scrollHeight > x.clientHeight + 50);
    if (!el) return {hasScroller:false, max:0, candidates:candidates.slice(0,5).map(x => ({tag:x.tagName, cls:String(x.className || '').slice(0,80), scrollHeight:x.scrollHeight, clientHeight:x.clientHeight, inputs:x.querySelectorAll('tr input').length}))};
    return {hasScroller:true, max: Math.max(0, el.scrollHeight - el.clientHeight), tag:el.tagName, cls:String(el.className || '').slice(0,120), inputs:el.querySelectorAll('tr input').length};
  `);
}

async function scrollTo(cdp, sessionId, top) {
  return await evalJs(cdp, sessionId, `
    const candidates = [...document.querySelectorAll('div,main,section')]
      .filter(el => el.querySelectorAll('tr input').length >= 2 && el.scrollHeight > el.clientHeight + 50)
      .sort((a,b) => (b.scrollHeight-b.clientHeight) - (a.scrollHeight-a.clientHeight));
    const el = candidates[0];
    if (el) {
      el.scrollTop = __arg;
      el.dispatchEvent(new Event('scroll', {bubbles:true}));
    } else {
      window.scrollTo(0, __arg);
    }
    return true;
  `, top);
}

async function fillEditPage(cdp, sessionId, storeKey, activityId) {
  const ready = await waitFor(cdp, sessionId, `document.body && document.body.innerText.includes('提报的活动价格')`, 30_000);
  if (!ready) return {ok: false, reason: '编辑页未加载'};
  const rowEditorReady = await waitFor(cdp, sessionId, `
    [...document.querySelectorAll('tr')].some(tr => {
      const cells = tr.querySelectorAll('td');
      const textInputs = [...tr.querySelectorAll('input')].filter(x => /^(text|number)$/.test(x.type || 'text'));
      return cells.length >= 6 && textInputs.length >= 1;
    })
  `, 60_000);
  if (!rowEditorReady) return {ok: false, reason: '编辑表格未加载'};
  await sleep(1500);

  const expectedTotal = await evalJs(cdp, sessionId, `
    const m = (document.body.innerText || '').match(/总计\\s*(\\d+)\\s*个/);
    return m ? Number(m[1]) : 0;
  `).catch(() => 0);

  const targets = new Map();
  const missingCost = new Map();
  const filled = new Map();
  const seenRows = new Map();
  let top = 0;
  for (let guard = 0; guard < 120; guard++) {
    const scroll = await getScrollInfo(cdp, sessionId);
    const max = scroll.hasScroller ? scroll.max : 0;
    await scrollTo(cdp, sessionId, top);
    await sleep(250);
    const rows = await collectVisibleRows(cdp, sessionId);
    const fills = [];
    for (const row of rows) {
      seenRows.set(row.idx, row);
      const computed = computeTarget(storeKey, activityId, row);
      if (!computed.ok) {
        missingCost.set(row.idx, {...row, ...computed});
        continue;
      }
      const full = {...row, ...computed};
      targets.set(row.idx, full);
      fills.push(full);
    }
    const done = await fillVisibleRows(cdp, sessionId, fills);
    for (const d of done) filled.set(d.idx, d);
    const covered = new Set([...targets.keys(), ...missingCost.keys()]).size;
    if (expectedTotal && covered >= expectedTotal) break;
    if (!scroll.hasScroller || top >= max) break;
    top = Math.min(top + 450, max);
  }

  // 二次复核
  const verifyRows = new Map();
  top = 0;
  for (let guard = 0; guard < 120; guard++) {
    const scroll = await getScrollInfo(cdp, sessionId);
    const max = scroll.hasScroller ? scroll.max : 0;
    await scrollTo(cdp, sessionId, top);
    await sleep(200);
    const rows = await evalJs(cdp, sessionId, `
      const rows = [];
      for (const tr of document.querySelectorAll('tr')) {
        const cells = [...tr.querySelectorAll('td')].map(td => td.innerText || '');
        const rowText = tr.innerText || cells.join('\\n');
        const idx = Number(((cells[0] || rowText).match(/\\d+/) || [])[0]);
        const inputs = [...tr.querySelectorAll('input')];
        const textInputs = inputs.filter(x => /^(text|number)$/.test(x.type || 'text'));
        const radioInputs = inputs.filter(x => x.type === 'radio');
        if (!idx || textInputs.length < 1) continue;
        const discountText = cells.join(' ');
        const editMode = radioInputs.length >= 2 && /VIP档|普通档/.test(discountText) ? 'vip_discount' : 'price';
        if (editMode === 'vip_discount') {
          const discountInput = textInputs.find(x => !String(x.className || '').includes('ant-input-number-input')) || textInputs[0];
          const priceInput = textInputs.find(x => String(x.className || '').includes('ant-input-number-input')) || textInputs[1];
          rows.push({idx, price: priceInput?.value || '', discount: String(parseInt(discountInput?.value || '', 10)), editMode});
        } else rows.push({idx, price: textInputs[0].value, discount: String(parseInt((textInputs[1] || inputs[1]).value, 10)), editMode});
      }
      return rows;
    `);
    for (const r of rows) verifyRows.set(r.idx, r);
    if (expectedTotal && verifyRows.size >= expectedTotal) break;
    if (!scroll.hasScroller || top >= max) break;
    top = Math.min(top + 450, max);
  }
  const mismatches = [];
  const platformRewrites = [];
  for (const [idx, t] of targets.entries()) {
    const r = verifyRows.get(idx);
    const expectedByDiscount = floor2(t.currentPrice * (1 - t.discountPct / 100)).toFixed(2);
    if (t.editMode === 'vip_discount') {
      const actualPriceNum = Number(r?.price);
      const targetPriceNum = Number(t.targetPriceText);
      const discountPriceNum = Number(expectedByDiscount);
      const priceOk = r && Number.isFinite(actualPriceNum) && (
        Math.abs(actualPriceNum - targetPriceNum) <= 0.55 ||
        Math.abs(actualPriceNum - discountPriceNum) <= 0.55
      );
      const discountOk = r && r.discount === String(t.discountPct);
      if (!r || (!priceOk && !discountOk)) {
        mismatches.push({idx, expectedPrice: t.targetPriceText, actualPrice: r?.price, expectedDiscount: String(t.discountPct), actualDiscount: r?.discount, supplierNo: t.supplierNo, skc: t.skc, editMode: t.editMode});
      }
      continue;
    }
    if (r && r.price === expectedByDiscount && r.discount === String(t.discountPct) && r.price !== t.targetPriceText) {
      platformRewrites.push({idx, expectedPrice: t.targetPriceText, actualPrice: r.price, discount: String(t.discountPct), supplierNo: t.supplierNo, skc: t.skc});
      continue;
    }
    if (!r || r.price !== t.targetPriceText || r.discount !== String(t.discountPct)) {
      mismatches.push({idx, expectedPrice: t.targetPriceText, actualPrice: r?.price, expectedDiscount: String(t.discountPct), actualDiscount: r?.discount, supplierNo: t.supplierNo, skc: t.skc});
    }
  }
  const coverageCount = new Set([...targets.keys(), ...missingCost.keys()]).size;
  const coverageOk = !expectedTotal || coverageCount >= expectedTotal;
  return {
    ok: missingCost.size === 0 && mismatches.length === 0 && coverageOk,
    expectedTotal,
    coverageCount,
    targetCount: targets.size,
    filledCount: filled.size,
    verifyCount: verifyRows.size,
    missingCost: [...missingCost.values()].sort((a,b) => a.idx - b.idx),
    mismatches,
    platformRewrites,
    platformAdjusted: [...targets.values()].filter(x => x.platformAdjusted),
    targets: [...targets.values()].sort((a,b) => a.idx - b.idx),
  };
}

async function processActivity(cdp, store, activity) {
  const url = `${LIST_URL.replace('/list', `/sign-up/config/${activity.activityId}`)}`;
  const {sessionId} = await newPage(cdp, url);
  const loaded = await waitFor(cdp, sessionId, `
    document.body && (
      document.body.innerText.includes('可报名商品') ||
      document.body.innerText.includes('提报的活动价格') ||
      document.body.innerText.includes('不可报名商品')
    )
  `, 35_000);
  if (!loaded) return {ok: false, store: store.storeKey, activity, reason: '活动页面未加载'};

  const selection = await selectAllGoodsAndNext(cdp, sessionId);
  if (!selection.ok) return {ok: false, store: store.storeKey, activity, selection, reason: selection.reason || '选择商品失败'};

  const fill = await fillEditPage(cdp, sessionId, store.storeKey, activity.activityId);
  const currentUrl = await evalJs(cdp, sessionId, `return location.href;`).catch(() => '');
  return {ok: fill.ok, store: store.storeKey, activity, selection, fill, url: currentUrl};
}

const selectedStores = STORES.filter(s => s.groupKey === 'DSY' && s.enabled)
  .filter(s => s.storeKey !== 'MZ' || args.stores.includes('MZ'))
  .filter(s => !args.stores.length || args.stores.includes(s.storeKey));

const summary = {
  createdAt: new Date().toISOString(),
  now: now.toISOString(),
  hours: args.hours,
  allOpen: args.allOpen,
  includeCoupon: args.includeCoupon,
  stores: [],
};

for (const store of selectedStores) {
  console.log(`\n[${store.storeKey}] 打开可见前端浏览器并检查活动...`);
  if (!args.noClose) {
    closeExistingStoreChrome(store);
    await sleep(2500);
    launchVisible(store);
    await sleep(3500);
  }
  bringStoreWindowToFront(store);
  await sleep(800);
  const cdp = await connectStore(store);
  try {
    const listPage = await newPage(cdp, LIST_URL);
    const activities = await fetchActivities(cdp, listPage.sessionId);
    await cdp.call('Target.closeTarget', {targetId: listPage.targetId}).catch(() => {});
    const due = activities.filter(withinDeadline);
    const storeResult = {store: store.storeKey, shopName: store.shopName, port: store.port, dueActivities: due, results: []};
    summary.stores.push(storeResult);
    const scopeLabel = args.allOpen ? '所有未截止可报名活动' : (args.activityIds.length ? '指定活动' : `${args.hours}小时内截止活动`);
    console.log(`[${store.storeKey}] ${scopeLabel}：${due.map(a => `${a.activityId}-${a.name}`).join('；') || '无'}`);
    for (const activity of due) {
      console.log(`[${store.storeKey}] 处理 ${activity.activityId} ${activity.name}`);
      const result = await processActivity(cdp, store, activity).catch(err => ({ok: false, store: store.storeKey, activity, reason: err.message, stack: err.stack}));
      storeResult.results.push(result);
      const file = path.join(OUT_DIR, `${store.storeKey}-${activity.activityId}.json`);
      await fs.writeFile(file, JSON.stringify(result, null, 2), 'utf8');
      console.log(`[${store.storeKey}] ${activity.activityId} ${result.ok ? '完成' : '异常'} ${result.reason || ''}`);
    }
  } catch (err) {
    summary.stores.push({store: store.storeKey, shopName: store.shopName, port: store.port, error: err.message, stack: err.stack});
    console.log(`[${store.storeKey}] 异常：${err.message}`);
  } finally {
    cdp.close();
  }
}

const summaryFile = path.join(OUT_DIR, `summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2), 'utf8');
console.log(`\nSUMMARY ${summaryFile}`);
