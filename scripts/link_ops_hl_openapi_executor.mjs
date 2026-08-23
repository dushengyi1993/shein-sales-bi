#!/usr/bin/env node
/**
 * SHEIN OpenAPI product publish/copy executor.
 *
 * Daily local Windows/Codex usage must not call real SHEIN OpenAPI; run real
 * publishOrEdit only inside shein-bi-tencent/cloud runtime or fake tests.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';
import {
  buildProductDraftFromSnapshots,
  inferSourceProductFromTask,
  resolveLinkOpsOutputDir,
  summarizeDraftForExecutor,
} from '../lib/link_ops_product_draft_mapper.mjs';
import {
  formatStoreIdentityError,
  openApiIdentityToStorageIdentity,
  storeIdentityMatchesMerchantOnly,
  validateStoreIdentity,
} from '../lib/shein_store_identity.mjs';
import {buildProductDisplayName} from '../lib/product_display_name.mjs';
import {
  applyApprovedImageBindingsToPublishPayload,
  applyExplicitPublishPreparationOverrides,
  normalizeApprovedImageBindingProjection,
  normalizeApprovedImageBindings,
  normalizePublishPayloadImageProjection,
  normalizePublishPreparationOverrides,
  taskHasUnboundImageAssets,
} from '../lib/link_ops_publish_asset_binding.mjs';
import {evaluateAdditionalDuplicatePublishOverride} from '../lib/link_ops_duplicate_publish_override.mjs';
import {
  evaluateDescriptionReadback,
  describePublishPayloadDescription,
  stripPublishPayloadDescriptions,
  validateCopyProductDescriptionPolicy,
  validateEmptyDescriptionAuthorization,
  validatePublishPayloadDescription,
} from '../lib/link_ops_product_descriptions.mjs';
import {isSheinSkc, sameSheinSkc} from '../lib/shein_product_identifiers.mjs';
import {
  createLoopbackTestWebhookWriteGuard,
  runSheinWebhookExternalWriteGuarded,
} from '../lib/shein_webhook_external_write_guard.mjs';
import {INPUT_VOLTAGE_AC_VALUE_ID} from '../lib/retire_supplier_code_repair_payload.mjs';
import {
  buildProductAliasContext,
  resolveExplicitProductAlias,
} from '../lib/link_ops_product_attribute_binding.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_TASK_FILE = path.join(ROOT, 'state', 'bi_link_ops_tasks.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'logs', 'link-ops-openapi-executor');
const TARGET_STORE = 'HL';
const SUBMIT_CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const STORES = STORES_CONFIG.stores || [];
const STORE_ACCOUNT_TRUTH = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'store_account_truth.json'), 'utf8'));
const PRODUCT_ALIASES_BYTES = await fs.readFile(path.join(ROOT, 'config', 'product_aliases.json'));
const PRODUCT_CATALOG_BYTES = await fs.readFile(path.join(ROOT, 'config', 'product_catalog.json'));
const PRODUCT_ALIAS_REGISTRY_FINGERPRINT = crypto.createHash('sha256').update(PRODUCT_ALIASES_BYTES).digest('hex');
const PRODUCT_CATALOG_FINGERPRINT = crypto.createHash('sha256').update(PRODUCT_CATALOG_BYTES).digest('hex');
const PRODUCT_ALIAS_CONTEXT = buildProductAliasContext({
  aliasRegistryJson: JSON.parse(PRODUCT_ALIASES_BYTES.toString('utf8')),
  catalogJson: JSON.parse(PRODUCT_CATALOG_BYTES.toString('utf8')),
  aliasRegistryFingerprint: PRODUCT_ALIAS_REGISTRY_FINGERPRINT,
  catalogFingerprint: PRODUCT_CATALOG_FINGERPRINT,
  aliasRegistrySource: 'config/product_aliases.json',
  catalogSource: 'config/product_catalog.json',
});
const ALLOWED_SKC_IMAGE_TYPES = new Set([1, 2, 5, 6]);
const SKC_IMAGE_TYPE_LABELS = new Map([
  [1, '主图'],
  [2, '细节图'],
  [5, '方块图'],
  [6, '色块图'],
]);
const POWER_SUPPLY_ATTRIBUTE_ID = 147;
const POWER_SUPPLY_WALL_PLUG_VALUE_ID = 1047;
const POWER_SUPPLY_POWER_ADAPTER_VALUE_ID = 1007239;
const POWER_SUPPLY_INPUT_VOLTAGE_VALUE_IDS = new Set([
  POWER_SUPPLY_WALL_PLUG_VALUE_ID,
  POWER_SUPPLY_POWER_ADAPTER_VALUE_ID,
]);
const PRODUCT_MODEL_ATTRIBUTE_ID = 1000546;
const INPUT_VOLTAGE_ATTRIBUTE_ID = 1002322;
const INPUT_CURRENT_ATTRIBUTE_ID = 1002323;
const PLUG_VOLTAGE_ATTRIBUTE_ID = 1001466;
const RATED_VOLTAGE_ATTRIBUTE_ID = 1001370;
const VOLTAGE_ATTRIBUTE_ID = 1000101;
const VOLTAGE_VALUE_ATTRIBUTE_ID = 164;
const HAZARD_CATEGORY_ATTRIBUTE_ID = 1000462;
const HAZARD_CATEGORY_NON_TRANSPORT_SENSITIVE_VALUE_ID = 1006206;
const HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID = 1002328;
const INPUT_VOLTAGE_AC_UNIT_LABEL = 'Vac 50–60Hz';
const DEFAULT_AIR_FRYER_INPUT_CURRENT_MA = 6800;
const MAX_EXPLICIT_INPUT_CURRENT_MA = 100_000;
const EXPLICIT_PREPARE_PUBLISH_SOURCE = 'explicit_prepare_publish';

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
    claimNonce: '',
    quiet: false,
    payloadOut: '',
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
    else if (a === '--claim-nonce') args.claimNonce = String(argv[++i] || '').trim();
    else if (a === '--payload-out') args.payloadOut = path.resolve(argv[++i]);
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/link_ops_hl_openapi_executor.mjs --task-id <id> [--dry-run] [--store HL]
  node scripts/link_ops_hl_openapi_executor.mjs --task-json task.json --execute --confirm ${SUBMIT_CONFIRM_TEXT}

用途：
  SHEIN OpenAPI 商品写执行器。默认只做真实 OpenAPI 权限、站点、品牌、仓库和发布 payload 预检；
  只有显式 --execute 且带确认文本、payload 完整时，才调用 publishOrEdit。

Local boundary:
  不要在本地 Windows/Codex 机器真实执行；真实 publishOrEdit 必须走 shein-bi-tencent 云端执行器。`);
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

function lockedHopeOnSaleDate(executionContext = null) {
  const value = safeString(
    executionContext?.productDraftLock?.hopeOnSaleDate
    || executionContext?.productDraftLock?.hope_on_sale_date
    || '',
    80,
  );
  return /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(value) ? value : '';
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

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function firstOwnField(candidates = []) {
  for (const [owner, key] of candidates) {
    if (owner && typeof owner === 'object' && Object.prototype.hasOwnProperty.call(owner, key)) {
      return {present: true, value: owner[key]};
    }
  }
  return {present: false, value: ''};
}

function ownObjectField(owner, key) {
  if (!owner || typeof owner !== 'object' || !Object.prototype.hasOwnProperty.call(owner, key)) {
    return {present: false, valid: true, value: null};
  }
  const value = owner[key];
  return {
    present: true,
    valid: Boolean(value && typeof value === 'object' && !Array.isArray(value)),
    value,
  };
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

function taskStandardGoodsSn(task = null, executionContext = null) {
  const explicitRaw = firstNonEmpty(
    task?.standardGoodsSn,
    task?.standard_goods_sn,
    task?.targets?.standardGoodsSn,
    task?.targets?.standard_goods_sn,
    task?.metadata?.standardGoodsSn,
    task?.metadata?.standard_goods_sn,
    executionContext?.standardGoodsSn,
    executionContext?.standard_goods_sn,
    executionContext?.targets?.standardGoodsSn,
    executionContext?.targets?.standard_goods_sn,
  );
  if (explicitRaw !== '' && typeof explicitRaw !== 'string') return '';
  if (/[\u0000-\u001f\u007f]/u.test(String(explicitRaw ?? ''))) return '';
  const explicit = safeString(explicitRaw, 240);
  if (explicit) return buildProductDisplayName(explicit);
  for (const ref of taskProductRefs(task)) {
    const text = safeString(ref, 240);
    if (/\p{Script=Han}/u.test(text)) return buildProductDisplayName(text);
  }
  if (isKnownSm505SewingMachineTask(task, executionContext)) return buildProductDisplayName('SM-505A');
  for (const ref of taskProductRefs(task)) {
    const text = safeString(ref, 240).toUpperCase();
    const match = text.match(/\b([A-Z]{1,8}-?\d{2,}[A-Z]?)\b/);
    if (match) return buildProductDisplayName(match[1]);
  }
  return '';
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
    task?.targets?.sourceSkc,
    task?.targets?.source_skc,
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
  const outputDir = resolveLinkOpsOutputDir();
  for (const file of [
    path.join(outputDir, 'bi-portal', 'sections', 'linksData.json'),
    path.join(outputDir, 'bi-portal', 'data.json'),
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

function findPayloadInApprovedJsonEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (looksLikePublishPayload(value)) return value;
  const directKeys = ['openapiPublishPayload', 'sheinOpenapiPublishPayload', 'publishPayload', 'publishOrEditPayload'];
  const candidates = directKeys
    .filter(key => looksLikePublishPayload(value[key]))
    .map(key => value[key]);
  // Approved JSON assets may be the payload itself or one explicit root
  // wrapper. Never recursively promote payload-looking objects from
  // history/debug/log/result or any other nested path.
  return candidates.length === 1 ? candidates[0] : null;
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
    const bytes = await fs.readFile(stored);
    const actualAssetSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const declaredAssetSha256 = String(asset?.sha256 || '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(declaredAssetSha256) || declaredAssetSha256 !== actualAssetSha256) {
      throw new Error('JSON asset bytes no longer match the upload-time sha256');
    }
    const json = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    const payload = findPayloadInApprovedJsonEnvelope(json);
    if (!payload) return null;
    return {
      source: 'asset_json',
      assetId: asset.id || '',
      assetName: name,
      assetSha256: actualAssetSha256,
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
  const directKeys = ['openapiPublishPayload', 'sheinOpenapiPublishPayload', 'publishPayload', 'publishOrEditPayload'];
  for (const key of directKeys) {
    if (looksLikePublishPayload(task?.[key])) {
      return {source: `task.${key}`, payload: jsonClone(task[key])};
    }
  }
  for (const asset of asArray(task?.assets)) {
    const fromAsset = await tryReadJsonAsset(task, asset);
    if (fromAsset?.payload) return {...fromAsset, payload: jsonClone(fromAsset.payload)};
  }
  return null;
}

function exactCopySourceLock(task) {
  const intents = asArray(task?.intents).map(value => String(value || '').trim());
  if (!intents.includes('copy_product_draft')) return null;
  const sourceStores = task?.targets?.sourceStores;
  if (!Array.isArray(sourceStores) || sourceStores.length !== 1) return null;
  const sourceStore = normalizeStoreKey(sourceStores[0]);
  const sourceSkc = task?.targets?.sourceSkc;
  if (!sourceStore) return null;
  if (typeof sourceSkc !== 'string' || !/^s[avb]\d{8,}$/.test(sourceSkc)) return null;
  return {sourceStore, sourceSkc};
}

function exactSourcePayloadReadiness(generated, source) {
  const payload = generated?.openapiPublishPayloadDraft;
  const blockers = asArray(generated?.blockers).map(value => String(value || '').trim()).filter(Boolean);
  const detail = generated?.canonicalDraft?.openApiDetail;
  const skcList = asArray(payload?.skc_list || payload?.skcList);
  const matchingSourceSkcs = skcList.filter(row => String(row?.source_skc || row?.sourceSkc || row?.skc_name || row?.skcName || '') === source.sourceSkc);
  const sourceSkc = matchingSourceSkcs.length === 1 ? matchingSourceSkcs[0] : null;
  const skuList = asArray(sourceSkc?.sku_list || sourceSkc?.skuList);
  if (generated?.ok !== true) blockers.push('mapper did not return ok=true');
  if (generated?.readyForOpenApiSubmit !== true) blockers.push('mapper draft is not readyForOpenApiSubmit');
  if (!looksLikePublishPayload(payload)) blockers.push('mapper did not return a publish payload');
  if (!['openapi_product_detail_snapshot', 'openapi_product_detail_cached_fallback'].includes(detail?.source)) {
    blockers.push('fresh exact OpenAPI product detail source is missing');
  }
  if (matchingSourceSkcs.length !== 1) blockers.push(`generated payload must contain exactly one source_skc=${source.sourceSkc}; matched=${matchingSourceSkcs.length}`);
  if (sourceSkc && String(sourceSkc?.source_skc || sourceSkc?.sourceSkc || '') !== source.sourceSkc) {
    blockers.push(`generated payload source_skc drifted from locked sourceSkc=${source.sourceSkc}`);
  }
  if (generated?.sourceSkc !== source.sourceSkc) blockers.push(`mapper sourceSkc drifted from locked sourceSkc=${source.sourceSkc}`);
  if (detail?.sourceDetailLock?.sourceStore !== source.sourceStore || detail?.sourceDetailLock?.sourceSkc !== source.sourceSkc) {
    blockers.push('source detail lock identity does not match exact sourceStore/sourceSkc');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(detail?.sourceDetailHash || detail?.sourceDetailLock?.sourceDetailHash || ''))) {
    blockers.push('source detail canonical hash is missing');
  }
  if (!Number.isFinite(Number(payload?.category_id ?? payload?.categoryId)) || Number(payload?.category_id ?? payload?.categoryId) <= 0) {
    blockers.push('exact source detail is missing category_id');
  }
  if (!Number.isFinite(Number(payload?.product_type_id ?? payload?.productTypeId)) || Number(payload?.product_type_id ?? payload?.productTypeId) <= 0) {
    blockers.push('exact source detail is missing product_type_id');
  }
  if (!Array.isArray(payload?.product_attribute_list || payload?.productAttributeList) || !(payload.product_attribute_list || payload.productAttributeList).length) {
    blockers.push('exact source detail is missing product_attribute_list');
  }
  if (!sourceSkc || !skuList.length) blockers.push('exact source detail is missing an SKC/SKU payload');
  for (const [index, sku] of skuList.entries()) {
    for (const field of ['height', 'length', 'width', 'weight']) {
      if (!Number.isFinite(Number(sku?.[field])) || Number(sku[field]) <= 0) blockers.push(`exact source detail SKU[${index}] is missing ${field}`);
    }
    if (!sku?.cost_info && !sku?.costInfo) blockers.push(`exact source detail SKU[${index}] is missing cost_info`);
  }
  if (blockers.length) {
    return {
      ok: false,
      reason: `exact source ${source.sourceStore}/${source.sourceSkc} mapper draft is incomplete: ${blockers.slice(0, 8).join('；')}`,
    };
  }
  return {
    ok: true,
    payload,
    sourceDetailHash: generated.sourceDetailHash || detail.sourceDetailHash,
    sourceDetailLock: generated.sourceDetailLock || detail.sourceDetailLock,
  };
}

function normalizedTargetStore(value) {
  return normalizeStoreKey(value || '');
}

function destinationStoreCandidates(task, targetStore) {
  const sourceStores = new Set(asArray(task?.targets?.sourceStores).map(normalizeStoreKey).filter(Boolean));
  const writeStores = asArray(task?.targets?.writeStores || task?.targets?.targetStores || task?.writeStores || task?.targetStores)
    .map(normalizeStoreKey)
    .filter(Boolean);
  const taskStores = asArray(task?.targets?.stores || task?.stores)
    .map(normalizeStoreKey)
    .filter(store => store && !sourceStores.has(store));
  const candidates = writeStores.length ? writeStores : taskStores;
  const explicit = [
    task?.targetStore,
    task?.target_store,
    task?.targets?.targetStore,
    task?.targets?.target_store,
    task?.targets?.writeStore,
    task?.targets?.write_store,
  ].map(normalizedTargetStore).filter(Boolean);
  return [...new Set([...candidates, ...explicit, normalizedTargetStore(targetStore)].filter(Boolean))];
}

function structuredDestinationPreparation(task) {
  const directBindingPreparation = task?.publishAssetBinding?.publishPreparation;
  const metadataBindingPreparation = task?.metadata?.publishAssetBinding?.publishPreparation;
  const bindingPreparation = directBindingPreparation || metadataBindingPreparation;
  const persistedTaskPreparations = [
    ['task.publishPreparation', task?.publishPreparation],
    ['targets.publishPreparation', task?.targets?.publishPreparation],
  ].filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value));
  const persistedPreparations = [
    ...persistedTaskPreparations,
    ['publishAssetBinding.publishPreparation', directBindingPreparation],
    ['metadata.publishAssetBinding.publishPreparation', metadataBindingPreparation],
  ].filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value));
  const inputCurrentDeclarations = persistedPreparations.map(([source, value]) => ({
    source,
    ...normalizeExactSourceInputCurrentDeclaration(value, source),
  }));
  const declarationSignatures = new Set(inputCurrentDeclarations.map(declaration => JSON.stringify({
    declared: declaration.declared,
    rowCount: declaration.rowCount,
    override: declaration.override,
  })));
  if (declarationSignatures.size > 1) {
    throw new Error(`exact source Input current(1002323) declarations differ across persisted publishPreparation sources: ${inputCurrentDeclarations.map(row => row.source).join(', ')}`);
  }
  const candidates = bindingPreparation && typeof bindingPreparation === 'object' && !Array.isArray(bindingPreparation)
    ? [[directBindingPreparation ? 'publishAssetBinding.publishPreparation' : 'metadata.publishAssetBinding.publishPreparation', bindingPreparation]]
    : persistedTaskPreparations;
  const raw = {};
  for (const [, value] of candidates) {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'attributeOverrides' || key === 'attribute_overrides') continue;
      // Binding evidence may carry explicit null placeholders for fields that
      // were not prepared. Those placeholders must not erase a verified field
      // from another structured preparation source.
      if (item === null || item === undefined || item === '') continue;
      if (key === 'titles' && item && typeof item === 'object' && !Array.isArray(item) && !Object.keys(item).length) continue;
      raw[key] = item;
    }
  }
  const agreedInputCurrent = inputCurrentDeclarations[0] || null;
  if (agreedInputCurrent?.declared) {
    raw.attributeOverrides = agreedInputCurrent.rowCount === 1
      ? [{
          attribute_id: agreedInputCurrent.override.attributeId,
          attribute_extra_value: agreedInputCurrent.override.attributeExtraValue,
          attribute_unit: agreedInputCurrent.override.unit,
          ...(agreedInputCurrent.override.label ? {label: agreedInputCurrent.override.label} : {}),
          source: agreedInputCurrent.override.source,
        }]
      : [];
  }
  const normalized = normalizePublishPreparationOverrides(raw);
  return {
    raw,
    normalized,
    sources: candidates.map(([source]) => source),
  };
}

function exactSourceOverrideField(row, snakeKey, camelKey, sourceLabel) {
  const hasSnake = Object.hasOwn(row, snakeKey);
  const hasCamel = Object.hasOwn(row, camelKey);
  if (hasSnake && hasCamel) {
    throw new Error(`${sourceLabel} Input current(1002323) row declares both ${snakeKey}/${camelKey}`);
  }
  return hasSnake ? row[snakeKey] : hasCamel ? row[camelKey] : undefined;
}

function normalizeExactSourceInputCurrentDeclaration(rawPreparation = {}, sourceLabel = 'exact source publishPreparation') {
  const preparation = rawPreparation && typeof rawPreparation === 'object' && !Array.isArray(rawPreparation)
    ? rawPreparation
    : {};
  const hasCamel = Object.hasOwn(preparation, 'attributeOverrides');
  const hasSnake = Object.hasOwn(preparation, 'attribute_overrides');
  if (hasCamel && hasSnake) {
    throw new Error(`${sourceLabel} declares both attributeOverrides aliases`);
  }
  if (!hasCamel && !hasSnake) return {declared: false, rowCount: 0, override: null};
  const rows = hasCamel ? preparation.attributeOverrides : preparation.attribute_overrides;
  if (!Array.isArray(rows)) {
    throw new Error(`${sourceLabel} attributeOverrides must be an array`);
  }
  if (rows.length > 1) {
    throw new Error(`${sourceLabel} must contain at most one Input current(1002323) override`);
  }
  if (!rows.length) return {declared: true, rowCount: 0, override: null};
  const row = rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`${sourceLabel} Input current(1002323) override must be an object`);
  }
  const rawAttributeId = exactSourceOverrideField(row, 'attribute_id', 'attributeId', sourceLabel);
  const attributeIdValid = (Number.isSafeInteger(rawAttributeId) && rawAttributeId > 0)
    || (typeof rawAttributeId === 'string' && /^[1-9]\d*$/.test(rawAttributeId));
  if (!attributeIdValid || Number(rawAttributeId) !== INPUT_CURRENT_ATTRIBUTE_ID) {
    throw new Error(`${sourceLabel} may project only Input current(1002323)`);
  }
  const extraValue = exactSourceOverrideField(row, 'attribute_extra_value', 'attributeExtraValue', sourceLabel);
  if (typeof extraValue !== 'string' || !/^[1-9]\d*$/.test(extraValue)) {
    throw new Error(`${sourceLabel} Input current(1002323) must be a positive integer numeric string`);
  }
  const milliamps = Number(extraValue);
  if (!Number.isSafeInteger(milliamps) || milliamps < 1 || milliamps > MAX_EXPLICIT_INPUT_CURRENT_MA) {
    throw new Error(`${sourceLabel} Input current(1002323) must be within 1-${MAX_EXPLICIT_INPUT_CURRENT_MA} mA`);
  }
  const unit = exactSourceOverrideField(row, 'attribute_unit', 'attributeUnit', sourceLabel);
  if (unit !== 'mA') {
    throw new Error(`${sourceLabel} Input current(1002323) unit must be mA`);
  }
  if (row.source !== EXPLICIT_PREPARE_PUBLISH_SOURCE) {
    throw new Error(`${sourceLabel} Input current(1002323) source must be ${EXPLICIT_PREPARE_PUBLISH_SOURCE}`);
  }
  return {
    declared: true,
    rowCount: 1,
    override: {
      attributeId: INPUT_CURRENT_ATTRIBUTE_ID,
      attributeExtraValue: String(milliamps),
      unit: 'mA',
      label: safeString(row.label || '', 80),
      source: EXPLICIT_PREPARE_PUBLISH_SOURCE,
    },
  };
}

function targetTitleRows(payload) {
  return asArray(payload?.multi_language_name_list || payload?.multiLanguageNameList)
    .filter(row => row && typeof row === 'object')
    .map(row => ({
      language: safeString(row.language || row.lang || row.languageCode || '', 40).toLowerCase(),
      name: safeString(row.name || row.product_name || row.productName || row.value || '', 1000),
    }))
    .filter(row => row.language && row.name);
}

function targetDescriptionRows(payload) {
  return asArray(payload?.multi_language_desc_list || payload?.multiLanguageDescList || payload?.productMultiDescList)
    .filter(row => row && typeof row === 'object')
    .map(row => ({
      language: safeString(row.language || row.lang || row.languageCode || '', 40).toLowerCase(),
      productDesc: safeString(row.product_desc || row.productDesc || row.description || row.name || row.value || '', 10000),
    }))
    .filter(row => row.language && row.productDesc);
}

function payloadSkuRows(payload) {
  return asArray(payload?.skc_list || payload?.skcList).flatMap(skc => asArray(skc?.sku_list || skc?.skuList));
}

function payloadCostValues(payload) {
  return payloadSkuRows(payload)
    .map(sku => sku?.cost_info || sku?.costInfo || {})
    .map(cost => cost.cost_price ?? cost.costPrice ?? cost.price ?? '')
    .filter(value => value !== '' && value !== null && value !== undefined)
    .map(Number)
    .filter(Number.isFinite);
}

function payloadInventoryValues(payload) {
  return payloadSkuRows(payload).flatMap(sku => asArray(sku?.stock_info_list || sku?.stockInfoList))
    .flatMap(row => ['inventory_num', 'inventoryNum', 'stock', 'stock_num', 'stockNum', 'quantity']
      .filter(key => row?.[key] !== undefined && row?.[key] !== null && row?.[key] !== '')
      .map(key => Number(row[key])))
    .filter(Number.isFinite);
}

function payloadStandardGoodsValues(payload) {
  return asArray(payload?.skc_list || payload?.skcList)
    .map(skc => skc?.supplier_code ?? skc?.supplierCode ?? '')
    .map(value => safeString(value, 240))
    .filter(Boolean);
}

function payloadSupplierSkuValues(payload) {
  return payloadSkuRows(payload)
    .map(sku => safeString(sku?.supplier_sku ?? sku?.supplierSku ?? '', 240))
    .filter(Boolean);
}

function payloadTargetStoreValues(payload) {
  return [
    payload?.target_store,
    payload?.targetStore,
    payload?.store_key,
    payload?.storeKey,
    payload?.write_store,
    payload?.writeStore,
  ].map(normalizedTargetStore).filter(Boolean);
}

function payloadTitleGroupValues(payload) {
  return [payload?.title_group, payload?.titleGroup]
    .map(value => safeString(value, 40).toLowerCase())
    .filter(Boolean);
}

function structuredImageBinding(task) {
  return task?.publishAssetBinding || task?.metadata?.publishAssetBinding || null;
}

function validateStructuredImageBinding(task, targetStore, existingPayload) {
  const binding = structuredImageBinding(task);
  if (!binding) return null;
  const bindingTarget = normalizedTargetStore(binding.targetStore);
  if (binding.sourceApproved !== true || String(binding.authority || '') !== 'human_reviewed_source') {
    throw new Error('exact source lock requires an approved human_reviewed_source destination image binding');
  }
  if (bindingTarget !== targetStore) {
    throw new Error(`destination image binding store ${bindingTarget || '(missing)'} does not match target store ${targetStore}`);
  }
  if (!binding.boundAt || !/^[a-f0-9]{64}$/i.test(String(binding.bindingFingerprint || ''))) {
    throw new Error('destination image binding lacks a verifiable boundAt/bindingFingerprint lock');
  }
  const images = normalizeApprovedImageBindings(binding.images, {sourceApproved: true});
  if (binding.imageCount !== undefined && Number(binding.imageCount) !== images.length) {
    throw new Error('destination image binding imageCount does not match its normalized images');
  }
  const existingImages = normalizePublishPayloadImageProjection(existingPayload);
  const bindingImages = normalizeApprovedImageBindingProjection(images, {sourceApproved: true});
  const hasExistingPayload = Boolean(existingPayload && typeof existingPayload === 'object' && !Array.isArray(existingPayload));
  if (hasExistingPayload && JSON.stringify(existingImages) !== JSON.stringify(bindingImages)) {
    throw new Error('existing task payload images do not match the locked destination image binding');
  }
  return {binding, images};
}

function assertEqualNumberField(values, expected, label) {
  if (!values.length) return;
  if (expected === null || expected === undefined || !Number.isFinite(Number(expected))) {
    throw new Error(`existing task payload contains destination ${label} but no structured preparation lock`);
  }
  if (values.some(value => Number(value) !== Number(expected))) {
    throw new Error(`existing task payload destination ${label} differs from the structured preparation lock`);
  }
}

function buildProtectedDestinationProjection(task, existingPayload, targetStore) {
  const destinationStore = normalizedTargetStore(targetStore);
  const stores = destinationStoreCandidates(task, destinationStore);
  if (stores.some(store => store !== destinationStore)) {
    throw new Error(`destination store binding drifted: expected ${destinationStore}, got ${stores.join('/')}`);
  }
  const preparation = structuredDestinationPreparation(task);
  const overrides = preparation.normalized;
  const payloadStores = payloadTargetStoreValues(existingPayload);
  if (payloadStores.length && payloadStores.some(store => store !== destinationStore)) {
    throw new Error(`existing task payload target store does not match ${destinationStore}`);
  }
  const payloadGroups = payloadTitleGroupValues(existingPayload);
  if (payloadGroups.length && (!overrides.titleGroup || payloadGroups.some(group => group !== overrides.titleGroup))) {
    throw new Error('existing task payload title group has no matching structured destination preparation lock');
  }

  const titles = targetTitleRows(existingPayload);
  const structuredTitles = overrides.titles || {};
  if (titles.length) {
    for (const row of titles) {
      if (!structuredTitles[row.language] || structuredTitles[row.language] !== row.name) {
        throw new Error(`existing task payload title ${row.language} has no matching structured destination title lock`);
      }
    }
  }
  const descriptions = targetDescriptionRows(existingPayload);
  const descriptionBinding = task?.descriptionMaterialBinding;
  const emptyDescriptionAuthorization = task?.emptyDescriptionAuthorization;
  if (descriptions.length || descriptionBinding || emptyDescriptionAuthorization) {
    const descriptionPolicy = validateCopyProductDescriptionPolicy(task, existingPayload);
    if (!descriptionPolicy.ok) {
      throw new Error(`existing task payload description policy lock is invalid: ${descriptionPolicy.blockers.slice(0, 4).join('; ')}`);
    }
  }

  const imageBinding = validateStructuredImageBinding(task, destinationStore, existingPayload);
  if (normalizePublishPayloadImageProjection(existingPayload).length && !imageBinding) {
    throw new Error('existing task payload contains destination images without a locked publishAssetBinding');
  }

  const standardGoods = payloadStandardGoodsValues(existingPayload);
  const supplierSkus = payloadSupplierSkuValues(existingPayload);
  const costs = payloadCostValues(existingPayload);
  const inventories = payloadInventoryValues(existingPayload);
  assertEqualNumberField(costs, overrides.supplyPrice, 'supplyPrice');
  assertEqualNumberField(inventories, overrides.inventory, 'inventory');
  if (standardGoods.length && (!overrides.standardGoodsSn || standardGoods.some(value => value !== overrides.standardGoodsSn))) {
    throw new Error('existing task payload standardGoodsSn has no matching structured preparation lock');
  }
  const expectedSupplierSku = overrides.supplierSku || overrides.standardGoodsSn;
  if (supplierSkus.length && (!expectedSupplierSku || supplierSkus.some(value => value !== expectedSupplierSku))) {
    throw new Error('existing task payload supplierSku has no matching structured preparation lock');
  }

  return {
    targetStore: destinationStore,
    titleGroup: overrides.titleGroup || '',
    titles: structuredTitles,
    descriptionBinding,
    emptyDescriptionAuthorization,
    imageBinding,
    overrides,
    rawPreparation: preparation.raw,
    preparationSources: preparation.sources,
    protectedFields: {
      targetStore: destinationStore,
      titleGroup: overrides.titleGroup || '',
      titleLanguages: Object.keys(structuredTitles),
      descriptionsLocked: Boolean(descriptionBinding || emptyDescriptionAuthorization),
      imagesLocked: Boolean(imageBinding),
      supplyPrice: overrides.supplyPrice,
      inventory: overrides.inventory,
      standardGoodsSn: overrides.standardGoodsSn || '',
      supplierSku: expectedSupplierSku || '',
    },
  };
}

function applyExplicitEmptyDescriptionProjection(payload, task, existingPayload) {
  if (!task?.emptyDescriptionAuthorization) return {payload, applied: []};
  const gate = validateEmptyDescriptionAuthorization(task, existingPayload);
  if (!gate.ok) {
    throw new Error(`empty-description destination lock is invalid: ${gate.blockers.slice(0, 4).join('; ')}`);
  }
  return {
    payload: stripPublishPayloadDescriptions(payload),
    applied: ['destination.emptyDescriptionAuthorization.omit_descriptions'],
  };
}

function applyExactSourceLockedInputCurrentOverride(payload, rawPreparation = {}) {
  const declaration = normalizeExactSourceInputCurrentDeclaration(rawPreparation);
  if (declaration.rowCount === 0) return {payload, applied: [], override: null};
  const milliamps = Number(declaration.override.attributeExtraValue);

  const next = jsonClone(payload || {});
  const list = asArray(next.product_attribute_list || next.productAttributeList)
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .filter(item => normalizeAttributeId(item.attribute_id ?? item.attributeId) !== INPUT_CURRENT_ATTRIBUTE_ID)
    .map(item => ({...item}));
  list.push({
    attribute_id: INPUT_CURRENT_ATTRIBUTE_ID,
    attribute_extra_value: String(milliamps),
    __manual_attribute_unit: 'mA',
  });
  next.product_attribute_list = list;
  if (next.productAttributeList) delete next.productAttributeList;
  return {
    payload: next,
    applied: [`product_attribute_list.${INPUT_CURRENT_ATTRIBUTE_ID}.explicit_prepare_publish=${milliamps}mA`],
    override: declaration.override,
  };
}

function mergeExactSourceDestinationBindings(sourcePayload, task, existingPayload, targetStore) {
  let payload = jsonClone(sourcePayload);
  const applied = [];
  const projection = buildProtectedDestinationProjection(task, existingPayload, targetStore);
  const emptyDescriptionApplied = applyExplicitEmptyDescriptionProjection(payload, task, existingPayload);
  payload = emptyDescriptionApplied.payload;
  applied.push(...emptyDescriptionApplied.applied);
  const imageBinding = projection.imageBinding;
  if (imageBinding) {
    const bound = applyApprovedImageBindingsToPublishPayload(payload, imageBinding.images, {sourceApproved: true});
    payload = bound.payload;
    applied.push('destination.publishAssetBinding.images');
  }

  const descriptionBinding = projection.descriptionBinding;
  if (descriptionBinding && typeof descriptionBinding === 'object') {
    payload.multi_language_desc_list = jsonClone(existingPayload.multi_language_desc_list);
    applied.push('destination.descriptionMaterialBinding.multi_language_desc_list');
  }

  // A separately signed productAttributeBinding is destination-owned state.
  // Exact-source hydration must not discard the one row that the binding pins,
  // but it must also never copy the whole task attribute list. The downstream
  // binding gate revalidates the donor evidence, hashes and payload row before
  // submit; malformed, missing or duplicate rows remain blocked.
  const attributeBinding = task?.productAttributeBinding;
  const boundAttributeId = Number(attributeBinding?.attributeId);
  const boundAttributeValueId = Number(attributeBinding?.attributeValueId);
  if (Number.isSafeInteger(boundAttributeId) && boundAttributeId > 0
    && Number.isSafeInteger(boundAttributeValueId) && boundAttributeValueId > 0) {
    const existingRows = asArray(existingPayload?.product_attribute_list || existingPayload?.productAttributeList)
      .filter(row => row && typeof row === 'object' && !Array.isArray(row));
    const matchingRows = existingRows.filter(row => {
      return Number(row.attribute_id ?? row.attributeId) === boundAttributeId
        && Number(row.attribute_value_id ?? row.attributeValueId) === boundAttributeValueId;
    });
    if (matchingRows.length === 1) {
      const sourceRows = asArray(payload?.product_attribute_list || payload?.productAttributeList)
        .filter(row => row && typeof row === 'object' && !Array.isArray(row))
        .filter(row => Number(row.attribute_id ?? row.attributeId) !== boundAttributeId)
        .map(row => jsonClone(row));
      payload.product_attribute_list = [...sourceRows, jsonClone(matchingRows[0])];
      delete payload.productAttributeList;
      applied.push(`destination.productAttributeBinding.${boundAttributeId}`);
    }
  }

  const preparation = applyExplicitPublishPreparationOverrides(payload, projection.overrides);
  payload = preparation.payload;
  applied.push(...preparation.applied.map(value => `destination.publishPreparation.${value}`));
  const inputCurrent = applyExactSourceLockedInputCurrentOverride(payload, projection.rawPreparation);
  payload = inputCurrent.payload;
  applied.push(...inputCurrent.applied.map(value => `destination.publishPreparation.${value}`));
  return {payload, applied, projection};
}

async function buildExactSourceLockedPayload(task, {targetStore, source, existingPayload, expectedSourceDetailHash = ''}) {
  const generated = await buildProductDraftFromSnapshots({
    sourceStore: source.sourceStore,
    sourceSkc: source.sourceSkc,
    date: 'latest',
    targetStore,
  });
  const readiness = exactSourcePayloadReadiness(generated, source);
  if (!readiness.ok) {
    return {
      source: 'exact_source_snapshot_incomplete',
      payload: null,
      inferred: source,
      exactSourceLock: true,
      generatedDraft: summarizeDraftForExecutor(generated),
      mappingBlockers: generated?.blockers || [],
      structuredMappingBlockers: generated?.mappingBlockers || [],
      generationError: readiness.reason,
    };
  }
  const currentSourceDetailHash = String(readiness.sourceDetailHash || '').toLowerCase();
  if (expectedSourceDetailHash && currentSourceDetailHash !== String(expectedSourceDetailHash).toLowerCase()) {
    return {
      source: 'exact_source_cache_drifted',
      payload: null,
      inferred: source,
      exactSourceLock: true,
      generatedDraft: summarizeDraftForExecutor(generated),
      sourceDetailLock: readiness.sourceDetailLock || null,
      generationError: `exact source detail cache drifted since preflight: expected=${expectedSourceDetailHash} actual=${currentSourceDetailHash || 'missing'}`,
    };
  }
  // Capture source identity before any destination-owned preparation can
  // rewrite supplier_code. Provenance guards must never treat the merged
  // target identity as evidence about the locked source product.
  const sourcePayloadSupplierCodes = publishTargetSupplierCodes(readiness.payload);
  const merged = mergeExactSourceDestinationBindings(readiness.payload, task, existingPayload, targetStore);
  return {
    source: 'webapi_snapshot_exact_source_lock',
    payload: merged.payload,
    inferred: source,
    exactSourceLock: true,
    generatedDraft: summarizeDraftForExecutor(generated),
    canonicalDraft: generated.canonicalDraft,
    mappingBlockers: generated.blockers,
    structuredMappingBlockers: generated.mappingBlockers,
    mappingWarnings: generated.warnings,
    destinationBindingsApplied: merged.applied,
    destinationProjection: merged.projection.protectedFields,
    sourceDetailHash: readiness.sourceDetailHash,
    sourceDetailLock: readiness.sourceDetailLock,
    sourcePayloadSupplierCodes,
    taskPayloadIgnored: Boolean(existingPayload),
  };
}

export async function findOrBuildPublishPayload(task, {targetStore, preferredSource = null}) {
  const taskExactSource = exactCopySourceLock(task);
  const hasExactSourceLock = Boolean(taskExactSource);

  const existing = await findPublishPayload(task);
  const exactSource = taskExactSource;
  if (exactSource) {
    if (taskHasUnboundImageAssets(task) && !task?.publishAssetBinding) {
      return {
        source: 'exact_source_unbound_image_assets',
        payload: null,
        inferred: exactSource,
        exactSourceLock: true,
        generationError: 'exact source lock cannot fall back to unbound destination image assets; bind reviewed images to the same task first',
      };
    }
    try {
      return await buildExactSourceLockedPayload(task, {
        targetStore,
        source: exactSource,
        existingPayload: existing?.payload || null,
        expectedSourceDetailHash: preferredSource?.sourceDetailHash || '',
      });
    } catch (error) {
      return {
        source: 'exact_source_snapshot_error',
        payload: null,
        inferred: exactSource,
        exactSourceLock: true,
        generationError: error?.message || String(error),
      };
    }
  }
  if (existing?.payload) {
    // A server-bound task keeps the reviewed payload at the task root. Retain
    // that payload as the only publish source, but hydrate read-only source
    // metadata from the deterministic snapshot so live en/ar title enrichment
    // still knows the exact source store and SPU. Never replace or merge the
    // bound payload with a snapshot payload here.
    const inferred = inferSourceProductFromTask(task, {targetStore});
    if (!inferred.sourceStore || !inferred.sourceSkc) return {...existing, inferred, exactSourceLock: hasExactSourceLock, taskExactSource};
    try {
      const generated = await buildProductDraftFromSnapshots({
        sourceStore: inferred.sourceStore,
        sourceSkc: inferred.sourceSkc,
        date: 'latest',
        targetStore,
      });
      return {
        ...existing,
        inferred,
        exactSourceLock: hasExactSourceLock,
        taskExactSource,
        generatedDraft: summarizeDraftForExecutor(generated),
        canonicalDraft: generated.canonicalDraft,
        mappingBlockers: generated.blockers,
        mappingWarnings: generated.warnings,
        structuredMappingBlockers: generated.mappingBlockers,
        sourceDetailLock: generated.sourceDetailLock,
      };
    } catch (err) {
      // The bound payload (root openapiPublishPayload or approved asset) stays
      // authoritative; snapshot hydration is read-only metadata enrichment.
      // The exact task source lock is preserved and enforced separately by the
      // source scope resolution and the scope-v4 execution hash.
      return {
        ...existing,
        inferred,
        exactSourceLock: hasExactSourceLock,
        taskExactSource,
        sourceMetadataWarning: `精确源链接 ${exactSourceStore}/${exactSourceSkc} 无法从当前详情快照还原只读元数据：${safeString(err?.message || err, 300)}`,
      };
    }
  }
  if (taskHasUnboundImageAssets(task)) {
    return {
      source: 'unbound_image_assets',
      payload: null,
      inferred: inferSourceProductFromTask(task, {targetStore}),
      taskExactSource,
      generationError: '任务已经上传本地图片，但这些图片尚未转换并绑定到发布 payload；已拒绝静默回退到源链接图片。请先使用同一任务的图片准备/绑定流程。',
    };
  }
  const inferred = inferSourceProductFromTask(task, {targetStore});
  const biCandidates = await inferSourceCandidatesFromBi(task, {targetStore});
  const candidates = hasExactSourceLock
    ? uniqueSourceCandidates([{sourceStore: exactSourceStore, sourceSkc: exactSourceSkc, source: 'task_exact_source_lock'}])
    : uniqueSourceCandidates([preferredSource, inferred, ...biCandidates]);
  if (!candidates.length) {
    return {
      source: 'missing',
      payload: null,
      inferred,
      taskExactSource,
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
        structuredMappingBlockers: generated.mappingBlockers,
        sourceDetailLock: generated.sourceDetailLock,
        inferred: candidate,
        exactSourceLock: hasExactSourceLock,
        taskExactSource,
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
    taskExactSource,
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

// Source scope resolution contract: every copy_product_draft with an exact
// unique task source lock (targets.sourceStores single value + sourceSkc) MUST
// resolve and preserve that lock, even when the payload comes from a root
// openapiPublishPayload or an approved asset. The resolved store/skc feed the
// scope-v4 execution hash, the provenance guard and the executor projection.
// Missing/multi-valued locks or a conflict between the exact lock and the
// inferred source fail closed with a blocker instead of an empty source.
function resolveLockedSourceScope({payloadFound, task, intents = [], targetStore = ''}) {
  const copyProductDraft = asArray(intents).includes('copy_product_draft');
  // The exact task source lock is authoritative and computed from the task
  // itself: single-valued targets.sourceStores plus a non-empty
  // targets.sourceSkc. A copy task that declares NO source at all is allowed
  // through the legacy/approved-asset flow (source may stay empty and the
  // scope-v4 hash stays stable). Partial declarations, multi-valued stores and
  // exact-vs-inferred conflicts fail closed.
  const rawDeclaredSourceStores = asArray(task?.targets?.sourceStores);
  const rawDeclaredSourceSkc = task?.targets?.sourceSkc;
  const declaredSourceStoreInvalid = rawDeclaredSourceStores.some(value => !validSourceStoreKey(value));
  const declaredSourceSkcPresent = rawDeclaredSourceSkc !== undefined && rawDeclaredSourceSkc !== null && rawDeclaredSourceSkc !== '';
  const declaredSourceSkcInvalid = declaredSourceSkcPresent && !validSourceSkc(rawDeclaredSourceSkc);
  const declaredSourceStores = declaredSourceStoreInvalid
    ? []
    : [...new Set(rawDeclaredSourceStores.map(value => String(value)).filter(Boolean))];
  const declaredSourceSkc = declaredSourceSkcInvalid ? '' : (declaredSourceSkcPresent ? rawDeclaredSourceSkc : '');
  const hasAnySourceDeclaration = rawDeclaredSourceStores.length > 0 || declaredSourceSkcPresent;
  const taskExact = !declaredSourceStoreInvalid && !declaredSourceSkcInvalid && declaredSourceStores.length === 1 && declaredSourceSkc
    ? {sourceStore: declaredSourceStores[0], sourceSkc: declaredSourceSkc}
    : null;
  const inferred = payloadFound?.inferred && typeof payloadFound.inferred === 'object' ? payloadFound.inferred : {};
  const inferredStore = normalizeStoreKey(
    inferred?.sourceStore
    || payloadFound?.generatedDraft?.sourceStore
    || payloadFound?.canonicalDraft?.source?.storeKey
    || '',
  );
  const inferredSkc = safeString(
    inferred?.sourceSkc
    || payloadFound?.generatedDraft?.sourceSkc
    || payloadFound?.canonicalDraft?.openApiDetail?.skcName
    || '',
    160,
  );
  const blockers = [];
  if (copyProductDraft && (declaredSourceStoreInvalid || declaredSourceSkcInvalid)) {
    blockers.push('copy_product_draft 任务的 sourceStores/sourceSkc 类型或格式无效，禁止发布，需重新创建精确字符串来源锁。');
  }
  if (copyProductDraft && hasAnySourceDeclaration && !taskExact) {
    blockers.push(declaredSourceStores.length > 1
      ? `copy_product_draft 任务声明的 sourceStores 不唯一（${declaredSourceStores.join('、')}），禁止发布，需人工修正精确源链接。`
      : `copy_product_draft 任务只声明了部分精确源链接（sourceStores=${declaredSourceStores.join('、') || '空'} sourceSkc=${declaredSourceSkc || '空'}），禁止发布，需人工补充完整。`);
  }
  if (copyProductDraft && taskExact) {
    if (inferredStore && inferredStore !== taskExact.sourceStore) {
      blockers.push(`copy_product_draft 任务精确源店 ${taskExact.sourceStore} 与推断来源 ${inferredStore} 冲突，禁止发布。`);
    }
    if (inferredSkc && inferredSkc !== taskExact.sourceSkc) {
      blockers.push(`copy_product_draft 任务精确源 SKC ${taskExact.sourceSkc} 与推断来源 ${inferredSkc} 冲突，禁止发布。`);
    }
  }
  return {
    copyProductDraft,
    taskExact,
    inferredStore,
    inferredSkc,
    sourceStore: taskExact ? taskExact.sourceStore : inferredStore,
    sourceSkc: taskExact ? taskExact.sourceSkc : inferredSkc,
    blockers,
  };
}

const SOURCE_DETAIL_LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PRODUCT_EXECUTION_HASH_ALGORITHM = 'sha256-stable-json-scope-v4';
const PRODUCT_EXECUTION_HASH_SCHEMA = 'copy_product_draft_execution_scope/v4';
const SOURCE_DETAIL_LOCK_SOURCES = new Set([
  'openapi_product_detail_snapshot',
  'openapi_product_detail_cached_fallback',
]);

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/u.test(String(value ?? ''));
}

function validSourceStoreKey(value) {
  if (typeof value !== 'string') return false;
  if (hasControlCharacters(value)) return false;
  const raw = String(value ?? '');
  return raw === normalizeStoreKey(raw) && /^[A-Z][A-Z0-9_-]{1,31}$/.test(raw);
}

function validSourceSkc(value) {
  if (typeof value !== 'string') return false;
  if (hasControlCharacters(value)) return false;
  const raw = String(value ?? '');
  return raw.length <= 160 && /^s[abv]\d{8,}$/i.test(raw);
}

function validSourceSpu(value) {
  if (typeof value !== 'string') return false;
  if (hasControlCharacters(value)) return false;
  const raw = String(value ?? '');
  return raw.length <= 160 && /^[abv]\d{8,}$/i.test(raw);
}

function validSourceDetailSource(value) {
  if (typeof value !== 'string') return false;
  if (hasControlCharacters(value)) return false;
  return SOURCE_DETAIL_LOCK_SOURCES.has(String(value ?? ''));
}

function validLowerSha256(value) {
  if (typeof value !== 'string') return false;
  if (hasControlCharacters(value)) return false;
  return /^[a-f0-9]{64}$/.test(String(value ?? ''));
}

function validRecoverableSourceDetailLock(lock, sourceSkc = '') {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return false;
  if (typeof lock.detailFetchedAt !== 'string') return false;
  const fetchedAt = lock.detailFetchedAt;
  const fetchedMs = Date.parse(fetchedAt);
  const checkedMs = Date.now();
  return validSourceDetailSource(lock.source)
    && validSourceSpu(lock.matchedSpuName)
    && validSourceSkc(lock.matchedSkcName)
    && (!sourceSkc || String(lock.matchedSkcName) === String(sourceSkc))
    && validLowerSha256(lock.detailContentSha256)
    && !hasControlCharacters(fetchedAt)
    && Number.isFinite(fetchedMs)
    && fetchedMs <= checkedMs
    && checkedMs - fetchedMs <= SOURCE_DETAIL_LOCK_MAX_AGE_MS;
}

function validStandardGoodsSn(value) {
  if (typeof value !== 'string') return false;
  const raw = String(value ?? '');
  if (/[\u0000-\u001f\u007f]/u.test(raw)) return false;
  if (raw !== raw.trim()) return false;
  const text = safeString(raw, 160);
  return Boolean(text && /[\p{L}\p{N}]/u.test(text));
}

function executionHashScalar(value, max = 160) {
  if (typeof value === 'string') return value.slice(0, max);
  return {invalidType: Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value)};
}

function sourceDetailLockBlocker(code, message) {
  return {code, message: safeString(message, 1000)};
}

// The execution-confirmation hash locks source identity and source content,
// not the observation timestamp. detailFetchedAt remains part of the persisted
// evidence and the 24-hour write gate below, but including it in the hash makes
// an otherwise byte-identical source refresh invalidate approval forever.
// Keep this projection explicit and fail-closed: malformed/missing values still
// affect the hash and are rejected separately by validateSourceDetailLockForWrite.
function sourceDetailLockExecutionHashScope(lock = null) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return null;
  return {
    source: executionHashScalar(lock.source, 160),
    matchedSkcName: executionHashScalar(lock.matchedSkcName, 160),
    matchedSpuName: executionHashScalar(lock.matchedSpuName, 160),
    detailContentSha256: executionHashScalar(lock.detailContentSha256, 120),
  };
}

function buildProductExecutionHashScope({
  payload = null,
  targetStore = '',
  sourceStore = '',
  sourceSkc = '',
  standardGoodsSn = '',
  sourceDetailLock = null,
  productAliasRegistryFingerprint = '',
  productCatalogFingerprint = '',
  emptyDescriptionAuthorization = null,
} = {}) {
  const scope = {
    schema: PRODUCT_EXECUTION_HASH_SCHEMA,
    payload,
    targetStore: executionHashScalar(targetStore, 80),
    sourceStore: executionHashScalar(sourceStore, 80),
    sourceSkc: executionHashScalar(sourceSkc, 160),
    // Preserve internal bytes in the hash domain. Validation rejects controls,
    // but even an invalid raw caller cannot make "ABC\nDEF" collide with the
    // valid canonical value "ABC DEF" before the gate blocks it.
    standardGoodsSn: executionHashScalar(standardGoodsSn, 160),
    sourceDetailLock: sourceDetailLockExecutionHashScope(sourceDetailLock),
    productAliasRegistryFingerprint: executionHashScalar(productAliasRegistryFingerprint, 120),
    productCatalogFingerprint: executionHashScalar(productCatalogFingerprint, 120),
  };
  // Preserve legacy v4 hashes for every ordinary task. Only an explicit marker
  // adds a new hash member, so unrelated in-flight preflights do not drift.
  if (emptyDescriptionAuthorization && typeof emptyDescriptionAuthorization === 'object' && !Array.isArray(emptyDescriptionAuthorization)) {
    scope.emptyDescriptionAuthorization = emptyDescriptionAuthorization;
  }
  return scope;
}

// 写前详情锁门：把本次 hydration 得到的当前 sourceDetailLock 与预检锁定的锁
// 逐项比对。过期、未来/非法时间、身份漂移、内容 hash 漂移或缺锁都必须阻断，
// sheinWriteAttempted 保持 false。
// - required=true（copy_product_draft）：dry-run 和 execute 都必须有当前详情锁，
//   bound payload hydration 失败/无锁是结构化 blocker，不能仅 warning 后继续。
// - requireExpectedLock=true（copy_product_draft 的 execute）：预检锁必须带
//   sourceDetailLock；旧版只有 payload hash 的预检强制重新 dry-run。
  // - 其它流程（维护执行等）无预检锁时沿用既有 scope-v4 hash 覆盖，不额外阻断。
function validateSourceDetailLockForWrite({
  currentLock = null,
  expectedLock = null,
  sourceStore = '',
  sourceSkc = '',
  standardGoodsSn = '',
  now = new Date(),
  required = false,
  requireExpectedLock = false,
} = {}) {
  const checkedMs = now instanceof Date && Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const checkedAt = new Date(checkedMs).toISOString();
  const expected = expectedLock && typeof expectedLock === 'object' && !Array.isArray(expectedLock) ? expectedLock : null;
  const current = currentLock && typeof currentLock === 'object' && !Array.isArray(currentLock) ? currentLock : null;
  const blockers = [];
  if (requireExpectedLock && !expected) {
    blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_PREFLIGHT_MISSING', '执行要求预检锁定 sourceDetailLock，但当前预检产物只有旧版 payload hash、没有详情锁；必须重新 dry-run 生成并锁定源详情锁后再执行。'));
  }
  if (!expected && !required) {
    return {
      ok: true,
      gateActive: false,
      blockers: [],
      checkedAt,
      note: '没有预检详情锁且当前流程不强制详情锁；沿用既有流程，scope-v4 hash 仍覆盖本次执行范围。',
    };
  }
  if (!current) {
    blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_MISSING', expected
      ? `写前详情锁缺失：预检已锁定源详情 ${safeString(sourceStore, 80)}/${safeString(sourceSkc, 160)}，执行时无法重新生成当前详情锁，禁止写入。`
      : `写前详情锁缺失：copy_product_draft 要求绑定源详情 ${safeString(sourceStore, 80)}/${safeString(sourceSkc, 160)}，本次 hydration 未能生成详情锁，禁止写入。`));
    return {ok: false, gateActive: true, blockers, checkedAt};
  }
  const expectedSpu = safeString(expected?.matchedSpuName, 160);
  const expectedSkc = safeString(expected?.matchedSkcName, 160);
  const currentSpu = safeString(current.matchedSpuName, 160);
  const currentSkc = safeString(current.matchedSkcName, 160);
  const currentSource = safeString(current.source, 160);
  const currentContentHash = safeString(current.detailContentSha256, 120).toLowerCase();
  const exactSourceStore = normalizeStoreKey(sourceStore);
  const exactSourceSkc = safeString(sourceSkc, 160);
  const exactStandardGoodsSn = safeString(standardGoodsSn, 160);
  if ((required || expected) && !validSourceStoreKey(sourceStore)) {
    blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_SCOPE_INVALID', `写前详情锁 sourceStore 格式无效（当前=${exactSourceStore || '空'}），禁止写入。`));
  }
  if ((required || expected) && !validSourceSkc(sourceSkc)) {
    blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_SCOPE_INVALID', `写前详情锁 sourceSkc 格式无效（当前=${exactSourceSkc || '空'}），禁止写入。`));
  }
  if (required && !validStandardGoodsSn(standardGoodsSn)) {
    blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_SCOPE_INVALID', `copy_product_draft 写前详情锁目标标准货号无效（当前=${exactStandardGoodsSn || '空'}），禁止写入。`));
  }
  if ((required || expected) && (!validSourceDetailSource(current.source)
    || !validSourceSpu(current.matchedSpuName)
    || !validSourceSkc(current.matchedSkcName)
    || !validLowerSha256(current.detailContentSha256))) {
    blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_SCOPE_INVALID', '写前详情锁的 source 枚举、SPU、SKC 或 content SHA 格式无效，禁止写入。'));
  }
  if (exactSourceSkc && currentSkc !== exactSourceSkc) {
    blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_IDENTITY_DRIFT', `写前详情锁 SKC 漂移：任务锁定源 ${safeString(sourceStore, 80)}/${safeString(sourceSkc, 160)}，当前详情实际 SKC=${currentSkc}，禁止写入。`));
  }
  if (expectedSkc && currentSkc && currentSkc !== expectedSkc) {
    blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_IDENTITY_DRIFT', `写前详情锁 SKC 漂移：预检锁定 SKC=${expectedSkc}，当前详情实际 SKC=${currentSkc}，禁止写入。`));
  }
  if (expectedSpu && currentSpu && currentSpu !== expectedSpu) {
    blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_IDENTITY_DRIFT', `写前详情锁 SPU 漂移：预检锁定 SPU=${expectedSpu}，当前详情实际 SPU=${currentSpu}，禁止写入。`));
  }
  const fetchedText = typeof current.detailFetchedAt === 'string' ? current.detailFetchedAt : '';
  const fetchedMs = Date.parse(fetchedText);
  if (!fetchedText || hasControlCharacters(fetchedText) || !Number.isFinite(fetchedMs)) {
    blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_TIMESTAMP_INVALID', `写前详情锁缺少合法行级 detailFetchedAt（当前=${fetchedText || '空'}），禁止写入。`));
  } else {
    if (fetchedMs > checkedMs) {
      blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_FUTURE', `写前详情锁 detailFetchedAt=${fetchedText} 晚于执行时间，判定为未来时间，禁止写入。`));
    }
    if (checkedMs - fetchedMs > SOURCE_DETAIL_LOCK_MAX_AGE_MS) {
      blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_EXPIRED', `写前详情锁 detailFetchedAt=${fetchedText} 已超过 24 小时，禁止写入。`));
    }
  }
  if (expected) {
    const expectedSource = safeString(expected.source, 160);
    const expectedHash = safeString(expected.detailContentSha256, 120).toLowerCase();
    if (!validSourceDetailSource(expected.source)
      || !validSourceSpu(expected.matchedSpuName)
      || !validSourceSkc(expected.matchedSkcName)
      || !validLowerSha256(expected.detailContentSha256)) {
      blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_PREFLIGHT_INVALID', '预检 sourceDetailLock 的 source 枚举、SPU、SKC 或 content SHA 格式无效，必须重新 dry-run。'));
    }
    const expectedFetchedText = typeof expected.detailFetchedAt === 'string' ? expected.detailFetchedAt : '';
    const expectedFetchedMs = Date.parse(expectedFetchedText);
    if (!expectedFetchedText || hasControlCharacters(expectedFetchedText) || !Number.isFinite(expectedFetchedMs)) {
      blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_PREFLIGHT_INVALID', '预检 sourceDetailLock 的 detailFetchedAt 类型或格式无效，必须重新 dry-run。'));
    } else if (expectedFetchedMs > checkedMs) {
      blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_PREFLIGHT_FUTURE', `预检 sourceDetailLock 的 detailFetchedAt=${expectedFetchedText} 晚于执行时间，必须重新 dry-run。`));
    } else if (checkedMs - expectedFetchedMs > SOURCE_DETAIL_LOCK_MAX_AGE_MS) {
      blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_PREFLIGHT_EXPIRED', `预检 sourceDetailLock 的 detailFetchedAt=${expectedFetchedText} 已超过 24 小时，必须重新 dry-run。`));
    }
    if (expectedSource && currentSource && expectedSource !== currentSource) {
      blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_IDENTITY_DRIFT', `写前详情锁来源类型漂移：预检锁定 ${expectedSource}，当前详情 ${currentSource}，禁止写入。`));
    }
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || !/^[a-f0-9]{64}$/.test(currentContentHash) || expectedHash !== currentContentHash) {
      blockers.push(sourceDetailLockBlocker('SOURCE_DETAIL_LOCK_CONTENT_DRIFT', `写前详情内容 hash 漂移：预检锁定 ${expectedHash || '空'}，当前详情 ${currentContentHash || '空'}，禁止写入。`));
    }
  }
  return {ok: blockers.length === 0, gateActive: true, blockers, checkedAt};
}

function taskPublishPreparationOverrides(task = {}, executionContext = {}) {
  const taskPreparation = task?.publishPreparation && typeof task.publishPreparation === 'object'
    ? task.publishPreparation
    : {};
  const metadataPreparation = task?.metadata?.publishPreparation && typeof task.metadata.publishPreparation === 'object'
    ? task.metadata.publishPreparation
    : {};
  const targetPreparation = task?.targets?.publishPreparation && typeof task.targets.publishPreparation === 'object'
    ? task.targets.publishPreparation
    : {};
  const executionPreparation = executionContext?.publishPreparation && typeof executionContext.publishPreparation === 'object'
    ? executionContext.publishPreparation
    : {};
  return {
    ...taskPreparation,
    ...metadataPreparation,
    ...targetPreparation,
    ...executionPreparation,
    standardGoodsSn: firstNonEmpty(
      executionPreparation.standardGoodsSn,
      executionPreparation.standard_goods_sn,
      taskPreparation.standardGoodsSn,
      taskPreparation.standard_goods_sn,
      metadataPreparation.standardGoodsSn,
      metadataPreparation.standard_goods_sn,
      targetPreparation.standardGoodsSn,
      targetPreparation.standard_goods_sn,
      task?.targets?.standardGoodsSn,
      task?.standardGoodsSn,
    ),
    supplierSku: firstNonEmpty(
      executionPreparation.supplierSku,
      executionPreparation.supplier_sku,
      taskPreparation.supplierSku,
      taskPreparation.supplier_sku,
      metadataPreparation.supplierSku,
      metadataPreparation.supplier_sku,
      targetPreparation.supplierSku,
      targetPreparation.supplier_sku,
      task?.notes?.supplierSkuPolicy?.mode === 'unique-per-link'
        ? task?.notes?.supplierSkuPolicy?.value
        : '',
    ),
    supplyPrice: firstNonEmpty(
      executionPreparation.supplyPrice,
      executionPreparation.supply_price,
      taskPreparation.supplyPrice,
      taskPreparation.supply_price,
      metadataPreparation.supplyPrice,
      metadataPreparation.supply_price,
      targetPreparation.supplyPrice,
      targetPreparation.supply_price,
      task?.targets?.supplyPrice,
      task?.supplyPrice,
    ),
    inventory: firstNonEmpty(
      executionPreparation.inventory,
      executionPreparation.stockQty,
      executionPreparation.stock_qty,
      taskPreparation.inventory,
      taskPreparation.stockQty,
      taskPreparation.stock_qty,
      metadataPreparation.inventory,
      metadataPreparation.stockQty,
      metadataPreparation.stock_qty,
      targetPreparation.inventory,
      targetPreparation.stockQty,
      targetPreparation.stock_qty,
      task?.targets?.inventory,
      task?.inventory,
    ),
    categoryId: firstNonEmpty(
      executionPreparation.categoryId,
      executionPreparation.category_id,
      taskPreparation.categoryId,
      taskPreparation.category_id,
      metadataPreparation.categoryId,
      metadataPreparation.category_id,
      targetPreparation.categoryId,
      targetPreparation.category_id,
      task?.targets?.categoryId,
      task?.categoryId,
    ),
    titleAr: firstNonEmpty(
      executionPreparation.titleAr,
      executionPreparation.title_ar,
      taskPreparation.titleAr,
      taskPreparation.title_ar,
      metadataPreparation.titleAr,
      metadataPreparation.title_ar,
      targetPreparation.titleAr,
      targetPreparation.title_ar,
      task?.targets?.titleAr,
      task?.titleAr,
    ),
    titleEn: firstNonEmpty(
      executionPreparation.titleEn,
      executionPreparation.title_en,
      taskPreparation.titleEn,
      taskPreparation.title_en,
      metadataPreparation.titleEn,
      metadataPreparation.title_en,
      targetPreparation.titleEn,
      targetPreparation.title_en,
      task?.targets?.titleEn,
      task?.titleEn,
    ),
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
  const lockedSchedule = lockedHopeOnSaleDate(executionContext);
  const scheduledHopeOnSaleDate = lockedSchedule || newLinkHopeOnSaleDate(task, executionContext);
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
  if (lockedSchedule && next.hope_on_sale_date !== lockedSchedule) {
    next.hope_on_sale_date = lockedSchedule;
    applied.push('hope_on_sale_date=preflight_locked');
  } else if (!next.hope_on_sale_date) {
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
    if (String(skc.shelf_way ?? skc.shelfWay) === '2' && hopeOnSaleDate) {
      const currentSkcHopeDate = skc.hope_on_sale_date || skc.hopeOnSaleDate || '';
      if (!currentSkcHopeDate || (lockedSchedule && currentSkcHopeDate !== lockedSchedule)) {
        skc.hope_on_sale_date = hopeOnSaleDate;
        if ('hopeOnSaleDate' in skc) delete skc.hopeOnSaleDate;
        applied.push(lockedSchedule ? 'skc_list.hope_on_sale_date.preflight_locked' : 'skc_list.hope_on_sale_date');
      }
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
  return safeString(row?.skcName || row?.skc_name || row?.skc, 160);
}

function namesFromOpenApiSpuInfo(info, sourceSkc = '') {
  const skcRows = openApiSpuInfoSkcList(info);
  const matchedSkc = sourceSkc
    ? skcRows.find(row => openApiSpuInfoSkcName(row) === sourceSkc) || null
    : skcRows[0] || null;
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

function liveSourceSkcMatches(info, sourceSkc = '') {
  return openApiSpuInfoSkcList(info).some(row => {
    const names = [row?.skcName, row?.skc_name, row?.skc]
      .map(value => safeString(value, 160))
      .filter(Boolean);
    return names.includes(sourceSkc);
  });
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

// Exact-case SKC -> SPU resolution for bound-payload copies: when the exact
// source lock has sourceStore+sourceSkc but no snapshot-derived spuName, the
// source store searchProduct must resolve EXACTLY ONE case-sensitive SPU.
// Zero/multiple results or a failed query block; case variants never match.
async function resolveSourceSpuByExactSkc(client, sourceStore, sourceSkc) {
  let response = null;
  try {
    response = await client.request('/open-api/goods/searchProduct', {
      method: 'POST',
      body: {pageNum: 1, pageSize: 10, skcNameList: [sourceSkc], languageList: ['en', 'ar']},
      headers: {language: 'en'},
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'query_failed',
      error: safeString(err?.message || err, 300),
      call: {
        name: `source-search-product-${sourceSkc}`,
        path: '/open-api/goods/searchProduct',
        method: 'POST',
        httpStatus: null,
        code: null,
        msg: safeString(err?.message || err, 300),
        traceId: null,
      },
    };
  }
  const call = compactCallResult(`source-search-product-${sourceSkc}`, '/open-api/goods/searchProduct', 'POST', response);
  if (!response.ok || String(response.data?.code) !== '0') {
    return {
      ok: false,
      reason: 'query_failed',
      error: `code=${safeString(response.data?.code || '', 80)} msg=${safeString(response.data?.msg || response.statusText || '', 300)}`,
      call,
    };
  }
  const spus = [];
  for (const product of openApiSearchProductRows(response.data)) {
    const skcNames = [
      ...asArray(product?.skcList || product?.skc_list || product?.skcInfoList || product?.skc_info_list)
        .map(row => safeString(row?.skcName || row?.skc_name || '', 160)),
      safeString(product?.skcName || product?.skc_name || '', 160),
    ].filter(Boolean);
    if (!skcNames.some(name => name === sourceSkc)) continue; // case-sensitive exact match
    const spuName = safeString(product?.spuName || product?.spu_name || '', 120);
    if (spuName) spus.push(spuName);
  }
  const unique = [...new Set(spus)];
  if (!unique.length) return {ok: false, reason: 'not_found', call};
  if (unique.length > 1) return {ok: false, reason: 'ambiguous', call, spus: unique};
  return {ok: true, spuName: unique[0], call};
}

async function enrichPayloadNamesFromLiveSourceOpenApi(config, payload, payloadFound) {
  const exactSourceLock = payloadFound?.exactSourceLock === true;
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
  const existingLanguages = payloadNameLanguages(payload);
  if (!sourceStore || (!spuName && !exactSourceLock)) {
    return {
      payload,
      applied: [],
      warnings: [],
      blockers: exactSourceLock ? ['精确源链接缺少可用于 live spu-info 的源店或 SPU，无法核验。'] : [],
      evidence: {status: 'skipped_missing_source_store_or_spu', sourceStore, sourceSkc, spuName},
      call: null,
      calls: [],
    };
  }
  if (!exactSourceLock && existingLanguages.has('en') && existingLanguages.has('ar')) {
    return {
      payload,
      applied: [],
      warnings: [],
      blockers: [],
      evidence: {status: 'skipped_payload_already_has_en_ar', sourceStore, sourceSkc, spuName},
      call: null,
      calls: [],
    };
  }
  const source = openApiClientForStore(config, sourceStore);
  if (!source?.client) {
    return {
      payload,
      applied: [],
      warnings: exactSourceLock ? [] : [`源店 ${sourceStore} 未配置可用 OpenAPI 只读凭据，无法现场补源链接多语言标题。`],
      blockers: exactSourceLock ? [`精确源链接 ${sourceStore}/${sourceSkc} 缺少源店 OpenAPI 只读凭据，无法 live 核验。`] : [],
      evidence: {status: 'skipped_missing_source_openapi_credentials', sourceStore, sourceSkc, spuName},
      call: null,
      calls: [],
    };
  }
  let resolvedSpuName = spuName;
  const calls = [];
  if (!spuName && exactSourceLock) {
    const resolved = await resolveSourceSpuByExactSkc(source.client, sourceStore, sourceSkc);
    calls.push(resolved.call);
    if (!resolved.ok) {
      const reasonText = resolved.reason === 'ambiguous'
        ? `同源店 SKC ${sourceSkc} 在 searchProduct 命中多个 SPU（${(resolved.spus || []).join('、')}），无法确证`
        : resolved.reason === 'not_found'
          ? `源店 ${sourceStore} searchProduct 未找到大小写精确匹配的 SKC ${sourceSkc}`
          : `源店 SKC 解析查询失败：${resolved.error || '未知错误'}`;
      return {
        payload,
        applied: [],
        warnings: [],
        blockers: [`精确源链接 ${sourceStore}/${sourceSkc} ${reasonText}，无法 live 核验。`],
        evidence: {status: `source_spu_resolve_${resolved.reason}`, sourceStore, sourceSkc, error: resolved.error || '', spus: resolved.spus || []},
        call: resolved.call,
        calls,
      };
    }
    resolvedSpuName = resolved.spuName;
  }
  let response = null;
  try {
    response = await source.client.request('/open-api/goods/spu-info', {
      method: 'POST',
      body: {spuName: resolvedSpuName, languageList: ['en', 'ar']},
      headers: {language: 'en'},
    });
  } catch (err) {
    return {
      payload,
      applied: [],
      warnings: exactSourceLock ? [] : [`现场读取源链接多语言标题失败：${sourceStore}/${spuName} ${safeString(err?.message || err, 300)}`],
      blockers: exactSourceLock ? [`精确源链接 ${sourceStore}/${sourceSkc} live 详情读取失败：${safeString(err?.message || err, 300)}`] : [],
      evidence: {status: 'query_failed', sourceStore, sourceSkc, spuName, error: safeString(err?.message || err, 300)},
      call: null,
      calls,
    };
  }
  const call = compactCallResult('source-spu-info-live', '/open-api/goods/spu-info', 'POST', response);
  calls.push(call);
  const evidence = {
    status: response.ok && String(response.data?.code) === '0' ? 'ok' : 'not_ok',
    sourceStore,
    sourceSkc,
    spuName: resolvedSpuName,
    spuResolvedBySearch: Boolean(!spuName && exactSourceLock),
    httpStatus: response.status,
    code: response.data?.code ?? null,
    msg: response.data?.msg ?? null,
  };
  if (!response.ok || String(response.data?.code) !== '0') {
    return {
      payload,
      applied: [],
      warnings: exactSourceLock ? [] : [`现场读取源链接多语言标题失败：code=${safeString(response.data?.code || '', 80)} msg=${safeString(response.data?.msg || response.statusText || '', 300)}`],
      blockers: exactSourceLock ? [`精确源链接 ${sourceStore}/${sourceSkc} live 详情返回失败：code=${safeString(response.data?.code || '', 80)}`] : [],
      evidence,
      call,
      calls,
    };
  }
  const liveSkcMatched = liveSourceSkcMatches(response.data?.info || {}, sourceSkc);
  evidence.sourceSkcMatched = liveSkcMatched;
  if (exactSourceLock && !liveSkcMatched) {
    return {
      payload,
      applied: [],
      warnings: [],
      blockers: [`精确源链接 live 详情与锁定 SKC 不一致：${sourceStore}/${sourceSkc}。`],
      evidence: {...evidence, status: 'source_skc_mismatch'},
      call,
      calls,
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
      blockers: [],
      evidence: {...evidence, status: 'ok_no_new_names'},
      call,
      calls,
    };
  }
  return {
    payload: merged.payload,
    applied: merged.applied,
    warnings: [],
    blockers: [],
    evidence,
    call,
    calls,
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

function isSha256PayloadHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function preflightProductLockFromRow(row, targetStore = '', fallback = {}) {
  const resultField = ownObjectField(row, 'result');
  if (resultField.present && !resultField.valid) return null;
  const result = resultField.present ? resultField.value : row;
  if (!result || typeof result !== 'object') return null;
  const storeKeyField = firstOwnField([
    [result, 'storeKey'],
    [row, 'storeKey'],
    [fallback, 'storeKey'],
  ]);
  if (!storeKeyField.present) return null;
  const rawStoreKey = storeKeyField.value;
  if (!validSourceStoreKey(rawStoreKey)) return null;
  const storeKey = rawStoreKey;
  if (targetStore && storeKey !== normalizeStoreKey(targetStore)) return null;
  const payloadField = ownObjectField(result, 'payload');
  if (payloadField.present && !payloadField.valid) return null;
  const payload = payloadField.present ? payloadField.value : {};
  const summaryField = firstOwnField([
    [payload, 'summary'],
    [result, 'payloadSummary'],
    [fallback, 'payloadSummary'],
  ]);
  if (summaryField.present && (!summaryField.value || typeof summaryField.value !== 'object' || Array.isArray(summaryField.value))) return null;
  const summary = summaryField.present ? summaryField.value : {};
  const fingerprintField = firstOwnField([
    [result, 'readbackFingerprint'],
    [fallback, 'readbackFingerprint'],
  ]);
  if (fingerprintField.present && (!fingerprintField.value || typeof fingerprintField.value !== 'object' || Array.isArray(fingerprintField.value))) return null;
  const fingerprint = fingerprintField.present ? fingerprintField.value : {};
  const inferredSourceField = ownObjectField(payload, 'inferredSource');
  if (inferredSourceField.present && !inferredSourceField.valid) return null;
  const inferredAliasField = inferredSourceField.present ? {present: false, valid: true, value: null} : ownObjectField(payload, 'inferred');
  if (inferredAliasField.present && !inferredAliasField.valid) return null;
  const inferred = inferredSourceField.present ? inferredSourceField.value : (inferredAliasField.present ? inferredAliasField.value : {});
  const generatedField = ownObjectField(payload, 'generatedDraft');
  if (generatedField.present && !generatedField.valid) return null;
  const generated = generatedField.present ? generatedField.value : {};
  const hasTopLevelSourceDetailLock = Object.prototype.hasOwnProperty.call(payload, 'sourceDetailLock');
  const hasGeneratedSourceDetailLock = Object.prototype.hasOwnProperty.call(generated, 'sourceDetailLock');
  let sourceDetailLock = null;
  if (hasTopLevelSourceDetailLock) {
    if (!payload.sourceDetailLock || typeof payload.sourceDetailLock !== 'object' || Array.isArray(payload.sourceDetailLock)) return null;
    sourceDetailLock = payload.sourceDetailLock;
  } else if (hasGeneratedSourceDetailLock) {
    if (!generated.sourceDetailLock || typeof generated.sourceDetailLock !== 'object' || Array.isArray(generated.sourceDetailLock)) return null;
    sourceDetailLock = generated.sourceDetailLock;
  }
  let sourcePair = null;
  for (const [owner, storeField, skcField] of [
    [inferred, 'sourceStore', 'sourceSkc'],
    [generated, 'sourceStore', 'sourceSkc'],
    [fingerprint, 'inferredSourceStore', 'inferredSourceSkc'],
    [result, 'sourceStore', 'sourceSkc'],
    [fallback, 'sourceStore', 'sourceSkc'],
  ]) {
    const hasStore = owner && typeof owner === 'object' && Object.prototype.hasOwnProperty.call(owner, storeField);
    const hasSkc = owner && typeof owner === 'object' && Object.prototype.hasOwnProperty.call(owner, skcField);
    if (!hasStore && !hasSkc) continue;
    if (!hasStore || !hasSkc) return null;
    sourcePair = {sourceStore: owner[storeField], sourceSkc: owner[skcField]};
    break;
  }
  if (!sourcePair) return null;
  const rawSourceStore = sourcePair.sourceStore;
  const rawSourceSkc = sourcePair.sourceSkc;
  if (!validSourceStoreKey(rawSourceStore) || !validSourceSkc(rawSourceSkc)) return null;
  const sourceStore = normalizeStoreKey(rawSourceStore);
  const sourceSkc = safeString(rawSourceSkc, 160);
  let hashPair = null;
  for (const owner of [payload, result, fallback]) {
    const hasHash = owner && typeof owner === 'object' && Object.prototype.hasOwnProperty.call(owner, 'payloadHash');
    const hasAlgorithm = owner && typeof owner === 'object' && Object.prototype.hasOwnProperty.call(owner, 'payloadHashAlgorithm');
    if (!hasHash && !hasAlgorithm) continue;
    if (!hasHash || !hasAlgorithm) return null;
    hashPair = {payloadHash: owner.payloadHash, payloadHashAlgorithm: owner.payloadHashAlgorithm};
    break;
  }
  if (!hashPair) return null;
  const rawPayloadHash = hashPair.payloadHash;
  const rawPayloadHashAlgorithm = hashPair.payloadHashAlgorithm;
  if (typeof rawPayloadHash !== 'string' || typeof rawPayloadHashAlgorithm !== 'string') return null;
  const payloadHash = rawPayloadHash;
  const payloadHashAlgorithm = rawPayloadHashAlgorithm;
  if (!sourceStore || !sourceSkc || !isSha256PayloadHash(payloadHash)
    || payloadHashAlgorithm !== PRODUCT_EXECUTION_HASH_ALGORITHM) return null;
  if (!validRecoverableSourceDetailLock(sourceDetailLock, sourceSkc)) return null;
  const sourceDetailHash = safeString(
    payload.sourceDetailHash
    || sourceDetailLock.sourceDetailHash
    || generated.sourceDetailHash
    || generated.openApiDetail?.sourceDetailHash
    || '',
    120,
  );
  return {
    storeKey,
    sourceStore,
    sourceSkc,
    standardGoodsSn: safeString(inferred.standardGoodsSn || fallback.standardGoodsSn || '', 240),
    hopeOnSaleDate: safeString(summary.hopeOnSaleDate || summary.hope_on_sale_date || fallback.hopeOnSaleDate || '', 80),
    payloadHash,
    payloadHashAlgorithm,
    sourceDetailHash,
    sourceDetailLock,
    lockedAt: safeString(fallback.lockedAt || result.endedAt || result.startedAt || '', 80),
    runId: safeString(result.runId || fallback.runId || '', 120),
    source: 'preflight_product_lock',
  };
}

function resolvePreflightProductLock(task, targetStore = '', {expectedPayloadHash = ''} = {}) {
  const target = normalizeStoreKey(targetStore);
  if (expectedPayloadHash !== '' && (typeof expectedPayloadHash !== 'string' || !isSha256PayloadHash(expectedPayloadHash))) return null;
  const expected = expectedPayloadHash;
  const candidates = [];
  const executionField = ownObjectField(task, 'execution');
  if (executionField.present && !executionField.valid) return null;
  const execution = executionField.present ? executionField.value : {};
  const currentStateField = firstOwnField([[execution, 'state']]);
  if (currentStateField.present && typeof currentStateField.value !== 'string') return null;
  const currentState = currentStateField.present ? currentStateField.value : '';
  const preflightField = ownObjectField(execution, 'preflight');
  if (preflightField.present && !preflightField.valid) return null;
  const currentReady = preflightField.value?.ok === true
    && (currentState === 'preflight_ready' || currentState === 'ready_for_submit');
  if (currentReady) {
    if (!Array.isArray(execution.openApiProductExecutors)) return null;
    for (const row of execution.openApiProductExecutors) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      const resultField = ownObjectField(row, 'result');
      if (resultField.present && !resultField.valid) return null;
      const rowStateField = firstOwnField([
        [row, 'state'],
        [resultField.present ? resultField.value : null, 'state'],
      ]);
      if (!rowStateField.present || typeof rowStateField.value !== 'string') return null;
      const state = rowStateField.value;
      if (state !== 'preflight_ready' && state !== 'ready_for_submit') continue;
      const lock = preflightProductLockFromRow(row, target);
      if (lock) candidates.push(lock);
    }
  }
  const history = task && typeof task === 'object' && Object.prototype.hasOwnProperty.call(task, 'history')
    ? task.history
    : [];
  if (!Array.isArray(history)) return null;
  for (const event of [...history].reverse()) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
    if (Object.prototype.hasOwnProperty.call(event, 'event') && typeof event.event !== 'string') return null;
    if (event.event !== 'openapi_product_preflight_ready') continue;
    const writeAuditField = ownObjectField(event, 'writeAudit');
    if (writeAuditField.present && !writeAuditField.valid) return null;
    const auditRows = writeAuditField.present && Object.prototype.hasOwnProperty.call(writeAuditField.value, 'executorEvidence')
      ? writeAuditField.value.executorEvidence
      : [];
    const historyRows = Object.prototype.hasOwnProperty.call(event, 'openApiProductExecutors')
      ? event.openApiProductExecutors
      : [];
    if (!Array.isArray(auditRows) || !Array.isArray(historyRows)) return null;
    const rows = [
      ...auditRows.map(row => ({row, requireOk: true})),
      ...historyRows.map(row => ({row, requireOk: false})),
    ];
    for (const {row, requireOk} of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      if (!Object.prototype.hasOwnProperty.call(row, 'state') || typeof row.state !== 'string') return null;
      if (row.state !== 'preflight_ready' && row.state !== 'ready_for_submit') continue;
      if (requireOk && row.ok !== true) continue;
      const lock = preflightProductLockFromRow(row, target, {
        lockedAt: event?.at || '',
        runId: event?.runId || '',
      });
      if (lock) candidates.push(lock);
    }
  }
  const seen = new Set();
  for (const lock of candidates) {
    const key = `${lock.storeKey}|${lock.sourceStore}|${lock.sourceSkc}|${lock.payloadHashAlgorithm}|${lock.payloadHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (expected && lock.payloadHash !== expected) continue;
    return lock;
  }
  return null;
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

function deterministicIntInclusive(min, max, seed) {
  const lo = Math.ceil(Number(min));
  const hi = Math.floor(Number(max));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return lo;
  const range = BigInt(hi - lo + 1);
  const digest = crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest();
  return lo + Number(digest.readBigUInt64BE(0) % range);
}

function taskRandomizationSeed(task, executionContext, targetStore, purpose) {
  const taskId = safeString(firstNonEmpty(task?.id, executionContext?.taskId, executionContext?.parentTaskId), 160);
  return sha256Stable({
    purpose,
    targetStore: normalizeStoreKey(targetStore),
    taskId,
    standardGoodsSn: taskStandardGoodsSn(task, executionContext),
    sourceStore: normalizeStoreKey(firstNonEmpty(task?.sourceStore, executionContext?.sourceStore, executionContext?.targets?.sourceStore)),
    sourceSkc: safeString(firstNonEmpty(task?.sourceSkc, task?.skc, executionContext?.sourceSkc, executionContext?.targets?.sourceSkc), 160),
    createdAt: taskId ? '' : safeString(firstNonEmpty(task?.createdAt, executionContext?.taskCreatedAt, executionContext?.createdAt), 80),
  });
}

function storePriceBucket({minCents, maxCents, targetStore}) {
  const storeKey = normalizeStoreKey(targetStore);
  const storeKeys = STORES.map(row => normalizeStoreKey(row?.storeKey)).filter(Boolean);
  const storeIndex = storeKeys.indexOf(storeKey);
  const count = maxCents - minCents + 1;
  if (storeIndex < 0 || count < storeKeys.length || !storeKeys.length) return {minCents, maxCents};
  const bucketStart = Math.floor(storeIndex * count / storeKeys.length);
  const bucketEnd = Math.floor((storeIndex + 1) * count / storeKeys.length) - 1;
  return {
    minCents: minCents + bucketStart,
    maxCents: minCents + Math.max(bucketStart, bucketEnd),
  };
}

function randomPriceInRange(range, targetStore = '', seed = '') {
  const min = Number(range?.min ?? range?.from ?? range?.low);
  const max = Number(range?.max ?? range?.to ?? range?.high);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) return null;
  const bucket = storePriceBucket({minCents: Math.round(min * 100), maxCents: Math.round(max * 100), targetStore});
  const cents = deterministicIntInclusive(bucket.minCents, bucket.maxCents, seed);
  return (cents / 100).toFixed(2);
}

function taskSupplyPriceRange(task, executionContext = {}, targetStore = '') {
  const candidates = [
    task?.supplyPriceRange,
    task?.supply_price_range,
    task?.targets?.supplyPriceRange,
    task?.targets?.supply_price_range,
    executionContext?.supplyPriceRange,
    executionContext?.supply_price_range,
    executionContext?.targets?.supplyPriceRange,
    executionContext?.targets?.supply_price_range,
  ];
  for (const candidate of candidates) {
    const seed = taskRandomizationSeed(task, executionContext, targetStore, 'supply_price');
    const price = randomPriceInRange(candidate, targetStore, seed);
    if (price !== null) {
      return {
        min: Number(candidate?.min ?? candidate?.from ?? candidate?.low),
        max: Number(candidate?.max ?? candidate?.to ?? candidate?.high),
        __randomCostPrice: price,
        __randomSeedHash: seed.slice(0, 16),
      };
    }
  }
  return null;
}

function applyRandomSupplyPrice(payload, task, executionContext, targetStore) {
  const range = taskSupplyPriceRange(task, executionContext, targetStore);
  if (!range) return {payload, applied: [], evidence: null};
  const costPrice = range.__randomCostPrice;
  const next = jsonClone(payload || {});
  const applied = [];
  for (const [skcIndex, skc] of asArray(next.skc_list || next.skcList).entries()) {
    for (const [skuIndex, sku] of asArray(skc?.sku_list || skc?.skuList).entries()) {
      if (!sku || typeof sku !== 'object') continue;
      const costInfo = sku.cost_info || sku.costInfo || {};
      sku.cost_info = {
        ...costInfo,
        currency: safeString(costInfo.currency || 'SAR', 20) || 'SAR',
        cost_price: costPrice,
      };
      if ('costInfo' in sku) delete sku.costInfo;
      applied.push(`skc_list[${skcIndex}].sku_list[${skuIndex}].cost_info.cost_price.randomized`);
    }
  }
  return {
    payload: next,
    applied: [...new Set(applied)],
    evidence: {
      storeKey: normalizeStoreKey(targetStore),
      min: range.min,
      max: range.max,
      currency: 'SAR',
      costPrice,
      perStoreRandomized: true,
      deterministicAcrossPreflightAndExecute: true,
      seedHash: range.__randomSeedHash,
    },
  };
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
  if (attributeId === INPUT_CURRENT_ATTRIBUTE_ID) {
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

function textFromPayloadForAttributeInference(payload, task, executionContext) {
  return [
    taskTextForKnownRules(task, executionContext),
    ...asArray(payload?.multi_language_name_list || payload?.multiLanguageNameList)
      .flatMap(row => [row?.name, row?.product_name, row?.productName, row?.value]),
    ...asArray(payload?.skc_list || payload?.skcList)
      .flatMap(skc => [skc?.sale_name, skc?.saleName, skc?.skc_name, skc?.skcName, skc?.supplier_code, skc?.supplierCode]),
  ].map(v => safeString(v, 300)).filter(Boolean).join(' ');
}

function isAirFryerTaskOrPayload(payload, task, executionContext) {
  return /空气炸锅|air\s*fryer/i.test(textFromPayloadForAttributeInference(payload, task, executionContext));
}

function payloadHasInputVoltageRequiringPowerSupply(payload) {
  const rows = asArray(payload?.product_attribute_list || payload?.productAttributeList);
  const powerSupply = rows.find(row => normalizeAttributeId(row?.attribute_id ?? row?.attributeId) === POWER_SUPPLY_ATTRIBUTE_ID);
  const valueId = normalizeAttributeId(powerSupply?.attribute_value_id ?? powerSupply?.attributeValueId);
  return POWER_SUPPLY_INPUT_VOLTAGE_VALUE_IDS.has(valueId);
}

function payloadHasInputCurrent(payload) {
  return asArray(payload?.product_attribute_list || payload?.productAttributeList).some(row => {
    if (normalizeAttributeId(row?.attribute_id ?? row?.attributeId) !== INPUT_CURRENT_ATTRIBUTE_ID) return false;
    return Boolean(safeString(row?.attribute_extra_value ?? row?.attributeExtraValue ?? row?.attribute_value ?? row?.attributeValue ?? '', 120));
  });
}

function parsePowerWatts(value) {
  const text = safeString(value, 240);
  if (!text) return null;
  const watt = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:w|瓦|瓦特)\b/i);
  const raw = watt || text.match(/\b([0-9]{3,4}(?:\.[0-9]+)?)\b/);
  if (!raw) return null;
  const n = Number(raw[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseVoltageNumber(value) {
  const text = safeString(value, 120);
  const range = text.match(/([0-9]{2,3}(?:\.[0-9]+)?)\s*V?\s*[-–—~]\s*([0-9]{2,3}(?:\.[0-9]+)?)\s*V?/i);
  if (range) return Number(range[1]);
  const single = text.match(/([0-9]{2,3}(?:\.[0-9]+)?)\s*V/i);
  return single ? Number(single[1]) : null;
}

function inferPowerWattsFromPayload(payload) {
  for (const item of collectPayloadAttributeRows(payload)) {
    const row = item.row;
    const name = safeString(row.attribute_name ?? row.attributeName ?? row.name ?? row.label ?? '', 160);
    const values = [
      row.attribute_extra_value,
      row.attributeExtraValue,
      row.attribute_value,
      row.attributeValue,
      row.attribute_value_name,
      row.attributeValueName,
    ];
    if (/power|wattage|rated\s*power|功率|额定功率/i.test(name)) {
      for (const value of values) {
        const watts = parsePowerWatts(value);
        if (watts) return {watts, source: item.source, source_attribute_id: item.attributeId, source_name: name};
      }
    }
    for (const value of values) {
      const text = safeString(value, 240);
      if (/w|瓦|瓦特/i.test(text)) {
        const watts = parsePowerWatts(text);
        if (watts) return {watts, source: item.source, source_attribute_id: item.attributeId, source_name: name};
      }
    }
  }
  return null;
}

function inferInputCurrentOverride(payload, task, executionContext) {
  if (!payloadHasInputVoltageRequiringPowerSupply(payload) || payloadHasInputCurrent(payload)) return null;
  const voltage = inferInputVoltageFromPayload(payload, new Map());
  const voltageV = parseVoltageNumber(voltage?.attribute_extra_value || voltage?.source_value || '');
  const power = inferPowerWattsFromPayload(payload);
  if (power?.watts && voltageV && voltageV > 0) {
    return {
      attribute_id: INPUT_CURRENT_ATTRIBUTE_ID,
      attribute_extra_value: String(Math.round(power.watts * 1000 / voltageV)),
      attribute_unit: 'mA',
      label: '输入电流',
      source: `auto_power_voltage:${power.source_attribute_id || power.source || 'payload'}`,
    };
  }
  if (isAirFryerTaskOrPayload(payload, task, executionContext)) {
    return {
      attribute_id: INPUT_CURRENT_ATTRIBUTE_ID,
      attribute_extra_value: String(DEFAULT_AIR_FRYER_INPUT_CURRENT_MA),
      attribute_unit: 'mA',
      label: '输入电流',
      source: 'auto_air_fryer_default',
    };
  }
  return null;
}

function collectManualAttributeOverrides(task, executionContext, payload = null) {
  const rows = [
    ...asArray(task?.targets?.attributeOverrides || task?.targets?.attribute_overrides),
    ...asArray(task?.manualAttributeOverrides || task?.manual_attribute_overrides),
    ...asArray(task?.attributeOverrides || task?.attribute_overrides),
    ...asArray(task?.publishPreparation?.attributeOverrides || task?.publishPreparation?.attribute_overrides),
    ...asArray(executionContext?.attributeOverrides || executionContext?.attribute_overrides),
    ...asArray(executionContext?.targets?.attributeOverrides || executionContext?.targets?.attribute_overrides),
    ...asArray(executionContext?.publishPreparation?.attributeOverrides || executionContext?.publishPreparation?.attribute_overrides),
  ].map(normalizeManualAttributeOverride).filter(Boolean);
  const autoInputCurrent = payload ? normalizeManualAttributeOverride(inferInputCurrentOverride(payload, task, executionContext)) : null;
  if (autoInputCurrent && !rows.some(row => Number(row.attribute_id) === INPUT_CURRENT_ATTRIBUTE_ID)) rows.push(autoInputCurrent);
  if (isKnownSm505SewingMachineTask(task, executionContext) && !rows.some(row => Number(row.attribute_id) === INPUT_CURRENT_ATTRIBUTE_ID)) {
    rows.push({
      attribute_id: INPUT_CURRENT_ATTRIBUTE_ID,
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
  const overrides = collectManualAttributeOverrides(task, executionContext, payload);
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

function templateAttributeValueLabel(templateRow, valueId) {
  const id = normalizeAttributeId(valueId);
  if (!id) return '';
  const value = asArray(templateRow?.attribute_value_info_list)
    .find(row => normalizeAttributeId(row?.attribute_value_id) === id);
  return safeString(value?.attribute_value || '', 160);
}

function extractVoltageRangeText(value) {
  const text = safeString(value, 200);
  if (!text) return '';
  const range = text.match(/([0-9]{2,3}(?:\.[0-9]+)?)\s*V?\s*[-–—~]\s*([0-9]{2,3}(?:\.[0-9]+)?)\s*V/i);
  if (range) return `${range[1]}-${range[2]}`;
  const single = text.match(/([0-9]{2,3}(?:\.[0-9]+)?)\s*V/i);
  return single ? single[1] : '';
}

function collectPayloadAttributeRows(payload) {
  const rows = [];
  const add = (row, source) => {
    if (!row || typeof row !== 'object') return;
    const attributeId = normalizeAttributeId(row.attribute_id ?? row.attributeId);
    if (!attributeId) return;
    rows.push({row, source, attributeId});
  };
  for (const row of asArray(payload?.product_attribute_list || payload?.productAttributeList)) add(row, 'product_attribute_list');
  for (const skc of asArray(payload?.skc_list || payload?.skcList)) {
    if (!skc || typeof skc !== 'object') continue;
    add(skc.sale_attribute || skc.saleAttribute, 'skc.sale_attribute');
    for (const row of asArray(skc.sale_attribute_list || skc.saleAttributeList)) add(row, 'skc.sale_attribute_list');
    for (const sku of asArray(skc.sku_list || skc.skuList)) {
      if (!sku || typeof sku !== 'object') continue;
      for (const row of asArray(sku.sale_attribute_list || sku.saleAttributeList)) add(row, 'sku.sale_attribute_list');
      for (const row of asArray(sku.product_sku_attribute_list || sku.productSkuAttributeList)) add(row, 'sku.product_sku_attribute_list');
    }
  }
  return rows;
}

function inferInputVoltageFromPayload(payload, templateById) {
  const rows = collectPayloadAttributeRows(payload);
  const priority = [
    PLUG_VOLTAGE_ATTRIBUTE_ID,
    VOLTAGE_ATTRIBUTE_ID,
    RATED_VOLTAGE_ATTRIBUTE_ID,
    VOLTAGE_VALUE_ATTRIBUTE_ID,
  ];
  for (const attributeId of priority) {
    for (const item of rows.filter(row => row.attributeId === attributeId || row.attribute_id === attributeId)) {
      const row = item.row;
      const template = templateById.get(attributeId);
      const valueId = normalizeAttributeId(row.attribute_value_id ?? row.attributeValueId);
      const candidates = [
        row.attribute_extra_value,
        row.attributeExtraValue,
        row.attribute_value,
        row.attributeValue,
        row.attribute_value_name,
        row.attributeValueName,
        templateAttributeValueLabel(template, valueId),
      ];
      for (const candidate of candidates) {
        const voltage = extractVoltageRangeText(candidate);
        if (voltage) {
          return {
            attribute_extra_value: voltage,
            source_attribute_id: attributeId,
            source_value_id: valueId || null,
            source_value: safeString(candidate, 160),
            source: item.source,
          };
        }
      }
    }
  }
  return null;
}

function chooseInputVoltageAcUnitValueId(templateRow) {
  const values = asArray(templateRow?.attribute_value_info_list);
  const normalizedTarget = INPUT_VOLTAGE_AC_UNIT_LABEL.toLowerCase().replace(/\s+/g, '');
  const exact = values.find(value => safeString(value.attribute_value, 80).toLowerCase().replace(/\s+/g, '') === normalizedTarget);
  if (exact?.attribute_value_id) return exact.attribute_value_id;
  const ac = values.find(value => /vac|v\s*ac/i.test(safeString(value.attribute_value, 80)));
  if (ac?.attribute_value_id) return ac.attribute_value_id;
  return values.length === 1 ? normalizeAttributeId(values[0]?.attribute_value_id) : null;
}

function ensurePowerSupplyInputVoltage(payload, productAttributeList, templateById) {
  const applied = [];
  const blockers = [];
  const powerSupply = productAttributeList.find(row => normalizeAttributeId(row.attribute_id ?? row.attributeId) === POWER_SUPPLY_ATTRIBUTE_ID);
  const powerSupplyValueId = normalizeAttributeId(powerSupply?.attribute_value_id ?? powerSupply?.attributeValueId);
  if (!POWER_SUPPLY_INPUT_VOLTAGE_VALUE_IDS.has(powerSupplyValueId)) return {applied, blockers, inputVoltageRequired: false};
  const powerSupplyTemplate = templateById.get(POWER_SUPPLY_ATTRIBUTE_ID);
  const powerSupplyLabel = templateAttributeValueLabel(powerSupplyTemplate, powerSupplyValueId) || String(powerSupplyValueId);
  let inputVoltage = productAttributeList.find(row => normalizeAttributeId(row.attribute_id ?? row.attributeId) === INPUT_VOLTAGE_ATTRIBUTE_ID);
  const existingExtra = safeString(inputVoltage?.attribute_extra_value ?? inputVoltage?.attributeExtraValue ?? '', 120);
  const existingValueId = normalizeAttributeId(inputVoltage?.attribute_value_id ?? inputVoltage?.attributeValueId);
  if (inputVoltage && existingExtra && existingValueId) return {applied, blockers, inputVoltageRequired: true};

  const template = templateById.get(INPUT_VOLTAGE_ATTRIBUTE_ID);
  if (!template) {
    blockers.push(`Power Supply=${powerSupplyLabel} 触发 Input voltage(${INPUT_VOLTAGE_ATTRIBUTE_ID}) 必填，但官方属性模板未返回该属性，不能自动补齐。`);
    return {applied, blockers, inputVoltageRequired: true};
  }
  // P1 contract: when the official template returns a Vac unit value id that
  // differs from the controlled catalog mapping 301114341, the conflicting
  // template id must never be adopted. Block with unit_value_id_conflict.
  const templateVacValueId = chooseInputVoltageAcUnitValueId(template);
  if (templateVacValueId && templateVacValueId !== INPUT_VOLTAGE_AC_VALUE_ID) {
    blockers.push(`Power Supply=${powerSupplyLabel} 触发 Input voltage(${INPUT_VOLTAGE_ATTRIBUTE_ID}) 必填；官方模板返回的 Vac 单位值 ID(${templateVacValueId}) 与受控目录映射(${INPUT_VOLTAGE_AC_VALUE_ID}) 冲突，不能采用模板值，必须人工补充。`);
    return {applied, blockers, inputVoltageRequired: true, unitValueIdConflict: templateVacValueId};
  }
  const inferred = inferInputVoltageFromPayload(payload, templateById);
  if (!inferred?.attribute_extra_value) {
    blockers.push(`Power Supply=${powerSupplyLabel} 触发 Input voltage(${INPUT_VOLTAGE_ATTRIBUTE_ID}) 必填，但无法从 Plug(Voltage)/Voltage 属性推导电压范围；请补充 Input voltage。`);
    return {applied, blockers, inputVoltageRequired: true};
  }
  const unitValueId = existingValueId || templateVacValueId;
  if (!unitValueId) {
    blockers.push(`Power Supply=${powerSupplyLabel} 触发 Input voltage(${INPUT_VOLTAGE_ATTRIBUTE_ID}) 必填，已推导 ${inferred.attribute_extra_value}，但无法从官方属性模板匹配 Vac 单位值 ID。`);
    return {applied, blockers, inputVoltageRequired: true};
  }

  if (!inputVoltage) {
    inputVoltage = {attribute_id: INPUT_VOLTAGE_ATTRIBUTE_ID};
    productAttributeList.push(inputVoltage);
  }
  inputVoltage.attribute_id = INPUT_VOLTAGE_ATTRIBUTE_ID;
  inputVoltage.attribute_value_id = unitValueId;
  inputVoltage.attribute_extra_value = inferred.attribute_extra_value;
  delete inputVoltage.attributeValueId;
  delete inputVoltage.attributeExtraValue;
  delete inputVoltage.attribute_value;
  delete inputVoltage.attributeValue;
  applied.push(`attribute_template:${INPUT_VOLTAGE_ATTRIBUTE_ID}.required_by_power_supply_${powerSupplyValueId}=${inferred.attribute_extra_value}`);
  return {applied, blockers, inputVoltageRequired: true};
}

function payloadAttributeHasValue(row) {
  if (!row || typeof row !== 'object') return false;
  const valueId = normalizeAttributeId(row.attribute_value_id ?? row.attributeValueId);
  const extraValue = safeString(
    row.attribute_extra_value
    ?? row.attributeExtraValue
    ?? row.attribute_value
    ?? row.attributeValue
    ?? '',
    500,
  );
  return Boolean(valueId || extraValue);
}

function listHasFilledInputVoltage(list) {
  return list.some(row => normalizeAttributeId(row?.attribute_id ?? row?.attributeId) === INPUT_VOLTAGE_ATTRIBUTE_ID && payloadAttributeHasValue(row));
}

function resolveExplicitSameProductIdentity(rawCodes) {
  const values = asArray(rawCodes).map(normalizeSupplierIdentity).filter(Boolean);
  if (!values.length) return {ok: false, canonical: '', resolutions: []};
  const resolutions = values.map(value => ({value, ...resolveExplicitProductAlias(PRODUCT_ALIAS_CONTEXT, value)}));
  if (resolutions.some(row => row.ok !== true || !row.canonical)) {
    return {ok: false, canonical: '', resolutions};
  }
  const canonicals = [...new Set(resolutions.map(row => row.canonical))];
  return {
    ok: canonicals.length === 1,
    canonical: canonicals.length === 1 ? canonicals[0] : '',
    resolutions,
  };
}

function sourcePayloadSupplierCodesForProvenance(payloadFound, publishStandardPayload) {
  if (payloadFound?.exactSourceLock === true) {
    return [...new Set(asArray(payloadFound?.sourcePayloadSupplierCodes).map(normalizeSupplierIdentity).filter(Boolean))];
  }
  return publishTargetSupplierCodes(publishStandardPayload);
}

/**
 * Owner-authorized fail-closed provenance lookup: when Input voltage(1002322)
 * is required by the target template path but cannot be filled authoritatively,
 * the ONLY permitted source is the same standard goods number on other OpenAPI
 * links. The extracted attribute/value pair must carry provenance (source SPU,
 * SKC, value id and extra value). No text guessing and no hardcoded values:
 * missing, ambiguous or different-goods-number sources keep the blocker.
 */
