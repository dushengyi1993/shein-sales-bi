#!/usr/bin/env node
/**
 * Fetch SHEIN OpenAPI return-order list/detail data into local JSON artifacts.
 *
 * Read-only: this script only calls SHEIN OpenAPI and writes files under
 * outputs/shein_openapi_returns/. It never writes PostgreSQL or SHEIN data.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    store: '',
    outDir: path.join(ROOT, 'outputs', 'shein_openapi_returns'),
    pageSize: 30,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--out') args.outDir = path.resolve(argv[++i]);
    else if (a === '--page-size') args.pageSize = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/fetch_shein_openapi_returns.mjs DL --date 2026-06-24
  node scripts/fetch_shein_openapi_returns.mjs DL --start 2026-06-01 --end 2026-06-07

Fetches /open-api/return-order/list and /open-api/return-order/details by
return request/create time. This is a read-only OpenAPI workflow.`);
      process.exit(0);
    } else rest.push(a);
  }
  args.store = String(rest[0] || '').trim().toUpperCase();
  if (!args.store) throw new Error('Missing store key, e.g. DL');
  if (args.date) {
    args.start = args.date;
    args.end = args.date;
  }
  if (!args.start) throw new Error('Missing --date or --start');
  if (!args.end) args.end = args.start;
  args.pageSize = Math.max(1, Math.min(100, Number.isFinite(args.pageSize) ? Math.trunc(args.pageSize) : 30));
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

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
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

function listRowsFromResponse(data) {
  const info = data?.info ?? data?.data ?? data?.result ?? data;
  const candidates = [
    info?.returnOrderList,
    info?.returnOrders,
    info?.data,
    info?.list,
    info?.records,
    info?.rows,
    data?.info?.returnOrderList,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  if (Array.isArray(info)) return info;
  return [];
}

function listTotalFromResponse(data, fallback) {
  const info = data?.info ?? data?.data ?? data?.result ?? {};
  const total = num(info.count ?? info.total ?? info.totalCount ?? info.recordCount ?? data?.count ?? data?.total);
  return total === null ? fallback : total;
}

function detailsFromResponse(data) {
  const info = data?.info ?? data?.data ?? data?.result ?? data;
  if (Array.isArray(info)) return info;
  for (const key of ['returnOrderDetailList', 'returnOrderList', 'details', 'data', 'list', 'records', 'rows']) {
    if (Array.isArray(info?.[key])) return info[key];
  }
  if (info && typeof info === 'object' && (info.returnOrderNo || info.orderNo || info.returnGoodsInfoList)) return [info];
  return [];
}

async function fetchReturnOrderListForDate(client, date, pageSize) {
  const all = [];
  let total = null;
  for (let page = 1; page < 400; page += 1) {
    const response = await client.request('/open-api/return-order/list', {
      body: {
        queryType: 1,
        startTime: `${date} 00:00:00`,
        endTime: `${date} 23:59:59`,
        page,
        pageSize,
      },
    });
    if (String(response.data?.code) !== '0') {
      throw new Error(`return-order/list ${date} failed: code=${response.data?.code} msg=${response.data?.msg} traceId=${response.data?.traceId}`);
    }
    const rows = listRowsFromResponse(response.data);
    total = listTotalFromResponse(response.data, total ?? rows.length);
    all.push(...rows);
    if (!rows.length || all.length >= total || rows.length < pageSize) break;
  }
  return {rows: all, total: total ?? all.length};
}

export async function fetchReturnOrderDetails(client, returnOrderNos) {
  const out = [];
  for (const part of chunk(returnOrderNos, 30)) {
    if (!part.length) continue;
    const response = await client.request('/open-api/return-order/details', {body: {returnOrderNoList: part}});
    if (String(response.data?.code) !== '0') {
      throw new Error(`return-order/details failed: code=${response.data?.code} msg=${response.data?.msg} traceId=${response.data?.traceId}`);
    }
    out.push(...detailsFromResponse(response.data));
  }
  return out;
}

function requestedSet(values, label) {
  const ids = [...new Set(asArray(values).map((value) => String(value || '').trim()).filter(Boolean))];
  if (!ids.length) throw new Error(`Missing ${label}`);
  return new Set(ids);
}

/** Fetch exactly the requested return details for a webhook worker. */
export async function fetchOpenApiReturnOrderDetailsForStore({storeKey, returnOrderNos, client, config, fetchTime = new Date().toISOString()} = {}) {
  const normalizedStore = String(storeKey || '').trim().toUpperCase();
  if (!normalizedStore) throw new Error('Missing storeKey');
  const requested = requestedSet(returnOrderNos, 'returnOrderNos');
  let effectiveConfig = config;
  let store;
  let effectiveClient = client;
  if (!effectiveClient) {
    effectiveConfig = effectiveConfig || await readJson(DEFAULT_CONFIG);
    store = asArray(effectiveConfig.stores).find((entry) => String(entry.storeKey).toUpperCase() === normalizedStore);
    if (!store?.openKeyId || !store?.secretKey) throw new Error(`${normalizedStore} 未完成 SHEIN OpenAPI 授权`);
    effectiveClient = new SheinOpenApiClient({baseUrl: effectiveConfig.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged, openKeyId: store.openKeyId, secretKey: store.secretKey});
  }
  if (!store && effectiveConfig) store = asArray(effectiveConfig.stores).find((entry) => String(entry.storeKey).toUpperCase() === normalizedStore);
  const returnOrders = await fetchReturnOrderDetails(effectiveClient, [...requested]);
  const returned = new Set(returnOrders.map((row) => String(row?.returnOrderNo || '').trim()).filter(Boolean));
  const unexpected = [...returned].filter((returnOrderNo) => !requested.has(returnOrderNo));
  const missing = [...requested].filter((returnOrderNo) => !returned.has(returnOrderNo));
  if (unexpected.length || missing.length) throw new Error(`return-order/details target mismatch for ${normalizedStore}: missing=${missing.join(',') || '-'} unexpected=${unexpected.join(',') || '-'}`);
  return {
    storeKey: normalizedStore, shopName: store?.shopName || normalizedStore, groupKey: store?.groupKey || '', fetchTime,
    source: 'shein-openapi-webhook', requestedReturnOrderNos: [...requested],
    returnOrderRefs: returnOrders.map((row) => ({returnOrderNo: row.returnOrderNo, orderNo: row.orderNo, requestReturnTime: row.requestReturnTime, addTime: row.addTime})),
    returnOrders, summary: summarize(returnOrders, returnOrders),
  };
}

