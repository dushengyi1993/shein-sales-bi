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
  safeString,
  supplierCodeRepairFinalStatus,
  targetKey,
  wasteGoodsSn,
  INPUT_CURRENT_ATTRIBUTE_ID,
} from '../lib/retire_supplier_code_repair_payload.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp', 'retire-candidates-execute', 'supplier-code-repair');
const DEFAULT_OPENAPI_PRODUCTS_DIR = process.env.SHEIN_OPENAPI_PRODUCTS_DIR || path.join(ROOT, 'outputs', 'shein_openapi_products');
const CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
const PARTIAL_EDIT = '/open-api/goods/product/partialEdit';
const SPU_INFO = '/open-api/goods/spu-info';
const SEARCH_PRODUCT = '/open-api/goods/searchProduct';
const QUERY_ATTRIBUTE_TEMPLATE = '/open-api/goods/query-attribute-template';
const QUERY_FILL_STANDARD = '/open-api/goods/query-publish-fill-in-standard';
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
    maxRows: 0,
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
    else if (a === '--max-rows') args.maxRows = Math.max(0, Number(argv[++i] || 0));
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
  return {
    store: normalizeStore(row.store || row.storeKey),
    spu: safeString(row.spu || row.spuName, 180),
    skc: safeString(row.skc || row.skcName, 180),
    standard_goods_sn: safeString(row.standard_goods_sn || row.standardGoodsSn, 260),
    raw_goods_sn: safeString(row.raw_goods_sn || row.rawGoodsSn, 260),
    waste_goods_sn: wasteGoodsSn(row),
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
      }})));
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

function loadPreviousRows(report) {
  const rows = asArray(report.finalRows || report.rows || report.candidates);
  if (!rows.length) throw new Error('Input must contain finalRows[] from prior retire execution summary');
  const hardExcluded = rows.filter(row => isHardExcludedRetireRow(row)).map(compactRow);
  const pendingReview = rows.filter(row => supplierCodeRepairFinalStatus(row) === 'retired+pendingReview').map(compactRow);
  const alreadyChanged = rows.filter(row => supplierCodeRepairFinalStatus(row) === 'retired+supplierCodeChanged').map(compactRow);
  const notChanged = rows.filter(row => supplierCodeRepairFinalStatus(row) === 'retired+supplierCodeNotChanged' && !isHardExcludedRetireRow(row)).map(compactRow);
  const notRetired = rows.filter(row => supplierCodeRepairFinalStatus(row) === 'not_retired').map(compactRow);
  return {rows, hardExcluded, pendingReview, alreadyChanged, notChanged, notRetired};
}

function templateRowsById(templateResponse) {
  return normalizeTemplateAttributeRows(templateResponse?.data || templateResponse);
}