function chooseNonDangerousGoodsValueId(templateRow) {
  const values = asArray(templateRow?.attribute_value_info_list);
  const exact = values.find(value => /this product is not classified as dangerous goods/i.test(safeString(value?.attribute_value, 240)));
  if (exact?.attribute_value_id) return normalizeAttributeId(exact.attribute_value_id);
  const fallback = values.find(value => /not (?:classified as )?dangerous goods|non[-\s]?dangerous/i.test(safeString(value?.attribute_value, 240)));
  return normalizeAttributeId(fallback?.attribute_value_id);
}

function payloadIndicatesNonDangerousGoods(productAttributeList, templateById) {
  const hazardCategory = productAttributeList.find(row => normalizeAttributeId(row.attribute_id ?? row.attributeId) === HAZARD_CATEGORY_ATTRIBUTE_ID);
  const hazardCategoryValueId = normalizeAttributeId(hazardCategory?.attribute_value_id ?? hazardCategory?.attributeValueId);
  if (hazardCategoryValueId === HAZARD_CATEGORY_NON_TRANSPORT_SENSITIVE_VALUE_ID) return true;
  const hazardCategoryLabel = templateAttributeValueLabel(templateById.get(HAZARD_CATEGORY_ATTRIBUTE_ID), hazardCategoryValueId);
  return /non[-\s]?transport sensitive|not (?:classified as )?dangerous goods|non[-\s]?dangerous/i.test(hazardCategoryLabel);
}