function cnReason(reasons) {
  const rows = asArray(reasons);
  const cn = rows.find((r) => String(r.language || '').toUpperCase() === 'CN' && r.reason);
  const any = rows.find((r) => r.reason);
  return cn?.reason || any?.reason || '';
}

function summarize(returnList, returnDetails) {
  const items = [];
  for (const detail of returnDetails) {
    for (const item of asArray(detail.returnGoodsInfoList)) items.push({detail, item});
  }
  const orderNos = new Set(returnDetails.map((r) => String(r.returnOrderNo || '')).filter(Boolean));
  const amountSar = round2(items.reduce((sum, {item}) => sum + Number(num(item.estimateIncomeMoney ?? item.estimateTaxIncomeMoney ?? item.sellerCurrencyPrice ?? item.costPrice) || 0), 0));
  return {
    source: 'shein-openapi',
    returnOrderRefCount: returnList.length,
    returnOrderDetailCount: orderNos.size,
    itemLineCount: items.length,
    quantity: items.length,
    amountSar,
    amountRmb: round2(amountSar * 1.8),
    statusCounts: returnDetails.reduce((acc, row) => {
      const key = String(row.returnOrderStatus ?? 'unknown');
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    reasonTop: items.reduce((acc, {item}) => {
      const key = cnReason(item.returnReasonList) || '未知';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
}

async function main() {
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
  // Version the slice at query start, not after all pages/details finish.
  // Otherwise a slow stale fetch could look newer than an intervening webhook.
  const fetchTime = new Date().toISOString();
  const list = await fetchReturnOrderListForDate(client, date, args.pageSize);
  const returnOrderNos = [...new Set(list.rows.map((row) => String(row.returnOrderNo || '').trim()).filter(Boolean))];
  const details = await fetchReturnOrderDetails(client, returnOrderNos);
  const payload = {
    storeKey: args.store,
    shopName: store.shopName || args.store,
    groupKey: store.groupKey || '',
    start: date,
    end: date,
    fetchTime,
    source: 'shein-openapi',
    request: {
      apiBaseUrl: client.baseUrl,
      queryType: 1,
      startTime: `${date} 00:00:00`,
      endTime: `${date} 23:59:59`,
      pageSize: args.pageSize,
    },
    timezone: {name: 'Asia/Shanghai', utcOffsetHours: 8},
    summary: summarize(list.rows, details),
    returnOrderRefs: list.rows,
    returnOrders: details,
  };
  const outFile = path.join(args.outDir, args.store, `${date}.json`);
  await writeJson(outFile, payload);
  outputs.push({date, savedTo: path.relative(ROOT, outFile).replace(/\\/g, '/'), summary: payload.summary});
}

console.log(JSON.stringify({ok: true, storeKey: args.store, outputs}, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error?.stack || String(error)); process.exit(1); });
}