async function prepareStore({storeKey, rows, client, calls, globalHintIndex}) {
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
    try {
      spuResp = await client.request(SPU_INFO, {method: 'POST', body: {spuName: row.spu, languageList: ['en', 'ar', 'zh-cn']}, headers: {language: 'zh-cn'}});
      calls.push({storeKey, target: row.skc, ...compactCall('spu-info', SPU_INFO, spuResp, false)});
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
    }})));
    if (existingVoltage) {
      const hint = {...existingVoltage, source: `store_${storeKey}_existing_voltage`};
      if (!voltageHintsByStandard.has(row.standard_goods_sn)) voltageHintsByStandard.set(row.standard_goods_sn, hint);
      if (model && !voltageHintsByModel.has(model)) voltageHintsByModel.set(model, hint);
      if (productTypeId && !voltageHintsByProductType.has(productTypeId)) voltageHintsByProductType.set(productTypeId, hint);
    }
    pendingDetails.push({row, info, productTypeId, categoryId, model});
    await wait(40);
  }

  for (const item of pendingDetails) {
    const {row, info, productTypeId, categoryId, model} = item;
    if (!productTypeId) {
      blockers.push({row, blockers: ['missing_product_type_id_from_spu_info']});
      continue;
    }
    if (!templateCache.has(productTypeId)) {
      const resp = await client.request(QUERY_ATTRIBUTE_TEMPLATE, {method: 'POST', body: {product_type_id_list: [productTypeId]}, headers: {language: 'zh-cn'}});
      calls.push({storeKey, productTypeId, ...compactCall('query-attribute-template', QUERY_ATTRIBUTE_TEMPLATE, resp, false)});
      templateCache.set(productTypeId, templateRowsById(resp));
      await wait(80);
    }
    if (categoryId && !fillCache.has(categoryId)) {
      const resp = await client.request(QUERY_FILL_STANDARD, {method: 'POST', body: {category_id: categoryId, spu_name: row.spu}, headers: {language: 'zh-cn'}});
      calls.push({storeKey, categoryId, ...compactCall('query-publish-fill-in-standard', QUERY_FILL_STANDARD, resp, false)});
      fillCache.set(categoryId, resp.data?.info || {});
      await wait(80);
    }
    const inputCurrentHint = currentHintsByStandard.get(row.standard_goods_sn)
      || chooseHint(globalHintIndex?.byStandard?.get(row.standard_goods_sn))
      || (model ? currentHintsByModel.get(model) : null)
      || (model ? chooseHint(globalHintIndex?.byModel?.get(model)) : null)
      || currentHintsByProductType.get(productTypeId)
      || null;
    const inputVoltageHint = voltageHintsByStandard.get(row.standard_goods_sn)
      || chooseHint(globalHintIndex?.voltageByStandard?.get(row.standard_goods_sn), 301114341)
      || (model ? voltageHintsByModel.get(model) : null)
      || (model ? chooseHint(globalHintIndex?.voltageByModel?.get(model), 301114341) : null)
      || voltageHintsByProductType.get(productTypeId)
      || null;
    const repair = buildSupplierCodeRepairPayload({
      row,
      spuInfo: {info},
      attributeTemplateRows: templateCache.get(productTypeId) || [],
      fillStandardInfo: fillCache.get(categoryId) || {},
      inputCurrentHint,
      inputVoltageHint,
    });
    if (repair.blockers.length) {
      blockers.push({row, blockers: repair.blockers, evidence: repair.evidence});
      continue;
    }
    const payload = {
      storeKey,
      operation: 'repair_supplier_code_only',
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertCloudOpenApiAllowed();
  const startedAt = new Date().toISOString();
  const stamp = nowStamp();
  const runDir = path.join(args.outDir, `${stamp}-${args.mode}`);
  await fs.mkdir(runDir, {recursive: true});

  const previous = await readJson(args.input);
  const loaded = loadPreviousRows(previous);
  let targets = loaded.notChanged;
  if (args.maxRows > 0) targets = targets.slice(0, args.maxRows);
  const calls = [];
  const globalHintIndex = await buildCurrentHintIndex(args.openapiProductsDir);
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
    const prepared = await prepareStore({storeKey, rows, client, calls, globalHintIndex});
    allPayloads.push(...prepared.payloads);
    allBlockers.push(...prepared.blockers.map(blocker => ({storeKey, ...blocker})));
    allWarnings.push(...prepared.warnings.map(warning => `${storeKey}: ${warning}`));
  }
  const pendingDocumentStates = await queryPendingDocs({pendingReview: loaded.pendingReview, args, calls});
  const plan = {
    schemaVersion: 'retire-supplier-code-repair/v1',
    operationOrder: ['repair_supplier_code_only'],
    safety: {
      doesNotCallModifySkcShelf: true,
      writeEndpoints: [PARTIAL_EDIT],
      readEndpoints: [STORE_INFO, SPU_INFO, QUERY_ATTRIBUTE_TEMPLATE, QUERY_FILL_STANDARD, QUERY_DOCUMENT_STATE, SEARCH_PRODUCT],
      hardExclude: {store: 'FY', standardGoodsSn: 'SK-5110电磁炉'},
    },
    payloads: allPayloads,
  };
  const payloadHash = sha256Stable(plan);
  const summary = {
    ok: allPayloads.length > 0,
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
    currentHintIndexStats: globalHintIndex.stats,
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