function ensureHazardousMaterialsClassification(productAttributeList, templateById) {
  const applied = [];
  const blockers = [];
  const template = templateById.get(HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID);
  if (!template) return {applied, blockers};
  let classification = productAttributeList.find(row => normalizeAttributeId(row.attribute_id ?? row.attributeId) === HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID);
  if (payloadAttributeHasValue(classification)) return {applied, blockers};
  if (!payloadIndicatesNonDangerousGoods(productAttributeList, templateById)) return {applied, blockers};
  const valueId = chooseNonDangerousGoodsValueId(template);
  if (!valueId) {
    blockers.push(`Hazardous materials classification(${HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID}) 为官方模板必填项，源商品已标记为非运输敏感物品，但模板中找不到“非危险品”选项。`);
    return {applied, blockers};
  }
  if (!classification) {
    classification = {attribute_id: HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID};
    productAttributeList.push(classification);
  }
  classification.attribute_id = HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID;
  classification.attribute_value_id = valueId;
  delete classification.attributeValueId;
  delete classification.attribute_extra_value;
  delete classification.attributeExtraValue;
  delete classification.attribute_value;
  delete classification.attributeValue;
  applied.push(`attribute_template:${HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID}.non_dangerous_from_hazard_category=${valueId}`);
  return {applied, blockers};
}

