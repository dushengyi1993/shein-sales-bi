#!/usr/bin/env node
/**
 * Cloud-only repair runner for retire candidates whose shelf action already
 * succeeded but supplier_code was not changed to （废）标准货号.
 *
 * Safety: this script never calls modify-skc-shelf. Execute is blocked on
 * Windows and requires SHEIN_BI_CLOUD_EXECUTION=1 + payload hash + confirm.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';
import {
  asArray,
  buildSupplierCodeRepairPayload,
  inputCurrentFromPayloadAttributes,
  isHardExcludedRetireRow,
  normalizeAttributeId,
  normalizeTemplateAttributeRows,
  existingInputVoltage,
  inferInputVoltage,
  productAttributesFromSpuInfo,
  safeString,
  supplierCodeRepairFinalStatus,
  targetKey,
  wasteGoodsSn,
  INPUT_CURRENT_ATTRIBUTE_ID,
} from '../lib/retire_supplier_code_repair_payload.mjs';
import {resolveOpenApiProductCacheDir, resolveOpenApiProductCacheFile} from '../lib/shein_openapi_product_cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp', 'retire-candidates-execute', 'supplier-code-repair');
const DEFAULT_OPENAPI_PRODUCTS_DIR = resolveOpenApiProductCacheDir({rootDir: ROOT});
const CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
const PARTIAL_EDIT = '/open-api/goods/product/partialEdit';
const SPU_INFO = '/open-api/goods/spu-info';
const SEARCH_PRODUCT = '/open-api/goods/searchProduct';
const QUERY_ATTRIBUTE_TEMPLATE = '/open-api/goods/query-attribute-template';
const QUERY_FILL_STANDARD = '/open-api/goods/query-publish-fill-in-standard';
const GET_ASSOCIATED_ATTRIBUTE_RULES = '/open-api/goods/get-associated-attribute-rules';
const QUERY_DOCUMENT_STATE = '/open-api/goods/query-document-state';
const STORE_INFO = '/open-api/openapi-business-backend/query-store-info';

function parseArgs(argv) {
  const args = {
    input: '',
    mode: 'dry-run',
    outDir: DEFAULT_OUT_DIR,
    config: DEFAULT_CONFIG,
    openapiProductsDir: DEFAULT_OPENAPI_PRODUCTS_DIR,
    payloadHash: '',
    confirm: '',
    sleepMs: 350,
    continueOnError: false,
    startIndex: 0,
    maxRows: 0,
    useProductSnapshot: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input') args.input = path.resolve(String(argv[++i] || ''));
    else if (a === '--mode') args.mode = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--dry-run') args.mode = 'dry-run';
    else if (a === '--execute') args.mode = 'execute';
    else if (a === '--out-dir') args.outDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--config') args.config = path.resolve(String(argv[++i] || ''));
    else if (a === '--openapi-products-dir') args.openapiProductsDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--payload-hash') args.payloadHash = String(argv[++i] || '').trim();
    else if (a === '--confirm') args.confirm = String(argv[++i] || '').trim();
    else if (a === '--sleep-ms') args.sleepMs = Number(argv[++i] || 350);
    else if (a === '--continue-on-error') args.continueOnError = true;
    else if (a === '--start-index') args.startIndex = Number(argv[++i] || 0);
    else if (a === '--max-rows') args.maxRows = Math.max(0, Number(argv[++i] || 0));
    else if (a === '--use-product-snapshot') args.useProductSnapshot = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.input) throw new Error('--input <previous final-summary.json> is required');
  if (!['dry-run', 'execute'].includes(args.mode)) throw new Error('--mode must be dry-run or execute');
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/repair_retire_supplier_code_openapi.mjs --input /srv/.../final-summary.json --dry-run
  SHEIN_BI_CLOUD_EXECUTION=1 node scripts/repair_retire_supplier_code_openapi.mjs \\
    --input /srv/.../final-summary.json --execute --payload-hash <dry-run hash> --confirm ${CONFIRM_TEXT}

This runner only calls partialEdit + read endpoints; it never calls modify-skc-shelf.
`);
}

async function readJson(file) { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
async function writeJson(file, data) { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8'); }
function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}
function sha256Stable(v) { return crypto.createHash('sha256').update(stableJson(v), 'utf8').digest('hex'); }
function nowStamp() { return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14); }
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, '/'); }
function normalizeStore(v) { return safeString(v, 40).toUpperCase(); }
function compactRow(row) {
  const desiredSupplierCode = safeString(row.desired_supplier_code || row.desiredSupplierCode || row.target_supplier_code || row.targetSupplierCode || row.suggested_waste_goods_sn || row.waste_goods_sn, 260);
  return {
    store: normalizeStore(row.store || row.storeKey),
    spu: safeString(row.spu || row.spuName, 180),
    skc: safeString(row.skc || row.skcName, 180),
    standard_goods_sn: safeString(row.standard_goods_sn || row.standardGoodsSn || row.canonical, 260),
    raw_goods_sn: safeString(row.raw_goods_sn || row.rawGoodsSn || row.current_supplier_code || row.currentSupplierCode, 260),
    supplierCode: safeString(row.current_supplier_code || row.currentSupplierCode || row.supplierCode || row.supplier_code, 260),
    desired_supplier_code: desiredSupplierCode,
    suggested_waste_goods_sn: desiredSupplierCode,
    waste_goods_sn: desiredSupplierCode || wasteGoodsSn(row),
    product_model: safeString(row.product_model || row.productModel, 180),
    status: safeString(row.status || row.finalStatus, 80),
    operation: safeString(row.operation || (desiredSupplierCode ? 'normalize_supplier_code' : 'repair_supplier_code_only'), 100),
    finalStatus: safeString(row.finalStatus || row.status, 80),
    partialVersion: safeString(row.partialVersion || '', 120),
  };
}
function compactCall(name, endpoint, response, write = false) {
  const data = response?.data || response || {};
  const info = data.info || {};
  return {
    name,
    endpoint,
    write,
    httpStatus: response?.status ?? response?.httpStatus ?? null,
    code: data.code ?? null,
    msg: safeString(data.msg || '', 300),
    traceId: data.traceId ?? null,
    infoSuccess: info.success ?? null,
    infoVersion: info.version ?? null,
    preValidResult: info.pre_valid_result ?? null,
  };
}

function requireSuccessfulRead(response, label, {requireInfo = true} = {}) {
  const data = response?.data || response || {};
  if (response?.ok === false || String(data?.code) !== '0') {
    throw new Error(`${label} failed: code=${data?.code ?? 'missing'} msg=${safeString(data?.msg || '', 300)}`);
  }
  if (requireInfo && (data?.info === undefined || data?.info === null)) {
    throw new Error(`${label} returned no info payload.`);
  }
  return data.info;
}

function productModelFromInfo(info) {
  const modelAttr = asArray(info?.productAttributeInfoList || info?.product_attribute_info_list)
    .find(attr => normalizeAttributeId(attr?.attributeId ?? attr?.attribute_id) === 1000546);
  return safeString(modelAttr?.attributeValue || modelAttr?.attribute_value || '', 180);
}

function inputCurrentFromInfo(info) {
  const attr = asArray(info?.productAttributeInfoList || info?.product_attribute_info_list)
    .find(row => normalizeAttributeId(row?.attributeId ?? row?.attribute_id) === INPUT_CURRENT_ATTRIBUTE_ID
      && safeString(row?.attributeValue || row?.attribute_value || '', 80)
      && normalizeAttributeId(row?.attributeValueId ?? row?.attribute_value_id));
  if (!attr) return null;
  return {
    attribute_extra_value: safeString(attr.attributeValue || attr.attribute_value, 80),
    attribute_value_id: normalizeAttributeId(attr.attributeValueId ?? attr.attribute_value_id),
  };
}

async function loadClient(configFile, storeKey) {
  const config = await readJson(configFile);
  const stores = Array.isArray(config.stores) ? config.stores : Object.entries(config.stores || {}).map(([key, v]) => ({storeKey: key, ...v}));
  const store = stores.find(s => normalizeStore(s.storeKey || s.key || s.store) === storeKey);
  if (!store?.openKeyId || !store?.secretKey) throw new Error(`Missing OpenAPI key for ${storeKey}`);
  const baseUrl = config.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged;
  return new SheinOpenApiClient({baseUrl, openKeyId: store.openKeyId, secretKey: store.secretKey});
}

async function buildCurrentHintIndex(openapiProductsDir) {
  const byStandard = new Map();
  const byModel = new Map();
  const byProductType = new Map();
  const voltageByStandard = new Map();
  const voltageByModel = new Map();
  const voltageByProductType = new Map();
  const stats = {files: 0, details: 0, hints: 0, errors: 0};
  const add = (map, key, hint) => {
    const normalizedKey = safeString(key, 260);
    if (!normalizedKey) return;
    if (!map.has(normalizedKey)) map.set(normalizedKey, []);
    map.get(normalizedKey).push(hint);
  };
  let stores = [];
  try {
    stores = await fs.readdir(openapiProductsDir, {withFileTypes: true});
  } catch {
    return {byStandard, byModel, byProductType, stats: {...stats, missingDir: openapiProductsDir}};
  }
  for (const entry of stores) {
    if (!entry.isDirectory()) continue;
    const file = path.join(openapiProductsDir, entry.name, 'latest.json');
    let data;
    try {
      data = await readJson(file);
    } catch {
      stats.errors += 1;
      continue;
    }
    stats.files += 1;
    const storeKey = normalizeStore(data.storeKey || entry.name);
    for (const detail of asArray(data.detailResults)) {
      const info = detail?.info || detail?.data || null;
      if (!info) continue;
      stats.details += 1;
      const current = inputCurrentFromInfo(info);
      const model = productModelFromInfo(info);
      const standard = safeString(info.supplierCode || info.supplier_code || '', 260);
      const productTypeId = safeString(info.productTypeId || info.product_type_id || '', 80);
      if (current) {
        const hint = {...current, source: `openapi_products_latest:${storeKey}:${safeString(info.spuName || info.spu_name, 160)}`, standard_goods_sn: standard, productModel: model, productTypeId};
        add(byStandard, standard, hint);
        add(byModel, model, hint);
        add(byProductType, productTypeId, hint);
        stats.hints += 1;
      }
      const voltage = existingInputVoltage(asArray(info.productAttributeInfoList || info.product_attribute_info_list).map(row => ({normalized: {
        attribute_id: row.attributeId ?? row.attribute_id,
        attribute_value_id: row.attributeValueId ?? row.attribute_value_id,
        attribute_extra_value: row.attributeValue ?? row.attribute_value,
      }}))) || (() => {
        const inferred = inferInputVoltage(productAttributesFromSpuInfo(info));
        return inferred?.attribute_extra_value ? {...inferred, source: 'inferred_from_live_product_voltage_attribute'} : null;
      })();
      if (voltage) {
        const hint = {...voltage, source: `openapi_products_latest:${storeKey}:${safeString(info.spuName || info.spu_name, 160)}`, standard_goods_sn: standard, productModel: model, productTypeId};
        add(voltageByStandard, standard, hint);
        add(voltageByModel, model, hint);
        add(voltageByProductType, productTypeId, hint);
      }
    }
  }
  return {byStandard, byModel, byProductType, voltageByStandard, voltageByModel, voltageByProductType, stats};
}

async function buildSpuInfoSnapshotIndex(openapiProductsDir) {
  const byTarget = new Map();
  const stats = {files: 0, details: 0, indexed: 0, errors: 0};
  let stores = [];
  try {
    stores = await fs.readdir(openapiProductsDir, {withFileTypes: true});
  } catch {
    return {byTarget, stats: {...stats, missingDir: openapiProductsDir}};
  }
  for (const entry of stores) {
    if (!entry.isDirectory()) continue;
    try {
      const file = resolveOpenApiProductCacheFile(entry.name, {rootDir: ROOT, cacheDir: openapiProductsDir});
      const data = await readJson(file);
      stats.files += 1;
      const storeKey = normalizeStore(data.storeKey || entry.name);
      for (const detail of asArray(data.detailResults)) {
        const info = detail?.info || detail?.data || null;
        if (!info) continue;
        stats.details += 1;
        const spu = safeString(info.spuName || info.spu_name || detail?.spuName || detail?.spu, 180);
        if (!storeKey || !spu) continue;
        byTarget.set(`${storeKey}|${spu}`, {info, file});
        stats.indexed += 1;
      }
    } catch {
      stats.errors += 1;
    }
  }
  return {byTarget, stats};
}

function chooseHint(rows, preferredValueId = 304301999) {
  const list = asArray(rows).filter(row => row?.attribute_extra_value && normalizeAttributeId(row.attribute_value_id));
  if (!list.length) return null;
  const counts = new Map();
  for (const row of list) {
    const key = `${row.attribute_value_id}|${row.attribute_extra_value}`;
    if (!counts.has(key)) counts.set(key, {row, count: 0});
    counts.get(key).count += 1;
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || (Number(a.row.attribute_value_id) === preferredValueId ? -1 : 0) || (Number(b.row.attribute_value_id) === preferredValueId ? 1 : 0))[0]?.row || null;
}

function chooseVoltageHint(rows) {
  const list = asArray(rows).filter(row => row?.attribute_extra_value);
  if (!list.length) return null;
  const counts = new Map();
  for (const row of list) {
    const key = `${safeString(row.attribute_extra_value, 80)}|${normalizeAttributeId(row.attribute_value_id) || ''}`;
    if (!counts.has(key)) counts.set(key, {row, count: 0});
    counts.get(key).count += 1;
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.row || null;
}

function loadPreviousRows(report) {
  if (String(report?.schemaVersion || '').startsWith('supplier-code-normalization-plan/')) {
    const rows = asArray(report.candidates).map(compactRow);
    if (!rows.length) throw new Error('Normalization plan must contain candidates[]');
    const notChanged = rows.filter(row => row.desired_supplier_code && row.supplierCode !== row.desired_supplier_code);
    return {operationKind: 'normalization', rows, hardExcluded: [], pendingReview: [], alreadyChanged: rows.filter(row => row.supplierCode === row.desired_supplier_code), notChanged, notRetired: []};
  }
  const rows = asArray(report.finalRows || report.rows || report.candidates);
  if (!rows.length) throw new Error('Input must contain finalRows[] from prior retire execution summary');
  const hardExcluded = rows.filter(row => isHardExcludedRetireRow(row)).map(compactRow);
  const pendingReview = rows.filter(row => supplierCodeRepairFinalStatus(row) === 'retired+pendingReview').map(compactRow);
  const alreadyChanged = rows.filter(row => supplierCodeRepairFinalStatus(row) === 'retired+supplierCodeChanged').map(compactRow);
  const notChanged = rows.filter(row => supplierCodeRepairFinalStatus(row) === 'retired+supplierCodeNotChanged' && !isHardExcludedRetireRow(row)).map(compactRow);
  const notRetired = rows.filter(row => supplierCodeRepairFinalStatus(row) === 'not_retired').map(compactRow);
  return {operationKind: 'retire_repair', rows, hardExcluded, pendingReview, alreadyChanged, notChanged, notRetired};
}

function templateRowsById(templateResponse) {
  return normalizeTemplateAttributeRows(templateResponse?.data || templateResponse);
}

function linkedRuleAttributeList(info) {
  const seen = new Set();
  const out = [];
  for (const item of productAttributesFromSpuInfo(info)) {
    const attributeId = normalizeAttributeId(item.normalized?.attribute_id);
    const attributeValueId = normalizeAttributeId(item.normalized?.attribute_value_id);
    if (!attributeId) continue;
    const key = `${attributeId}|${attributeValueId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = {attribute_id: attributeId};
    if (attributeValueId) row.attribute_value_id = attributeValueId;
    out.push(row);
  }
  return out;
}

async function queryLinkedRequirements({storeKey, pendingDetails, client, calls}) {
  const bySkc = new Map();
  const errorsBySkc = new Map();
  for (let offset = 0; offset < pendingDetails.length; offset += 10) {
    const batch = pendingDetails.slice(offset, offset + 10);
    const body = {
      get_linked_rule_req_list: batch.map(({row, info, productTypeId, categoryId}) => ({
        group_id: row.skc,
        category_id: categoryId,
        product_type_id: productTypeId,
        attribute_list: linkedRuleAttributeList(info),
      })),
    };
    let resp = null;
    let lastError = '';
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        resp = await client.request(GET_ASSOCIATED_ATTRIBUTE_RULES, {method: 'POST', body, headers: {language: 'zh-cn'}});
        calls.push({storeKey, targets: batch.map(item => item.row.skc), retryAttempt: attempt, ...compactCall('get-associated-attribute-rules', GET_ASSOCIATED_ATTRIBUTE_RULES, resp, false)});
        if (String(resp.data?.code) === '0') break;
        lastError = `http=${resp.status ?? '-'} code=${resp.data?.code || '-'} msg=${resp.data?.msg || '-'}`;
      } catch (err) {
        lastError = safeString(err?.message || err, 300);
        calls.push({storeKey, targets: batch.map(item => item.row.skc), retryAttempt: attempt, name: 'get-associated-attribute-rules', endpoint: GET_ASSOCIATED_ATTRIBUTE_RULES, write: false, error: lastError});
      }
      resp = null;
      if (attempt < 4) await wait(attempt * 600);
    }
    if (!resp || String(resp.data?.code) !== '0') {
      for (const item of batch) errorsBySkc.set(item.row.skc, `associated attribute rule query failed after 4 attempts: ${lastError || 'empty response'}`);
      continue;
    }
    for (const group of asArray(resp.data?.info?.data)) {
      const required = asArray(group?.link_rule_attribute_list)
        .map(rule => normalizeAttributeId(rule?.attribute_id ?? rule?.attributeId))
        .filter(Boolean);
      bySkc.set(safeString(group?.group_id ?? group?.groupId, 180), [...new Set(required)]);
    }
    for (const item of batch) {
      if (!bySkc.has(item.row.skc)) errorsBySkc.set(item.row.skc, `missing linked-rule response for ${item.row.skc}`);
    }
    await wait(80);
  }
  return {bySkc, errorsBySkc};
}

async function prepareStore({storeKey, rows, client, calls, globalHintIndex, spuInfoSnapshotIndex = null}) {
  const payloads = [];
  const blockers = [];
  const warnings = [];
  const templateCache = new Map();
  const fillCache = new Map();
  const currentHintsByStandard = new Map();
  const currentHintsByModel = new Map();
  const currentHintsByProductType = new Map();
  const voltageHintsByStandard = new Map();
  const voltageHintsByModel = new Map();
  const voltageHintsByProductType = new Map();
  const pendingDetails = [];

  await client.request(STORE_INFO, {method: 'POST', body: {}, headers: {language: 'zh-cn'}})
    .then(resp => calls.push({storeKey, ...compactCall('store-info', STORE_INFO, resp, false)}))
    .catch(err => warnings.push(`store-info ${storeKey} failed: ${safeString(err?.message || err, 300)}`));

  for (const row of rows) {
    let spuResp;
    const snapshotRecord = spuInfoSnapshotIndex?.byTarget?.get(`${storeKey}|${row.spu}`) || null;
    const snapshotInfo = snapshotRecord?.info || null;
    try {
      if (snapshotInfo) {
        spuResp = {status: 200, data: {code: '0', msg: 'OK', info: snapshotInfo}};
        calls.push({storeKey, target: row.skc, name: 'spu-info-snapshot', endpoint: SPU_INFO, write: false, source: snapshotRecord?.file || 'SHEIN_OPENAPI_PRODUCT_CACHE_DIR/<STORE>/latest.json', httpStatus: 200, code: '0', msg: 'OK'});
      } else {
        spuResp = await client.request(SPU_INFO, {method: 'POST', body: {spuName: row.spu, languageList: ['en', 'ar', 'zh-cn']}, headers: {language: 'zh-cn'}});
        calls.push({storeKey, target: row.skc, ...compactCall('spu-info', SPU_INFO, spuResp, false)});
      }
    } catch (err) {
      blockers.push({row, blockers: [`spu-info failed: ${safeString(err?.message || err, 300)}`]});
      continue;
    }
    if (String(spuResp.data?.code) !== '0' || !spuResp.data?.info) {
      blockers.push({row, blockers: [`spu-info not ok: code=${spuResp.data?.code || '-'} msg=${spuResp.data?.msg || '-'}`]});
      continue;
    }
    const info = spuResp.data.info;
    const productTypeId = Number(info.productTypeId ?? info.product_type_id);
    const categoryId = Number(info.categoryId ?? info.category_id);
    const model = productModelFromInfo(info);
    const existingCurrent = inputCurrentFromInfo(info);
    if (existingCurrent) {
      const hint = {...existingCurrent, source: `store_${storeKey}_existing_current`};
      if (!currentHintsByStandard.has(row.standard_goods_sn)) currentHintsByStandard.set(row.standard_goods_sn, hint);
      if (model && !currentHintsByModel.has(model)) currentHintsByModel.set(model, hint);
      if (productTypeId && !currentHintsByProductType.has(productTypeId)) currentHintsByProductType.set(productTypeId, hint);
    }
    const existingVoltage = existingInputVoltage(asArray(info.productAttributeInfoList || info.product_attribute_info_list).map(row => ({normalized: {
      attribute_id: row.attributeId ?? row.attribute_id,
      attribute_value_id: row.attributeValueId ?? row.attribute_value_id,
      attribute_extra_value: row.attributeValue ?? row.attribute_value,
    }}))) || (() => {
      const inferred = inferInputVoltage(productAttributesFromSpuInfo(info));
      return inferred?.attribute_extra_value ? {...inferred, source: 'inferred_from_current_spu_voltage_attribute'} : null;
    })();
    if (existingVoltage) {
      const hint = {...existingVoltage, source: `store_${storeKey}_existing_voltage`};
      if (!voltageHintsByStandard.has(row.standard_goods_sn)) voltageHintsByStandard.set(row.standard_goods_sn, hint);
      if (model && !voltageHintsByModel.has(model)) voltageHintsByModel.set(model, hint);
      if (productTypeId && !voltageHintsByProductType.has(productTypeId)) voltageHintsByProductType.set(productTypeId, hint);
    }
    pendingDetails.push({row, info, productTypeId, categoryId, model});
    await wait(40);
  }

  let linkedRequirements;
  try {
    linkedRequirements = await queryLinkedRequirements({storeKey, pendingDetails, client, calls});
  } catch (err) {
    const reason = `associated attribute rule query failed: ${safeString(err?.message || err, 300)}`;
    blockers.push(...pendingDetails.map(({row}) => ({row, blockers: [reason]})));
    return {payloads, blockers, warnings};
  }

  for (const item of pendingDetails) {
    const {row, info, productTypeId, categoryId, model} = item;
    const linkedRuleError = linkedRequirements.errorsBySkc.get(row.skc);
    if (linkedRuleError) {
      blockers.push({row, blockers: [linkedRuleError]});
      continue;
    }
    if (!productTypeId) {
      blockers.push({row, blockers: ['missing_product_type_id_from_spu_info']});
      continue;
    }
    if (!templateCache.has(productTypeId)) {
      const resp = await client.request(QUERY_ATTRIBUTE_TEMPLATE, {method: 'POST', body: {product_type_id_list: [productTypeId]}, headers: {language: 'zh-cn'}});
      calls.push({storeKey, productTypeId, ...compactCall('query-attribute-template', QUERY_ATTRIBUTE_TEMPLATE, resp, false)});
      requireSuccessfulRead(resp, `query-attribute-template productType=${productTypeId}`);
      const rows = templateRowsById(resp);
      if (!rows.length) throw new Error(`query-attribute-template productType=${productTypeId} returned no normalized attributes.`);
      templateCache.set(productTypeId, rows);
      await wait(80);
    }
    if (categoryId && !fillCache.has(categoryId)) {
      const resp = await client.request(QUERY_FILL_STANDARD, {method: 'POST', body: {category_id: categoryId, spu_name: row.spu}, headers: {language: 'zh-cn'}});
      calls.push({storeKey, categoryId, ...compactCall('query-publish-fill-in-standard', QUERY_FILL_STANDARD, resp, false)});
      const info = requireSuccessfulRead(resp, `query-publish-fill-in-standard category=${categoryId}`);
      if (!info || typeof info !== 'object' || Array.isArray(info) || Object.keys(info).length === 0) {
        throw new Error(`query-publish-fill-in-standard category=${categoryId} returned empty fill rules.`);
      }
      fillCache.set(categoryId, info);
      await wait(80);
    }
    const inputCurrentHint = currentHintsByStandard.get(row.standard_goods_sn)
      || chooseHint(globalHintIndex?.byStandard?.get(row.standard_goods_sn))
      || (model ? currentHintsByModel.get(model) : null)
      || (model ? chooseHint(globalHintIndex?.byModel?.get(model)) : null)
      || currentHintsByProductType.get(productTypeId)
      || chooseHint(globalHintIndex?.byProductType?.get(String(productTypeId)))
      || chooseHint(globalHintIndex?.byProductType?.get(productTypeId))
      || null;
    const inputVoltageHint = globalHintIndex?.voltageByTarget?.get(`${storeKey}|${row.skc}`)
      || voltageHintsByStandard.get(row.standard_goods_sn)
      || chooseVoltageHint(globalHintIndex?.voltageByStandard?.get(row.standard_goods_sn))
      || (model ? voltageHintsByModel.get(model) : null)
      || (model ? chooseVoltageHint(globalHintIndex?.voltageByModel?.get(model)) : null)
      || voltageHintsByProductType.get(productTypeId)
      || chooseVoltageHint(globalHintIndex?.voltageByProductType?.get(String(productTypeId)))
      || chooseVoltageHint(globalHintIndex?.voltageByProductType?.get(productTypeId))
      || null;
    const hazardousClassificationHint = globalHintIndex?.hazardousByCanonical?.get(row.standard_goods_sn) || null;
    const requiredAttributeHints = globalHintIndex?.requiredAttrsByCanonical?.get(row.standard_goods_sn) || null;
    const repair = buildSupplierCodeRepairPayload({
      row,
      spuInfo: {info},
      attributeTemplateRows: templateCache.get(productTypeId) || [],
      fillStandardInfo: fillCache.get(categoryId) || {},
      inputCurrentHint,
      inputVoltageHint,
      hazardousClassificationHint,
      requiredAttributeHints,
      requiredLinkedAttributeIds: linkedRequirements.bySkc.get(row.skc),
    });
    if (repair.blockers.length) {
      blockers.push({row, blockers: repair.blockers, evidence: repair.evidence});
      continue;
    }
    const payload = {
      storeKey,
      operation: row.operation || 'repair_supplier_code_only',
      endpoint: PARTIAL_EDIT,
      body: repair.body,
      targetSkcs: [row.skc],
      expectedWaste: row.waste_goods_sn,
      evidence: repair.evidence,
      applied: repair.applied,
    };
    const current = inputCurrentFromPayloadAttributes(repair.body.product_attribute_list);
    if (current && inputCurrentHint && current.source !== 'sibling_current_hint') {
      payload.evidence.inputCurrentHintAvailable = true;
    }
    payloads.push(payload);
  }

  return {payloads, blockers, warnings};
}

function assertExecuteAllowed(args, payloadHash) {
  if (os.platform() === 'win32') throw new Error('Refusing execute on Windows/local Codex. Use shein-bi-tencent cloud only.');
  if (process.env.SHEIN_BI_CLOUD_EXECUTION !== '1') throw new Error('Execute requires SHEIN_BI_CLOUD_EXECUTION=1 on shein-bi-tencent.');
  if (args.confirm !== CONFIRM_TEXT) throw new Error(`Execute requires --confirm ${CONFIRM_TEXT}`);
  if (!args.payloadHash || args.payloadHash !== payloadHash) throw new Error(`Payload hash mismatch: expected=${args.payloadHash || 'missing'} actual=${payloadHash}`);
}

function assertCloudOpenApiAllowed() {
  if (os.platform() === 'win32' && process.env.SHEIN_BI_ALLOW_LOCAL_OPENAPI_EXECUTOR !== '1') {
    throw new Error('Refusing SHEIN OpenAPI access on Windows/local Codex. Run dry-run/execute on shein-bi-tencent cloud only.');
  }
}

async function readbackStore({storeKey, rows, client, calls}) {
  const out = [];
  for (const row of rows) {
    try {
      const resp = await client.request(SEARCH_PRODUCT, {method: 'POST', body: {pageNum: 1, pageSize: 10, skcNameList: [row.skc], languageList: ['en', 'zh-cn']}, headers: {language: 'zh-cn'}});
      calls.push({storeKey, target: row.skc, ...compactCall('searchProduct-readback', SEARCH_PRODUCT, resp, false)});
      const products = asArray(resp.data?.info?.data);
      let found = null;
      for (const spu of products) {
        for (const skc of asArray(spu.skcList || spu.skc_list)) {
          if (safeString(skc?.skcName || skc?.skc_name, 180) === row.skc) found = skc;
        }
      }
      out.push({
        ...row,
        found: Boolean(found),
        supplierCode: safeString(found?.supplierCode || found?.supplier_code || '', 260),
        supplierCodeMatchesWaste: safeString(found?.supplierCode || found?.supplier_code || '', 260) === row.waste_goods_sn,
        skcShelfStatus: found?.skcShelfStatus ?? found?.skc_shelf_status ?? null,
        siteShelfStatus: asArray(found?.skcSiteShelfStatusList || found?.skc_site_shelf_status_list)[0]?.status ?? null,
      });
      await wait(80);
    } catch (err) {
      out.push({...row, found: false, error: safeString(err?.message || err, 500)});
    }
  }
  return out;
}

async function queryPendingDocs({pendingReview, args, calls}) {
  const out = [];
  const byStore = new Map();
  for (const row of pendingReview) {
    if (!row.partialVersion) continue;
    if (!byStore.has(row.store)) byStore.set(row.store, []);
    byStore.get(row.store).push(row);
  }
  for (const [storeKey, rows] of byStore) {
    const client = await loadClient(args.config, storeKey);
    for (const row of rows) {
      const resp = await client.request(QUERY_DOCUMENT_STATE, {method: 'POST', body: {spuList: [{spuName: row.spu, version: row.partialVersion}]}, headers: {language: 'zh-cn'}});
      calls.push({storeKey, target: row.skc, ...compactCall('query-document-state', QUERY_DOCUMENT_STATE, resp, false)});
      out.push({row, response: compactCall('query-document-state', QUERY_DOCUMENT_STATE, resp, false), rawInfo: resp.data?.info || null});
      await wait(80);
    }
  }
  return out;
}

function validatePreparedNormalizationPlan(plan) {
  if (plan?.schemaVersion !== 'supplier-code-normalization-execute/v1') throw new Error('Unsupported prepared plan schemaVersion.');
  if (plan?.safety?.doesNotCallModifySkcShelf !== true) throw new Error('Prepared plan is missing doesNotCallModifySkcShelf=true.');
  const payloads = asArray(plan?.payloads);
  if (!payloads.length) throw new Error('Prepared normalization plan must contain payloads[].');
  const seen = new Set();
  for (const payload of payloads) {
    const target = safeString(payload?.targetSkcs?.[0], 180);
    const key = `${normalizeStore(payload?.storeKey)}|${target}`;
    if (!target || seen.has(key)) throw new Error(`Prepared plan has missing or duplicate target: ${key}`);
    seen.add(key);
    if (payload?.endpoint !== PARTIAL_EDIT || payload?.operation !== 'normalize_supplier_code') throw new Error(`Prepared plan contains unauthorized operation for ${key}`);
    if (asArray(payload?.targetSkcs).length !== 1) throw new Error(`Prepared plan targetSkcs must contain exactly one SKC for ${key}`);
    const skc = asArray(payload?.body?.skc_list).find(row => safeString(row?.skc_name, 180) === target);
    if (!payload?.body?.spu_name || !skc) throw new Error(`Prepared plan payload is incomplete for ${key}`);
    if (safeString(skc?.supplier_code, 260) !== safeString(payload?.expectedWaste, 260)) throw new Error(`Prepared plan supplier code mismatch for ${key}`);
  }
  return payloads;
}

async function runPreparedNormalizationPlan({args, runDir, plan, startedAt}) {
  const payloads = validatePreparedNormalizationPlan(plan);
  if (!Number.isInteger(args.startIndex) || args.startIndex < 0 || args.startIndex > payloads.length) {
    throw new Error(`--start-index must be an integer between 0 and ${payloads.length}`);
  }
  const selectedPayloads = args.maxRows > 0
    ? payloads.slice(args.startIndex, args.startIndex + args.maxRows)
    : payloads.slice(args.startIndex);
  const payloadHash = sha256Stable(plan);
  const calls = [];
  const summary = {
    ok: true,
    mode: args.mode,
    generatedAt: startedAt,
    input: args.input,
    outDir: runDir,
    frozenPreparedPlan: true,
    selectionCounts: {
      sourceRows: payloads.length,
      skippedPreparedRows: args.startIndex,
      maxPreparedRows: args.maxRows || null,
      hardExcludedRows: 0,
      alreadyChangedRows: 0,
      pendingReviewRows: 0,
      needsSupplierCodeRepairRows: selectedPayloads.length,
      selectedRepairRows: selectedPayloads.length,
      notRetiredRows: 0,
      repairPayloads: selectedPayloads.length,
      isolatedRepairBlockers: 0,
    },
    payloadHash,
    payloadHashAlgorithm: 'sha256-stable-json-v1',
    operationKind: 'normalization',
    continueOnError: args.continueOnError,
    blockers: [],
    warnings: [],
  };
  await writeJson(path.join(runDir, 'repair-plan.json'), plan);
  await writeJson(path.join(runDir, 'dry-run-summary.json'), summary);
  await writeJson(path.join(runDir, 'read-calls.json'), calls);
  if (args.mode === 'dry-run') {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  throw new Error('Supplier-code normalization execute is disabled until immutable scope binding, per-row live preflight, and resumable checkpoints are implemented. Dry-run planning remains available.');

  assertExecuteAllowed(args, payloadHash);
  const results = [];
  for (const payload of selectedPayloads) {
    const client = await loadClient(args.config, payload.storeKey);
    try {
      const resp = await client.request(payload.endpoint, {method: 'POST', body: payload.body, headers: {language: 'zh-cn'}});
      const call = compactCall(payload.operation, payload.endpoint, resp, true);
      calls.push({storeKey: payload.storeKey, targetSkcs: payload.targetSkcs, ...call});
      const ok = String(resp.data?.code) === '0' && resp.data?.info?.success !== false;
      results.push({payload, response: call, ok});
      if (!ok && !args.continueOnError) break;
    } catch (err) {
      results.push({payload, ok: false, error: safeString(err?.message || err, 500)});
      if (!args.continueOnError) break;
    }
    await wait(args.sleepMs);
  }
  const rowsForReadback = selectedPayloads.map(payload => ({store: payload.storeKey, spu: payload.body.spu_name, skc: payload.targetSkcs[0], waste_goods_sn: payload.expectedWaste, standard_goods_sn: ''}));
  const readback = [];
  const byStore = new Map();
  for (const row of rowsForReadback) {
    if (!byStore.has(row.store)) byStore.set(row.store, []);
    byStore.get(row.store).push(row);
  }
  for (const [storeKey, rows] of byStore) {
    const client = await loadClient(args.config, storeKey);
    readback.push(...await readbackStore({storeKey, rows, client, calls}));
  }
  const final = {
    ...summary,
    ok: results.length === selectedPayloads.length && results.every(row => row.ok) && readback.every(row => row.supplierCodeMatchesWaste),
    endedAt: new Date().toISOString(),
    executeResults: results,
    readback,
    finalCounts: {
      repairSubmitted: results.length,
      repairAccepted: results.filter(row => row.ok).length,
      readbackWasteMatched: readback.filter(row => row.supplierCodeMatchesWaste).length,
      stillNotWaste: readback.filter(row => !row.supplierCodeMatchesWaste).length,
      isolatedRepairBlockers: 0,
    },
  };
  await writeJson(path.join(runDir, 'execute-results.json'), results);
  await writeJson(path.join(runDir, 'post-readback.json'), readback);
  await writeJson(path.join(runDir, 'final-summary.json'), final);
  await writeJson(path.join(runDir, 'read-calls.json'), calls);
  console.log(JSON.stringify({ok: final.ok, outDir: runDir, payloadHash, finalCounts: final.finalCounts}, null, 2));
  if (!final.ok) process.exitCode = 3;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertCloudOpenApiAllowed();
  const startedAt = new Date().toISOString();
  const stamp = nowStamp();
  const runDir = path.join(args.outDir, `${stamp}-${args.mode}`);
  await fs.mkdir(runDir, {recursive: true});

  const previous = await readJson(args.input);
  if (previous?.schemaVersion === 'supplier-code-normalization-execute/v1') {
    await runPreparedNormalizationPlan({args, runDir, plan: previous, startedAt});
    return;
  }
  const loaded = loadPreviousRows(previous);
  const normalization = loaded.operationKind === 'normalization';
  let targets = loaded.notChanged;
  if (args.maxRows > 0) targets = targets.slice(0, args.maxRows);
  const calls = [];
  const globalHintIndex = await buildCurrentHintIndex(args.openapiProductsDir);
  const spuInfoSnapshotIndex = args.useProductSnapshot
    ? await buildSpuInfoSnapshotIndex(args.openapiProductsDir)
    : null;
  globalHintIndex.voltageByTarget = new Map(Object.entries(previous?.attributeEvidence?.inputVoltageByTarget || {}));
  globalHintIndex.hazardousByCanonical = new Map(Object.entries(previous?.attributeEvidence?.hazardousClassificationByCanonical || {}));
  globalHintIndex.requiredAttrsByCanonical = new Map(Object.entries(previous?.attributeEvidence?.requiredAttributesByCanonical || {}));
  for (const [canonical, hint] of Object.entries(previous?.attributeEvidence?.inputCurrentByCanonical || {})) {
    if (!hint?.attribute_extra_value || !normalizeAttributeId(hint?.attribute_value_id)) continue;
    if (!globalHintIndex.byStandard.has(canonical)) globalHintIndex.byStandard.set(canonical, []);
    globalHintIndex.byStandard.get(canonical).push({...hint, source: hint.source || 'normalization_plan_attribute_evidence'});
  }
  const allPayloads = [];
  const allBlockers = [];
  const allWarnings = [];
  const byStore = new Map();
  for (const row of targets) {
    if (!byStore.has(row.store)) byStore.set(row.store, []);
    byStore.get(row.store).push(row);
  }
  for (const [storeKey, rows] of [...byStore.entries()].sort()) {
    const client = await loadClient(args.config, storeKey);
    const prepared = await prepareStore({storeKey, rows, client, calls, globalHintIndex, spuInfoSnapshotIndex});
    allPayloads.push(...prepared.payloads);
    allBlockers.push(...prepared.blockers.map(blocker => ({storeKey, ...blocker})));
    allWarnings.push(...prepared.warnings.map(warning => `${storeKey}: ${warning}`));
  }
  const pendingDocumentStates = await queryPendingDocs({pendingReview: loaded.pendingReview, args, calls});
  const plan = {
    schemaVersion: normalization ? 'supplier-code-normalization-execute/v1' : 'retire-supplier-code-repair/v1',
    operationOrder: [normalization ? 'normalize_supplier_code' : 'repair_supplier_code_only'],
    safety: {
      doesNotCallModifySkcShelf: true,
      writeEndpoints: [PARTIAL_EDIT],
      readEndpoints: [STORE_INFO, SPU_INFO, QUERY_ATTRIBUTE_TEMPLATE, QUERY_FILL_STANDARD, GET_ASSOCIATED_ATTRIBUTE_RULES, QUERY_DOCUMENT_STATE, SEARCH_PRODUCT],
      hardExclude: normalization ? null : {store: 'FY', standardGoodsSn: 'SK-5110电磁炉'},
    },
    payloads: allPayloads,
  };
  const payloadHash = sha256Stable(plan);
  const summary = {
    ok: allPayloads.length > 0 && (!normalization || allBlockers.length === 0),
    mode: args.mode,
    generatedAt: startedAt,
    input: args.input,
    outDir: runDir,
    previousCounts: previous.counts || null,
    selectionCounts: {
      sourceRows: loaded.rows.length,
      hardExcludedRows: loaded.hardExcluded.length,
      alreadyChangedRows: loaded.alreadyChanged.length,
      pendingReviewRows: loaded.pendingReview.length,
      needsSupplierCodeRepairRows: loaded.notChanged.length,
      selectedRepairRows: targets.length,
      notRetiredRows: loaded.notRetired.length,
      repairPayloads: allPayloads.length,
      isolatedRepairBlockers: allBlockers.length,
    },
    payloadHash,
    payloadHashAlgorithm: 'sha256-stable-json-v1',
    operationKind: loaded.operationKind,
    currentHintIndexStats: globalHintIndex.stats,
    spuInfoSnapshotStats: spuInfoSnapshotIndex?.stats || null,
    blockers: allBlockers,
    warnings: allWarnings,
    hardExcluded: loaded.hardExcluded,
    pendingDocumentStates,
  };
  await writeJson(path.join(runDir, 'repair-plan.json'), plan);
  await writeJson(path.join(runDir, 'dry-run-summary.json'), summary);
  await writeJson(path.join(runDir, 'read-calls.json'), calls);
  if (args.mode === 'dry-run') {
    console.log(JSON.stringify({...summary, outDir: runDir}, null, 2));
    process.exit(summary.ok ? 0 : 2);
  }

  if (normalization && allBlockers.length) throw new Error(`Refusing normalization execute with ${allBlockers.length} isolated preflight blocker(s).`);
  if (normalization) {
    throw new Error('Supplier-code normalization execute is disabled until immutable scope binding, per-row live preflight, and resumable checkpoints are implemented. Dry-run planning remains available.');
  }

  assertExecuteAllowed(args, payloadHash);
  const results = [];
  for (const payload of allPayloads) {
    const client = await loadClient(args.config, payload.storeKey);
    try {
      const resp = await client.request(payload.endpoint, {method: 'POST', body: payload.body, headers: {language: 'zh-cn'}});
      const call = compactCall(payload.operation, payload.endpoint, resp, true);
      calls.push({storeKey: payload.storeKey, targetSkcs: payload.targetSkcs, ...call});
      const ok = String(resp.data?.code) === '0' && resp.data?.info?.success !== false;
      results.push({payload, response: call, ok});
      if (!ok && !args.continueOnError) break;
    } catch (err) {
      results.push({payload, ok: false, error: safeString(err?.message || err, 500)});
      if (!args.continueOnError) break;
    }
    await wait(args.sleepMs);
  }
  const rowsForReadback = allPayloads.map(payload => ({store: payload.storeKey, spu: payload.body.spu_name, skc: payload.targetSkcs[0], waste_goods_sn: payload.expectedWaste, standard_goods_sn: ''}));
  const readback = [];
  const rbByStore = new Map();
  for (const row of rowsForReadback) {
    if (!rbByStore.has(row.store)) rbByStore.set(row.store, []);
    rbByStore.get(row.store).push(row);
  }
  for (const [storeKey, rows] of rbByStore) {
    const client = await loadClient(args.config, storeKey);
    readback.push(...await readbackStore({storeKey, rows, client, calls}));
  }
  const final = {
    ...summary,
    ok: results.every(r => r.ok) && readback.every(r => r.supplierCodeMatchesWaste),
    endedAt: new Date().toISOString(),
    executeResults: results,
    readback,
    finalCounts: {
      previousRetired: loaded.rows.filter(row => supplierCodeRepairFinalStatus(row) !== 'not_retired').length,
      previousHardExcluded: loaded.hardExcluded.length,
      repairSubmitted: results.length,
      repairAccepted: results.filter(r => r.ok).length,
      readbackWasteMatched: readback.filter(r => r.supplierCodeMatchesWaste).length,
      stillNotWaste: readback.filter(r => !r.supplierCodeMatchesWaste).length,
      isolatedRepairBlockers: allBlockers.length,
      pendingReviewRows: loaded.pendingReview.length,
    },
  };
  await writeJson(path.join(runDir, 'execute-results.json'), results);
  await writeJson(path.join(runDir, 'post-readback.json'), readback);
  await writeJson(path.join(runDir, 'final-summary.json'), final);
  await writeJson(path.join(runDir, 'read-calls.json'), calls);
  console.log(JSON.stringify({ok: final.ok, outDir: runDir, payloadHash, finalCounts: final.finalCounts, blockers: final.blockers.slice(0, 10), warnings: final.warnings.slice(0, 10)}, null, 2));
  process.exit(final.ok ? 0 : 3);
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
