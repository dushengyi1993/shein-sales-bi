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
import {summarizeSalesGoodsRows} from '../lib/shein_sales_validity.mjs';
import {
  mapOpenApiOrderDetails,
  resolveOpenApiStoreMetadata,
} from '../lib/shein_openapi_sales_mapper.mjs';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_STORES_CONFIG = path.join(ROOT, 'config', 'stores.json');

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    storesConfig: DEFAULT_STORES_CONFIG,
    store: '',
    outDir: path.join(ROOT, 'outputs', 'shein_openapi_fetch'),
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--stores-config') args.storesConfig = path.resolve(argv[++i]);
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
const publicStoreConfig = await readJson(args.storesConfig);
const storeMetadata = resolveOpenApiStoreMetadata(args.store, store, publicStoreConfig);

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
  const {orderRows, goodsRows} = mapOpenApiOrderDetails(orderDetails);
  const payload = {
    storeKey: args.store,
    shopName: storeMetadata.shopName,
    groupKey: storeMetadata.groupKey,
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
