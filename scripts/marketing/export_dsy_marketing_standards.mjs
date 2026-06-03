import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {normalizeGoodsSnDetailed} from '../../lib/product_sku_normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIST_URL = 'https://sso.geiwohuo.com/#/mbrs/marketing/list';
const OUT_DIR = path.join(ROOT, 'outputs', 'reports');
const TMP_DIR = path.join(ROOT, 'tmp', 'mbrs', 'standards');
const STORES = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8')).stores;
const COST_DOC = JSON.parse(await fs.readFile(path.join(ROOT, 'tmp', 'mbrs', 'marketing-cost-map.json'), 'utf8'));
const COSTS = COST_DOC.costMap || {};
const TRUE_COSTS = COST_DOC.trueCostMap || {};
const BI = JSON.parse(await fs.readFile(path.join(ROOT, 'outputs', 'bi-portal', 'data.json'), 'utf8'));

const args = parseArgs(process.argv.slice(2));
const now = new Date();
const deadlineMs = now.getTime() + args.hours * 3600_000;
const dateTag = formatDate(now);

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

const fixedPriceRules = new Map();
for (const [label, value] of fixedPriceBase) registerRuleKeys(fixedPriceRules, label, value);

const depletionByStandard = new Map();
for (const p of BI.inventoryDepletion?.products || []) {
  if (p.standard_goods_sn) depletionByStandard.set(compact(p.standard_goods_sn), p);
}

function parseArgs(argv) {
  const out = {stores: [], hours: 48, allOpen: false, includeCoupon: false, visible: true, noClose: false};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stores') out.stores = String(argv[++i] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--hours') out.hours = Number(argv[++i] || 48);
    else if (a === '--all-open') out.allOpen = true;
    else if (a === '--include-coupon') out.includeCoupon = true;
    else if (a === '--headless') out.visible = false;
    else if (a === '--no-close') out.noClose = true;
  }
  return out;
}

function formatDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function compact(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, '').replace(/[()（）【】\[\]_:：/\\-]/g, '').toUpperCase();
}

function modelCode(s) {
  return String(s || '').match(/^[A-Z]{1,5}-?\d+[A-Z]?(?:-\d+)?/i)?.[0] || '';
}

function registerRuleKeys(map, label, value) {
  const normalized = normalizeGoodsSnDetailed(label, {goodsTitle: label});
  const keys = [label, normalized.canonical, modelCode(label), modelCode(normalized.canonical)]
    .map(compact)
    .filter(Boolean);
  for (const key of keys) map.set(key, value);
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

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function floor2(n) {
  return Math.floor((Number(n) + 1e-9) * 100) / 100;
}

function numValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace('%', '').replace(',', '').trim());
  return Number.isFinite(n) ? n : null;
}

