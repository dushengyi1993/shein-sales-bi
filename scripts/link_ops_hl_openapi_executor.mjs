#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_TASK_FILE = path.join(ROOT, 'state', 'bi_link_ops_tasks.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'logs', 'link-ops-openapi-executor');
const TARGET_STORE = 'HL';
const SUBMIT_CONFIRM_TEXT = 'SHEIN_HL_OPENAPI_SUBMIT';

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    taskFile: DEFAULT_TASK_FILE,
    taskId: '',
    taskJson: '',
    mode: 'dry-run',
    outDir: DEFAULT_OUT_DIR,
    store: TARGET_STORE,
    confirm: '',
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--task-file') args.taskFile = path.resolve(argv[++i]);
    else if (a === '--task-id') args.taskId = String(argv[++i] || '').trim();
    else if (a === '--task-json') args.taskJson = path.resolve(argv[++i]);
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--store') args.store = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--mode') args.mode = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--dry-run') args.mode = 'dry-run';
    else if (a === '--execute') args.mode = 'execute';
    else if (a === '--confirm') args.confirm = String(argv[++i] || '').trim();
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/link_ops_hl_openapi_executor.mjs --task-id <id> [--dry-run]
  node scripts/link_ops_hl_openapi_executor.mjs --task-json task.json --execute --confirm ${SUBMIT_CONFIRM_TEXT}

用途：
  HL 商品写执行器。默认只做真实 OpenAPI 权限、站点、品牌、仓库和发布 payload 预检；
  只有显式 --execute 且带确认文本、payload 完整时，才调用 publishOrEdit。`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!['dry-run', 'execute'].includes(args.mode)) throw new Error(`Invalid --mode: ${args.mode}`);
  return args;
}

function isoStamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function tenYearsLaterBeijing(date = new Date()) {
  const utcMs = date.getTime();
  const bj = new Date(utcMs + 8 * 60 * 60 * 1000);
  bj.setUTCFullYear(bj.getUTCFullYear() + 10);
  bj.setUTCHours(10, 0, 0, 0);
  const pad = n => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}:${pad(bj.getUTCSeconds())}`;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function safeString(value, max = 800) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function mask(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 10) return '***';
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

function normalizeTaskStore(data) {
  if (Array.isArray(data?.tasks)) return data;
  if (data?.id) return {version: 1, updatedAt: null, tasks: [data]};
  throw new Error('Task JSON must be a task object or {tasks: [...]} store');
}

async function loadTask(args) {
  const source = args.taskJson ? args.taskJson : args.taskFile;
  const store = normalizeTaskStore(await readJson(source));
  if (!args.taskId && store.tasks.length === 1) {
    return {source, task: store.tasks[0], taskStore: store};
  }
  const task = store.tasks.find(t => String(t?.id || '') === args.taskId);
  if (!task) throw new Error(`Task not found: ${args.taskId || '(missing --task-id)'}`);
  return {source, task, taskStore: store};
}

