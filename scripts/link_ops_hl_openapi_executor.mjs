#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';
import {
  buildProductDraftFromSnapshots,
  inferSourceProductFromTask,
  summarizeDraftForExecutor,
} from '../lib/link_ops_product_draft_mapper.mjs';
import {
  formatStoreIdentityError,
  validateStoreIdentity,
} from '../lib/shein_store_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_TASK_FILE = path.join(ROOT, 'state', 'bi_link_ops_tasks.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'logs', 'link-ops-openapi-executor');
const TARGET_STORE = 'HL';
const SUBMIT_CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const STORES = STORES_CONFIG.stores || [];
const STORE_ACCOUNT_TRUTH = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'store_account_truth.json'), 'utf8'));
const ALLOWED_SKC_IMAGE_TYPES = new Set([1, 2, 5, 6]);
const SKC_IMAGE_TYPE_LABELS = new Map([
  [1, '主图'],
  [2, '细节图'],
  [5, '方块图'],
  [6, '色块图'],
]);

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
  node scripts/link_ops_hl_openapi_executor.mjs --task-id <id> [--dry-run] [--store HL]
  node scripts/link_ops_hl_openapi_executor.mjs --task-json task.json --execute --confirm ${SUBMIT_CONFIRM_TEXT}

用途：
  SHEIN OpenAPI 商品写执行器。默认只做真实 OpenAPI 权限、站点、品牌、仓库和发布 payload 预检；
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