function requiredTemplateAttributeBlockers(productAttributeList, templates) {
  const blockers = [];
  for (const template of templates) {
    if (Number(template?.attribute_status) !== 3) continue;
    const attributeId = normalizeAttributeId(template?.attribute_id);
    if (!attributeId) continue;
    const row = productAttributeList.find(item => normalizeAttributeId(item?.attribute_id ?? item?.attributeId) === attributeId);
    if (payloadAttributeHasValue(row)) continue;
    blockers.push(`${template.attribute_name || `商品属性 ${attributeId}`}(${attributeId}) 是 SHEIN 官方商品类型模板的必填属性，当前发布资料未填写。`);
  }
  return blockers;
}

function summarizeProductAttributes(productAttributeList, templateById) {
  return productAttributeList.map(row => {
    const attributeId = normalizeAttributeId(row?.attribute_id ?? row?.attributeId);
    const valueId = normalizeAttributeId(row?.attribute_value_id ?? row?.attributeValueId);
    const template = attributeId ? templateById.get(attributeId) : null;
    return {
      attributeId,
      attributeName: safeString(template?.attribute_name || row?.attribute_name || row?.attributeName || '', 160),
      attributeValueId: valueId,
      attributeValue: valueId ? templateAttributeValueLabel(template, valueId) : '',
      attributeExtraValue: safeString(row?.attribute_extra_value ?? row?.attributeExtraValue ?? '', 160),
    };
  }).filter(row => row.attributeId);
}

