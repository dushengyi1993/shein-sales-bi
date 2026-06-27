#!/usr/bin/env node
/**
 * Fetch SHEIN OpenAPI product/link basics for one store.
 *
 * Read-only by design:
 * - calls product list, product detail and virtual stock query endpoints only;
 * - writes ignored local/cloud artifacts under outputs/shein_openapi_products/;
 * - never writes PostgreSQL and never changes SHEIN data.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'shein_openapi.local.json');

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    store: '',
    outDir: path.join(ROOT, 'outputs', 'shein_openapi_products'),
    pageSize: 50,
    maxPages: 200,
    maxDetails: 0,
    detailConcurrency: 3,
    stockChunkSize: 50,
    skipDetails: false,
    skipStock: false,
    keepSnapshots: Number(process.env.SHEIN_OPENAPI_PRODUCT_KEEP_SNAPSHOTS || 2),
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--out') args.outDir = path.resolve(argv[++i]);
    else if (a === '--page-size') args.pageSize = Number(argv[++i]);
    else if (a === '--max-pages') args.maxPages = Number(argv[++i]);
    else if (a === '--max-details') args.maxDetails = Number(argv[++i]);
    else if (a === '--detail-concurrency') args.detailConcurrency = Number(argv[++i]);
    else if (a === '--stock-chunk-size') args.stockChunkSize = Number(argv[++i]);
    else if (a === '--keep-snapshots') args.keepSnapshots = Number(argv[++i]);
    else if (a === '--skip-details') args.skipDetails = true;
    else if (a === '--skip-stock') args.skipStock = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/fetch_shein_openapi_products.mjs HL
  node scripts/fetch_shein_openapi_products.mjs HL --max-details 30

Fetches product/link basics into outputs/shein_openapi_products/<STORE>/latest.json.
Use --max-details 0 for all listed SPUs; --skip-details for list-only smoke tests.`);
      process.exit(0);
    } else {
      rest.push(a);
    }
  }
  args.store = String(rest[0] || '').trim().toUpperCase();
  if (!args.store) throw new Error('Missing store key, e.g. HL');
  args.pageSize = Math.max(1, Math.min(100, Number.isFinite(args.pageSize) ? Math.trunc(args.pageSize) : 50));
  args.maxPages = Math.max(1, Math.min(1000, Number.isFinite(args.maxPages) ? Math.trunc(args.maxPages) : 200));
  args.maxDetails = Math.max(0, Number.isFinite(args.maxDetails) ? Math.trunc(args.maxDetails) : 0);
  args.detailConcurrency = Math.max(1, Math.min(8, Number.isFinite(args.detailConcurrency) ? Math.trunc(args.detailConcurrency) : 3));
  args.stockChunkSize = Math.max(1, Math.min(100, Number.isFinite(args.stockChunkSize) ? Math.trunc(args.stockChunkSize) : 50));
  args.keepSnapshots = Math.max(0, Math.min(30, Number.isFinite(args.keepSnapshots) ? Math.trunc(args.keepSnapshots) : 2));
  return args;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function cleanupOldSnapshots(outDir, keepSnapshots) {
  if (!Number.isFinite(keepSnapshots) || keepSnapshots < 0) return {deleted: 0, kept: 0};
  let entries = [];
  try {
    entries = await fs.readdir(outDir, {withFileTypes: true});
  } catch {
    return {deleted: 0, kept: 0};
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'latest.json') continue;
    const full = path.join(outDir, entry.name);
    let stat = null;
    try { stat = await fs.stat(full); } catch {}
    files.push({name: entry.name, full, mtimeMs: stat?.mtimeMs || 0});
  }
  files.sort((a, b) => b.name.localeCompare(a.name) || b.mtimeMs - a.mtimeMs);
  const stale = files.slice(keepSnapshots);
  let deleted = 0;
  for (const file of stale) {
    await fs.rm(file.full, {force: true});
    deleted += 1;
  }
  return {deleted, kept: Math.min(files.length, keepSnapshots)};
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function unique(values) {
  return [...new Set(values.map(v => compact(v)).filter(Boolean))];
}

function firstByLanguage(list, languages, key) {
  const rows = asArray(list);
  for (const lang of languages) {
    const hit = rows.find(r => String(r?.language || '').toLowerCase() === lang && compact(r?.[key]));
    if (hit) return compact(hit[key]);
  }
  const any = rows.find(r => compact(r?.[key]));
  return any ? compact(any[key]) : '';
}

function firstImage(list) {
  const rows = asArray(list);
  const main = rows.find(r => String(r?.imageType || '').toUpperCase() === 'MAIN') || rows[0];
  return compact(main?.imageUrl || main?.imageMediumUrl || main?.imageSmallUrl || '');
}

function findShelfStatus(skcInfo) {
  const rows = asArray(skcInfo?.shelfStatusInfoList);
  return rows.find(r => String(r?.siteAbbr || '').toLowerCase() === 'shein-sa') || rows[0] || {};
}

function shelfStatusLabel(code) {
  const text = String(code ?? '').trim();
  if (text === '0') return '非已上架';
  if (text === '1') return '已上架';
  if (text === '2') return '待上架';
  if (text === '3') return '已售罄';
  if (text === '4') return '已下架';
  return text ? `状态${text}` : '';
}

function costByCurrency(skuInfoList, currency) {
  const wanted = String(currency || '').toUpperCase();
  const values = [];
  for (const sku of asArray(skuInfoList)) {
    for (const c of asArray(sku?.costInfoList)) {
      if (String(c?.currency || '').toUpperCase() !== wanted) continue;
      const n = Number(c?.costPrice);
      if (Number.isFinite(n)) values.push(n);
    }
  }
  if (!values.length) return null;
  return Math.round((Math.min(...values) + Number.EPSILON) * 100) / 100;
}

function parseStockRows(stockResponses) {
  const bySku = new Map();
  for (const response of stockResponses) {
    for (const info of asArray(response?.data?.info)) {
      for (const goods of asArray(info?.goodsInventory)) {
        for (const sku of asArray(goods?.skuList)) {
          const skuCode = compact(sku?.skuCode);
          if (!skuCode) continue;
          bySku.set(skuCode, {
            skuCode,
            totalInventoryQuantity: Number(sku?.totalInventoryQuantity ?? 0),
            totalLockedQuantity: Number(sku?.totalLockedQuantity ?? 0),
            totalUsableInventory: Number(sku?.totalUsableInventory ?? 0),
            totalTempLockQuantity: Number(sku?.totalTempLockQuantity ?? 0),
            raw: sku,
          });
        }
      }
    }
  }
  return bySku;
}

function normalizeProductRows({storeKey, productRows, detailResults, stockBySku, fetchedAt}) {
  const detailBySpu = new Map();
  for (const result of detailResults) {
    if (result?.ok && result.info?.spuName) detailBySpu.set(compact(result.info.spuName), result.info);
  }
  const rows = [];
  for (const item of productRows) {
    const spu = compact(item?.spuName);
    const listSkc = compact(item?.skcName);
    const detail = detailBySpu.get(spu);
    const detailSkcs = asArray(detail?.skcInfoList);
    const skcInfos = detailSkcs.length
      ? detailSkcs.filter(x => !listSkc || compact(x?.skcName) === listSkc)
      : [];
    const fallbackSkcInfos = skcInfos.length ? skcInfos : [{skcName: listSkc, skuInfoList: asArray(item?.skuCodeList).map(skuCode => ({skuCode}))}];
    for (const skcInfo of fallbackSkcInfos) {
      const skc = compact(skcInfo?.skcName || listSkc);
      if (!skc) continue;
      const skuCodes = unique([
        ...asArray(item?.skuCodeList),
        ...asArray(skcInfo?.skuInfoList).map(x => x?.skuCode),
      ]);
      const shelf = findShelfStatus(skcInfo);
      const stockRows = skuCodes.map(sku => stockBySku.get(sku)).filter(Boolean);
      const productNameEn = firstByLanguage(skcInfo?.productMultiNameList, ['en', 'us'], 'productName')
        || firstByLanguage(detail?.productMultiNameList, ['en', 'us'], 'productName');
      const productNameZh = firstByLanguage(skcInfo?.productMultiNameList, ['zh-cn', 'cn'], 'productName')
        || firstByLanguage(detail?.productMultiNameList, ['zh-cn', 'cn'], 'productName');
      const supplierCode = compact(skcInfo?.supplierCode || detail?.supplierCode || '');
      const shelfStatusCode = shelf?.shelfStatus === undefined || shelf?.shelfStatus === null ? '' : String(shelf.shelfStatus);
      rows.push({
        storeKey,
        fetchedAt,
        spu,
        skc,
        skuCodes,
        supplierCode,
        productNameEn,
        productNameZh,
        categoryId: compact(detail?.categoryId),
        productTypeId: compact(detail?.productTypeId),
        brandCode: compact(detail?.brandCode),
        shelfStatusCode,
        shelfStatusName: shelfStatusLabel(shelfStatusCode),
        firstShelfTime: compact(shelf?.firstShelfTime),
        lastShelfTime: compact(shelf?.lastShelfTime),
        lastUpdateTime: compact(shelf?.lastUpdateTime),
        skuCount: skuCodes.length,
        costSar: costByCurrency(skcInfo?.skuInfoList, 'SAR'),
        costCny: costByCurrency(skcInfo?.skuInfoList, 'CNY'),
        imageUrl: firstImage(skcInfo?.skcImageInfoList) || firstImage(detail?.spuImageInfoList),
        sheinUsableInventory: stockRows.reduce((sum, row) => sum + Number(row.totalUsableInventory || 0), 0),
        sheinInventoryQuantity: stockRows.reduce((sum, row) => sum + Number(row.totalInventoryQuantity || 0), 0),
        sheinLockedQuantity: stockRows.reduce((sum, row) => sum + Number(row.totalLockedQuantity || 0), 0),
        sourceCompleteness: {
          hasList: true,
          hasDetail: Boolean(detail),
          hasStock: stockRows.length > 0,
        },
      });
    }
  }
  return rows;
}

async function fetchProductList(client, args) {
  const rows = [];
  for (let pageNum = 1; pageNum <= args.maxPages; pageNum += 1) {
    const response = await client.request('/open-api/openapi-business-backend/product/query', {
      body: {pageNum, pageSize: args.pageSize},
    });
    if (String(response.data?.code) !== '0') {
      throw new Error(`product/query failed page=${pageNum}: code=${response.data?.code} msg=${response.data?.msg} traceId=${response.data?.traceId}`);
    }
    const pageRows = asArray(response.data?.info?.data);
    rows.push(...pageRows);
    if (!pageRows.length || pageRows.length < args.pageSize) break;
  }
  return rows;
}

async function fetchDetail(client, spuName) {
  try {
    const response = await client.request('/open-api/goods/spu-info', {
      body: {spuName, languageList: ['en', 'zh-cn']},
    });
    const ok = response.ok && String(response.data?.code) === '0';
    return {
      spuName,
      ok,
      httpStatus: response.status,
      code: response.data?.code ?? null,
      msg: response.data?.msg ?? null,
      traceId: response.data?.traceId ?? null,
      info: ok ? response.data?.info : null,
    };
  } catch (error) {
    return {spuName, ok: false, error: error?.message || String(error)};
  }
}

async function fetchDetails(client, spuNames, args) {
  if (args.skipDetails) return [];
  const limited = args.maxDetails > 0 ? spuNames.slice(0, args.maxDetails) : spuNames;
  const results = new Array(limited.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= limited.length) return;
      results[idx] = await fetchDetail(client, limited[idx]);
    }
  }
  await Promise.all(Array.from({length: Math.min(args.detailConcurrency, limited.length || 1)}, () => worker()));
  return results.filter(Boolean);
}

async function fetchStock(client, skuCodes, args) {
  if (args.skipStock || !skuCodes.length) return [];
  const responses = [];
  for (const part of chunk(skuCodes, args.stockChunkSize)) {
    const response = await client.request('/open-api/stock/stock-query', {
      body: {skuCodeList: part, warehouseType: '2', invType: 'VI'},
    });
    responses.push({
      ok: response.ok && String(response.data?.code) === '0',
      httpStatus: response.status,
      code: response.data?.code ?? null,
      msg: response.data?.msg ?? null,
      traceId: response.data?.traceId ?? null,
      skuCount: part.length,
      data: response.data,
    });
  }
  return responses;
}

const args = parseArgs(process.argv.slice(2));
const config = await readJson(args.config);
const store = asArray(config.stores).find((s) => String(s.storeKey || '').toUpperCase() === args.store);
if (!store?.enabled || !store?.openKeyId || !store?.secretKey) throw new Error(`${args.store} 未完成 SHEIN OpenAPI 授权`);

const client = new SheinOpenApiClient({
  baseUrl: config.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
  openKeyId: store.openKeyId,
  secretKey: store.secretKey,
});

const fetchedAt = new Date().toISOString();
const productRows = await fetchProductList(client, args);
const spuNames = unique(productRows.map(row => row?.spuName));
const skuCodes = unique(productRows.flatMap(row => asArray(row?.skuCodeList)));
const detailResults = await fetchDetails(client, spuNames, args);
const stockResponses = await fetchStock(client, skuCodes, args);
const stockBySku = parseStockRows(stockResponses.filter(r => r.ok));
const normalizedRows = normalizeProductRows({
  storeKey: args.store,
  productRows,
  detailResults,
  stockBySku,
  fetchedAt,
});

const detailFailures = detailResults.filter(r => !r.ok);
const stockFailures = stockResponses.filter(r => !r.ok);
const payload = {
  schemaVersion: 'shein-openapi-product-basics/v1',
  ok: true,
  storeKey: args.store,
  shopName: store.shopName || args.store,
  groupKey: store.groupKey || '',
  fetchedAt,
  request: {
    apiBaseUrl: client.baseUrl,
    pageSize: args.pageSize,
    maxPages: args.maxPages,
    maxDetails: args.maxDetails,
    detailsSkipped: args.skipDetails,
    stockSkipped: args.skipStock,
  },
  summary: {
    productListRows: productRows.length,
    distinctSpuCount: spuNames.length,
    distinctSkcCount: unique(productRows.map(row => row?.skcName)).length,
    distinctSkuCount: skuCodes.length,
    detailRequestedSpuCount: args.skipDetails ? 0 : (args.maxDetails > 0 ? Math.min(args.maxDetails, spuNames.length) : spuNames.length),
    detailOkSpuCount: detailResults.filter(r => r.ok).length,
    detailFailedSpuCount: detailFailures.length,
    stockRequestedSkuCount: args.skipStock ? 0 : skuCodes.length,
    stockOkSkuCount: stockBySku.size,
    stockFailedChunkCount: stockFailures.length,
    normalizedLinkRows: normalizedRows.length,
    normalizedOnShelfRows: normalizedRows.filter(r => String(r.shelfStatusCode) === '1').length,
  },
  productList: productRows,
  detailResults,
  stockResponses,
  normalizedRows,
};

const stamp = fetchedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const outDir = path.join(args.outDir, args.store);
const outFile = path.join(outDir, `${stamp}.json`);
const latestFile = path.join(outDir, 'latest.json');
await writeJson(outFile, payload);
await writeJson(latestFile, payload);
const cleanup = await cleanupOldSnapshots(outDir, args.keepSnapshots);

console.log(JSON.stringify({
  ok: true,
  storeKey: args.store,
  savedTo: rel(outFile),
  latest: rel(latestFile),
  cleanup,
  summary: payload.summary,
  warnings: [
    ...(detailFailures.length ? [`${detailFailures.length} 个 SPU 详情抓取失败`] : []),
    ...(stockFailures.length ? [`${stockFailures.length} 个库存查询分片失败`] : []),
  ],
}, null, 2));
