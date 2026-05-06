#!/usr/bin/env node
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'shein_openapi.local.json');

function parseArgs(argv) {
  const args = {config: DEFAULT_CONFIG, store: 'HL', dates: [], outDir: path.join(ROOT, 'tmp', 'shein-openapi-runtime')};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--store') args.store = argv[++i];
    else if (a === '--date') args.dates.push(argv[++i]);
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/reconcile_shein_openapi_hl_sales.mjs --date 2026-05-05
  node scripts/reconcile_shein_openapi_hl_sales.mjs --start 2026-05-05 --end 2026-05-06

读取 SHEIN OpenAPI 订单列表/详情，与现有浏览器抓取 outputs/shein_fetch/<店>/<日期>.json 做日维度对账。`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (args.start) {
    if (!args.end) args.end = args.start;
    for (const d of eachDate(args.start, args.end)) args.dates.push(d);
  }
  if (!args.dates.length) throw new Error('请提供 --date 或 --start/--end');
  return args;
}

function* eachDate(start, end) {
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

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function setDiff(left, right) {
  return [...left].filter((x) => !right.has(x));
}

function isPositiveSaleLine(order, item) {
  const orderStatus = Number(order?.orderStatus);
  const goodsStatus = Number(item?.newGoodsStatus);
  const estimatedIncome = Number(item?.estimatedIncome || 0);
  if (!Number.isFinite(estimatedIncome) || estimatedIncome <= 0) return false;
  if (orderStatus === 6 || goodsStatus === 6) return false;
  return true;
}

function summarizeOpenApi(date, orderList, orderDetails) {
  const ordersByNo = new Map(orderDetails.map((o) => [String(o.orderNo), o]));
  const goodsRows = [];
  for (const order of orderDetails) {
    for (const item of asArray(order.orderGoodsInfoList)) {
      goodsRows.push({order, item});
    }
  }
  const positiveGoodsRows = goodsRows.filter(({order, item}) => isPositiveSaleLine(order, item));
  const positiveOrderNos = new Set(positiveGoodsRows.map(({order}) => String(order.orderNo)));
  const orderNos = new Set(orderList.map((o) => String(o.orderNo)));
  return {
    date,
    orderRefCount: orderList.length,
    detailedOrderCount: orderDetails.length,
    missingDetailCount: [...orderNos].filter((no) => !ordersByNo.has(no)).length,
    positiveAmountOrderCount: positiveOrderNos.size,
    goodsLineCount: goodsRows.length,
    quantityAll: goodsRows.length,
    quantityPositiveAmount: positiveGoodsRows.length,
    salesSar: round2(positiveGoodsRows.reduce((sum, row) => sum + Number(row.item.estimatedIncome || 0), 0)),
    orderNos: [...orderNos].sort(),
    positiveOrderNos: [...positiveOrderNos].sort(),
    goodsIds: goodsRows.map(({item}) => String(item.goodsId)).filter(Boolean).sort(),
  };
}

function summarizeBrowser(file) {
  if (!fssync.existsSync(file)) return null;
  const data = JSON.parse(fssync.readFileSync(file, 'utf8'));
  const summary = data.summary || {};
  return {
    date: data.start || data.date || path.basename(file, '.json'),
    orderRefCount: Number(summary.orderRefCount || 0),
    apiCount: Number(summary.apiCount || 0),
    detailedOrderCount: Number(summary.detailedOrderCount || 0),
    positiveAmountOrderCount: Number(summary.positiveAmountOrderCount || 0),
    goodsLineCount: Number(summary.goodsLineCount || 0),
    quantityAll: Number(summary.quantityAll || 0),
    quantityPositiveAmount: Number(summary.quantityPositiveAmount || 0),
    salesSar: round2(summary.salesSar || 0),
    orderNos: asArray(data.orderRows).map((r) => String(r.orderNo)).filter(Boolean).sort(),
    goodsIds: asArray(data.goodsRows).map((r) => String(r.goodsId)).filter(Boolean).sort(),
    fetchTime: data.fetchTime || null,
  };
}

async function fetchOrderListForDate(client, date) {
  const pageSize = 30;
  const all = [];
  let total = null;
  for (let page = 1; page < 400; page++) {
    const response = await client.request('/open-api/order/order-list', {
      body: {
        queryType: 1,
        startTime: `${date} 00:00:00`,
        endTime: `${date} 23:59:59`,
        page,
        pageSize,
      },
    });
    if (String(response.data?.code) !== '0') {
      throw new Error(`order-list ${date} failed: code=${response.data?.code} msg=${response.data?.msg} traceId=${response.data?.traceId}`);
    }
    total = Number(response.data?.info?.count ?? 0);
    const rows = asArray(response.data?.info?.orderList);
    all.push(...rows);
    if (!rows.length || all.length >= total || rows.length < pageSize) break;
  }
  return all;
}

async function fetchOrderDetails(client, orderNos) {
  const out = [];
  for (const part of chunk(orderNos, 30)) {
    if (!part.length) continue;
    const response = await client.request('/open-api/order/order-detail', {body: {orderNoList: part}});
    if (String(response.data?.code) !== '0') {
      throw new Error(`order-detail failed: code=${response.data?.code} msg=${response.data?.msg} traceId=${response.data?.traceId}`);
    }
    out.push(...asArray(response.data?.info));
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const config = await readJson(args.config);
const store = asArray(config.stores).find((s) => String(s.storeKey).toUpperCase() === String(args.store).toUpperCase());
if (!store?.openKeyId || !store?.secretKey) throw new Error(`${args.store} 未完成 SHEIN OpenAPI 授权`);

const client = new SheinOpenApiClient({
  baseUrl: config.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
  openKeyId: store.openKeyId,
  secretKey: store.secretKey,
});

const reports = [];
for (const date of args.dates) {
  const orderList = await fetchOrderListForDate(client, date);
  const orderNos = orderList.map((o) => String(o.orderNo)).filter(Boolean);
  const orderDetails = await fetchOrderDetails(client, orderNos);
  const openapi = summarizeOpenApi(date, orderList, orderDetails);
  const browserFile = path.join(ROOT, 'outputs', 'shein_fetch', args.store, `${date}.json`);
  const browser = summarizeBrowser(browserFile);
  const browserOrderSet = new Set(browser?.orderNos || []);
  const openapiOrderSet = new Set(openapi.orderNos || []);
  const browserGoodsSet = new Set(browser?.goodsIds || []);
  const openapiGoodsSet = new Set(openapi.goodsIds || []);
  const compare = {
    orderRefCountDelta: browser ? openapi.orderRefCount - browser.orderRefCount : null,
    detailedOrderCountDelta: browser ? openapi.detailedOrderCount - browser.detailedOrderCount : null,
    positiveAmountOrderCountDelta: browser ? openapi.positiveAmountOrderCount - browser.positiveAmountOrderCount : null,
    goodsLineCountDelta: browser ? openapi.goodsLineCount - browser.goodsLineCount : null,
    quantityPositiveAmountDelta: browser ? openapi.quantityPositiveAmount - browser.quantityPositiveAmount : null,
    salesSarDelta: browser ? round2(openapi.salesSar - browser.salesSar) : null,
    openapiOnlyOrderCount: browser ? setDiff(openapiOrderSet, browserOrderSet).length : null,
    browserOnlyOrderCount: browser ? setDiff(browserOrderSet, openapiOrderSet).length : null,
    openapiOnlyGoodsCount: browser ? setDiff(openapiGoodsSet, browserGoodsSet).length : null,
    browserOnlyGoodsCount: browser ? setDiff(browserGoodsSet, openapiGoodsSet).length : null,
  };
  const report = {date, storeKey: args.store, generatedAt: new Date().toISOString(), browserFile: path.relative(ROOT, browserFile).replace(/\\/g, '/'), openapi, browser, compare};
  const outPath = path.join(args.outDir, `hl-openapi-reconcile-${date}.local.json`);
  await writeJson(outPath, report);
  reports.push({date, savedTo: path.relative(ROOT, outPath).replace(/\\/g, '/'), openapi: {
    orderRefCount: openapi.orderRefCount,
    positiveAmountOrderCount: openapi.positiveAmountOrderCount,
    goodsLineCount: openapi.goodsLineCount,
    quantityPositiveAmount: openapi.quantityPositiveAmount,
    salesSar: openapi.salesSar,
  }, browser: browser ? {
    orderRefCount: browser.orderRefCount,
    positiveAmountOrderCount: browser.positiveAmountOrderCount,
    goodsLineCount: browser.goodsLineCount,
    quantityPositiveAmount: browser.quantityPositiveAmount,
    salesSar: browser.salesSar,
  } : null, compare});
}

console.log(JSON.stringify({ok: true, storeKey: args.store, reports}, null, 2));