function exactSourceRequiresHazardTemplateDerivation(payload, sourceContext = {}) {
  if (sourceContext?.copyProductDraft !== true || sourceContext?.exactSourceLock !== true) return false;
  const list = asArray(payload?.product_attribute_list || payload?.productAttributeList)
    .filter(row => row && typeof row === 'object');
  const hazardRows = list.filter(row => normalizeAttributeId(row?.attribute_id ?? row?.attributeId) === HAZARD_CATEGORY_ATTRIBUTE_ID);
  const classificationRows = list.filter(row => normalizeAttributeId(row?.attribute_id ?? row?.attributeId) === HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID);
  return hazardRows.length === 1
    && normalizeAttributeId(hazardRows[0]?.attribute_value_id ?? hazardRows[0]?.attributeValueId) === HAZARD_CATEGORY_NON_TRANSPORT_SENSITIVE_VALUE_ID
    && !classificationRows.some(payloadAttributeHasValue);
}

function shouldIssuePublishOrEdit(mode, readyForSubmit) {
  return mode === 'execute' && readyForSubmit === true;
}

function hazardousMaterialsTemplateBlocker(reason) {
  return `精确源商品已标记 Hazard Category(${HAZARD_CATEGORY_ATTRIBUTE_ID})=${HAZARD_CATEGORY_NON_TRANSPORT_SENSITIVE_VALUE_ID} 且缺少 Hazardous materials classification(${HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID})；${reason}，无法按官方模板确定性补值，禁止发布。`;
}

