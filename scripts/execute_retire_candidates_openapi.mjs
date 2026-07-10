#!/usr/bin/env node
/**
 * Cloud-only executor for confirmed low-exposure / zero-sales retire candidates.
 *
 * - Dry-run is local/static only: reads the candidate report and builds a stable
 *   submit plan + payload hash without calling SHEIN.
 * - Execute is guarded: not allowed on Windows, requires an explicit cloud env
 *   flag, exact payload hash and SHEIN_OPENAPI_SUBMIT confirmation.
 * - Real writes are per store: mandatory modify-skc-shelf shelf_state=2 first,
 *   then best-effort partialEdit supplier_code to （废）标准货号. A
 *   partialEdit/pre-validation failure must never block or undo shelf
 *   retirement. Readback uses spu-info for each target.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';
import {
  formatStoreIdentityError,
  openApiIdentityToStorageIdentity,
  storeIdentityMatchesMerchantOnly,
  validateStoreIdentity,
} from '../lib/shein_store_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_TRUTH = path.join(ROOT, 'config', 'store_account_truth.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp', 'retire-candidates-execute');
const CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
const WASTE_PREFIX = '（废）';
const PARTIAL_EDIT = '/open-api/goods/product/partialEdit';
const MODIFY_SKC_SHELF = '/open-api/goods/modify-skc-shelf';
const SPU_INFO = '/open-api/goods/spu-info';
const STORE_INFO = '/open-api/openapi-business-backend/query-store-info';

function parseArgs(argv) {
  const args = {
    input: '',
    mode: 'dry-run',
    outDir: DEFAULT_OUT_DIR,
    config: DEFAULT_CONFIG,
    storeTruth: DEFAULT_TRUTH,
    payloadHash: '',
    confirm: '',
    site: 'shein-sa',
    excludeStore: 'FY',
    excludeStandardGoodsSn: 'SK-5110电磁炉',
    resumeFile: '',
    continueOnError: false,
    continueStoresOnError: false,
    maxStores: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input') args.input = path.resolve(String(argv[++i] || ''));
    else if (a === '--mode') args.mode = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--dry-run') args.mode = 'dry-run';
    else if (a === '--execute') args.mode = 'execute';
    else if (a === '--out-dir') args.outDir = path.resolve(String(argv[++i] || ''));
    else if (a === '--config') args.config = path.resolve(String(argv[++i] || ''));
    else if (a === '--store-truth') args.storeTruth = path.resolve(String(argv[++i] || ''));
    else if (a === '--payload-hash') args.payloadHash = String(argv[++i] || '').trim();
    else if (a === '--confirm') args.confirm = String(argv[++i] || '').trim();
    else if (a === '--site') args.site = String(argv[++i] || '').trim() || args.site;
    else if (a === '--exclude-store') args.excludeStore = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--exclude-standard-goods-sn') args.excludeStandardGoodsSn = String(argv[++i] || '').trim();
    else if (a === '--resume-file') args.resumeFile = path.resolve(String(argv[++i] || ''));
    else if (a === '--continue-on-error') args.continueOnError = true;
    else if (a === '--continue-stores-on-error') args.continueStoresOnError = true;
    else if (a === '--max-stores') args.maxStores = Math.max(0, Number(argv[++i] || 0));
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.input) throw new Error('--input <retire-candidates-v5 json> is required');
  if (!['dry-run', 'execute'].includes(args.mode)) throw new Error('--mode must be dry-run or execute');
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/execute_retire_candidates_openapi.mjs --input tmp/retire-candidates/...json --dry-run
  SHEIN_BI_CLOUD_EXECUTION=1 node scripts/execute_retire_candidates_openapi.mjs \\
    --input /srv/shein-bi/runtime/.../candidates.json \\
    --execute --payload-hash <dry-run hash> --confirm ${CONFIRM_TEXT}

Safety:
  execute is blocked unless running outside Windows with SHEIN_BI_CLOUD_EXECUTION=1.
  This script retires the SKC as the hard goal. Supplier_code is changed to
  （废）标准货号 on a best-effort basis; partialEdit failure is recorded but does
  not block modify-skc-shelf.
`);
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, '/'); }
function safe(v, max = 500) { return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); }
function normalizeStore(v) { return safe(v, 20).toUpperCase(); }
function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}
function sha256Stable(v) { return crypto.createHash('sha256').update(stableJson(v), 'utf8').digest('hex'); }
function nowStamp() { return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14); }
function asArray(v) { if (v == null) return []; return Array.isArray(v) ? v : [v]; }
function uniq(xs) { return [...new Set(xs.filter(Boolean))]; }
function storeSort(a, b) {
  const order = ['DL','DX','FY','LQ','NM','HL','JY','ZL','TS','MZ','CX','YJ','XL','QY','QH','TZ','TZZ','JSH','XC'];
  const ia = order.indexOf(a), ib = order.indexOf(b);
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || String(a).localeCompare(String(b));
}
function isExcluded(row, args) {
  return normalizeStore(row.store) === args.excludeStore && safe(row.standard_goods_sn) === args.excludeStandardGoodsSn;
}
function wasteGoodsSn(row) {
  const suggested = safe(row.suggested_waste_goods_sn, 220);
  if (suggested) return suggested;
  const sn = safe(row.standard_goods_sn, 200);
  return sn.startsWith(WASTE_PREFIX) ? sn : `${WASTE_PREFIX}${sn}`;
}
function validateCandidateRow(row, index) {
  const blockers = [];
  const store = normalizeStore(row.store);
  const skc = safe(row.skc, 120);
  const spu = safe(row.spu, 120);
  const standardGoodsSn = safe(row.standard_goods_sn, 220);
  const currentStatus = safe(row.current_status, 80);
  const bucket = safe(row.retire_candidate_bucket, 80);
  const reason = safe(row.retire_candidate_reason, 120);
  const c7Exposure = Number(row.c7_exposure);
  const c7SaleCnt = Number(row.c7_sale_cnt);
  const newTagValue = safe(row.new_tag_value, 120);
  const firstShelfTime = safe(row.first_shelf_time, 80);
  if (!store) blockers.push('missing_store');
  if (!skc) blockers.push('missing_skc');
  if (!spu) blockers.push('missing_spu');
  if (!standardGoodsSn) blockers.push('missing_standard_goods_sn');
  if (!/已上架|ON_SHELF|on shelf/i.test(currentStatus)) blockers.push(`not_on_shelf:${currentStatus || '-'}`);
  if (bucket && bucket !== 'candidate') blockers.push(`bucket_not_candidate:${bucket}`);
  if (reason && reason !== 'pass') blockers.push(`reason_not_pass:${reason}`);
  if (!Number.isFinite(c7Exposure) || c7Exposure > 300) blockers.push(`bad_c7_exposure:${row.c7_exposure}`);
  if (!Number.isFinite(c7SaleCnt) || c7SaleCnt !== 0) blockers.push(`bad_c7_sale_cnt:${row.c7_sale_cnt}`);
  if (newTagValue) blockers.push(`new_goods_tag_present:${newTagValue}`);
  if (!firstShelfTime) blockers.push('missing_first_shelf_time');
  return {index, store, skc, spu, standardGoodsSn, wasteGoodsSn: wasteGoodsSn(row), blockers};
}
function loadRows(report) {
  if (Array.isArray(report)) return report;
  if (Array.isArray(report?.rows)) return report.rows;
  if (Array.isArray(report?.candidates)) return report.candidates;
  throw new Error('Input must be a v5 retire candidates JSON with rows[]');
}
function groupByStore(rows) {
  const map = new Map();
  for (const row of rows) {
    const store = row.store;
    if (!map.has(store)) map.set(store, []);
    map.get(store).push(row);
  }
  return [...map.entries()].sort((a, b) => storeSort(a[0], b[0])).map(([store, items]) => ({store, items}));
}
function compactTarget(row) {
  return {
    store: row.store,
    shop_name: row.shop_name || '',
    standard_goods_sn: row.standard_goods_sn,
    suggested_waste_goods_sn: row.suggested_waste_goods_sn,
    spu: row.spu,
    skc: row.skc,
    c7_exposure: row.c7_exposure,
    c7_sale_cnt: row.c7_sale_cnt,
    first_shelf_time: row.first_shelf_time,
    current_status: row.current_status,
    activity_tag: row.activity_tag || '',
    activity_names: row.activity_names || '',
  };
}
function buildSubmitPlan(validRows, args) {
  const stores = groupByStore(validRows).map(({store, items}) => {
    const partialEditPayloads = items.map(row => ({
      operation: 'update_supplier_code_to_waste_goods_sn',
      endpoint: PARTIAL_EDIT,
      body: {
        spu_name: row.spu,
        skc_list: [{skc_name: row.skc, supplier_code: row.wasteGoodsSn}],
      },
      targetSkcs: [row.skc],
      targetSpu: row.spu,
      wasteGoodsSn: row.wasteGoodsSn,
    }));
    const retirePayload = {
      operation: 'retire_link',
      endpoint: MODIFY_SKC_SHELF,
      body: {
        skc_site_info_list: items.map(row => ({
          shelf_state: 2,
          site_list: [args.site],
          skc_name: row.skc,
        })),
      },
      targetSkcs: items.map(row => row.skc),
    };
    return {store, count: items.length, operations: [retirePayload, ...partialEditPayloads]};
  });
  return {
    schemaVersion: 'retire-candidates-execute-plan/v1',
    site: args.site,
    operationOrder: ['retire_link', 'update_supplier_code_to_waste_goods_sn_best_effort'],
    stores,
  };
}
function summarizePlan(plan) {
  const byStore = Object.fromEntries(plan.stores.map(s => [s.store, s.count]));
  const partialEditCount = plan.stores.reduce((n, s) => n + s.operations.filter(o => o.operation === 'update_supplier_code_to_waste_goods_sn').length, 0);
  const retireCallCount = plan.stores.reduce((n, s) => n + s.operations.filter(o => o.operation === 'retire_link').length, 0);
  return {storeCount: plan.stores.length, targetCount: Object.values(byStore).reduce((a, b) => a + b, 0), byStore, partialEditCount, retireCallCount};
}

export function isSupplierCodeWasteOperation(operation) {
  return operation?.operation === 'update_supplier_code_to_waste_goods_sn';
}

export function isRetireLinkOperation(operation) {
  return operation?.operation === 'retire_link' || operation?.operation === 'retire_link_single';
}

export function supplierCodeOperationAccepted(operation) {
  return Boolean(operation?.ok);
}

export function retireOperationAccepted(operation) {
  return Boolean(operation?.ok);
}

async function requestOperation(client, op, calls) {
  const response = await client.request(op.endpoint, {method: 'POST', body: op.body, headers: {language: 'en'}});
  const compact = compactCall(op.operation, op.endpoint, response);
  calls.push(compact);
  const opOk = String(response.data?.code) === '0' && response.data?.info?.success !== false;
  const preValidBlock = response.data?.info?.success === false ? response.data?.info?.pre_valid_result : null;
  return {response, compact, opOk, preValidBlock};
}

function splitRetireOperation(op) {
  const items = asArray(op?.body?.skc_site_info_list);
  if (op?.operation !== 'retire_link' || items.length <= 1) return [];
  return items.map(item => ({
    operation: 'retire_link_single',
    endpoint: op.endpoint,
    body: {skc_site_info_list: [item]},
    targetSkcs: [safe(item?.skc_name, 120)].filter(Boolean),
  }));
}

function partialStatusBySkc(operations) {
  const out = new Map();
  for (const op of operations) {
    if (!isSupplierCodeWasteOperation(op)) continue;
    for (const skc of asArray(op.targetSkcs)) {
      out.set(skc, {
        submitted: true,
        accepted: supplierCodeOperationAccepted(op),
        version: op.infoVersion || '',
        preValidResult: op.preValidResult ?? null,
        code: op.code ?? null,
        msg: op.msg || '',
        traceId: op.traceId || '',
      });
    }
  }
  return out;
}

export function classifyRetireOutcome(row) {
  const retired = Boolean(row?.readback?.retired);
  if (!retired) return 'downFailed';
  if (row?.readback?.supplierCodeMatchesWaste || row?.supplierCodeEdit?.accepted) return 'retiredWithSupplierCodeChangedOrReview';
  return 'retiredWithSupplierCodeNotChangedAccepted';
}

export function summarizeRetireOutcomeRows(rows) {
  const summary = {
    retiredWithSupplierCodeChangedOrReview: 0,
    retiredWithSupplierCodeNotChangedAccepted: 0,
    downFailed: 0,
  };
  for (const row of rows) summary[classifyRetireOutcome(row)] += 1;
  return summary;
}

export function isRetiredShelfReadback({shelfState = '', shelfLabel = ''} = {}) {
  const state = safe(shelfState, 40);
  const label = safe(shelfLabel, 80);
  return state === '0' || state === '2' || state === '4' || /下架|off/i.test(label);
}

async function prepare(args) {
  const report = await readJson(args.input);
  const sourceRows = loadRows(report);
  const excluded = [];
  const invalid = [];
  const valid = [];
  for (let i = 0; i < sourceRows.length; i += 1) {
    const raw = sourceRows[i];
    if (isExcluded(raw, args)) {
      excluded.push({reason: 'hard_exclude_user_confirmed', ...compactTarget(raw)});
      continue;
    }
    const checked = validateCandidateRow(raw, i);
    const row = {...compactTarget(raw), store: checked.store, skc: checked.skc, spu: checked.spu, standard_goods_sn: checked.standardGoodsSn, wasteGoodsSn: checked.wasteGoodsSn};
    if (checked.blockers.length) invalid.push({...row, blockers: checked.blockers});
    else valid.push(row);
  }
  const duplicateSkcs = [];
  const skcSeen = new Set();
  const skcDuplicated = new Set();
  for (const row of valid) {
    if (skcSeen.has(row.skc)) skcDuplicated.add(row.skc);
    skcSeen.add(row.skc);
  }
  duplicateSkcs.push(...skcDuplicated);
  const storeSpuToSkcs = new Map();
  for (const row of valid) {
    const key = `${row.store}|${row.spu}`;
    if (!storeSpuToSkcs.has(key)) storeSpuToSkcs.set(key, new Set());
    storeSpuToSkcs.get(key).add(row.skc);
  }
  const sameStoreSpuMultiSkc = [...storeSpuToSkcs.entries()]
    .filter(([, skcs]) => skcs.size > 1)
    .map(([key, skcs]) => ({key, skcs: [...skcs]}));
  if (duplicateSkcs.length) throw new Error(`Refusing retire plan with duplicate SKC: ${duplicateSkcs.join(', ')}`);
  if (sameStoreSpuMultiSkc.length) throw new Error(`Refusing retire plan with same store+SPU mapped to multiple SKC: ${JSON.stringify(sameStoreSpuMultiSkc.slice(0, 10))}`);
  if (args.maxStores > 0) {
    const allowed = new Set(groupByStore(valid).slice(0, args.maxStores).map(x => x.store));
    const deferred = valid.filter(r => !allowed.has(r.store)).map(r => ({reason: 'deferred_by_max_stores', ...r}));
    valid.splice(0, valid.length, ...valid.filter(r => allowed.has(r.store)));
    excluded.push(...deferred);
  }
  const plan = buildSubmitPlan(valid, args);
  const payloadHash = sha256Stable(plan);
  const activityRows = valid.filter(row => {
    const names = row.activity_names;
    return safe(row.activity_tag, 120) || (Array.isArray(names) ? names.length > 0 : safe(names, 500));
  });
  return {
    report,
    sourceRows,
    excluded,
    invalid,
    valid,
    plan,
    payloadHash,
    guardSummary: {
      duplicateSkcCount: duplicateSkcs.length,
      sameStoreSpuMultiSkcCount: sameStoreSpuMultiSkc.length,
      activityRows: activityRows.length,
    },
  };
}
function assertExecuteAllowed(args, payloadHash, invalid) {
  if (os.platform() === 'win32') throw new Error('Refusing execute on Windows/local Codex. Use shein-bi-tencent cloud only.');
  if (process.env.SHEIN_BI_CLOUD_EXECUTION !== '1' && process.env.SHEIN_BI_ALLOW_LOCAL_OPENAPI_EXECUTOR !== '1') {
    throw new Error('Execute requires SHEIN_BI_CLOUD_EXECUTION=1 on shein-bi-tencent (or SHEIN_BI_ALLOW_LOCAL_OPENAPI_EXECUTOR=1 for isolated fake tests).');
  }
  if (args.confirm !== CONFIRM_TEXT) throw new Error(`Execute requires --confirm ${CONFIRM_TEXT}`);
  if (!args.payloadHash) throw new Error('Execute requires --payload-hash from dry-run.');
  if (args.payloadHash !== payloadHash) throw new Error(`Payload hash mismatch: expected=${args.payloadHash} actual=${payloadHash}`);
  if (invalid.length) throw new Error(`Refusing execute with invalid candidate rows: ${invalid.length}`);
}
async function loadClient(configFile, storeKey) {
  const config = await readJson(configFile);
  const stores = Array.isArray(config.stores) ? config.stores : Object.entries(config.stores || {}).map(([key, v]) => ({storeKey: key, ...v}));
  const store = stores.find(s => normalizeStore(s.storeKey || s.key || s.store) === storeKey);
  if (!store?.openKeyId || !store?.secretKey) throw new Error(`Missing OpenAPI key for ${storeKey} in ${rel(configFile)}`);
  const baseUrl = config.apiBaseUrls?.prodSemiManaged || SHEIN_OPENAPI_BASE_URLS.prodSemiManaged;
  return {config, store, client: new SheinOpenApiClient({baseUrl, openKeyId: store.openKeyId, secretKey: store.secretKey})};
}
async function verifyStoreIdentity(client, storeConfig, truthJson, storeKey, calls) {
  const response = await client.request(STORE_INFO, {method: 'POST', body: {}, headers: {language: 'en'}});
  calls.push(compactCall('store-info', STORE_INFO, response));
  const truth = truthJson?.stores?.[storeKey];
  if (!truth) return {ok: true, warning: 'no_store_truth'};
  const identity = validateStoreIdentity({store: storeConfig, truth, storageIdentity: openApiIdentityToStorageIdentity(response.data), href: `openapi:${STORE_INFO}`, context: 'execute_retire_candidates_openapi'});
  if (identity.ok || storeIdentityMatchesMerchantOnly(identity)) return {ok: true, merchantFallback: !identity.ok};
  return {ok: false, error: formatStoreIdentityError(identity)};
}
function compactCall(name, endpoint, response) {
  const info = response.data?.info;
  return {
    name,
    endpoint,
    httpStatus: response.status ?? response.httpStatus ?? null,
    code: response.data?.code ?? null,
    msg: safe(response.data?.msg, 300),
    traceId: response.data?.traceId ?? null,
    infoSuccess: info?.success ?? null,
    infoVersion: info?.version ?? null,
    preValidResult: info?.pre_valid_result ?? null,
    skcList: info?.skc_list ?? null,
  };
}
function findSkcInfo(spuInfo, skcName) {
  return asArray(spuInfo?.skcInfoList).find(x => safe(x?.skcName, 120) === skcName) || null;
}
function findShelf(skcInfo, site) {
  const rows = asArray(skcInfo?.shelfStatusInfoList);
  return rows.find(x => safe(x?.siteAbbr, 80).toLowerCase() === site.toLowerCase()) || rows[0] || null;
}
async function readbackRow(client, row, site) {
  const response = await client.request(SPU_INFO, {method: 'POST', body: {spuName: row.spu, languageList: ['en', 'ar']}, headers: {language: 'en'}});
  const call = compactCall('spu-info-readback', SPU_INFO, response);
  const info = response.data?.info || {};
  const skcInfo = findSkcInfo(info, row.skc);
  const shelf = skcInfo ? findShelf(skcInfo, site) : null;
  const supplierCode = safe(skcInfo?.supplierCode || skcInfo?.supplier_code || info?.supplierCode || info?.supplier_code, 240);
  const shelfState = safe(shelf?.shelfState ?? shelf?.shelf_state ?? shelf?.shelfStatus ?? shelf?.shelf_status ?? shelf?.shelfStatusCode ?? shelf?.shelf_status_code, 40);
  const shelfLabel = safe(shelf?.shelfStatusName || shelf?.shelf_status_name || shelf?.shelfStateName || shelf?.shelf_state_name, 80);
  return {
    ok: String(response.data?.code) === '0' && Boolean(skcInfo),
    supplierCode,
    supplierCodeMatchesWaste: supplierCode === row.wasteGoodsSn,
    shelfState,
    shelfLabel,
    retired: isRetiredShelfReadback({shelfState, shelfLabel}),
    call,
  };
}
async function executeStore({storePlan, rowBySkc, args, truthJson}) {
  const {store, client} = await loadClient(args.config, storePlan.store);
  const calls = [];
  const storeResult = {store: storePlan.store, count: storePlan.count, ok: false, calls, operations: [], rows: [], blockers: [], warnings: []};
  const identity = await verifyStoreIdentity(client, store, truthJson, storePlan.store, calls);
  if (!identity.ok) {
    storeResult.blockers.push(identity.error || 'store_identity_failed');
    return storeResult;
  }
  if (identity.merchantFallback) storeResult.warnings.push('OpenAPI 店铺信息未返回 GS 账号但 merchantId 匹配。');
  for (const op of storePlan.operations) {
    try {
      const {compact, opOk: initialOpOk, preValidBlock} = await requestOperation(client, op, calls);
      let opOk = initialOpOk;
      const operationRecord = {operation: op.operation, endpoint: op.endpoint, targetSkcs: op.targetSkcs, ok: opOk, ...compact};
      storeResult.operations.push(operationRecord);
      if (!opOk && op.operation === 'retire_link') {
        const singleRetireOps = splitRetireOperation(op);
        if (singleRetireOps.length) {
          storeResult.warnings.push(`bulk_retire_failed_retry_single_skc: ${singleRetireOps.length}`);
          const singleResults = [];
          for (const singleOp of singleRetireOps) {
            try {
              const singleResult = await requestOperation(client, singleOp, calls);
              const singleRecord = {operation: singleOp.operation, endpoint: singleOp.endpoint, targetSkcs: singleOp.targetSkcs, ok: singleResult.opOk, ...singleResult.compact};
              singleResults.push(singleRecord);
              storeResult.operations.push(singleRecord);
            } catch (singleErr) {
              const singleRecord = {operation: singleOp.operation, endpoint: singleOp.endpoint, targetSkcs: singleOp.targetSkcs, ok: false, error: safe(singleErr?.message || singleErr, 500)};
              singleResults.push(singleRecord);
              storeResult.operations.push(singleRecord);
            }
          }
          opOk = singleResults.length > 0 && singleResults.every(retireOperationAccepted);
          operationRecord.ok = opOk;
          operationRecord.fallbackSingleRetireOk = opOk;
        }
      }
      if (!opOk) {
        const message = `${op.operation} failed code=${compact.code} msg=${compact.msg || '-'} preValid=${JSON.stringify(preValidBlock || null)}`;
        if (isSupplierCodeWasteOperation(op)) {
          storeResult.warnings.push(`best_effort_supplier_code_not_changed: ${message}`);
          continue;
        }
        storeResult.blockers.push(message);
        if (!args.continueOnError) break;
      }
    } catch (err) {
      storeResult.operations.push({operation: op.operation, endpoint: op.endpoint, targetSkcs: op.targetSkcs, ok: false, error: safe(err?.message || err, 500)});
      const message = `${op.operation} exception: ${safe(err?.message || err, 500)}`;
      if (isSupplierCodeWasteOperation(op)) {
        storeResult.warnings.push(`best_effort_supplier_code_not_changed: ${message}`);
        continue;
      }
      storeResult.blockers.push(message);
      if (!args.continueOnError) break;
    }
  }
  const bulkRetireOps = storeResult.operations.filter(op => op.operation === 'retire_link');
  const singleRetireOps = storeResult.operations.filter(op => op.operation === 'retire_link_single');
  const retireSubmittedOk = bulkRetireOps.some(retireOperationAccepted)
    || (singleRetireOps.length === storePlan.count && singleRetireOps.every(retireOperationAccepted));
  if (retireSubmittedOk || args.continueOnError) {
    const bySkc = partialStatusBySkc(storeResult.operations);
    for (const item of rowBySkc.get(storePlan.store) || []) {
      try {
        const rb = await readbackRow(client, item, args.site);
        calls.push(rb.call);
        const row = {...item, supplierCodeEdit: bySkc.get(item.skc) || {submitted: false, accepted: false}, readback: rb};
        storeResult.rows.push({...row, finalClass: classifyRetireOutcome(row)});
      } catch (err) {
        const row = {...item, supplierCodeEdit: bySkc.get(item.skc) || {submitted: false, accepted: false}, readback: {ok: false, error: safe(err?.message || err, 500)}};
        storeResult.rows.push({...row, finalClass: classifyRetireOutcome(row)});
      }
    }
  }
  const rowRetireReadbackOk = storeResult.rows.length === storePlan.count && storeResult.rows.every(r => r.readback?.retired);
  const supplierCodeBestEffortSummary = summarizeRetireOutcomeRows(storeResult.rows);
  storeResult.supplierCodeBestEffortSummary = supplierCodeBestEffortSummary;
  storeResult.ok = retireSubmittedOk && rowRetireReadbackOk && storeResult.blockers.length === 0;
  if (retireSubmittedOk && !rowRetireReadbackOk) storeResult.warnings.push('写接口返回成功，但部分链接回读未确认“已下架”；需后续复核。');
  if (supplierCodeBestEffortSummary.retiredWithSupplierCodeNotChangedAccepted) storeResult.warnings.push(`废货号为 best-effort：${supplierCodeBestEffortSummary.retiredWithSupplierCodeNotChangedAccepted} 条已下架但货号未改，按用户确认接受。`);
  return storeResult;
}
async function run() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const stamp = nowStamp();
  const prepared = await prepare(args);
  const summary = {
    input: rel(args.input),
    mode: args.mode,
    generatedAt: startedAt,
    sourceRows: prepared.sourceRows.length,
    executeRows: prepared.valid.length,
    excludedRows: prepared.excluded.length,
    invalidRows: prepared.invalid.length,
    excluded: prepared.excluded,
    invalid: prepared.invalid,
    hardExclude: {store: args.excludeStore, standard_goods_sn: args.excludeStandardGoodsSn},
    payloadHash: prepared.payloadHash,
    payloadHashAlgorithm: 'sha256-stable-json-v1',
    planSummary: summarizePlan(prepared.plan),
    guardSummary: prepared.guardSummary,
    safety: {
      dryRunDoesNotCallShein: args.mode === 'dry-run',
      executeRequiresCloudEnv: 'SHEIN_BI_CLOUD_EXECUTION=1',
      executeRequiresConfirm: CONFIRM_TEXT,
      realWriteEndpoints: [MODIFY_SKC_SHELF, PARTIAL_EDIT],
      hardGoal: 'retire_link',
      supplierCodeChange: 'best_effort_non_blocking',
      readbackEndpoint: SPU_INFO,
    },
  };
  const runDir = path.join(args.outDir, `${stamp}-${args.mode}`);
  await fs.mkdir(runDir, {recursive: true});
  await writeJson(path.join(runDir, 'submit-plan.json'), prepared.plan);
  await writeJson(path.join(runDir, 'audit-summary.json'), summary);
  await writeJson(path.join(runDir, 'targets.json'), {rows: prepared.valid, excluded: prepared.excluded, invalid: prepared.invalid});
  if (args.mode === 'dry-run') {
    const out = {...summary, ok: prepared.invalid.length === 0, runDir: rel(runDir)};
    await writeJson(path.join(runDir, 'dry-run-result.json'), out);
    console.log(JSON.stringify(out, null, 2));
    process.exit(prepared.invalid.length ? 2 : 0);
  }
  assertExecuteAllowed(args, prepared.payloadHash, prepared.invalid);
  const truthJson = await readJson(args.storeTruth).catch(() => ({}));
  const rowBySkc = new Map();
  for (const row of prepared.valid) {
    if (!rowBySkc.has(row.store)) rowBySkc.set(row.store, []);
    rowBySkc.get(row.store).push(row);
  }
  const storeResults = [];
  for (const storePlan of prepared.plan.stores) {
    const result = await executeStore({storePlan, rowBySkc, args, truthJson});
    storeResults.push(result);
    await writeJson(path.join(runDir, `store-${storePlan.store}.json`), result);
    if (!result.ok && !args.continueStoresOnError) break;
  }
  const allResultRows = storeResults.flatMap(s => s.rows.map(r => ({...r, storeBlockers: s.blockers, storeWarnings: s.warnings})));
  const outcomeCounts = summarizeRetireOutcomeRows(allResultRows);
  const succeededRows = allResultRows.filter(r => r.readback?.retired);
  const failedRows = allResultRows.filter(r => !r.readback?.retired);
  const supplierCodeBestEffortFailures = allResultRows.filter(r => classifyRetireOutcome(r) === 'retiredWithSupplierCodeNotChangedAccepted');
  const blockedStores = storeResults.filter(s => !s.ok).map(s => ({store: s.store, blockers: s.blockers, warnings: s.warnings, rowsChecked: s.rows.length}));
  const final = {
    ...summary,
    ok: blockedStores.length === 0 && succeededRows.length === prepared.valid.length,
    endedAt: new Date().toISOString(),
    runDir: rel(runDir),
    executedStoreCount: storeResults.length,
    successRows: succeededRows.length,
    failedRows: failedRows.length,
    outcomeCounts,
    supplierCodeBestEffortFailures,
    skippedRows: prepared.excluded.length,
    blockedStores,
    byStore: Object.fromEntries(storeResults.map(s => [s.store, {
      ok: s.ok,
      count: s.count,
      blockers: s.blockers,
      warnings: s.warnings,
      retiredReadbackOk: s.rows.filter(r => r.readback?.retired).length,
      supplierCodeBestEffortSummary: s.supplierCodeBestEffortSummary || summarizeRetireOutcomeRows(s.rows),
    }])) ,
    storeResultFiles: storeResults.map(s => rel(path.join(runDir, `store-${s.store}.json`))),
    finalRows: allResultRows,
    failures: failedRows,
  };
  await writeJson(path.join(runDir, 'execute-final-summary.json'), final);
  console.log(JSON.stringify(final, null, 2));
  process.exit(final.ok ? 0 : 3);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run().catch(err => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });
}