function stableTaskBaseDate(task = null, executionContext = null) {
  for (const value of [
    task?.createdAt,
    task?.created_at,
    task?.created,
    executionContext?.taskCreatedAt,
    executionContext?.createdAt,
    executionContext?.issuedAt,
  ]) {
    if (!value) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function newLinkHopeOnSaleDate(task = null, executionContext = null) {
  return tenYearsLaterBeijing(stableTaskBaseDate(task, executionContext));
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

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256Stable(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function appendUnique(target, values) {
  const seen = new Set(target);
  for (const value of asArray(values)) {
    const text = safeString(value, 1000);
    if (!text || seen.has(text)) continue;
    target.push(text);
    seen.add(text);
  }
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
    return {source, task: store.tasks[0], taskStore: store, executionContext: store.executionContext || null};
  }
  const task = store.tasks.find(t => String(t?.id || '') === args.taskId);
  if (!task) throw new Error(`Task not found: ${args.taskId || '(missing --task-id)'}`);
  return {source, task, taskStore: store, executionContext: store.executionContext || null};
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

function collectOpenApiIdentity(value, out = null, depth = 0) {
  const target = out || {
    accountNos: new Set(),
    userNames: new Set(),
    mainUserNames: new Set(),
    supplierUserNames: new Set(),
    supplierIds: new Set(),
    externalIds: new Set(),
    emplids: new Set(),
    companyNames: new Set(),
    rawSources: new Set(),
  };
  if (!value || depth > 7) return target;
  if (Array.isArray(value)) {
    value.forEach(item => collectOpenApiIdentity(item, target, depth + 1));
    return target;
  }
  if (typeof value !== 'object') return target;
  target.rawSources.add(`openapi-depth-${depth}`);
  const add = (setName, candidate) => {
    if (candidate === null || candidate === undefined || candidate === '') return;
    target[setName].add(String(candidate).trim());
  };
  add('userNames', value.userName || value.username || value.name || value.enName);
  add('mainUserNames', value.mainUserName || value.main_user_name);
  add('supplierUserNames', value.supplierUserName || value.supplier_user_name);
  add('supplierIds', value.supplierId || value.supplier_id || value.merchantId || value.merchant_id);
  add('externalIds', value.externalId || value.external_id);
  add('emplids', value.emplid || value.empId);
  add('companyNames', value.companyName || value.company_name || value.supplierName || value.supplier_name);
  for (const candidate of [
    value.accountNo,
    value.account_no,
    value.shopName,
    value.shop_name,
    value.userName,
    value.username,
    value.name,
    value.enName,
    value.mainUserName,
    value.main_user_name,
    value.supplierUserName,
    value.supplier_user_name,
  ]) {
    if (/^GS\d+$/i.test(String(candidate || '').trim())) {
      target.accountNos.add(String(candidate).trim().toUpperCase());
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === 'object' && /(user|supplier|merchant|store|shop|seller|account|company|info|data)/i.test(key)) {
      collectOpenApiIdentity(child, target, depth + 1);
    }
  }
  return target;
}

function openApiIdentityToStorageIdentity(value) {
  const collected = collectOpenApiIdentity(value);
  return Object.fromEntries(Object.entries(collected).map(([key, set]) => [key, [...set]]));
}

function openApiStoreIdentityMatchesMerchant(identityCheck) {
  if (!identityCheck || identityCheck.ok) return Boolean(identityCheck?.ok);
  const expectedMerchantId = String(identityCheck.expectedMerchantId || '').trim();
  if (!expectedMerchantId) return false;
  const merchantOk = identityCheck.merchantOk === true
    || (Array.isArray(identityCheck.merchantCandidates) && identityCheck.merchantCandidates.includes(expectedMerchantId));
  const accountConflicts = Array.isArray(identityCheck.accountConflicts) ? identityCheck.accountConflicts : [];
  const merchantConflicts = Array.isArray(identityCheck.merchantConflicts) ? identityCheck.merchantConflicts : [];
  const accountCandidates = Array.isArray(identityCheck.accountCandidates) ? identityCheck.accountCandidates : [];
  const hasConcreteAccountCandidate = accountCandidates.some(value => /^GS\d+$/i.test(String(value || '').trim()));
  return merchantOk && !accountConflicts.length && !merchantConflicts.length && !hasConcreteAccountCandidate;
}

function configuredStoreForIdentity(storeKey) {
  return STORES.find(s => normalizeStoreKey(s.storeKey) === normalizeStoreKey(storeKey));
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

async function callOpenApi(client, {name, method = 'POST', path: pathText, query, body, headers = {language: 'en'}}) {
  const response = await client.request(pathText, {method, query, body, headers});
  return {
    ...compactCallResult(name, pathText, method, response),
    data: response.data,
  };
}

function openApiStoreConfig(config, storeKey) {
  const key = normalizeStoreKey(storeKey);
  return asArray(config?.stores).find(s => normalizeStoreKey(s?.storeKey) === key) || null;
}

function openApiClientForStore(config, storeKey) {
  const store = openApiStoreConfig(config, storeKey);
  if (!store?.openKeyId || !store?.secretKey) return null;
  return {
    store,
    client: new SheinOpenApiClient({
      baseUrl: config.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
      openKeyId: store.openKeyId,
      secretKey: store.secretKey,
    }),
  };
}

function taskStores(task) {
  const stores = [
    ...asArray(task?.targets?.stores),
    ...asArray(task?.targets?.writeStores),
    ...asArray(task?.targets?.targetStores),
    ...asArray(task?.stores),
    ...asArray(task?.writeStores),
    ...asArray(task?.targetStores),
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

async function readJsonIfExists(file) {
  try {
    return await readJson(file);
  } catch {
    return null;
  }
}

function biPortalLinkRows(data) {
  const candidates = [
    data?.storeLinks,
    data?.links,
    data?.data?.storeLinks,
    data?.data?.links,
  ];
  for (const value of candidates) {
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
}

function compactRef(value) {
  return String(value || '').toLowerCase().replace(/[\s_\-（）()【】\[\]，,。.;；:：/\\]+/g, '');
}

function explicitSkcRefs(task) {
  const text = [
    task?.sourceSkc,
    task?.source_skc,
    task?.skc,
    task?.metadata?.sourceSkc,
    ...taskProductRefs(task),
    task?.command,
    task?.title,
    task?.summary,
  ].map(x => safeString(x, 4000)).join('\n');
  return [...new Set((text.match(/\b(s[avb]\d{8,})\b/ig) || []).map(x => x.trim()))];
}

function sourceCandidateScore(row, {storeHints, sourceStoreAllowList = [], productHints, explicitSkcs}) {
  const store = normalizeStoreKey(row?.store_key || row?.storeKey);
  const skc = safeString(row?.skc, 120);
  if (!store || !skc) return -Infinity;
  if (sourceStoreAllowList.length && !sourceStoreAllowList.includes(store)) return -Infinity;
  const standard = safeString(row?.standard_goods_sn || row?.standardGoodsSn || row?.raw_goods_sn || row?.rawGoodsSn, 400);
  const hay = compactRef([standard, skc, row?.product_name_cn, row?.productNameCn, row?.goods_sn, row?.rawGoodsSn].filter(Boolean).join(' '));
  let score = 0;
  const matchedSkc = explicitSkcs.some(x => String(x).toLowerCase() === skc.toLowerCase());
  if (matchedSkc) score += 2_000_000;
  const matchedProduct = productHints.some(ref => {
    const q = compactRef(ref);
    const standardRef = compactRef(standard);
    return q && (hay.includes(q) || (standardRef && q.includes(standardRef)));
  });
  if (!matchedSkc && !matchedProduct) return -Infinity;
  if (matchedProduct) score += 300_000;
  if (storeHints.includes(store)) score += 30_000;
  if (/上架|on/i.test(String(row?.shelf_status_name || row?.shelfStatusName || ''))) score += 20_000;
  if (row?.retire_candidate || row?.retireCandidate) score -= 50_000;
  score += Number(row?.c30_sale_cnt ?? row?.c30SaleCnt ?? 0) * 10_000;
  score += Number(row?.c7_sale_cnt ?? row?.c7SaleCnt ?? 0) * 8_000;
  score += Number(row?.c30_goods_uv ?? row?.c30GoodsUv ?? row?.goods_uv ?? 0) * 20;
  score += Number(row?.c30_eps_uv ?? row?.c30EpsUv ?? row?.eps_uv ?? 0) * 0.5;
  return score;
}

function sourceCandidateMetrics(row) {
  return {
    shelfStatusName: safeString(row?.shelf_status_name || row?.shelfStatusName || '', 80),
    rawGoodsSn: safeString(row?.raw_goods_sn || row?.rawGoodsSn || row?.goods_sn || row?.goodsSn || '', 240),
    productName: safeString(row?.product_name_cn || row?.productNameCn || row?.product_display_name || row?.productDisplayName || '', 240),
    c7SaleCnt: Number(row?.c7_sale_cnt ?? row?.c7SaleCnt ?? 0) || 0,
    c30SaleCnt: Number(row?.c30_sale_cnt ?? row?.c30SaleCnt ?? 0) || 0,
    c7GoodsUv: Number(row?.c7_goods_uv ?? row?.c7GoodsUv ?? 0) || 0,
    c30GoodsUv: Number(row?.c30_goods_uv ?? row?.c30GoodsUv ?? 0) || 0,
    c7EpsUv: Number(row?.c7_eps_uv ?? row?.c7EpsUv ?? 0) || 0,
    c30EpsUv: Number(row?.c30_eps_uv ?? row?.c30EpsUv ?? 0) || 0,
    totalSaleVolume: Number(row?.total_sale_volume ?? row?.totalSaleVolume ?? row?.platform_total_sale_volume ?? 0) || 0,
    lastSaleDate: safeString(row?.last_sale_date || row?.lastSaleDate || '', 40),
  };
}

async function inferSourceCandidatesFromBi(task, {targetStore}) {
  const rows = [];
  for (const file of [
    path.join(ROOT, 'outputs', 'bi-portal', 'sections', 'linksData.json'),
    path.join(ROOT, 'outputs', 'bi-portal', 'data.json'),
  ]) {
    const data = await readJsonIfExists(file);
    rows.push(...biPortalLinkRows(data));
  }
  if (!rows.length) return [];
  const explicitSourceStores = [...new Set([
    ...asArray(task?.targets?.sourceStores),
    ...asArray(task?.targets?.readStores),
    ...asArray(task?.sourceStores),
    ...asArray(task?.readStores),
    task?.sourceStore,
  ].map(normalizeStoreKey).filter(Boolean))];
  const sourceScope = String(task?.targets?.sourceScope || task?.sourceScope || '').trim().toLowerCase();
  const storeHints = explicitSourceStores.length
    ? explicitSourceStores
    : (sourceScope === 'all_stores' ? [] : taskStores(task));
  const productHints = taskProductRefs(task).filter(x => !/^s[avb]\d{8,}$/i.test(x));
  const skcHints = explicitSkcRefs(task);
  const scored = rows
    .map(row => ({
      sourceStore: normalizeStoreKey(row?.store_key || row?.storeKey),
      sourceSkc: safeString(row?.skc, 120),
      standardGoodsSn: safeString(row?.standard_goods_sn || row?.standardGoodsSn, 240),
      source: 'bi_portal_store_link',
      score: sourceCandidateScore(row, {storeHints, sourceStoreAllowList: explicitSourceStores, productHints, explicitSkcs: skcHints}),
      metrics: sourceCandidateMetrics(row),
    }))
    .filter(x => x.sourceStore && x.sourceSkc && Number.isFinite(x.score) && x.score > 0)
    .sort((a, b) => b.score - a.score);
  const out = [];
  const seen = new Set();
  for (const item of scored) {
    const key = `${item.sourceStore}|${item.sourceSkc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= 12) break;
  }
  return out;
}

function uniqueSourceCandidates(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const sourceStore = normalizeStoreKey(value?.sourceStore);
    const sourceSkc = safeString(value?.sourceSkc, 120);
    if (!sourceStore || !sourceSkc) continue;
    const key = `${sourceStore}|${sourceSkc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({...value, sourceStore, sourceSkc});
  }
  return out;
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

async function findOrBuildPublishPayload(task, {targetStore}) {
  const existing = await findPublishPayload(task);
  if (existing?.payload) return existing;
  const inferred = inferSourceProductFromTask(task, {targetStore});
  const biCandidates = await inferSourceCandidatesFromBi(task, {targetStore});
  const candidates = uniqueSourceCandidates([inferred, ...biCandidates]);
  if (!candidates.length) {
    return {
      source: 'missing',
      payload: null,
      inferred,
      generationError: inferred.sourceStore
        ? '未能从任务中识别源 SKC。'
        : '未能从任务中识别源店和源 SKC。',
    };
  }
  const errors = [];
  for (const candidate of candidates) {
    try {
      const generated = await buildProductDraftFromSnapshots({
        sourceStore: candidate.sourceStore,
        sourceSkc: candidate.sourceSkc,
        date: 'latest',
        targetStore,
      });
      return {
        source: candidate.source === 'bi_portal_store_link' ? 'bi_portal_webapi_snapshot' : 'webapi_snapshot',
        payload: jsonClone(generated.openapiPublishPayloadDraft),
        generatedDraft: summarizeDraftForExecutor(generated),
        canonicalDraft: generated.canonicalDraft,
        mappingBlockers: generated.blockers,
        mappingWarnings: generated.warnings,
        inferred: candidate,
        attemptedCandidates: candidates.map(x => ({
          sourceStore: x.sourceStore,
          sourceSkc: x.sourceSkc,
          standardGoodsSn: x.standardGoodsSn || '',
          score: x.score ?? null,
          metrics: x.metrics || null,
        })),
      };
    } catch (err) {
      errors.push(`${candidate.sourceStore}/${candidate.sourceSkc}: ${err?.message || String(err)}`);
    }
  }
  return {
    source: 'webapi_snapshot_error',
    payload: null,
    inferred,
    attemptedCandidates: candidates.map(x => ({
      sourceStore: x.sourceStore,
      sourceSkc: x.sourceSkc,
      standardGoodsSn: x.standardGoodsSn || '',
      score: x.score ?? null,
      metrics: x.metrics || null,
    })),
    generationError: errors.slice(0, 8).join('；') || '未能从候选源链接生成发布 payload。',
  };
}

function taskTextForKnownRules(task, executionContext = {}) {
  return [
    task?.command,
    task?.title,
    ...asArray(task?.productRefs || task?.targets?.productRefs),
    ...asArray(task?.targets?.productRefs),
    ...asArray(executionContext?.productRefs),
    ...asArray(executionContext?.targets?.productRefs),
    executionContext?.sourceSkc,
    executionContext?.targets?.sourceSkc,
  ].map(v => safeString(v, 300)).filter(Boolean).join(' ');
}

function isKnownSm505SewingMachineTask(task, executionContext = {}) {
  const text = taskTextForKnownRules(task, executionContext);
  return /SM-?505A/i.test(text)
    || /(?:^|[^0-9])505(?:[^0-9]|$)/.test(text) && /缝纫机/.test(text)
    || /sv25082869650540305/i.test(text);
}

function applySafeDefaults(payload, {sites, brands, task = null, executionContext = null} = {}) {
  const next = jsonClone(payload || {});
  const applied = [];
  if (!next.source_system && !next.sourceSystem) {
    next.source_system = 'OpenAPI';
    applied.push('source_system=OpenAPI');
  }
  const existingSiteList = asArray(next.site_list || next.siteList);
  if (!existingSiteList.length) {
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
  const scheduledHopeOnSaleDate = newLinkHopeOnSaleDate(task, executionContext);
  const currentShelfWay = next.shelf_way ?? next.shelfWay;
  if (Number(currentShelfWay) !== 2) {
    next.shelf_way = 2;
    if ('shelfWay' in next) delete next.shelfWay;
    applied.push(currentShelfWay === undefined ? 'shelf_way=2.new_link_scheduled' : 'shelf_way=2.override_new_link_scheduled');
  } else if (!('shelf_way' in next) && 'shelfWay' in next) {
    next.shelf_way = next.shelfWay;
    delete next.shelfWay;
    applied.push('shelf_way.normalize_snake_case');
  }
  if (!next.hope_on_sale_date && next.hopeOnSaleDate) {
    next.hope_on_sale_date = next.hopeOnSaleDate;
    delete next.hopeOnSaleDate;
    applied.push('hope_on_sale_date.normalize_snake_case');
  }
  if (!next.hope_on_sale_date) {
    next.hope_on_sale_date = scheduledHopeOnSaleDate;
    applied.push('hope_on_sale_date=ten_years_later_new_link_scheduled');
  }
  const shelfWay = next.shelf_way ?? next.shelfWay ?? 2;
  const hopeOnSaleDate = next.hope_on_sale_date ?? next.hopeOnSaleDate ?? scheduledHopeOnSaleDate;
  const skcList = asArray(next.skc_list || next.skcList).filter(row => row && typeof row === 'object');
  for (const skc of skcList) {
    const skcShelfWay = skc.shelf_way ?? skc.shelfWay;
    if (Number(skcShelfWay) !== 2) {
      skc.shelf_way = shelfWay;
      if ('shelfWay' in skc) delete skc.shelfWay;
      applied.push(skcShelfWay === undefined ? 'skc_list.shelf_way' : 'skc_list.shelf_way.override_new_link_scheduled');
    } else if (!('shelf_way' in skc) && 'shelfWay' in skc) {
      skc.shelf_way = skc.shelfWay;
      delete skc.shelfWay;
      applied.push('skc_list.shelf_way.normalize_snake_case');
    }
    if (String(skc.shelf_way ?? skc.shelfWay) === '2' && hopeOnSaleDate && !skc.hope_on_sale_date && !skc.hopeOnSaleDate) {
      skc.hope_on_sale_date = hopeOnSaleDate;
      applied.push('skc_list.hope_on_sale_date');
    }
  }
  const normalizedNames = normalizePublishNames(next);
  if (normalizedNames.applied.length) applied.push(...normalizedNames.applied);
  const normalizedAttributes = normalizePublishProductAttributes(next);
  if (normalizedAttributes.applied.length) applied.push(...normalizedAttributes.applied);
  return {payload: next, applied};
}

function normalizePublishNames(payload) {
  const applied = [];
  const rows = asArray(payload?.multi_language_name_list || payload?.multiLanguageNameList)
    .filter(row => row && typeof row === 'object');
  const byLanguage = new Map();
  let removedBlank = false;
  let copiedProductName = false;
  for (const row of rows) {
    const language = safeString(row.language || row.lang || row.languageCode || '', 40).toLowerCase();
    const name = safeString(row.name || row.product_name || row.productName || row.value || '', 500);
    if (!language || !name) {
      removedBlank = true;
      continue;
    }
    if (!row.name && (row.product_name || row.productName || row.value)) copiedProductName = true;
    if (!byLanguage.has(language)) byLanguage.set(language, {language, name});
  }
  const normalized = [...byLanguage.values()];
  if (removedBlank) applied.push('multi_language_name_list.remove_blank_names');
  if (copiedProductName) applied.push('multi_language_name_list.name_from_product_name');
  if (normalized.length || payload.multi_language_name_list || payload.multiLanguageNameList) {
    payload.multi_language_name_list = normalized;
    if (payload.multiLanguageNameList) delete payload.multiLanguageNameList;
  }
  return {applied: [...new Set(applied)]};
}

function payloadNameLanguages(payload) {
  return new Set(asArray(payload?.multi_language_name_list || payload?.multiLanguageNameList)
    .map(row => safeString(row?.language || row?.lang || row?.languageCode || '', 40).toLowerCase())
    .filter(Boolean));
}

function openApiSpuInfoSkcList(info) {
  return asArray(info?.skcInfoList || info?.skc_info_list || info?.skcList || info?.skc_list);
}

function openApiSpuInfoSkcName(row) {
  return safeString(row?.skcName || row?.skc_name || row?.skc || row?.supplierCode || row?.supplier_code, 160);
}

function namesFromOpenApiSpuInfo(info, sourceSkc = '') {
  const skcRows = openApiSpuInfoSkcList(info);
  const matchedSkc = skcRows.find(row => openApiSpuInfoSkcName(row) === sourceSkc) || skcRows[0] || null;
  const rows = [
    ...asArray(matchedSkc?.productMultiNameList || matchedSkc?.product_multi_name_list),
    ...asArray(info?.productMultiNameList || info?.product_multi_name_list),
  ];
  const byLanguage = new Map();
  for (const row of rows) {
    const language = safeString(row?.language || row?.lang || row?.languageCode || '', 40).toLowerCase();
    const name = safeString(row?.name || row?.productName || row?.product_name || row?.value || '', 1000);
    if (!language || !name || byLanguage.has(language)) continue;
    byLanguage.set(language, {language, name});
  }
  return [...byLanguage.values()];
}

function mergePayloadNames(payload, names) {
  const next = jsonClone(payload || {});
  const rows = asArray(next.multi_language_name_list || next.multiLanguageNameList)
    .filter(row => row && typeof row === 'object')
    .map(row => ({...row}));
  const byLanguage = new Map();
  for (const row of rows) {
    const language = safeString(row.language || row.lang || row.languageCode || '', 40).toLowerCase();
    if (!language) continue;
    byLanguage.set(language, row);
  }
  const applied = [];
  for (const row of asArray(names)) {
    const language = safeString(row?.language || '', 40).toLowerCase();
    const name = safeString(row?.name || '', 1000);
    if (!language || !name) continue;
    const existing = byLanguage.get(language);
    const existingName = safeString(existing?.name || existing?.product_name || existing?.productName || existing?.value || '', 1000);
    if (existing && existingName) continue;
    const normalized = {language, name};
    if (existing) Object.assign(existing, normalized);
    else {
      rows.push(normalized);
      byLanguage.set(language, normalized);
    }
    applied.push(`multi_language_name_list.${language}.from_source_spu_info`);
  }
  next.multi_language_name_list = rows;
  if (next.multiLanguageNameList) delete next.multiLanguageNameList;
  return {payload: next, applied: [...new Set(applied)]};
}

async function enrichPayloadNamesFromLiveSourceOpenApi(config, payload, payloadFound) {
  const sourceStore = normalizeStoreKey(
    payloadFound?.inferred?.sourceStore
    || payloadFound?.generatedDraft?.sourceStore
    || payloadFound?.canonicalDraft?.source?.storeKey
  );
  const sourceSkc = safeString(
    payloadFound?.inferred?.sourceSkc
    || payloadFound?.generatedDraft?.sourceSkc
    || payloadFound?.canonicalDraft?.openApiDetail?.skcName
    || '',
    160
  );
  const spuName = safeString(
    payloadFound?.generatedDraft?.openApiDetail?.spuName
    || payloadFound?.canonicalDraft?.openApiDetail?.spuName
    || payloadFound?.canonicalDraft?.product?.spu
    || '',
    160
  );
  if (!sourceStore || !spuName) {
    return {
      payload,
      applied: [],
      warnings: [],
      evidence: {status: 'skipped_missing_source_store_or_spu', sourceStore, sourceSkc, spuName},
      call: null,
    };
  }
  const existingLanguages = payloadNameLanguages(payload);
  if (existingLanguages.has('en') && existingLanguages.has('ar')) {
    return {
      payload,
      applied: [],
      warnings: [],
      evidence: {status: 'skipped_payload_already_has_en_ar', sourceStore, sourceSkc, spuName},
      call: null,
    };
  }
  const source = openApiClientForStore(config, sourceStore);
  if (!source?.client) {
    return {
      payload,
      applied: [],
      warnings: [`源店 ${sourceStore} 未配置可用 OpenAPI 只读凭据，无法现场补源链接多语言标题。`],
      evidence: {status: 'skipped_missing_source_openapi_credentials', sourceStore, sourceSkc, spuName},
      call: null,
    };
  }
  let response = null;
  try {
    response = await source.client.request('/open-api/goods/spu-info', {
      method: 'POST',
      body: {spuName, languageList: ['en', 'ar']},
      headers: {language: 'en'},
    });
  } catch (err) {
    return {
      payload,
      applied: [],
      warnings: [`现场读取源链接多语言标题失败：${sourceStore}/${spuName} ${safeString(err?.message || err, 300)}`],
      evidence: {status: 'query_failed', sourceStore, sourceSkc, spuName, error: safeString(err?.message || err, 300)},
      call: null,
    };
  }
  const call = compactCallResult('source-spu-info-live', '/open-api/goods/spu-info', 'POST', response);
  const evidence = {
    status: response.ok && String(response.data?.code) === '0' ? 'ok' : 'not_ok',
    sourceStore,
    sourceSkc,
    spuName,
    httpStatus: response.status,
    code: response.data?.code ?? null,
    msg: response.data?.msg ?? null,
  };
  if (!response.ok || String(response.data?.code) !== '0') {
    return {
      payload,
      applied: [],
      warnings: [`现场读取源链接多语言标题失败：code=${safeString(response.data?.code || '', 80)} msg=${safeString(response.data?.msg || response.statusText || '', 300)}`],
      evidence,
      call,
    };
  }
  const names = namesFromOpenApiSpuInfo(response.data?.info || {}, sourceSkc);
  evidence.languages = names.map(row => row.language);
  const merged = mergePayloadNames(payload, names);
  if (!merged.applied.length) {
    return {
      payload,
      applied: [],
      warnings: [],
      evidence: {...evidence, status: 'ok_no_new_names'},
      call,
    };
  }
  return {
    payload: merged.payload,
    applied: merged.applied,
    warnings: [],
    evidence,
    call,
  };
}

function payloadCategoryId(payload) {
  const id = normalizeAttributeId(payload?.category_id ?? payload?.categoryId);
  return id || null;
}

function titleMaxLengthMap(info) {
  const out = new Map();
  for (const row of asArray(info?.language_title_max_length_list || info?.languageTitleMaxLengthList)) {
    const language = safeString(row?.language || row?.lang || '', 40).toLowerCase();
    const max = Number(row?.max_length ?? row?.maxLength);
    if (language && Number.isFinite(max) && max > 0) out.set(language, Math.trunc(max));
  }
  const defaultLanguage = safeString(info?.default_language || info?.defaultLanguage || '', 40).toLowerCase();
  const defaultMax = Number(info?.default_language_title_max_length ?? info?.defaultLanguageTitleMaxLength);
  if (defaultLanguage && Number.isFinite(defaultMax) && defaultMax > 0 && !out.has(defaultLanguage)) out.set(defaultLanguage, Math.trunc(defaultMax));
  return out;
}

async function applyPublishFillInStandardRules(client, payload) {
  const categoryId = payloadCategoryId(payload);
  if (!categoryId) return {payload, applied: [], warnings: [], blockers: [], evidence: {status: 'skipped_missing_category_id'}, call: null};
  let response = null;
  try {
    response = await client.request('/open-api/goods/query-publish-fill-in-standard', {
      method: 'POST',
      body: {category_id: categoryId},
      headers: {language: 'en'},
    });
  } catch (err) {
    return {
      payload,
      applied: [],
      warnings: [`查询商品发布字段规范失败：${safeString(err?.message || err, 300)}`],
      blockers: [],
      evidence: {status: 'query_failed', categoryId, error: safeString(err?.message || err, 300)},
      call: null,
    };
  }
  const call = compactCallResult('query-publish-fill-in-standard', '/open-api/goods/query-publish-fill-in-standard', 'POST', response);
  const info = response.data?.info || {};
  const defaultLanguage = safeString(info.default_language || info.defaultLanguage || '', 40).toLowerCase();
  const maxByLanguage = titleMaxLengthMap(info);
  const evidence = {
    status: response.ok && String(response.data?.code) === '0' ? 'ok' : 'not_ok',
    categoryId,
    httpStatus: response.status,
    code: response.data?.code ?? null,
    msg: response.data?.msg ?? null,
    defaultLanguage,
    titleMaxLength: Object.fromEntries(maxByLanguage.entries()),
  };
  if (!response.ok || String(response.data?.code) !== '0') {
    return {
      payload,
      applied: [],
      warnings: [`查询商品发布字段规范失败：code=${safeString(response.data?.code || '', 80)} msg=${safeString(response.data?.msg || response.statusText || '', 300)}`],
      blockers: [],
      evidence,
      call,
    };
  }
  const next = jsonClone(payload || {});
  const names = asArray(next.multi_language_name_list || next.multiLanguageNameList)
    .filter(row => row && typeof row === 'object')
    .map(row => ({...row}));
  const applied = [];
  const blockers = [];
  for (const row of names) {
    const language = safeString(row.language || row.lang || row.languageCode || '', 40).toLowerCase();
    const max = maxByLanguage.get(language);
    const name = safeString(row.name || row.product_name || row.productName || row.value || '', 2000);
    if (max && name.length > max) {
      row.name = name.slice(0, max);
      applied.push(`multi_language_name_list.${language}.truncate_${max}`);
    }
  }
  if (defaultLanguage) {
    const hasDefaultTitle = names.some(row => {
      const language = safeString(row.language || row.lang || row.languageCode || '', 40).toLowerCase();
      return language === defaultLanguage && Boolean(safeString(row.name || row.product_name || row.productName || row.value || '', 2000));
    });
    if (!hasDefaultTitle) {
      blockers.push(`缺默认语种 ${defaultLanguage} 商品标题：请同步源链接 ${defaultLanguage} 标题，或在聊天里补充 ${defaultLanguage} 标题后再提交。`);
    }
  }
  next.multi_language_name_list = names;
  if (next.multiLanguageNameList) delete next.multiLanguageNameList;
  return {payload: next, applied: [...new Set(applied)], warnings: [], blockers, evidence, call};
}

function normalizeAttributeId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function collectPayloadSaleAttributeIds(payload) {
  const out = new Set();
  const add = row => {
    const id = normalizeAttributeId(row?.attribute_id ?? row?.attributeId);
    if (id) out.add(id);
  };
  for (const skc of asArray(payload?.skc_list || payload?.skcList)) {
    if (!skc || typeof skc !== 'object') continue;
    add(skc.sale_attribute || skc.saleAttribute);
    for (const row of asArray(skc.sale_attribute_list || skc.saleAttributeList)) add(row);
    for (const sku of asArray(skc.sku_list || skc.skuList)) {
      for (const row of asArray(sku?.sale_attribute_list || sku?.saleAttributeList)) add(row);
      for (const row of asArray(sku?.product_sku_attribute_list || sku?.productSkuAttributeList)) add(row);
    }
  }
  return out;
}

function normalizePublishProductAttributes(payload) {
  const applied = [];
  const saleAttributeIds = collectPayloadSaleAttributeIds(payload);
  const list = asArray(payload?.product_attribute_list || payload?.productAttributeList)
    .filter(row => row && typeof row === 'object')
    .map(row => ({...row}))
    .filter(row => {
      const id = normalizeAttributeId(row.attribute_id ?? row.attributeId);
      if (id && saleAttributeIds.has(id)) {
        applied.push('product_attribute_list.remove_sale_attribute');
        return false;
      }
      return true;
    });
  if (!list.length) {
    payload.product_attribute_list = list;
    if (payload.productAttributeList) delete payload.productAttributeList;
    return {applied: [...new Set(applied)]};
  }
  for (const row of list) {
    const extraValue = safeString(row.attribute_extra_value ?? row.attributeExtraValue ?? row.attribute_value ?? row.attributeValue ?? '', 500);
    if (extraValue && !row.attribute_extra_value) {
      row.attribute_extra_value = extraValue;
      applied.push('product_attribute_list.attribute_extra_value');
    }
    if (extraValue && (String(row.attribute_value_id ?? row.attributeValueId ?? '') === '0')) {
      delete row.attribute_value_id;
      delete row.attributeValueId;
      applied.push('product_attribute_list.remove_zero_attribute_value_id');
    }
    delete row.attribute_value;
    delete row.attributeValue;
    delete row.attributeExtraValue;
  }
  payload.product_attribute_list = list;
  if (payload.productAttributeList) delete payload.productAttributeList;
  return {applied: [...new Set(applied)]};
}

function normalizeInputCurrentExtraValue(value, unit = '') {
  const text = safeString(value, 120);
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return text;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) return text;
  const unitText = `${unit || text}`.toLowerCase();
  const milliamps = /(^|[^m])a\b|安/.test(unitText) && !/ma|毫安/.test(unitText)
    ? Math.round(numeric * 1000)
    : Math.round(numeric);
  return String(milliamps);
}

function normalizeManualAttributeOverride(row) {
  if (!row || typeof row !== 'object') return null;
  const attributeId = normalizeAttributeId(row.attribute_id ?? row.attributeId ?? row.id);
  const rawUnit = safeString(row.attribute_unit ?? row.attributeUnit ?? row.unit ?? '', 40);
  let attributeExtraValue = safeString(
    row.attribute_extra_value
    ?? row.attributeExtraValue
    ?? row.attribute_value
    ?? row.attributeValue
    ?? row.value
    ?? '',
    500
  );
  let attributeUnit = rawUnit;
  if (attributeId === 1002323) {
    attributeExtraValue = normalizeInputCurrentExtraValue(attributeExtraValue, row.attribute_unit || row.attributeUnit || '');
    attributeUnit = 'mA';
  }
  if (!attributeId || !attributeExtraValue) return null;
  return {
    attribute_id: attributeId,
    attribute_extra_value: attributeExtraValue,
    attribute_unit: attributeUnit,
    label: safeString(row.label || '', 80),
    source: safeString(row.source || 'manual_override', 80),
  };
}

function collectManualAttributeOverrides(task, executionContext) {
  const rows = [
    ...asArray(task?.targets?.attributeOverrides || task?.targets?.attribute_overrides),
    ...asArray(task?.manualAttributeOverrides || task?.manual_attribute_overrides),
    ...asArray(task?.attributeOverrides || task?.attribute_overrides),
    ...asArray(executionContext?.attributeOverrides || executionContext?.attribute_overrides),
    ...asArray(executionContext?.targets?.attributeOverrides || executionContext?.targets?.attribute_overrides),
  ].map(normalizeManualAttributeOverride).filter(Boolean);
  if (isKnownSm505SewingMachineTask(task, executionContext) && !rows.some(row => Number(row.attribute_id) === 1002323)) {
    rows.push({
      attribute_id: 1002323,
      attribute_extra_value: '1200',
      attribute_unit: 'mA',
      label: '输入电流',
      source: 'known_sm505_user_rule',
    });
  }
  const byId = new Map();
  for (const row of rows) byId.set(row.attribute_id, row);
  return [...byId.values()];
}

function applyManualAttributeOverrides(payload, task, executionContext) {
  const overrides = collectManualAttributeOverrides(task, executionContext);
  if (!overrides.length) return {payload, applied: [], overrides: []};
  const next = jsonClone(payload || {});
  const list = asArray(next.product_attribute_list || next.productAttributeList)
    .filter(row => row && typeof row === 'object')
    .map(row => ({...row}));
  const applied = [];
  for (const override of overrides) {
    const existing = list.find(row => normalizeAttributeId(row.attribute_id ?? row.attributeId) === override.attribute_id);
    const row = existing || {attribute_id: override.attribute_id};
    row.attribute_id = override.attribute_id;
    row.attribute_extra_value = override.attribute_extra_value;
    if (override.attribute_unit) row.__manual_attribute_unit = override.attribute_unit;
    delete row.attribute_value_id;
    delete row.attributeValueId;
    delete row.attribute_value;
    delete row.attributeValue;
    if (!existing) list.push(row);
    applied.push(`${override.label || override.attribute_id}=${override.attribute_extra_value}`);
  }
  next.product_attribute_list = list;
  if (next.productAttributeList) delete next.productAttributeList;
  return {payload: next, applied, overrides};
}

function payloadProductTypeId(payload) {
  const id = normalizeAttributeId(payload?.product_type_id ?? payload?.productTypeId);
  return id || null;
}

function normalizeTemplateAttributeRows(data) {
  const out = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const attributeId = normalizeAttributeId(node.attribute_id ?? node.attributeId);
    if (attributeId && (node.attribute_mode !== undefined || node.attributeMode !== undefined || node.attribute_value_info_list || node.attributeValueInfoList)) {
      out.push({
        attribute_id: attributeId,
        attribute_name: safeString(node.attribute_name ?? node.attributeName ?? node.attribute_name_en ?? node.attributeNameEn ?? '', 160),
        attribute_mode: Number(node.attribute_mode ?? node.attributeMode),
        attribute_type: Number(node.attribute_type ?? node.attributeType),
        attribute_status: Number(node.attribute_status ?? node.attributeStatus),
        attribute_value_info_list: asArray(node.attribute_value_info_list || node.attributeValueInfoList).map(value => ({
          attribute_value_id: normalizeAttributeId(value?.attribute_value_id ?? value?.attributeValueId),
          attribute_value: safeString(value?.attribute_value ?? value?.attributeValue ?? value?.attribute_value_en ?? value?.attributeValueEn ?? '', 120),
          is_custom_attribute_value: Boolean(value?.is_custom_attribute_value ?? value?.isCustomAttributeValue),
        })).filter(value => value.attribute_value_id || value.attribute_value),
      });
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value);
    }
  }
  visit(data?.info || data);
  const byId = new Map();
  for (const row of out) if (!byId.has(row.attribute_id)) byId.set(row.attribute_id, row);
  return [...byId.values()];
}

function chooseAttributeValueIdForManualUnit(templateRow, row) {
  const unit = safeString(row.__manual_attribute_unit || row.attribute_unit || row.attributeUnit || '', 40).toLowerCase();
  if (!unit) return null;
  const normalizedUnit = unit.replace(/\s+/g, '');
  const values = asArray(templateRow?.attribute_value_info_list);
  const exact = values.find(value => safeString(value.attribute_value, 40).toLowerCase().replace(/\s+/g, '') === normalizedUnit);
  if (exact?.attribute_value_id) return exact.attribute_value_id;
  return null;
}

async function applyAttributeTemplateRules(client, payload) {
  const productTypeId = payloadProductTypeId(payload);
  if (!productTypeId) return {payload, applied: [], warnings: [], blockers: [], evidence: {status: 'skipped_missing_product_type_id'}, call: null};
  let response = null;
  try {
    response = await client.request('/open-api/goods/query-attribute-template', {
      method: 'POST',
      body: {product_type_id_list: [productTypeId]},
      headers: {language: 'en'},
    });
  } catch (err) {
    return {
      payload,
      applied: [],
      warnings: [`查询商品属性模板失败：${safeString(err?.message || err, 300)}`],
      blockers: [],
      evidence: {status: 'query_failed', productTypeId, error: safeString(err?.message || err, 300)},
      call: null,
    };
  }
  const call = compactCallResult('query-attribute-template', '/open-api/goods/query-attribute-template', 'POST', response);
  const evidence = {
    status: response.ok && String(response.data?.code) === '0' ? 'ok' : 'not_ok',
    productTypeId,
    httpStatus: response.status,
    code: response.data?.code ?? null,
    msg: response.data?.msg ?? null,
  };
  if (!response.ok || String(response.data?.code) !== '0') {
    return {
      payload,
      applied: [],
      warnings: [`查询商品属性模板失败：code=${safeString(response.data?.code || '', 80)} msg=${safeString(response.data?.msg || response.statusText || '', 300)}`],
      blockers: [],
      evidence,
      call,
    };
  }
  const templates = normalizeTemplateAttributeRows(response.data);
  const byId = new Map(templates.map(row => [row.attribute_id, row]));
  const next = jsonClone(payload || {});
  const list = asArray(next.product_attribute_list || next.productAttributeList)
    .filter(row => row && typeof row === 'object')
    .map(row => ({...row}));
  const applied = [];
  const blockers = [];
  const warnings = [];
  for (const row of list) {
    const attributeId = normalizeAttributeId(row.attribute_id ?? row.attributeId);
    const template = attributeId ? byId.get(attributeId) : null;
    const mode = Number(template?.attribute_mode);
    const hasExtra = Boolean(safeString(row.attribute_extra_value ?? row.attributeExtraValue ?? '', 500));
    const valueId = normalizeAttributeId(row.attribute_value_id ?? row.attributeValueId);
    if (template && hasExtra && mode === 4 && !valueId) {
      const resolvedValueId = chooseAttributeValueIdForManualUnit(template, row);
      if (resolvedValueId) {
        row.attribute_value_id = resolvedValueId;
        applied.push(`attribute_template:${attributeId}.attribute_value_id=${resolvedValueId}`);
      } else {
        blockers.push(`${template.attribute_name || attributeId} 是“下拉+手动输入”属性，已填写 ${row.attribute_extra_value}，但未能从官方属性模板匹配单位/属性值 ID。`);
      }
    }
    delete row.__manual_attribute_unit;
    delete row.attribute_unit;
    delete row.attributeUnit;
    delete row.attributeExtraValue;
    delete row.attributeValueId;
    delete row.attributeValue;
    if (hasExtra && mode === 0) {
      delete row.attribute_value_id;
      applied.push(`attribute_template:${attributeId}.manual_input_no_value_id`);
    }
  }
  next.product_attribute_list = list;
  if (next.productAttributeList) delete next.productAttributeList;
  return {
    payload: next,
    applied: [...new Set(applied)],
    warnings: [...new Set(warnings)],
    blockers: [...new Set(blockers)],
    evidence: {
      ...evidence,
      attributeCount: templates.length,
      enrichedAttributeIds: applied.map(item => item.split(':')[1]?.split('.')[0]).filter(Boolean),
    },
    call,
  };
}

function normalizePublishImageType(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const text = String(value).trim().toUpperCase();
  if (text === 'MAIN') return 1;
  if (text === 'DETAIL') return 2;
  if (text === 'SQUARE') return 5;
  if (text === 'COLOR' || text === 'COLOR_BLOCK' || text === 'SWATCH') return 6;
  return null;
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
  const siteList = arr('site_list', 'siteList');
  if (!siteList.length) {
    blockers.push('缺 site_list：沙特站应包含 shein / shein-sa。');
  } else if (!siteList.some(site => {
    const mainSite = String(site?.main_site ?? site?.mainSite ?? '').toLowerCase();
    const subSites = asArray(site?.sub_site_list || site?.subSiteList).map(v => String(v).toLowerCase());
    return mainSite === 'shein' && subSites.includes('shein-sa');
  })) {
    blockers.push('发布站点未包含 shein-sa：草稿/发布前必须勾选 SHEIN 沙特站。');
  }
  const skcList = arr('skc_list', 'skcList');
  if (!skcList.length) blockers.push('缺 skc_list：需要 SKC 图片、销售属性和 SKU 列表。');
  for (const [i, skc] of skcList.entries()) {
    const prefix = `skc_list[${i}]`;
    const imageInfo = skc?.image_info || skc?.imageInfo || {};
    const imageList = asArray(imageInfo?.image_info_list || imageInfo?.imageInfoList);
    if (!imageList.length) blockers.push(`${prefix} 缺 image_info.image_info_list：需要主图/详情图素材或源商品图片映射。`);
    let mainImageCount = 0;
    for (const [j, image] of imageList.entries()) {
      const imagePrefix = `${prefix}.image_info.image_info_list[${j}]`;
      const imageType = normalizePublishImageType(image?.image_type ?? image?.imageType);
      if (imageType === null) {
        blockers.push(`${imagePrefix} 缺 image_type：publishOrEdit 的 SKC 图必须标明 1主图/2细节图/5方块图/6色块图。`);
      } else if (!ALLOWED_SKC_IMAGE_TYPES.has(imageType)) {
        blockers.push(`${imagePrefix} image_type=${imageType} 非法：SKC 图只允许 ${[...SKC_IMAGE_TYPE_LABELS].map(([value, label]) => `${value}${label}`).join('/')}。`);
      } else if (imageType === 1) {
        mainImageCount += 1;
        const imageSort = Number(image?.image_sort ?? image?.imageSort);
        if (imageSort !== 1) blockers.push(`${imagePrefix} 主图 image_type=1 时 image_sort 必须为 1。`);
      }
      if (!image?.image_url && !image?.imageUrl) blockers.push(`${imagePrefix} 缺 image_url。`);
    }
    if (imageList.length && mainImageCount !== 1) blockers.push(`${prefix} SKC 图必须且只能有 1 张主图 image_type=1，当前 ${mainImageCount} 张。`);
    const saleAttrValue = skc?.sale_attribute || skc?.saleAttribute;
    if (Array.isArray(saleAttrValue)) {
      blockers.push(`${prefix} sale_attribute 结构错误：SHEIN publishOrEdit 要求单个对象，不能传数组。`);
    }
    const saleAttrs = asArray(saleAttrValue);
    if (!saleAttrs.length) blockers.push(`${prefix} 缺 sale_attribute：需要颜色/规格等销售属性。`);
    const skuList = asArray(skc?.sku_list || skc?.skuList);
    if (!skuList.length) blockers.push(`${prefix} 缺 sku_list：需要 SKU 规格、成本、库存、尺寸重量。`);
    for (const [j, sku] of skuList.entries()) {
      const skuPrefix = `${prefix}.sku_list[${j}]`;
      for (const key of ['height', 'length', 'width', 'weight']) {
        if (sku?.[key] === undefined || sku?.[key] === null || sku?.[key] === '') blockers.push(`${skuPrefix} 缺 ${key}。`);
      }
      if (!sku?.mall_state && !sku?.mallState) blockers.push(`${skuPrefix} 缺 mall_state。`);
      if (!sku?.supplier_sku && !sku?.supplierSku) warnings.push(`${skuPrefix} 缺 supplier_sku：不使用平台 sku_code 冒充；若 SHEIN 发布接口强制要求，再按规则或人工补。`);
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

function publishInfoHasExplicitSuccess(info) {
  return Boolean(info && typeof info === 'object' && !Array.isArray(info) && Object.hasOwn(info, 'success'));
}

function publishResultSucceeded(result) {
  if (!result || String(result.code ?? '') !== '0') return false;
  if (publishInfoHasExplicitSuccess(result.info)) return result.info.success === true;
  return true;
}

function publishPreValidMessages(info) {
  const rows = asArray(info?.pre_valid_result || info?.preValidResult);
  const messages = [];
  for (const row of rows) {
    const label = safeString(row?.form_name || row?.form || row?.module || '平台预校验', 80);
    for (const msg of asArray(row?.messages || row?.message)) {
      const text = safeString(msg, 300);
      if (text) messages.push(`${label}：${text}`);
    }
  }
  if (!messages.length && publishInfoHasExplicitSuccess(info) && info.success === false) {
    messages.push('平台返回 success=false，但未返回具体预校验明细。');
  }
  return [...new Set(messages)];
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

function openApiProductRows(data) {
  return asArray(data?.info?.data || data?.info?.list || data?.data);
}

function openApiSearchProductRows(data) {
  return asArray(
    data?.info?.data ||
    data?.info?.list ||
    data?.info?.records ||
    data?.info?.rows ||
    data?.data,
  );
}

function rowTextForReadback(row) {
  const parts = [];
  const queue = [row];
  const seen = new Set();
  while (queue.length && parts.length < 240) {
    const cur = queue.shift();
    if (cur === null || cur === undefined) continue;
    if (typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean') {
      const text = safeString(cur, 500);
      if (text) parts.push(text);
      continue;
    }
    if (typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    for (const value of Object.values(cur)) {
      if (Array.isArray(value)) queue.push(...value.slice(0, 60));
      else if (value && typeof value === 'object') queue.push(value);
      else {
        const text = safeString(value, 500);
        if (text) parts.push(text);
      }
    }
  }
  return compactRef(parts.join(' '));
}

function compactProductReadbackRow(row) {
  return {
    spuName: safeString(row?.spuName || row?.spu_name || row?.spu || row?.productCode || '', 120),
    skcName: safeString(row?.skcName || row?.skc_name || row?.skc || '', 120),
    supplierCode: safeString(row?.supplierCode || row?.supplier_code || '', 120),
    skuCodeList: asArray(row?.skuCodeList || row?.sku_code_list || row?.skuCodes).map(x => safeString(x, 80)).filter(Boolean).slice(0, 20),
    productName: safeString(row?.productName || row?.product_name || row?.productNameEn || row?.productNameAr || '', 240),
    rawKeys: Object.keys(row || {}).slice(0, 40),
  };
}

function matchProductReadbackRows(rows, fingerprint) {
  const supplierSkus = asArray(fingerprint?.targetSupplierSkus).map(compactRef).filter(Boolean);
  const supplierCodes = asArray(fingerprint?.targetSupplierCodes).map(compactRef).filter(Boolean);
  const platformSkuCodes = asArray(fingerprint?.targetPlatformSkuCodes).map(compactRef).filter(Boolean);
  const platformSkcNames = asArray(fingerprint?.targetPlatformSkcNames).map(compactRef).filter(Boolean);
  const publishSpuNames = asArray(fingerprint?.publishSpuNames).map(compactRef).filter(Boolean);
  const publishSkcNames = asArray(fingerprint?.publishSkcNames).map(compactRef).filter(Boolean);
  const publishSkuCodes = asArray(fingerprint?.publishSkuCodes).map(compactRef).filter(Boolean);
  const productRefs = asArray(fingerprint?.taskProductRefs).map(compactRef).filter(Boolean);
  const sourceSkc = compactRef(fingerprint?.inferredSourceSkc || '');
  const matches = [];
  const weakMatches = [];
  for (const row of rows) {
    const hay = rowTextForReadback(row);
    const strongReasons = [];
    const weakReasons = [];
    for (const sku of supplierSkus) {
      if (sku && hay.includes(sku)) strongReasons.push(`supplierSku:${sku}`);
    }
    for (const code of supplierCodes) {
      if (code && hay.includes(code)) strongReasons.push(`supplierCode:${code}`);
    }
    for (const spuName of publishSpuNames) {
      if (spuName && hay.includes(spuName)) strongReasons.push(`publishSpuName:${spuName}`);
    }
    for (const skcName of publishSkcNames) {
      if (skcName && hay.includes(skcName)) strongReasons.push(`publishSkcName:${skcName}`);
    }
    for (const skuCode of publishSkuCodes) {
      if (skuCode && hay.includes(skuCode)) strongReasons.push(`publishSkuCode:${skuCode}`);
    }
    for (const code of platformSkuCodes) {
      if (code && hay.includes(code)) weakReasons.push(`platformSkuCode:${code}`);
    }
    for (const skcName of platformSkcNames) {
      if (skcName && hay.includes(skcName)) weakReasons.push(`platformSkcName:${skcName}`);
    }
    for (const ref of productRefs) {
      if (ref && hay.includes(ref)) weakReasons.push(`productRef:${ref}`);
    }
    if (sourceSkc && hay.includes(sourceSkc)) weakReasons.push(`sourceSkc:${sourceSkc}`);
    if (!strongReasons.length && !weakReasons.length) continue;
    const compact = {
      ...compactProductReadbackRow(row),
      matchReasons: [...new Set([...strongReasons, ...weakReasons])].slice(0, 12),
      strongMatchReasons: [...new Set(strongReasons)].slice(0, 12),
      weakMatchReasons: [...new Set(weakReasons)].slice(0, 12),
      reliableForSubmittedReadback: strongReasons.length > 0,
    };
    if (strongReasons.length) matches.push(compact);
    else weakMatches.push(compact);
    if (matches.length >= 20) break;
  }
  return {
    strong: matches,
    weak: weakMatches.slice(0, 20),
  };
}

async function readbackPublishedProduct(client, fingerprint, {enabled = false} = {}) {
  const startedAt = new Date().toISOString();
  const calls = [];
  const targetSupplierSkus = asArray(fingerprint?.targetSupplierSkus).filter(Boolean);
  const targetSupplierCodes = asArray(fingerprint?.targetSupplierCodes).filter(Boolean);
  const targetPlatformSkuCodes = asArray(fingerprint?.targetPlatformSkuCodes).filter(Boolean);
  const targetPlatformSkcNames = asArray(fingerprint?.targetPlatformSkcNames).filter(Boolean);
  const publishSpuNames = asArray(fingerprint?.publishSpuNames).filter(Boolean);
  const publishSkcNames = asArray(fingerprint?.publishSkcNames).filter(Boolean);
  const publishSkuCodes = asArray(fingerprint?.publishSkuCodes).filter(Boolean);
  const taskProductRefs = asArray(fingerprint?.taskProductRefs).filter(Boolean);
  const pageSize = Math.max(1, Math.min(100, Number(process.env.SHEIN_LINK_OPS_READBACK_PAGE_SIZE || 100)));
  const maxPages = Math.max(1, Math.min(20, Number(process.env.SHEIN_LINK_OPS_READBACK_MAX_PAGES || 5)));
  const queryHints = [...new Set([
    ...publishSpuNames,
    ...publishSkcNames,
    ...publishSkuCodes,
    ...targetSupplierSkus,
    ...targetSupplierCodes,
    ...targetPlatformSkuCodes,
    ...targetPlatformSkcNames,
    fingerprint?.inferredSourceSkc,
    ...taskProductRefs,
  ].map(x => safeString(x, 120)).filter(Boolean))].slice(0, 20);
  const plan = {
    endpoints: [
      '/open-api/goods/spu-info',
      '/open-api/goods/searchProduct',
      '/open-api/openapi-business-backend/product/query',
    ],
    endpoint: '/open-api/openapi-business-backend/product/query',
    method: 'POST',
    pageSize,
    maxPages,
    queryHints,
    targetSupplierSkuCount: targetSupplierSkus.length,
    targetSupplierCodeCount: targetSupplierCodes.length,
    publishSpuNameCount: publishSpuNames.length,
    publishSkcNameCount: publishSkcNames.length,
    publishSkuCodeCount: publishSkuCodes.length,
    targetPlatformSkuCodeCount: targetPlatformSkuCodes.length,
    targetPlatformSkcNameCount: targetPlatformSkcNames.length,
    reliableMatchRequires: 'publishOrEdit 返回的 SPU/SKC/SKU 或目标商家 SKU/商家货号命中；源 SKC、货号文本只作弱证据。',
  };
  if (!enabled) {
    return {
      ok: false,
      status: 'planned_not_run',
      startedAt,
      endedAt: new Date().toISOString(),
      plan,
      calls,
      matchedRows: [],
      note: 'dry-run 或未提交成功时只生成回读计划，不调用商品查询回读。',
    };
  }
  if (!targetSupplierSkus.length && !targetSupplierCodes.length && !publishSpuNames.length && !publishSkcNames.length && !publishSkuCodes.length) {
    return {
      ok: false,
      status: 'insufficient_strong_fingerprint',
      startedAt,
      endedAt: new Date().toISOString(),
      plan,
      calls,
      matchedRows: [],
      weakMatchedRows: [],
      note: '提交成功但缺少可可靠回读的 publishOrEdit 返回编号或目标商家 SKU / 商家货号；源 SKC 或货号文本不能单独证明新链接已生成，任务需要人工核销。',
    };
  }
  try {
    for (const spuName of publishSpuNames.slice(0, 5)) {
      const response = await client.request('/open-api/goods/spu-info', {
        method: 'POST',
        body: {spuName, languageList: ['en', 'ar']},
        headers: {language: 'en'},
      });
      calls.push(compactCallResult(`spu-info-readback-${spuName}`, '/open-api/goods/spu-info', 'POST', response));
      if (!response.ok || String(response.data?.code) !== '0') continue;
      const info = response.data?.info && typeof response.data.info === 'object' ? response.data.info : null;
      if (!info) continue;
      const matched = matchProductReadbackRows([info], fingerprint);
      if (matched.strong.length) {
        return {
          ok: true,
          status: 'matched_publish_spu_in_spu_info',
          startedAt,
          endedAt: new Date().toISOString(),
          plan,
          calls,
          scannedRows: 1,
          matchedRows: matched.strong,
          weakMatchedRows: matched.weak,
          note: '已用 publishOrEdit 返回的 SPU 编号调用官方 spu-info，并强匹配到平台返回的新 SPU/SKC/SKU；该证据可证明 SHEIN 已接收并生成商品记录，后续仍需结合审核状态判断是否已上架。',
        };
      }
    }
    const allWeakMatches = [];
    const searchProductAttempts = [
      ...publishSpuNames.slice(0, 10).map(spuName => ({
        name: `search-product-by-spu-${spuName}`,
        body: {pageNum: 1, pageSize: 10, spuNameList: [spuName], languageList: ['en', 'ar']},
      })),
      ...publishSkcNames.slice(0, 20).map(skcName => ({
        name: `search-product-by-skc-${skcName}`,
        body: {pageNum: 1, pageSize: 10, skcNameList: [skcName], languageList: ['en', 'ar']},
      })),
      ...publishSkuCodes.slice(0, 20).map(skuCode => ({
        name: `search-product-by-sku-${skuCode}`,
        body: {pageNum: 1, pageSize: 10, skuCodeList: [skuCode], languageList: ['en', 'ar']},
      })),
      ...targetSupplierCodes.slice(0, 20).map(code => ({
        name: `search-product-by-supplier-code-${code}`,
        body: {pageNum: 1, pageSize: 10, skcSupplierCodeList: [code], languageList: ['en', 'ar']},
      })),
      ...targetSupplierSkus.slice(0, 20).map(sku => ({
        name: `search-product-by-supplier-sku-${sku}`,
        body: {pageNum: 1, pageSize: 10, supplierSkuList: [sku], languageList: ['en', 'ar']},
      })),
    ];
    const seenSearchBodies = new Set();
    for (const attempt of searchProductAttempts) {
      const key = JSON.stringify(attempt.body);
      if (seenSearchBodies.has(key)) continue;
      seenSearchBodies.add(key);
      const response = await client.request('/open-api/goods/searchProduct', {
        method: 'POST',
        body: attempt.body,
        headers: {language: 'en'},
      });
      calls.push(compactCallResult(attempt.name, '/open-api/goods/searchProduct', 'POST', response));
      if (!response.ok || String(response.data?.code) !== '0') continue;
      const rows = openApiSearchProductRows(response.data);
      const matched = matchProductReadbackRows(rows, fingerprint);
      allWeakMatches.push(...matched.weak);
      if (matched.strong.length) {
        return {
          ok: true,
          status: 'matched_publish_identifier_in_search_product',
          startedAt,
          endedAt: new Date().toISOString(),
          plan,
          calls,
          scannedRows: rows.length,
          matchedRows: matched.strong,
          weakMatchedRows: allWeakMatches.slice(0, 20),
          note: '已用 publishOrEdit 返回的 SPU/SKC/SKU 或目标商家编号调用官方 searchProduct，并强匹配到新商品记录；该证据可证明 SHEIN 已接收并可被官方商品综合查询命中，后续仍需结合审核/上架状态判断是否已前台可售。',
        };
      }
    }
    let scannedRows = 0;
    let lastRowsCount = 0;
    for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
      const response = await client.request('/open-api/openapi-business-backend/product/query', {
        method: 'POST',
        body: {pageNum, pageSize},
        headers: {language: 'en'},
      });
      calls.push(compactCallResult(`product-query-readback-page-${pageNum}`, '/open-api/openapi-business-backend/product/query', 'POST', response));
      if (!response.ok || String(response.data?.code) !== '0') {
        return {
          ok: false,
          status: 'query_failed',
          startedAt,
          endedAt: new Date().toISOString(),
          plan,
          calls,
          scannedRows,
          matchedRows: [],
          weakMatchedRows: allWeakMatches.slice(0, 20),
          error: safeString(response.data?.msg || response.statusText || response.text || 'product query failed', 500),
        };
      }
      const rows = openApiProductRows(response.data);
      lastRowsCount = rows.length;
      scannedRows += rows.length;
      const matched = matchProductReadbackRows(rows, fingerprint);
      allWeakMatches.push(...matched.weak);
      if (matched.strong.length) {
        return {
          ok: true,
          status: 'matched_strong_fingerprint_in_product_query',
          startedAt,
          endedAt: new Date().toISOString(),
          plan,
          calls,
          scannedRows,
          matchedRows: matched.strong,
          weakMatchedRows: allWeakMatches.slice(0, 20),
          note: '已在 OpenAPI 商品列表回读中找到目标商家 SKU / 商家货号强指纹匹配的商品行；仍需结合 SHEIN 审核状态判断最终上架结果。',
        };
      }
      if (!rows.length || rows.length < pageSize) break;
    }
    return {
      ok: false,
      status: allWeakMatches.length ? 'weak_match_only' : 'not_found_in_scanned_pages',
      startedAt,
      endedAt: new Date().toISOString(),
      plan,
      calls,
      scannedRows,
      lastRowsCount,
      matchedRows: [],
      weakMatchedRows: allWeakMatches.slice(0, 20),
      note: allWeakMatches.length
        ? '只找到平台 SKU、源 SKC 或货号文本等弱证据；不能单独证明新链接已生成，任务保持锁定并需人工核销。'
        : '已按分页扫描商品列表但未找到目标商家 SKU / 商家货号强指纹；可能仍在异步审核/列表延迟，也可能需要更精确的审核/详情回读接口。',
    };
  } catch (err) {
    return {
      ok: false,
      status: 'readback_error',
      startedAt,
      endedAt: new Date().toISOString(),
      plan,
      calls,
      matchedRows: [],
      weakMatchedRows: [],
      error: safeString(err?.message || err, 800),
    };
  }
}

function extractReadbackFingerprint({payload, payloadFound, targetStore, task, publishResult}) {
  const skcList = asArray(payload?.skc_list || payload?.skcList);
  const skuRows = skcList.flatMap(skc => asArray(skc?.sku_list || skc?.skuList));
  const publishInfo = publishResult?.info && typeof publishResult.info === 'object' ? publishResult.info : {};
  const publishSkcRows = asArray(publishInfo?.skc_list || publishInfo?.skcList);
  const publishSkuRows = publishSkcRows.flatMap(skc => asArray(skc?.sku_list || skc?.skuList));
  const publishSpuNames = [...new Set([
    safeString(publishInfo?.spu_name ?? publishInfo?.spuName, 120),
  ].filter(Boolean))].slice(0, 20);
  const publishSkcNames = [...new Set(publishSkcRows
    .map(skc => safeString(skc?.skc_name ?? skc?.skcName, 120))
    .filter(Boolean))]
    .slice(0, 40);
  const publishSkuCodes = [...new Set(publishSkuRows
    .map(sku => safeString(sku?.sku_code ?? sku?.skuCode, 120))
    .filter(Boolean))]
    .slice(0, 80);
  const targetSupplierSkus = [...new Set(skuRows
    .map(sku => safeString(sku?.supplier_sku ?? sku?.supplierSku, 120))
    .filter(Boolean))]
    .slice(0, 80);
  const targetPlatformSkuCodes = [...new Set(skuRows
    .map(sku => safeString(sku?.sku_code ?? sku?.skuCode, 120))
    .filter(Boolean))]
    .slice(0, 80);
  const targetSupplierCodes = [...new Set(skcList
    .map(skc => safeString(skc?.supplier_code ?? skc?.supplierCode, 120))
    .filter(Boolean))]
    .slice(0, 20);
  const targetPlatformSkcNames = [...new Set(skcList
    .map(skc => safeString(skc?.skc_name ?? skc?.skcName, 120))
    .filter(Boolean))]
    .slice(0, 20);
  const inferred = payloadFound?.inferred || {};
  const generatedDraft = payloadFound?.generatedDraft || {};
  return {
    targetStore,
    taskId: task?.id || '',
    taskProductRefs: taskProductRefs(task),
    inferredSourceStore: normalizeStoreKey(inferred.sourceStore || generatedDraft.sourceStore || task?.sourceStore || ''),
    inferredSourceSkc: safeString(inferred.sourceSkc || generatedDraft.sourceSkc || task?.sourceSkc || task?.skc || '', 120),
    categoryId: payload?.category_id ?? payload?.categoryId ?? null,
    productTypeId: payload?.product_type_id ?? payload?.productTypeId ?? null,
    publishSpuNames,
    publishSpuNameCount: publishSpuNames.length,
    publishSkcNames,
    publishSkcNameCount: publishSkcNames.length,
    publishSkuCodes,
    publishSkuCodeCount: publishSkuCodes.length,
    targetSupplierCodes,
    targetSupplierSkus,
    targetSupplierSkuCount: targetSupplierSkus.length,
    targetPlatformSkuCodes,
    targetPlatformSkuCodeCount: targetPlatformSkuCodes.length,
    targetPlatformSkcNames,
    targetPlatformSkcNameCount: targetPlatformSkcNames.length,
    publishTraceId: publishResult?.traceId || null,
    publishInfoPresent: publishResult?.info !== undefined && publishResult?.info !== null,
    readbackStatus: publishResult?.code === '0' ? 'submitted_pending_product_readback' : 'not_submitted_or_blocked',
    readbackHint: '回读优先用 targetStore + targetSupplierSkus/targetSupplierCodes + categoryId + publishTraceId 关联 SHEIN 商品列表、审核记录或任务回执。',
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
  const {source, task, executionContext} = await loadTask(args);
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
    warnings.push('任务 intent 未包含 copy_product_draft；本执行器只负责 OpenAPI 复制/补链发品路径。');
  }
  if (String(task?.status || '') !== 'confirmed' && String(task?.status || '') !== 'in_progress' && String(task?.status || '') !== 'waiting_review') {
    blockers.push('任务尚未确认成任务，不能进入 SHEIN 写执行。');
  }

  const {config, store, client} = await loadClient(args);
  const configuredStore = configuredStoreForIdentity(targetStore);
  if (!configuredStore) {
    blockers.push(`config/stores.json 中不存在目标店铺 ${targetStore}，不能执行 OpenAPI 写入。`);
  }
  const calls = [];
  const storeInfo = await callOpenApi(client, {
    name: 'query-store-info',
    method: 'POST',
    path: '/open-api/openapi-business-backend/query-store-info',
    body: {},
  });
  calls.push(compactCallResult(storeInfo.name, storeInfo.path, storeInfo.method, {status: storeInfo.httpStatus, data: storeInfo.data}));
  const openapiIdentity = configuredStore ? validateStoreIdentity({
    store: configuredStore,
    truth: STORE_ACCOUNT_TRUTH.stores?.[targetStore],
    storageIdentity: openApiIdentityToStorageIdentity(storeInfo.data),
    href: 'openapi:/open-api/openapi-business-backend/query-store-info',
    context: 'link_ops_hl_openapi_executor',
  }) : {ok: false, reason: 'missing_configured_store'};
  const openapiIdentityAcceptedByMerchant = openApiStoreIdentityMatchesMerchant(openapiIdentity);
  evidence.storeIdentity = {
    ...openapiIdentity,
    ok: openapiIdentity.ok || openapiIdentityAcceptedByMerchant,
    acceptedByMerchantOnly: openapiIdentityAcceptedByMerchant && !openapiIdentity.ok,
  };
  if (!openapiIdentity.ok && !openapiIdentityAcceptedByMerchant) {
    blockers.push(formatStoreIdentityError(openapiIdentity));
  } else if (openapiIdentityAcceptedByMerchant) {
    warnings.push(`${targetStore} OpenAPI 店铺信息未返回 GS账号，但 merchantId=${openapiIdentity.expectedMerchantId} 已匹配；若后续接口返回冲突 GS账号仍会阻断。`);
  }
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
    blockers.push(`${targetStore} 店铺当前不可发品：${safeString(publishPermission.data?.msg || publishPermission.data?.info?.reason || '未知原因')}`);
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

  const payloadFound = await findOrBuildPublishPayload(task, {targetStore});
  let payloadSummary = null;
  let safeDefaults = [];
  let manualAttributeOverrides = [];
  let payloadValidation = {ok: false, blockers: ['未能自动生成 OpenAPI 发布 payload：系统已尝试从源店/源 SKC 的链接快照还原类目、属性、图片、SKU、供货价、库存和尺寸重量；请补充更明确的源店、源 SKC，或先同步该源链接详情。'], warnings: []};
  let publishPayload = null;
  let payloadHash = '';
  if (payloadFound?.payload) {
    appendUnique(warnings, payloadFound.mappingWarnings);
    const applied = applySafeDefaults(payloadFound.payload, {sites, brands, task, executionContext});
    const manualApplied = applyManualAttributeOverrides(applied.payload, task, executionContext);
    const liveSourceNames = await enrichPayloadNamesFromLiveSourceOpenApi(config, manualApplied.payload, payloadFound);
    if (liveSourceNames.call) calls.push(liveSourceNames.call);
    const publishStandardApplied = await applyPublishFillInStandardRules(client, liveSourceNames.payload);
    if (publishStandardApplied.call) calls.push(publishStandardApplied.call);
    const templateApplied = await applyAttributeTemplateRules(client, publishStandardApplied.payload);
    if (templateApplied.call) calls.push(templateApplied.call);
    publishPayload = templateApplied.payload;
    safeDefaults = [
      ...applied.applied,
      ...manualApplied.applied.map(x => `manual_attribute:${x}`),
      ...liveSourceNames.applied,
      ...publishStandardApplied.applied,
      ...templateApplied.applied,
    ];
    manualAttributeOverrides = manualApplied.overrides;
    evidence.sourceLiveSpuInfo = liveSourceNames.evidence;
    evidence.publishFillInStandard = publishStandardApplied.evidence;
    evidence.attributeTemplate = templateApplied.evidence;
    appendUnique(warnings, liveSourceNames.warnings);
    appendUnique(warnings, publishStandardApplied.warnings);
    appendUnique(blockers, publishStandardApplied.blockers);
    appendUnique(warnings, templateApplied.warnings);
    appendUnique(blockers, templateApplied.blockers);
    payloadValidation = validatePublishPayload(publishPayload);
    payloadSummary = extractPayloadSummary(publishPayload);
    payloadHash = sha256Stable(publishPayload);
    appendUnique(warnings, payloadValidation.warnings);
    appendUnique(blockers, payloadValidation.blockers);
  } else {
    appendUnique(blockers, payloadValidation.blockers);
    if (payloadFound?.generationError) appendUnique(warnings, `自动生成源商品草稿失败：${payloadFound.generationError}`);
  }

  if (productRefs.length && !payloadFound?.payload) {
    warnings.push(`已识别任务对象 ${productRefs.join('、')}，但当前 BI 数据不足以还原完整发布 payload；需要补充源店、源 SKC 或更完整商品详情。`);
  }

  if (args.mode === 'execute') {
    if (args.confirm !== SUBMIT_CONFIRM_TEXT) {
      blockers.push(`真实提交必须显式传入 --confirm ${SUBMIT_CONFIRM_TEXT}`);
    }
    const expectedHash = safeString(
      executionContext?.expectedPayloadHash
      || executionContext?.request?.expectedPayloadHash
      || executionContext?.request?.payloadHash
      || '',
      120,
    );
    if (!expectedHash) {
      blockers.push('真实提交缺少 dry-run 锁定的 payload hash，不能提交未经锁定的发布 payload。');
    } else if (!payloadHash || payloadHash !== expectedHash) {
      blockers.push(`真实提交 payload hash 与 dry-run 锁定值不一致：expected=${expectedHash || 'missing'} actual=${payloadHash || 'missing'}`);
    }
  }

  const readyForSubmit = blockers.length === 0 && Boolean(publishPayload);
  let publishResult = null;
  if (args.mode === 'execute' && readyForSubmit) {
    const response = await client.request('/open-api/goods/product/publishOrEdit', {
      method: 'POST',
      body: publishPayload,
      headers: {language: 'en'},
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
    } else if (!publishResultSucceeded(publishResult)) {
      const preValidMessages = publishPreValidMessages(publishResult.info);
      blockers.push(`publishOrEdit 平台预校验失败，未创建新链接：${preValidMessages.join('；') || safeString(publishResult.msg || '未知原因')}`);
    }
  }
  const publishSucceeded = publishResultSucceeded(publishResult);
  const publishPreValidFailed = Boolean(publishResult && String(publishResult.code ?? '') === '0' && !publishSucceeded);
  const readbackFingerprint = extractReadbackFingerprint({
    payload: publishPayload,
    payloadFound,
    targetStore,
    task,
    publishResult,
  });
  const readback = await readbackPublishedProduct(client, readbackFingerprint, {
    enabled: publishSucceeded,
  });
  readbackFingerprint.readbackStatus = readback.status;

  const state = args.mode === 'execute'
    ? (publishSucceeded ? 'submitted' : (publishPreValidFailed ? 'publish_pre_valid_failed' : 'blocked'))
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
    executorContext: executionContext ? {
      actor: executionContext.actor || null,
      requestMeta: executionContext.requestMeta || null,
      parentTaskId: executionContext.parentTaskId || task?.id || '',
      targetStores: executionContext.targetStores || [],
      productRefs: executionContext.productRefs || productRefs,
      attributeOverrides: executionContext.attributeOverrides || [],
      intents: executionContext.intents || intents,
      requestedMode: executionContext.requestedMode || args.mode,
      targetStore: executionContext.targetStore || targetStore,
      parentIssuedAt: executionContext.parentIssuedAt || '',
      issuedAt: executionContext.issuedAt || '',
    } : null,
    openapi: {
      baseUrl: client.baseUrl,
      openKeyId: mask(store.openKeyId),
      calls,
      canPublishProduct: canPublish,
      publishPermissionReason: evidence.publishPermissionReason,
      sites,
      brands,
      warehouses,
      storeIdentity: openapiIdentity,
    },
    evidence,
    payload: {
      found: Boolean(payloadFound?.payload),
      source: payloadFound?.source || null,
      assetId: payloadFound?.assetId || null,
      assetName: payloadFound?.assetName || null,
      safeDefaults,
      manualAttributeOverrides,
      payloadHash,
      payloadHashAlgorithm: payloadHash ? 'sha256-stable-json-v1' : '',
      summary: payloadSummary,
      validation: payloadValidation,
      generatedDraft: payloadFound?.generatedDraft || null,
      generationError: payloadFound?.generationError || null,
      inferredSource: payloadFound?.inferred || null,
    },
    readbackFingerprint,
    readback,
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
