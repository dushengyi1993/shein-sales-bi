#!/usr/bin/env node
/**
 * Daily inventory replenishment executor lifecycle: deterministic subprocess
 * coverage for the per-row catch and the durable-intent map invariant.
 *
 * 1. An error before the durable intent is created (ET evidence guard) must
 *    reach the catch without a ReferenceError and record `blocked`.
 * 2. An error after the durable intent was fsynced (transport failure during
 *    the write POST) must record `suspicious_write_attempted`, retain the
 *    intent in the journal, and a re-run of the same executor must recover it
 *    readback-only (no second POST).
 * 3. A successful write+readback must record `updated_readback_matched` with
 *    exactly one POST, and a re-run must resolve through the recovered-intent
 *    path without a second POST (write/idempotency/readback semantics).
 *
 * All OpenAPI traffic is served by a local mock server; no real SHEIN/OpenAPI
 * endpoint is contacted and no inventory write is executed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

import {
  buildDailyInventoryPlanHashPayload,
  computeInventoryOverwriteQuantity,
  resolveInventoryIdentityKey,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXECUTOR = path.join(ROOT, 'scripts', 'inventory', 'execute_daily_inventory_replenishment_plan.mjs');
const POLICY_FILE = path.join(ROOT, 'config', 'inventory_replenishment_policy.json');
const STORE_KEY = 'DL';
const SKC = 'TEST-SKC-1';
const SKU_CODE = 'TEST-SKU-1';
const CANONICAL = 'TEST-CANON-1';
// The executor's ET lookup and same-store grouping are bound by the
// alias-resolved identity (resolveInventoryIdentityKey), exactly like the
// planner output.  A compact canonicalInventoryKey form (CANON1) would miss
// the ET row and fail the lifecycle scenarios at the ET evidence guard.
const MATCH_KEY = resolveInventoryIdentityKey(CANONICAL);
const LOCK_FILE = path.join(ROOT, 'state', 'locks', `daily-inventory-${STORE_KEY}-${SKC}.lock`);
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

function createMockOpenApiServer({onChangeInventory}) {
  let currentUsable = 10;
  const counts = {queryStoreInfo: 0, spuInfo: 0, stockQuery: 0, changeInventory: 0};
  let changeHandler = onChangeInventory || (() => {});
  let destroyNextStockQuery = false;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const json = value => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (pathname === '/open-api/openapi-business-backend/query-store-info') {
      counts.queryStoreInfo += 1;
      json({code: '0', data: {accountNo: 'GS5337922', supplierId: '6720288'}});
      return;
    }
    if (pathname === '/open-api/goods/spu-info') {
      counts.spuInfo += 1;
      json({
        code: '0',
        info: {
          supplierCode: CANONICAL,
          skcInfoList: [{
            skcName: SKC,
            shelfStatusInfoList: [{siteAbbr: 'shein-sa', shelfStatus: '1'}],
            skuInfoList: [{skuCode: SKU_CODE}],
          }],
        },
      });
      return;
    }
    if (pathname === '/open-api/stock/stock-query') {
      counts.stockQuery += 1;
      if (destroyNextStockQuery) {
        destroyNextStockQuery = false;
        res.socket.destroy();
        return;
      }
      json({
        code: '0',
        info: [{
          goodsInventory: [{
            skuList: [{
              skuCode: SKU_CODE,
              totalInventoryQuantity: currentUsable,
              totalUsableInventory: currentUsable,
              totalLockedQuantity: 0,
              warehouseInventoryList: [],
            }],
          }],
        }],
      });
      return;
    }
    if (pathname === '/open-api/stock/change-inventory/v2') {
      counts.changeInventory += 1;
      changeHandler({res, json, setCurrent: value => { currentUsable = value; }});
      return;
    }
    res.statusCode = 404;
    json({code: '404', msg: 'mock no route'});
  });
  return {
    server,
    url: '',
    setCurrent: value => { currentUsable = value; },
    getCurrent: () => currentUsable,
    counts,
    getChangeInventoryPosts: () => counts.changeInventory,
    setChangeInventoryHandler: handler => { changeHandler = handler; },
    destroyNextStockQuery: () => { destroyNextStockQuery = true; },
  };
}

async function buildPlanFixture(dir, {etProducts}) {
  const nowIso = new Date().toISOString();
  const policy = JSON.parse(await fs.readFile(POLICY_FILE, 'utf8'));
  const row = {
    storeKey: STORE_KEY,
    spu: 'TEST-SPU-1',
    skc: SKC,
    skuCode: SKU_CODE,
    supplierCode: CANONICAL,
    canonical: CANONICAL,
    matchKey: MATCH_KEY,
    platformUsableInventory: 10,
    platformTotalInventory: 10,
    platformLockedInventory: 0,
    openApiShelfStatusCode: '1',
    shelfStatusCode: '1',
    shelfStatusName: '已上架',
    shelfStatusSource: 'linksData_four_state',
    sameStoreOnShelfSkcs: [],
    otherSellingStores: [],
    crossStoreSoldOutFinding: false,
    etSellableInventory: 15,
    etSnapshotDate: TODAY,
    c7SaleCount: 0,
    c30SaleCount: 0,
    c7Exposure: 0,
    c7GoodsVisitors: 0,
    productName: 'TEST',
    decision: 'legacy_virtual_inventory_top_up',
    ruleClass: 'legacy_virtual_inventory_top_up',
    inventoryAction: 'increase',
    targetUsableInventory: 15,
  };
  const sourceEvidence = [
    {store: 'ET', file: 'outputs/bi-portal/sections/inventoryTrend.json', fetchedAt: nowIso},
    {store: 'BI_LINKS', file: 'outputs/bi-portal/sections/linksData.json', fetchedAt: nowIso},
  ];
  const plan = {
    schemaVersion: 'daily-inventory-replenishment-plan/v1',
    date: TODAY,
    policyVersion: policy.policyVersion,
    generatedAt: nowIso,
    etFactSource: null,
    sourceEvidence,
    blockers: [],
    actionable: [row],
    linkAlerts: [],
    ignored: [],
    lowEtAllocations: [],
    detailRefreshTargets: [],
    crossStoreSoldOutFindings: [],
    etAlerts: [],
  };
  plan.payloadHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(plan));
  plan.executable = true;
  await fs.writeFile(path.join(dir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(dir, 'policy.json'), `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({stores: []}), 'utf8');
  await fs.writeFile(path.join(dir, 'bi.json'), JSON.stringify({
    generatedAt: nowIso,
    data: {inventoryDepletion: {products: etProducts}},
  }), 'utf8');
  await fs.writeFile(path.join(dir, 'links.json'), JSON.stringify({
    generatedAt: nowIso,
    data: {storeLinks: [{
      store_key: STORE_KEY,
      skc: SKC,
      standard_goods_sn: CANONICAL,
      is_on_shelf: true,
      c7_sale_cnt: 0,
      c7_eps_uv: 0,
      c30_sale_cnt: 0,
      c7_goods_uv: 0,
    }]},
  }), 'utf8');
  return {plan, policy};
}

async function cleanupLock() {
  await fs.rm(LOCK_FILE, {force: true}).catch(() => {});
  for (const dir of [path.dirname(LOCK_FILE), path.dirname(path.dirname(LOCK_FILE))]) {
    await fs.rmdir(dir).catch(() => {});
  }
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-executor-lifecycle-'));
try {
  // ---------------------------------------------------------------------
  // Scenario 1: error before the durable intent -> blocked, no ReferenceError
  // ---------------------------------------------------------------------
  const dirA = path.join(temp, 'a');
  await fs.mkdir(dirA);
  // Empty ET projection makes the per-row ET guard throw before any intent.
  await buildPlanFixture(dirA, {etProducts: []});
  const outA = path.join(dirA, 'result.json');
  const runA = await runExecutor([
    '--plan', path.join(dirA, 'plan.json'),
    '--policy', path.join(dirA, 'policy.json'),
    '--config', path.join(dirA, 'config.json'),
    '--bi-data', path.join(dirA, 'bi.json'),
    '--links-data', path.join(dirA, 'links.json'),
    '--out', outA,
    '--dry-run',
  ]);
  assert.equal(runA.code, 1, `pre-durable failure must exit blocked, stderr=${runA.stderr}`);
  assert.doesNotMatch(runA.stderr, /ReferenceError/,
    'catch must not ReferenceError on pre-durable errors (production 2026.08.16.10 regression)');
  assert.doesNotMatch(runA.stderr, /activeIntent is not defined/,
    'activeIntent must be in scope for the row catch');
  const resultA = JSON.parse(await fs.readFile(outA, 'utf8'));
  assert.equal(resultA.results.length, 1);
  assert.equal(resultA.results[0].state, 'blocked');
  assert.equal(resultA.results[0].error, 'ET inventory is not a current-day matched fact');
  assert.equal(resultA.results[0].storeKey, STORE_KEY);

  // ---------------------------------------------------------------------
  // Scenario 2: durable intent + transport failure -> suspicious_write_attempted
  // ---------------------------------------------------------------------
  const dirB = path.join(temp, 'b');
  await fs.mkdir(dirB);
  const etRow = {
    match_key: MATCH_KEY,
    standard_goods_sn: CANONICAL,
    current_sellable_quantity: 15,
    et_store_snapshot_date: TODAY,
    inventory_match_status: 'matched',
    et_operational_stock_policy: '',
  };
  const {plan: planB} = await buildPlanFixture(dirB, {etProducts: [etRow]});
  const configB = {
    stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
  };
  const mockB = createMockOpenApiServer({
    onChangeInventory: ({res}) => {
      // Simulate a transport failure after the platform accepted the request:
      // the fetch rejects, so the durable-intent helper flags the write.
      res.socket.destroy();
    },
  });
  mockB.url = await new Promise(resolve => mockB.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${mockB.server.address().port}`)));
  configB.apiBaseUrls = {prodSemiManaged: mockB.url};
  await fs.writeFile(path.join(dirB, 'config.json'), JSON.stringify(configB), 'utf8');
  const outB = path.join(dirB, 'result.json');
  const argsB = [
    '--plan', path.join(dirB, 'plan.json'),
    '--policy', path.join(dirB, 'policy.json'),
    '--config', path.join(dirB, 'config.json'),
    '--bi-data', path.join(dirB, 'bi.json'),
    '--links-data', path.join(dirB, 'links.json'),
    '--out', outB,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', planB.payloadHash,
  ];
  const envB = {
    SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: AUTOMATION_CONTEXT,
    SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: AUTOMATION_AUTHORIZATION,
  };
  try {
    const runB = await runExecutor(argsB, envB);
    assert.equal(runB.code, 1, `durable transport failure must exit blocked, stderr=${runB.stderr}`);
    assert.doesNotMatch(runB.stderr, /ReferenceError/, 'durable-error catch must not ReferenceError');
    const resultB = JSON.parse(await fs.readFile(outB, 'utf8'));
    assert.equal(resultB.results[0].state, 'suspicious_write_attempted',
      `durable transport failure must record suspicious_write_attempted, got error=${resultB.results[0].error} stderr=${runB.stderr}`);
    const logicalActionKey = stableInventoryHash({
      runDate: TODAY,
      store: STORE_KEY,
      skc: SKC,
      sku: SKU_CODE,
      target: 15,
      actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
      policyVersion: planB.policyVersion,
      authorizationId: AUTOMATION_AUTHORIZATION,
    });
    assert.equal(resultB.results[0].logicalActionKey, logicalActionKey);
    assert.equal(resultB.results[0].idempotencyKey, `bi-inv-${logicalActionKey.slice(0, 42)}`);
    assert.match(resultB.results[0].requestPayloadHash, /^[a-f0-9]{64}$/);
    assert.match(resultB.results[0].error, /write intent is durable and automatic resubmission is forbidden/);
    const journalB = await fs.readFile(`${outB}.journal.ndjson`, 'utf8');
    const intentRows = journalB.split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(entry => entry.kind === 'intent');
    assert.equal(intentRows.length, 1, 'the durable intent must be journaled before the failed POST');
    assert.ok(intentRows[0].intentId && /^[A-Za-z0-9-]+$/.test(intentRows[0].intentId), 'journaled intent carries a stable intentId');
    assert.equal(intentRows[0].idempotencyKey, resultB.results[0].idempotencyKey);
    assert.equal(intentRows[0].logicalActionKey, resultB.results[0].logicalActionKey);
    assert.equal(mockB.getChangeInventoryPosts(), 1, 'exactly one POST attempt after the durable fsync');

    // Re-run against the same journal: recovery must be readback-only and
    // must never submit a second overwrite.
    const runB2 = await runExecutor(argsB, envB);
    assert.equal(runB2.code, 1, `recovery re-run stays readback-pending, stderr=${runB2.stderr}`);
    const resultB2 = JSON.parse(await fs.readFile(outB, 'utf8'));
    assert.equal(resultB2.results[0].state, 'submitted_but_readback_pending');
    assert.match(resultB2.results[0].error, /durable pre-submit intent exists and exact target is not visible/);
    assert.equal(mockB.getChangeInventoryPosts(), 1, 'recovery must never POST again');
  } finally {
    mockB.server.close();
    await cleanupLock();
  }

  // ---------------------------------------------------------------------
  // Scenario 3: successful write + readback -> updated_readback_matched, and
  // a re-run resolves via the recovered intent without a second POST.
  // ---------------------------------------------------------------------
  const dirC = path.join(temp, 'c');
  await fs.mkdir(dirC);
  const {plan: planC} = await buildPlanFixture(dirC, {etProducts: [etRow]});
  const mockC = createMockOpenApiServer({
    onChangeInventory: ({res, json, setCurrent}) => {
      setCurrent(15);
      json({code: '0', msg: 'success', traceId: 'trace-1', info: {success: true}});
    },
  });
  mockC.url = await new Promise(resolve => mockC.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${mockC.server.address().port}`)));
  const configC = {
    stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
    apiBaseUrls: {prodSemiManaged: mockC.url},
  };
  await fs.writeFile(path.join(dirC, 'config.json'), JSON.stringify(configC), 'utf8');
  const outC = path.join(dirC, 'result.json');
  const argsC = [
    '--plan', path.join(dirC, 'plan.json'),
    '--policy', path.join(dirC, 'policy.json'),
    '--config', path.join(dirC, 'config.json'),
    '--bi-data', path.join(dirC, 'bi.json'),
    '--links-data', path.join(dirC, 'links.json'),
    '--out', outC,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', planC.payloadHash,
  ];
  const envC = {
    SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: AUTOMATION_CONTEXT,
    SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: AUTOMATION_AUTHORIZATION,
  };
  try {
    const runC = await runExecutor(argsC, envC);
    assert.equal(runC.code, 0, `successful write must exit clean, stderr=${runC.stderr}`);
    const resultC = JSON.parse(await fs.readFile(outC, 'utf8'));
    assert.equal(resultC.results[0].state, 'updated_readback_matched',
      `unexpected scenario-C state, row=${JSON.stringify(resultC.results[0])}`);
    assert.equal(resultC.results[0].before.totalUsableInventory, 10);
    assert.equal(resultC.results[0].after.totalUsableInventory, 15);
    assert.equal(resultC.results[0].writes.length, 1);
    assert.equal(resultC.results[0].writes[0].code, '0');
    assert.equal(resultC.results[0].writes[0].success, true);
    assert.equal(mockC.getChangeInventoryPosts(), 1, 'exactly one successful POST');
    const journalC = await fs.readFile(`${outC}.journal.ndjson`, 'utf8');
    const journalEntriesC = journalC.split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(journalEntriesC.filter(entry => entry.kind === 'intent').length, 1);
    assert.equal(
      journalEntriesC.filter(entry => entry.kind === 'write_outcome' && entry.disposition === 'readback_matched').length,
      1,
      'a matched readback must release the durable intent in the journal',
    );

    const runC2 = await runExecutor(argsC, envC);
    assert.equal(runC2.code, 0, `idempotent re-run must exit clean, stderr=${runC2.stderr}`);
    const resultC2 = JSON.parse(await fs.readFile(outC, 'utf8'));
    assert.equal(resultC2.results[0].state, 'skipped_target_already_matched',
      'the journal write_outcome already released the intent, so the re-run must skip on the fresh readback');
    assert.equal(resultC2.results[0].before.totalUsableInventory, 15);
    assert.equal(mockC.getChangeInventoryPosts(), 1, 'an idempotent re-run must never POST again');
  } finally {
    mockC.server.close();
    await cleanupLock();
  }

  // ---------------------------------------------------------------------
  // Scenario 4: explicit platform rejection -> write_outcome(rejected),
  // intentId released, and the next run may legitimately re-attempt (the
  // durable lock is what forbids duplicate submission; a definitive rejection
  // releases it by design, see readPendingInventoryIntents).
  // ---------------------------------------------------------------------
  const dirR = path.join(temp, 'rejected');
  await fs.mkdir(dirR);
  const {plan: planR} = await buildPlanFixture(dirR, {etProducts: [etRow]});
  const mockR = createMockOpenApiServer({
    onChangeInventory: ({res, json}) => json({code: '400', msg: 'rejected by platform', info: {success: false}}),
  });
  mockR.url = await new Promise(resolve => mockR.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${mockR.server.address().port}`)));
  await fs.writeFile(path.join(dirR, 'config.json'), JSON.stringify({
    stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
    apiBaseUrls: {prodSemiManaged: mockR.url},
  }), 'utf8');
  const outR = path.join(dirR, 'result.json');
  const argsR = [
    '--plan', path.join(dirR, 'plan.json'),
    '--policy', path.join(dirR, 'policy.json'),
    '--config', path.join(dirR, 'config.json'),
    '--bi-data', path.join(dirR, 'bi.json'),
    '--links-data', path.join(dirR, 'links.json'),
    '--out', outR,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', planR.payloadHash,
  ];
  const envR = {
    SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: AUTOMATION_CONTEXT,
    SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: AUTOMATION_AUTHORIZATION,
  };
  try {
    const runR = await runExecutor(argsR, envR);
    assert.equal(runR.code, 1, `rejected write must exit blocked, stderr=${runR.stderr}`);
    const resultR = JSON.parse(await fs.readFile(outR, 'utf8'));
    assert.equal(resultR.results[0].state, 'blocked');
    assert.match(resultR.results[0].error, /inventory write failed: 400 rejected by platform/);
    assert.equal(mockR.getChangeInventoryPosts(), 1, 'exactly one rejected POST');
    const journalR = await fs.readFile(`${outR}.journal.ndjson`, 'utf8');
    const entriesR = journalR.split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const intentR = entriesR.find(entry => entry.kind === 'intent');
    const outcomeR = entriesR.filter(entry => entry.kind === 'write_outcome');
    assert.equal(outcomeR.length, 1, 'a definitive rejection must journal write_outcome(rejected)');
    assert.equal(outcomeR[0].disposition, 'rejected');
    assert.equal(outcomeR[0].intentId, intentR.intentId, 'the write_outcome must reference the released intentId');

    // The released intent lets the next run retry the same logical action
    // with a fresh intent; the platform accepts this time.
    mockR.setChangeInventoryHandler(({res, json, setCurrent}) => {
      setCurrent(15);
      json({code: '0', msg: 'ok', traceId: 'trace-r', info: {success: true}});
    });
    const runR2 = await runExecutor(argsR, envR);
    assert.equal(runR2.code, 0, `post-rejection retry must exit clean, stderr=${runR2.stderr}`);
    const resultR2 = JSON.parse(await fs.readFile(outR, 'utf8'));
    assert.equal(resultR2.results[0].state, 'updated_readback_matched');
    assert.equal(mockR.getChangeInventoryPosts(), 2, 'release-on-rejection allows exactly one clean retry POST');
    const entriesR2 = (await fs.readFile(`${outR}.journal.ndjson`, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(entriesR2.filter(entry => entry.kind === 'write_outcome' && entry.disposition === 'rejected').length, 1);
    assert.equal(entriesR2.filter(entry => entry.kind === 'write_outcome' && entry.disposition === 'readback_matched').length, 1);
  } finally {
    mockR.server.close();
    await cleanupLock();
  }

  // ---------------------------------------------------------------------
  // Scenario 5: ambiguous response (explicit code=0 but no info.success) ->
  // intent retained, re-run is readback-only, POST stays exactly 1.
  // ---------------------------------------------------------------------
  const dirAm = path.join(temp, 'ambiguous');
  await fs.mkdir(dirAm);
  const {plan: planAm} = await buildPlanFixture(dirAm, {etProducts: [etRow]});
  const mockAm = createMockOpenApiServer({
    onChangeInventory: ({res, json}) => json({code: '0'}),
  });
  mockAm.url = await new Promise(resolve => mockAm.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${mockAm.server.address().port}`)));
  await fs.writeFile(path.join(dirAm, 'config.json'), JSON.stringify({
    stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
    apiBaseUrls: {prodSemiManaged: mockAm.url},
  }), 'utf8');
  const outAm = path.join(dirAm, 'result.json');
  const argsAm = [
    '--plan', path.join(dirAm, 'plan.json'),
    '--policy', path.join(dirAm, 'policy.json'),
    '--config', path.join(dirAm, 'config.json'),
    '--bi-data', path.join(dirAm, 'bi.json'),
    '--links-data', path.join(dirAm, 'links.json'),
    '--out', outAm,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', planAm.payloadHash,
  ];
  const envAm = {
    SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: AUTOMATION_CONTEXT,
    SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: AUTOMATION_AUTHORIZATION,
  };
  try {
    const runAm = await runExecutor(argsAm, envAm);
    assert.equal(runAm.code, 1, `ambiguous response must exit blocked, stderr=${runAm.stderr}`);
    const resultAm = JSON.parse(await fs.readFile(outAm, 'utf8'));
    assert.equal(resultAm.results[0].state, 'needs_manual_resolve');
    assert.match(resultAm.results[0].error, /did not contain explicit code=0 and info\.success=true; durable intent retained and duplicate submission forbidden/);
    assert.equal(mockAm.getChangeInventoryPosts(), 1);
    const entriesAm = (await fs.readFile(`${outAm}.journal.ndjson`, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(entriesAm.filter(entry => entry.kind === 'intent').length, 1, 'ambiguous response must retain the intent');
    assert.equal(entriesAm.filter(entry => entry.kind === 'write_outcome').length, 0);

    const runAm2 = await runExecutor(argsAm, envAm);
    assert.equal(runAm2.code, 1, `ambiguous recovery re-run stays pending, stderr=${runAm2.stderr}`);
    const resultAm2 = JSON.parse(await fs.readFile(outAm, 'utf8'));
    assert.equal(resultAm2.results[0].state, 'submitted_but_readback_pending');
    assert.match(resultAm2.results[0].error, /durable pre-submit intent exists and exact target is not visible/);
    assert.equal(mockAm.getChangeInventoryPosts(), 1, 'ambiguous recovery must never POST again');
  } finally {
    mockAm.server.close();
    await cleanupLock();
  }

  // ---------------------------------------------------------------------
  // Scenario 6a: accepted response but ten readbacks never match -> intent
  // retained; re-run is readback-only, POST stays exactly 1.
  // ---------------------------------------------------------------------
  const dirP = path.join(temp, 'readback-pending');
  await fs.mkdir(dirP);
  const {plan: planP} = await buildPlanFixture(dirP, {etProducts: [etRow]});
  const mockP = createMockOpenApiServer({
    onChangeInventory: ({res, json}) => json({code: '0', msg: 'ok', info: {success: true}}),
  });
  mockP.url = await new Promise(resolve => mockP.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${mockP.server.address().port}`)));
  await fs.writeFile(path.join(dirP, 'config.json'), JSON.stringify({
    stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
    apiBaseUrls: {prodSemiManaged: mockP.url},
  }), 'utf8');
  const outP = path.join(dirP, 'result.json');
  const argsP = [
    '--plan', path.join(dirP, 'plan.json'),
    '--policy', path.join(dirP, 'policy.json'),
    '--config', path.join(dirP, 'config.json'),
    '--bi-data', path.join(dirP, 'bi.json'),
    '--links-data', path.join(dirP, 'links.json'),
    '--out', outP,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', planP.payloadHash,
  ];
  const envP = {
    SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: AUTOMATION_CONTEXT,
    SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: AUTOMATION_AUTHORIZATION,
  };
  try {
    const runP = await runExecutor(argsP, envP);
    assert.equal(runP.code, 1, `ten unmatched readbacks must exit blocked, stderr=${runP.stderr}`);
    const resultP = JSON.parse(await fs.readFile(outP, 'utf8'));
    assert.equal(resultP.results[0].state, 'submitted_but_readback_pending');
    assert.match(resultP.results[0].error, /readback usable inventory 10 does not match target 15; duplicate submission forbidden/);
    assert.equal(mockP.getChangeInventoryPosts(), 1);
    assert.equal(mockP.counts.stockQuery, 11, 'one before-read plus ten bounded readbacks');
    const entriesP = (await fs.readFile(`${outP}.journal.ndjson`, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(entriesP.filter(entry => entry.kind === 'intent').length, 1, 'pending readback must retain the intent');
    assert.equal(entriesP.filter(entry => entry.kind === 'write_outcome').length, 0);

    const runP2 = await runExecutor(argsP, envP);
    assert.equal(runP2.code, 1, `pending-readback re-run stays pending, stderr=${runP2.stderr}`);
    const resultP2 = JSON.parse(await fs.readFile(outP, 'utf8'));
    assert.equal(resultP2.results[0].state, 'submitted_but_readback_pending');
    assert.match(resultP2.results[0].error, /durable pre-submit intent exists and exact target is not visible/);
    assert.equal(mockP.getChangeInventoryPosts(), 1, 'pending-readback re-run must never POST again');
    assert.equal(mockP.counts.stockQuery, 12, 'the re-run only performs the fresh before-read');
  } finally {
    mockP.server.close();
    await cleanupLock();
  }

  // ---------------------------------------------------------------------
  // Scenario 6b: accepted response but the first readback throws -> durable
  // error, intent retained; re-run is readback-only, POST stays exactly 1.
  // ---------------------------------------------------------------------
  const dirT = path.join(temp, 'readback-throw');
  await fs.mkdir(dirT);
  const {plan: planT} = await buildPlanFixture(dirT, {etProducts: [etRow]});
  const mockT = createMockOpenApiServer({
    onChangeInventory: ({res, json}) => {
      json({code: '0', msg: 'ok', info: {success: true}});
      mockT.destroyNextStockQuery();
    },
  });
  mockT.url = await new Promise(resolve => mockT.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${mockT.server.address().port}`)));
  await fs.writeFile(path.join(dirT, 'config.json'), JSON.stringify({
    stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
    apiBaseUrls: {prodSemiManaged: mockT.url},
  }), 'utf8');
  const outT = path.join(dirT, 'result.json');
  const argsT = [
    '--plan', path.join(dirT, 'plan.json'),
    '--policy', path.join(dirT, 'policy.json'),
    '--config', path.join(dirT, 'config.json'),
    '--bi-data', path.join(dirT, 'bi.json'),
    '--links-data', path.join(dirT, 'links.json'),
    '--out', outT,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', planT.payloadHash,
  ];
  const envT = {
    SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: AUTOMATION_CONTEXT,
    SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: AUTOMATION_AUTHORIZATION,
  };
  try {
    const runT = await runExecutor(argsT, envT);
    assert.equal(runT.code, 1, `readback throw must exit blocked, stderr=${runT.stderr}`);
    const resultT = JSON.parse(await fs.readFile(outT, 'utf8'));
    assert.equal(resultT.results[0].state, 'suspicious_write_attempted');
    assert.match(resultT.results[0].error, /write intent is durable and automatic resubmission is forbidden/);
    assert.equal(mockT.getChangeInventoryPosts(), 1);
    const entriesT = (await fs.readFile(`${outT}.journal.ndjson`, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(entriesT.filter(entry => entry.kind === 'intent').length, 1, 'readback throw must retain the durable intent');
    assert.equal(entriesT.filter(entry => entry.kind === 'write_outcome').length, 0);

    const runT2 = await runExecutor(argsT, envT);
    assert.equal(runT2.code, 1, `readback-throw re-run stays pending, stderr=${runT2.stderr}`);
    const resultT2 = JSON.parse(await fs.readFile(outT, 'utf8'));
    assert.equal(resultT2.results[0].state, 'submitted_but_readback_pending');
    assert.match(resultT2.results[0].error, /durable pre-submit intent exists and exact target is not visible/);
    assert.equal(mockT.getChangeInventoryPosts(), 1, 'readback-throw re-run must never POST again');
  } finally {
    mockT.server.close();
    await cleanupLock();
  }

  // ---------------------------------------------------------------------
  // Scenario 7: torn journal tail and mid-file corruption must fail closed
  // before any OpenAPI client is created or any request is sent.
  // ---------------------------------------------------------------------
  const dirJ = path.join(temp, 'journal-corrupt');
  await fs.mkdir(dirJ);
  const {plan: planJ} = await buildPlanFixture(dirJ, {etProducts: [etRow]});
  const mockJ = createMockOpenApiServer({
    onChangeInventory: ({res, json}) => json({code: '0', msg: 'ok', info: {success: true}}),
  });
  mockJ.url = await new Promise(resolve => mockJ.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${mockJ.server.address().port}`)));
  await fs.writeFile(path.join(dirJ, 'config.json'), JSON.stringify({
    stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
    apiBaseUrls: {prodSemiManaged: mockJ.url},
  }), 'utf8');
  const outJ = path.join(dirJ, 'result.json');
  const journalJ = `${outJ}.journal.ndjson`;
  const argsJ = [
    '--plan', path.join(dirJ, 'plan.json'),
    '--policy', path.join(dirJ, 'policy.json'),
    '--config', path.join(dirJ, 'config.json'),
    '--bi-data', path.join(dirJ, 'bi.json'),
    '--links-data', path.join(dirJ, 'links.json'),
    '--out', outJ,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', planJ.payloadHash,
  ];
  const envJ = {
    SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: AUTOMATION_CONTEXT,
    SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: AUTOMATION_AUTHORIZATION,
  };
  try {
    const journalTarget = 10;
    const journalBefore = {
      skuCode: SKU_CODE,
      totalInventoryQuantity: 10,
      totalUsableInventory: 10,
      totalLockedQuantity: 0,
      stockRowMissing: false,
      warehouseCodes: [],
    };
    const journalLogicalActionKey = stableInventoryHash({
      runDate: TODAY,
      store: STORE_KEY,
      skc: SKC,
      sku: SKU_CODE,
      target: journalTarget,
      actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
      policyVersion: planJ.policyVersion,
      authorizationId: AUTOMATION_AUTHORIZATION,
    });
    const journalRequest = {
      pathname: '/open-api/stock/change-inventory/v2',
      method: 'POST',
      body: {updateSkuInventoryQuantityRequests: [{
        idempotencyKey: `bi-inv-${journalLogicalActionKey.slice(0, 42)}`,
        skuCode: SKU_CODE,
        invType: 'VI',
        changeType: 'OVERWRITE',
        changeQuantity: computeInventoryOverwriteQuantity(journalTarget, journalBefore),
        changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
      }]},
      headers: {language: 'en'},
    };
    const validJournalIntent = {
      kind: 'intent',
      intentId: 'i-1',
      logicalActionKey: journalLogicalActionKey,
      planHash: planJ.payloadHash,
      runDate: TODAY,
      storeKey: STORE_KEY,
      skc: SKC,
      skuCode: SKU_CODE,
      targetUsableInventory: journalTarget,
      policyVersion: planJ.policyVersion,
      authorizationId: AUTOMATION_AUTHORIZATION,
      idempotencyKey: journalRequest.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
      requestPayloadHash: stableInventoryHash(journalRequest),
      request: journalRequest,
      before: journalBefore,
    };
    await fs.writeFile(journalJ, `${JSON.stringify(validJournalIntent)}\n{torn`, 'utf8');
    const tornRun = await runExecutor(argsJ, envJ);
    assert.notEqual(tornRun.code, 0, `torn tail must fail closed, stderr=${tornRun.stderr}`);
    assert.match(tornRun.stderr, /INVENTORY_JOURNAL_TORN_TAIL/);
    assert.equal(Object.values(mockJ.counts).reduce((sum, value) => sum + value, 0), 0,
      'a torn journal tail must abort before any OpenAPI request');

    await fs.writeFile(journalJ, `${JSON.stringify(validJournalIntent)}\n{oops\n`, 'utf8');
    const corruptRun = await runExecutor(argsJ, envJ);
    assert.notEqual(corruptRun.code, 0, `mid-file corruption must fail closed, stderr=${corruptRun.stderr}`);
    assert.match(corruptRun.stderr, /INVENTORY_JOURNAL_INVALID_LINE:2/);
    assert.equal(Object.values(mockJ.counts).reduce((sum, value) => sum + value, 0), 0,
      'mid-file corruption must abort before any OpenAPI request');
  } finally {
    mockJ.server.close();
    await cleanupLock();
  }

  console.log(JSON.stringify({
    ok: true,
    scenarios: [
      'pre_durable_error_records_blocked_without_reference_error',
      'durable_transport_error_records_suspicious_write_attempted',
      'durable_intent_recovery_is_readback_only_no_second_post',
      'successful_write_readback_matched_one_post',
      'idempotent_rerun_skips_on_fresh_readback_no_second_post',
      'definitive_rejection_journals_write_outcome_rejected_and_releases_intent',
      'ambiguous_response_retains_intent_rerun_readback_only',
      'ten_readbacks_pending_retains_intent_rerun_readback_only',
      'readback_throw_retains_intent_rerun_readback_only',
      'torn_and_corrupt_journal_fail_closed_before_any_request',
    ],
  }, null, 2));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
