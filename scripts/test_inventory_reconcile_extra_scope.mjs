#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {
  assertDailyInventoryExecutionAuthorization,
  buildDailyInventoryPlanHashPayload,
  computeInventoryOverwriteQuantity,
  INVENTORY_OVERWRITE_COMPUTATION_VERSION,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTOR = path.join(ROOT, 'scripts', 'inventory', 'execute_daily_inventory_replenishment_plan.mjs');
const POLICY_FILE = path.join(ROOT, 'config', 'inventory_replenishment_policy.json');
const STORE_KEY = 'DL';
const SKC = 'TEST-SKC-SCOPE-A';
const SKU_CODE = 'TEST-SKU-SCOPE-A';
const EXTRA_SKC = 'TEST-SKC-SCOPE-B';
const EXTRA_SKU = 'TEST-SKU-SCOPE-B';
const CANONICAL = 'TESTCANONICALSCOPEA';
const MATCH_KEY = 'TESTCANONICALSCOPEA';
const AUTOMATION_CONTEXT = 'cloud_daily_inventory_replenishment_guard';
const AUTOMATION_AUTHORIZATION = 'owner-automatic-inventory-20260803-v1';
const TODAY = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());

function runExecutor(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [EXECUTOR, ...args], {
      cwd: ROOT,
      env: {...process.env, ...env},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

function createMockOpenApiServer() {
  let currentUsable = 15;
  const counts = {changeInventory: 0};
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const json = value => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (pathname === '/open-api/openapi-business-backend/query-store-info') {
      json({code: '0', data: {accountNo: 'GS5337922', supplierId: '6720288'}});
      return;
    }
    if (pathname === '/open-api/goods/spu-info') {
      json({code: '0', info: {supplierCode: CANONICAL, skcInfoList: [{skcName: SKC, shelfStatusInfoList: [{siteAbbr: 'shein-sa', shelfStatus: '1'}], skuInfoList: [{skuCode: SKU_CODE}]}]}});
      return;
    }
    if (pathname === '/open-api/stock/stock-query') {
      json({code: '0', info: [{goodsInventory: [{skuList: [{skuCode: SKU_CODE, totalInventoryQuantity: currentUsable, totalUsableInventory: currentUsable, totalLockedQuantity: 0, temporaryInventoryQuantity: 0, warehouseInventoryList: []}]}]}]});
      return;
    }
    if (pathname === '/open-api/stock/change-inventory/v2') {
      counts.changeInventory += 1;
      json({code: '0', success: true});
      return;
    }
    res.statusCode = 404;
    json({code: '404', msg: 'mock no route'});
  });
  return {server, url: '', counts, getChangeInventoryPosts: () => counts.changeInventory};
}