function getNested(obj, pathText) {
  let cur = obj;
  for (const part of pathText.split('.')) cur = cur?.[part];
  return cur;
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function resultRows(data) {
  return firstArray(
    getNested(data, 'info.data'),
    getNested(data, 'info.list'),
    getNested(data, 'info.site_list'),
    getNested(data, 'info.brand_list'),
    getNested(data, 'data'),
  );
}

function summarizeSiteList(data) {
  const rows = resultRows(data);
  const sites = [];
  for (const row of rows) {
    const mainSite = row?.main_site || row?.mainSite || '';
    for (const sub of asArray(row?.sub_site_list || row?.subSiteList)) {
      sites.push({
        mainSite,
        mainSiteName: row?.main_site_name || row?.mainSiteName || '',
        siteAbbr: sub?.site_abbr || sub?.siteAbbr || '',
        siteName: sub?.site_name || sub?.siteName || '',
        currency: sub?.currency || '',
        status: sub?.site_status ?? sub?.siteStatus ?? null,
      });
    }
  }
  return sites;
}

function summarizeBrandList(data) {
  return resultRows(data).map(row => ({
    brandCode: row?.brand_code || row?.brandCode || '',
    brandName: row?.brand_name || row?.brandName || row?.brand_name_en || row?.brandNameEn || '',
    brandNameEn: row?.brand_name_en || row?.brandNameEn || '',
  })).filter(row => row.brandCode || row.brandName);
}

function summarizeWarehouseList(data) {
  const rows = resultRows(data);
  const out = [];
  const queue = [...rows];
  const seen = new Set();
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    const id = cur.supplier_warehouse_id || cur.supplierWarehouseId || cur.warehouseId || cur.warehouse_id || cur.id;
    const name = cur.supplier_warehouse_name || cur.supplierWarehouseName || cur.warehouseName || cur.warehouse_name || cur.name;
    if (id || name) {
      out.push({
        id: id ? String(id) : '',
        name: name ? String(name) : '',
        type: cur.warehouseType || cur.warehouse_type || cur.type || '',
        status: cur.status ?? cur.warehouseStatus ?? null,
      });
    }
    for (const value of Object.values(cur)) {
      if (Array.isArray(value)) queue.push(...value);
      else if (value && typeof value === 'object') queue.push(value);
    }
  }
  const uniq = new Map();
  for (const row of out) {
    const key = `${row.id}|${row.name}`;
    if (!uniq.has(key)) uniq.set(key, row);
  }
  return [...uniq.values()].slice(0, 50);
}

function compactCallResult(name, pathText, method, response) {
  return {
    name,
    path: pathText,
    method,
    httpStatus: response.status,
    code: response.data?.code ?? null,
    msg: response.data?.msg ?? null,
    traceId: response.data?.traceId ?? null,
  };
}

async function callOpenApi(client, {name, method = 'POST', path: pathText, query, body, headers = {language: 'zh-cn'}}) {
  const response = await client.request(pathText, {method, query, body, headers});
  return {
    ...compactCallResult(name, pathText, method, response),
    data: response.data,
  };
}

function taskStores(task) {
  const stores = [
    ...asArray(task?.targets?.stores),
    ...asArray(task?.stores),
    task?.store,
    task?.targetStore,
  ].map(normalizeStoreKey).filter(Boolean);
  return [...new Set(stores)];
}

function taskProductRefs(task) {
  return [...new Set([
    ...asArray(task?.targets?.productRefs),
    ...asArray(task?.productRefs),
    task?.productRef,
    task?.sku,
    task?.skc,
  ].map(x => safeString(x, 120)).filter(Boolean))];
}

function taskIntents(task) {
  return [...new Set(asArray(task?.intents).map(x => String(x || '').trim()).filter(Boolean))];
}

function looksLikePublishPayload(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (value.skc_list || value.skcList || value.category_id || value.categoryId)
    && (value.multi_language_name_list || value.multiLanguageNameList || value.product_attribute_list || value.productAttributeList || value.skc_list || value.skcList));
}

