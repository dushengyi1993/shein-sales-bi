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
import {fileURLToPath, pathToFileURL} from 'node:url';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';
import {
  collectOpenapiProductDetailFallbacks,
  selectOpenapiProductDetailSpus,
} from '../lib/openapi_product_detail_cache.mjs';

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
    detailRetryAttempts: Number(process.env.SHEIN_OPENAPI_PRODUCT_DETAIL_RETRY_ATTEMPTS || 3),
    detailRetryBaseDelayMs: Number(process.env.SHEIN_OPENAPI_PRODUCT_DETAIL_RETRY_BASE_DELAY_MS || 1200),
    stockChunkSize: 50,
    stockRetryAttempts: Number(process.env.SHEIN_OPENAPI_PRODUCT_STOCK_RETRY_ATTEMPTS || 3),
    stockRetryBaseDelayMs: Number(process.env.SHEIN_OPENAPI_PRODUCT_STOCK_RETRY_BASE_DELAY_MS || 1200),
    skipDetails: false,
    skipStock: false,
    detailPriorityFile: '',
    priorityDetailsOnly: false,
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
    else if (a === '--detail-retry-attempts') args.detailRetryAttempts = Number(argv[++i]);
    else if (a === '--detail-retry-base-delay-ms') args.detailRetryBaseDelayMs = Number(argv[++i]);
    else if (a === '--stock-chunk-size') args.stockChunkSize = Number(argv[++i]);
    else if (a === '--stock-retry-attempts') args.stockRetryAttempts = Number(argv[++i]);
    else if (a === '--stock-retry-base-delay-ms') args.stockRetryBaseDelayMs = Number(argv[++i]);
    else if (a === '--keep-snapshots') args.keepSnapshots = Number(argv[++i]);
    else if (a === '--skip-details') args.skipDetails = true;
    else if (a === '--skip-stock') args.skipStock = true;
    else if (a === '--detail-priority-file') args.detailPriorityFile = path.resolve(argv[++i]);
    else if (a === '--priority-details-only') args.priorityDetailsOnly = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/fetch_shein_openapi_products.mjs HL
  node scripts/fetch_shein_openapi_products.mjs HL --max-details 30

