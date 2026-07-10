#!/usr/bin/env node
/**
 * Fetch SHEIN link-management data through an already logged-in Chrome profile.
 *
 * This script is read-only against SHEIN. It collects:
 * - product/link master data from 商品列表
 * - merchandise performance from 数据 -> 商品分析 -> 商品明细
 * - flow-diagnose suggestions from 数据 -> 商品分析 -> 商品流量诊断
 * - display/platform stock from 商品 -> 备货信息
 *
 * Important business note:
 * 备货信息里的库存数量 is treated as SHEIN display/platform stock only.
 * It is NOT real warehouse inventory.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeGoodsSnDetailed, stripLeadingAnnotations, getCatalogConfig} from '../lib/product_sku_normalizer.mjs';
import {connectCdp} from '../lib/shein_browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const OUT_DIR = path.join(ROOT, 'outputs', 'shein_links');
const RAW_DIR = path.join(ROOT, 'outputs', 'shein_links_raw');
const MERCHANDISE_URL = 'https://sso.geiwohuo.com/#/sbn/merchandise/details';

const storesConfig = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));

const STATUS_LABELS = {
  WAIT_SHELF: '待上架',
  ON_SHELF: '已上架',
  SOLD_OUT: '已售罄',
  OUT_SHELF: '已下架',
};
const PRODUCT_STATUSES = ['ON_SHELF', 'WAIT_SHELF', 'SOLD_OUT', 'OUT_SHELF'];
const FLOW_TABS = [
  {tabId: '1880', name: '低曝光', ruleCodeName: 'le'},
  {tabId: '1879', name: '低点击转化', ruleCodeName: 'lcc'},
  {tabId: '1881', name: '低支付转化', ruleCodeName: 'lpc'},
];

function parseArgs(argv) {
  const args = {
    group: 'DSY',
    stores: null,
    date: bjDate(-1),
    pageSize: 100,
    outDir: OUT_DIR,
    rawDir: RAW_DIR,
    saveRaw: true,
    fetchFlowDiagnose: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--group') args.group = argv[++i].toUpperCase();
    else if (a === '--stores') args.stores = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--store') args.stores = [argv[++i].trim().toUpperCase()];
    else if (a === '--page-size') args.pageSize = Number(argv[++i] || 100);
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--raw-dir') args.rawDir = path.resolve(argv[++i]);
    else if (a === '--no-raw') args.saveRaw = false;
    else if (a === '--no-flow-diagnose') args.fetchFlowDiagnose = false;
  }
  return args;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function ymdCompact(ymd) { return String(ymd).replace(/-/g, ''); }
function bjDate(offsetDays = 0) {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
  const bj = new Date(utc + 8 * 3600_000);
  bj.setDate(bj.getDate() + offsetDays);
  return `${bj.getFullYear()}-${pad2(bj.getMonth() + 1)}-${pad2(bj.getDate())}`;
}
function addDays(ymd, delta) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function nowBjString() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60_000;
  const bj = new Date(utc + 8 * 3600_000);
  return `${bj.getFullYear()}-${pad2(bj.getMonth() + 1)}-${pad2(bj.getDate())} ${pad2(bj.getHours())}:${pad2(bj.getMinutes())}:${pad2(bj.getSeconds())}`;
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
    ? enabled.map(s => s.storeKey)
    : storesConfig.groups?.[args.group];
  if (!Array.isArray(keys)) throw new Error(`Unknown store group: ${args.group}`);
  return keys.map(key => {
    const store = enabled.find(s => s.storeKey === key);
    if (!store) throw new Error(`Configured group store is missing/disabled: ${key}`);
    return store;
  });
}

function round4(n) {
  if (n === null || n === undefined || n === '') return null;
  const x = Number(n);
  return Number.isFinite(x) ? Math.round((x + Number.EPSILON) * 10000) / 10000 : null;
}
function num(n, fallback = 0) {
  if (n === null || n === undefined || n === '' || n === '-') return fallback;
  const x = Number(String(n).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(x) ? x : fallback;
}
function nullableNum(n) {
  if (n === null || n === undefined || n === '' || n === '-') return null;
  if (typeof n === 'object') {
    for (const key of ['amount', 'value', 'price', 'salePrice', 'sale_price', 'centAmount', 'cent_amount']) {
      const v = nullableNum(n?.[key]);
      if (v !== null) return /cent/i.test(key) ? v / 100 : v;
    }
    for (const v of Object.values(n)) {
      const parsed = nullableNum(v);
      if (parsed !== null) return parsed;
    }
    return null;
  }
  const x = Number(String(n).replace(/,/g, '').replace(/%$/, ''));
  if (Number.isFinite(x)) return x;
  const m = String(n).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function firstNonEmpty(...values) {
  for (const v of values) {
    if (v !== null && v !== undefined && String(v).trim() !== '') return v;
  }
  return '';
}
function compactJson(value, maxLen = 3500) {
  const text = JSON.stringify(value ?? null);
  return text.length > maxLen ? `${text.slice(0, maxLen - 20)}...<truncated>` : text;
}
function labelNames(list) {
  if (!Array.isArray(list)) return '';
  return list.map(x => x?.name || x?.labelName || x?.tagName || x?.value || '').filter(Boolean).join(' / ');
}
function htmlToText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}
function leadingAnnotation(value) {
  const s = String(value || '').trim();
  const m = s.match(/^\s*((?:（[^）]{1,20}）|\([^)]{1,20}\)))/);
  return m ? m[1] : '';
}
function isHardDeadLink(status, supplierCode) {
  return status === 'OUT_SHELF' && /^\s*(?:（\s*废\s*）|\(\s*废\s*\)|（\s*廢\s*）|\(\s*廢\s*\))/i.test(String(supplierCode || ''));
}
function stringifyReason(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.map(stringifyReason).filter(Boolean).join(' / ');
  if (typeof value === 'object') {
    return firstNonEmpty(
      value.name,
      value.labelName,
      value.reason,
      value.reasonDesc,
      value.desc,
      value.message,
      value.msg,
      value.value,
      compactJson(value, 800)
    );
  }
  return String(value).trim();
}
function pickReasonFields(obj, keyPattern) {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'shelf_require_list' || key === 'shelf_way_list') continue;
    if (!keyPattern.test(key)) continue;
    const text = stringifyReason(value);
    if (text) out.push(`${key}:${text}`);
  }
  return out;
}
function detectWaitShelfBlockage(product, skc) {
  const reasons = [];
  const productPattern = /(fail|reason|reject|audit|check|risk|block|cert|qual|license|material|require|notice|tip|warn|error|msg)/i;
  const skcPattern = /(fail|reason|reject|audit|check|risk|block|cert|qual|license|material|notice|tip|warn|error|msg)/i;
  reasons.push(...pickReasonFields(product, productPattern));
  reasons.push(...pickReasonFields(skc, skcPattern));
  const requireList = Array.isArray(product?.shelf_require_list) ? product.shelf_require_list.filter(x => x !== null && x !== undefined) : [];
  const nonDefaultRequire = requireList.filter(x => String(x) !== '0');
  if (nonDefaultRequire.length) reasons.push(`shelf_require_list:${nonDefaultRequire.join(',')}`);
  const deduped = [...new Set(reasons.map(x => String(x).trim()).filter(Boolean))];
  const reasonText = deduped.join('；').slice(0, 1800);
  const certLike = /证书|证件|资质|认证|备案|合规|安规|文件|资料|certificate|cert|license|qualification|compliance|material/i.test(reasonText);
  const reviewLike = /审核|驳回|拒绝|失败|不通过|风险|异常|补充|缺少|缺失|reject|audit|fail|risk|block|missing|require/i.test(reasonText);
  return {
    reason: reasonText,
    blocked: Boolean(reasonText && (certLike || reviewLike || nonDefaultRequire.length)),
    type: certLike ? '缺证书/资质/资料' : (reviewLike || nonDefaultRequire.length ? '待上架阻塞' : ''),
    requiresCertificate: certLike,
    shelfRequireList: requireList.join(','),
    shelfWayList: Array.isArray(product?.shelf_way_list) ? product.shelf_way_list.join(',') : '',
  };
}
function daysBetween(startYmd, endYmd) {
  if (!startYmd || !endYmd) return null;
  const start = new Date(`${String(startYmd).slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${String(endYmd).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.floor((end - start) / 86400_000);
}

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
async function ensureGeiwohuoPage(send) {
  const info = await evaluate(send, `(() => ({href: location.href, title: document.title}))()`);
  if (/^https:\/\/sso\.geiwohuo\.com\//i.test(String(info?.href || ''))) return info;
  await send('Page.navigate', {url: MERCHANDISE_URL});
  await sleep(2500);
  return await evaluate(send, `(() => ({href: location.href, title: document.title}))()`);
}
async function pageFetch(send, endpoint, payload, options = {}) {
  const method = options.method || 'POST';
  const extraHeaders = options.headers || {};
  const expression = `(() => {
    const endpoint = ${JSON.stringify(endpoint)};
    const payload = ${JSON.stringify(payload ?? {})};
    const extraHeaders = ${JSON.stringify(extraHeaders)};
    return fetch(endpoint, {
      method: ${JSON.stringify(method)},
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Origin-Path': location.hash ? location.hash.replace(/^#/, '') : location.pathname,
        'Origin-Url': location.href,
        ...extraHeaders
      },
      body: ${method === 'GET' ? 'undefined' : 'JSON.stringify(payload)'}
    }).then(async res => {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {status: res.status, text, json};
    });
  })()`;
  const value = await evaluate(send, expression);
  if (!value?.json) throw new Error(`Non-JSON response from ${endpoint}: ${String(value?.text || '').slice(0, 300)}`);
  if (String(value.json.code) === '20302') {
    throw new Error(`${endpoint} failed: code=20302 子系统登录重定向，需要重新登录`);
  }
  if (String(value.json.code) !== '0') {
    throw new Error(`${endpoint} failed: code=${value.json.code} msg=${value.json.msg}`);
  }
  return value.json;
}

async function captureSbnHeaders(cdp) {
  const {ws, send} = cdp;
  await send('Network.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1365,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  }).catch(() => null);
  let resolved = false;
  let targetRequestCount = 0;
  let lastTargetHeaderKeys = [];
  let cleanup = null;
  const pickHeader = (headers, name) => {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
      if (key.toLowerCase() === wanted) return value;
    }
    return null;
  };
  const buildAllowedHeaders = headers => {
    const allowed = {};
    for (const key of ['Accept', 'Content-Type', 'x-gw-auth', 'x-sbn-front-version', 'x-bbl-route', 'Origin-Url']) {
      const value = pickHeader(headers, key);
      if (value) allowed[key] = value;
    }
    return allowed;
  };
  const headersPromise = new Promise(resolve => {
    const handler = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.method !== 'Network.requestWillBeSent') return;
      const req = msg.params?.request;
      if (!String(req?.url || '').includes('/sbn/new_goods/get_skc_diagnose_list')) return;
      const h = req.headers || {};
      targetRequestCount += 1;
      lastTargetHeaderKeys = Object.keys(h).sort();
      const allowed = buildAllowedHeaders(h);
      if (allowed['x-gw-auth']) {
        resolved = true;
        resolve(allowed);
      }
    };
    cleanup = () => ws.removeEventListener?.('message', handler);
    ws.addEventListener('message', handler);
  });
  const waitForHeaders = ms => Promise.race([headersPromise, sleep(ms).then(() => null)]);
  let headers = null;
  for (let attempt = 1; attempt <= 3 && !resolved; attempt += 1) {
    await send('Page.navigate', {url: `${MERCHANDISE_URL}?linkFetchTs=${Date.now()}-${attempt}`});
    // The SBN micro-frontend sometimes reuses cached route state on hash navigation.
    // A hard reload reliably makes the frontend issue its own signed request, but
    // some cloud/headless runs need a second route initialization before SBN emits
    // the signed request. Keep this retry local so one store does not break the
    // full daily cloud job on a transient missing x-gw-auth capture.
    headers = await waitForHeaders(7000);
    if (headers) break;
    await send('Page.reload', {ignoreCache: true});
    headers = await waitForHeaders(attempt === 3 ? 25_000 : 12_000);
  }
  cleanup?.();
  if (!resolved || !headers?.['x-gw-auth']) {
    const headerKeys = lastTargetHeaderKeys.length ? lastTargetHeaderKeys.join(',') : 'none';
    throw new Error(`未捕获到商品分析接口 x-gw-auth 请求头，请确认商品分析页可正常打开 targetRequests=${targetRequestCount} headerKeys=${headerKeys}`);
  }
  return headers;
}

async function fetchProductStatus(send, status, pageSize) {
  const rows = [];
  let pageNum = 1;
  let total = null;
  while (true) {
    const endpoint = `/spmp-api-prefix/spmp/product/list?page_num=${pageNum}&page_size=${pageSize}`;
    const json = await pageFetch(send, endpoint, {shelf_status: status});
    const batch = json.info?.data || [];
    rows.push(...batch.map(x => ({...x, shelf_status: x.shelf_status || status})));
    total = json.info?.meta?.count ?? total;
    if (total !== null && rows.length >= total) break;
    if (batch.length < pageSize || batch.length === 0) break;
    pageNum += 1;
  }
  return {status, count: rows.length, total, rows};
}

async function fetchStockup(send, pageSize) {
  const rows = [];
  let page = 1;
  let total = null;
  while (true) {
    const json = await pageFetch(send, '/idms/goods-skc/list', {page, pageSize});
    const batch = json.info?.list || [];
    rows.push(...batch);
    total = json.info?.count ?? total;
    if (total !== null && rows.length >= total) break;
    if (batch.length < pageSize || batch.length === 0) break;
    page += 1;
  }
  return {count: rows.length, total, rows};
}

function buildReleasedPagePriceRequest(productRows) {
  const bySpu = new Map();
  for (const product of productRows || []) {
    const spuName = String(product?.spu_name || product?.spu || '').trim();
    if (!spuName) continue;
    const skcNames = bySpu.get(spuName) || new Set();
    for (const skc of product.skc_info_list || []) {
      const skcName = String(skc?.skc_name || skc?.skc || '').trim();
      if (skcName) skcNames.add(skcName);
    }
    if (skcNames.size) bySpu.set(spuName, skcNames);
  }
  return [...bySpu.entries()].map(([spuName, skcNames]) => ({
    spu_name: spuName,
    skc_name_list: [...skcNames].map(skcName => ({skc_name: skcName})),
  }));
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function fetchReleasedPagePrices(send, productRows, pageSize = 80) {
  const requestRows = buildReleasedPagePriceRequest(productRows);
  const priceBySpu = new Map();
  for (const chunk of chunkArray(requestRows, pageSize)) {
    if (!chunk.length) continue;
    const json = await pageFetch(send, '/spmp-api-prefix/spmp/product/query_cost_price_for_released_page', {spu_skc_list: chunk});
    for (const row of json.info?.data || []) {
      const spuName = String(row?.spu_name || '').trim();
      if (!spuName) continue;
      priceBySpu.set(spuName, {
        spu: spuName,
        originalSupplyPriceRange: String(row.cost_range || '').trim(),
        originalSupplyPriceCurrency: String(row.currency || '').trim(),
        originalSupplyPriceMin: nullableNum(row.min_cost),
        originalSupplyPriceMax: nullableNum(row.max_cost),
        originalSupplyPriceSource: 'spmp.product.query_cost_price_for_released_page',
      });
    }
  }
  return priceBySpu;
}

async function fetchDiagnoseWindow(send, dateStart, dateEnd, pageSize, sbnHeaders = {}) {
  const rows = [];
  let pageNum = 1;
  let total = null;
  while (true) {
    const payload = {
      areaCd: 'cn',
      dt: ymdCompact(dateEnd),
      countrySite: ['shein-all'],
      startDate: ymdCompact(dateStart),
      endDate: ymdCompact(dateEnd),
      pageNum,
      pageSize,
    };
    const json = await pageFetch(send, '/sbn/new_goods/get_skc_diagnose_list', payload, {headers: sbnHeaders});
    const batch = json.info?.data || [];
    rows.push(...batch);
    total = json.info?.meta?.count ?? json.info?.meta?.total ?? total;
    if (total !== null && rows.length >= total) break;
    if (batch.length < pageSize || batch.length === 0) break;
    pageNum += 1;
  }
  return {count: rows.length, total, rows, startDate: dateStart, endDate: dateEnd};
}

async function fetchFlowDiagnose(send, pageSize, sbnHeaders = {}) {
  const tz = await pageFetch(send, '/sbn/goods/flowDiagnose/querySiteTimezone', {businessScene: 12}, {headers: sbnHeaders});
  const siteInfo = (tz.info || []).find(x => x.site === 'shein-all') || (tz.info || [])[0] || {};
  const lastUpdateTime = siteInfo.lastUpdateTime || '';
  const tabsJson = await pageFetch(send, '/sbn/goods/flowDiagnose/queryAllTabs', {site: ['shein-all'], lastUpdateTime}, {headers: sbnHeaders});
  const tabs = Array.isArray(tabsJson.info) ? tabsJson.info : [];
  const rows = [];
  for (const fallback of FLOW_TABS) {
    const tab = tabs.find(t => String(t.tabId) === String(fallback.tabId)) || fallback;
    const total = Number(tab.count || 0);
    if (!total) continue;
    let pageNum = 1;
    while (true) {
      const payload = {
        pageNum,
        pageSize,
        tabId: String(tab.tabId),
        site: ['shein-all'],
        lastUpdateTime,
      };
      if (tab.ruleCodeName && tab.ruleCodeName !== 'le') payload.ruleCodeName = tab.ruleCodeName;
      const json = await pageFetch(send, '/sbn/goods/flowDiagnose/querySkcList', payload, {headers: sbnHeaders});
      const batch = json.info?.data || [];
      rows.push(...batch.map(x => ({...x, diagnoseTab: tab.tabName || fallback.name, diagnoseTabId: String(tab.tabId), ruleCodeName: tab.ruleCodeName || fallback.ruleCodeName})));
      if (rows.filter(x => x.diagnoseTabId === String(tab.tabId)).length >= total) break;
      if (batch.length < pageSize || batch.length === 0) break;
      pageNum += 1;
    }
  }
  return {lastUpdateTime, tabs, rows};
}

function normalizeSupplierCode(value, title = '') {
  const detailed = normalizeGoodsSnDetailed(value || '', {goodsTitle: title});
  return detailed;
}
function flattenProductRows(store, date, productStatuses, releasedPriceBySpu = new Map()) {
  const rows = [];
  for (const statusBlock of productStatuses) {
    const status = statusBlock.status;
    for (const product of statusBlock.rows || []) {
      const releasedPrice = releasedPriceBySpu.get(product.spu_name || product.spu || '') || {};
      for (const skc of product.skc_info_list || []) {
        const rawGoodsSn = String(skc.supplier_code || '').trim();
        const norm = normalizeSupplierCode(rawGoodsSn, product.product_name_ch || product.product_name_en || product.product_name_multi || '');
        const skuCodes = (skc.sku_info || []).map(x => x.sku_code).filter(Boolean);
        const waitShelfBlockage = detectWaitShelfBlockage(product, skc);
        rows.push({
          uniqueKey: `${store.storeKey}__${skc.skc_name || skc.skc || skc.skc_code || ''}`,
          date,
          groupKey: store.groupKey,
          storeKey: store.storeKey,
          shopName: store.shopName || '',
          standardGoodsSn: norm.canonical || '',
          rawGoodsSn,
          cleanedGoodsSn: stripLeadingAnnotations(rawGoodsSn),
          leadingAnnotation: leadingAnnotation(rawGoodsSn),
          needsGoodsSnReview: Boolean(norm.needsReview),
          goodsSnReviewReason: norm.reviewReason || '',
          spu: product.spu_name || product.spu || '',
          spuCode: product.spu_code || '',
          skc: skc.skc_name || skc.skc || '',
          skcCode: skc.skc_code || '',
          skuCodes: skuCodes.join(','),
          skuCount: skuCodes.length,
          saleName: skc.sale_name || '',
          imageUrl: skc.main_image_thumbnail_url || '',
          productNameCn: product.product_name_ch || '',
          productNameEn: product.product_name_en || '',
          productNameMulti: product.product_name_multi || '',
          categoryId: product.category_id || '',
          brandName: product.brand_name || '',
          shelfStatus: product.shelf_status || status,
          shelfStatusName: STATUS_LABELS[product.shelf_status || status] || (product.shelf_status || status),
          isOnShelf: (product.shelf_status || status) === 'ON_SHELF',
          isWaitShelf: (product.shelf_status || status) === 'WAIT_SHELF',
          isSoldOut: (product.shelf_status || status) === 'SOLD_OUT',
          isOutShelf: (product.shelf_status || status) === 'OUT_SHELF',
          isHardDead: isHardDeadLink(product.shelf_status || status, rawGoodsSn),
          waitShelfBlockReason: waitShelfBlockage.reason,
          waitShelfBlockType: waitShelfBlockage.type,
          waitShelfBlocked: (product.shelf_status || status) === 'WAIT_SHELF' && waitShelfBlockage.blocked,
          waitShelfRequiresCertificate: (product.shelf_status || status) === 'WAIT_SHELF' && waitShelfBlockage.requiresCertificate,
          shelfRequireList: waitShelfBlockage.shelfRequireList,
          shelfWayList: waitShelfBlockage.shelfWayList,
          mallSellStatus: skc.mall_sell_status ?? '',
          abandoned: Boolean(skc.abandoned),
          hasActivity: Boolean(skc.has_activity),
          createTime: product.create_time || '',
          publishTime: product.publish_time || '',
          firstShelfTime: product.first_shelf_time || '',
          expectShelfTime: product.expect_shelf_time || '',
          originalSupplyPriceRange: releasedPrice.originalSupplyPriceRange || '',
          originalSupplyPriceCurrency: releasedPrice.originalSupplyPriceCurrency || '',
          originalSupplyPriceMin: releasedPrice.originalSupplyPriceMin ?? null,
          originalSupplyPriceMax: releasedPrice.originalSupplyPriceMax ?? null,
          originalSupplyPriceSource: releasedPrice.originalSupplyPriceSource || '',
          productTags: labelNames(product.tag_info_list),
          skcTags: labelNames(skc.tag_info_list),
          rawSummary: compactJson({product, skc}, 3000),
        });
      }
    }
  }
  return rows.filter(r => r.skc);
}

function aggregateSkuList(skuList = []) {
  const sum = key => skuList.reduce((acc, x) => acc + num(x?.[key], 0), 0);
  const nums = key => skuList.map(x => nullableNum(x?.[key])).filter(x => x !== null);
  const min = key => {
    const xs = nums(key);
    return xs.length ? Math.min(...xs) : null;
  };
  const max = key => {
    const xs = nums(key);
    return xs.length ? Math.max(...xs) : null;
  };
  return {
    skuCodes: skuList.map(x => x.skuCode).filter(Boolean).join(','),
    skuAttrs: skuList.map(x => x.attr).filter(Boolean).join(' / ').slice(0, 1000),
    displayStock: sum('stock'),
    saleableStock: sum('saleableStock'),
    stayDeliver: sum('stayDeliver'),
    stayShelf: sum('stayShelf'),
    transit: sum('transit'),
    supplierStock: sum('supplierStock'),
    c7dSaleCnt: sum('c7dSaleCnt'),
    c30dSaleCnt: sum('c30dSaleCnt'),
    totalSaleVolume: sum('totalSaleVolume'),
    orderCnt: sum('orderCnt'),
    adviceOrderCount: sum('adviceOrderCount'),
    availableOrderCount: sum('availableOrderCount'),
    orderCount: sum('orderCount'),
    systemOrderCount: sum('systemOrderCount'),
    userOrderCount: sum('userOrderCount'),
    minStockSaleDays: min('stockSaleDays'),
    maxStockSaleDays: max('stockSaleDays'),
    minSaleDays: min('saleDays'),
    maxSaleDays: max('saleDays'),
    minPrice: min('price'),
    maxPrice: max('price'),
    minFinalPrice: min('finalPrice'),
    maxFinalPrice: max('finalPrice'),
    minPurchasePrice: min('purchasePrice'),
    maxPurchasePrice: max('purchasePrice'),
  };
}
function flattenInventoryRows(store, date, stockRows, releasedPriceBySpu = new Map()) {
  return (stockRows || []).map(row => {
    const rawGoodsSn = String(row.supplierCode || '').trim();
    const norm = normalizeSupplierCode(rawGoodsSn, '');
    const skuAgg = aggregateSkuList(row.skuList || []);
    const releasedPrice = releasedPriceBySpu.get(row.spu || '') || {};
    const stockWarnName = row.stockWarnStatus?.name || '';
    // 2026-05-01 复核：备货信息里的 stock / stockSaleDays 不是用户在链接后台看到的
    // “可调整展示库存”口径。例如 sv25082988192111895 在此接口返回 0，但后台实际
    // 仍有 80+。因此这里继续沉淀字段，但不再触发“展示库存快售罄”实操提醒。
    const lowByQty = false;
    const lowByDays = false;
    const lowByWarn = false;
    return {
      uniqueKey: `${date}__${store.storeKey}__${row.skc || ''}`,
      date,
      groupKey: store.groupKey,
      storeKey: store.storeKey,
      shopName: store.shopName || '',
      standardGoodsSn: norm.canonical || '',
      rawGoodsSn,
      spu: row.spu || '',
      skc: row.skc || '',
      skuCodes: skuAgg.skuCodes,
      skuAttrs: skuAgg.skuAttrs,
      imageUrl: row.picUrl || '',
      categoryName: row.categoryName || '',
      shelfDate: row.shelfDate || '',
      shelfDays: nullableNum(row.shelfDays),
      supplyStatus: row.supplyStatus?.name || '',
      shelfStatus: row.shelfStatus?.name || '',
      saleModel: row.saleModel?.name || '',
      qualityGrade: row.qualityGrade?.name || row.qualityGrade || '',
      goodsLevel: row.goodsLevel?.name || '',
      stockWarnStatus: stockWarnName,
      operateLabels: labelNames(row.operateLabelList),
      rightsLabels: labelNames(row.rightsLabelList),
      goodsLabels: labelNames(row.goodsLabelList),
      platformDisplayStock: skuAgg.displayStock,
      platformSaleableStock: skuAgg.saleableStock,
      stayDeliver: skuAgg.stayDeliver,
      stayShelf: skuAgg.stayShelf,
      transit: skuAgg.transit,
      supplierStock: skuAgg.supplierStock,
      c7dSaleCnt: row.c7dSaleCntSum ?? skuAgg.c7dSaleCnt,
      c30dSaleCnt: skuAgg.c30dSaleCnt,
      totalSaleVolume: skuAgg.totalSaleVolume,
      orderCnt: skuAgg.orderCnt,
      adviceOrderCount: skuAgg.adviceOrderCount,
      availableOrderCount: skuAgg.availableOrderCount,
      systemOrderCount: skuAgg.systemOrderCount,
      userOrderCount: skuAgg.userOrderCount,
      minStockSaleDays: skuAgg.minStockSaleDays,
      maxStockSaleDays: skuAgg.maxStockSaleDays,
      priceRange: [skuAgg.minPrice, skuAgg.maxPrice].filter(x => x !== null).join('~'),
      finalPriceRange: [skuAgg.minFinalPrice, skuAgg.maxFinalPrice].filter(x => x !== null).join('~'),
      purchasePriceRange: [skuAgg.minPurchasePrice, skuAgg.maxPurchasePrice].filter(x => x !== null).join('~'),
      originalSupplyPriceRange: releasedPrice.originalSupplyPriceRange || '',
      originalSupplyPriceCurrency: releasedPrice.originalSupplyPriceCurrency || '',
      originalSupplyPriceMin: releasedPrice.originalSupplyPriceMin ?? null,
      originalSupplyPriceMax: releasedPrice.originalSupplyPriceMax ?? null,
      originalSupplyPriceSource: releasedPrice.originalSupplyPriceSource || '',
      displayStockLow: lowByQty || lowByDays || lowByWarn,
      displayStockWarningReason: [
        lowByQty ? `展示库存<=10（${skuAgg.displayStock}）` : null,
        lowByDays ? `平台可售天数<=3（${skuAgg.minStockSaleDays}）` : null,
        lowByWarn ? stockWarnName : null,
      ].filter(Boolean).join('；'),
      realInventoryStatus: '未接入',
      rawSummary: compactJson(row, 3000),
    };
  }).filter(r => r.skc);
}

function metricMap(rows) {
  const map = new Map();
  for (const row of rows || []) if (row.skc) map.set(row.skc, row);
  return map;
}
function flattenFlowDiagnoseRows(flowRows) {
  const map = new Map();
  for (const row of flowRows || []) {
    const product = row.skcProductVo || {};
    const cols = Object.fromEntries((row.skcColumnVoList || []).map(x => [x.columnKey, x.value]));
    const skc = product.skc || '';
    if (!skc) continue;
    const item = map.get(skc) || {
      skc,
      tabs: [],
      suggestions: [],
      columns: {},
      operateButtons: [],
      product,
    };
    item.tabs.push(row.diagnoseTab);
    if (cols.suggestion) item.suggestions.push(`${row.diagnoseTab}：${htmlToText(cols.suggestion)}`);
    item.columns = {...item.columns, ...cols};
    item.operateButtons.push(...(row.operateButtons || []));
    map.set(skc, item);
  }
  return map;
}
function performanceRecord(store, date, day, c7, prev7, c30, flow) {
  const rawGoodsSn = String(firstNonEmpty(day?.skuSupplierNo, c7?.skuSupplierNo, c30?.skuSupplierNo, flow?.product?.skuSupplierNo)).trim();
  const title = firstNonEmpty(day?.goodsName, c7?.goodsName, c30?.goodsName, flow?.product?.productName);
  const norm = normalizeSupplierCode(rawGoodsSn, title);
  const sale7 = num(c7?.saleCnt, 0);
  const salePrev7 = num(prev7?.saleCnt, 0);
  const eps7 = num(c7?.epsUvIdx, 0);
  const epsPrev7 = num(prev7?.epsUvIdx, 0);
  return {
    uniqueKey: `${date}__${store.storeKey}__${day?.skc || c7?.skc || c30?.skc || flow?.skc || ''}`,
    date,
    groupKey: store.groupKey,
    storeKey: store.storeKey,
    shopName: store.shopName || '',
    standardGoodsSn: norm.canonical || '',
    rawGoodsSn,
    spu: firstNonEmpty(day?.spu, c7?.spu, c30?.spu),
    skc: firstNonEmpty(day?.skc, c7?.skc, c30?.skc, flow?.skc),
    goodsName: title || '',
    imageUrl: firstNonEmpty(day?.imgUrl, c7?.imgUrl, c30?.imgUrl, flow?.product?.productUrl),
    newGoodsTag: firstNonEmpty(day?.newGoodsTag, c7?.newGoodsTag, c30?.newGoodsTag),
    layerName: firstNonEmpty(day?.layerNm, c7?.layerNm, c30?.layerNm, flow?.columns?.supplier_layer_nm),
    onSaleFlag: firstNonEmpty(day?.onsaleFlag, c7?.onsaleFlag, c30?.onsaleFlag, flow?.product?.onSaleTag),
    saleFlag: firstNonEmpty(day?.saleFlag, c7?.saleFlag, c30?.saleFlag),
    activityTag: day?.promCampaign?.promTag || '',
    activityNames: (day?.promCampaign?.promInfIng || []).map(x => x.promNm).filter(Boolean).join(' / ').slice(0, 1500),
    saleCnt: num(day?.saleCnt, 0),
    payOrderCnt: num(day?.payOrderCnt, 0),
    epsUv: num(day?.epsUvIdx, 0),
    goodsUv: num(day?.goodsUvIdx, 0),
    clickRate: round4(day?.epsGdsCtrIdx),
    cartUv: num(day?.cartUvIdx, 0),
    cartPv: num(day?.cartPvIdx, 0),
    cartRate: round4(day?.gdsCartCtrIdx),
    payUv: num(day?.payUvIdx, 0),
    payRate: round4(day?.gdsPayCtrIdx),
    c7SaleCnt: sale7,
    prev7SaleCnt: salePrev7,
    c30SaleCnt: num(c30?.saleCnt, 0),
    c7PayOrderCnt: num(c7?.payOrderCnt, 0),
    c7EpsUv: eps7,
    prev7EpsUv: epsPrev7,
    c7GoodsUv: num(c7?.goodsUvIdx, 0),
    c7ClickRate: round4(c7?.epsGdsCtrIdx),
    c7PayRate: round4(c7?.gdsPayCtrIdx),
    c30EpsUv: num(c30?.epsUvIdx, 0),
    c30GoodsUv: num(c30?.goodsUvIdx, 0),
    c30ClickRate: round4(c30?.epsGdsCtrIdx),
    c30PayRate: round4(c30?.gdsPayCtrIdx),
    sale7ChangeRate: salePrev7 > 0 ? round4((sale7 - salePrev7) / salePrev7) : null,
    exposure7ChangeRate: epsPrev7 > 0 ? round4((eps7 - epsPrev7) / epsPrev7) : null,
    totalQualityLevel: firstNonEmpty(day?.totalQualityLevel, c7?.totalQualityLevel, c30?.totalQualityLevel, flow?.columns?.total_quality_level),
    totalCommentCnt: num(day?.totalCommentCnt, 0),
    badCommentRate: round4(day?.badCommentRate),
    payCommentCnt: num(day?.payCommentCnt, 0),
    payBadCommentRate: round4(day?.payBadCommentRate),
    returnOrderCnt: num(day?.returnOrderCnt, 0),
    returnQty: num(day?.returnQty, 0),
    category1: firstNonEmpty(day?.newCate1Nm, c7?.newCate1Nm, c30?.newCate1Nm),
    category2: firstNonEmpty(day?.newCate2Nm, c7?.newCate2Nm, c30?.newCate2Nm),
    category3: firstNonEmpty(day?.newCate3Nm, c7?.newCate3Nm, c30?.newCate3Nm),
    category4: firstNonEmpty(day?.newCate4Nm, c7?.newCate4Nm, c30?.newCate4Nm),
    listName: day?.listName || '',
    listType: day?.listType || '',
    listRank: num(day?.listRank, 0),
    flowDiagnoseTabs: (flow?.tabs || []).join(' / '),
    officialSuggestion: (flow?.suggestions || []).join('\n').slice(0, 2500),
    officialOperateButtons: (flow?.operateButtons || []).map(x => x.buttonName).filter(Boolean).join(' / '),
    rawSummary: compactJson({day, c7, prev7, c30, flow}, 4000),
  };
}
function flattenPerformanceRows(store, date, diagnose, flow) {
  const dayMap = metricMap(diagnose.day.rows);
  const c7Map = metricMap(diagnose.c7.rows);
  const prev7Map = metricMap(diagnose.prev7.rows);
  const c30Map = metricMap(diagnose.c30.rows);
  const flowMap = flattenFlowDiagnoseRows(flow?.rows || []);
  const skcs = new Set([...dayMap.keys(), ...c7Map.keys(), ...prev7Map.keys(), ...c30Map.keys(), ...flowMap.keys()]);
  return [...skcs].map(skc => performanceRecord(store, date, dayMap.get(skc) || {skc}, c7Map.get(skc), prev7Map.get(skc), c30Map.get(skc), flowMap.get(skc)));
}

function buildCoverageRows(store, date, productRows, performanceRows) {
  const catalog = getCatalogConfig();
  const standards = [...new Set([...(catalog.standards || []), ...(catalog.extraConfirmedStandards || [])])];
  const bySku = new Map();
  for (const row of productRows) {
    if (!row.standardGoodsSn) continue;
    if (!bySku.has(row.standardGoodsSn)) bySku.set(row.standardGoodsSn, []);
    bySku.get(row.standardGoodsSn).push(row);
  }
  const perfBySkc = new Map(performanceRows.map(r => [r.skc, r]));
  const allStandards = [...new Set([...standards, ...bySku.keys()])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  return allStandards.map(standardGoodsSn => {
    const links = bySku.get(standardGoodsSn) || [];
    const onShelf = links.filter(x => x.shelfStatus === 'ON_SHELF');
    const waitShelf = links.filter(x => x.shelfStatus === 'WAIT_SHELF');
    const soldOut = links.filter(x => x.shelfStatus === 'SOLD_OUT');
    const outShelf = links.filter(x => x.shelfStatus === 'OUT_SHELF');
    const hardDead = links.filter(x => x.isHardDead);
    const best = [...onShelf].sort((a, b) => {
      const pa = perfBySkc.get(a.skc);
      const pb = perfBySkc.get(b.skc);
      return num(pb?.c30SaleCnt, 0) - num(pa?.c30SaleCnt, 0)
        || num(pb?.c7SaleCnt, 0) - num(pa?.c7SaleCnt, 0)
        || String(a.skc).localeCompare(String(b.skc));
    })[0] || null;
    let coverageStatus = '有上架链接';
    if (!links.length) coverageStatus = '没有链接';
    else if (!onShelf.length && waitShelf.length) coverageStatus = '只有待上架';
    else if (!onShelf.length && soldOut.length) coverageStatus = '只有已售罄';
    else if (!onShelf.length && outShelf.length && hardDead.length === outShelf.length) coverageStatus = '只有硬死链';
    else if (!onShelf.length && outShelf.length) coverageStatus = '只有已下架';
    return {
      uniqueKey: `${date}__${store.storeKey}__${standardGoodsSn}`,
      date,
      groupKey: store.groupKey,
      storeKey: store.storeKey,
      shopName: store.shopName || '',
      standardGoodsSn,
      coverageStatus,
      hasOnShelfLink: onShelf.length > 0,
      needSupplementLink: onShelf.length === 0,
      linkCount: links.length,
      onShelfCount: onShelf.length,
      waitShelfCount: waitShelf.length,
      soldOutCount: soldOut.length,
      outShelfCount: outShelf.length,
      hardDeadCount: hardDead.length,
      duplicateOnShelf: onShelf.length > 1,
      bestSkc: best?.skc || '',
      bestLinkC30Sale: num(perfBySkc.get(best?.skc)?.c30SaleCnt, 0),
      skcList: links.map(x => `${x.skc}:${x.shelfStatusName}`).join(' / ').slice(0, 2000),
      recommendation: onShelf.length
        ? (onShelf.length > 1 ? '有多条上架链接，可做优胜劣汰' : '覆盖正常')
        : '需要补充上架链接',
      rawSummary: compactJson({links: links.map(x => ({skc: x.skc, status: x.shelfStatusName, rawGoodsSn: x.rawGoodsSn}))}, 2500),
    };
  });
}

function pushSuggestion(list, row) {
  list.push({
    ...row,
    uniqueKey: `${row.date}__${row.storeKey}__${row.targetType}__${row.targetKey}__${row.ruleCode}`,
  });
}
function buildSuggestionRows(store, date, productRows, performanceRows, inventoryRows, coverageRows) {
  const suggestions = [];
  const perfBySkc = new Map(performanceRows.map(r => [r.skc, r]));
  const invBySkc = new Map(inventoryRows.map(r => [r.skc, r]));
  const coverageBySku = new Map(coverageRows.map(r => [r.standardGoodsSn, r]));
  const productBySku = new Map();
  for (const link of productRows) {
    if (!productBySku.has(link.standardGoodsSn)) productBySku.set(link.standardGoodsSn, []);
    productBySku.get(link.standardGoodsSn).push(link);
  }
  for (const cov of coverageRows) {
    if (cov.needSupplementLink) {
      pushSuggestion(suggestions, {
        date, groupKey: store.groupKey, storeKey: store.storeKey, shopName: store.shopName || '',
        targetType: '货号', targetKey: cov.standardGoodsSn, standardGoodsSn: cov.standardGoodsSn, skc: '',
        ruleCode: 'COVERAGE_MISSING', suggestionType: '缺链接', priority: '高',
        reason: `该货号在 ${store.storeKey} 没有已上架链接（${cov.coverageStatus}）`,
        action: '补充至少 1 条已上架链接；已标废且已下架的旧链接直接忽略，不作为待处理事项。',
        evidence: `link=${cov.linkCount}, wait=${cov.waitShelfCount}, soldOut=${cov.soldOutCount}, out=${cov.outShelfCount}, hardDead=${cov.hardDeadCount}`,
      });
    }
  }
  for (const link of productRows) {
    const perf = perfBySkc.get(link.skc) || {};
    const inv = invBySkc.get(link.skc) || {};
    const cov = coverageBySku.get(link.standardGoodsSn) || {};
    const shelfAge = daysBetween((link.firstShelfTime || link.publishTime || link.createTime || '').slice(0, 10), date);
    if (link.isWaitShelf && link.waitShelfBlocked) {
      pushSuggestion(suggestions, {
        date, groupKey: store.groupKey, storeKey: store.storeKey, shopName: store.shopName || '',
        targetType: '链接', targetKey: link.skc, standardGoodsSn: link.standardGoodsSn, skc: link.skc,
        ruleCode: 'WAIT_SHELF_BLOCKED', suggestionType: link.waitShelfRequiresCertificate ? '待上架缺证书/资料' : '待上架阻塞', priority: '高',
        reason: link.waitShelfBlockReason || '链接处于待上架，且后台返回上架阻塞/资料要求。',
        action: link.waitShelfRequiresCertificate
          ? '优先补充证书、资质、认证或商品资料，否则这条链接无法正常上架。'
          : '优先检查待上架卡点，补齐平台要求后再等待上架。',
        evidence: `status=${link.shelfStatusName}, require=${link.shelfRequireList || ''}, way=${link.shelfWayList || ''}`,
      });
    }
    // 展示库存低预警暂不从“备货信息”触发；该接口库存口径已被样本证明不可靠。
    if (link.isOnShelf && shelfAge !== null && shelfAge >= 30 && num(perf.c30SaleCnt, 0) === 0) {
      const unique = num(cov.onShelfCount, 0) <= 1;
      pushSuggestion(suggestions, {
        date, groupKey: store.groupKey, storeKey: store.storeKey, shopName: store.shopName || '',
        targetType: '链接', targetKey: link.skc, standardGoodsSn: link.standardGoodsSn, skc: link.skc,
        ruleCode: 'C30_ZERO_SALE', suggestionType: '连续无销量', priority: unique ? '中' : '高',
        reason: `上架约 ${shelfAge} 天，近30天销量为 0。${unique ? '这是该货号唯一上架链接，不能直接下架。' : '同货号存在其他上架链接，可优先淘汰弱链接。'}`,
        action: unique ? '先优化或补新链接，再决定是否下架旧链接。' : '进入淘汰候选；若其他链接表现更好，可下架/替换。',
        evidence: `c30Sale=${perf.c30SaleCnt || 0}, c30EpsUv=${perf.c30EpsUv || 0}, c30PayRate=${perf.c30PayRate ?? ''}`,
      });
    }
    if (link.isOnShelf && num(perf.c30SaleCnt, 0) === 0 && num(perf.c30EpsUv, 0) >= 200) {
      pushSuggestion(suggestions, {
        date, groupKey: store.groupKey, storeKey: store.storeKey, shopName: store.shopName || '',
        targetType: '链接', targetKey: link.skc, standardGoodsSn: link.standardGoodsSn, skc: link.skc,
        ruleCode: 'TRAFFIC_NO_SALE', suggestionType: '有流量无销量', priority: '高',
        reason: '近30天有曝光但没有销量，说明不是完全没流量，更可能是点击/转化/价格/评价/承接问题。',
        action: '优先检查主图标题、价格、活动、评价和详情承接；若已有强替代链接，可考虑淘汰。',
        evidence: `c30EpsUv=${perf.c30EpsUv}, c30GoodsUv=${perf.c30GoodsUv}, c30ClickRate=${perf.c30ClickRate ?? ''}, c30PayRate=${perf.c30PayRate ?? ''}`,
      });
    }
    if (link.isOnShelf && num(perf.c7EpsUv, 0) >= 200 && (perf.c7ClickRate ?? 1) < 0.01) {
      pushSuggestion(suggestions, {
        date, groupKey: store.groupKey, storeKey: store.storeKey, shopName: store.shopName || '',
        targetType: '链接', targetKey: link.skc, standardGoodsSn: link.standardGoodsSn, skc: link.skc,
        ruleCode: 'HIGH_EXPOSURE_LOW_CLICK', suggestionType: '高曝光低点击', priority: '高',
        reason: '近7天曝光不低，但点击率低。',
        action: '优先优化首图、标题关键词、价格展示和活动露出。',
        evidence: `c7EpsUv=${perf.c7EpsUv}, c7ClickRate=${perf.c7ClickRate}`,
      });
    }
    if (link.isOnShelf && num(perf.c7GoodsUv, 0) >= 30 && (perf.c7PayRate ?? 1) < 0.01) {
      pushSuggestion(suggestions, {
        date, groupKey: store.groupKey, storeKey: store.storeKey, shopName: store.shopName || '',
        targetType: '链接', targetKey: link.skc, standardGoodsSn: link.standardGoodsSn, skc: link.skc,
        ruleCode: 'HIGH_VISITOR_LOW_PAY', suggestionType: '高访客低支付', priority: '高',
        reason: '近7天已有商详访客，但支付转化低。',
        action: '检查价格竞争力、详情页卖点、评价/差评、质量等级、活动承接。',
        evidence: `c7GoodsUv=${perf.c7GoodsUv}, c7PayRate=${perf.c7PayRate}, quality=${perf.totalQualityLevel || ''}`,
      });
    }
    if (link.isOnShelf && num(perf.prev7SaleCnt, 0) >= 3 && num(perf.c7SaleCnt, 0) <= num(perf.prev7SaleCnt, 0) * 0.5) {
      pushSuggestion(suggestions, {
        date, groupKey: store.groupKey, storeKey: store.storeKey, shopName: store.shopName || '',
        targetType: '链接', targetKey: link.skc, standardGoodsSn: link.standardGoodsSn, skc: link.skc,
        ruleCode: 'SALE_DROP_7D', suggestionType: '销量下滑', priority: '中',
        reason: '近7天销量较前7天明显下降。',
        action: '复核曝光、活动、价格、库存展示和竞品变化；优先恢复有历史销量的链接。',
        evidence: `c7Sale=${perf.c7SaleCnt}, prev7Sale=${perf.prev7SaleCnt}, change=${perf.sale7ChangeRate}`,
      });
    }
    if (link.isOnShelf && num(perf.prev7EpsUv, 0) >= 100 && num(perf.c7EpsUv, 0) <= num(perf.prev7EpsUv, 0) * 0.5) {
      pushSuggestion(suggestions, {
        date, groupKey: store.groupKey, storeKey: store.storeKey, shopName: store.shopName || '',
        targetType: '链接', targetKey: link.skc, standardGoodsSn: link.standardGoodsSn, skc: link.skc,
        ruleCode: 'EXPOSURE_DROP_7D', suggestionType: '曝光下滑', priority: '中',
        reason: '近7天曝光较前7天明显下降。',
        action: '检查活动结束、排名变化、标题关键词、平台标签和展示库存。',
        evidence: `c7EpsUv=${perf.c7EpsUv}, prev7EpsUv=${perf.prev7EpsUv}, change=${perf.exposure7ChangeRate}`,
      });
    }
    if (perf.flowDiagnoseTabs) {
      pushSuggestion(suggestions, {
        date, groupKey: store.groupKey, storeKey: store.storeKey, shopName: store.shopName || '',
        targetType: '链接', targetKey: link.skc, standardGoodsSn: link.standardGoodsSn, skc: link.skc,
        ruleCode: 'SHEIN_FLOW_DIAGNOSE', suggestionType: '官方诊断参考', priority: '低',
        reason: `SHEIN 官方诊断：${perf.flowDiagnoseTabs}`,
        action: '作为参考，不直接照搬；结合本系统的销售/覆盖/重复链接规则判断。',
        evidence: String(perf.officialSuggestion || '').slice(0, 1200),
      });
    }
  }
  for (const [standardGoodsSn, links] of productBySku.entries()) {
    const onShelf = links.filter(x => x.isOnShelf);
    if (onShelf.length <= 1) continue;
    const ranked = [...onShelf].sort((a, b) => num(perfBySkc.get(b.skc)?.c30SaleCnt, 0) - num(perfBySkc.get(a.skc)?.c30SaleCnt, 0));
    const best = ranked[0];
    for (const weak of ranked.slice(1)) {
      const weakPerf = perfBySkc.get(weak.skc) || {};
      if (num(weakPerf.c30SaleCnt, 0) > 0 && num(weakPerf.c30SaleCnt, 0) >= num(perfBySkc.get(best.skc)?.c30SaleCnt, 0) * 0.5) continue;
      pushSuggestion(suggestions, {
        date, groupKey: store.groupKey, storeKey: store.storeKey, shopName: store.shopName || '',
        targetType: '链接', targetKey: weak.skc, standardGoodsSn, skc: weak.skc,
        ruleCode: 'DUPLICATE_WEAK_LINK', suggestionType: '重复链接优胜劣汰', priority: '中',
        reason: `同货号有 ${onShelf.length} 条上架链接，该链接弱于当前最佳链接 ${best.skc}。`,
        action: '保留强链接，弱链接进入观察/淘汰候选；下架前确认强链接库存展示和状态正常。',
        evidence: `weakC30=${weakPerf.c30SaleCnt || 0}, bestC30=${perfBySkc.get(best.skc)?.c30SaleCnt || 0}`,
      });
    }
  }
  return suggestions;
}

function buildDashboardRows(store, date, linkRows, performanceRows, inventoryRows, coverageRows, suggestionRows) {
  const onShelfCount = linkRows.filter(x => x.isOnShelf).length;
  const hardDeadCount = linkRows.filter(x => x.isHardDead).length;
  const waitShelfBlockedCount = linkRows.filter(x => x.waitShelfBlocked).length;
  const missingCoverage = coverageRows.filter(x => x.needSupplementLink).length;
  const lowDisplayStock = inventoryRows.filter(x => x.displayStockLow).length;
  const highPrioritySuggestions = suggestionRows.filter(x => x.priority === '高').length;
  const sale7 = performanceRows.reduce((s, x) => s + num(x.c7SaleCnt, 0), 0);
  const exposure7 = performanceRows.reduce((s, x) => s + num(x.c7EpsUv, 0), 0);
  return {
    overview: {
      uniqueKey: `${date}__${store.storeKey}`,
      date,
      groupKey: store.groupKey,
      storeKey: store.storeKey,
      shopName: store.shopName || '',
      linkCount: linkRows.length,
      onShelfCount,
      waitShelfCount: linkRows.filter(x => x.isWaitShelf).length,
      soldOutCount: linkRows.filter(x => x.isSoldOut).length,
      outShelfCount: linkRows.filter(x => x.isOutShelf).length,
      hardDeadCount,
      waitShelfBlockedCount,
      standardCoveredCount: coverageRows.filter(x => x.hasOnShelfLink).length,
      standardMissingCount: missingCoverage,
      duplicateOnShelfSkuCount: coverageRows.filter(x => x.duplicateOnShelf).length,
      lowDisplayStockCount: lowDisplayStock,
      suggestionCount: suggestionRows.length,
      highPrioritySuggestionCount: highPrioritySuggestions,
      c7SaleCnt: sale7,
      c7ExposureUv: exposure7,
    },
  };
}

async function fetchStore(store, args) {
  const cdp = await connectCdp(store.port);
  const {send} = cdp;
  try {
    await ensureGeiwohuoPage(send);
    const sbnHeaders = await captureSbnHeaders(cdp);
    const fetchTime = nowBjString();
    // 商品列表接口当前会返回全量链接，筛选条件由前端侧处理；
    // 因此这里抓全量后按返回的 shelf_status 本地分组，避免重复计数。
    const productAll = await fetchProductStatus(send, 'ALL', args.pageSize);
    const productStatuses = PRODUCT_STATUSES.map(status => {
      const rows = productAll.rows.filter(x => x.shelf_status === status);
      return {status, count: rows.length, total: rows.length, rows};
    });
    const releasedPriceBySpu = await fetchReleasedPagePrices(send, productAll.rows);
    const stockup = await fetchStockup(send, args.pageSize);
    const date = args.date;
    const diagnose = {
      day: await fetchDiagnoseWindow(send, date, date, args.pageSize, sbnHeaders),
      c7: await fetchDiagnoseWindow(send, addDays(date, -6), date, args.pageSize, sbnHeaders),
      prev7: await fetchDiagnoseWindow(send, addDays(date, -13), addDays(date, -7), args.pageSize, sbnHeaders),
      c30: await fetchDiagnoseWindow(send, addDays(date, -29), date, args.pageSize, sbnHeaders),
    };
    let flow = {rows: [], tabs: [], lastUpdateTime: ''};
    if (args.fetchFlowDiagnose) {
      try {
        flow = await fetchFlowDiagnose(send, args.pageSize, sbnHeaders);
      } catch (err) {
        console.error(`[${store.storeKey}] WARN flow diagnose skipped: ${err?.message || err}`);
      }
    }

    const linkRows = flattenProductRows(store, date, productStatuses, releasedPriceBySpu);
    const inventoryRows = flattenInventoryRows(store, date, stockup.rows, releasedPriceBySpu);
    const performanceRows = flattenPerformanceRows(store, date, diagnose, flow);
    const coverageRows = buildCoverageRows(store, date, linkRows, performanceRows);
    const suggestionRows = buildSuggestionRows(store, date, linkRows, performanceRows, inventoryRows, coverageRows);
    const dashboardRows = buildDashboardRows(store, date, linkRows, performanceRows, inventoryRows, coverageRows, suggestionRows);

    return {
      ok: true,
      date,
      fetchTime,
      store: {
        storeKey: store.storeKey,
        groupKey: store.groupKey,
        shopName: store.shopName || '',
        port: store.port,
      },
      counts: {
        productsByStatus: Object.fromEntries(productStatuses.map(x => [x.status, x.count])),
        stockup: stockup.count,
        diagnoseDay: diagnose.day.count,
        diagnoseC7: diagnose.c7.count,
        diagnosePrev7: diagnose.prev7.count,
        diagnoseC30: diagnose.c30.count,
        flowDiagnose: flow.rows.length,
        releasedPrices: releasedPriceBySpu.size,
        linkRows: linkRows.length,
        inventoryRows: inventoryRows.length,
        performanceRows: performanceRows.length,
        coverageRows: coverageRows.length,
        suggestionRows: suggestionRows.length,
      },
      updateTimes: {
        flowDiagnoseLastUpdateTime: flow.lastUpdateTime || '',
      },
      linkRows,
      performanceRows,
      inventoryRows,
      releasedPriceRows: [...releasedPriceBySpu.values()],
      coverageRows,
      suggestionRows,
      dashboardRows,
      raw: args.saveRaw ? {productStatuses, stockup, diagnose, flow} : undefined,
    };
  } finally {
    cdp.close();
  }
}

async function writeStoreResult(args, result) {
  const storeKey = result.store.storeKey;
  const dir = path.join(args.outDir, storeKey);
  await fs.mkdir(dir, {recursive: true});
  const file = path.join(dir, `${result.date}.json`);
  const normalized = {...result};
  delete normalized.raw;
  await fs.writeFile(file, JSON.stringify(normalized, null, 2), 'utf8');
  let rawFile = null;
  if (args.saveRaw && result.raw) {
    const rawDir = path.join(args.rawDir, storeKey, result.date);
    await fs.mkdir(rawDir, {recursive: true});
    rawFile = path.join(rawDir, `${Date.now()}.json`);
    await fs.writeFile(rawFile, JSON.stringify(result.raw, null, 2), 'utf8');
  }
  return {file, rawFile};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stores = selectedStores(args);
  const results = [];
  for (const store of stores) {
    try {
      const result = await fetchStore(store, args);
      const files = await writeStoreResult(args, result);
      results.push({storeKey: store.storeKey, ok: true, file: files.file, rawFile: files.rawFile, counts: result.counts});
      console.log(`[${store.storeKey}] ok ${JSON.stringify(result.counts)}`);
    } catch (err) {
      results.push({storeKey: store.storeKey, ok: false, error: String(err?.stack || err)});
      console.error(`[${store.storeKey}] ERROR ${err?.message || err}`);
    }
  }
  const summary = {
    ok: results.every(r => r.ok),
    date: args.date,
    stores: results,
    outDir: args.outDir,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

await main();