async function applyAttributeTemplateRules(client, payload, sourceContext = {}) {
  const requiresHazardTemplateDerivation = exactSourceRequiresHazardTemplateDerivation(payload, sourceContext);
  const productTypeId = payloadProductTypeId(payload);
  if (!productTypeId) return {
    payload,
    applied: [],
    warnings: [],
    blockers: requiresHazardTemplateDerivation
      ? [hazardousMaterialsTemplateBlocker('源 payload 缺少 product_type_id，不能查询官方属性模板')]
      : [],
    evidence: {status: 'skipped_missing_product_type_id'},
    call: null,
  };
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
      blockers: requiresHazardTemplateDerivation
        ? [hazardousMaterialsTemplateBlocker('官方属性模板请求异常')]
        : [],
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
      blockers: requiresHazardTemplateDerivation
        ? [hazardousMaterialsTemplateBlocker('官方属性模板返回失败')]
        : [],
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
  if (requiresHazardTemplateDerivation && !byId.has(HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID)) {
    blockers.push(hazardousMaterialsTemplateBlocker(`官方模板缺少属性 ${HAZARDOUS_MATERIALS_CLASSIFICATION_ATTRIBUTE_ID}`));
  }
  const powerSupplyInputVoltage = ensurePowerSupplyInputVoltage(next, list, byId);
  if (powerSupplyInputVoltage.inputVoltageRequired && !listHasFilledInputVoltage(list)) {
    // Locked owner authorization: ONLY a copy_product_draft task whose source
    // is the exact findOrBuild source lock (sourceStore + sourceSkc present,
    // exactSourceLock) and whose target standard goods number either exactly
    // equals the source payload supplier identity or all identities resolve to
    // one explicit, reviewed catalog alias may derive Input voltage(1002322) from the
    // locked source payload's official Plug(Voltage)/Voltage attributes. No
    // target-store live fallback exists anymore. The range is parsed with the
    // existing deterministic inference and the unit value id reuses the
    // controlled catalog mapping 301114341; missing intent/source/imprecise
    // source/goods-number mismatch/unresolvable range/template unit-id conflict
    // all keep the blocker.
    const lockedSourceStore = safeString(sourceContext?.sourceStore || '', 80);
    const lockedSourceSkc = safeString(sourceContext?.sourceSkc || '', 160);
    const lockedStandardGoodsSn = safeString(sourceContext?.standardGoodsSn || '', 160);
    const lockedStandardGoodsSnNormalized = normalizeSupplierIdentity(lockedStandardGoodsSn);
    const sourcePayloadCodes = [...new Set(asArray(sourceContext?.sourcePayloadSupplierCodes).map(normalizeSupplierIdentity).filter(Boolean))];
    const payloadCodes = [...new Set(publishTargetSupplierCodes(next).map(normalizeSupplierIdentity).filter(Boolean))];
    const strictIdentityMatches = sourcePayloadCodes.length === 1
      && payloadCodes.length === 1
      && sourcePayloadCodes[0] === lockedStandardGoodsSnNormalized
      && payloadCodes[0] === lockedStandardGoodsSnNormalized;
    const explicitAliasIdentity = strictIdentityMatches
      ? {ok: true, canonical: lockedStandardGoodsSnNormalized, resolutions: [], mode: 'strict_exact'}
      : {
          ...resolveExplicitSameProductIdentity([
            lockedStandardGoodsSnNormalized,
            sourcePayloadCodes.length === 1 ? sourcePayloadCodes[0] : '',
            payloadCodes.length === 1 ? payloadCodes[0] : '',
          ]),
          mode: 'explicit_alias_registry',
        };
    const provenanceAllowed = sourceContext?.copyProductDraft === true
      && sourceContext?.exactSourceLock === true
      && Boolean(lockedSourceStore)
      && Boolean(lockedSourceSkc)
      && Boolean(lockedStandardGoodsSn)
      && sourcePayloadCodes.length === 1
      && payloadCodes.length === 1
      && explicitAliasIdentity.ok === true;
    if (powerSupplyInputVoltage.unitValueIdConflict) {
      blockers.push(...powerSupplyInputVoltage.blockers);
      evidence.inputVoltageProvenance = {
        status: 'unit_value_id_conflict',
        source: 'locked_source_payload',
        templateVacValueId: powerSupplyInputVoltage.unitValueIdConflict,
        officialCatalogMapping: {attributeId: INPUT_VOLTAGE_ATTRIBUTE_ID, valueId: INPUT_VOLTAGE_AC_VALUE_ID, label: INPUT_VOLTAGE_AC_UNIT_LABEL},
      };
    } else if (!provenanceAllowed) {
      const reason = sourceContext?.copyProductDraft !== true
        ? '任务不是精确的 copy_product_draft 发布'
        : sourceContext?.exactSourceLock !== true || !lockedSourceStore || !lockedSourceSkc
          ? '来源不是本次 findOrBuild 的精确 source lock（缺 sourceStore/sourceSkc 或来源不精确）'
          : !lockedStandardGoodsSn || sourcePayloadCodes.length !== 1 || payloadCodes.length !== 1
            ? `标准货号缺失或不唯一（source=${sourcePayloadCodes.join('、') || '空'} payload=${payloadCodes.join('、') || '空'}）`
            : `源 payload 标准货号（${sourcePayloadCodes[0]}）与任务目标标准货号（${lockedStandardGoodsSnNormalized}）不一致`;
      blockers.push(`Power Supply 触发 Input voltage(${INPUT_VOLTAGE_ATTRIBUTE_ID}) 必填；${reason}，禁止从源 payload 推导补值，必须人工补充 Input voltage。`);
      evidence.inputVoltageProvenance = {
        status: 'blocked',
        reason,
        sourceStore: lockedSourceStore,
        sourceSkc: lockedSourceSkc,
        standardGoodsNumber: lockedStandardGoodsSn,
        sourcePayloadSupplierCodes: sourcePayloadCodes,
        payloadSupplierCodes: payloadCodes,
        identityResolutionMode: explicitAliasIdentity.mode,
        canonicalCode: explicitAliasIdentity.canonical,
      };
    } else {
      const payloadInferred = inferInputVoltageFromPayload(next, byId);
      const inputVoltageTemplate = byId.get(INPUT_VOLTAGE_ATTRIBUTE_ID);
      const templateVacValueId = inputVoltageTemplate ? chooseInputVoltageAcUnitValueId(inputVoltageTemplate) : null;
      if (payloadInferred?.attribute_extra_value && (!templateVacValueId || templateVacValueId === INPUT_VOLTAGE_AC_VALUE_ID)) {
        list.push({
          attribute_id: INPUT_VOLTAGE_ATTRIBUTE_ID,
          attribute_value_id: INPUT_VOLTAGE_AC_VALUE_ID,
          attribute_extra_value: payloadInferred.attribute_extra_value,
        });
        applied.push(
          `attribute_provenance:${INPUT_VOLTAGE_ATTRIBUTE_ID}.from_locked_source_payload.${payloadInferred.source_attribute_id}.${payloadInferred.source_value_id || ''}=${payloadInferred.attribute_extra_value}`,
          `official_catalog_mapping:${INPUT_VOLTAGE_ATTRIBUTE_ID}.vac_value_id=${INPUT_VOLTAGE_AC_VALUE_ID}`,
        );
        evidence.inputVoltageProvenance = {
          status: 'ok',
          source: 'locked_source_payload',
          sourceStore: lockedSourceStore,
          sourceSkc: lockedSourceSkc,
          standardGoodsNumber: lockedStandardGoodsSn,
          identityResolutionMode: explicitAliasIdentity.mode,
          canonicalCode: explicitAliasIdentity.canonical,
          sourceAttributeId: payloadInferred.source_attribute_id || null,
          sourceValueId: payloadInferred.source_value_id || null,
          sourceValue: safeString(payloadInferred.source_value, 160),
          unitValueIdSource: 'official_catalog_mapping',
          officialCatalogMapping: {attributeId: INPUT_VOLTAGE_ATTRIBUTE_ID, valueId: INPUT_VOLTAGE_AC_VALUE_ID, label: INPUT_VOLTAGE_AC_UNIT_LABEL},
        };
      } else if (payloadInferred?.attribute_extra_value && templateVacValueId) {
        blockers.push(`Power Supply 触发 Input voltage(${INPUT_VOLTAGE_ATTRIBUTE_ID}) 必填；源 payload 推导出的受控目录单位值 ID(${INPUT_VOLTAGE_AC_VALUE_ID}) 与官方模板返回的 Vac 单位值 ID(${templateVacValueId}) 冲突，无法确证，必须人工补充。`);
        evidence.inputVoltageProvenance = {
          status: 'unit_value_id_conflict',
          source: 'locked_source_payload',
          templateVacValueId,
          officialCatalogMapping: {attributeId: INPUT_VOLTAGE_ATTRIBUTE_ID, valueId: INPUT_VOLTAGE_AC_VALUE_ID, label: INPUT_VOLTAGE_AC_UNIT_LABEL},
        };
      } else {
        blockers.push(`Power Supply 触发 Input voltage(${INPUT_VOLTAGE_ATTRIBUTE_ID}) 必填；锁定源 payload 的官方 Plug(Voltage)/Voltage 属性无法推导电压范围，保持阻断，必须人工补充。`);
        evidence.inputVoltageProvenance = {
          status: 'unresolvable',
          source: 'locked_source_payload',
          sourceStore: lockedSourceStore,
          sourceSkc: lockedSourceSkc,
          standardGoodsNumber: lockedStandardGoodsSn,
        };
      }
    }
  } else {
    applied.push(...powerSupplyInputVoltage.applied);
    blockers.push(...powerSupplyInputVoltage.blockers);
  }
  const hazardousMaterialsClassification = ensureHazardousMaterialsClassification(list, byId);
  applied.push(...hazardousMaterialsClassification.applied);
  blockers.push(...hazardousMaterialsClassification.blockers);
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
  blockers.push(...requiredTemplateAttributeBlockers(list, templates));
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
      requiredAttributeIds: templates.filter(row => Number(row?.attribute_status) === 3).map(row => row.attribute_id),
      enrichedAttributeIds: applied.map(item => item.split(':')[1]?.split('.')[0]).filter(Boolean),
      finalProductAttributes: summarizeProductAttributes(list, byId),
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

function ensurePublishImageSortGlobalUnique(payload) {
  const next = jsonClone(payload || {});
  const applied = [];
  for (const [skcIndex, skc] of asArray(next.skc_list || next.skcList).entries()) {
    const imageInfo = skc?.image_info || skc?.imageInfo;
    const rows = asArray(imageInfo?.image_info_list || imageInfo?.imageInfoList);
    if (!rows.length) continue;

    const used = new Set();
    let maxSort = 0;
    for (const row of rows) {
      const sort = Number(row?.image_sort ?? row?.imageSort);
      if (Number.isFinite(sort) && sort > maxSort) maxSort = sort;
    }

    for (const [rowIndex, row] of rows.entries()) {
      const imageType = normalizePublishImageType(row?.image_type ?? row?.imageType);
      let sort = Number(row?.image_sort ?? row?.imageSort);
      if (imageType === 1) {
        if (sort !== 1) {
          sort = 1;
          row.image_sort = 1;
          delete row.imageSort;
          applied.push(`skc_list[${skcIndex}].image_info.image_info_list[${rowIndex}].main_sort=1`);
        }
        used.add(1);
        if (maxSort < 1) maxSort = 1;
        continue;
      }
      if (!Number.isFinite(sort) || sort <= 0 || used.has(sort)) {
        do {
          maxSort += 1;
        } while (used.has(maxSort));
        row.image_sort = maxSort;
        delete row.imageSort;
        applied.push(`skc_list[${skcIndex}].image_info.image_info_list[${rowIndex}].unique_sort=${maxSort}`);
        sort = maxSort;
      }
      used.add(sort);
    }
  }
  return {payload: next, applied};
}

function taskShuffleImagesEnabled(task, executionContext = {}) {
  return Boolean(
    task?.shuffleImages
    || task?.shuffle_images
    || task?.targets?.shuffleImages
    || task?.targets?.shuffle_images
    || executionContext?.shuffleImages
    || executionContext?.shuffle_images
    || executionContext?.targets?.shuffleImages
    || executionContext?.targets?.shuffle_images
  );
}

function taskApprovedImageOrderLocked(task) {
  const binding = task?.publishAssetBinding || task?.metadata?.publishAssetBinding || null;
  return Boolean(
    binding?.sourceApproved === true
    && binding?.authority === 'human_reviewed_source'
    && binding?.boundAt
    && binding?.bindingFingerprint
  );
}

function cryptoShuffle(values, seed) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = deterministicIntInclusive(0, i, `${seed}:${i}`);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function shufflePublishDetailImages(payload, task, executionContext, targetStore = '') {
  if (!taskShuffleImagesEnabled(task, executionContext)) return {payload, applied: []};
  const next = jsonClone(payload || {});
  const applied = [];
  const shuffleSeed = taskRandomizationSeed(
    task,
    executionContext,
    firstNonEmpty(targetStore, executionContext?.targetStore, executionContext?.targets?.targetStore, task?.targetStore, task?.targets?.targetStore),
    'detail_image_order',
  );
  for (const [skcIndex, skc] of asArray(next.skc_list || next.skcList).entries()) {
    const imageInfo = skc?.image_info || skc?.imageInfo;
    const rows = asArray(imageInfo?.image_info_list || imageInfo?.imageInfoList);
    if (!rows.length) continue;
    const reservedSorts = new Set([1]);
    const details = [];
    for (const [rowIndex, row] of rows.entries()) {
      const imageType = normalizePublishImageType(row?.image_type ?? row?.imageType);
      if (imageType === 1) {
        if (Number(row?.image_sort ?? row?.imageSort) !== 1) {
          row.image_sort = 1;
          delete row.imageSort;
          applied.push(`skc_list[${skcIndex}].image_info.image_info_list[${rowIndex}].main_sort=1`);
        }
        continue;
      }
      if (imageType === 2) {
        details.push({row, rowIndex});
        continue;
      }
      const sort = Number(row?.image_sort ?? row?.imageSort);
      if (Number.isFinite(sort) && sort > 1) reservedSorts.add(sort);
    }
    if (details.length <= 1) continue;
    const shuffled = cryptoShuffle(details, `${shuffleSeed}:${skcIndex}`);
    let nextSort = 2;
    for (const item of shuffled) {
      while (reservedSorts.has(nextSort)) nextSort += 1;
      item.row.image_sort = nextSort;
      delete item.row.imageSort;
      reservedSorts.add(nextSort);
      applied.push(`skc_list[${skcIndex}].image_info.image_info_list[${item.rowIndex}].detail_shuffle_sort=${nextSort}`);
      nextSort += 1;
    }
  }
  return {payload: next, applied: [...new Set(applied)]};
}

function applyTargetStandardGoodsSn(payload, standardGoodsSn, {preserveExplicitSupplierSku = false} = {}) {
  const goodsSn = safeString(standardGoodsSn, 240);
  if (!goodsSn) return {payload, applied: []};
  const next = jsonClone(payload || {});
  const applied = [];
  // standardGoodsSn is a supplier/product identity, not the Product Model.
  // Keep attribute 1000546 exactly as provided by the product payload; Chinese
  // product names may be valid supplier codes but must never leak into model.
  if (next.productAttributeList) delete next.productAttributeList;
  const skcList = asArray(next.skc_list || next.skcList).filter(row => row && typeof row === 'object');
  for (const [skcIndex, skc] of skcList.entries()) {
    if ((skc.supplier_code ?? skc.supplierCode) !== goodsSn) {
      skc.supplier_code = goodsSn;
      if ('supplierCode' in skc) delete skc.supplierCode;
      applied.push(`skc_list[${skcIndex}].supplier_code.standard_goods_sn`);
    }
    for (const [skuIndex, sku] of asArray(skc.sku_list || skc.skuList).entries()) {
      if (!sku || typeof sku !== 'object') continue;
      const explicitSupplierSku = safeString(sku.supplier_sku ?? sku.supplierSku, 240);
      if (preserveExplicitSupplierSku && explicitSupplierSku) {
        if ('supplierSku' in sku) {
          sku.supplier_sku = explicitSupplierSku;
          delete sku.supplierSku;
        }
        applied.push(`skc_list[${skcIndex}].sku_list[${skuIndex}].supplier_sku.explicit_unique_preserved`);
        continue;
      }
      if ((sku.supplier_sku ?? sku.supplierSku) !== goodsSn) {
        sku.supplier_sku = goodsSn;
        if ('supplierSku' in sku) delete sku.supplierSku;
        applied.push(`skc_list[${skcIndex}].sku_list[${skuIndex}].supplier_sku.standard_goods_sn`);
      }
    }
  }
  return {payload: next, applied};
}

function validatePublishPayload(payload, task) {
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
  // Preserve the legacy structural gate for every normal task. The stronger
  // task/binding policy is applied below to the final execution payload. Only
  // an explicit-empty task needs its authorization-aware policy at this early
  // shape-validation stage because an omitted description is intentional.
  const descriptionGate = task?.emptyDescriptionAuthorization
    ? validateCopyProductDescriptionPolicy(task, payload)
    : validatePublishPayloadDescription(payload);
  blockers.push(...descriptionGate.blockers);
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
    const seenImageSorts = new Set();
    for (const [j, image] of imageList.entries()) {
      const imagePrefix = `${prefix}.image_info.image_info_list[${j}]`;
      const imageType = normalizePublishImageType(image?.image_type ?? image?.imageType);
      const imageSort = Number(image?.image_sort ?? image?.imageSort);
      if (!Number.isFinite(imageSort) || imageSort <= 0) {
        blockers.push(`${imagePrefix} 缺合法 image_sort。`);
      } else if (seenImageSorts.has(imageSort)) {
        blockers.push(`${imagePrefix} image_sort=${imageSort} 与同一 SKC 其他图片重复；publishOrEdit 图片 sort 必须全局唯一。`);
      } else {
        seenImageSorts.add(imageSort);
      }
      if (imageType === null) {
        blockers.push(`${imagePrefix} 缺 image_type：publishOrEdit 的 SKC 图必须标明 1主图/2细节图/5方块图/6色块图。`);
      } else if (!ALLOWED_SKC_IMAGE_TYPES.has(imageType)) {
        blockers.push(`${imagePrefix} image_type=${imageType} 非法：SKC 图只允许 ${[...SKC_IMAGE_TYPE_LABELS].map(([value, label]) => `${value}${label}`).join('/')}。`);
      } else if (imageType === 1) {
        mainImageCount += 1;
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

function strictOwnBoolean(object, key) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || !Object.hasOwn(object, key)) return undefined;
  return object[key] === true ? true : (object[key] === false ? false : undefined);
}

function publishInfoHasExplicitSuccess(info) {
  return strictOwnBoolean(info, 'success') !== undefined;
}

function publishResultSucceeded(result) {
  if (!result || String(result.code ?? '') !== '0') return false;
  // Phase A contract: publishOrEdit success requires code=0 AND explicit
  // info.success===true. A code=0 response without an explicit success flag is
  // not proof of acceptance and must never be treated as success.
  return strictOwnBoolean(result.info, 'success') === true;
}

function descriptionSensitiveFragments(payload) {
  const fragments = [];
  for (const row of asArray(payload?.multi_language_desc_list)) {
    const name = typeof row?.name === 'string' ? row.name : '';
    if (name) fragments.push(name);
    for (const line of name.split('\n')) {
      if (line) fragments.push(line);
    }
  }
  return [...new Set(fragments)];
}

/**
 * Whitespace normalization used ONLY for echo containment matching, never for
 * output. Collapses CR/LF/tabs/multi-space runs so a platform echo that wraps,
 * breaks, or flattens a reviewed fragment still matches it.
 */
function normalizeMatchWhitespace(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * Longest reviewed-text window that still triggers redaction when echoed
 * partially. A platform that truncates a long single-line description (or
 * wraps an error around a cut echo) no longer contains the full reviewed
 * fragment; 32+ contiguous reviewed characters in platform text is a
 * defensible echo signal (covers 63-char partial echoes) while staying far
 * below ordinary diagnostics.
 */
const LONG_REVIEWED_ECHO_WINDOW = 32;

/**
 * A one-character reviewed line must appear as a standalone token (bounded by
 * non-letter/non-digit characters or the string edges) to count as an echo.
 * This keeps unrelated larger diagnostics visible even when they happen to
 * contain the same single character, while exact short-line echoes still
 * redact (hash-only is the safe fallback for those unavoidable matches).
 */
const MATCH_TOKEN_BOUNDARY_RE = /[\p{L}\p{N}]/u;

function shortFragmentTokenMatch(raw, frag) {
  let index = -1;
  while ((index = raw.indexOf(frag, index + 1)) !== -1) {
    const before = index === 0 ? '' : raw[index - 1];
    const after = index + frag.length >= raw.length ? '' : raw[index + frag.length];
    if (!MATCH_TOKEN_BOUNDARY_RE.test(before) && !MATCH_TOKEN_BOUNDARY_RE.test(after)) return true;
  }
  return false;
}

function publishTextEchoesFragment(raw, normalizedRaw, fragment) {
  const frag = String(fragment ?? '');
  if (!frag) return false;
  // One-character reviewed lines: standalone-token containment only, so an
  // unrelated diagnostic is not redacted merely for containing the character.
  if (frag.length === 1) {
    return shortFragmentTokenMatch(raw, frag) || shortFragmentTokenMatch(normalizedRaw, frag);
  }
  // Exact containment: whole or embedded echo of the reviewed text.
  if (raw.includes(frag)) return true;
  const normalizedFragment = normalizeMatchWhitespace(frag);
  // Whitespace-normalized containment: line-wrap / multi-space / newline
  // collapse variants of a reviewed fragment still count as an echo. Very
  // short (2-3 char) reviewed lines keep plain containment: matching the
  // exact short string is safer than leaking it.
  if (normalizedFragment.length >= 2 && normalizedRaw.includes(normalizedFragment)) return true;
  // Partial echo: a platform-truncated long echo never contains the full
  // fragment. Redact whenever a long contiguous window of reviewed text
  // survives, so a long prefix cannot leak through max truncation.
  if (
    normalizedFragment.length >= LONG_REVIEWED_ECHO_WINDOW
    && normalizedRaw.length >= LONG_REVIEWED_ECHO_WINDOW
  ) {
    const lastWindowStart = normalizedFragment.length - LONG_REVIEWED_ECHO_WINDOW;
    for (let i = 0; i <= lastWindowStart; i += 1) {
      if (normalizedRaw.includes(normalizedFragment.slice(i, i + LONG_REVIEWED_ECHO_WINDOW))) return true;
    }
  }
  return false;
}

function publishTextContainsReviewedFragment(raw, fragments) {
  if (!fragments.length || !raw) return false;
  const normalizedRaw = normalizeMatchWhitespace(raw);
  return fragments.some(fragment => publishTextEchoesFragment(raw, normalizedRaw, fragment));
}

// Platform free text is untrusted and may echo reviewed descriptions.  When
// descriptions are present, only these closed, structure-only diagnostics may
// remain readable; everything else is hash-only.  The allowlist deliberately
// contains no arbitrary field/value capture.
const SAFE_PUBLISH_VALIDATION_PATTERNS = [
  /^(?:商品属性|商品标题|基础信息|平台预校验)$/u,
  /^商品标题不能为空[。.]?$/u,
  /^Because Power Supply\(\d+\) selected (?:Wall Plug|Power Adapter)\(\d+\), Input (?:current|voltage)\(\d+\) is required\.?$/u,
  /^(?:产品型号|输入电流|输入电压|危险品分类)(?:\(\d+\))?[，,]\s*为必填项[。.]?$/u,
  /^(?:Hazardous materials classification|Input current|Input voltage)(?:\(\d+\))?\s*[:：]\s*The template attribute under type is required\.?$/u,
];

function safeStructuredPublishDiagnostic(raw) {
  const normalized = normalizeMatchWhitespace(raw);
  return SAFE_PUBLISH_VALIDATION_PATTERNS.some(pattern => pattern.test(normalized));
}

function sanitizePublishPlatformText(value, payload, max = 300) {
  const raw = String(value ?? '');
  if (!raw.trim()) return '';
  // Redact BEFORE normalization/truncation: an exact or echoed reviewed
  // description fragment must never survive max-truncation as a long prefix.
  // Non-sensitive platform diagnostics stay visible, so ordinary pre-valid
  // field/message failures remain debuggable even when the payload carries
  // reviewed descriptions.
  const fragments = descriptionSensitiveFragments(payload);
  if (fragments.length && (
    publishTextContainsReviewedFragment(raw, fragments)
    || !safeStructuredPublishDiagnostic(raw)
  )) {
    return `[平台回显内容已脱敏 sha256=${crypto.createHash('sha256').update(raw, 'utf8').digest('hex')}]`;
  }
  return safeString(raw, max);
}

function publishPreValidMessages(info, payload) {
  const rows = asArray(info?.pre_valid_result || info?.preValidResult);
  const messages = [];
  for (const row of rows) {
    const label = sanitizePublishPlatformText(row?.form_name || row?.form || row?.module || '平台预校验', payload, 80);
    for (const msg of asArray(row?.messages || row?.message)) {
      const text = sanitizePublishPlatformText(msg, payload, 300);
      if (text) messages.push(`${label}：${text}`);
    }
  }
  if (!messages.length && publishInfoHasExplicitSuccess(info) && info.success === false) {
    messages.push('平台返回 success=false，但未返回具体预校验明细。');
  }
  return [...new Set(messages)];
}

function compactPublishResultForStorage(result, payload) {
  if (!result || typeof result !== 'object') return null;
  const info = result.info && typeof result.info === 'object' ? result.info : {};
  const preValidResult = asArray(info.pre_valid_result || info.preValidResult).slice(0, 30).map(row => ({
    module: sanitizePublishPlatformText(row?.module || '', payload, 80),
    form_name: sanitizePublishPlatformText(row?.form_name || row?.form || '', payload, 120),
    messages: asArray(row?.messages || row?.message)
      .map(message => sanitizePublishPlatformText(message, payload, 300))
      .filter(Boolean)
      .slice(0, 10),
  }));
  const skcList = asArray(info.skc_list || info.skcList).slice(0, 30).map(skc => ({
    skc_name: safeString(skc?.skc_name || skc?.skcName || '', 120),
    sku_list: asArray(skc?.sku_list || skc?.skuList).slice(0, 100).map(sku => ({
      sku_code: safeString(sku?.sku_code || sku?.skuCode || '', 120),
    })),
  }));
  return {
    httpStatus: Number(result.httpStatus || 0) || null,
    code: result.code == null ? null : String(result.code),
    msg: sanitizePublishPlatformText(result.msg || '', payload, 300),
    traceId: safeString(result.traceId || '', 180) || null,
    info: {
      // Tri-state: undefined when the platform response omitted info.success
      // (unknown outcome), false/true only when it explicitly returned them.
      // Only an explicit success=false may prove publish_pre_valid_failed;
      // code=0 with missing info.success is uncertainty, never a rejection.
      success: strictOwnBoolean(info, 'success'),
      taskNo: safeString(info.taskNo || info.task_no || '', 180),
      spu_name: safeString(info.spu_name || info.spuName || '', 120),
      version: safeString(info.version || '', 180),
      skc_list: skcList,
      pre_valid_result: preValidResult,
    },
  };
}

function publishInfoExplicitlyFalse(result) {
  const info = result?.info && typeof result.info === 'object' ? result.info : null;
  return strictOwnBoolean(info, 'success') === false;
}

function extractPayloadSummary(payload) {
  const skcList = asArray(payload?.skc_list || payload?.skcList);
  const skuCount = skcList.reduce((sum, skc) => sum + asArray(skc?.sku_list || skc?.skuList).length, 0);
  return {
    ...describePublishPayloadDescription(payload),
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

function publishTargetSupplierCodes(payload) {
  return [...new Set(asArray(payload?.skc_list || payload?.skcList)
    .map(row => safeString(row?.supplier_code ?? row?.supplierCode ?? '', 160))
    .filter(Boolean))];
}

// Strict supplier identity normalization for provenance guards: only trim and
// Unicode NFKC are allowed. Hyphens, brackets and punctuation are significant -
// "HL03012SN" and "HL-03012-SN" are different identities and must never match.
function normalizeSupplierIdentity(value) {
  return String(value || '').trim().normalize('NFKC');
}

function existingTargetSkcRows(data, supplierCodes) {
  const wanted = new Set(supplierCodes.map(compactRef).filter(Boolean));
  const rows = [];
  for (const product of openApiSearchProductRows(data)) {
    const spuName = safeString(product?.spuName || product?.spu_name || '', 120);
    for (const skc of asArray(product?.skcList || product?.skc_list || product?.skcInfoList || product?.skc_info_list)) {
      const supplierCode = safeString(skc?.supplierCode || skc?.supplier_code || '', 160);
      if (!supplierCode || !wanted.has(compactRef(supplierCode))) continue;
      const siteShelf = asArray(skc?.skcSiteShelfStatusList || skc?.skc_site_shelf_status_list || skc?.shelfStatusInfoList || skc?.shelf_status_info_list)
        .find(row => /shein-sa/i.test(String(row?.subSite || row?.siteAbbr || row?.site_abbr || '')));
      rows.push({
        spuName,
        skcName: safeString(skc?.skcName || skc?.skc_name || '', 120),
        supplierCode,
        shelfStatus: Number(siteShelf?.status ?? siteShelf?.shelfStatus ?? siteShelf?.shelf_status ?? skc?.skcShelfStatus ?? skc?.skc_shelf_status ?? product?.spuShelfStatus ?? product?.spu_shelf_status),
        recycleStatus: null,
      });
    }
  }
  return rows;
}

function enrichExistingTargetSkcsFromSpuInfo(matches, info) {
  const next = matches.map(row => ({...row}));
  const skcs = asArray(info?.skcInfoList || info?.skc_info_list || info?.skcList || info?.skc_list);
  for (const row of next) {
    const detail = skcs.find(item => {
      const candidate = safeString(item?.skcName || item?.skc_name, 120);
      return sameSheinSkc(candidate, row.skcName) || candidate.toLowerCase() === safeString(row.skcName, 120).toLowerCase();
    });
    if (!detail) continue;
    const siteShelf = asArray(detail?.shelfStatusInfoList || detail?.shelf_status_info_list)
      .find(item => /shein-sa/i.test(String(item?.siteAbbr || item?.site_abbr || item?.subSite || '')));
    const recycle = asArray(detail?.recycleInfoList || detail?.recycle_info_list)
      .find(item => /shein-sa/i.test(String(item?.subSite || item?.siteAbbr || item?.site_abbr || '')));
    const shelfStatus = Number(siteShelf?.shelfStatus ?? siteShelf?.shelf_status);
    const recycleStatus = Number(recycle?.recycleStatus ?? recycle?.recycle_status);
    if (Number.isFinite(shelfStatus)) row.shelfStatus = shelfStatus;
    if (Number.isFinite(recycleStatus)) row.recycleStatus = recycleStatus;
    row.lastShelfTime = safeString(siteShelf?.lastShelfTime || siteShelf?.last_shelf_time || '', 80);
    row.lastUpdateTime = safeString(siteShelf?.lastUpdateTime || siteShelf?.last_update_time || '', 80);
  }
  return next;
}

async function terminalReplacementDuplicateOverride(client, task, targetStore, matches, calls) {
  const repairMode = safeString(task?.notes?.repairMode, 80);
  const expectedState = repairMode === 'republish_rejected'
    ? 3
    : repairMode === 'republish_withdrawn'
      ? 4
      : null;
  const replacement = expectedState === 3
    ? task?.notes?.replacesRejectedTarget
    : expectedState === 4
      ? task?.notes?.replacesWithdrawnTarget
      : null;
  const enabled = task?.allowDuplicateNewPublish === true
    && expectedState !== null
    && replacement
    && typeof replacement === 'object'
    && Number(replacement.state) === expectedState
    && normalizeStoreKey(replacement.store) === normalizeStoreKey(targetStore)
    && isSheinSkc(safeString(replacement.skc, 120))
    && /^(?:sr|v|b)\d+$/i.test(safeString(replacement.spu, 120));
  if (!enabled) return {allowed: false, replacement: null, liveValidation: {status: 'not_requested'}};

  const replacedSkc = safeString(replacement.skc, 120);
  // Never bypass the guard when the allegedly rejected SKC itself appears in
  // the product list.  The narrow exception is only for a *different* draft
  // replacing an exact terminal rejected/withdrawn document while older
  // same-code links coexist.
  if (matches.some(row => sameSheinSkc(row?.skcName, replacedSkc))) {
    return {allowed: false, replacement: {store: targetStore, spu: replacement.spu, skc: replacedSkc, state: expectedState}, liveValidation: {status: 'replacement_present_in_product_search'}};
  }
  const replacedSpu = safeString(replacement.spu, 120);
  try {
    const response = await client.request('/open-api/goods/query-document-state', {
      method: 'POST',
      body: {spuList: [{spuName: replacedSpu}]},
      headers: {language: 'zh-cn'},
    });
    calls.push(compactCallResult(`query-document-state-terminal-replacement-${replacedSpu}`, '/open-api/goods/query-document-state', 'POST', response));
    if (!response.ok || String(response.data?.code) !== '0') {
      return {
        allowed: false,
        replacement: {store: targetStore, spu: replacedSpu, skc: replacedSkc, state: expectedState},
        liveValidation: {status: 'query_not_ok', code: response.data?.code ?? null, msg: response.data?.msg ?? null},
      };
    }
    const liveSkc = asArray(response.data?.info?.data)
      .filter(row => safeString(row?.spuName || row?.spu_name, 120) === replacedSpu)
      .flatMap(row => asArray(row?.skcList || row?.skc_list))
      .find(row => sameSheinSkc(row?.skcName || row?.skc_name, replacedSkc));
    const documentState = Number(liveSkc?.documentState ?? liveSkc?.document_state);
    const allowed = Number.isFinite(documentState) && documentState === expectedState;
    return {
      allowed,
      replacement: {store: targetStore, spu: replacedSpu, skc: replacedSkc, state: expectedState},
      liveValidation: {
        status: allowed
          ? expectedState === 3 ? 'verified_terminal_rejected' : 'verified_terminal_withdrawn'
          : 'not_expected_terminal_state',
        documentState: Number.isFinite(documentState) ? documentState : null,
      },
    };
  } catch (error) {
    calls.push({name: `query-document-state-terminal-replacement-${replacedSpu}`, path: '/open-api/goods/query-document-state', method: 'POST', httpStatus: null, code: null, msg: safeString(error?.message || error, 300), traceId: null});
    return {
      allowed: false,
      replacement: {store: targetStore, spu: replacedSpu, skc: replacedSkc, state: expectedState},
      liveValidation: {status: 'query_failed', error: safeString(error?.message || error, 300)},
    };
  }
}

async function inspectTargetDuplicateProducts(client, payload, targetStore = '', task = null) {
  const supplierCodes = publishTargetSupplierCodes(payload);
  const calls = [];
  const blockers = [];
  const warnings = [];
  if (!supplierCodes.length) {
    return {calls, blockers, warnings, evidence: {status: 'skipped_missing_supplier_code', supplierCodes: [], matches: []}};
  }
  let response = null;
  try {
    response = await client.request('/open-api/goods/searchProduct', {
      method: 'POST',
      body: {pageNum: 1, pageSize: 10, skcSupplierCodeList: supplierCodes.slice(0, 20), languageList: ['en', 'ar']},
      headers: {language: 'en'},
    });
  } catch (err) {
    blockers.push(`${targetStore || '目标店'} 同货号去重检查失败：${safeString(err?.message || err, 300)}；在确认目标店没有现有同货号链接前禁止创建新链接。`);
    return {calls, blockers, warnings, evidence: {status: 'query_failed', supplierCodes, matches: [], error: safeString(err?.message || err, 300)}};
  }
  calls.push(compactCallResult('search-existing-target-by-supplier-code', '/open-api/goods/searchProduct', 'POST', response));
  if (!response.ok || String(response.data?.code) !== '0') {
    blockers.push(`${targetStore || '目标店'} 同货号去重检查失败：code=${safeString(response.data?.code || '', 80)} msg=${safeString(response.data?.msg || response.statusText || '', 300)}；在确认目标店没有现有同货号链接前禁止创建新链接。`);
    return {calls, blockers, warnings, evidence: {status: 'query_not_ok', supplierCodes, matches: [], httpStatus: response.status, code: response.data?.code ?? null, msg: response.data?.msg ?? null}};
  }
  let matches = existingTargetSkcRows(response.data, supplierCodes);
  const bySpu = [...new Set(matches.map(row => row.spuName).filter(Boolean))].slice(0, 20);
  for (const spuName of bySpu) {
    try {
      const detailResponse = await client.request('/open-api/goods/spu-info', {
        method: 'POST',
        body: {spuName, languageList: ['en', 'ar']},
        headers: {language: 'en'},
      });
      calls.push(compactCallResult(`spu-info-existing-target-${spuName}`, '/open-api/goods/spu-info', 'POST', detailResponse));
      if (!detailResponse.ok || String(detailResponse.data?.code) !== '0' || !detailResponse.data?.info) continue;
      const group = matches.filter(row => row.spuName === spuName);
      const enriched = enrichExistingTargetSkcsFromSpuInfo(group, detailResponse.data.info);
      const enrichedBySkc = new Map(enriched.map(row => [row.skcName, row]));
      matches = matches.map(row => row.spuName === spuName ? (enrichedBySkc.get(row.skcName) || row) : row);
    } catch (err) {
      calls.push({name: `spu-info-existing-target-${spuName}`, path: '/open-api/goods/spu-info', method: 'POST', httpStatus: null, code: null, msg: safeString(err?.message || err, 300), traceId: null});
    }
  }
  const recycled = matches.filter(row => Number(row.recycleStatus) === 1);
  const active = matches.filter(row => Number(row.recycleStatus) !== 1 && Number(row.shelfStatus) === 1);
  const inactive = matches.filter(row => Number(row.recycleStatus) !== 1 && Number(row.shelfStatus) !== 1);
  const hasBlockingDuplicate = active.length > 0 || inactive.length > 0;
  const terminalReplacement = hasBlockingDuplicate
    ? await terminalReplacementDuplicateOverride(client, task, targetStore, matches, calls)
    : {allowed: false, replacement: null, liveValidation: {status: 'not_needed_no_blocking_duplicate'}};
  const additionalDuplicateOverride = evaluateAdditionalDuplicatePublishOverride(task, targetStore, [...active, ...inactive]);
  const duplicateOverrideAllowed = terminalReplacement.allowed || additionalDuplicateOverride.allowed;
  if (active.length && !duplicateOverrideAllowed) {
    blockers.push(`${targetStore || '目标店'} 已存在同货号在售链接 ${active.map(row => row.skcName).filter(Boolean).join('、')}，禁止重复创建新链接。`);
  }
  if (inactive.length && !duplicateOverrideAllowed) {
    blockers.push(`${targetStore || '目标店'} 已存在同货号下架但未回收链接 ${inactive.map(row => row.skcName).filter(Boolean).join('、')}；应优先恢复该链接，或先明确说明为何必须另建，当前禁止直接创建重复链接。`);
  }
  if (terminalReplacement.allowed && (active.length || inactive.length)) {
    const terminalLabel = Number(terminalReplacement.replacement?.state) === 3 ? '议价拒绝' : '已撤回';
    warnings.push(`${targetStore || '目标店'} 正在替换终态 state=${terminalReplacement.replacement.state} 的${terminalLabel}链接 ${terminalReplacement.replacement.skc}；已对其他同货号链接应用单次重发豁免，不改变全局去重规则。`);
  }
  if (additionalDuplicateOverride.allowed) {
    warnings.push(`${targetStore || '目标店'} 已由负责人明确授权保留现有同货号链接 ${additionalDuplicateOverride.existingSkcs.join('、')} 并额外新建一条；该豁免仅对本任务和当前精确链接集合生效。`);
  }
  if (recycled.length) {
    warnings.push(`${targetStore || '目标店'} 已存在同货号历史回收链接 ${recycled.map(row => row.skcName).filter(Boolean).join('、')}（已回收、当前非在售）。本次计划仍是创建新链接，不会恢复旧链接；确认后新链接会与历史回收记录并存。`);
  }
  return {
    calls,
    blockers,
    warnings,
    evidence: {
      status: 'ok',
      supplierCodes,
      matchCount: matches.length,
      activeCount: active.length,
      inactiveCount: inactive.length,
      recycledCount: recycled.length,
      rejectedReplacementOverride: terminalReplacement,
      additionalDuplicateOverride,
      matches: matches.slice(0, 40),
    },
  };
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
  const hasPublishIdentity = publishSpuNames.length > 0 || publishSkcNames.length > 0 || publishSkuCodes.length > 0;
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
    // When publishOrEdit already returned the new SPU/SKC/SKU identity, a row
    // matched only by the shared standard goods number or supplier SKU can be an
    // OLD link of the same goods number and must never act as the new-link
    // readback. Demote such rows to weak evidence with an explicit reason.
    if (hasPublishIdentity && !strongReasons.some(reason => /^publish(?:SpuName|SkcName|SkuCode):/.test(reason))) {
      for (const reason of strongReasons) {
        if (/^supplier(?:Sku|Code):/.test(reason)) {
          weakReasons.push(reason.replace(/^supplier(Sku|Code):/, 'sameGoodsNumberOldLinkWithoutPublishIdentity:'));
        }
      }
      strongReasons.length = 0;
    }
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

function descriptionReadbackLanguageList(task) {
  return task?.emptyDescriptionAuthorization
    ? ['en', 'ar', 'zh-cn']
    : ['en', 'ar'];
}

async function readbackPublishedProduct(client, fingerprint, {enabled = false, task = null} = {}) {
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
  const descriptionBinding = task?.descriptionMaterialBinding && typeof task.descriptionMaterialBinding === 'object'
    ? task.descriptionMaterialBinding
    : null;
  const emptyDescriptionAuthorization = task?.emptyDescriptionAuthorization && typeof task.emptyDescriptionAuthorization === 'object'
    ? task.emptyDescriptionAuthorization
    : null;
  const emptyDescriptionAuthorizationGate = emptyDescriptionAuthorization
    ? validateEmptyDescriptionAuthorization(task, task?.openapiPublishPayload)
    : null;
  const descriptionLanguages = descriptionReadbackLanguageList(task);
  const verifyMatchedRowsDescription = async (matchedRows, label) => {
    if (!descriptionBinding && !emptyDescriptionAuthorization) {
      return {
        ok: true,
        status: 'description_readback_not_required',
        descriptionReadback: {ok: true, status: 'description_readback_not_required', blockers: [], summary: {}},
      };
    }
    if (emptyDescriptionAuthorization && emptyDescriptionAuthorizationGate?.ok !== true) {
      return {
        ok: false,
        status: 'description_readback_unverifiable',
        descriptionReadback: {
          ok: false,
          status: 'description_readback_unverifiable',
          blockers: emptyDescriptionAuthorizationGate?.blockers || ['空描述授权在终态回读前已失效'],
          summary: {},
        },
      };
    }
    const spuNames = [...new Set(asArray(matchedRows).map(row => safeString(row?.spuName || '', 120)).filter(Boolean))];
    if (spuNames.length !== 1) {
      return {
        ok: false,
        status: 'description_readback_unverifiable',
        descriptionReadback: {
          ok: false,
          status: 'description_readback_unverifiable',
          blockers: [`强身份回读没有得到唯一 SPU（count=${spuNames.length}），无法精确回读描述`],
          summary: {},
        },
      };
    }
    const spuName = spuNames[0];
    const response = await client.request('/open-api/goods/spu-info', {
      method: 'POST',
      body: {spuName, languageList: descriptionLanguages},
      headers: {language: 'en'},
    });
    calls.push(compactCallResult(`${label}-description-spu-info-${spuName}`, '/open-api/goods/spu-info', 'POST', response));
    if (!response.ok || String(response.data?.code) !== '0' || !response.data?.info || typeof response.data.info !== 'object') {
      return {
        ok: false,
        status: 'description_readback_unverifiable',
        descriptionReadback: {
          ok: false,
          status: 'description_readback_unverifiable',
          blockers: ['官方 spu-info 描述回读失败或缺少 info，不能以商品列表命中代替描述终态回读'],
          summary: {},
        },
      };
    }
    const descriptionReadback = evaluateDescriptionReadback(descriptionBinding, response.data.info);
    return {ok: descriptionReadback.ok, status: descriptionReadback.status, descriptionReadback};
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
        body: {spuName, languageList: descriptionLanguages},
        headers: {language: 'en'},
      });
      calls.push(compactCallResult(`spu-info-readback-${spuName}`, '/open-api/goods/spu-info', 'POST', response));
      if (!response.ok || String(response.data?.code) !== '0') continue;
      const info = response.data?.info && typeof response.data.info === 'object' ? response.data.info : null;
      if (!info) continue;
      const matched = matchProductReadbackRows([info], fingerprint);
      if (matched.strong.length) {
        // Phase A live description gate: identity strongly matched, but the
        // spu-info productMultiDescList must still carry ar/en exactly once
        // each with hashes equal to the task's descriptionMaterialBinding.
        const descriptionReadback = task?.descriptionMaterialBinding || emptyDescriptionAuthorization
          ? (emptyDescriptionAuthorization && emptyDescriptionAuthorizationGate?.ok !== true
              ? {
                  ok: false,
                  status: 'description_readback_unverifiable',
                  blockers: emptyDescriptionAuthorizationGate?.blockers || ['空描述授权在终态回读前已失效'],
                  summary: {},
                }
              : evaluateDescriptionReadback(task?.descriptionMaterialBinding || null, info))
          : null;
        if (descriptionReadback && !descriptionReadback.ok) {
          return {
            ok: false,
            status: descriptionReadback.status,
            startedAt,
            endedAt: new Date().toISOString(),
            plan,
            calls,
            scannedRows: 1,
            matchedRows: matched.strong,
            weakMatchedRows: matched.weak,
            descriptionReadback,
            note: 'publishOrEdit 返回的 SPU 已在官方 spu-info 强匹配，但 live 商品描述与审核资料绑定哈希不一致/缺失/重复；不能按已闭环处理，必须人工核销。',
          };
        }
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
          descriptionReadback: descriptionReadback || {ok: true, status: 'description_readback_not_required', blockers: [], summary: {}},
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
        const descriptionVerification = await verifyMatchedRowsDescription(matched.strong, attempt.name);
        if (!descriptionVerification.ok) {
          return {
            ok: false,
            status: descriptionVerification.status,
            startedAt,
            endedAt: new Date().toISOString(),
            plan,
            calls,
            scannedRows: rows.length,
            matchedRows: matched.strong,
            weakMatchedRows: allWeakMatches.slice(0, 20),
            descriptionReadback: descriptionVerification.descriptionReadback,
            note: '官方商品综合查询已强匹配，但审核资料描述未完成精确 spu-info 回读；不能按已闭环处理。',
          };
        }
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
          descriptionReadback: descriptionVerification.descriptionReadback,
          note: '已用 publishOrEdit 返回的 SPU/SKC/SKU 或目标商家编号调用官方 searchProduct，并强匹配到新商品记录；该证据可证明 SHEIN 已接收并可被官方商品综合查询命中，后续仍需结合审核/上架状态判断是否已前台可售。',
        };
      }
    }
    let scannedRows = 0;
    let lastRowsCount = 0;
    for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
      const response = await client.requestReadOnly('/open-api/openapi-business-backend/product/query', {
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
        const descriptionVerification = await verifyMatchedRowsDescription(matched.strong, `product-query-page-${pageNum}`);
        if (!descriptionVerification.ok) {
          return {
            ok: false,
            status: descriptionVerification.status,
            startedAt,
            endedAt: new Date().toISOString(),
            plan,
            calls,
            scannedRows,
            matchedRows: matched.strong,
            weakMatchedRows: allWeakMatches.slice(0, 20),
            descriptionReadback: descriptionVerification.descriptionReadback,
            note: 'OpenAPI 商品列表已强匹配，但审核资料描述未完成精确 spu-info 回读；不能按已闭环处理。',
          };
        }
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
          descriptionReadback: descriptionVerification.descriptionReadback,
          note: '已在 OpenAPI 商品列表回读中找到目标商家 SKU / 商家货号强指纹匹配的商品行；仍需结合 SHEIN 审核状态判断最终上架结果。',
        };
      }
      if (!rows.length || rows.length < pageSize) break;
    }
    // Contract: with a publishOrEdit-returned new identity, the readback must
    // keep trying strong searchProduct/product-query fallbacks (old
    // same-goods-number rows are already demoted to weak). Only when every
    // fallback yields no publish-identity strong match - weak old-link rows or
    // zero results - is the state explicitly pending review / unverifiable,
    // never an old-link match and never a plain failure.
    if (publishSpuNames.length || publishSkcNames.length || publishSkuCodes.length) {
      return {
        ok: false,
        status: 'new_identity_pending_review_unverifiable',
        startedAt,
        endedAt: new Date().toISOString(),
        plan,
        calls,
        scannedRows,
        lastRowsCount,
        matchedRows: [],
        weakMatchedRows: allWeakMatches.slice(0, 20),
        pendingReview: true,
        note: 'publishOrEdit 已返回新 SPU/SKC/SKU 身份，但官方 spu-info、searchProduct 与商品列表强身份回读均未命中（可能仍待审核）。本次回读绑定新身份，同货号旧链接只能作为弱证据，不能充当新链接回读；任务保持待审核/人工核销，等待官方数据可用后重试回读。',
      };
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
    inferredSourceStore: normalizeStoreKey(inferred.sourceStore || generatedDraft.sourceStore || task?.targets?.sourceStores?.[0] || task?.sourceStore || ''),
    inferredSourceSkc: safeString(inferred.sourceSkc || generatedDraft.sourceSkc || task?.targets?.sourceSkc || task?.sourceSkc || task?.skc || '', 120),
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
  const openapiIdentityAcceptedByMerchant = storeIdentityMatchesMerchantOnly(openapiIdentity);
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

  const expectedPayloadHashField = args.mode === 'execute'
    ? firstOwnField([
      [executionContext, 'expectedPayloadHash'],
      [executionContext?.request, 'expectedPayloadHash'],
      [executionContext?.request, 'payloadHash'],
    ])
    : {present: false, value: ''};
  const rawExpectedPayloadHash = expectedPayloadHashField.present ? expectedPayloadHashField.value : '';
  const expectedPayloadHashInputValid = args.mode !== 'execute'
    || (typeof rawExpectedPayloadHash === 'string' && isSha256PayloadHash(rawExpectedPayloadHash));
  const expectedPayloadHash = expectedPayloadHashInputValid ? rawExpectedPayloadHash : '';
  if (args.mode === 'execute' && rawExpectedPayloadHash !== '' && !expectedPayloadHashInputValid) {
    blockers.push('真实提交 expectedPayloadHash 类型或格式无效；必须使用 fresh dry-run 返回的原生小写 SHA-256 字符串。');
  }
  const reusePreflightLock = args.mode === 'execute'
    || executionContext?.reusePreflightLock === true
    || executionContext?.request?.reusePreflightLock === true;
  const productDraftLock = reusePreflightLock
    ? resolvePreflightProductLock(task, targetStore, {expectedPayloadHash})
    : null;
  const exactSourceCopy = exactCopySourceLock(task);
  if (args.mode === 'execute' && exactSourceCopy && !productDraftLock) {
    blockers.push('精确源 copy_product_draft execute 缺少可解析的 productDraftLock（必须匹配 expectedPayloadHash）；拒绝仅凭 expectedPayloadHash 调用 publishOrEdit。');
  }
  const effectiveExecutionContext = productDraftLock
    ? {...(executionContext || {}), productDraftLock}
    : executionContext;
  const payloadFound = await findOrBuildPublishPayload(task, {
    targetStore,
    preferredSource: productDraftLock,
  });
  const currentSourceDetailLock = payloadFound?.sourceDetailLock
    && typeof payloadFound.sourceDetailLock === 'object'
    && !Array.isArray(payloadFound.sourceDetailLock)
    ? payloadFound.sourceDetailLock
    : null;
  const lockedSourceScope = resolveLockedSourceScope({payloadFound, task, intents, targetStore});
  appendUnique(blockers, lockedSourceScope.blockers);
  if (payloadFound?.sourceMetadataWarning) appendUnique(warnings, payloadFound.sourceMetadataWarning);
  if (productDraftLock && !productDraftLock.sourceDetailHash) {
    blockers.push('现有 preflight 锁缺少 sourceDetailHash；缓存漂移不可验证，必须重新预检。');
  }
  if (productDraftLock?.sourceDetailHash && payloadFound?.sourceDetailHash
    && String(productDraftLock.sourceDetailHash).toLowerCase() !== String(payloadFound.sourceDetailHash).toLowerCase()) {
    blockers.push(`source detail canonical hash 与 preflight 锁不一致：expected=${productDraftLock.sourceDetailHash} actual=${payloadFound.sourceDetailHash}`);
  }
  if (payloadFound?.exactSourceLock && payloadFound?.payload && payloadFound?.inferred?.sourceSkc) {
    const generatedSourceSkc = payloadFound.payload?.skc_list?.[0]?.source_skc
      || payloadFound.payload?.skc_list?.[0]?.sourceSkc
      || '';
    if (generatedSourceSkc !== payloadFound.inferred.sourceSkc) {
      blockers.push(`最终 publish payload source_skc 与锁定 sourceSkc 不一致：expected=${payloadFound.inferred.sourceSkc} actual=${generatedSourceSkc || 'missing'}`);
    }
  }
  let payloadSummary = null;
  let safeDefaults = [];
  let manualAttributeOverrides = [];
  let payloadValidation = {ok: false, blockers: ['未能自动生成 OpenAPI 发布 payload：系统已尝试从源店/源 SKC 的链接快照还原类目、属性、图片、SKU、供货价、库存和尺寸重量；请补充更明确的源店、源 SKC，或先同步该源链接详情。'], warnings: []};
  let publishPayload = null;
  let payloadHash = '';
  let bodyHash = '';
  if (payloadFound?.payload) {
    appendUnique(blockers, payloadFound.mappingBlockers);
    appendUnique(warnings, payloadFound.mappingWarnings);
    const applied = applySafeDefaults(payloadFound.payload, {sites, brands, task, executionContext: effectiveExecutionContext});
    const exactSourceLock = payloadFound.exactSourceLock === true;
    const manualApplied = exactSourceLock
      ? {payload: applied.payload, applied: [], overrides: []}
      : applyManualAttributeOverrides(applied.payload, task, effectiveExecutionContext);
    const liveSourceNames = await enrichPayloadNamesFromLiveSourceOpenApi(config, manualApplied.payload, payloadFound);
    if (liveSourceNames.calls?.length) calls.push(...liveSourceNames.calls);
    else if (liveSourceNames.call) calls.push(liveSourceNames.call);
    const publishStandardApplied = await applyPublishFillInStandardRules(client, liveSourceNames.payload);
    if (publishStandardApplied.call) calls.push(publishStandardApplied.call);
    const sourcePayloadSupplierCodes = sourcePayloadSupplierCodesForProvenance(payloadFound, publishStandardApplied.payload);
    const preserveExplicitSupplierSku = task?.notes?.supplierSkuPolicy?.mode === 'unique-per-link';
    // Order contract: the target standard goods number must be applied to the
    // payload BEFORE any template/provenance transform, so the provenance guard
    // sees the final identity and can never source a value from goods number A
    // and publish it under goods number B.
    const standardGoodsSnApplied = exactSourceLock
      ? {payload: publishStandardApplied.payload, applied: []}
      : applyTargetStandardGoodsSn(
        publishStandardApplied.payload,
        taskStandardGoodsSn(task, effectiveExecutionContext),
        {preserveExplicitSupplierSku},
      );
    const taskStandardGoodsSnValue = taskStandardGoodsSn(task, effectiveExecutionContext);
    const templateApplied = await applyAttributeTemplateRules(client, standardGoodsSnApplied.payload, {
      copyProductDraft: intents.includes('copy_product_draft'),
      exactSourceLock: payloadFound?.exactSourceLock === true,
      sourceStore: lockedSourceScope.sourceStore,
      sourceSkc: lockedSourceScope.sourceSkc,
      standardGoodsSn: safeString(taskStandardGoodsSnValue, 160),
      sourcePayloadSupplierCodes,
    });
    if (templateApplied.call) calls.push(templateApplied.call);
    const randomSupplyPriceApplied = exactSourceLock
      ? {payload: templateApplied.payload, applied: [], evidence: null}
      : applyRandomSupplyPrice(templateApplied.payload, task, effectiveExecutionContext, targetStore);
    const explicitPreparationApplied = exactSourceLock
      ? {payload: randomSupplyPriceApplied.payload, applied: [], evidence: null}
      : applyExplicitPublishPreparationOverrides(
        randomSupplyPriceApplied.payload,
        taskPublishPreparationOverrides(task, effectiveExecutionContext),
      );
    // A reviewed image package is an operator-owned fact, not an AI suggestion.
    // Preserve its explicit order even when an older task/template still carries
    // shuffleImages=true; otherwise a later preflight can silently rewrite the
    // sequence that the operator just approved and locked to this task.
    const approvedImageOrderLocked = taskApprovedImageOrderLocked(task);
    const imageShuffleApplied = exactSourceLock || approvedImageOrderLocked
      ? {payload: explicitPreparationApplied.payload, applied: ['publish_asset_binding.approved_order_locked']}
      : shufflePublishDetailImages(explicitPreparationApplied.payload, task, effectiveExecutionContext, targetStore);
    const imageSortApplied = ensurePublishImageSortGlobalUnique(imageShuffleApplied.payload);
    publishPayload = imageSortApplied.payload;
    const targetDuplicateCheck = await inspectTargetDuplicateProducts(client, publishPayload, targetStore, task);
    calls.push(...targetDuplicateCheck.calls);
    safeDefaults = [
      ...applied.applied,
      ...manualApplied.applied.map(x => `manual_attribute:${x}`),
      ...liveSourceNames.applied,
      ...publishStandardApplied.applied,
      ...templateApplied.applied,
      ...standardGoodsSnApplied.applied,
      ...randomSupplyPriceApplied.applied,
      ...explicitPreparationApplied.applied,
      ...imageShuffleApplied.applied,
      ...imageSortApplied.applied,
    ];
    manualAttributeOverrides = manualApplied.overrides;
    evidence.sourceLiveSpuInfo = liveSourceNames.evidence;
    evidence.publishFillInStandard = publishStandardApplied.evidence;
    evidence.attributeTemplate = templateApplied.evidence;
    evidence.randomSupplyPrice = randomSupplyPriceApplied.evidence;
    evidence.explicitPublishPreparation = explicitPreparationApplied.evidence;
    evidence.approvedImageOrderLocked = approvedImageOrderLocked;
    evidence.targetDuplicateCheck = targetDuplicateCheck.evidence;
    appendUnique(warnings, liveSourceNames.warnings);
    appendUnique(blockers, liveSourceNames.blockers);
    appendUnique(warnings, publishStandardApplied.warnings);
    appendUnique(blockers, publishStandardApplied.blockers);
    appendUnique(warnings, templateApplied.warnings);
    appendUnique(blockers, templateApplied.blockers);
    appendUnique(warnings, targetDuplicateCheck.warnings);
    appendUnique(blockers, targetDuplicateCheck.blockers);
    payloadValidation = validatePublishPayload(publishPayload, task);
    payloadSummary = extractPayloadSummary(publishPayload);
    // Execution lock hash v4: the real expectedPayloadHash must cover the final
    // publish payload PLUS the locked source store/sourceSkc and the target
    // standard goods number plus source identity/content (stable JSON scope).
    // detailFetchedAt is deliberately excluded because it is freshness
    // evidence, not source content; the separate write gate still validates its
    // syntax, future skew and 24-hour TTL. Any identity/content drift between
    // preflight and execute still changes the hash and blocks the write. The raw
    // body hash stays available separately for description binding and audit;
    // the two are never mixed.
    const executionScope = buildProductExecutionHashScope({
      payload: publishPayload,
      targetStore,
      sourceStore: lockedSourceScope.sourceStore,
      sourceSkc: lockedSourceScope.sourceSkc,
      standardGoodsSn: taskStandardGoodsSn(task, effectiveExecutionContext),
      sourceDetailLock: currentSourceDetailLock,
      productAliasRegistryFingerprint: PRODUCT_ALIAS_REGISTRY_FINGERPRINT,
      productCatalogFingerprint: PRODUCT_CATALOG_FINGERPRINT,
      emptyDescriptionAuthorization: task?.emptyDescriptionAuthorization || null,
    });
    bodyHash = sha256Stable(publishPayload);
    payloadHash = sha256Stable(executionScope);
    appendUnique(warnings, payloadValidation.warnings);
    appendUnique(blockers, payloadValidation.blockers);
    // Reviewed-material binding lock: the final payload's ar/en description
    // hashes must equal the task's descriptionMaterialBinding hashes. Passing
    // the 5-line shape is not enough; any byte drift blocks dry-run/execute.
    const finalDescriptionPolicy = validateCopyProductDescriptionPolicy(task, publishPayload);
    payloadSummary.descriptionBindingLocked = finalDescriptionPolicy.ok;
    payloadSummary.descriptionPolicyMode = finalDescriptionPolicy.mode;
    appendUnique(blockers, finalDescriptionPolicy.blockers);
  } else {
    appendUnique(blockers, payloadValidation.blockers);
    if (payloadFound?.generationError) {
      const message = `自动生成源商品草稿失败：${payloadFound.generationError}`;
      if (payloadFound?.exactSourceLock) appendUnique(blockers, message);
      else appendUnique(warnings, message);
    }
  }

  if (productRefs.length && !payloadFound?.payload) {
    warnings.push(`已识别任务对象 ${productRefs.join('、')}，但当前 BI 数据不足以还原完整发布 payload；需要补充源店、源 SKC 或更完整商品详情。`);
  }

  if (args.mode === 'execute') {
    if (args.confirm !== SUBMIT_CONFIRM_TEXT) {
      blockers.push(`真实提交必须显式传入 --confirm ${SUBMIT_CONFIRM_TEXT}`);
    }
    const expectedHash = expectedPayloadHash;
    const skipPayloadHashLock = Boolean(task?.skipPayloadHashLock || task?.targets?.skipPayloadHashLock || executionContext?.skipPayloadHashLock || executionContext?.targets?.skipPayloadHashLock);
    if (skipPayloadHashLock) {
      blockers.push('skipPayloadHashLock 已停用；随机供货价和图片顺序已改为任务级确定性结果，必须重新 dry-run 并锁定精确 payload hash。');
    }
    if (!expectedHash) {
      blockers.push('真实提交缺少 dry-run 锁定的 payload hash，不能提交未经锁定的发布 payload。');
    } else if (!payloadHash || payloadHash !== expectedHash) {
      blockers.push(`真实提交 payload hash 与 dry-run 锁定值不一致：expected=${expectedHash || 'missing'} actual=${payloadHash || 'missing'}`);
    }
    const writeClaim = executionContext?.writeClaim && typeof executionContext.writeClaim === 'object'
      ? executionContext.writeClaim
      : null;
    const claimOperations = Array.isArray(writeClaim?.operations)
      ? [...new Set(writeClaim.operations.map(value => String(value || '').trim().toLowerCase()).filter(Boolean))].sort()
      : [];
    const claimOk = Boolean(writeClaim
      && args.claimNonce
      && String(writeClaim.nonce || '') === args.claimNonce
      && String(writeClaim.taskId || '') === String(task?.id || '')
      && normalizeStoreKey(writeClaim.storeKey) === targetStore
      && JSON.stringify(claimOperations) === JSON.stringify(['copy_product_draft'])
      && String(writeClaim.expectedPayloadHash || '') === expectedHash
      && String(writeClaim.expectedPayloadHash || '') === payloadHash
      && String(writeClaim.state || '') === 'claimed');
    if (!claimOk) {
      blockers.push('copy_product_draft 真实提交缺少服务端持久化 write-claim（nonce/taskId/store/expectedPayloadHash/operation 必须一致），禁止调用 publishOrEdit。');
    }
  }

  // 详情锁门在 dry-run 和 execute 都运行：copy_product_draft 两个阶段都必须
  // 持有本次 hydration 生成的当前详情锁；execute 还要求预检锁带
  // sourceDetailLock，旧版只有 hash 的预检会被要求重新 dry-run。
  const copyProductDraft = intents.includes('copy_product_draft');
  const sourceDetailLockGate = validateSourceDetailLockForWrite({
    currentLock: currentSourceDetailLock,
    expectedLock: productDraftLock?.sourceDetailLock || null,
    sourceStore: lockedSourceScope.sourceStore,
    sourceSkc: lockedSourceScope.sourceSkc,
    standardGoodsSn: taskStandardGoodsSn(task, effectiveExecutionContext),
    now: new Date(),
    required: copyProductDraft,
    requireExpectedLock: copyProductDraft && args.mode === 'execute',
  });
  evidence.sourceDetailLockGate = sourceDetailLockGate;
  appendUnique(blockers, asArray(sourceDetailLockGate.blockers).map(row => safeString(row?.message, 1000)));

  const readyForSubmit = blockers.length === 0 && Boolean(publishPayload);
  let publishResult = null;
  if (shouldIssuePublishOrEdit(args.mode, readyForSubmit)) {
    const testWebhookGuard = createLoopbackTestWebhookWriteGuard({baseUrl: client.baseUrl});
    const guardedWrite = await runSheinWebhookExternalWriteGuarded({
      writeStores: [targetStore],
      guard: testWebhookGuard || undefined,
      write: () => client.request('/open-api/goods/product/publishOrEdit', {
        method: 'POST',
        body: publishPayload,
        headers: {language: 'en'},
      }),
    });
    if (!guardedWrite.ok) {
      appendUnique(blockers, guardedWrite.gate?.blockers || ['平台动态安全闸门阻止真实提交。']);
    } else {
      const response = guardedWrite.value;
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
        msg: sanitizePublishPlatformText(publishResult.msg, publishPayload, 300),
        traceId: publishResult.traceId,
      });
      if (String(publishResult.code ?? '') !== '0') {
        blockers.push(`publishOrEdit 返回失败：${sanitizePublishPlatformText(publishResult.msg || publishResult.code || '未知错误', publishPayload, 300)}`);
      } else if (publishResultSucceeded(publishResult)) {
        // Explicit info.success=true: the write was accepted; readback follows.
      } else if (publishInfoExplicitlyFalse(publishResult)) {
        const preValidMessages = publishPreValidMessages(publishResult.info, publishPayload);
        blockers.push(`publishOrEdit 平台预校验失败，未创建新链接：${preValidMessages.join('；') || sanitizePublishPlatformText(publishResult.msg || '未知原因', publishPayload, 300)}`);
      } else {
        blockers.push('publishOrEdit 返回 code=0 但未显式 info.success；无法确认平台是否已接收写请求，禁止重试，需人工核销。');
      }
    }
  }
  const publishSucceeded = publishResultSucceeded(publishResult);
  // Only an original info object with explicit success=false may produce
  // publish_pre_valid_failed; code=0 with missing/unknown success is
  // uncertainty and stays blocked.
  const publishPreValidFailed = Boolean(publishResult && String(publishResult.code ?? '') === '0' && publishInfoExplicitlyFalse(publishResult));
  const readbackFingerprint = extractReadbackFingerprint({
    payload: publishPayload,
    payloadFound,
    targetStore,
    task,
    publishResult,
  });
  const readback = await readbackPublishedProduct(client, readbackFingerprint, {
    enabled: publishSucceeded,
    task,
  });
  readbackFingerprint.readbackStatus = readback.status;

  const state = args.mode === 'execute'
    ? (publishSucceeded ? 'submitted' : (publishPreValidFailed ? 'publish_pre_valid_failed' : 'blocked'))
    : (readyForSubmit ? 'ready_for_submit' : 'blocked');
  const storedPublishResult = compactPublishResultForStorage(publishResult, publishPayload);
  const output = {
    ok: blockers.length === 0,
    runId,
    mode: args.mode,
    state,
    startedAt,
    endedAt: new Date().toISOString(),
    storeKey: targetStore,
    sourceStore: lockedSourceScope.sourceStore,
    sourceSkc: lockedSourceScope.sourceSkc,
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
      productDraftLock: productDraftLock ? {
        sourceStore: productDraftLock.sourceStore,
        sourceSkc: productDraftLock.sourceSkc,
        hopeOnSaleDate: productDraftLock.hopeOnSaleDate,
        payloadHash: productDraftLock.payloadHash,
        sourceDetailHash: productDraftLock.sourceDetailHash || '',
        sourceDetailLock: productDraftLock.sourceDetailLock || null,
        runId: productDraftLock.runId,
      } : null,
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
      assetSha256: payloadFound?.assetSha256 || null,
      safeDefaults,
      manualAttributeOverrides,
      payloadHash,
      bodyHash,
      payloadHashAlgorithm: payloadHash ? PRODUCT_EXECUTION_HASH_ALGORITHM : '',
      summary: payloadSummary,
      validation: payloadValidation,
      sourceStore: payloadFound?.inferred?.sourceStore || null,
      sourceSkc: payloadFound?.inferred?.sourceSkc || null,
      sourceDetailHash: payloadFound?.sourceDetailHash || payloadFound?.sourceDetailLock?.sourceDetailHash || null,
      sourceDetailLock: currentSourceDetailLock,
      generatedDraft: payloadFound?.generatedDraft || null,
      generationError: payloadFound?.generationError || null,
      inferredSource: payloadFound?.inferred || null,
      mappingBlockers: payloadFound?.structuredMappingBlockers || payloadFound?.mappingBlockers || [],
      taskPayloadIgnored: payloadFound?.taskPayloadIgnored === true,
      destinationBindingsApplied: payloadFound?.destinationBindingsApplied || [],
      destinationProjection: payloadFound?.destinationProjection || null,
      preflightLock: productDraftLock ? {
        reused: true,
        sourceStore: productDraftLock.sourceStore,
        sourceSkc: productDraftLock.sourceSkc,
        hopeOnSaleDate: productDraftLock.hopeOnSaleDate,
        payloadHash: productDraftLock.payloadHash,
        sourceDetailHash: productDraftLock.sourceDetailHash || '',
        sourceDetailLock: productDraftLock.sourceDetailLock || null,
        runId: productDraftLock.runId,
      } : null,
    },
    readbackFingerprint,
    readback,
    blockers,
    warnings,
    publishResult: storedPublishResult,
    safety: {
      canSilentWrite: false,
      executeRequiresConfirm: SUBMIT_CONFIRM_TEXT,
      dryRunDoesNotCallPublishOrEdit: args.mode !== 'execute',
      note: '默认只预检；真实 publishOrEdit 必须任务已确认、payload 完整、显式 execute 和确认文本同时满足。',
    },
  };

  const outPath = path.join(args.outDir, `${runId}.local.json`);
  await writeJson(outPath, output);
  if (args.payloadOut && publishPayload) await writeJson(args.payloadOut, publishPayload);
  output.savedTo = rel(outPath);
  if (!args.quiet) console.log(JSON.stringify(output, null, 2));
  process.exitCode = output.ok ? 0 : 2;
}