function buildIntent({plan, skc, skuCode, targetUsableInventory, intentId}) {
  const before = {skuCode, totalInventoryQuantity: 10, totalUsableInventory: 10, totalLockedQuantity: 0, temporaryInventoryQuantity: 0, stockRowMissing: false, warehouseCodes: []};
  const logicalActionKey = stableInventoryHash({
    runDate: TODAY,
    store: STORE_KEY,
    skc,
    sku: skuCode,
    target: targetUsableInventory,
    actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
    policyVersion: plan.policyVersion,
    authorizationId: AUTOMATION_AUTHORIZATION,
  });
  const request = {
    pathname: '/open-api/stock/change-inventory/v2',
    method: 'POST',
    body: {updateSkuInventoryQuantityRequests: [{
      idempotencyKey: `bi-inv-${logicalActionKey.slice(0, 42)}`,
      skuCode,
      invType: 'VI',
      changeType: 'OVERWRITE',
      changeQuantity: computeInventoryOverwriteQuantity(targetUsableInventory, before),
      changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
    }]},
    headers: {language: 'en'},
  };
  return {
    kind: 'intent',
    intentId,
    logicalActionKey,
    recoveryScopeKey: stableInventoryHash({store: STORE_KEY, skc, sku: skuCode, actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET', invType: 'VI'}),
    planHash: plan.payloadHash,
    runDate: TODAY,
    storeKey: STORE_KEY,
    skc,
    skuCode,
    targetUsableInventory,
    policyVersion: plan.policyVersion,
    overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION,
    authorizationId: AUTOMATION_AUTHORIZATION,
    idempotencyKey: request.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
    requestPayloadHash: stableInventoryHash(request),
    request,
    before,
    recordedAt: new Date().toISOString(),
  };
}

const executorSource = await fs.readFile(EXECUTOR, 'utf8');
assert.doesNotMatch(executorSource, /extra_intent_scope=/);
assert.match(executorSource, /unrelated scopes must not be written, terminated, or used to fail this batch/);

const manualPolicy = {execution: {mode: 'manual_review', perRunUserConfirmationRequired: true, perRunPayloadHashRequired: true, storeScope: 'all_enabled_stores', automaticExecution: {enabled: false}}};
const hash = 'a'.repeat(64);
const firstAuth = assertDailyInventoryExecutionAuthorization({policy: manualPolicy, payloadHash: hash, confirmHash: hash});
const secondAuth = assertDailyInventoryExecutionAuthorization({policy: manualPolicy, payloadHash: hash, confirmHash: hash});
const otherAuth = assertDailyInventoryExecutionAuthorization({policy: manualPolicy, payloadHash: 'b'.repeat(64), confirmHash: 'b'.repeat(64)});
assert.equal(firstAuth.mode, 'manual_review');
assert.match(firstAuth.authorizationId, /^[a-f0-9]{64}$/);
assert.equal(firstAuth.authorizationId, secondAuth.authorizationId);
assert.notEqual(firstAuth.authorizationId, otherAuth.authorizationId);
assert.equal(assertDailyInventoryExecutionAuthorization({policy: {execution: {mode: 'automatic', perRunUserConfirmationRequired: false, perRunPayloadHashRequired: true, storeScope: 'all_enabled_stores', automaticExecution: {enabled: true, authorizationId: 'owner-automatic-inventory-20260803-v1', allowedContext: 'cloud_daily_inventory_replenishment_guard'}}}, mode: 'automatic', context: 'cloud_daily_inventory_replenishment_guard', authorizationId: 'owner-automatic-inventory-20260803-v1', payloadHash: hash, confirmHash: hash}).authorizationId, 'owner-automatic-inventory-20260803-v1');


const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-extra-scope-'));
const policy = JSON.parse(await fs.readFile(POLICY_FILE, 'utf8'));
const nowIso = new Date().toISOString();
const row = {
  storeKey: STORE_KEY, spu: 'TEST-SPU-SCOPE-A', skc: SKC, skuCode: SKU_CODE, supplierCode: CANONICAL, canonical: CANONICAL, matchKey: MATCH_KEY,
  platformUsableInventory: 10, platformTotalInventory: 10, platformLockedInventory: 0, openApiShelfStatusCode: '1', shelfStatusCode: '1',
  shelfStatusName: '已上架', shelfStatusSource: 'linksData_four_state', sameStoreOnShelfSkcs: [], otherSellingStores: [], crossStoreSoldOutFinding: false,
  etSellableInventory: 15, etSnapshotDate: TODAY, c7SaleCount: 0, c30SaleCount: 0, c7Exposure: 0, c7GoodsVisitors: 0, productName: 'TEST',
  decision: 'legacy_virtual_inventory_top_up', ruleClass: 'legacy_virtual_inventory_top_up', inventoryAction: 'increase', targetUsableInventory: 15,
};
const sourceEvidence = [
  {store: 'ET', file: path.join(temp, 'source-et.json'), fetchedAt: nowIso},
  {store: 'BI_LINKS', file: path.join(temp, 'source-links.json'), fetchedAt: nowIso},
];
await fs.writeFile(path.join(temp, 'source-et.json'), JSON.stringify({source: 'et'}), 'utf8');
const sourceLinksFile = path.join(temp, 'source-links.json');
await fs.writeFile(sourceLinksFile, JSON.stringify({source: 'links', generation: 1}), 'utf8');
sourceEvidence[1].sha256 = crypto.createHash('sha256').update(await fs.readFile(sourceLinksFile)).digest('hex');
const plan = {
  schemaVersion: 'daily-inventory-replenishment-plan/v1', date: TODAY, policyVersion: policy.policyVersion, generatedAt: nowIso,
  etFactSource: null, sourceEvidence, blockers: [], actionable: [row], linkAlerts: [], ignored: [], lowEtAllocations: [],
  detailRefreshTargets: [], crossStoreSoldOutFindings: [], etAlerts: [],
};
plan.payloadHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(plan));
plan.executable = true;
await fs.writeFile(path.join(temp, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
await fs.writeFile(path.join(temp, 'policy.json'), JSON.stringify(policy, null, 2), 'utf8');
await fs.writeFile(path.join(temp, 'bi.json'), JSON.stringify({generatedAt: nowIso, data: {inventoryDepletion: {products: [{match_key: MATCH_KEY, standard_goods_sn: CANONICAL, current_sellable_quantity: 15, et_store_snapshot_date: TODAY, inventory_match_status: 'matched', et_operational_stock_policy: ''}]}}}, null, 2), 'utf8');
await fs.writeFile(path.join(temp, 'links.json'), JSON.stringify({generatedAt: nowIso, data: {storeLinks: [{store_key: STORE_KEY, skc: SKC, standard_goods_sn: CANONICAL, is_on_shelf: true, c7_sale_cnt: 0, c7_eps_uv: 0, c30_sale_cnt: 0, c7_goods_uv: 0}]}}, null, 2), 'utf8');
const mock = createMockOpenApiServer();
mock.url = await new Promise(resolve => mock.server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + mock.server.address().port)));
await fs.writeFile(path.join(temp, 'config.json'), JSON.stringify({stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}], apiBaseUrls: {prodSemiManaged: mock.url}}), 'utf8');