function findPayloadDeep(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  if (looksLikePublishPayload(value)) return value;
  const directKeys = ['openapiPublishPayload', 'sheinOpenapiPublishPayload', 'publishPayload', 'publishOrEditPayload'];
  for (const key of directKeys) {
    if (looksLikePublishPayload(value[key])) return value[key];
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPayloadDeep(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const found = findPayloadDeep(item, depth + 1);
    if (found) return found;
  }
  return null;
}

async function tryReadJsonAsset(task, asset) {
  const mime = String(asset?.mime || '').toLowerCase();
  const name = String(asset?.originalName || asset?.storedName || '');
  if (mime !== 'application/json' && !/\.json$/i.test(name)) return null;
  const stored = asset?.storedRelativePath
    ? path.resolve(ROOT, String(asset.storedRelativePath))
    : asset?.storedPath
      ? path.resolve(String(asset.storedPath))
      : '';
  if (!stored) return null;
  const root = path.resolve(ROOT);
  if (!path.resolve(stored).startsWith(root + path.sep)) return null;
  try {
    const json = await readJson(stored);
    const payload = findPayloadDeep(json);
    if (!payload) return null;
    return {
      source: 'asset_json',
      assetId: asset.id || '',
      assetName: name,
      path: rel(stored),
      payload,
    };
  } catch (err) {
    return {
      source: 'asset_json_error',
      assetId: asset?.id || '',
      assetName: name,
      error: err?.message || String(err),
      payload: null,
    };
  }
}

async function findPublishPayload(task) {
  const fromTask = findPayloadDeep(task);
  if (fromTask) return {source: 'task', payload: jsonClone(fromTask)};
  for (const asset of asArray(task?.assets)) {
    const fromAsset = await tryReadJsonAsset(task, asset);
    if (fromAsset?.payload) return {...fromAsset, payload: jsonClone(fromAsset.payload)};
  }
  return null;
}

function applySafeDefaults(payload, {sites, brands}) {
  const next = jsonClone(payload || {});
  const applied = [];
  if (!next.source_system && !next.sourceSystem) {
    next.source_system = 'OpenAPI';
    applied.push('source_system=OpenAPI');
  }
  if (!next.site_list && !next.siteList) {
    const sa = sites.find(s => s.siteAbbr === 'shein-sa') || sites[0];
    if (sa?.mainSite && sa?.siteAbbr) {
      next.site_list = [{main_site: sa.mainSite, sub_site_list: [sa.siteAbbr]}];
      applied.push(`site_list=${sa.mainSite}/${sa.siteAbbr}`);
    }
  }
  if (!next.brand_code && !next.brandCode && brands.length === 1 && brands[0].brandCode) {
    next.brand_code = brands[0].brandCode;
    applied.push(`brand_code=${brands[0].brandName || brands[0].brandCode}`);
  }
  if ((next.shelf_way === undefined || next.shelfWay === undefined) && !('shelf_way' in next) && !('shelfWay' in next)) {
    next.shelf_way = 2;
    applied.push('shelf_way=2');
  }
  if ((next.shelf_way === 2 || next.shelfWay === 2) && !next.hope_on_sale_date && !next.hopeOnSaleDate) {
    next.hope_on_sale_date = tenYearsLaterBeijing();
    applied.push('hope_on_sale_date=10年后北京时间10:00');
  }
  return {payload: next, applied};
}

function validatePublishPayload(payload) {
  const blockers = [];
  const warnings = [];
  const has = (...keys) => keys.some(k => payload?.[k] !== undefined && payload?.[k] !== null && payload?.[k] !== '');
  const arr = (...keys) => {
    for (const key of keys) if (Array.isArray(payload?.[key]) && payload[key].length) return payload[key];
    return [];
  };
  if (!has('category_id', 'categoryId')) blockers.push('缺 category_id：需要从源链接/类目树确定最终叶子类目。');
  if (!has('product_type_id', 'productTypeId')) warnings.push('缺 product_type_id：新发布商品通常需要类目树返回的 product_type_id。');
  if (!has('source_system', 'sourceSystem')) blockers.push('缺 source_system=OpenAPI。');
  if (!arr('multi_language_name_list', 'multiLanguageNameList').length) blockers.push('缺 multi_language_name_list：至少需要商品标题/多语言名称。');
  if (!arr('product_attribute_list', 'productAttributeList').length) blockers.push('缺 product_attribute_list：需要类目属性模板和源商品参数。');
  if (!arr('site_list', 'siteList').length) blockers.push('缺 site_list：HL 沙特站应包含 shein / shein-sa。');
  const skcList = arr('skc_list', 'skcList');
  if (!skcList.length) blockers.push('缺 skc_list：需要 SKC 图片、销售属性和 SKU 列表。');
  for (const [i, skc] of skcList.entries()) {
    const prefix = `skc_list[${i}]`;
    const imageInfo = skc?.image_info || skc?.imageInfo || {};
    const imageList = asArray(imageInfo?.image_info_list || imageInfo?.imageInfoList);
    if (!imageList.length) blockers.push(`${prefix} 缺 image_info.image_info_list：需要主图/详情图素材或源商品图片映射。`);
    const saleAttrs = asArray(skc?.sale_attribute || skc?.saleAttribute);
    if (!saleAttrs.length) blockers.push(`${prefix} 缺 sale_attribute：需要颜色/规格等销售属性。`);
    const skuList = asArray(skc?.sku_list || skc?.skuList);
    if (!skuList.length) blockers.push(`${prefix} 缺 sku_list：需要 SKU 规格、成本、库存、尺寸重量。`);
    for (const [j, sku] of skuList.entries()) {
      const skuPrefix = `${prefix}.sku_list[${j}]`;
      for (const key of ['height', 'length', 'width', 'weight']) {
        if (sku?.[key] === undefined || sku?.[key] === null || sku?.[key] === '') blockers.push(`${skuPrefix} 缺 ${key}。`);
      }
      if (!sku?.mall_state && !sku?.mallState) blockers.push(`${skuPrefix} 缺 mall_state。`);
      if (!sku?.supplier_sku && !sku?.supplierSku) blockers.push(`${skuPrefix} 缺 supplier_sku。`);
      if (!sku?.cost_info && !sku?.costInfo) blockers.push(`${skuPrefix} 缺 cost_info：半托管新发品需要供货价/成本信息。`);
      const stockList = asArray(sku?.stock_info_list || sku?.stockInfoList);
      if (!stockList.length) blockers.push(`${skuPrefix} 缺 stock_info_list：至少需要库存数量，通常还需要仓库。`);
    }
  }
  if (!has('shelf_way', 'shelfWay')) blockers.push('缺 shelf_way：半托管新发品需要上架方式。');
  const shelfWay = payload?.shelf_way ?? payload?.shelfWay;
  if (Number(shelfWay) === 2 && !has('hope_on_sale_date', 'hopeOnSaleDate')) {
    blockers.push('shelf_way=2 时缺 hope_on_sale_date。');
  }
  return {ok: blockers.length === 0, blockers, warnings};
}

function extractPayloadSummary(payload) {
  const skcList = asArray(payload?.skc_list || payload?.skcList);
  const skuCount = skcList.reduce((sum, skc) => sum + asArray(skc?.sku_list || skc?.skuList).length, 0);
  return {
    categoryId: payload?.category_id ?? payload?.categoryId ?? null,
    productTypeId: payload?.product_type_id ?? payload?.productTypeId ?? null,
    brandCode: payload?.brand_code ?? payload?.brandCode ?? null,
    sourceSystem: payload?.source_system ?? payload?.sourceSystem ?? null,
    shelfWay: payload?.shelf_way ?? payload?.shelfWay ?? null,
    hopeOnSaleDate: payload?.hope_on_sale_date ?? payload?.hopeOnSaleDate ?? null,
    siteCount: asArray(payload?.site_list || payload?.siteList).length,
    nameCount: asArray(payload?.multi_language_name_list || payload?.multiLanguageNameList).length,
    attributeCount: asArray(payload?.product_attribute_list || payload?.productAttributeList).length,
    skcCount: skcList.length,
    skuCount,
  };
}

async function loadClient(args) {
  const config = await readJson(args.config);
  const store = asArray(config.stores).find(s => normalizeStoreKey(s?.storeKey) === normalizeStoreKey(args.store));
  if (!store?.openKeyId || !store?.secretKey) {
    throw new Error(`未在 ${rel(args.config)} 找到 ${args.store} 的 openKeyId/secretKey`);
  }
  return {
    config,
    store,
    client: new SheinOpenApiClient({
      baseUrl: config.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
      openKeyId: store.openKeyId,
      secretKey: store.secretKey,
    }),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const runId = `lho_${isoStamp()}_${crypto.randomBytes(4).toString('hex')}`;
  const {source, task} = await loadTask(args);
  const stores = taskStores(task);
  const intents = taskIntents(task);
  const productRefs = taskProductRefs(task);
  const targetStore = normalizeStoreKey(args.store || TARGET_STORE);
  const blockers = [];
  const warnings = [];
  const evidence = {};

  if (!stores.includes(targetStore)) {
    blockers.push(`任务目标店铺未包含 ${targetStore}，本执行器不会处理其它店。`);
  }
  if (!intents.includes('copy_product_draft')) {
    warnings.push('任务 intent 未包含 copy_product_draft；本执行器只负责 HL 复制/补链发品路径。');
  }
  if (String(task?.status || '') !== 'confirmed' && String(task?.status || '') !== 'in_progress' && String(task?.status || '') !== 'waiting_review') {
    blockers.push('任务尚未确认成任务，不能进入 SHEIN 写执行。');
  }

  const {store, client} = await loadClient(args);
  const calls = [];
  const publishPermission = await callOpenApi(client, {
    name: 'check-publish-permission',
    method: 'GET',
    path: '/open-api/goods/product/check-publish-permission',
  });
  calls.push(compactCallResult(publishPermission.name, publishPermission.path, publishPermission.method, {status: publishPermission.httpStatus, data: publishPermission.data}));
  const canPublish = Boolean(publishPermission.data?.info?.canPublishProduct);
  evidence.canPublishProduct = canPublish;
  evidence.publishPermissionReason = publishPermission.data?.info?.reason ?? null;
  if (publishPermission.code !== '0' || !canPublish) {
    blockers.push(`HL 店铺当前不可发品：${safeString(publishPermission.data?.msg || publishPermission.data?.info?.reason || '未知原因')}`);
  }

  const siteResult = await callOpenApi(client, {
    name: 'query-site-list',
    method: 'POST',
    path: '/open-api/goods/query-site-list',
    body: {},
  });
  calls.push(compactCallResult(siteResult.name, siteResult.path, siteResult.method, {status: siteResult.httpStatus, data: siteResult.data}));
  const sites = summarizeSiteList(siteResult.data);
  evidence.sites = sites;
  if (!sites.some(s => s.siteAbbr === 'shein-sa' && String(s.currency).toUpperCase() === 'SAR')) {
    warnings.push('未在站点列表中解析到 shein-sa/SAR；发布 payload 必须人工复核站点。');
  }

  const brandResult = await callOpenApi(client, {
    name: 'query-brand-list',
    method: 'POST',
    path: '/open-api/goods/query-brand-list',
    body: {},
  });
  calls.push(compactCallResult(brandResult.name, brandResult.path, brandResult.method, {status: brandResult.httpStatus, data: brandResult.data}));
  const brands = summarizeBrandList(brandResult.data);
  evidence.brands = brands;

  let warehouses = [];
  try {
    const warehouseResult = await callOpenApi(client, {
      name: 'warehouse-list',
      method: 'GET',
      path: '/open-api/msc/warehouse/list',
    });
    calls.push(compactCallResult(warehouseResult.name, warehouseResult.path, warehouseResult.method, {status: warehouseResult.httpStatus, data: warehouseResult.data}));
    warehouses = summarizeWarehouseList(warehouseResult.data);
    evidence.warehouses = warehouses;
  } catch (err) {
    warnings.push(`仓库列表探针失败：${safeString(err?.message || err)}`);
  }

  const payloadFound = await findPublishPayload(task);
  let payloadSummary = null;
  let safeDefaults = [];
  let payloadValidation = {ok: false, blockers: ['缺 OpenAPI 发布 payload：需要先从源 SKC 后台详情映射出类目、属性、图片、SKU、供货价、库存和尺寸重量。'], warnings: []};
  let publishPayload = null;
  if (payloadFound?.payload) {
    const applied = applySafeDefaults(payloadFound.payload, {sites, brands});
    publishPayload = applied.payload;
    safeDefaults = applied.applied;
    payloadValidation = validatePublishPayload(publishPayload);
    payloadSummary = extractPayloadSummary(publishPayload);
    warnings.push(...payloadValidation.warnings);
    blockers.push(...payloadValidation.blockers);
  } else {
    blockers.push(...payloadValidation.blockers);
  }

  if (productRefs.length && !payloadFound?.payload) {
    warnings.push(`已识别任务对象 ${productRefs.join('、')}，但当前 BI 数据不足以还原完整发布 payload；需要接入源商品详情抓取/映射器。`);
  }

  if (args.mode === 'execute') {
    if (args.confirm !== SUBMIT_CONFIRM_TEXT) {
      blockers.push(`真实提交必须显式传入 --confirm ${SUBMIT_CONFIRM_TEXT}`);
    }
  }

  const readyForSubmit = blockers.length === 0 && Boolean(publishPayload);
  let publishResult = null;
  if (args.mode === 'execute' && readyForSubmit) {
    const response = await client.request('/open-api/goods/product/publishOrEdit', {
      method: 'POST',
      body: publishPayload,
      headers: {language: 'zh-cn'},
    });
    publishResult = {
      httpStatus: response.status,
      code: response.data?.code ?? null,
      msg: response.data?.msg ?? null,
      traceId: response.data?.traceId ?? null,
      info: response.data?.info ?? null,
    };
    calls.push({
      name: 'publishOrEdit',
      path: '/open-api/goods/product/publishOrEdit',
      method: 'POST',
      httpStatus: publishResult.httpStatus,
      code: publishResult.code,
      msg: publishResult.msg,
      traceId: publishResult.traceId,
    });
    if (publishResult.code !== '0') {
      blockers.push(`publishOrEdit 返回失败：${safeString(publishResult.msg || publishResult.code || '未知错误')}`);
    }
  }

  const state = args.mode === 'execute'
    ? (publishResult?.code === '0' ? 'submitted' : 'blocked')
    : (readyForSubmit ? 'ready_for_submit' : 'blocked');
  const output = {
    ok: blockers.length === 0,
    runId,
    mode: args.mode,
    state,
    startedAt,
    endedAt: new Date().toISOString(),
    storeKey: targetStore,
    sourceTaskFile: rel(source),
    task: {
      id: task?.id || '',
      status: task?.status || '',
      title: task?.title || task?.summary || '',
      stores,
      productRefs,
      intents,
    },
    openapi: {
      baseUrl: client.baseUrl,
      openKeyId: mask(store.openKeyId),
      calls,
      canPublishProduct: canPublish,
      publishPermissionReason: evidence.publishPermissionReason,
      sites,
      brands,
      warehouses,
    },
    payload: {
      found: Boolean(payloadFound?.payload),
      source: payloadFound?.source || null,
      assetId: payloadFound?.assetId || null,
      assetName: payloadFound?.assetName || null,
      safeDefaults,
      summary: payloadSummary,
      validation: payloadValidation,
    },
    blockers,
    warnings,
    publishResult,
    safety: {
      canSilentWrite: false,
      executeRequiresConfirm: SUBMIT_CONFIRM_TEXT,
      dryRunDoesNotCallPublishOrEdit: args.mode !== 'execute',
      note: '默认只预检；真实 publishOrEdit 必须任务已确认、payload 完整、显式 execute 和确认文本同时满足。',
    },
  };

  const outPath = path.join(args.outDir, `${runId}.local.json`);
  await writeJson(outPath, output);
  output.savedTo = rel(outPath);
  if (!args.quiet) console.log(JSON.stringify(output, null, 2));
  process.exitCode = output.ok ? 0 : 2;
}

main().catch(err => {
  const error = {
    ok: false,
    state: 'error',
    error: err?.stack || err?.message || String(err),
  };
  console.error(JSON.stringify(error, null, 2));
  process.exit(1);
});