Fetches product/link basics into outputs/shein_openapi_products/<STORE>/latest.json.
Use --max-details 0 for all listed SPUs; --skip-details for list-only smoke tests.
Use --stock-retry-attempts/--stock-retry-base-delay-ms to tune stock shard retries.`);
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
  args.detailRetryAttempts = Math.max(1, Math.min(6, Number.isFinite(args.detailRetryAttempts) ? Math.trunc(args.detailRetryAttempts) : 3));
  args.detailRetryBaseDelayMs = Math.max(250, Math.min(10_000, Number.isFinite(args.detailRetryBaseDelayMs) ? Math.trunc(args.detailRetryBaseDelayMs) : 1200));
  args.stockChunkSize = Math.max(1, Math.min(100, Number.isFinite(args.stockChunkSize) ? Math.trunc(args.stockChunkSize) : 50));
  args.stockRetryAttempts = Math.max(1, Math.min(6, Number.isFinite(args.stockRetryAttempts) ? Math.trunc(args.stockRetryAttempts) : 3));
  args.stockRetryBaseDelayMs = Math.max(250, Math.min(10_000, Number.isFinite(args.stockRetryBaseDelayMs) ? Math.trunc(args.stockRetryBaseDelayMs) : 1200));
  args.keepSnapshots = Math.max(0, Math.min(30, Number.isFinite(args.keepSnapshots) ? Math.trunc(args.keepSnapshots) : 2));
  if (args.priorityDetailsOnly && !args.detailPriorityFile) {
    throw new Error('--priority-details-only requires --detail-priority-file');
  }
  if (args.priorityDetailsOnly && args.maxDetails < 1) {
    throw new Error('--priority-details-only requires a positive --max-details budget');
  }
  return args;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readDetailPrioritySpus(file, storeKey) {
  if (!file) return [];
  const payload = await readJson(file);
  const values = payload?.stores?.[storeKey] ?? payload?.[storeKey] ?? [];
  if (!Array.isArray(values)) throw new Error(`Detail priority file has no array for ${storeKey}`);
  return unique(values);
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

async function readPriorProductPayloads(outDir) {
  let names = [];
  try {
    names = (await fs.readdir(outDir))
      .filter(name => name.endsWith('.json'))
      .sort((a, b) => {
        if (a === 'latest.json') return -1;
        if (b === 'latest.json') return 1;
        return b.localeCompare(a);
      });
  } catch {
    return [];
  }
  const seen = new Set();
  const payloads = [];
  for (const name of names) {
    try {
      const payload = JSON.parse(await fs.readFile(path.join(outDir, name), 'utf8'));
      const key = compact(payload?.fetchedAt || payload?.generatedAt || name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      payloads.push(payload);
    } catch {}
  }
  return payloads;
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

function normalizeProductRows({storeKey, productRows, detailResults, detailFallbackResults, stockBySku, fetchedAt}) {
  const detailBySpu = new Map();
  for (const result of detailResults) {
    if (!result?.ok || !result?.info) continue;
    const spu = compact(result.spuName || result.info?.spuName);
    if (spu) detailBySpu.set(spu, {info: result.info, source: 'current', fetchedAt});
  }
  for (const result of detailFallbackResults) {
    if (!result?.ok || !result?.info) continue;
    const spu = compact(result.spuName || result.info?.spuName);
    if (spu && !detailBySpu.has(spu)) {
      detailBySpu.set(spu, {
        info: result.info,
        source: 'prior_cache',
        fetchedAt: compact(result.detailFetchedAt),
      });
    }
  }
  const rows = [];
  for (const item of productRows) {
    const spu = compact(item?.spuName);
    const listSkc = compact(item?.skcName);
    const detailEvidence = detailBySpu.get(spu);
    const detail = detailEvidence?.info;
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
      const productNameAr = firstByLanguage(skcInfo?.productMultiNameList, ['ar', 'ar-sa'], 'productName')
        || firstByLanguage(detail?.productMultiNameList, ['ar', 'ar-sa'], 'productName');
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
        productNameAr,
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
          hasCurrentDetail: detailEvidence?.source === 'current',
          hasCachedDetail: detailEvidence?.source === 'prior_cache',
          detailSource: detailEvidence?.source || 'missing',
          detailFetchedAt: detailEvidence?.fetchedAt || '',
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
      body: {spuName, languageList: ['en', 'ar']},
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

// Shared retry classification for detail requests and stock shard queries:
// transient HTTP/API failures only, matching the detail retry semantics.
function isRetryableOpenapiFailure(result) {
  const status = Number(result?.httpStatus || 0);
  const code = String(result?.code || '');
  const text = `${result?.msg || ''} ${result?.error || ''}`.toLowerCase();
  return status === 408
    || status === 429
    || status >= 500
    || code === '832213'
    || /限流|rate.?limit|timeout|timed out|temporar/.test(text);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchDetails(client, spuNames, args) {
  if (args.skipDetails) return [];
  const results = new Array(spuNames.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= spuNames.length) return;
      let result = null;
      for (let attempt = 1; attempt <= args.detailRetryAttempts; attempt += 1) {
        result = await fetchDetail(client, spuNames[idx]);
        result.attempts = attempt;
        if (result.ok || !isRetryableOpenapiFailure(result) || attempt >= args.detailRetryAttempts) break;
        await sleep(args.detailRetryBaseDelayMs * (2 ** (attempt - 1)));
      }
      results[idx] = result;
    }
  }
  await Promise.all(Array.from({length: Math.min(args.detailConcurrency, spuNames.length || 1)}, () => worker()));
  return results.filter(Boolean);
}

async function requestStockChunk(client, skuCodes) {
  try {
    const response = await client.request('/open-api/stock/stock-query', {
      body: {skuCodeList: skuCodes, warehouseType: '2', invType: 'VI'},
    });
    return {
      ok: response.ok && String(response.data?.code) === '0',
      httpStatus: response.status,
      code: response.data?.code ?? null,
      msg: response.data?.msg ?? null,
      traceId: response.data?.traceId ?? null,
      data: response.data,
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus: 0,
      code: null,
      msg: null,
      traceId: null,
      error: error?.message || String(error),
      data: null,
    };
  }
}

function classifyOpenapiFailure(response) {
  const text = `${response?.msg || ''} ${response?.error || ''}`.toLowerCase();
  if (Number(response?.httpStatus) === 429 || /限流|rate.?limit/.test(text)) return 'rate_limited';
  if (Number(response?.httpStatus) === 408 || /timeout|timed out/.test(text)) return 'timeout';
  if (Number(response?.httpStatus) >= 500 || /temporary/.test(text)) return 'upstream_unavailable';
  if (Number(response?.httpStatus) >= 400) return 'http_error';
  return response?.code ? 'business_error' : 'transport_error';
}

function safeFailureCode(value) {
  const code = String(value ?? '').trim();
  return /^[A-Za-z0-9._:-]{1,64}$/.test(code) ? code : null;
}

// Failed stock shards must stay diagnosable without leaking the full
// (potentially sensitive) response body: drop `data` and bound free-text.
function sanitizeFailedStockResponse(response) {
  const safe = {...response};
  delete safe.data;
  delete safe.msg;
  delete safe.error;
  delete safe.traceId;
  safe.code = safeFailureCode(safe.code);
  safe.failureClass = classifyOpenapiFailure(response);
  return safe;
}

function sleepWithJitter(ms) {
  const jitter = Math.round(ms * 0.1 * (Math.random() * 2 - 1));
  return sleep(Math.max(0, ms + jitter));
}

// Summary entries keep only classified metadata. Free-text and trace IDs are
// deliberately omitted because an upstream can echo credentials into them.
function buildStockFailureSummary(stockFailures) {
  return stockFailures.map((r) => ({
    chunkIndex: r.chunkIndex,
    skuCount: r.skuCount,
    attempts: r.attempts,
    httpStatus: r.httpStatus,
    code: r.code,
    failureClass: r.failureClass,
  }));
}

async function fetchStock(client, skuCodes, args) {
  if (args.skipStock || !skuCodes.length) return [];
  const responses = [];
  const chunks = chunk(skuCodes, args.stockChunkSize);
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const part = chunks[chunkIndex];
    let response = null;
    for (let attempt = 1; attempt <= args.stockRetryAttempts; attempt += 1) {
      response = await requestStockChunk(client, part);
      response.attempts = attempt;
      response.chunkIndex = chunkIndex;
      response.skuCount = part.length;
      if (response.ok || !isRetryableOpenapiFailure(response) || attempt >= args.stockRetryAttempts) break;
      await sleepWithJitter(args.stockRetryBaseDelayMs * (2 ** (attempt - 1)));
    }
    responses.push(response.ok ? response : sanitizeFailedStockResponse(response));
  }
  return responses;
}

async function main() {
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
  const outDir = path.join(args.outDir, args.store);
  const priorPayloads = await readPriorProductPayloads(outDir);
  const priorPayload = priorPayloads[0] || null;
  const productRows = await fetchProductList(client, args);
  const spuNames = unique(productRows.map(row => row?.spuName));
  const skuCodes = unique(productRows.flatMap(row => asArray(row?.skuCodeList)));
  const priorDetailFallbacks = collectOpenapiProductDetailFallbacks({
    priorPayloads,
    currentDetailResults: [],
    allowedSpus: spuNames,
  });
  const priorDetailSpus = new Set(priorDetailFallbacks.map(row => compact(row.spuName)));
  const uncachedDetailSpus = spuNames.filter(spu => !priorDetailSpus.has(spu));
  const configuredPrioritySpus = await readDetailPrioritySpus(args.detailPriorityFile, args.store);
  const allowedSpus = new Set(spuNames);
  const availablePrioritySpus = configuredPrioritySpus.filter(spu => allowedSpus.has(spu));
  const selectedDetailSpus = args.skipDetails
    ? []
    : args.priorityDetailsOnly
      ? availablePrioritySpus.slice(0, args.maxDetails)
      : selectOpenapiProductDetailSpus({
        spuNames,
        budget: args.maxDetails,
        priorPayload,
        prioritySpus: [...configuredPrioritySpus, ...uncachedDetailSpus],
        dateKey: fetchedAt,
      });
  const detailResults = await fetchDetails(client, selectedDetailSpus, args);
  const detailFallbackResults = collectOpenapiProductDetailFallbacks({
    priorPayloads,
    currentDetailResults: detailResults,
    allowedSpus: spuNames,
  });
  const stockResponses = await fetchStock(client, skuCodes, args);
  const stockBySku = parseStockRows(stockResponses.filter(r => r.ok));
  const normalizedRows = normalizeProductRows({
    storeKey: args.store,
    productRows,
    detailResults,
    detailFallbackResults,
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
      stockRetryAttempts: args.stockRetryAttempts,
      stockRetryBaseDelayMs: args.stockRetryBaseDelayMs,
      priorityDetailsOnly: args.priorityDetailsOnly,
    },
    summary: {
      productListRows: productRows.length,
      distinctSpuCount: spuNames.length,
      distinctSkcCount: unique(productRows.map(row => row?.skcName)).length,
      distinctSkuCount: skuCodes.length,
      detailRequestedSpuCount: selectedDetailSpus.length,
      detailPrioritySpuCount: Math.min(selectedDetailSpus.length, uncachedDetailSpus.length),
      detailConfiguredPrioritySpuCount: configuredPrioritySpus.length,
      detailAvailablePrioritySpuCount: availablePrioritySpus.length,
      detailUnavailablePrioritySpuCount: Math.max(0, configuredPrioritySpus.length - availablePrioritySpus.length),
      detailDeferredSpuCount: Math.max(0, spuNames.length - selectedDetailSpus.length),
      detailOkSpuCount: detailResults.filter(r => r.ok).length,
      detailFailedSpuCount: detailFailures.length,
      detailFallbackSpuCount: detailFallbackResults.length,
      detailMissingAfterFallbackCount: unique(normalizedRows
        .filter(row => row?.sourceCompleteness?.hasDetail !== true)
        .map(row => row?.spu)).length,
      stockRequestedSkuCount: args.skipStock ? 0 : skuCodes.length,
      stockOkSkuCount: stockBySku.size,
      stockFailedChunkCount: stockFailures.length,
      stockFailedChunks: buildStockFailureSummary(stockFailures),
      normalizedLinkRows: normalizedRows.length,
      normalizedOnShelfRows: normalizedRows.filter(r => String(r.shelfStatusCode) === '1').length,
    },
    productList: productRows,
    detailResults,
    detailFallbackResults,
    stockResponses,
    normalizedRows,
  };

  const stamp = fetchedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
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
      ...(detailFailures.length ? [`${detailFailures.length} 个 SPU 本轮详情请求失败，优先使用最近成功详情兜底`] : []),
      ...(stockFailures.length ? [`${stockFailures.length} 个库存查询分片失败`] : []),
    ],
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error?.stack || String(error)); process.exit(1); });
}

export {
  buildStockFailureSummary,
  fetchStock,
  isRetryableOpenapiFailure,
  parseArgs,
  sleepWithJitter,
};