const matchingIntent = buildIntent({plan, skc: SKC, skuCode: SKU_CODE, targetUsableInventory: 15, intentId: 'scope-a-intent'});
const extraIntent = buildIntent({plan, skc: EXTRA_SKC, skuCode: EXTRA_SKU, targetUsableInventory: 8, intentId: 'scope-b-intent'});
const out = path.join(temp, 'result.json');
const journalFile = out + '.journal.ndjson';
await fs.writeFile(journalFile, JSON.stringify(matchingIntent) + '\n' + JSON.stringify(extraIntent) + '\n', 'utf8');

try {
  const run = await runExecutor([
    '--plan', path.join(temp, 'plan.json'),
    '--policy', path.join(temp, 'policy.json'),
    '--config', path.join(temp, 'config.json'),
    '--bi-data', path.join(temp, 'bi.json'),
    '--links-data', path.join(temp, 'links.json'),
    '--out', out,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', plan.payloadHash,
    '--reconcile-pending-only',
  ], {
    SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: AUTOMATION_CONTEXT,
    SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: AUTOMATION_AUTHORIZATION,
  });
  assert.doesNotMatch(run.stderr, /extra_intent_scope=/);
  assert.doesNotMatch(run.stderr, /INVENTORY_RECONCILE_PENDING_ONLY_PRECONDITION_FAILED/);
  assert.equal(run.code, 0, 'current plan reconcile must not fail because of an unrelated journal scope, stderr=' + run.stderr);
  const entries = (await fs.readFile(journalFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const extraAfter = entries.find(entry => entry.intentId === 'scope-b-intent');
  assert.ok(extraAfter);
  assert.equal(JSON.stringify(extraAfter), JSON.stringify(extraIntent));
  assert.equal(entries.some(entry => entry.kind === 'write_outcome' && entry.intentId === 'scope-b-intent'), false);
  assert.equal(mock.getChangeInventoryPosts(), 0);
} finally {
  mock.server.close();
  await fs.rm(temp, {recursive: true, force: true}).catch(() => {});
}

const mismatchTemp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-scope-mismatch-'));
await fs.writeFile(path.join(mismatchTemp, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
await fs.writeFile(path.join(mismatchTemp, 'policy.json'), JSON.stringify(policy, null, 2), 'utf8');
await fs.writeFile(path.join(mismatchTemp, 'bi.json'), JSON.stringify({generatedAt: nowIso, data: {inventoryDepletion: {products: [{match_key: MATCH_KEY, standard_goods_sn: CANONICAL, current_sellable_quantity: 15, et_store_snapshot_date: TODAY, inventory_match_status: 'matched', et_operational_stock_policy: ''}]}}}, null, 2), 'utf8');
await fs.writeFile(path.join(mismatchTemp, 'links.json'), JSON.stringify({generatedAt: nowIso, data: {storeLinks: [{store_key: STORE_KEY, skc: SKC, standard_goods_sn: CANONICAL, is_on_shelf: true, c7_sale_cnt: 0, c7_eps_uv: 0, c30_sale_cnt: 0, c7_goods_uv: 0}]}}, null, 2), 'utf8');
const mismatchOut = path.join(mismatchTemp, 'result.json');
const mismatchJournal = mismatchOut + '.journal.ndjson';
const mismatchedA = buildIntent({plan, skc: SKC, skuCode: SKU_CODE, targetUsableInventory: 14, intentId: 'scope-a-mismatch'});
const extraB = buildIntent({plan, skc: EXTRA_SKC, skuCode: EXTRA_SKU, targetUsableInventory: 8, intentId: 'scope-b-mismatch'});
await fs.writeFile(mismatchJournal, JSON.stringify(mismatchedA) + '\n' + JSON.stringify(extraB) + '\n', 'utf8');
const mockMismatch = createMockOpenApiServer();
mockMismatch.url = await new Promise(resolve => mockMismatch.server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + mockMismatch.server.address().port)));
await fs.writeFile(path.join(mismatchTemp, 'config.json'), JSON.stringify({stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}], apiBaseUrls: {prodSemiManaged: mockMismatch.url}}), 'utf8');
try {
  const mismatchRun = await runExecutor([
    '--plan', path.join(mismatchTemp, 'plan.json'),
    '--policy', path.join(mismatchTemp, 'policy.json'),
    '--config', path.join(mismatchTemp, 'config.json'),
    '--bi-data', path.join(mismatchTemp, 'bi.json'),
    '--links-data', path.join(mismatchTemp, 'links.json'),
    '--out', mismatchOut,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', plan.payloadHash,
    '--reconcile-pending-only',
  ], {
    SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: AUTOMATION_CONTEXT,
    SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: AUTOMATION_AUTHORIZATION,
  });
  assert.notEqual(mismatchRun.code, 0);
  assert.match(mismatchRun.stderr, /INVENTORY_RECONCILE_PENDING_ONLY_PRECONDITION_FAILED/);
  assert.match(mismatchRun.stderr, /scope_matches=0:scope_count=1/);
  assert.doesNotMatch(mismatchRun.stderr, /extra_intent_scope=/);
  const mismatchEntries = (await fs.readFile(mismatchJournal, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(JSON.stringify(mismatchEntries.find(entry => entry.intentId === 'scope-b-mismatch')), JSON.stringify(extraB));
  assert.equal(mockMismatch.getChangeInventoryPosts(), 0);
} finally {
  mockMismatch.server.close();
  await fs.rm(mismatchTemp, {recursive: true, force: true}).catch(() => {});
}

console.log(JSON.stringify({ok: true, tests: ['reconcile_pending_only_ignores_unrelated_same_day_scope', 'current_plan_scope_mismatch_still_fails_closed']}));
