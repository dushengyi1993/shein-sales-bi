#!/usr/bin/env node
/**
 * Fetch SHEIN order/item details through an already logged-in Chrome profile.
 *
 * Usage:
 *   node scripts/fetch_shein_sales.mjs DL --date 2026-03-31
 *   node scripts/fetch_shein_sales.mjs DL --start 2026-03-01 --end 2026-03-31 --by-day
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storesConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const ORDER_URL = 'https://sso.geiwohuo.com/#/gsp/order-management/list';
const CDP_COMMAND_TIMEOUT_MS = Number(process.env.SHEIN_CDP_TIMEOUT_MS || 60_000);
const PAGE_FETCH_TIMEOUT_MS = Number(process.env.SHEIN_PAGE_FETCH_TIMEOUT_MS || 45_000);

function parseArgs(argv) {
  const args = {outDir: path.join(ROOT, 'outputs', 'shein_fetch'), perPage: 50, byDay: false};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--out') args.outDir = path.resolve(argv[++i]);
    else if (a === '--per-page') args.perPage = Number(argv[++i]);
    else if (a === '--by-day') args.byDay = true;
    else if (a === '--json') args.json = true;
    else rest.push(a);
  }
  args.storeKey = (rest[0] || '').toUpperCase();
  if (!args.storeKey) throw new Error('Missing store key, e.g. DL');
  if (rest[1] && !args.date && !args.start) args.date = rest[1];
  if (args.date) {
    args.start = args.date;
    args.end = args.date;
  }
  if (!args.start) throw new Error('Missing --date or --start');
  if (!args.end) args.end = args.start;
  return args;
}

function isoDateOk(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function* eachDate(start, end) {
  if (!isoDateOk(start) || !isoDateOk(end)) throw new Error('Date must be YYYY-MM-DD');
  const d = new Date(`${start}T00:00:00+08:00`);
  const stop = new Date(`${end}T00:00:00+08:00`);
  while (d <= stop) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    yield `${y}-${m}-${day}`;
    d.setDate(d.getDate() + 1);
  }
}

function getStore(key) {
  const store = storesConfig.stores.find(s => s.storeKey.toUpperCase() === key);
  if (!store) throw new Error(`Unknown store key: ${key}`);
  return store;
}

async function connectCdp(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(p => p.type === 'page' && /geiwohuo|shein/i.test(p.url)) || targets.find(p => p.type === 'page');
  if (!page) throw new Error(`No Chrome page target on port ${port}. 请先启动并登录该店铺浏览器。`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
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
        reject(new Error(`CDP command timed out after ${CDP_COMMAND_TIMEOUT_MS}ms: ${method}`));
      }, CDP_COMMAND_TIMEOUT_MS);
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
  await send('Runtime.enable');
  await send('Page.enable');
  return {ws, send, page};
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function currentPageInfo(send) {
  const result = await send('Runtime.evaluate', {
    expression: `(() => ({href: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 1000)}))()`,
    returnByValue: true,
  });
  return result.result?.value || {};
}

async function ensureOrderPage(send) {
  let info = await currentPageInfo(send);
  if (String(info.href || '').includes('/gsp/order-management/list')) {
    return {navigated: false, href: info.href, title: info.title};
  }
  await send('Page.navigate', {url: ORDER_URL});
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    info = await currentPageInfo(send);
    if (String(info.href || '').includes('/gsp/order-management/list') && /我的订单|订单创建时间|搜索/.test(String(info.text || ''))) {
      return {navigated: true, href: info.href, title: info.title};
    }
  }
  return {navigated: true, href: info.href, title: info.title, warning: 'order page readiness not confirmed'};
}

async function pageFetch(send, endpoint, payload) {
  const doFetch = async () => {
    const expression = `(() => {
    const endpoint = ${JSON.stringify(endpoint)};
    const payload = ${JSON.stringify(payload)};
    const timeoutMs = ${JSON.stringify(PAGE_FETCH_TIMEOUT_MS)};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json;Charset=utf-8',
        'Origin-Path': '/order-management/list',
        'Origin-Url': location.origin + '/#/gsp/order-management/list',
        'build-version': '2026-04-23 11:38'
      },
      body: JSON.stringify(payload)
    }).then(async res => {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {status: res.status, text, json};
    }).catch(err => ({
      status: 0,
      text: String(err && (err.stack || err.message) || err),
      json: {code: 'FETCH_ERROR', msg: String(err && (err.message || err) || 'fetch failed')}
    })).finally(() => {
      clearTimeout(timer);
    });
  })()`;
    const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  let value = await doFetch();
  if (value?.json?.code === 20302 || value?.json?.code === '20302') {
    await ensureOrderPage(send);
    await sleep(1000);
    value = await doFetch();
  }
  if (!value?.json) throw new Error(`Non-JSON response from ${endpoint}: ${String(value?.text || '').slice(0, 300)}`);
  if (value.json.code !== '0') throw new Error(`${endpoint} failed: code=${value.json.code} msg=${value.json.msg}`);
  return value.json;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localDateTimeToUtcMs(ymd, hms, utcOffsetHours) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm, ss] = hms.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss) - Number(utcOffsetHours) * 3600_000;
}

function utcMsToLocalDateTime(ms, utcOffsetHours) {
  const d = new Date(ms + Number(utcOffsetHours) * 3600_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function accountRangeForBusinessRange(start, end, businessUtcOffsetHours, accountUtcOffsetHours) {
  const startUtc = localDateTimeToUtcMs(start, '00:00:00', businessUtcOffsetHours);
  const endUtc = localDateTimeToUtcMs(end, '23:59:59', businessUtcOffsetHours);
  return {
    allocateTimeStart: utcMsToLocalDateTime(startUtc, accountUtcOffsetHours),
    allocateTimeEnd: utcMsToLocalDateTime(endUtc, accountUtcOffsetHours),
  };
}

async function detectAccountUtcOffset(send, store) {
  if (store.accountUtcOffsetHours !== undefined) return Number(store.accountUtcOffsetHours);
  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body?.innerText || '';
      const m = text.match(/UTC\\s*([+-])\\s*(\\d{1,2})(?::?(\\d{2}))?/i);
      if (!m) return null;
      const sign = m[1] === '-' ? -1 : 1;
      const hours = Number(m[2] || 0);
      const minutes = Number(m[3] || 0);
      return sign * (hours + minutes / 60);
    })()`,
    returnByValue: true,
  });
  const value = result.result?.value;
  return Number.isFinite(value) ? value : 8;
}

function pickTimeByCode(group, code) {
  return (group.statusTimeline?.logisticsTimes || [])
    .find(t => t.timeCode === code);
}

function extractRows(orders) {
  const orderRows = [];
  const goodsRows = [];
  for (const order of orders) {
    const base = {
      orderId: order.id || order.orderId,
      orderNo: order.orderNo,
      billno: order.billno,
      orderStatus: order.orderStatus,
      orderStatusDesc: order.orderStatusDesc,
      performStatus: order.performStatus,
      performStatusDesc: order.performStatusDesc,
      allocateTime: order.allocateTime,
      allocateTimeFull: order.g_zcs_allocateTime,
      site: order.site,
      orderType: order.orderType,
    };
    orderRows.push(base);
    for (const group of order.groupList || []) {
      const orderTime = pickTimeByCode(group, 'ORDER_TIME');
      const splitTime = pickTimeByCode(group, 'ORDER_SPLIT_TIME');
      const orderCustomerTime = orderTime?.time || orderTime?.g_zcs_time || null;
      const orderCreateTime = splitTime?.time || splitTime?.g_zcs_time || order.g_zcs_allocateTime || order.allocateTime;
      for (const goods of group.goodsList || []) {
        goodsRows.push({
          ...base,
          pageStatus: group.statusTimeline?.pageStatus,
          pageStatusDesc: group.statusTimeline?.pageStatusDesc,
          orderCustomerTime,
          orderCreateTime,
          goodsId: goods.id,
          entityId: goods.entityId,
          goodsSn: goods.goodsSn,
          skuSn: goods.skuSn,
          skuCode: goods.skuCode,
          skcName: goods.skcName,
          suffix: goods.suffix,
          goodsTitle: goods.goodsTitle,
          number: Number(goods.number || 0),
          currencyCode: goods.currencyCode || 'SAR',
          currencyPrice: Number(goods.currencyPrice || 0),
          newOrderGoodsStatus: goods.newOrderGoodsStatus,
          goodsPerformanceStatus: goods.goodsPerformanceStatus,
          goodsPerformanceStatusDesc: goods.goodsPerformanceStatusDesc,
          goodsExchangeTag: goods.goodsExchangeTag,
          performanceTag: goods.performanceTag,
          storageTag: goods.storageTag,
        });
      }
    }
  }
  return {orderRows, goodsRows};
}
async function fetchRange(send, store, start, end, perPage, timezone) {
  const businessUtcOffsetHours = timezone.businessUtcOffsetHours;
  const accountUtcOffsetHours = timezone.accountUtcOffsetHours;
  const accountRange = accountRangeForBusinessRange(start, end, businessUtcOffsetHours, accountUtcOffsetHours);
  const basePayload = {
    allocateTimeStart: accountRange.allocateTimeStart,
    allocateTimeEnd: accountRange.allocateTimeEnd,
    excludeOrderType: 5,
    tabIndex: 1,
    page: 1,
    perPage,
  };
  const first = await pageFetch(send, '/gsp/orderPlus/listOrder', basePayload);
  const count = Number(first.info?.meta?.count || 0);
  const pages = Math.max(1, Math.ceil(count / perPage));
  const orderRefs = [...(first.info?.data || [])];
  for (let page = 2; page <= pages; page++) {
    const resp = await pageFetch(send, '/gsp/orderPlus/listOrder', {...basePayload, page});
    orderRefs.push(...(resp.info?.data || []));
  }

  const itemResponses = [];
  for (let i = 0; i < orderRefs.length; i += 50) {
    const chunk = orderRefs.slice(i, i + 50);
    if (!chunk.length) continue;
    const resp = await pageFetch(send, '/gsp/orderPlus/listOrderItem', {
      orderPlusListPageVOList: chunk,
      tabIndex: 1,
    });
    itemResponses.push(resp);
  }
  const orders = itemResponses.flatMap(r => Array.isArray(r.info) ? r.info : []);
  const {orderRows, goodsRows} = extractRows(orders);
  const salesSar = round2(goodsRows.reduce((s, g) => s + g.currencyPrice, 0));
  const positiveAmountOrderCount = new Set(goodsRows.filter(g => g.currencyPrice > 0).map(g => g.orderNo || g.orderId)).size;
  const quantityAll = goodsRows.reduce((s, g) => s + g.number, 0);
  const quantityPositiveAmount = goodsRows.filter(g => g.currencyPrice > 0).reduce((s, g) => s + g.number, 0);
  return {
    storeKey: store.storeKey,
    shopName: store.shopName,
    groupKey: store.groupKey,
    start,
    end,
    fetchTime: new Date().toISOString(),
    request: basePayload,
    timezone: {
      businessUtcOffsetHours,
      accountUtcOffsetHours,
      businessRange: {
        start: `${start} 00:00:00`,
        end: `${end} 23:59:59`,
      },
      accountQueryRange: accountRange,
    },
    summary: {
      orderRefCount: orderRefs.length,
      apiCount: count,
      detailedOrderCount: orderRows.length,
      positiveAmountOrderCount,
      goodsLineCount: goodsRows.length,
      quantityAll,
      quantityPositiveAmount,
      salesSar,
      salesRmb: round2(salesSar * Number(storesConfig.fx?.sarToRmb || 1.8)),
    },
    orderRefs,
    orders,
    orderRows,
    goodsRows,
  };
}

async function saveResult(outDir, storeKey, label, result) {
  const dir = path.join(outDir, storeKey.toUpperCase());
  await fs.mkdir(dir, {recursive: true});
  const file = path.join(dir, `${label}.json`);
  await fs.writeFile(file, JSON.stringify(result, null, 2), 'utf8');
  return file;
}

const args = parseArgs(process.argv.slice(2));
const store = getStore(args.storeKey);
const {ws, send, page} = await connectCdp(store.port);
try {
  const orderPage = await ensureOrderPage(send);
  const timezone = {
    businessUtcOffsetHours: Number(storesConfig.businessUtcOffsetHours ?? 8),
    accountUtcOffsetHours: await detectAccountUtcOffset(send, store),
  };
  const dates = [...eachDate(args.start, args.end)];
  if (args.byDay || dates.length === 1) {
    const daily = [];
    for (const d of dates) {
      const result = await fetchRange(send, store, d, d, args.perPage, timezone);
      const file = await saveResult(args.outDir, store.storeKey, d, result);
      daily.push({date: d, file, ...result.summary});
    }
    const totalSar = round2(daily.reduce((s, d) => s + d.salesSar, 0));
    const output = {
      storeKey: store.storeKey,
      shopName: store.shopName,
      pageUrl: orderPage.href || page.url,
      orderPage,
      mode: 'by-day',
      start: args.start,
      end: args.end,
      timezone,
      days: daily,
      totalSar,
      totalRmb: round2(totalSar * Number(storesConfig.fx?.sarToRmb || 1.8)),
    };
    const label = dates.length === 1 ? `${dates[0]}_summary` : `${args.start}_to_${args.end}_daily-summary`;
    const file = await saveResult(args.outDir, store.storeKey, label, output);
    if (args.json) console.log(JSON.stringify({...output, file}, null, 2));
    else {
      console.log(JSON.stringify({
        file,
        storeKey: output.storeKey,
        shopName: output.shopName,
        start: output.start,
        end: output.end,
        days: output.days.length,
        totalSar: output.totalSar,
        totalRmb: output.totalRmb,
        orderPage,
        daily: output.days.map(d => ({
          date: d.date,
          orders: d.detailedOrderCount,
          goods: d.goodsLineCount,
          qty: d.quantityPositiveAmount,
          salesSar: d.salesSar,
        })),
      }, null, 2));
    }
  } else {
    const result = await fetchRange(send, store, args.start, args.end, args.perPage, timezone);
    result.orderPage = orderPage;
    const file = await saveResult(args.outDir, store.storeKey, `${args.start}_to_${args.end}`, result);
    console.log(JSON.stringify({file, ...result.summary}, null, 2));
  }
} finally {
  ws.close();
}
