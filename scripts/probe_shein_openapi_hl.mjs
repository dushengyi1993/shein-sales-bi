#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'shein_openapi.local.json');

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    store: 'HL',
    out: '',
    orderHours: 47,
    financeDays: 6,
    productPageSize: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--store') args.store = argv[++i];
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--order-hours') args.orderHours = Number(argv[++i]);
    else if (a === '--finance-days') args.financeDays = Number(argv[++i]);
    else if (a === '--product-page-size') args.productPageSize = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/probe_shein_openapi_hl.mjs [--store HL]

只读探针：调用指定店铺已授权的 SHEIN OpenAPI，保存原始结果到 tmp/，控制台只输出状态摘要。`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function mask(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 10) return '***';
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

function stampForFile(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatBeijing(date) {
  const d = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function firstStringByKeys(obj, keys) {
  const seen = new Set();
  const queue = [obj];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const v of cur) queue.push(v);
      continue;
    }
    for (const key of keys) {
      const value = cur[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (Array.isArray(value)) {
        const found = value.find((v) => typeof v === 'string' && v.trim());
        if (found) return found.trim();
      }
    }
    for (const value of Object.values(cur)) queue.push(value);
  }
  return '';
}

function countLike(data, candidates) {
  for (const pathText of candidates) {
    const parts = pathText.split('.');
    let cur = data;
    for (const part of parts) cur = cur?.[part];
    if (Array.isArray(cur)) return cur.length;
    if (typeof cur === 'number') return cur;
  }
  return null;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function call(client, probe) {
  const startedAt = new Date().toISOString();
  try {
    const response = await client.request(probe.path, {
      method: probe.method,
      body: probe.body,
      query: probe.query,
      headers: probe.headers,
    });
    return {
      name: probe.name,
      path: probe.path,
      method: probe.method,
      request: {query: probe.query || null, body: probe.body || null},
      startedAt,
      endedAt: new Date().toISOString(),
      httpStatus: response.status,
      code: response.data?.code ?? null,
      msg: response.data?.msg ?? null,
      traceId: response.data?.traceId ?? null,
      data: response.data,
    };
  } catch (err) {
    return {
      name: probe.name,
      path: probe.path,
      method: probe.method,
      request: {query: probe.query || null, body: probe.body || null},
      startedAt,
      endedAt: new Date().toISOString(),
      error: String(err?.message || err),
    };
  }
}

const args = parseArgs(process.argv.slice(2));
const config = await readJson(args.config);
const store = asArray(config.stores).find((s) => String(s.storeKey).toUpperCase() === String(args.store).toUpperCase());
if (!store?.openKeyId || !store?.secretKey) {
  throw new Error(`未在 ${path.relative(ROOT, args.config)} 找到 ${args.store} 的 openKeyId/secretKey，请先完成授权。`);
}

const now = new Date();
const orderStart = new Date(now.getTime() - args.orderHours * 60 * 60 * 1000);
const financeStart = new Date(now.getTime() - args.financeDays * 24 * 60 * 60 * 1000);
const orderWindow = {startTime: formatBeijing(orderStart), endTime: formatBeijing(now)};
const financeWindow = {startAddTime: formatBeijing(financeStart), endAddTime: formatBeijing(now)};

const client = new SheinOpenApiClient({
  baseUrl: config.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
  openKeyId: store.openKeyId,
  secretKey: store.secretKey,
});

const results = [];
const baseProbes = [
  {name: 'store-info', method: 'POST', path: '/open-api/openapi-business-backend/query-store-info', body: {}},
  {name: 'site-list', method: 'POST', path: '/open-api/goods/query-site-list', body: {}},
  {name: 'warehouse-list', method: 'GET', path: '/open-api/msc/warehouse/list'},
  {name: 'product-query', method: 'POST', path: '/open-api/openapi-business-backend/product/query', body: {pageNum: 1, pageSize: args.productPageSize}},
  {name: 'order-list', method: 'POST', path: '/open-api/order/order-list', body: {queryType: 1, ...orderWindow, page: 1, pageSize: 10}},
  {name: 'return-order-list', method: 'POST', path: '/open-api/return-order/list', body: {queryType: 1, ...orderWindow, page: 1, pageSize: 10}},
  {name: 'finance-check-order-list', method: 'POST', path: '/open-api/finance/get-check-order-list', body: {...financeWindow, page: 1, pageSize: 10}},
  {name: 'finance-report-order-list', method: 'POST', path: '/open-api/finance/report-order-list', body: {page: 1, pageSize: 10}},
];

for (const probe of baseProbes) {
  const result = await call(client, probe);
  results.push(result);
}

const productResult = results.find((r) => r.name === 'product-query')?.data;
const firstSpuName = firstStringByKeys(productResult, ['spuName']);
const firstSkuCode = firstStringByKeys(productResult, ['skuCode', 'skuCodeList']);
if (firstSpuName) {
  results.push(await call(client, {
    name: 'spu-info-first-product',
    method: 'POST',
    path: '/open-api/goods/spu-info',
    body: {spuName: firstSpuName, languageList: ['en', 'ar']},
  }));
}
if (firstSkuCode) {
  results.push(await call(client, {
    name: 'stock-query-first-sku-vi',
    method: 'POST',
    path: '/open-api/stock/stock-query',
    body: {skuCodeList: [firstSkuCode], warehouseType: '2', invType: 'VI'},
  }));
}

const orderNo = firstStringByKeys(results.find((r) => r.name === 'order-list')?.data, ['orderNo']);
if (orderNo) {
  results.push(await call(client, {
    name: 'order-detail-first-order',
    method: 'POST',
    path: '/open-api/order/order-detail',
    body: {orderNoList: [orderNo]},
  }));
}

const returnOrderNo = firstStringByKeys(results.find((r) => r.name === 'return-order-list')?.data, ['returnOrderNo']);
if (returnOrderNo) {
  results.push(await call(client, {
    name: 'return-order-detail-first-return',
    method: 'POST',
    path: '/open-api/return-order/details',
    body: {returnOrderNoList: [returnOrderNo]},
  }));
}

const checkOrderNo = firstStringByKeys(results.find((r) => r.name === 'finance-check-order-list')?.data, ['checkOrderNo']);
if (checkOrderNo) {
  results.push(await call(client, {
    name: 'finance-check-order-detail-first',
    method: 'GET',
    path: '/open-api/finance/get-check-order-detail',
    query: {checkOrderNo},
  }));
}

const output = {
  capturedAt: new Date().toISOString(),
  storeKey: args.store,
  openKeyId: mask(store.openKeyId),
  baseUrl: client.baseUrl,
  windows: {
    order: orderWindow,
    finance: financeWindow,
  },
  results,
};
const outPath = args.out || path.join(ROOT, 'tmp', 'shein-openapi-runtime', `${String(args.store || 'store').toLowerCase()}-probe-${stampForFile()}.local.json`);
await writeJson(outPath, output);

const summary = results.map((r) => ({
  name: r.name,
  httpStatus: r.httpStatus ?? null,
  code: r.code ?? null,
  msg: r.msg ?? r.error ?? null,
  traceId: r.traceId ?? null,
  count: countLike(r.data, [
    'info.count',
    'info.orderList',
    'info.returnOrderList',
    'info.list',
    'info.data',
    'info.goodsInventory',
  ]),
}));

console.log(JSON.stringify({
  ok: true,
  savedTo: path.relative(ROOT, outPath).replace(/\\/g, '/'),
  storeKey: args.store,
  openKeyId: mask(store.openKeyId),
  summary,
}, null, 2));
