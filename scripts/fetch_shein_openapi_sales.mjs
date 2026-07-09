#!/usr/bin/env node
/**
 * Fetch SHEIN OpenAPI order list/detail data and emit browser-fetch-compatible
 * sales artifacts under outputs/shein_openapi_fetch/.
 *
 * This script is read-only. It does not write to PostgreSQL or modify SHEIN data.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isValidSalesGoodsRow, summarizeSalesGoodsRows} from '../lib/shein_sales_validity.mjs';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'shein_openapi.local.json');

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    store: '',
    outDir: path.join(ROOT, 'outputs', 'shein_openapi_fetch'),
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--out') args.outDir = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/fetch_shein_openapi_sales.mjs HL --date 2026-05-05
  node scripts/fetch_shein_openapi_sales.mjs HL --start 2026-05-05 --end 2026-05-06`);
      process.exit(0);
    } else rest.push(a);
  }
  args.store = (rest[0] || '').toUpperCase();
  if (!args.store) throw new Error('Missing store key, e.g. HL');
  if (args.date) {
    args.start = args.date;
    args.end = args.date;
  }
  if (!args.start) throw new Error('Missing --date or --start');
  if (!args.end) args.end = args.start;
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

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function round2(n) {
  return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
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

function attrSuffix(item) {
  const attrs = asArray(item.skuAttribute);
  const cn = attrs.find((a) => a.language === 'CN' && a.attrName && a.attrName !== '-');
  const us = attrs.find((a) => a.language === 'US' && a.attrName && a.attrName !== '-');
  return cn?.attrName || us?.attrName || '';
}

function isCancelledBeforePickup(order, item) {
  const orderStatus = Number(order?.orderStatus);
  const goodsStatus = Number(item?.newGoodsStatus);
  const performanceTag = Number(item?.performanceTag);
  return orderStatus === 6 && goodsStatus === 6 && performanceTag === 2;
}

function openApiGoodsPerformanceStatus(order, item) {
  return isCancelledBeforePickup(order, item) ? 6 : item.performanceTag ?? '';
}

function openApiGoodsPerformanceStatusDesc(order, item) {
  return isCancelledBeforePickup(order, item) ? '揽收前已取消' : '';
}

function toOrderRows(orderDetails) {
  return orderDetails.map((order) => ({
    orderId: String(order.orderNo || ''),
    orderNo: String(order.orderNo || ''),
    billno: String(order.orderNo || ''),
    orderStatus: order.orderStatus ?? '',
    orderStatusDesc: '',
    performStatus: order.orderStatus ?? '',
    performStatusDesc: '',
    allocateTime: String(order.orderTime || order.orderAllocateTime || '').slice(0, 16),
    allocateTimeFull: order.orderTime || order.orderAllocateTime || '',
    site: order.salesSite || '',
    orderType: order.orderType ?? '',
  }));
}

function toGoodsRows(orderDetails) {
  const rows = [];
  for (const order of orderDetails) {
    const orderTime = order.orderTime || order.orderAllocateTime || '';
    for (const item of asArray(order.orderGoodsInfoList)) {
      const currencyPrice = round2(item.estimatedIncome || 0);
      const goodsPerformanceStatus = openApiGoodsPerformanceStatus(order, item);
      const goodsPerformanceStatusDesc = openApiGoodsPerformanceStatusDesc(order, item);
      rows.push({
        orderId: String(order.orderNo || ''),
        orderNo: String(order.orderNo || ''),
        billno: String(order.orderNo || ''),
        orderStatus: order.orderStatus ?? '',
        orderStatusDesc: '',
        performStatus: order.orderStatus ?? '',
        performStatusDesc: '',
        allocateTime: String(orderTime).slice(0, 16),
        allocateTimeFull: orderTime,
        site: order.salesSite || '',
        orderType: order.orderType ?? '',
        pageStatus: '',
        pageStatusDesc: '',
        orderCustomerTime: order.paymentTime || order.orderTime || '',
        orderCreateTime: orderTime,
        goodsId: String(item.goodsId || ''),
        entityId: String(item.goodsId || ''),
        goodsSn: item.goodsSn || '',
        skuSn: item.sellerSku || '',
        skuCode: item.skuCode || '',
        skcName: item.skc || '',
        suffix: attrSuffix(item),
        goodsTitle: item.goodsTitle || '',
        number: 1,
        currencyCode: item.saleCurrency || item.orderCurrency || '',
        currencyPrice,
        newOrderGoodsStatus: item.newGoodsStatus ?? '',
        goodsPerformanceStatus,
        goodsPerformanceStatusDesc,
        goodsExchangeTag: item.goodsExchangeTag ?? '',
        performanceTag: item.performanceTag ?? '',
        storageTag: item.storageTag ?? '',
        isValidSale: isValidSalesGoodsRow({
          number: 1,
          currencyPrice,
          goodsPerformanceStatus,
          goodsPerformanceStatusDesc,
        }),
        salesExclusionReason: isCancelledBeforePickup(order, item) ? 'cancelled_before_pickup' : '',
      });
    }
  }
  return rows;
}

function summarize(orderList, orderRows, goodsRows) {
  const goodsSales = summarizeSalesGoodsRows(goodsRows);
  const salesSar = round2(goodsSales.salesSar);
  return {
    orderRefCount: orderList.length,
    apiCount: orderList.length,
    detailedOrderCount: orderRows.length,
    positiveAmountOrderCount: goodsSales.positiveAmountOrderCount,
    goodsLineCount: goodsRows.length,
    quantityAll: goodsSales.quantityAll,
    quantityPositiveAmount: goodsSales.quantityPositiveAmount,
    salesSar,
    salesRmb: round2(salesSar * 1.8),
    excludedGoodsLineCount: goodsSales.excludedGoodsLineCount,
    excludedSalesSar: round2(goodsSales.excludedSalesSar),
    validityPolicy: 'lib/shein_sales_validity.mjs',
    source: 'shein-openapi',
  };
}

const args = parseArgs(process.argv.slice(2));
const config = await readJson(args.config);
const store = asArray(config.stores).find((s) => String(s.storeKey).toUpperCase() === args.store);
if (!store?.openKeyId || !store?.secretKey) throw new Error(`${args.store} 未完成 SHEIN OpenAPI 授权`);

const client = new SheinOpenApiClient({
  baseUrl: config.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
  openKeyId: store.openKeyId,
  secretKey: store.secretKey,
});

const outputs = [];
for (const date of eachDate(args.start, args.end)) {
  const orderList = await fetchOrderListForDate(client, date);
  const orderNos = orderList.map((row) => String(row.orderNo)).filter(Boolean);
  const orderDetails = await fetchOrderDetails(client, orderNos);
  const orderRows = toOrderRows(orderDetails);
  const goodsRows = toGoodsRows(orderDetails);
  const payload = {
    storeKey: args.store,
    shopName: store.shopName || args.store,
    groupKey: store.groupKey || '',
    start: date,
    end: date,
    fetchTime: new Date().toISOString(),
    source: 'shein-openapi',
    request: {
      apiBaseUrl: client.baseUrl,
      queryType: 1,
      startTime: `${date} 00:00:00`,
      endTime: `${date} 23:59:59`,
    },
    timezone: {name: 'Asia/Shanghai', utcOffsetHours: 8},
    summary: summarize(orderList, orderRows, goodsRows),
    orderRefs: orderList,
    orders: orderDetails,
    orderRows,
    goodsRows,
  };
  const outFile = path.join(args.outDir, args.store, `${date}.json`);
  await writeJson(outFile, payload);
  outputs.push({date, savedTo: path.relative(ROOT, outFile).replace(/\\/g, '/'), summary: payload.summary});
}

console.log(JSON.stringify({ok: true, storeKey: args.store, outputs}, null, 2));
