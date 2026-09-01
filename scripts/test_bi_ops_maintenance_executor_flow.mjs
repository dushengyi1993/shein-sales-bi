#!/usr/bin/env node
/**
 * Isolated fake-OpenAPI smoke for link maintenance executor.
 * It verifies activate_link/retire_link/update_inventory/update_supply_price/update_product_price/update_title
 * without touching real SHEIN.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildPendingListingImageCorrection} from '../lib/link_ops_pending_listing_image_correction.mjs';
import {__testHooks as maintenanceExecutorTestHooks} from './link_ops_maintenance_openapi_executor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP_TEMP = process.argv.includes('--keep-temp');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'bi-ops-maintenance-executor-smoke-'));
const CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
function sendJson(res, value, status = 200) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(value));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      resolve({text, json});
    });
    req.on('error', reject);
  });
}
async function writeJson(relPath, value) {
  const file = path.join(tmpRoot, relPath);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}
async function writeExecuteSnapshot(relPath, task, expectedPayloadHash, {
  store = 'SMK',
  nonce = `claim-${task.id}`,
  claimStore = store,
  claimOperations = asArray(task.intents),
  claimState = 'claimed',
} = {}) {
  const writeClaim = {
    schemaVersion: 1,
    claimId: `wc-${task.id}`,
    nonce,
    taskId: String(task.id || ''),
    storeKey: claimStore,
    operations: claimOperations,
    expectedPayloadHash,
    claimedAt: new Date().toISOString(),
    claimedBy: 'maintenance-executor-test',
    state: claimState,
  };
  const file = await writeJson(relPath, {
    version: 1,
    executionContext: {expectedPayloadHash, writeClaim},
    tasks: [task],
  });
  return {file, nonce};
}
function runNode(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SHEIN_BI_TEST_ALLOW_FAKE_WEBHOOK_GATE: '1',
      },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      let json = null;
      try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch {}
      resolve({code, stdout, stderr, json});
    });
  });
}
function asArray(v) { return Array.isArray(v) ? v : []; }
const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? (expected.name || 'predicate') : expected, pass});
  return pass;
}

const evidencePayloads = [
  {operation: 'update_title_and_images', endpoint: '/open-api/goods/product/partialEdit', body: {spu_name: 'SpU-Plan-A', value: 1}, targetLinks: []},
  {operation: 'update_title_and_images', endpoint: '/open-api/goods/product/partialEdit', body: {spu_name: 'SpU-Plan-B', value: 2}, targetLinks: []},
];
const evidencePlans = evidencePayloads.map((payload, index) => maintenanceExecutorTestHooks.submissionPlanDescriptor(payload, index));
function acceptedEvidenceResponse(plan, overrides = {}) {
  return {
    operation: plan.operation,
    path: plan.endpoint,
    code: '0',
    infoSuccess: true,
    submissionPlanId: plan.submissionPlanId,
    submissionPlanIndex: plan.index,
    submissionPlanEndpoint: plan.endpoint,
    submissionPlanPayloadHash: plan.payloadBodyHash,
    ...overrides,
  };
}
const exactEvidenceResponses = evidencePlans.map(plan => acceptedEvidenceResponse(plan));
const exactTitleEvidence = maintenanceExecutorTestHooks.operationSubmissionEvidence('update_title', evidencePayloads, exactEvidenceResponses);
const exactImageEvidence = maintenanceExecutorTestHooks.operationSubmissionEvidence('update_images', evidencePayloads, exactEvidenceResponses);
check('combined title evidence maps every payload exactly once', exactTitleEvidence.fullySubmitted, true);
check('combined image evidence reuses the same exact payload responses', exactImageEvidence.fullySubmitted, true);
const missingEvidence = maintenanceExecutorTestHooks.operationSubmissionEvidence('update_title', evidencePayloads, [exactEvidenceResponses[0]]);
check('missing payload response is not fully submitted', missingEvidence.fullySubmitted, false);
check('missing payload response count is explicit', missingEvidence.missingResponseCount, 1);
const duplicateEvidence = maintenanceExecutorTestHooks.operationSubmissionEvidence('update_title', evidencePayloads, [exactEvidenceResponses[0], exactEvidenceResponses[0], exactEvidenceResponses[1]]);
check('duplicate payload response is not fully submitted', duplicateEvidence.fullySubmitted, false);
check('duplicate payload response count is explicit', duplicateEvidence.duplicateResponseCount, 1);
const mismatchedEvidence = maintenanceExecutorTestHooks.operationSubmissionEvidence('update_title', evidencePayloads, [
  acceptedEvidenceResponse(evidencePlans[0], {operation: 'update_title'}),
  exactEvidenceResponses[1],
]);
check('operation-mismatched payload response is not fully submitted', mismatchedEvidence.fullySubmitted, false);
check('operation-mismatched payload response count is explicit', mismatchedEvidence.mismatchedResponseCount, 1);
const unknownEvidence = maintenanceExecutorTestHooks.operationSubmissionEvidence('update_title', evidencePayloads, [
  ...exactEvidenceResponses,
  acceptedEvidenceResponse(evidencePlans[0], {submissionPlanId: 'f'.repeat(64), submissionPlanIndex: 99}),
]);
check('unknown payload response is not fully submitted', unknownEvidence.fullySubmitted, false);
check('unknown payload response count is explicit', unknownEvidence.unknownResponseCount, 1);
async function checkMalformedSubmissionSkipsReadback(label, responses) {
  const readbackCalls = [];
  let readRequestCount = 0;
  const readback = await maintenanceExecutorTestHooks.readbackForIntents({
    async request() {
      readRequestCount += 1;
      return {ok: true, data: {code: '0', info: {spuName: 'SpU-Plan-A'}}};
    },
  }, ['update_title'], [{spu: 'SpU-Plan-A'}], readbackCalls, null, {}, null, '', evidencePayloads, responses);
  check(`${label} response mapping does not enter strong readback`, readRequestCount, 0);
  check(`${label} response mapping remains explicitly unsubmitted`, readback.groups?.[0]?.status, 'operation_not_fully_submitted');
}
await checkMalformedSubmissionSkipsReadback('missing', [exactEvidenceResponses[0]]);
await checkMalformedSubmissionSkipsReadback('duplicate', [exactEvidenceResponses[0], exactEvidenceResponses[0], exactEvidenceResponses[1]]);
await checkMalformedSubmissionSkipsReadback('mismatched', [
  acceptedEvidenceResponse(evidencePlans[0], {operation: 'update_title'}),
  exactEvidenceResponses[1],
]);
await checkMalformedSubmissionSkipsReadback('unknown', [
  ...exactEvidenceResponses,
  acceptedEvidenceResponse(evidencePlans[0], {submissionPlanId: 'f'.repeat(64), submissionPlanIndex: 99}),
]);
const sourceCaseConflictCalls = [];
let sourceCaseConflictRequestCount = 0;
const sourceCaseConflictCache = await maintenanceExecutorTestHooks.loadExactSpuInfoReadback({
  async request() {
    sourceCaseConflictRequestCount += 1;
    return {ok: true, data: {code: '0', info: {spuName: 'SpU-Case-Conflict'}}};
  },
}, [{spu: 'SpU-Case-Conflict'}, {spu: 'spu-case-conflict'}], [], sourceCaseConflictCalls);
check('source SPU case conflict fails closed before OpenAPI request', sourceCaseConflictRequestCount, 0);
check('source SPU case conflict emits no ambiguous readback call', sourceCaseConflictCalls.length, 0);
check('source SPU case conflict records explicit identity failure', sourceCaseConflictCache.get('spu-case-conflict')?.status, 'spu_info_requested_identity_case_conflict');

const calls = [];
let correctionDocumentState = 1;
let correctionDocumentVersion = 'SPMP260806300745650';
let failCorrectionRepublish = true;
let rejectProductPrice = false;
let pendingSpuInfoFault = null;
let activeSpuInfoFault = null;
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function liveImageType(value) {
  const map = {1: 'MAIN', 2: 'DETAIL', 5: 'SQUARE', 6: 'COLOR'};
  return map[Number(value)] || String(value || '');
}
function liveImageUrl(value) {
  const parsed = new URL(String(value || ''));
  parsed.protocol = parsed.protocol === 'http:' ? 'https:' : 'http:';
  const entries = [...parsed.searchParams.entries()].reverse();
  parsed.search = '';
  for (const [key, item] of entries) parsed.searchParams.append(key, item);
  return parsed.toString();
}
function liveImageRows(rows) {
  return asArray(rows).map(row => ({
    groupCode: row?.groupCode || row?.group_code || 'G-SMOKE-READBACK',
    imageType: liveImageType(row?.image_type ?? row?.imageType),
    sort: Number(row?.image_sort ?? row?.imageSort ?? row?.sort),
    imageUrl: liveImageUrl(row?.image_url ?? row?.imageUrl),
  }));
}
function liveSiteDetailGroups(groups) {
  return asArray(groups).map(group => ({
    imageGroupCode: group?.image_group_code || group?.imageGroupCode || 'G-SMOKE-SITE-DETAIL',
    imageInfoList: asArray(group?.image_info_list || group?.imageInfoList).map(row => ({
      imageSort: Number(row?.image_sort ?? row?.imageSort),
      imageUrl: liveImageUrl(row?.image_url ?? row?.imageUrl),
    })),
    siteInfoList: asArray(group?.site_abbr_list || group?.siteAbbrList).map(site => ({site: String(site)})),
  }));
}
const liveProducts = new Map([
  ['spu-smoke', {
    spuName: 'spu-smoke',
    productMultiNameList: [{language: 'en', productName: 'Original Smoke Title'}],
    spuImageInfoList: [{imageType: 'MAIN', sort: 1, imageUrl: 'https://imgdeal-test01.shein.com/images3_pi/original-spu.jpg'}],
    skcInfoList: [{
      skcName: 'sv-smoke-skc',
      productMultiNameList: [{language: 'en', productName: 'Original Smoke Title'}],
      shelfStatusInfoList: [{siteAbbr: 'shein-sa', shelfStatus: 1}],
      skcImageInfoList: [{imageType: 'MAIN', sort: 1, imageUrl: 'https://imgdeal-test01.shein.com/images3_pi/original-skc.jpg'}],
      siteDetailImageInfoList: [],
      skuInfoList: [{
        skuCode: 'sku-smoke-001',
        saleAttributeList: [{attributeId: 27, attributeValueId: 513}],
        costInfoList: [{currency: 'SAR', costPrice: 70}],
        skuImageInfoList: [{groupCode: 'G-SKU-SMOKE', imageType: 'MAIN', sort: 1, imageUrl: 'https://imgdeal-test01.shein.com/images3_pi/original-sku.jpg'}],
      }],
    }],
  }],
  ['spu-inactive-smoke', {
    spuName: 'spu-inactive-smoke',
    productMultiNameList: [{language: 'en', productName: 'Inactive Smoke Title'}],
    skcInfoList: [{
      skcName: 'sv-smoke-inactive-skc',
      productMultiNameList: [{language: 'en', productName: 'Inactive Smoke Title'}],
      shelfStatusInfoList: [{siteAbbr: 'shein-sa', shelfStatus: 0}],
      skuInfoList: [{skuCode: 'sku-smoke-002', costInfoList: [{currency: 'SAR', costPrice: 70}]}],
    }],
  }],
  ['spu-mixed-smoke', {
    spuName: 'SpU-MiXeD-Smoke',
    productMultiNameList: [{language: 'en', productName: 'Mixed Case Smoke Title'}],
    skcInfoList: [{
      skcName: 'sv-mixed-case-skc',
      productMultiNameList: [{language: 'en', productName: 'Mixed Case Smoke Title'}],
      shelfStatusInfoList: [{siteAbbr: 'shein-sa', shelfStatus: 1}],
      skuInfoList: [{skuCode: 'sku-mixed-case-001', costInfoList: [{currency: 'SAR', costPrice: 70}]}],
    }],
  }],
  ['b2608062023343035', {
    spuName: 'b2608062023343035',
    spuImageInfoList: [{groupCode: 'G-LIVE-SPU'}],
    skcInfoList: [{
      skcName: 'sb260806202334303501938',
      skcImageInfoList: [{groupCode: 'G-LIVE-SKC'}],
      skuInfoList: [{skuCode: 'sku-live-sb-001', saleAttributeList: [{attributeId: 27, attributeValueId: 513}]}],
    }],
  }],
]);
function exactLiveSkc(skcName) {
  for (const product of liveProducts.values()) {
    const rows = asArray(product.skcInfoList).filter(row => String(row?.skcName || '').toLowerCase() === String(skcName || '').toLowerCase());
    if (rows.length === 1) return {product, skc: rows[0]};
  }
  return null;
}
function activatePendingReadbackFault() { activeSpuInfoFault = pendingSpuInfoFault ? clone(pendingSpuInfoFault) : null; }
function applySpuInfoFault(info, fault) {
  if (!fault || !info) return info;
  const targetSkc = asArray(info.skcInfoList).find(row => String(row?.skcName || '').toLowerCase() === String(fault.skc || 'sv-smoke-skc').toLowerCase());
  const targetSku = targetSkc && asArray(targetSkc.skuInfoList).find(row => String(row?.skuCode || '') === String(fault.sku || 'sku-smoke-001'));
  if (fault.kind === 'shelf_status' && targetSkc) targetSkc.shelfStatusInfoList = [{siteAbbr: 'shein-sa', shelfStatus: fault.value}];
  if (fault.kind === 'supply_sku' && targetSku) targetSku.skuCode = fault.value || 'wrong-sku';
  if (fault.kind === 'supply_currency' && targetSku?.costInfoList?.[0]) targetSku.costInfoList[0].currency = fault.value || 'USD';
  if (fault.kind === 'supply_cost' && targetSku?.costInfoList?.[0]) targetSku.costInfoList[0].costPrice = fault.value ?? 80.01;
  if (fault.kind === 'spu_return_case') info.spuName = fault.value || String(info.spuName || '').toLowerCase();
  if (fault.kind === 'title_missing_language') {
    info.productMultiNameList = asArray(info.productMultiNameList).filter(row => row.language !== fault.language);
    if (targetSkc) targetSkc.productMultiNameList = asArray(targetSkc.productMultiNameList).filter(row => row.language !== fault.language);
  }
  if (fault.kind === 'title_text') {
    for (const row of asArray(info.productMultiNameList)) if (row.language === fault.language) row.productName = fault.value || 'Wrong title';
    for (const row of asArray(targetSkc?.productMultiNameList)) if (row.language === fault.language) row.productName = fault.value || 'Wrong title';
  }
  if (fault.kind === 'image_url' && targetSkc?.skcImageInfoList?.[0]) targetSkc.skcImageInfoList[0].imageUrl = fault.value || 'https://imgdeal-test01.shein.com/images3_pi/smoke-main.jpg?quality=90&width=901';
  if (fault.kind === 'image_role' && targetSkc?.skcImageInfoList?.[0]) targetSkc.skcImageInfoList[0].imageType = fault.value || 'DETAIL';
  if (fault.kind === 'image_sort' && targetSkc?.skcImageInfoList?.[0]) targetSkc.skcImageInfoList[0].sort = fault.value || 2;
  if (fault.kind === 'image_level' && targetSkc?.skcImageInfoList?.length) {
    info.spuImageInfoList = [...asArray(info.spuImageInfoList), targetSkc.skcImageInfoList[0]];
    targetSkc.skcImageInfoList = targetSkc.skcImageInfoList.slice(1);
  }
  return info;
}
const port = await freePort();
const fake = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const pathname = req.url.split('?')[0];
  calls.push({method: req.method, path: pathname, body: body.json || body.text});
  if (pathname === '/open-api/openapi-business-backend/query-store-info') {
    return sendJson(res, {code: '0', msg: 'OK', info: {shopName: 'Smoke Store'}});
  }
  if (pathname === '/open-api/goods/query-site-list') {
    return sendJson(res, {code: '0', msg: 'OK', info: [{sub_site_list: [{site_abbr: 'shein-sa', currency: 'SAR'}]}]});
  }
  if (pathname === '/open-api/goods/searchProduct') {
    const requested = body.json?.skcNameList?.[0] || '';
    if (String(requested).toLowerCase() === 'sb260806202334303501938') {
      return sendJson(res, {code: '0', msg: 'OK', info: {data: [{
        spuName: 'b2608062023343035',
        skcName: 'sb260806202334303501938',
        supplierCode: 'SK-15061热风梳',
        skuCodeList: ['sku-live-sb-001'],
      }]}});
    }
    return sendJson(res, {code: '0', msg: 'OK', info: {data: []}});
  }
  if (pathname === '/open-api/goods/spu-info') {
    const requested = String(body.json?.spuName || '').toLowerCase();
    const live = liveProducts.get(requested);
    if (live) return sendJson(res, {code: '0', msg: 'OK', info: applySpuInfoFault(clone(live), activeSpuInfoFault)});
    return sendJson(res, {code: '0', msg: 'OK', info: {}});
  }
  if (pathname === '/open-api/goods/query-document-state') {
    const item = body.json?.spuList?.[0] || {};
    if (String(item.spuName).toLowerCase() !== 'b2608062023343035' || item.version !== correctionDocumentVersion) return sendJson(res, {code: '0', msg: 'OK', info: {data: []}});
    return sendJson(res, {code: '0', msg: 'OK', info: {data: [{
      spuName: 'b2608062023343035',
      version: correctionDocumentVersion,
      skcList: [{skcName: 'sb260806202334303501938', documentState: correctionDocumentState}],
    }]}});
  }
  if (pathname === '/open-api/goods/revoke-product') {
    if (body.json?.spuName !== 'b2608062023343035' || correctionDocumentState !== 1) return sendJson(res, {code: '400', msg: 'bad revoke payload/state'});
    correctionDocumentState = 4;
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-correction-revoke'});
  }
  if (pathname === '/open-api/goods/product/publishOrEdit') {
    const row = body.json?.skc_list?.[0] || {};
    const sku = row?.sku_list?.[0] || {};
    const unchanged = body.json?.spu_name === 'b2608062023343035'
      && row.skc_name === 'sb260806202334303501938'
      && sku.sku_code === 'SKU-LIVE-SB-001'
      && row.supplier_code === 'SK-15061热风梳'
      && sku.supplier_sku === 'SK-15061-ORIGINAL'
      && sku.cost_info?.cost_price === '88.00'
      && sku.stock_info_list?.[0]?.stock === 100
      && body.json?.multi_language_name_list?.[0]?.name === 'Original locked title'
      && row.image_info?.image_info_list?.some(image => String(image.image_url).includes('approved-correction-main'));
    if (!unchanged) return sendJson(res, {code: '400', msg: 'protected fields or correction images invalid'});
    if (failCorrectionRepublish) return sendJson(res, {code: '0', msg: 'OK', info: {success: false, pre_valid_result: [{form: 'smoke', messages: ['recoverable republish failure']}]}});
    correctionDocumentVersion = 'SPMP260806399999999';
    correctionDocumentState = 1;
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-correction-publish', info: {success: true, version: correctionDocumentVersion, spu_name: 'b2608062023343035', skc_list: [{skc_name: 'sb260806202334303501938', sku_list: [{sku_code: 'SKU-LIVE-SB-001'}]}]}});
  }
  if (pathname === '/open-api/msc/warehouse/list') {
    return sendJson(res, {code: '0', msg: 'OK', info: {list: [{
      warehouseCode: 'PS-SMOKE-SA',
      warehouseName: 'Saudi Arabia',
      saleCountryList: ['SA'],
    }]}});
  }
  if (pathname === '/open-api/goods/modify-skc-shelf') {
    const row = body.json?.skc_site_info_list?.[0] || {};
    const okRetire = row.shelf_state === 2 && row.skc_name === 'sv-smoke-skc';
    const okActivate = row.shelf_state === 1 && row.skc_name === 'sv-smoke-inactive-skc';
    const okMixedCaseRetire = row.shelf_state === 2 && row.skc_name === 'sv-mixed-case-skc';
    if (!okRetire && !okActivate && !okMixedCaseRetire) return sendJson(res, {code: '400', msg: 'bad shelf payload'}, 200);
    const target = exactLiveSkc(row.skc_name);
    if (target) target.skc.shelfStatusInfoList = [{siteAbbr: 'shein-sa', shelfStatus: row.shelf_state === 1 ? 1 : 0}];
    activatePendingReadbackFault();
    return sendJson(res, {code: '0', msg: 'OK', traceId: okActivate ? 'trace-activate' : 'trace-retire'});
  }
  if (pathname === '/open-api/stock/change-inventory/v2') {
    const row = body.json?.updateSkuInventoryQuantityRequests?.[0] || {};
    if (row.skuCode !== 'sku-smoke-001' || row.changeQuantity !== 100 || row.changeType !== 'OVERWRITE' || row.warehouseCode !== 'PS-SMOKE-SA') return sendJson(res, {code: '400', msg: 'bad inventory payload'}, 200);
    activatePendingReadbackFault();
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-inventory'});
  }
  if (pathname === '/open-api/goods/update-cost') {
    const sku = body.json?.skc_info_list?.[0]?.sku_info_list?.[0] || {};
    if (sku.sku_code !== 'sku-smoke-001' || sku.cost !== 80 || sku.currency !== 'SAR') return sendJson(res, {code: '400', msg: 'bad supply payload'}, 200);
    const target = exactLiveSkc(body.json?.skc_info_list?.[0]?.skc_name);
    const liveSku = asArray(target?.skc?.skuInfoList).find(row => row?.skuCode === sku.sku_code);
    if (liveSku) liveSku.costInfoList = [{currency: sku.currency, costPrice: sku.cost}];
    activatePendingReadbackFault();
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-supply'});
  }
  if (pathname === '/open-api/openapi-business-backend/product/price/save') {
    const row = body.json?.productPriceList?.[0] || {};
    if (row.productCode !== 'sku-smoke-001' || row.shopPrice !== 99 || row.specialPrice !== 99 || row.site !== 'shein-sa') return sendJson(res, {code: '400', msg: 'bad product price payload'}, 200);
    if (rejectProductPrice) return sendJson(res, {code: '400', msg: 'platform rejected price after earlier commit'}, 200);
    activatePendingReadbackFault();
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-price'});
  }
  if (pathname === '/open-api/goods/product/partialEdit') {
    const row = body.json?.skc_list?.[0] || {};
    const hasTitle = asArray(body.json?.multi_language_name_list).length > 0;
    const hasImages = Boolean(body.json?.image_info?.image_info_list?.length || row.image_info?.image_info_list?.length || row.sku_list?.some(sku => sku?.image_info?.image_info_list?.length));
    const valid = body.json?.spu_name === 'spu-smoke' && row.skc_name === 'sv-smoke-skc' && (hasTitle || hasImages);
    if (!valid) return sendJson(res, {code: '400', msg: 'bad partialEdit payload'}, 200);
    const live = liveProducts.get('spu-smoke');
    const liveSkc = asArray(live?.skcInfoList).find(item => item.skcName === row.skc_name);
    if (hasTitle) {
      const names = body.json.multi_language_name_list.map(item => ({language: item.language, productName: item.name}));
      live.productMultiNameList = clone(names);
      liveSkc.productMultiNameList = clone(names);
    }
    if (body.json?.image_info?.image_info_list) live.spuImageInfoList = liveImageRows(body.json.image_info.image_info_list);
    if (row?.image_info?.image_info_list) liveSkc.skcImageInfoList = liveImageRows(row.image_info.image_info_list);
    if (row?.site_detail_image_info_list) liveSkc.siteDetailImageInfoList = liveSiteDetailGroups(row.site_detail_image_info_list);
    for (const skuPlan of asArray(row?.sku_list)) {
      const liveSku = asArray(liveSkc?.skuInfoList).find(item => item.skuCode === skuPlan?.sku_code);
      if (liveSku && skuPlan?.image_info?.image_info_list) liveSku.skuImageInfoList = liveImageRows(skuPlan.image_info.image_info_list);
    }
    activatePendingReadbackFault();
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-title-image', info: {success: true, version: 'SPMP-SMOKE'}});
  }
  if (pathname === '/open-api/goods/save-certificate-pool-skc-bind') {
    if (body.json?.skc_name !== 'sv-smoke-skc' || body.json?.certificate_pool_id !== 'CERTPOOL-SMOKE') return sendJson(res, {code: '400', msg: 'bad certificate bind payload'}, 200);
    return sendJson(res, {code: '0', msg: 'OK', traceId: 'trace-certificate'});
  }
  if (pathname === '/open-api/stock/stock-query') {
    return sendJson(res, {code: '0', msg: 'OK', info: [{
      warehouseCode: 'PS-SMOKE-SA',
      goodsInventory: [{
        skcName: 'sv-smoke-skc',
        skuList: [{
          skuCode: 'sku-smoke-001',
          totalInventoryQuantity: 100,
          totalUsableInventory: 100,
          totalLockedQuantity: 0,
          temporaryInventoryQuantity: 0,
        }],
      }],
    }]});
  }
  if (pathname === '/open-api/openapi-business-backend/product/query') {
    return sendJson(res, {code: '0', msg: 'OK', info: {data: [
      {skcName: 'sv-smoke-skc', spuName: 'spu-smoke', supplierCode: 'TEST-PRODUCT', skuCodeList: ['sku-smoke-001']},
      {skcName: 'sv-smoke-inactive-skc', spuName: 'spu-inactive-smoke', supplierCode: 'TEST-INACTIVE', skuCodeList: ['sku-smoke-002']},
    ]}});
  }
  return sendJson(res, {code: '404', msg: `Unhandled ${pathname}`}, 404);
});
await new Promise(resolve => fake.listen(port, '127.0.0.1', resolve));

let ok = false;
try {
  const configFile = await writeJson('openapi.json', {
    apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${port}`},
    stores: [{storeKey: 'SMK', enabled: true, openKeyId: 'dummy-open', secretKey: 'dummy-secret'}],
  });
  const biDir = path.join(tmpRoot, 'bi-portal');
  await writeJson('bi-portal/sections/linksData.json', {
    data: {storeLinks: [
      {store_key: 'SMK', skc: 'sv-smoke-skc', spu: 'spu-smoke', standard_goods_sn: 'TEST-PRODUCT', is_on_shelf: true, shelf_status_name: '已上架'},
      {store_key: 'SMK', skc: 'sv-smoke-inactive-skc', spu: 'spu-inactive-smoke', standard_goods_sn: 'TEST-INACTIVE', is_on_shelf: false, shelf_status_name: '已下架'},
      {store_key: 'SMK', skc: 'sv-mixed-case-skc', spu: '  SpU-MiXeD-Smoke  ', standard_goods_sn: 'TEST-MIXED-SPU', is_on_shelf: true, shelf_status_name: '已上架'},
    ]},
  });
  const productCacheDir = path.join(tmpRoot, 'products');
  await writeJson('products/SMK/latest.json', {
    normalizedRows: [
      {storeKey: 'SMK', skc: 'sv-smoke-skc', spu: 'spu-smoke', supplierCode: 'TEST-PRODUCT', skuCodes: '["sku-smoke-001"]', costSar: 70, sheinUsableInventory: 30},
      {storeKey: 'SMK', skc: 'sv-smoke-inactive-skc', spu: 'spu-inactive-smoke', supplierCode: 'TEST-INACTIVE', skuCodes: '["sku-smoke-002"]', costSar: 70, sheinUsableInventory: 0},
      {storeKey: 'SMK', skc: 'sv-mixed-case-skc', spu: 'SpU-MiXeD-Smoke', supplierCode: 'TEST-MIXED-SPU', skuCodes: '["sku-mixed-case-001"]', costSar: 70, sheinUsableInventory: 0},
    ],
  });
  const task = {
    id: 'maintenance-smoke',
    status: 'waiting_review',
    command: '处理这项结构化维护任务；不要从这句话猜动作或参数',
    planning: {
      source: 'structured_cli',
      parameters: {
        inventory: 100,
        expectedCurrentInventory: 100,
        supplyPrice: 80,
        productPrice: 99,
        title: 'Smoke Title',
      },
    },
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    partialEditPayload: {
      spu_name: 'spu-smoke',
      is_spu_pic: true,
      image_info: {
        image_group_code: 'G-spu-smoke',
        image_info_list: [{image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/smoke-spu-main.jpg?quality=90&width=900'}],
      },
      skc_list: [{
        skc_name: 'sv-smoke-skc',
        image_info: {
          image_group_code: 'G-smoke',
          image_info_list: [
            {image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/smoke-main.jpg?quality=90&width=900'},
            ...Array.from({length: 10}, (_, i) => ({
              image_sort: i + 2,
              image_type: 2,
              image_url: `http://imgdeal-test01.shein.com/images3_pi/smoke-detail-${i + 1}.jpg`,
            })),
            {image_sort: 12, image_type: 5, image_url: 'http://imgdeal-test01.shein.com/images3_pi/smoke-square.jpg'},
          ],
        },
        sku_list: [{
          sku_code: 'sku-smoke-001',
          image_info: {image_info_list: [{image_sort: 1, image_type: 1, image_url: 'https://img.ltwebstatic.com/v4/j/spmp/2026/07/02/80/high-resolution-sku-main.jpg'}]},
        }],
      }],
    },
    intents: ['retire_link', 'update_inventory', 'update_supply_price', 'update_product_price', 'update_title', 'update_images'],
  };
  const taskFile = await writeJson('task-dry.json', {version: 1, tasks: [task]});
  const outDir = path.join(tmpRoot, 'out');
  const commonArgs = [
    'scripts/link_ops_maintenance_openapi_executor.mjs',
    '--config', configFile,
    '--task-id', 'maintenance-smoke',
    '--store', 'SMK',
    '--dir', biDir,
    '--product-cache-dir', productCacheDir,
    '--out-dir', outDir,
  ];
  const runClaimedTask = async (label, taskValue, {fault = null} = {}) => {
    const dryFile = await writeJson(`task-${label}-dry.json`, {version: 1, tasks: [taskValue]});
    calls.length = 0;
    activeSpuInfoFault = null;
    pendingSpuInfoFault = null;
    const dryResult = await runNode([...commonArgs, '--task-id', taskValue.id, '--task-json', dryFile, '--dry-run']);
    const payloadHash = dryResult.json?.payload?.payloadHash || '';
    const executeSnapshot = await writeExecuteSnapshot(`task-${label}-execute.json`, taskValue, payloadHash, {nonce: `claim-${taskValue.id}-${label}`});
    calls.length = 0;
    activeSpuInfoFault = null;
    pendingSpuInfoFault = fault ? clone(fault) : null;
    const executeResult = await runNode([...commonArgs, '--task-id', taskValue.id, '--task-json', executeSnapshot.file, '--execute', '--confirm', CONFIRM_TEXT, '--claim-nonce', executeSnapshot.nonce]);
    const callSnapshot = clone(calls);
    pendingSpuInfoFault = null;
    activeSpuInfoFault = null;
    return {dryResult, executeResult, calls: callSnapshot};
  };
  const dry = await runNode([...commonArgs, '--task-json', taskFile, '--dry-run']);
  const dryPaths = calls.map(c => c.path);
  check('dry-run exits 0', dry.code, 0);
  check('dry-run ok', dry.json?.ok, true);
  check('dry-run state ready', dry.json?.state, 'ready_for_submit');
  check('dry-run payload hash present', Boolean(dry.json?.payload?.payloadHash), true);
  check('dry-run has 5 operations after merging title+images', asArray(dry.json?.payload?.summary?.operations).length, 5);
  check('dry-run merges title and images into one partialEdit op', asArray(dry.json?.payload?.summary?.operations), xs => asArray(xs).filter(x => x === 'update_title_and_images').length === 1 && !asArray(xs).includes('update_title') && !asArray(xs).includes('update_images'));
  check('dry-run merged partialEdit carries skc_title', dry.json?.payload?.submitPlan?.payloads?.find(p => p.operation === 'update_title_and_images')?.body?.skc_list?.[0]?.skc_title, 'Smoke Title');
  check('dry-run merged partialEdit carries image rows', dry.json?.payload?.submitPlan?.payloads?.find(p => p.operation === 'update_title_and_images')?.body?.skc_list?.[0]?.image_info?.image_info_list?.length, 12);
  check('dry-run records image payload inspection', dry.json?.payload?.summary?.imagePayloadInspection?.payloadCount, 1);
  check('dry-run records SPU image count', dry.json?.payload?.summary?.imagePayloadInspection?.totalSpuImages, 1);
  check('dry-run records SKC image count', dry.json?.payload?.summary?.imagePayloadInspection?.totalSkcImages, 12);
  check('dry-run records SKU image count', dry.json?.payload?.summary?.imagePayloadInspection?.totalSkuImages, 1);
  check('dry-run records total detail count', dry.json?.payload?.summary?.imagePayloadInspection?.totalDetailImages, 10);
  check('dry-run records image inspection evidence', dry.json?.adapterEvidence?.imagePayloadInspection?.payloads?.[0]?.skcImageCount, 12);
  check('dry-run injects live SKU sale attributes for SKU image edit',
    dry.json?.payload?.submitPlan?.payloads?.find(p => p.operation === 'update_title_and_images')?.body?.skc_list?.[0]?.sku_list?.[0]?.sale_attribute_list?.[0]?.attribute_value_id, 513);
  check('existing image group codes are reported as retained, not injected', dry.json?.warnings || [], xs => asArray(xs).some(x => /保留 payload 中已有的 2 个 image_group_code/.test(String(x))) && !asArray(xs).some(x => /已注入.*image_group_code/.test(String(x))));
  check('dry-run does not misclassify CDN /80/ path as tiny SKU', dry.json?.blockers || [], xs => !asArray(xs).some(x => /high-resolution-sku-main/.test(String(x))));
  check('dry-run does not misclassify numeric 80 filename as tiny SKU', dry.json?.blockers || [], xs => !asArray(xs).some(x => /\/80\.jpg/.test(String(x))));
  check('dry-run does not call write endpoint', dryPaths.some(p => ['/open-api/goods/modify-skc-shelf','/open-api/stock/change-inventory/v2','/open-api/goods/update-cost','/open-api/openapi-business-backend/product/price/save','/open-api/goods/product/partialEdit'].includes(p)), false);
  check('dry-run defers live inventory preflight to execute', dry.json?.adapterEvidence?.inventoryPreflight ?? null, null);
  check('dry-run records exact current inventory gate', dry.json?.safety?.inventoryPreflightRequired, true);

  const driftTask = {
    id: 'inventory-drift-gate-smoke',
    status: 'waiting_review',
    command: '验证库存写前漂移门禁',
    planning: {source: 'structured_cli', parameters: {inventory: 100, expectedCurrentInventory: 99}},
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    intents: ['update_inventory'],
  };
  const driftTaskFile = await writeJson('task-inventory-drift.json', {version: 1, tasks: [driftTask]});
  calls.length = 0;
  const driftDry = await runNode([...commonArgs, '--task-id', driftTask.id, '--task-json', driftTaskFile, '--dry-run']);
  check('inventory drift dry-run exits without exception', driftDry.code, 0);
  check('inventory drift dry-run stays ready', driftDry.json?.state, 'ready_for_submit');
  check('inventory drift dry-run does not call live stock preflight', calls.some(c => c.path === '/open-api/stock/stock-query'), false);
  const driftHash = driftDry.json?.payload?.payloadHash || '';
  const driftExecuteSnapshot = await writeExecuteSnapshot('task-inventory-drift-execute.json', driftTask, driftHash, {nonce: `claim-${driftTask.id}-drift`});
  calls.length = 0;
  const driftExecute = await runNode([...commonArgs, '--task-id', driftTask.id, '--task-json', driftExecuteSnapshot.file, '--execute', '--confirm', CONFIRM_TEXT, '--claim-nonce', driftExecuteSnapshot.nonce]);
  check('inventory drift blocked execute exits 1', driftExecute.code, 1);
  check('inventory drift execute blocks mismatched current stock', driftExecute.json?.state, 'blocked');
  check('inventory drift execute makes no write attempt', driftExecute.json?.adapterEvidence?.writeAttempted, false);
  check('inventory drift execute reports exact SKU mismatch', driftExecute.json?.blockers || [], xs => asArray(xs).some(x => /INVENTORY_FRESH_STOCK_ROW_REQUIRED/.test(String(x)) && /"mismatchedSkuCodes":\["sku-smoke-001"\]/.test(String(x))));
  check('inventory drift execute uses official stock query', calls.some(c => c.path === '/open-api/stock/stock-query'), true);
  check('inventory drift execute never calls write endpoint', calls.some(c => c.path === '/open-api/stock/change-inventory/v2'), false);

  const manyDetailTask = {
    id: 'many-detail-image-smoke',
    status: 'waiting_review',
    command: '给 SMK 的 TEST-PRODUCT 换图',
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    partialEditPayload: {
      spu_name: 'spu-smoke',
      is_spu_pic: true,
      image_info: {image_info_list: [{image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/many-spu-main.jpg'}]},
      skc_list: [{
        skc_name: 'sv-smoke-skc',
        image_info: {
          image_info_list: [
            {image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/many-main.jpg'},
            ...Array.from({length: 12}, (_, i) => ({
              image_sort: i + 2,
              image_type: 2,
              image_url: `http://imgdeal-test01.shein.com/images3_pi/many-detail-${i + 1}.jpg`,
            })),
          ],
        },
        sku_list: [{
          sku_code: 'sku-smoke-001',
          image_info: {image_info_list: [{image_sort: 1, image_type: 1, image_url: 'https://img.ltwebstatic.com/v4/j/spmp/2026/07/02/80.jpg'}]},
        }],
      }],
    },
    intents: ['update_images'],
  };
  const manyDetailTaskFile = await writeJson('task-many-detail-image.json', {version: 1, tasks: [manyDetailTask]});
  calls.length = 0;
  const manyDetailDry = await runNode([...commonArgs, '--task-id', 'many-detail-image-smoke', '--task-json', manyDetailTaskFile, '--dry-run']);
  check('many-detail image dry-run exits without exception', manyDetailDry.code, 0);
  check('many-detail image dry-run remains ready', manyDetailDry.json?.ok, true);
  check('many-detail image dry-run reports warning not blocker', manyDetailDry.json?.warnings || [], xs => asArray(xs).some(x => /细节图.*超过 11 张/.test(String(x))));
  check('spu-info without group codes reports honest missing warning', manyDetailDry.json?.warnings || [], xs => asArray(xs).some(x => /缺少 image_group_code/.test(String(x))) && !asArray(xs).some(x => /已注入.*image_group_code/.test(String(x))));
  check('many-detail image dry-run has no numeric 80 sku blocker', manyDetailDry.json?.blockers || [], xs => !asArray(xs).some(x => /80\.jpg/.test(String(x))));

  const liveSbTask = {
    id: 'live-sb-image-smoke',
    status: 'waiting_review',
    command: '给刚发布的 SB 链接换图',
    targets: {stores: ['SMK'], productRefs: ['b2608062023343035', 'SB260806202334303501938']},
    publishAssetBinding: {
      schemaVersion: 2,
      kind: 'update_images',
      sourceApproved: true,
      targetStore: 'SMK',
      bindingFingerprint: 'a'.repeat(64),
    },
    partialEditPayload: {
      spu_name: 'b2608062023343035',
      is_spu_pic: true,
      image_info: {image_info_list: [{image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/live-sb-spu-main.jpg'}]},
      skc_list: [{
        skc_name: 'SB260806202334303501938',
        image_info: {image_info_list: [{image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/live-sb-main.jpg'}]},
        sku_list: [{sku_code: 'SKU-LIVE-SB-001', image_info: {image_info_list: [{image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/live-sb-sku.jpg'}]}}],
      }],
    },
    intents: ['update_images'],
  };
  const liveSbTaskFile = await writeJson('task-live-sb-image.json', {version: 1, tasks: [liveSbTask]});
  calls.length = 0;
  const liveSbDry = await runNode([...commonArgs, '--task-id', liveSbTask.id, '--task-json', liveSbTaskFile, '--dry-run']);
  const liveSbPlan = liveSbDry.json?.payload?.submitPlan?.payloads?.[0];
  check('uppercase SB exact target dry-run exits 0', liveSbDry.code, 0);
  check('approved SB target resolves while live search is not ready', liveSbDry.json?.ok, true);
  check('approved SB target records same-task binding resolution', liveSbDry.json?.adapterEvidence?.matchedLinks?.[0]?.resolvedFrom, 'task_approved_image_identity');
  check('uppercase SB image payload uses canonical live skc', liveSbPlan?.body?.skc_list?.[0]?.skc_name, 'sb260806202334303501938');
  check('uppercase SB image payload fills immediate live sku', liveSbPlan?.body?.skc_list?.[0]?.sku_list?.[0]?.sku_code, 'sku-live-sb-001');
  check('uppercase SB image payload injects live SKU sale attributes', liveSbPlan?.body?.skc_list?.[0]?.sku_list?.[0]?.sale_attribute_list?.[0]?.attribute_value_id, 513);
  check('uppercase SB image payload injects live group code', liveSbPlan?.body?.skc_list?.[0]?.image_info?.image_group_code, 'G-LIVE-SKC');
  check('approved SB binding does not depend on searchProduct indexing', calls.some(c => c.path === '/open-api/goods/searchProduct'), false);

  const liveSbSearchTask = {
    ...liveSbTask,
    id: 'live-sb-search-smoke',
    targets: {stores: ['SMK'], productRefs: ['SB260806202334303501938']},
    publishAssetBinding: undefined,
  };
  const liveSbSearchTaskFile = await writeJson('task-live-sb-search.json', {version: 1, tasks: [liveSbSearchTask]});
  calls.length = 0;
  const liveSbSearchDry = await runNode([...commonArgs, '--task-id', liveSbSearchTask.id, '--task-json', liveSbSearchTaskFile, '--dry-run']);
  check('unbound SB target still resolves from live OpenAPI', liveSbSearchDry.json?.adapterEvidence?.matchedLinks?.[0]?.resolvedFrom, 'openapi_exact_skc');
  check('unbound SB exact lookup respects searchProduct pageSize limit', calls.find(c => c.path === '/open-api/goods/searchProduct')?.body?.pageSize, 10);

  const correctionBindings = [
    {name: 'approved-correction-main.png', role: 'mainCover', imageType: 1, imageUrl: 'https://img.shein.com/approved-correction-main.png', width: 900, height: 1200, order: 1},
    {name: 'approved-correction-detail.png', role: 'detail', imageType: 2, imageUrl: 'https://img.shein.com/approved-correction-detail.png', width: 900, height: 1200, order: 2},
    {name: 'approved-correction-square.png', role: 'squareImage', imageType: 5, imageUrl: 'https://img.shein.com/approved-correction-square.png', width: 1200, height: 1200, order: 3},
  ];
  const correctionSourcePayload = {
    category_id: 789,
    multi_language_name_list: [{language: 'en', name: 'Original locked title'}],
    product_attribute_list: [{attribute_id: 1000546, attribute_extra_value: 'SK-15061'}],
    skc_list: [{
      supplier_code: 'SK-15061热风梳',
      image_info: {image_info_list: [{image_type: 1, image_sort: 1, image_url: 'https://img.shein.com/wrong-sm961.png'}]},
      sku_list: [{supplier_sku: 'SK-15061-ORIGINAL', cost_info: {currency: 'SAR', cost_price: '88.00'}, stock_info_list: [{warehouse_id: 'WH-SMOKE', stock: 100}]}],
    }],
  };
  const correctionBindingFingerprint = 'c'.repeat(64);
  const correctionPlan = buildPendingListingImageCorrection({
    sourceTask: {id: 'source-publish-smoke', openapiPublishPayload: correctionSourcePayload, execution: {actualWriteSubmitted: true}},
    sourceTaskId: 'source-publish-smoke',
    targetStore: 'SMK',
    identity: {spuName: 'b2608062023343035', skcName: 'sb260806202334303501938', skuCodes: ['SKU-LIVE-SB-001']},
    documentVersion: correctionDocumentVersion,
    approvedBindings: correctionBindings,
    approvedBindingFingerprint: correctionBindingFingerprint,
  });
  const correctionTask = {
    id: 'pending-correction-smoke',
    status: 'waiting_review',
    command: '纠正待审核新品图片',
    targets: {stores: ['SMK'], productRefs: ['b2608062023343035', 'sb260806202334303501938']},
    intents: ['update_images'],
    publishAssetBinding: {schemaVersion: 2, kind: 'update_images', sourceApproved: true, targetStore: 'SMK', bindingFingerprint: correctionBindingFingerprint},
    imageEditPayload: {
      spu_name: 'b2608062023343035',
      skc_list: [{skc_name: 'sb260806202334303501938', image_info: correctionPlan.republishPayload.skc_list[0].image_info, sku_list: [{sku_code: 'SKU-LIVE-SB-001'}]}],
    },
    pendingNewListingImageCorrection: correctionPlan,
  };
  const correctionDryFile = await writeJson('task-pending-correction-dry.json', {version: 1, tasks: [correctionTask]});
  calls.length = 0;
  const correctionDry = await runNode([...commonArgs, '--task-id', correctionTask.id, '--task-json', correctionDryFile, '--dry-run']);
  const correctionDryHash = correctionDry.json?.payload?.payloadHash || '';
  check('pending correction dry-run ready', correctionDry.json?.state, 'ready_for_submit');
  check('pending correction dry-run locks hash', Boolean(correctionDryHash), true);
  check('pending correction dry-run plans revoke then republish', correctionDry.json?.payload?.summary?.operations || [], xs => JSON.stringify(xs) === JSON.stringify(['pending_new_listing_revoke','pending_new_listing_republish']));
  check('pending correction dry-run performs no write', calls.some(call => ['/open-api/goods/revoke-product','/open-api/goods/product/publishOrEdit'].includes(call.path)), false);
  check('pending correction dry-run queries exact version', calls.find(call => call.path === '/open-api/goods/query-document-state')?.body?.spuList?.[0]?.version, 'SPMP260806300745650');
  const correctionExec = await writeExecuteSnapshot('task-pending-correction-exec.json', correctionTask, correctionDryHash);
  calls.length = 0;
  const correctionFailed = await runNode([...commonArgs, '--task-id', correctionTask.id, '--task-json', correctionExec.file, '--execute', '--confirm', CONFIRM_TEXT, '--claim-nonce', correctionExec.nonce]);
  check('pending correction definite republish failure is recoverable', correctionFailed.json?.state, 'pending_listing_image_correction_recovery_required');
  check('pending correction records write attempt without final submit', correctionFailed.json?.adapterEvidence?.writeAttempted, true);
  check('pending correction does not claim final submit on failure', correctionFailed.json?.adapterEvidence?.realSubmit, false);
  check('pending correction leaves document withdrawn', correctionDocumentState, 4);
  calls.length = 0;
  const correctionRecoveryDry = await runNode([...commonArgs, '--task-id', correctionTask.id, '--task-json', correctionDryFile, '--dry-run']);
  const correctionRecoveryHash = correctionRecoveryDry.json?.payload?.payloadHash || '';
  check('pending correction recovery dry-run skips repeated revoke', correctionRecoveryDry.json?.payload?.summary?.operations || [], xs => JSON.stringify(xs) === JSON.stringify(['pending_new_listing_republish']));
  check('pending correction recovery receives new phase hash', correctionRecoveryHash !== correctionDryHash, true);
  failCorrectionRepublish = false;
  const correctionRecoveryExec = await writeExecuteSnapshot('task-pending-correction-recovery-exec.json', correctionTask, correctionRecoveryHash, {nonce: `claim-${correctionTask.id}-recovery`});
  calls.length = 0;
  const correctionRecovered = await runNode([...commonArgs, '--task-id', correctionTask.id, '--task-json', correctionRecoveryExec.file, '--execute', '--confirm', CONFIRM_TEXT, '--claim-nonce', correctionRecoveryExec.nonce]);
  check('pending correction recovered submit succeeds', correctionRecovered.json?.state, 'submitted');
  check('pending correction recovered readback exact state', correctionRecovered.json?.readback?.status, 'matched_pending_document_state');
  check('pending correction strong readback uses new version', correctionRecovered.json?.readback?.evidence?.version, 'SPMP260806399999999');
  check('pending correction never calls partialEdit', calls.some(call => call.path === '/open-api/goods/product/partialEdit'), false);

  const badImageTask = {
    id: 'bad-image-smoke',
    status: 'waiting_review',
    command: '给 SMK 的 TEST-PRODUCT 换图',
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    partialEditPayload: {
      spu_name: 'spu-smoke',
      skc_list: [{
        skc_name: 'sv-smoke-skc',
        image_info: {image_group_code: 'G-smoke', image_info_list: [{image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/smoke-main.jpg'}]},
        sku_list: [{
          sku_code: 'sku-smoke-001',
          image_info: {image_info_list: [{image_sort: 1, image_type: 6, image_url: 'http://imgdeal-test01.shein.com/images3_pi/sku-80.png'}]},
        }],
      }],
    },
    intents: ['update_images'],
  };
  const badImageTaskFile = await writeJson('task-bad-image.json', {version: 1, tasks: [badImageTask]});
  calls.length = 0;
  const badImageDry = await runNode([...commonArgs, '--task-id', 'bad-image-smoke', '--task-json', badImageTaskFile, '--dry-run']);
  const badImagePaths = calls.map(c => c.path);
  check('bad image dry-run exits without exception', badImageDry.code, 0);
  check('bad image dry-run blocks unsafe payload', badImageDry.json?.ok, false);
  check('bad image dry-run state blocked', badImageDry.json?.state, 'blocked');
  check('bad image dry-run reports sku type blocker', badImageDry.json?.blockers || [], xs => asArray(xs).some(x => /SKU 图只允许主图 image_type=1/.test(String(x))));
  check('bad image dry-run reports tiny sku blocker', badImageDry.json?.blockers || [], xs => asArray(xs).some(x => /sku-80|80x80/.test(String(x))));
  check('bad image dry-run counts sku image', badImageDry.json?.payload?.summary?.imagePayloadInspection?.totalSkuImages, 1);
  check('bad image dry-run does not call partialEdit', badImagePaths.includes('/open-api/goods/product/partialEdit'), false);

  const hash = dry.json?.payload?.payloadHash || '';
  const execTask = await writeExecuteSnapshot('task-exec.json', task, hash);
  calls.length = 0;
  const exec = await runNode([...commonArgs, '--task-json', execTask.file, '--execute', '--confirm', CONFIRM_TEXT, '--claim-nonce', execTask.nonce]);
  const execPaths = calls.map(c => c.path);
  check('execute exits 0', exec.code, 0);
  check('execute state submitted', exec.json?.state, 'submitted');
  check('execute publishResult code', exec.json?.publishResult?.code, '0');
  check('execute validates exact current inventory through OpenAPI', exec.json?.adapterEvidence?.inventoryPreflight?.ok, true);
  check('execute mixed readback stays pending because product price has no approved exact field', exec.json?.readback?.ok, false);
  check('execute readback includes stock', exec.json?.readback?.status || '', s => String(s).includes('matched_stock_query'));
  check('execute product price stays explicitly unconfirmed', exec.json?.readback?.status || '', s => String(s).includes('product_price_unconfirmed'));
  const mixedGroups = asArray(exec.json?.readback?.groups);
  for (const operation of ['retire_link','update_inventory','update_supply_price','update_title','update_images']) {
    check(`execute ${operation} group exact`, mixedGroups.find(group => group.operation === operation)?.ok, true);
  }
  check('execute product price group is not identity-only proof', mixedGroups.find(group => group.operation === 'update_product_price')?.status, 'product_price_unconfirmed');
  check('execute emits one independent readback group per intent', mixedGroups.length, 6);
  for (const endpoint of ['/open-api/goods/modify-skc-shelf','/open-api/stock/change-inventory/v2','/open-api/goods/update-cost','/open-api/openapi-business-backend/product/price/save','/open-api/goods/product/partialEdit','/open-api/stock/stock-query','/open-api/goods/spu-info']) {
    check(`execute called ${endpoint}`, execPaths.includes(endpoint), true);
  }
  check('execute does not use product/query identity as mutation proof', execPaths.includes('/open-api/openapi-business-backend/product/query'), false);
  const strongSpuCall = calls.find(c => c.path === '/open-api/goods/spu-info' && c.body?.spuName === 'spu-smoke');
  check('operation readback uses official spu-info exact SPU request', strongSpuCall?.body?.spuName, 'spu-smoke');
  check('operation readback requests exact title languages', strongSpuCall?.body?.languageList || [], value => JSON.stringify(value) === JSON.stringify(['en','ar']));
  check('image readback records explicit URL normalization policy', mixedGroups.find(group => group.operation === 'update_images')?.evidence?.urlPolicy || '', value => /host-lowercase.*path-exact.*query/.test(String(value)));
  check('execute called partialEdit once for merged title and image', execPaths.filter(p => p === '/open-api/goods/product/partialEdit').length, 1);
  check('execute partialEdit body includes title and image', calls.filter(c => c.path === '/open-api/goods/product/partialEdit')[0]?.body, body => Boolean(body?.multi_language_name_list?.length && body?.skc_list?.[0]?.skc_title && body?.skc_list?.[0]?.image_info?.image_info_list?.length));
  check('execute reused payload hash', exec.json?.payload?.payloadHash || '', hash);
  check('saved output file exists', fssync.existsSync(path.join(ROOT, exec.json?.savedTo || '')), true);

  const activateTask = {
    id: 'activate-smoke',
    status: 'waiting_review',
    command: '把 SMK 的 TEST-INACTIVE 恢复上架',
    targets: {stores: ['SMK'], productRefs: ['TEST-INACTIVE']},
    intents: ['activate_link'],
  };
  const activateDryFile = await writeJson('task-activate-dry.json', {version: 1, tasks: [activateTask]});
  calls.length = 0;
  const activateDry = await runNode([...commonArgs, '--task-id', 'activate-smoke', '--task-json', activateDryFile, '--dry-run']);
  check('activate dry-run exits 0', activateDry.code, 0);
  check('activate dry-run ok', activateDry.json?.ok, true);
  check('activate dry-run operation', activateDry.json?.payload?.summary?.operations?.[0], 'activate_link');
  check('activate dry-run uses shelf state 1', activateDry.json?.payload?.submitPlan?.payloads?.[0]?.body?.skc_site_info_list?.[0]?.shelf_state, 1);
  check('activate dry-run does not write', calls.some(c => c.path === '/open-api/goods/modify-skc-shelf'), false);
  const activateHash = activateDry.json?.payload?.payloadHash || '';
  const activateNoClaimFile = await writeJson('task-activate-no-claim.json', {version: 1, executionContext: {expectedPayloadHash: activateHash}, tasks: [activateTask]});
  calls.length = 0;
  const activateNoClaim = await runNode([...commonArgs, '--task-id', 'activate-smoke', '--task-json', activateNoClaimFile, '--execute', '--confirm', CONFIRM_TEXT]);
  check('activate execute without durable claim is blocked', activateNoClaim.json?.state, 'blocked');
  check('activate execute without durable claim never writes', calls.some(c => c.path === '/open-api/goods/modify-skc-shelf'), false);
  check('activate execute without durable claim explains exact gate', activateNoClaim.json?.blockers || [], xs => asArray(xs).some(x => /write-claim/.test(String(x))));
  const activateWrongClaim = await writeExecuteSnapshot('task-activate-wrong-claim.json', activateTask, activateHash, {
    nonce: 'claim-activate-wrong-operation',
    claimOperations: ['activate_link', 'update_title'],
  });
  calls.length = 0;
  const activateWrongClaimResult = await runNode([...commonArgs, '--task-id', 'activate-smoke', '--task-json', activateWrongClaim.file, '--execute', '--confirm', CONFIRM_TEXT, '--claim-nonce', activateWrongClaim.nonce]);
  check('activate execute with extra claim operation is blocked', activateWrongClaimResult.json?.state, 'blocked');
  check('activate execute with extra claim operation never writes', calls.some(c => c.path === '/open-api/goods/modify-skc-shelf'), false);
  const activateExec = await writeExecuteSnapshot('task-activate-exec.json', activateTask, activateHash);
  calls.length = 0;
  const activateResult = await runNode([...commonArgs, '--task-id', 'activate-smoke', '--task-json', activateExec.file, '--execute', '--confirm', CONFIRM_TEXT, '--claim-nonce', activateExec.nonce]);
  check('activate execute exits 0', activateResult.code, 0);
  check('activate execute state submitted', activateResult.json?.state, 'submitted');
  check('activate execute calls shelf endpoint', calls.some(c => c.path === '/open-api/goods/modify-skc-shelf'), true);
  check('activate execute payload shelf state 1', calls.find(c => c.path === '/open-api/goods/modify-skc-shelf')?.body?.skc_site_info_list?.[0]?.shelf_state, 1);
  check('activate execute exact shelf readback succeeds', activateResult.json?.readback?.ok, true);
  check('activate execute reports exact shelf evidence', activateResult.json?.readback?.status, 'matched_shelf_status_exact');
  check('activate execute completes only after strong readback', activateResult.json?.outcome, 'completed');
  check('activate readback calls official spu-info', calls.some(c => c.path === '/open-api/goods/spu-info' && c.body?.spuName === 'spu-inactive-smoke'), true);

  const mixedCaseSpuTask = {
    id: 'mixed-case-spu-smoke',
    status: 'waiting_review',
    command: '验证混合大小写 SPU 原样请求与强回读',
    targets: {stores: ['SMK'], productRefs: ['TEST-MIXED-SPU']},
    intents: ['retire_link'],
  };
  const mixedCaseSpuExact = await runClaimedTask('mixed-case-spu-exact', mixedCaseSpuTask);
  const mixedCaseExactGroup = mixedCaseSpuExact.executeResult.json?.readback?.groups?.[0];
  const mixedCaseExactCall = mixedCaseSpuExact.calls.find(call => call.path === '/open-api/goods/spu-info');
  check('mixed-case SPU dry-run ready', mixedCaseSpuExact.dryResult.json?.state, 'ready_for_submit');
  check('mixed-case SPU request preserves trimmed source case', mixedCaseExactCall?.body?.spuName, 'SpU-MiXeD-Smoke');
  check('mixed-case SPU exact response completes', mixedCaseSpuExact.executeResult.json?.outcome, 'completed');
  check('mixed-case SPU exact response matches shelf status', mixedCaseExactGroup?.status, 'matched_shelf_status_exact');
  check('mixed-case SPU evidence preserves requested identity', mixedCaseExactGroup?.evidence?.targets?.[0]?.requestedSpu, 'SpU-MiXeD-Smoke');
  check('mixed-case SPU evidence preserves returned identity', mixedCaseExactGroup?.evidence?.targets?.[0]?.returnedSpu, 'SpU-MiXeD-Smoke');

  const mixedCaseSpuDriftTask = {...mixedCaseSpuTask, id: 'mixed-case-spu-return-drift-smoke'};
  const mixedCaseSpuDrift = await runClaimedTask('mixed-case-spu-return-drift', mixedCaseSpuDriftTask, {
    fault: {kind: 'spu_return_case', value: 'spu-mixed-smoke'},
  });
  const mixedCaseDriftGroup = mixedCaseSpuDrift.executeResult.json?.readback?.groups?.[0];
  const mixedCaseDriftCall = mixedCaseSpuDrift.calls.find(call => call.path === '/open-api/goods/spu-info');
  check('mixed-case SPU drift request still preserves source case', mixedCaseDriftCall?.body?.spuName, 'SpU-MiXeD-Smoke');
  check('mixed-case SPU returned-case drift stays unconfirmed', mixedCaseSpuDrift.executeResult.json?.outcome, 'unconfirmed');
  check('mixed-case SPU returned-case drift fails shelf readback', mixedCaseDriftGroup?.status, 'shelf_status_readback_mismatch');
  check('mixed-case SPU returned-case drift records exact failure', mixedCaseDriftGroup?.evidence?.targets?.[0]?.spuIdentityStatus, 'spu_info_return_identity_case_mismatch');
  check('mixed-case SPU returned-case drift preserves requested identity', mixedCaseDriftGroup?.evidence?.targets?.[0]?.requestedSpu, 'SpU-MiXeD-Smoke');
  check('mixed-case SPU returned-case drift preserves returned identity', mixedCaseDriftGroup?.evidence?.targets?.[0]?.returnedSpu, 'spu-mixed-smoke');

  const certTask = {
    id: 'certificate-smoke',
    status: 'waiting_review',
    command: '给 SMK 的 TEST-PRODUCT 绑定证书池',
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    certificatePayloads: [{endpoint: '/open-api/goods/save-certificate-pool-skc-bind', body: {skc_name: 'sv-smoke-skc', certificate_pool_id: 'CERTPOOL-SMOKE'}}],
    intents: ['certificate_review'],
  };
  const certDryFile = await writeJson('task-cert-dry.json', {version: 1, tasks: [certTask]});
  calls.length = 0;
  const certDry = await runNode([...commonArgs, '--task-id', 'certificate-smoke', '--task-json', certDryFile, '--dry-run']);
  check('certificate dry-run exits 0', certDry.code, 0);
  check('certificate dry-run ok', certDry.json?.ok, true);
  check('certificate dry-run payload hash present', Boolean(certDry.json?.payload?.payloadHash), true);
  check('certificate dry-run does not write', calls.some(c => c.path === '/open-api/goods/save-certificate-pool-skc-bind'), false);
  const certHash = certDry.json?.payload?.payloadHash || '';
  const certExec = await writeExecuteSnapshot('task-cert-exec.json', certTask, certHash);
  calls.length = 0;
  const certResult = await runNode([...commonArgs, '--task-id', 'certificate-smoke', '--task-json', certExec.file, '--execute', '--confirm', CONFIRM_TEXT, '--claim-nonce', certExec.nonce]);
  check('certificate execute exits 0', certResult.code, 0);
  check('certificate execute state submitted', certResult.json?.state, 'submitted');
  check('certificate execute publish code', certResult.json?.publishResult?.code, '0');
  check('certificate execute calls bind endpoint', calls.some(c => c.path === '/open-api/goods/save-certificate-pool-skc-bind'), true);
  check('certificate execute requires manual review', certResult.json?.readback?.status || '', s => String(s).includes('certificate_submitted_manual_review_required'));
  check('certificate execute not auto ok', certResult.json?.ok, false);

  const shelfMismatchTask = {
    id: 'shelf-readback-mismatch-smoke',
    status: 'waiting_review',
    command: '验证下架后的官方详情强回读',
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    intents: ['retire_link'],
  };
  const shelfMismatch = await runClaimedTask('shelf-mismatch', shelfMismatchTask, {fault: {kind: 'shelf_status', value: 1}});
  check('shelf mismatch dry-run ready', shelfMismatch.dryResult.json?.state, 'ready_for_submit');
  check('shelf mismatch stays unconfirmed', shelfMismatch.executeResult.json?.outcome, 'unconfirmed');
  check('shelf mismatch group fails exact state', shelfMismatch.executeResult.json?.readback?.groups?.[0]?.status, 'shelf_status_readback_mismatch');
  check('shelf mismatch official response field is observed', shelfMismatch.executeResult.json?.readback?.groups?.[0]?.evidence?.targets?.[0]?.actualShelfStatus, '1');
  check('shelf mismatch uses official spu-info', shelfMismatch.calls.some(call => call.path === '/open-api/goods/spu-info' && call.body?.spuName === 'spu-smoke'), true);

  const supplyFaultCases = [
    ['sku', {kind: 'supply_sku', value: 'wrong-sku-smoke'}],
    ['currency', {kind: 'supply_currency', value: 'USD'}],
    ['cost', {kind: 'supply_cost', value: 80.01}],
  ];
  for (const [label, fault] of supplyFaultCases) {
    const supplyTask = {
      id: `supply-${label}-mismatch-smoke`,
      status: 'waiting_review',
      command: '验证供货价官方详情强回读',
      planning: {source: 'structured_cli', parameters: {supplyPrice: 80}},
      targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
      intents: ['update_supply_price'],
    };
    const result = await runClaimedTask(`supply-${label}-mismatch`, supplyTask, {fault});
    const group = result.executeResult.json?.readback?.groups?.[0];
    check(`supply ${label} mismatch dry-run ready`, result.dryResult.json?.state, 'ready_for_submit');
    check(`supply ${label} mismatch stays unconfirmed`, result.executeResult.json?.outcome, 'unconfirmed');
    check(`supply ${label} mismatch fails exact readback`, group?.status, 'supply_price_readback_mismatch');
    check(`supply ${label} mismatch records no tolerance policy`, group?.evidence?.numericPolicy, 'canonical-decimal-exact-no-tolerance');
    check(`supply ${label} mismatch uses official spu-info`, result.calls.some(call => call.path === '/open-api/goods/spu-info' && call.body?.spuName === 'spu-smoke'), true);
  }

  const exactTitleParameters = {title: 'Smoke Title', titleAr: 'عنوان دخاني'};
  const titleFaultCases = [
    ['missing-language', {kind: 'title_missing_language', language: 'ar'}],
    ['wrong-text', {kind: 'title_text', language: 'en', value: 'Wrong Smoke Title'}],
  ];
  for (const [label, fault] of titleFaultCases) {
    const titleTask = {
      id: `title-${label}-smoke`,
      status: 'waiting_review',
      command: '验证标题官方详情强回读',
      planning: {source: 'structured_cli', parameters: exactTitleParameters},
      targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
      intents: ['update_title'],
    };
    const result = await runClaimedTask(`title-${label}`, titleTask, {fault});
    const group = result.executeResult.json?.readback?.groups?.[0];
    check(`title ${label} mismatch dry-run ready`, result.dryResult.json?.state, 'ready_for_submit');
    check(`title ${label} mismatch stays unconfirmed`, result.executeResult.json?.outcome, 'unconfirmed');
    check(`title ${label} mismatch fails exact language/text`, group?.status, 'title_readback_mismatch');
    check(`title ${label} mismatch has independent evidence`, group?.operation, 'update_title');
  }

  const exactImagePayload = {
    spu_name: 'spu-smoke',
    is_spu_pic: true,
    image_info: {image_info_list: [{image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/exact-spu-main.jpg?quality=90&width=900'}]},
    skc_list: [{
      skc_name: 'sv-smoke-skc',
      image_info: {image_info_list: [
        {image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/smoke-main.jpg?quality=90&width=900'},
        {image_sort: 2, image_type: 2, image_url: 'http://imgdeal-test01.shein.com/images3_pi/exact-detail.jpg'},
        {image_sort: 3, image_type: 5, image_url: 'http://imgdeal-test01.shein.com/images3_pi/exact-square.jpg'},
      ]},
      site_detail_image_info_list: [{
        image_group_code: 'G-SMOKE-SITE-DETAIL',
        site_abbr_list: ['shein-sa'],
        image_info_list: [{image_sort: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/exact-site-detail.jpg?quality=90&width=900'}],
      }],
      sku_list: [{sku_code: 'sku-smoke-001', image_info: {image_info_list: [{image_sort: 1, image_type: 1, image_url: 'http://imgdeal-test01.shein.com/images3_pi/exact-sku.jpg'}]}}],
    }],
  };
  const exactImageTask = {
    id: 'image-exact-positive-smoke',
    status: 'waiting_review',
    command: '验证图片全部层级官方详情强回读',
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    partialEditPayload: clone(exactImagePayload),
    intents: ['update_images'],
  };
  const exactImagePositive = await runClaimedTask('image-exact-positive', exactImageTask);
  const exactImageGroup = exactImagePositive.executeResult.json?.readback?.groups?.[0];
  check('image exact positive completes', exactImagePositive.executeResult.json?.outcome, 'completed');
  check('image exact positive group matches', exactImageGroup?.status, 'matched_images_exact');
  check('image exact positive proves SPU/SKC/SKU/site-detail levels', exactImageGroup?.evidence?.levels || [], rows => ['SPU','SKC','SKU','SKC_SITE_DETAIL'].every(level => asArray(rows).some(row => row.level === level && row.ok === true)));
  const wrongLevelPayload = clone(exactImagePayload);
  wrongLevelPayload.site_detail_image_info_list = wrongLevelPayload.skc_list[0].site_detail_image_info_list;
  delete wrongLevelPayload.skc_list[0].site_detail_image_info_list;
  const wrongLevelTask = {...exactImageTask, id: 'image-wrong-request-level-smoke', partialEditPayload: wrongLevelPayload};
  const wrongLevelTaskFile = await writeJson('task-image-wrong-request-level.json', {version: 1, tasks: [wrongLevelTask]});
  calls.length = 0;
  const wrongLevelDry = await runNode([...commonArgs, '--task-id', wrongLevelTask.id, '--task-json', wrongLevelTaskFile, '--dry-run']);
  check('image wrong request level is blocked before write', wrongLevelDry.json?.state, 'blocked');
  check('image wrong request level explains official SKC hierarchy', wrongLevelDry.json?.blockers || [], rows => asArray(rows).some(row => /site_detail_image_info_list.*skc_list/.test(String(row))));
  check('image wrong request level never calls partialEdit', calls.some(call => call.path === '/open-api/goods/product/partialEdit'), false);
  const imageFaultCases = [
    ['url', {kind: 'image_url', value: 'https://imgdeal-test01.shein.com/images3_pi/smoke-main.jpg?quality=90&width=901'}],
    ['role', {kind: 'image_role', value: 'DETAIL'}],
    ['sort', {kind: 'image_sort', value: 2}],
    ['level', {kind: 'image_level'}],
  ];
  for (const [label, fault] of imageFaultCases) {
    const imageTask = {
      id: `image-${label}-mismatch-smoke`,
      status: 'waiting_review',
      command: '验证图片官方详情强回读',
      targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
      partialEditPayload: clone(exactImagePayload),
      intents: ['update_images'],
    };
    const result = await runClaimedTask(`image-${label}-mismatch`, imageTask, {fault});
    const group = result.executeResult.json?.readback?.groups?.[0];
    check(`image ${label} mismatch dry-run ready`, result.dryResult.json?.state, 'ready_for_submit');
    check(`image ${label} mismatch stays unconfirmed`, result.executeResult.json?.outcome, 'unconfirmed');
    check(`image ${label} mismatch fails exact readback`, group?.status, 'image_readback_mismatch');
    check(`image ${label} mismatch records exact URL policy`, group?.evidence?.urlPolicy, value => /host-lowercase.*path-exact.*query/.test(String(value)));
    check(`image ${label} mismatch preserves target-level evidence`, group?.evidence?.levels || [], rows => asArray(rows).some(row => row.level === 'SKC'));
  }

  const mixedExactAndMismatchTask = {
    id: 'mixed-exact-and-mismatch-smoke',
    status: 'waiting_review',
    command: '验证混合批次每个 operation 独立回读',
    planning: {source: 'structured_cli', parameters: {supplyPrice: 80, ...exactTitleParameters}},
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    intents: ['update_supply_price', 'update_title'],
  };
  const mixedExactAndMismatch = await runClaimedTask('mixed-exact-and-mismatch', mixedExactAndMismatchTask, {fault: {kind: 'title_text', language: 'ar', value: 'عنوان خاطئ'}});
  const mixedExactGroups = asArray(mixedExactAndMismatch.executeResult.json?.readback?.groups);
  check('mixed exact/mismatch stays unconfirmed', mixedExactAndMismatch.executeResult.json?.outcome, 'unconfirmed');
  check('mixed exact/mismatch emits two independent groups', mixedExactGroups.length, 2);
  check('mixed exact/mismatch keeps exact supply group true', mixedExactGroups.find(group => group.operation === 'update_supply_price')?.ok, true);
  check('mixed exact/mismatch keeps title group false', mixedExactGroups.find(group => group.operation === 'update_title')?.ok, false);
  check('mixed exact/mismatch total readback false', mixedExactAndMismatch.executeResult.json?.readback?.ok, false);

  // Deterministic regression: an earlier op durably commits (committed=true)
  // while a later op is definitively rejected by the platform. output.blockers
  // must keep the platform rejection verbatim and add an explicit
  // readback-unconfirmed blocker/warning; the terminal state is
  // partial/unconfirmed -- never success.
  const partialRejectTask = {
    id: 'partial-platform-reject-smoke',
    status: 'waiting_review',
    command: '处理一项先改库存再改售价的结构化维护任务；不要从这句话猜动作或参数',
    planning: {source: 'structured_cli', parameters: {inventory: 100, expectedCurrentInventory: 100, productPrice: 99}},
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    intents: ['update_inventory', 'update_product_price'],
  };
  const partialRejectTaskFile = await writeJson('task-partial-platform-reject-dry.json', {version: 1, tasks: [partialRejectTask]});
  calls.length = 0;
  const partialRejectDry = await runNode([...commonArgs, '--task-id', partialRejectTask.id, '--task-json', partialRejectTaskFile, '--dry-run']);
  check('partial platform reject dry-run stays ready', partialRejectDry.json?.state, 'ready_for_submit');
  check('partial platform reject dry-run plans inventory then price', partialRejectDry.json?.payload?.summary?.operations || [], xs => JSON.stringify(asArray(xs)) === JSON.stringify(['update_inventory','update_product_price']));
  const partialRejectHash = partialRejectDry.json?.payload?.payloadHash || '';
  const partialRejectExec = await writeExecuteSnapshot('task-partial-platform-reject-exec.json', partialRejectTask, partialRejectHash);
  rejectProductPrice = true;
  calls.length = 0;
  const partialRejectResult = await runNode([...commonArgs, '--task-id', partialRejectTask.id, '--task-json', partialRejectExec.file, '--execute', '--confirm', CONFIRM_TEXT, '--claim-nonce', partialRejectExec.nonce]);
  rejectProductPrice = false;
  const partialRejectBlockers = asArray(partialRejectResult.json?.blockers);
  check('partial platform reject exits 0', partialRejectResult.code, 0);
  check('partial platform reject state stays submitted', partialRejectResult.json?.state, 'submitted');
  check('partial platform reject ok false', partialRejectResult.json?.ok, false);
  check('partial platform reject partial true', partialRejectResult.json?.partial, true);
  check('partial platform reject committed true', partialRejectResult.json?.committed, true);
  check('partial platform reject outcome unconfirmed', partialRejectResult.json?.outcome, 'unconfirmed');
  check('partial platform reject never clears blockers', partialRejectBlockers.length > 0, true);
  check('partial platform reject preserves platform rejection blocker', partialRejectBlockers, xs => asArray(xs).some(x => /update_product_price 返回失败：platform rejected price/.test(String(x))));
  check('partial platform reject keeps committed operation evidence', partialRejectResult.json?.adapterEvidence?.realSubmit, true);
  const partialRejectGroups = asArray(partialRejectResult.json?.readback?.groups);
  check('partial platform reject keeps committed inventory group exact', partialRejectGroups.find(group => group.operation === 'update_inventory')?.ok, true);
  check('partial platform reject marks rejected operation not read back', partialRejectGroups.find(group => group.operation === 'update_product_price')?.status, 'operation_platform_rejected_not_read_back');
  check('partial platform reject adds explicit readback unconfirmed blocker', partialRejectBlockers, xs => asArray(xs).some(x => /强回读未确认|回读未确认|未核销/.test(String(x))));
  check('partial platform reject adds readback unconfirmed warning', asArray(partialRejectResult.json?.warnings) || [], xs => asArray(xs).some(x => /强回读未确认|回读未确认|未核销/.test(String(x))));
  check('partial platform reject readback not confirmed', partialRejectResult.json?.readback?.ok, false);

  // Deterministic regression: the whole write commits (committed=true) but the
  // strong readback cannot confirm update_product_price because no approved
  // operation-specific authoritative read field exists. Product identity is
  // never mutation proof. Outcome must be unconfirmed with an explicit
  // readback-unconfirmed blocker/warning; never 'completed'.
  const readbackUnconfirmedTask = {
    id: 'readback-unconfirmed-smoke',
    status: 'waiting_review',
    command: '验证整批提交后强回读未确认的语义',
    planning: {source: 'structured_cli', parameters: {productPrice: 99}},
    targets: {stores: ['SMK'], productRefs: ['TEST-PRODUCT']},
    intents: ['update_product_price'],
  };
  const readbackUnconfirmedTaskFile = await writeJson('task-readback-unconfirmed-dry.json', {version: 1, tasks: [readbackUnconfirmedTask]});
  calls.length = 0;
  const readbackUnconfirmedDry = await runNode([...commonArgs, '--task-id', readbackUnconfirmedTask.id, '--task-json', readbackUnconfirmedTaskFile, '--dry-run']);
  check('readback unconfirmed dry-run stays ready', readbackUnconfirmedDry.json?.state, 'ready_for_submit');
  const readbackUnconfirmedHash = readbackUnconfirmedDry.json?.payload?.payloadHash || '';
  const readbackUnconfirmedExec = await writeExecuteSnapshot('task-readback-unconfirmed-exec.json', readbackUnconfirmedTask, readbackUnconfirmedHash);
  calls.length = 0;
  const readbackUnconfirmedResult = await runNode([...commonArgs, '--task-id', readbackUnconfirmedTask.id, '--task-json', readbackUnconfirmedExec.file, '--execute', '--confirm', CONFIRM_TEXT, '--claim-nonce', readbackUnconfirmedExec.nonce]);
  const readbackUnconfirmedBlockers = asArray(readbackUnconfirmedResult.json?.blockers);
  check('readback unconfirmed exits 0', readbackUnconfirmedResult.code, 0);
  check('readback unconfirmed state stays submitted', readbackUnconfirmedResult.json?.state, 'submitted');
  check('readback unconfirmed ok false', readbackUnconfirmedResult.json?.ok, false);
  check('readback unconfirmed partial true', readbackUnconfirmedResult.json?.partial, true);
  check('readback unconfirmed committed true', readbackUnconfirmedResult.json?.committed, true);
  check('readback unconfirmed outcome unconfirmed', readbackUnconfirmedResult.json?.outcome, 'unconfirmed');
  check('readback unconfirmed uses explicit product price status', readbackUnconfirmedResult.json?.readback?.status || '', s => String(s).includes('product_price_unconfirmed'));
  check('readback unconfirmed not upgraded to completed', readbackUnconfirmedResult.json?.outcome !== 'completed' && readbackUnconfirmedResult.json?.ok !== true, true);
  check('readback unconfirmed adds explicit readback unconfirmed blocker', readbackUnconfirmedBlockers, xs => asArray(xs).some(x => /强回读未确认|回读未确认|未核销/.test(String(x))));
  check('readback unconfirmed adds readback unconfirmed warning', asArray(readbackUnconfirmedResult.json?.warnings) || [], xs => asArray(xs).some(x => /强回读未确认|回读未确认|未核销/.test(String(x))));
  check('readback unconfirmed records durable commit evidence', readbackUnconfirmedResult.json?.adapterEvidence?.realSubmit, true);
  check('readback unconfirmed called the product price write endpoint', calls.some(c => c.path === '/open-api/openapi-business-backend/product/price/save'), true);
  check('readback unconfirmed never calls product/query identity probe', calls.some(c => c.path === '/open-api/openapi-business-backend/product/query'), false);

  ok = checks.every(c => c.pass);
} finally {
  await new Promise(resolve => fake.close(resolve));
}
const result = {ok, tmpRoot, checks, callPaths: calls.map(c => c.path)};
console.log(JSON.stringify(result, null, 2));
if (ok && !KEEP_TEMP) await fs.rm(tmpRoot, {recursive: true, force: true});
else if (!ok) console.error(`maintenance executor smoke failed; temp kept at ${tmpRoot}`);
if (!ok) process.exit(1);