function parseTime(s) {
  if (!s || s === '长期有效') return null;
  const raw = String(s).trim();
  const d = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)
    ? new Date(raw.replace(/\//g, '-').replace(' ', 'T'))
    : new Date(raw.replace(/\//g, '-').replace(' ', 'T') + '+08:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

function isCouponActivity(a) {
  const text = [a.name, a.label, a.backendCate].filter(Boolean).join(' ');
  return /coupon|优惠券/i.test(text);
}

function withinScope(a) {
  if (!args.includeCoupon && isCouponActivity(a)) return false;
  if (a.allowGoodsNum <= 0) return false;
  if (a.applyGoodsNum >= a.allowGoodsNum) return false;
  const end = parseTime(a.signEnd);
  if (!end || end.getTime() < now.getTime()) return false;
  if (args.allOpen) return true;
  return end.getTime() <= deadlineMs;
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

function launchStore(store) {
  const params = [
    path.join(ROOT, 'scripts', 'launch_store_browser.mjs'),
    store.storeKey,
    args.visible ? '--visible' : '--background',
    '--url',
    LIST_URL,
  ];
  const r = spawnSync(process.execPath, params, {cwd: ROOT, encoding: 'utf8', timeout: 25_000});
  if (r.status !== 0) throw new Error(`launch browser failed for ${store.storeKey}: ${r.stderr || r.stdout}`);
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return await res.json();
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
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
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  call(method, params = {}, sessionId) {
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
      }, 45_000);
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
  await cdp.call('Target.setDiscoverTargets', {discover: true});
  return cdp;
}

async function newPage(cdp, url) {
  const {targetId} = await cdp.call('Target.createTarget', {url, newWindow: false});
  const {sessionId} = await cdp.call('Target.attachToTarget', {targetId, flatten: true});
  await cdp.call('Page.enable', {}, sessionId);
  await cdp.call('Runtime.enable', {}, sessionId);
  return {targetId, sessionId};
}

async function evalJs(cdp, sessionId, body, arg = undefined) {
  const encoded = arg === undefined ? 'undefined' : JSON.stringify(arg).replace(/</g, '\\u003c');
  const expression = `(async () => { const __arg = ${encoded}; ${body} })()`;
  const res = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'Runtime.evaluate failed');
  return res.result?.value;
}

async function waitFor(cdp, sessionId, predicateBody, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await evalJs(cdp, sessionId, `return Boolean(${predicateBody});`).catch(() => false);
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function realClick(cdp, sessionId, rect) {
  const x = rect.x + (rect.w || 0) / 2;
  const y = rect.y + (rect.h || 0) / 2;
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y}, sessionId);
  await cdp.call('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1}, sessionId);
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1}, sessionId);
}

async function setPageSize500(cdp, sessionId) {
  const before = await evalJs(cdp, sessionId, `
    const textOf = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const rectOf = el => {
      const r = el.getBoundingClientRect();
      return {x: r.left, y: r.top, w: r.width, h: r.height};
    };
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
    return {currentText: textOf(current), rect: current ? rectOf(current) : null};
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
      .map(el => ({rect: rectOf(el), text: textOf(el), cls: String(el.className || ''), tag: el.tagName}))
      .filter(x => x.rect.w > 0 && x.rect.h > 0)
      .sort((a,b) => ((a.tag === 'LI' ? 0 : 1) - (b.tag === 'LI' ? 0 : 1)));
    return options[0] || null;
  `);
  if (!option?.rect) return {ok: false, changed: false, reason: '未找到500条/页选项', before};
  await realClick(cdp, sessionId, option.rect);
  await sleep(1200);
  return {ok: true, changed: true, before, optionText: option.text};
}

async function fetchActivities(cdp, sessionId) {
  await waitFor(cdp, sessionId, `document.body && document.body.innerText.includes('营销活动报名')`, 30_000);
  const pages = await evalJs(cdp, sessionId, `
    const pages = [];
    for (let page = 1; page <= 20; page += 1) {
      const r = await fetch('/mrs-api-prefix/mbrs/activity/get_activity_list?page_num=' + page + '&page_size=100', {
        method: 'POST',
        credentials: 'include',
        headers: {'content-type': 'application/json'},
        body: '{}',
      });
      const json = await r.json();
      const list = json?.info?.activity_detail_list || [];
      pages.push({page, list});
      if (list.length < 100) break;
    }
    return pages;
  `);
  const seen = new Set();
  const list = [];
  for (const page of pages || []) {
    for (const activity of page.list || []) {
      const id = Number(activity.activity_id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      list.push(activity);
    }
  }
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

async function collectChooseRows(cdp, sessionId) {
  const ready = await waitFor(cdp, sessionId, `document.body && (document.body.innerText.includes('可报名商品') || document.body.innerText.includes('提报的活动价格'))`, 30_000);
  if (!ready) return {ok: false, reason: '商品页未加载', rows: []};
  const mode = await evalJs(cdp, sessionId, `
    const t = document.body.innerText || '';
    if (t.includes('提报的活动价格')) return 'edit';
    if (t.includes('可报名商品')) return 'choose';
    return 'unknown';
  `);
  if (mode !== 'choose') return {ok: false, reason: `非选择页：${mode}`, rows: [], mode};
  const pageSize = await setPageSize500(cdp, sessionId).catch(err => ({ok: false, reason: err.message}));
  await sleep(500);
  const apiRows = await evalJs(cdp, sessionId, `
    const activityId = Number((location.hash.match(/config\\/(\\d+)/) || [])[1] || 0);
    const body = {
      activity_id: activityId,
      is_partake: 0,
      main_site: 'shein',
      pricing_currency_code: 'SAR',
      skc_query: {grade_tree_list: []}
    };
    const r = await fetch('/mrs-api-prefix/mbrs/activity/query_supplier_goods_list_v2?page_num=1&page_size=500', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'Origin-Url': location.href,
        'x-bbl-route': location.hash.replace(/^#/, ''),
        'x-req-zone-id': 'Asia/Shanghai',
        'x-lt-language': 'CN',
        'LAN': 'CN'
      },
      body: JSON.stringify(body)
    });
    const json = await r.json();
    const list = json?.info?.partake_goods_list || [];
    const totalGoods = Number(json?.info?.total || list.length || 0);
    return {
      code: json?.code,
      msg: json?.msg,
      totalGoods,
      rows: list.map((g, i) => {
        const minDiscount = Number(g.final_min_sell_price_rate || g.min_sell_price_rate || g.min_special_sell_price_rate || g.lowest_sale_price_thirty_day_rate || 0);
        return {
          idx: i + 1,
          skc: g.skc || '',
          supplierNo: g.supplier_no || '',
          sku: '',
          currentPrice: Number(g.current_cost || g.current_cost_display?.value || g.shop_price || g.special_price || 0),
          minDiscount: minDiscount || 10,
          goodsName: [g.goods_name || '', g.supplier_no || '', g.grade_tree || ''].filter(Boolean).join('\\n').slice(0, 260),
          apiRaw: {
            gradeTree: g.grade_tree || '',
            currentCostStr: g.current_cost_str || '',
            finalMinSellPriceRate: g.final_min_sell_price_rate ?? null,
            minSellPriceRate: g.min_sell_price_rate ?? null
          }
        };
      })
    };
  `).catch(err => ({code: 'ERR', msg: err.message, rows: [], totalGoods: 0}));
  if (apiRows.rows?.length) {
    return {
      ok: !apiRows.totalGoods || apiRows.rows.length >= apiRows.totalGoods,
      rows: apiRows.rows,
      totalGoods: apiRows.totalGoods,
      pageSize,
      source: 'api',
      reason: apiRows.totalGoods && apiRows.rows.length < apiRows.totalGoods ? `接口只返回 ${apiRows.rows.length}/${apiRows.totalGoods} 行` : undefined,
    };
  }

  const rows = new Map();
  let stagnant = 0;
  let lastSize = 0;
  let lastMeta = {};
  for (let guard = 0; guard < 180; guard += 1) {
    const batch = await evalJs(cdp, sessionId, `
      const rows = [];
      const textOf = el => String(el?.innerText || el?.textContent || '').trim();
      for (const tr of document.querySelectorAll('tr')) {
        const cells = [...tr.querySelectorAll('td')].map(td => td.innerText || '');
        if (cells.length < 4) continue;
        const rowText = tr.innerText || cells.join('\\n');
        const idx = Number(((cells[0] || rowText).match(/\\d+/) || [])[0]);
        const skc = (rowText.match(/SKC:\\s*([a-z]{2}\\d+)/i) || [])[1] || '';
        const supplierNo = (rowText.match(/供方货号:\\s*([^\\n\\t]+)/) || [])[1]?.trim() || '';
        const sku = (rowText.match(/SKU:\\s*([^\\n\\t]+)/) || [])[1]?.trim() || '';
        const priceCell = cells.find(c => /SAR\\s*[\\d.]+/i.test(c)) || '';
        const currentPrice = Number((priceCell.match(/SAR\\s*([\\d.]+)/i) || rowText.match(/SAR\\s*([\\d.]+)/i) || [])[1] || 0);
        const discountMatches = [...rowText.matchAll(/(\\d+(?:\\.\\d+)?)%\\s*价格降幅/g)].map(m => Number(m[1]));
        let minDiscount = Number((rowText.match(/降幅要求[:：]\\s*(\\d+(?:\\.\\d+)?)%/) || [])[1] || 0);
        if (!minDiscount && discountMatches.length) minDiscount = Math.max(...discountMatches);
        if (!minDiscount) minDiscount = 10;
        if (!idx || !skc) continue;
        rows.push({idx, skc, supplierNo, sku, currentPrice, minDiscount, goodsName: rowText.slice(0, 260)});
      }
      const scrollers = [...document.querySelectorAll('div,main,section')]
        .filter(el => el.scrollHeight > el.clientHeight + 40)
        .map((el, i) => {
          if (!el.dataset.mbrsScrollId) el.dataset.mbrsScrollId = 's' + i + '-' + Math.random().toString(36).slice(2);
          const r = el.getBoundingClientRect();
          return {
            id: el.dataset.mbrsScrollId,
            tr: el.querySelectorAll('tr').length,
            cb: el.querySelectorAll('tr input[type=checkbox]').length,
            top: el.scrollTop,
            max: Math.max(0, el.scrollHeight - el.clientHeight),
            area: Math.round(r.width * r.height),
            y: Math.round(r.top),
            h: Math.round(r.height)
          };
        })
        .filter(x => x.tr >= 2 || x.cb >= 2)
        .sort((a,b) => (b.cb - a.cb) || (b.tr - a.tr) || (b.max - a.max));
      const totalText = ([...document.querySelectorAll('*')].map(textOf).find(t => /总计\\s*\\d+\\s*个/.test(t)) || '');
      const totalGoods = Number((totalText.match(/总计\\s*(\\d+)\\s*个/) || [])[1] || 0);
      const best = scrollers[0] || null;
      return {rows, totalGoods, scrollers, scrollTop: best?.top || 0, max: best?.max || 0};
    `);
    for (const row of batch.rows || []) rows.set(row.idx, row);
    lastMeta = batch;
    if (batch.totalGoods && rows.size >= batch.totalGoods) {
      return {ok: true, rows: [...rows.values()].sort((a,b) => a.idx - b.idx), totalGoods: batch.totalGoods, pageSize};
    }
    stagnant = rows.size === lastSize ? stagnant + 1 : 0;
    lastSize = rows.size;
    if ((!batch.scrollers || !batch.scrollers.length) && stagnant >= 6) break;
    if (stagnant >= 18) break;
    await evalJs(cdp, sessionId, `
      const candidates = [...document.querySelectorAll('div,main,section')]
        .filter(el => (el.querySelectorAll('tr').length >= 2 || el.querySelectorAll('tr input[type=checkbox]').length >= 2) && el.scrollHeight > el.clientHeight + 40)
        .sort((a,b) => (b.querySelectorAll('tr input[type=checkbox]').length - a.querySelectorAll('tr input[type=checkbox]').length)
          || (b.querySelectorAll('tr').length - a.querySelectorAll('tr').length)
          || ((b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight)));
      for (const scroller of candidates.slice(0, 4)) {
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const next = Math.min(scroller.scrollTop + Math.max(300, Math.round(scroller.clientHeight * 0.72)), max);
        if (next === scroller.scrollTop && scroller.scrollTop >= max - 2) scroller.scrollTop = 0;
        else scroller.scrollTop = next;
        scroller.dispatchEvent(new Event('scroll', {bubbles:true}));
        scroller.dispatchEvent(new WheelEvent('wheel', {bubbles:true, deltaY: 360}));
      }
      window.scrollBy(0, 260);
      return true;
    `);
    await cdp.call('Input.dispatchMouseEvent', {type: 'mouseWheel', x: 900, y: 560, deltaY: 520}, sessionId).catch(() => {});
    await sleep(360);
  }
  const totalGoods = lastMeta?.totalGoods || 0;
  const ok = totalGoods ? rows.size >= totalGoods : rows.size > 0;
  return {ok, rows: [...rows.values()].sort((a,b) => a.idx - b.idx), totalGoods, pageSize, reason: ok ? undefined : `虚拟表格只采集到 ${rows.size}/${totalGoods || '?'} 行`};
}

function lookupCost(keys) {
  for (const key of keys) {
    if (COSTS[key] !== undefined) return Number(COSTS[key]);
    const c = compact(key);
    if (COSTS[c] !== undefined) return Number(COSTS[c]);
  }
  return null;
}

function lookupTrueCost(keys) {
  for (const key of keys) {
    if (TRUE_COSTS[key]) return TRUE_COSTS[key];
    const c = compact(key);
    if (TRUE_COSTS[c]) return TRUE_COSTS[c];
  }
  return null;
}

function classifyAndPrice(storeKey, activityId, row) {
  const normalized = normalizeGoodsSnDetailed(row.supplierNo, {goodsTitle: row.goodsName || ''});
  const canonical = normalized.canonical || row.supplierNo || '';
  const keysRaw = [row.supplierNo, canonical, modelCode(row.supplierNo), modelCode(canonical), normalized.rawGoodsSn].filter(Boolean);
  const keysCompact = keysRaw.map(compact).filter(Boolean);
  const fixed = keysCompact.map(k => fixedPriceRules.get(k)).find(v => v !== undefined);
  const depletion = depletionByStandard.get(compact(canonical)) || depletionByStandard.get(compact(row.supplierNo));
  const trueCostInfo = lookupTrueCost(keysRaw);
  const baseCost = lookupCost(keysRaw) ?? numValue(depletion?.unit_cost_sar);
  const cost = numValue(trueCostInfo?.trueUnitCostSar)
    ?? numValue(trueCostInfo?.unitCostSar)
    ?? numValue(trueCostInfo?.productUnitCostSar)
    ?? baseCost;
  const storageUnitCostSar = numValue(trueCostInfo?.storageUnitCostSar)
    ?? numValue(trueCostInfo?.storageUnitCostSar30d);
  const storageMethod = trueCostInfo?.storageMethod || '';
  const onHand = Number(depletion?.estimated_on_hand_quantity ?? 0);
  const daysOnHand = Number(depletion?.days_of_supply_on_hand ?? 0);
  const weightedDailySales = Number(depletion?.weighted_daily_gross_sales ?? 0);
  const seed = `${storeKey}:${activityId}:${row.skc}:${canonical}`;

  let rule = '默认30%利润率';
  let targetMargin = 0.30;
  let basePrice = null;
  let randomNote = '';
  let needsReview = '';
  if (fixed !== undefined) {
    rule = '用户明确固定价';
    basePrice = Number(fixed);
    targetMargin = null;
    randomNote = '固定价按基准价随机 -2/+1 SAR';
  } else if (onHand > 0 && daysOnHand > 180) {
    rule = '在仓库存去化>6个月：15%利润率';
    targetMargin = 0.15;
  } else if (onHand > 0 && daysOnHand > 90) {
    rule = '在仓库存去化>3且<=6个月：23%-27%利润率';
    targetMargin = randomBetween(seed, 0.23, 0.27);
    randomNote = '按店铺/活动/商品稳定随机';
  }

  let targetPrice = null;
  if (basePrice !== null) {
    targetPrice = round2(basePrice + randomBetween(seed, -2, 1));
  } else if (cost && targetMargin !== null) {
    targetPrice = round2(cost / (1 - targetMargin));
  } else {
    needsReview = '缺成本，无法按利润率自动定价';
  }

  const platformMax = row.currentPrice > 0 ? floor2(row.currentPrice * (1 - row.minDiscount / 100)) : null;
  let platformAdjusted = false;
  if (targetPrice !== null && platformMax !== null && targetPrice > platformMax) {
    targetPrice = platformMax;
    platformAdjusted = true;
  }
  const projectedMargin = cost && targetPrice ? (targetPrice - cost) / targetPrice : null;
  const discountPct = row.currentPrice > 0 && targetPrice !== null
    ? Math.max(row.minDiscount, Math.floor((1 - targetPrice / row.currentPrice) * 100 + 1e-9))
    : null;

  return {
    canonical,
    normalized,
    cost,
    baseCost,
    storageUnitCostSar,
    storageMethod,
    depletion,
    onHand,
    daysOnHand,
    weightedDailySales,
    rule,
    targetMargin,
    targetPrice,
    platformMax,
    platformAdjusted,
    projectedMargin,
    discountPct,
    randomNote,
    needsReview,
  };
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function pct(v) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? '' : `${round2(Number(v) * 100)}%`;
}

function num(v) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? '' : round2(Number(v));
}

function rangeText(values, digits = 0) {
  const nums = values.map(v => Number(v)).filter(v => Number.isFinite(v));
  if (!nums.length) return '';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const fmt = v => digits > 0 ? v.toFixed(digits) : String(Math.round(v));
  return min === max ? fmt(min) : `${fmt(min)}-${fmt(max)}`;
}

function mostCommon(values) {
  const counts = new Map();
  for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function summarizeBySku(rows) {
  const bySku = new Map();
  for (const row of rows) {
    const key = row['标准货号'] || row['供方货号'] || row.SKC;
    if (!bySku.has(key)) bySku.set(key, []);
    bySku.get(key).push(row);
  }
  const summaryRows = [];
  for (const [sku, group] of bySku) {
    const rule = group.some(r => r['定价规则'] === '用户明确固定价') ? '用户明确固定价'
      : group.some(r => String(r['定价规则']).includes('>6个月')) ? '在仓去化>6个月：15%利润率'
      : group.some(r => String(r['定价规则']).includes('>3且<=6个月')) ? '在仓去化>3且<=6个月：23%-27%利润率'
      : mostCommon(group.map(r => r['定价规则']));
    const fixedBase = fixedPriceRules.get(compact(sku)) ?? fixedPriceRules.get(compact(modelCode(sku)));
    const standard = fixedBase !== undefined ? `固定基准价 ${fixedBase} SAR；执行时允许 -2/+1 SAR 小幅浮动`
      : rule.includes('15%') ? '按 15% 利润率报；执行时可小幅随机浮动'
      : rule.includes('23%-27%') ? '按 23%-27% 利润率随机报；每个店铺可有差异'
      : '按默认 30% 利润率报；执行时可在 28%-31% 间小幅浮动';
    const stores = [...new Set(group.map(r => r['店铺']))].sort();
    const activities = [...new Set(group.map(r => String(r['活动ID'])))].sort((a,b) => Number(a) - Number(b));
    const platformRewrites = group.filter(r => r['平台折扣压价'] === '是').length;
    const issues = [...new Set(group.map(r => r['异常/待复核']).filter(Boolean))];
    summaryRows.push({
      '标准货号': sku,
      '代表供方货号': mostCommon(group.map(r => r['供方货号'])),
      '适用店铺数': stores.length,
      '适用店铺': stores.join(','),
      '涉及活动数': activities.length,
      '活动ID': activities.join(','),
      '明细商品行数': group.length,
      '定价标准': rule,
      '审核用价格/利润率口径': standard,
      '参考成本SAR': rangeText(group.map(r => r['含仓储成本SAR'] || r['成本SAR']), 1),
      '商品成本SAR': rangeText(group.map(r => r['商品成本SAR']), 1),
      '仓储成本SAR/件': rangeText(group.map(r => r['仓储成本SAR/件']), 2),
      '仓储口径': mostCommon(group.map(r => r['仓储口径'])),
      '在仓库存范围': rangeText(group.map(r => r['在仓剩余库存']), 0),
      '去化周期月范围': rangeText(group.map(r => r['去化周期月']), 1),
      '执行时预计活动价SAR范围': rangeText(group.map(r => r['建议活动价SAR']), 0),
      '平台压价情况': platformRewrites ? `${platformRewrites}/${group.length} 行会被平台最低折扣压低` : '',
      '异常/待复核': issues.slice(0, 3).join('；') + (issues.length > 3 ? '；...' : ''),
      '修改意见/备注': '',
    });
  }
  return summaryRows.sort((a, b) => String(a['标准货号']).localeCompare(String(b['标准货号']), 'zh-Hans-CN'));
}

const selectedStores = STORES.filter(s => s.groupKey === 'DSY' && s.enabled)
  .filter(s => !args.stores.length || args.stores.includes(s.storeKey));

await fs.mkdir(OUT_DIR, {recursive: true});
await fs.mkdir(TMP_DIR, {recursive: true});

const allRows = [];
const audit = {createdAt: now.toISOString(), args, stores: []};

for (const store of selectedStores) {
  console.log(`\n[${store.storeKey}] 只读扫描活动商品...`);
  if (!args.noClose) {
    closeExistingStoreChrome(store);
    await sleep(2000);
    launchStore(store);
    await sleep(3500);
  }
  const cdp = await connectStore(store);
  try {
    const listPage = await newPage(cdp, LIST_URL);
    const activities = (await fetchActivities(cdp, listPage.sessionId)).filter(withinScope);
    await cdp.call('Target.closeTarget', {targetId: listPage.targetId}).catch(() => {});
    const storeAudit = {store: store.storeKey, activities: []};
    audit.stores.push(storeAudit);
    console.log(`[${store.storeKey}] 待导出活动：${activities.map(a => `${a.activityId}-${a.name}`).join('；') || '无'}`);
    for (const activity of activities) {
      const url = `${LIST_URL.replace('/list', `/sign-up/config/${activity.activityId}`)}`;
      const page = await newPage(cdp, url);
      await waitFor(cdp, page.sessionId, `document.body && (document.body.innerText.includes('可报名商品') || document.body.innerText.includes('提报的活动价格'))`, 30_000);
      const collected = await collectChooseRows(cdp, page.sessionId);
      await cdp.call('Target.closeTarget', {targetId: page.targetId}).catch(() => {});
      storeAudit.activities.push({activity, collected: {ok: collected.ok, totalGoods: collected.totalGoods, rows: collected.rows.length, reason: collected.reason, pageSize: collected.pageSize}});
      console.log(`[${store.storeKey}] ${activity.activityId} ${collected.ok ? 'OK' : 'WARN'} rows=${collected.rows.length}/${collected.totalGoods || ''} ${collected.reason || ''}`);
      for (const row of collected.rows) {
        const priced = classifyAndPrice(store.storeKey, activity.activityId, row);
        allRows.push({
          '店铺': store.storeKey,
          '活动ID': activity.activityId,
          '活动名称': activity.name,
          '报名截止': activity.signEnd,
          '活动开始': activity.eventStart,
          '活动结束': activity.eventEnd,
          '行号': row.idx,
          'SKC': row.skc,
          'SKU': row.sku,
          '供方货号': row.supplierNo,
          '标准货号': priced.canonical,
          '当前售价SAR': num(row.currentPrice),
          '平台最低降幅%': row.minDiscount,
          '成本SAR': num(priced.cost),
          '商品成本SAR': num(priced.baseCost),
          '仓储成本SAR/件': num(priced.storageUnitCostSar),
          '含仓储成本SAR': num(priced.cost),
          '仓储口径': priced.storageMethod || (priced.storageUnitCostSar === null ? '估算缺失' : ''),
          '在仓剩余库存': num(priced.onHand),
          '加权日均销量': num(priced.weightedDailySales),
          '去化周期天': num(priced.daysOnHand),
          '去化周期月': priced.daysOnHand ? num(priced.daysOnHand / 30) : '',
          '定价规则': priced.rule,
          '建议目标利润率': priced.targetMargin === null ? '' : pct(priced.targetMargin),
          '建议活动价SAR': num(priced.targetPrice),
          '预计利润率': priced.projectedMargin === null ? '' : pct(priced.projectedMargin),
          '建议降幅%': priced.discountPct ?? '',
          '平台折扣压价': priced.platformAdjusted ? '是' : '否',
          '随机/备注': priced.randomNote,
          '异常/待复核': priced.needsReview || (priced.normalized.needsReview ? `货号归并待复核：${priced.normalized.reviewReason}` : ''),
          '修改意见/备注': '',
        });
      }
    }
  } catch (err) {
    audit.stores.push({store: store.storeKey, error: err.message, stack: err.stack});
    console.log(`[${store.storeKey}] 异常：${err.message}`);
  } finally {
    cdp.close();
  }
}

const headers = [
  '店铺','活动ID','活动名称','报名截止','活动开始','活动结束','行号','SKC','SKU','供方货号','标准货号',
  '当前售价SAR','平台最低降幅%','成本SAR','商品成本SAR','仓储成本SAR/件','含仓储成本SAR','仓储口径','在仓剩余库存','加权日均销量','去化周期天','去化周期月',
  '定价规则','建议目标利润率','建议活动价SAR','预计利润率','建议降幅%','平台折扣压价','随机/备注','异常/待复核','修改意见/备注',
];

const csv = [
  headers.join(','),
  ...allRows.map(r => headers.map(h => csvEscape(r[h])).join(',')),
].join('\n');

const csvPath = path.join(OUT_DIR, `marketing-standards-${dateTag}.csv`);
const jsonPath = path.join(OUT_DIR, `marketing-standards-${dateTag}.json`);
const auditPath = path.join(TMP_DIR, `marketing-standards-audit-${dateTag}.json`);
await fs.writeFile(csvPath, '\uFEFF' + csv, 'utf8');
await fs.writeFile(jsonPath, JSON.stringify({createdAt: now.toISOString(), source: {biGeneratedAt: BI.generatedAt, costSource: COST_DOC.source}, rows: allRows}, null, 2), 'utf8');
await fs.writeFile(auditPath, JSON.stringify(audit, null, 2), 'utf8');

const skuRows = summarizeBySku(allRows);
const skuHeaders = [
  '标准货号','代表供方货号','适用店铺数','适用店铺','涉及活动数','活动ID','明细商品行数',
  '定价标准','审核用价格/利润率口径','参考成本SAR','商品成本SAR','仓储成本SAR/件','仓储口径','在仓库存范围','去化周期月范围',
  '执行时预计活动价SAR范围','平台压价情况','异常/待复核','修改意见/备注',
];
const skuCsv = [
  skuHeaders.join(','),
  ...skuRows.map(r => skuHeaders.map(h => csvEscape(r[h])).join(',')),
].join('\n');
const skuCsvPath = path.join(OUT_DIR, `marketing-standards-by-sku-${dateTag}.csv`);
const skuMdPath = path.join(OUT_DIR, `marketing-standards-by-sku-${dateTag}.md`);
await fs.writeFile(skuCsvPath, '\uFEFF' + skuCsv, 'utf8');
await fs.writeFile(skuMdPath, [
  `# DSY 营销活动填报标准（按货号汇总，${dateTag}）`,
  '',
  `- 标准货号行数：${skuRows.length}`,
  `- 来源明细商品行数：${allRows.length}`,
  '- 用途：给用户审核报价标准；不是逐商品执行明细。',
  '',
  `| ${skuHeaders.join(' |')} |`,
  `| ${skuHeaders.map(() => '---').join(' |')} |`,
  ...skuRows.map(r => `| ${skuHeaders.map(h => String(r[h] ?? '').replace(/\|/g, '/')).join(' |')} |`),
  '',
].join('\n'), 'utf8');

const byRule = new Map();
for (const r of allRows) byRule.set(r['定价规则'], (byRule.get(r['定价规则']) || 0) + 1);
const mdPath = path.join(OUT_DIR, `marketing-standards-${dateTag}.md`);
const previewHeaders = ['店铺','活动ID','供方货号','标准货号','成本SAR','在仓剩余库存','去化周期月','定价规则','建议目标利润率','建议活动价SAR','预计利润率','异常/待复核','修改意见/备注'];
const mdLines = [
  `# DSY 营销活动填报标准（${dateTag}）`,
  '',
  '- 状态：仅导出标准，未勾选、未填价、未提交。',
  `- BI 数据时间：${BI.generatedAt || ''}`,
  `- 成本来源：${COST_DOC.source || 'tmp/mbrs/marketing-cost-map.json'}`,
  '- 规则：明确固定价优先；在仓去化 >6 个月按 15%；>3 且 <=6 个月按 23%-27% 店铺差异；其它按 30%。',
  '',
  '## 规则分布',
  '',
  ...[...byRule.entries()].map(([rule, count]) => `- ${rule}: ${count}`),
  '',
  '## 明细预览',
  '',
  `| ${previewHeaders.join(' |')} |`,
  `| ${previewHeaders.map(() => '---').join(' |')} |`,
  ...allRows.slice(0, 120).map(r => `| ${previewHeaders.map(h => String(r[h] ?? '').replace(/\|/g, '/')).join(' |')} |`),
  allRows.length > 120 ? `\n> 仅预览前 120 行；完整表见 CSV/XLSX。` : '',
  '',
];
await fs.writeFile(mdPath, mdLines.join('\n'), 'utf8');

console.log(`\nROWS ${allRows.length}`);
console.log(`CSV ${csvPath}`);
console.log(`JSON ${jsonPath}`);
console.log(`MD ${mdPath}`);
console.log(`SKU_CSV ${skuCsvPath}`);
console.log(`SKU_MD ${skuMdPath}`);
console.log(`AUDIT ${auditPath}`);