if (process.env.SHEIN_LINK_OPS_EXECUTOR_SELF_TEST !== '1') main().catch(err => {
  const error = {
    ok: false,
    state: 'error',
    error: err?.stack || err?.message || String(err),
  };
  console.error(JSON.stringify(error, null, 2));
  process.exit(1);
});

export const __testHooks = {
  exactCopySourceLock,
  exactSourceRequiresHazardTemplateDerivation,
  shouldIssuePublishOrEdit,
  applyExactSourceLockedInputCurrentOverride,
  applyExplicitEmptyDescriptionProjection,
  mergeExactSourceDestinationBindings,
  applySafeDefaults,
  applyManualAttributeOverrides,
  applyAttributeTemplateRules,
  sourcePayloadSupplierCodesForProvenance,
  inspectTargetDuplicateProducts,
  resolveLockedSourceScope,
  resolveSourceSpuByExactSkc,
  applyRandomSupplyPrice,
  applyExplicitPublishPreparationOverrides,
  applyTargetStandardGoodsSn,
  taskPublishPreparationOverrides,
  resolvePreflightProductLock,
  taskApprovedImageOrderLocked,
  shufflePublishDetailImages,
  ensurePublishImageSortGlobalUnique,
  normalizePublishImageType,
  publishResultSucceeded,
  strictOwnBoolean,
  sanitizePublishPlatformText,
  publishPreValidMessages,
  compactPublishResultForStorage,
  matchProductReadbackRows,
  descriptionReadbackLanguageList,
  readbackPublishedProduct,
  sha256Stable,
  buildProductExecutionHashScope,
  PRODUCT_EXECUTION_HASH_ALGORITHM,
  PRODUCT_EXECUTION_HASH_SCHEMA,
  sourceDetailLockExecutionHashScope,
  validateSourceDetailLockForWrite,
};
