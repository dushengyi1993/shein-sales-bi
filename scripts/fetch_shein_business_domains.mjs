#!/usr/bin/env node
/**
 * Read-only SHEIN business-domain fetcher.
 *
 * This is the first warehouse-oriented fetcher beyond the original sales/link
 * jobs. It collects operational domains that are needed for a real BI system:
 * after-sales, waybill/fulfillment, visible stock, quality, comments,
 * marketing and management indicators.
 *
 * It only uses the already logged-in Chrome profile for a store. No credentials
 * or request headers are persisted.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORES_PATH = path.join(ROOT, 'config', 'stores.json');
const OUT_DIR = path.join(ROOT, 'outputs', 'shein_business_domains');
const ORIGIN = 'https://sso.geiwohuo.com';

const ROUTES = {
  home: `${ORIGIN}/#/home`,
  orders: `${ORIGIN}/#/gsp/order-management/list`,
  afterSales: `${ORIGIN}/#/gsp/order-management/after-sales-list`,
  waybill: `${ORIGIN}/#/gsp/order-management/deliver-waybill-list`,
  productList: `${ORIGIN}/#/spmp/commdities/list`,
  finance: `${ORIGIN}/#/gsfs/finance-management/list`,
  management: `${ORIGIN}/#/sbn/managementAnalysis/index`,
  marketing: `${ORIGIN}/#/sbn/marketing/activities`,
  quality: `${ORIGIN}/#/pqmp/commoditiesQuality/list`,
  feedback: `${ORIGIN}/#/mgs/store-management/product-feedback`,
  fulfillment: `${ORIGIN}/#/mgs/performance_time_analysis`,
};

const DOMAIN_KEYS = [
  'home',
  'afterSales',
  'waybill',
  'fulfillment',
  'productInventory',
  'finance',
  'management',
  'marketing',
  'quality',
  'comments',
];
const DEFAULT_COMMENT_LOOKBACK_DAYS = 14;
const DEFAULT_FINANCE_LOOKBACK_DAYS = 89;

const storesConfig = JSON.parse(await fs.readFile(STORES_PATH, 'utf8'));

function parseArgs(argv) {
  const args = {
    stores: null,
    group: 'ALL',
    date: bjDate(-1),
    outDir: OUT_DIR,
    pageSize: 50,
    maxPages: 20,
    waitMs: 2500,
    commentLookbackDays: DEFAULT_COMMENT_LOOKBACK_DAYS,
    autoRelogin: true,
    reloginVisible: true,
    storeAttempts: 2,
    domains: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store') args.stores = [argv[++i].trim().toUpperCase()];
    else if (a === '--stores') args.stores = argv[++i].split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (a === '--group') args.group = argv[++i].trim().toUpperCase();
    else if (a === '--date') args.date = argv[++i].trim();
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--page-size') args.pageSize = Number(argv[++i]);
    else if (a === '--max-pages') args.maxPages = Number(argv[++i]);
    else if (a === '--wait-ms') args.waitMs = Number(argv[++i]);
    else if (a === '--comment-lookback-days') args.commentLookbackDays = Math.max(0, Number(argv[++i] || DEFAULT_COMMENT_LOOKBACK_DAYS));
    else if (a === '--no-auto-relogin') args.autoRelogin = false;
    else if (a === '--relogin-headless') { args.autoRelogin = true; args.reloginVisible = false; }
    else if (a === '--relogin-visible') { args.autoRelogin = true; args.reloginVisible = true; }
    else if (a === '--store-attempts') args.storeAttempts = Math.max(1, Number(argv[++i] || 1));
    else if (a === '--domains') {
      args.domains = new Set(String(argv[++i] || '').split(',').map(x => x.trim()).filter(Boolean));
    }
    else if (a === '--json') args.json = true;
  }
  return args;
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

function addDays(ymd, delta) {
  const d = new Date(`${ymd}T00:00:00+08:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function ymdCompact(ymd) {
  return String(ymd).replace(/-/g, '');
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
  if (!Array.isArray(keys)) throw new Error(`Unknown group: ${args.group}`);
  return keys.map(key => {
    const store = enabled.find(s => s.storeKey === key);
    if (!store) throw new Error(`Store ${key} is not configured or disabled`);
    return store;
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runNode(script, args, timeoutMs = 240_000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ok: false, code: null, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim()});
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ok: false, code: null, stdout, stderr: String(err?.stack || err)});
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ok: code === 0, code, stdout, stderr});
    });
  });
}

function parseJsonFromOutput(text) {
  const s = String(text || '').trim();
  const starts = [s.indexOf('{'), s.indexOf('[')].filter(i => i >= 0);
  if (!starts.length) return null;
  try { return JSON.parse(s.slice(Math.min(...starts))); } catch { return null; }
}

function isLoginRedirectError(error) {
  return /20302|GMPSSO|login\/|login redirect|account login/i.test(String(error || ''));
}

async function tryAutoRelogin(store, args, key) {
  if (!args.autoRelogin) {
    return {key, attempted: false, ok: false, skipped: true, reason: 'auto_relogin_disabled'};
  }
  const reloginArgs = [store.storeKey, '--date', args.date, args.reloginVisible ? '--visible' : '--headless'];
  const relogin = await runNode('auto_relogin_shein_store.mjs', reloginArgs, 240_000);
  const parsed = parseJsonFromOutput(relogin.stdout);
  return {
    key,
    attempted: true,
    ok: relogin.ok && parsed?.ok !== false,
    code: relogin.code,
    mode: args.reloginVisible ? 'visible' : 'headless',
    stdoutTail: relogin.stdout.slice(-1500),
    stderrTail: relogin.stderr.slice(-1500),
    parsed,
  };
}

async function connectCdp(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(4000)})).json();
  const page = targets.find(p => p.type === 'page' && /geiwohuo|shein/i.test(p.url)) || targets.find(p => p.type === 'page');
  if (!page) throw new Error(`No Chrome page target on port ${port}.`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const {resolve, reject} = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once: true});
    ws.addEventListener('error', reject, {once: true});
  });
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
  };
  await send('Runtime.enable');
  await send('Page.enable');
  return {ws, send, page};
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

async function navigate(send, url, waitMs) {
  await send('Page.navigate', {url});
  await sleep(waitMs);
  return evaluate(send, `(() => ({href: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 8000)}))()`);
}

async function pageFetch(send, endpoint, payload = {}, options = {}) {
  const method = options.method || 'POST';
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Origin-Path': options.originPath || '',
    'Origin-Url': options.originUrl || '',
    ...(options.headers || {}),
  };
  const expression = `(() => {
    const endpoint = ${JSON.stringify(endpoint)};
    const payload = ${JSON.stringify(payload ?? {})};
    const method = ${JSON.stringify(method)};
    const headers = ${JSON.stringify(headers)};
    if (!headers['Origin-Path']) headers['Origin-Path'] = location.hash ? location.hash.replace(/^#/, '') : location.pathname;
    if (!headers['Origin-Url']) headers['Origin-Url'] = location.href;
    return fetch(endpoint, {
      method,
      credentials: 'include',
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(payload)
    }).then(async res => {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {status: res.status, text, json};
    });
  })()`;
  const value = await evaluate(send, expression);
  if (!value?.json) throw new Error(`Non-JSON response from ${endpoint}: ${String(value?.text || '').slice(0, 300)}`);
  const code = String(value.json.code ?? value.json.status ?? '');
  if (code && code !== '0') throw new Error(`${endpoint} failed: code=${value.json.code} msg=${value.json.msg || value.json.message || ''}`);
  return value.json;
}

async function fetchPaged(send, endpoint, basePayload, pickList, args) {
  const rows = [];
  let page = 1;
  let metaCount = null;
  while (page <= args.maxPages) {
    const payload = {...basePayload, page, pageNum: basePayload.pageNum === undefined ? undefined : page};
    if (payload.pageNum === undefined) delete payload.pageNum;
    const json = await pageFetch(send, endpoint, payload);
    const list = pickList(json);
    rows.push(...list);
    metaCount = json.info?.meta?.count ?? json.info?.count ?? metaCount;
    if (Number.isFinite(Number(metaCount)) && rows.length >= Number(metaCount)) break;
    if (!list.length || list.length < (basePayload.perPage || basePayload.pageSize || args.pageSize)) break;
    page += 1;
  }
  return {rows, metaCount};
}

function compactResponse(json, maxLen = 15000) {
  const text = JSON.stringify(json ?? null);
  return text.length > maxLen ? {truncated: true, preview: text.slice(0, maxLen)} : json;
}

function productStockPayload(productRows) {
  const out = [];
  const seen = new Set();
  for (const p of productRows || []) {
    const spu = p.spu_name || p.spu || p.spuCode || p.spu_name_en;
    if (!spu || seen.has(spu)) continue;
    const skcList = (p.skc_info_list || [])
      .map(s => ({
        skc_name: s.skc_name || s.skc || s.skc_code,
        sku_code_list: (s.sku_info || []).map(x => x.sku_code).filter(Boolean),
      }))
      .filter(x => x.skc_name)
      .filter(Boolean)
      .slice(0, 20);
    out.push({spu_name: spu, skc_name_list: skcList});
    seen.add(spu);
  }
  return out;
}

async function fetchProductsAndVisibleStock(send, args) {
  await navigate(send, ROUTES.productList, args.waitMs);
  const productRows = [];
  let pageNum = 1;
  let total = null;
  while (pageNum <= args.maxPages) {
    const json = await pageFetch(
      send,
      `/spmp-api-prefix/spmp/product/list?page_num=${pageNum}&page_size=${args.pageSize}`,
      {shelf_status: 'ALL'}
    );
    const batch = json.info?.data || [];
    productRows.push(...batch);
    total = json.info?.meta?.count ?? total;
    if (Number.isFinite(Number(total)) && productRows.length >= Number(total)) break;
    if (!batch.length || batch.length < args.pageSize) break;
    pageNum += 1;
  }

  const stockRows = [];
  const stockErrors = [];
  const items = productStockPayload(productRows);
  for (let i = 0; i < items.length; i += 20) {
    const chunk = items.slice(i, i + 20);
    if (!chunk.length) continue;
    try {
      const json = await pageFetch(send, '/spmp-api-prefix/spmp/product/query_msc_stock_for_released_page', {
        spu_skc_list: chunk,
      });
      stockRows.push(...(json.info?.data || []));
    } catch (err) {
      stockErrors.push({chunkStart: i, error: String(err?.message || err)});
    }
  }
  return {
    productRows,
    visibleStockRows: stockRows,
    meta: {productCount: productRows.length, stockCount: stockRows.length, productTotal: total, stockErrors},
  };
}

async function fetchAfterSales(send, args) {
  await navigate(send, ROUTES.afterSales, args.waitMs);
  const list = await fetchPaged(
    send,
    '/gsp/aftersalesOrder/list',
    {quickType: 0, page: 1, perPage: args.pageSize},
    json => json.info?.data || [],
    args
  );
  const statistic = await pageFetch(send, '/gsp/aftersalesOrder/statistic', {}).catch(err => ({error: String(err.message || err)}));
  const reasons = await pageFetch(send, '/gsp/refundReason/listGroup', {}).catch(err => ({error: String(err.message || err)}));
  return {rows: list.rows, statistic, reasons, meta: {count: list.rows.length, metaCount: list.metaCount}};
}

async function fetchWaybill(send, args) {
  await navigate(send, ROUTES.waybill, args.waitMs);
  const end = `${args.date} 23:59:59`;
  const start = `${addDays(args.date, -29)} 00:00:00`;
  const list = await fetchPaged(
    send,
    '/gsp/place/order/deliver/print/list',
    {page: 1, perPage: args.pageSize, placeOrderStartTime: start, placeOrderEndTime: end},
    json => json.info?.data || [],
    args
  );
  const count = await pageFetch(send, '/gsp/place/order/deliver/print/count', {
    placeOrderStartTime: start,
    placeOrderEndTime: end,
  }).catch(err => ({error: String(err.message || err)}));
  return {rows: list.rows, count, meta: {count: list.rows.length, metaCount: list.metaCount, start, end}};
}

async function fetchFulfillment(send, args) {
  await navigate(send, ROUTES.fulfillment, args.waitMs);
  const start = addDays(args.date, -29);
  const end = args.date;
  const indicator = await pageFetch(send, '/mgs-api-prefix/estimate/newPerformanceIndicator', {
    pay_time_start: start,
    pay_time_end: end,
  });
  const line = await pageFetch(send, '/mgs-api-prefix/estimate/newPerformanceLineChart', {
    pay_time_start: start,
    pay_time_end: end,
  });
  const nonCompliant = await pageFetch(send, '/mgs-api-prefix/estimate/queryPerformanceNonCompliantOrder', {
    pay_time_start: start,
    pay_time_end: end,
    page: 1,
    perPage: args.pageSize,
  }).catch(err => ({error: String(err.message || err)}));
  return {indicator, lineRows: line.info || [], nonCompliant, meta: {start, end}};
}

async function fetchManagement(send, args) {
  await navigate(send, ROUTES.management, args.waitMs);
  let metricDate = args.date;
  let payload = {areaCd: 'cn', dt: ymdCompact(metricDate), countrySite: ['shein-all']};
  const comprehensive = await pageFetch(send, '/sbn/index/get_comprehensive_indicator', payload);
  const info = comprehensive.info || {};
  const hasAnyData = Object.values(info).some(v => v !== null && v !== undefined && (typeof v !== 'object' || Object.values(v).some(x => x !== null && x !== undefined)));
  if (!hasAnyData) {
    metricDate = addDays(args.date, -1);
    payload = {areaCd: 'cn', dt: ymdCompact(metricDate), countrySite: ['shein-all']};
    comprehensive.info = (await pageFetch(send, '/sbn/index/get_comprehensive_indicator', payload)).info;
  }
  const goodsTop = await pageFetch(send, '/sbn/index/get_goods_top', payload).catch(err => ({error: String(err.message || err)}));
  return {comprehensive, goodsTopRows: goodsTop.info || [], meta: {dt: payload.dt, metricDate}};
}

async function fetchMarketing(send, args) {
  await navigate(send, ROUTES.marketing, args.waitMs);
  const dt = ymdCompact(args.date);
  const overviewPayload = {
    areaCd: 'cn',
    dt,
    countrySite: ['shein-all'],
    startDate: args.date,
    endDate: args.date,
    businessActivityTp: '1',
  };
  const overview = await pageFetch(send, '/sbn/marketing/overview', overviewPayload);
  const chart = await pageFetch(send, '/sbn/marketing/overview_chart', {
    ...overviewPayload,
    startDate: addDays(args.date, -6),
  });
  const campaigns = await fetchPaged(
    send,
    '/sbn/marketing/campaign/list',
    {
      areaCd: 'cn',
      dt,
      countrySite: ['shein-all'],
      orderCol: 'startDate',
      orderType: 'desc',
      businessActivityIdList: [],
      pageNum: 1,
      pageSize: args.pageSize,
      startDate: '',
      endDate: '',
      businessActivityTp: '1',
    },
    json => json.info?.data || [],
    args
  );
  return {overview, chartRows: chart.info || [], campaignRows: campaigns.rows, meta: {dt, campaignCount: campaigns.rows.length}};
}

async function fetchQuality(send, args) {
  await navigate(send, ROUTES.quality, args.waitMs);
  const rows = {rows: [], error: ''};
  for (let pageNum = 1; pageNum <= args.maxPages; pageNum++) {
    try {
      const json = await pageFetch(
        send,
        `/pqmp-api-prefix/pqmp/quality_analysis/new_list?page_num=${pageNum}&page_size=${args.pageSize}`,
        {}
      );
      const batch = json.info?.data || [];
      rows.rows.push(...batch);
      const total = Number(json.info?.meta?.count ?? json.info?.count ?? 0);
      if ((total && rows.rows.length >= total) || !batch.length || batch.length < args.pageSize) break;
    } catch (err) {
      rows.error = String(err.message || err);
      break;
    }
  }
  const target = await pageFetch(send, '/pqmp-api-prefix/pqmp/quality_analysis/query_store_quality_target_left', {})
    .catch(err => ({error: String(err.message || err)}));
  return {rows: rows.rows || [], target, meta: {count: rows.rows?.length || 0, error: rows.error || ''}};
}

async function fetchComments(send, args) {
  await navigate(send, ROUTES.feedback, args.waitMs);
  const basePayload = {
    startCommentTime: `${addDays(args.date, -Math.max(0, Number(args.commentLookbackDays || DEFAULT_COMMENT_LOOKBACK_DAYS)))} 00:00:00`,
    commentEndTime: `${args.date} 23:59:59`,
    page: 1,
    perPage: args.pageSize,
  };
  const rows = await fetchPaged(
    send,
    '/mgs-api-prefix/goods/comment/list',
    basePayload,
    json => json.info?.data || [],
    args
  );
  const translated = await fetchPaged(
    send,
    '/mgs-api-prefix/goods/comment/list',
    {...basePayload, translate: 1},
    json => json.info?.data || [],
    args
  ).catch(err => ({rows: [], metaCount: null, error: String(err?.message || err)}));
  const translatedById = new Map((translated.rows || []).map(row => [String(row.commentId || ''), row]));
  const mergedRows = rows.rows.map(row => {
    const translatedRow = translatedById.get(String(row.commentId || ''));
    const zh = translatedRow?.goodsCommentContent || '';
    const logisticZh = translatedRow?.logisticCommentContent || '';
    return {
      ...row,
      goodsCommentContentZh: zh,
      logisticCommentContentZh: logisticZh,
      translationProvider: zh || logisticZh ? 'shein-platform' : '',
      translatedAt: zh || logisticZh ? new Date().toISOString() : '',
    };
  });
  return {
    rows: mergedRows,
    meta: {
      count: rows.rows.length,
      metaCount: rows.metaCount,
      translatedCount: mergedRows.filter(row => row.goodsCommentContentZh).length,
      translateError: translated.error || '',
    },
  };
}

async function fetchHome(send, args) {
  const info = await navigate(send, ROUTES.home, args.waitMs);
  const text = String(info.text || '').replace(/\s+/g, ' ');
  const money = label => {
    const re = new RegExp(`${label}\\s*SAR\\s*([0-9,]+(?:\\.\\d+)?)`);
    const m = text.match(re);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  const numberAfter = label => {
    const re = new RegExp(`${label}\\s*([0-9,]+(?:\\.\\d+)?)`);
    const m = text.match(re);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  const updateTime = text.match(/更新时间[:：]\s*([0-9/:\s-]{10,25})/)?.[1]?.trim() || '';
  return {
    href: info.href,
    title: info.title,
    metrics: {
      updateTime,
      tradeAmountSar: money('成交金额'),
      payUserCount: numberAfter('支付人数'),
      goodsUv: numberAfter('商详访客'),
      saleCount: numberAfter('销量'),
      inTransitOrderAmountSar: money('在途订单金额'),
      pendingSettlementIncomeSar: money('待结算收入'),
      settlementAbnormalSar: money('结算异常'),
      withdrawableAmountSar: money('可提现金额'),
    },
    textPreview: text.slice(0, 6000),
  };
}

async function fetchFinance(send, args) {
  await navigate(send, ROUTES.finance, args.waitMs);
  const start = `${addDays(args.date, -DEFAULT_FINANCE_LOOKBACK_DAYS)} 00:00:00`;
  const end = `${args.date} 23:59:59`;
  const listPayload = {
    orderDeliveryBeginTime: start,
    orderDeliveryEndTime: end,
    page: 1,
    perPage: args.pageSize,
  };

  const isNewPlatformGray = await pageFetch(
    send,
    '/gsfs/finance/platform/isNewPlatformGray',
    {},
    {method: 'GET'}
  ).catch(err => ({error: String(err.message || err)}));

  const accountPrivilege = await pageFetch(
    send,
    '/gsfs/finance/platform/accountPeriodPrivilege',
    {},
    {method: 'GET'}
  ).catch(err => ({error: String(err.message || err)}));

  const showTag = await pageFetch(send, '/gsfs/finance/platform/showTag', {})
    .catch(err => ({error: String(err.message || err)}));

  const allowViewReport = await pageFetch(send, '/gsfs/finance/taxReport/getAllowViewReport', {})
    .catch(err => ({error: String(err.message || err)}));

  const incomeOverview = await pageFetch(
    send,
    '/gsfs/finance/platform/incomeOverview',
    {},
    {method: 'GET'}
  ).catch(err => ({error: String(err.message || err)}));

  const noFinishStats = await pageFetch(
    send,
    '/gsfs/finance/platform/noFinishOrderList/statistics',
    listPayload
  ).catch(err => ({error: String(err.message || err)}));

  const noFinish = await fetchPaged(
    send,
    '/gsfs/finance/platform/noFinishOrderList',
    listPayload,
    json => json.info?.data || [],
    args
  ).catch(err => ({rows: [], metaCount: null, error: String(err.message || err)}));

  return {
    isNewPlatformGray,
    accountPrivilege,
    showTag,
    allowViewReport,
    incomeOverview,
    noFinishStats,
    noFinishRows: noFinish.rows || [],
    meta: {
      start,
      end,
      noFinishCount: noFinish.rows?.length || 0,
      noFinishMetaCount: noFinish.metaCount ?? null,
      noFinishError: noFinish.error || '',
    },
  };
}

async function fetchStore(store, args) {
  const cdp = await connectCdp(store.port);
  const {ws, send} = cdp;
  try {
    const result = {
      ok: true,
      date: args.date,
      fetchTime: nowBjString(),
      store: {
        storeKey: store.storeKey,
        groupKey: store.groupKey,
        shopName: store.shopName,
        profileKey: store.profileKey,
        port: store.port,
      },
      home: null,
      afterSales: null,
      waybill: null,
      fulfillment: null,
      productInventory: null,
      finance: null,
      management: null,
      marketing: null,
      quality: null,
      comments: null,
      errors: [],
      autoRelogin: [],
    };
    const steps = [
      ['home', fetchHome],
      ['afterSales', fetchAfterSales],
      ['waybill', fetchWaybill],
      ['fulfillment', fetchFulfillment],
      ['productInventory', fetchProductsAndVisibleStock],
      ['finance', fetchFinance],
      ['management', fetchManagement],
      ['marketing', fetchMarketing],
      ['quality', fetchQuality],
      ['comments', fetchComments],
    ].filter(([key]) => !args.domains || args.domains.has(key));
    for (const [key, fn] of steps) {
      let lastError = null;
      let done = false;
      const maxAttempts = Math.max(1, Number(args.storeAttempts || 1));
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          result[key] = await fn(send, args);
          done = true;
          break;
        } catch (err) {
          lastError = err;
          const message = String(err?.message || err);
          if (attempt < maxAttempts && isLoginRedirectError(message)) {
            const relogin = await tryAutoRelogin(store, args, key);
            result.autoRelogin.push(relogin);
            if (relogin.ok) {
              await sleep(1500);
              continue;
            }
          }
          break;
        }
      }
      if (!done) {
        result.errors.push({key, error: String(lastError?.message || lastError)});
        result[key] = {error: String(lastError?.message || lastError)};
      }
    }
    result.counts = buildCounts(result);
    return result;
  } finally {
    try { ws.close(); } catch {}
  }
}

async function writeStoreResult(args, result) {
  const dir = path.join(args.outDir, result.store.storeKey);
  await fs.mkdir(dir, {recursive: true});
  const file = path.join(dir, `${result.date}.json`);
  if (args.domains) {
    let existing = null;
    try { existing = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
    if (existing?.store?.storeKey === result.store.storeKey) {
      const merged = {
        ...existing,
        ok: existing.ok !== false && result.ok !== false,
        date: result.date,
        fetchTime: result.fetchTime,
        store: result.store,
        autoRelogin: [...(existing.autoRelogin || []), ...(result.autoRelogin || [])],
      };
      for (const key of DOMAIN_KEYS) {
        const nextValue = result[key];
        const nextFailed = (result.errors || []).some(e => e?.key === key);
        const nextRows = Array.isArray(nextValue?.rows) ? nextValue.rows.length : null;
        if (args.domains.has(key) && !nextFailed && (nextRows === null || nextRows > 0 || !existing[key])) {
          merged[key] = nextValue;
        } else {
          merged[key] = existing[key] ?? nextValue;
        }
      }
      const selectedErrorKeys = new Set([...args.domains]);
      merged.errors = [
        ...(existing.errors || []).filter(e => !selectedErrorKeys.has(e?.key)),
        ...(result.errors || []),
      ];
      merged.counts = buildCounts(merged);
      result = merged;
    }
  }
  // Keep normalized page data complete; downstream warehouse loading depends on
  // these rows. The script still does not persist cookies, headers or tokens.
  await fs.writeFile(file, JSON.stringify(result, null, 2), 'utf8');
  return file;
}

function buildCounts(result) {
  return {
    afterSales: result.afterSales?.rows?.length || 0,
    waybill: result.waybill?.rows?.length || 0,
    visibleStock: result.productInventory?.visibleStockRows?.length || 0,
    productRows: result.productInventory?.productRows?.length || 0,
    financeNoFinishOrders: result.finance?.noFinishRows?.length || 0,
    financeOverview: Array.isArray(result.finance?.incomeOverview?.info) ? result.finance.incomeOverview.info.length : 0,
    fulfillmentDays: result.fulfillment?.lineRows?.length || 0,
    marketingCampaigns: result.marketing?.campaignRows?.length || 0,
    qualityRows: result.quality?.rows?.length || 0,
    comments: result.comments?.rows?.length || 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stores = selectedStores(args);
  const results = [];
  for (const store of stores) {
    try {
      const result = await fetchStore(store, args);
      const file = await writeStoreResult(args, result);
      results.push({storeKey: store.storeKey, ok: true, file, counts: result.counts, errors: result.errors});
      console.log(`[${store.storeKey}] ok ${JSON.stringify({counts: result.counts, errors: result.errors.length})}`);
    } catch (err) {
      results.push({storeKey: store.storeKey, ok: false, error: String(err?.stack || err)});
      console.error(`[${store.storeKey}] ERROR ${err?.message || err}`);
    }
  }
  const summary = {ok: results.every(r => r.ok), date: args.date, stores: results};
  console.log(JSON.stringify(summary, null, 2));
  if (args.json) console.log(JSON.stringify(summary));
  if (!summary.ok) process.exit(1);
}

await main();
