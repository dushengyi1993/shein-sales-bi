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
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

import {
  buildDailyInventoryPlanHashPayload,
  computeInventoryOverwriteQuantity,
  INVENTORY_OVERWRITE_COMPUTATION_VERSION,
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
const dateDaysBefore = (date, days) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
};
const YESTERDAY = dateDaysBefore(TODAY, 1);
const TWO_DAYS_AGO = dateDaysBefore(TODAY, 2);
const fileHash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

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

function createMockOpenApiServer({onChangeInventory, onQueryStoreInfo, onStockQuery} = {}) {
  let currentUsable = 10;
  const counts = {queryStoreInfo: 0, spuInfo: 0, stockQuery: 0, changeInventory: 0};
  let changeHandler = onChangeInventory || (() => {});
  let stockQueryHandler = onStockQuery || null;
  let destroyNextStockQuery = false;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const json = value => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value));
    };
    if (pathname === '/open-api/openapi-business-backend/query-store-info') {
      counts.queryStoreInfo += 1;
      if (onQueryStoreInfo) {
        Promise.resolve(onQueryStoreInfo({res, json})).catch(error => {
          if (!res.headersSent) {
            res.statusCode = 500;
            json({code: '500', msg: error.message});
          } else {
            res.destroy(error);
          }
        });
        return;
      }
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
      if (stockQueryHandler) {
        Promise.resolve(stockQueryHandler({res, json, currentUsable})).catch(error => {
          if (!res.headersSent) {
            res.statusCode = 500;
            json({code: '500', msg: error.message});
          } else {
            res.destroy(error);
          }
        });
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
    setStockQueryHandler: handler => { stockQueryHandler = handler; },
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
    {store: 'ET', file: path.join(dir, 'source-et.json'), fetchedAt: nowIso},
    {store: 'BI_LINKS', file: path.join(dir, 'source-links.json'), fetchedAt: nowIso},
  ];
  await fs.writeFile(path.join(dir, 'source-et.json'), JSON.stringify({source: 'et'}), 'utf8');
  const sourceLinksFile = path.join(dir, 'source-links.json');
  await fs.writeFile(sourceLinksFile, JSON.stringify({source: 'links', generation: 1}), 'utf8');
  sourceEvidence[1].sha256 = await fileHash(sourceLinksFile);
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

function buildJournalIntent({
  plan,
  runDate = plan.date,
  targetUsableInventory = 15,
  beforeUsableInventory = 10,
  recordedAt = new Date().toISOString(),
  intentId = `intent-${crypto.randomUUID()}`,
  authorizationId = AUTOMATION_AUTHORIZATION,
} = {}) {
  const before = {
    skuCode: SKU_CODE,
    totalInventoryQuantity: beforeUsableInventory,
    totalUsableInventory: beforeUsableInventory,
    totalLockedQuantity: 0,
    stockRowMissing: false,
    warehouseCodes: [],
  };
  const logicalActionKey = stableInventoryHash({
    runDate,
    store: STORE_KEY,
    skc: SKC,
    sku: SKU_CODE,
    target: targetUsableInventory,
    actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
    policyVersion: plan.policyVersion,
    authorizationId,
  });
  const request = {
    pathname: '/open-api/stock/change-inventory/v2',
    method: 'POST',
    body: {updateSkuInventoryQuantityRequests: [{
      idempotencyKey: `bi-inv-${logicalActionKey.slice(0, 42)}`,
      skuCode: SKU_CODE,
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
    recoveryScopeKey: stableInventoryHash({
      store: STORE_KEY,
      skc: SKC,
      sku: SKU_CODE,
      actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
      invType: 'VI',
    }),
    planHash: plan.payloadHash,
    runDate,
    storeKey: STORE_KEY,
    skc: SKC,
    skuCode: SKU_CODE,
    targetUsableInventory,
    policyVersion: plan.policyVersion,
    overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION,
    authorizationId,
    idempotencyKey: request.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
    requestPayloadHash: stableInventoryHash(request),
    request,
    before,
    recordedAt,
  };
}

function buildReadbackMatchedOutcome(intent, recordedAt = new Date().toISOString()) {
  return {
    kind: 'write_outcome',
    intentId: intent.intentId,
    logicalActionKey: intent.logicalActionKey,
    disposition: 'readback_matched',
    recordedAt,
  };
}

async function readJournalEntries(file) {
  return (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

async function writeHardLinkedHistoricalIntent({
  dir,
  out,
  plan,
  runDate = YESTERDAY,
  targetUsableInventory = 15,
  intentId,
} = {}) {
  const historicalJournal = path.join(
    dir,
    `daily-inventory-replenishment-${runDate}.json.journal.ndjson`,
  );
  const currentJournal = `${out}.journal.ndjson`;
  const intent = buildJournalIntent({plan, runDate, targetUsableInventory, intentId});
  await fs.writeFile(historicalJournal, `${JSON.stringify(intent)}\n`, 'utf8');
  await fs.link(historicalJournal, currentJournal);
  const [historicalStat, currentStat] = await Promise.all([
    fs.stat(historicalJournal, {bigint: true}),
    fs.stat(currentJournal, {bigint: true}),
  ]);
  assert.equal(currentStat.dev, historicalStat.dev, 'hard-link fixture must share the same device');
  assert.equal(currentStat.ino, historicalStat.ino, 'hard-link fixture must share the same inode');
  return {historicalJournal, currentJournal, intent};
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
    assert.equal(intentRows[0].overwriteComputationVersion, INVENTORY_OVERWRITE_COMPUTATION_VERSION, 'new executor intents carry the explicit overwrite computation version');
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
  // Scenario 3: successful write + exact stock readback ->
  // updated_readback_matched, and re-run/source-drift behavior stays bounded.
  // ---------------------------------------------------------------------
  const dirC = path.join(temp, 'c');
  await fs.mkdir(dirC);
  const {plan: planC} = await buildPlanFixture(dirC, {etProducts: [etRow]});
  const scenarioCStringReadbacks = [];
  const mockC = createMockOpenApiServer({
    onStockQuery: ({json, currentUsable}) => {
      const totalUsableInventory = String(currentUsable);
      scenarioCStringReadbacks.push(totalUsableInventory);
      json({
        code: '0',
        info: [{
          goodsInventory: [{
            skuList: [{
              skuCode: SKU_CODE,
              totalInventoryQuantity: String(currentUsable),
              totalUsableInventory,
              totalLockedQuantity: '0',
              warehouseInventoryList: [],
            }],
          }],
        }],
      });
    },
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
    assert.ok(scenarioCStringReadbacks.includes('15'), 'multi-digit integer string readback "15" must parse and allow readback_matched');
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
      'exact readback must release the durable intent in the journal',
    );

    await fs.writeFile(path.join(dirC, 'source-links.json'), JSON.stringify({source: 'links', generation: 2}), 'utf8');
    const runC2 = await runExecutor(argsC, envC);
    assert.notEqual(runC2.code, 0, `normal re-run must fail closed on source evidence drift, stderr=${runC2.stderr}`);
    assert.match(runC2.stderr, /Plan source evidence file hash drifted: BI_LINKS/);
    assert.equal(mockC.getChangeInventoryPosts(), 1, 'normal source drift failure must happen before any second POST');

    const runC3 = await runExecutor([...argsC, '--reconcile-pending-only'], envC);
    assert.equal(runC3.code, 0, `reconcile-only terminal recovery must ignore external source file drift, stderr=${runC3.stderr}`);
    const resultC2 = JSON.parse(await fs.readFile(outC, 'utf8'));
    assert.equal(resultC2.reconcilePendingOnly, true);
    assert.equal(resultC2.results[0].state, 'skipped_terminal_readback_recorded',
      'reconcile-only must use the terminal journal instead of creating any new write intent');
    assert.equal(resultC2.results[0].logicalActionKey, resultC.results[0].logicalActionKey,
      'reconcile-only terminal result must preserve the original intent logicalActionKey');
    assert.equal(resultC2.results[0].before.totalUsableInventory, 15);
    assert.equal(resultC2.results[0].after, undefined);
    assert.equal(mockC.getChangeInventoryPosts(), 1, 'reconcile-only terminal recovery must never POST again');
  } finally {
    mockC.server.close();
    await cleanupLock();
  }

  // ---------------------------------------------------------------------
  // Scenario 3b: discovery prefers the current path when a historical
  // journal is hard-linked as the current sidecar. Classification must use
  // intent.runDate, reach lock-held row-level readback, keep the unmatched
  // historical target pending, and never POST or create another intent.
  // ---------------------------------------------------------------------
  const dirH = path.join(temp, 'historical-pending-reconcile-only');
  await fs.mkdir(dirH);
  const {plan: planH} = await buildPlanFixture(dirH, {etProducts: [etRow]});
  const mockH = createMockOpenApiServer({});
  mockH.url = await new Promise(resolve => mockH.server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + mockH.server.address().port)));
  await fs.writeFile(path.join(dirH, 'config.json'), JSON.stringify({
    stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
    apiBaseUrls: {prodSemiManaged: mockH.url},
  }), 'utf8');
  const outH = path.join(dirH, 'result.json');
  const argsH = [
    '--plan', path.join(dirH, 'plan.json'),
    '--policy', path.join(dirH, 'policy.json'),
    '--config', path.join(dirH, 'config.json'),
    '--bi-data', path.join(dirH, 'bi.json'),
    '--links-data', path.join(dirH, 'links.json'),
    '--out', outH,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', planH.payloadHash,
    '--reconcile-pending-only',
  ];
  const envH = {
    SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: AUTOMATION_CONTEXT,
    SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: AUTOMATION_AUTHORIZATION,
  };
  try {
    const historicalRunDate = YESTERDAY;
    const {historicalJournal, intent: historicalIntent} = await writeHardLinkedHistoricalIntent({
      dir: dirH,
      out: outH,
      plan: planH,
      runDate: historicalRunDate,
      targetUsableInventory: 15,
      intentId: 'historical-intent-1',
    });
    const runH = await runExecutor(argsH, envH);
    assert.equal(runH.code, 1, 'historical pending reconcile-only must publish a pending row, stderr=' + runH.stderr);
    assert.doesNotMatch(runH.stderr, /INVENTORY_RECONCILE_PENDING_ONLY_PRECONDITION_FAILED/,
      'historical pending must not be rejected by the batch precondition');
    const resultH = JSON.parse(await fs.readFile(outH, 'utf8'));
    assert.equal(resultH.results[0].state, 'submitted_but_readback_pending');
    assert.equal(resultH.results[0].historicalPending, true);
    assert.equal(resultH.results[0].historicalRunDate, historicalRunDate);
    assert.match(resultH.results[0].error, /historical durable inventory intent remains pending/);
    assert.equal(mockH.getChangeInventoryPosts(), 0, 'historical reconcile-only must never POST');
    const entriesH = await readJournalEntries(historicalJournal);
    assert.deepEqual(
      entriesH.filter(entry => entry.kind === 'intent').map(entry => entry.intentId),
      [historicalIntent.intentId],
      'hard-linked historical recovery must retain only the original intent',
    );
  } finally {
    mockH.server.close();
    await cleanupLock();
  }

  // ---------------------------------------------------------------------
  // Scenario 3bb: when fresh live stock exactly matches the historical
  // target, reconcile-only closes only that original intent with one
  // readback_matched outcome. It never creates a current-day intent or POST.
  // ---------------------------------------------------------------------
  const dirHM = path.join(temp, 'historical-hard-link-readback-matched');
  await fs.mkdir(dirHM);
  const {plan: planHM} = await buildPlanFixture(dirHM, {etProducts: [etRow]});
  const mockHM = createMockOpenApiServer({});
  mockHM.url = await new Promise(resolve => mockHM.server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + mockHM.server.address().port)));
  await fs.writeFile(path.join(dirHM, 'config.json'), JSON.stringify({
    stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
    apiBaseUrls: {prodSemiManaged: mockHM.url},
  }), 'utf8');
  const outHM = path.join(dirHM, 'result.json');
  try {
    const {historicalJournal, intent} = await writeHardLinkedHistoricalIntent({
      dir: dirHM,
      out: outHM,
      plan: planHM,
      runDate: YESTERDAY,
      targetUsableInventory: 10,
      intentId: 'historical-matched-intent-1',
    });
    const runHM = await runExecutor([
      '--plan', path.join(dirHM, 'plan.json'),
      '--policy', path.join(dirHM, 'policy.json'),
      '--config', path.join(dirHM, 'config.json'),
      '--bi-data', path.join(dirHM, 'bi.json'),
      '--links-data', path.join(dirHM, 'links.json'),
      '--out', outHM,
      '--execute',
      '--execution-mode', 'automatic',
      '--confirm-hash', planHM.payloadHash,
      '--reconcile-pending-only',
    ], envH);
    assert.equal(runHM.code, 1, 'historical matched target remains a deferred corrective row, stderr=' + runHM.stderr);
    assert.doesNotMatch(runHM.stderr, /INVENTORY_RECONCILE_PENDING_ONLY_PRECONDITION_FAILED/);
    const resultHM = JSON.parse(await fs.readFile(outHM, 'utf8'));
    assert.equal(resultHM.results[0].state, 'historical_readback_matched');
    assert.equal(resultHM.results[0].historicalIntentId, intent.intentId);
    assert.equal(mockHM.getChangeInventoryPosts(), 0, 'historical matched recovery must never POST');
    const entriesHM = await readJournalEntries(historicalJournal);
    assert.deepEqual(
      entriesHM.filter(entry => entry.kind === 'intent').map(entry => entry.intentId),
      [intent.intentId],
      'historical matched recovery must not generate a new intent',
    );
    const outcomesHM = entriesHM.filter(entry => entry.kind === 'write_outcome');
    assert.equal(outcomesHM.length, 1, 'historical matched recovery appends exactly one lifecycle outcome');
    assert.equal(outcomesHM[0].intentId, intent.intentId);
    assert.equal(outcomesHM[0].disposition, 'readback_matched');
  } finally {
    mockHM.server.close();
    await cleanupLock();
  }

  // ---------------------------------------------------------------------
  // Scenario 3bc: another actor may close the historical intent after the
  // batch snapshot but before the SKU ticket. The lock-held fresh reread
  // must observe that closure, avoid stale pending handling, and never POST.
  // ---------------------------------------------------------------------
  const dirHR = path.join(temp, 'historical-close-after-precondition');
  await fs.mkdir(dirHR);
  const {plan: planHR} = await buildPlanFixture(dirHR, {etProducts: [etRow]});
  const outHR = path.join(dirHR, 'result.json');
  let closeHistoricalIntent;
  const mockHR = createMockOpenApiServer({
    onQueryStoreInfo: async ({json}) => {
      await fs.appendFile(
        closeHistoricalIntent.historicalJournal,
        `${JSON.stringify(buildReadbackMatchedOutcome(closeHistoricalIntent.intent))}\n`,
        'utf8',
      );
      json({code: '0', data: {accountNo: 'GS5337922', supplierId: '6720288'}});
    },
  });
  mockHR.url = await new Promise(resolve => mockHR.server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + mockHR.server.address().port)));
  await fs.writeFile(path.join(dirHR, 'config.json'), JSON.stringify({
    stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
    apiBaseUrls: {prodSemiManaged: mockHR.url},
  }), 'utf8');
  try {
    closeHistoricalIntent = await writeHardLinkedHistoricalIntent({
      dir: dirHR,
      out: outHR,
      plan: planHR,
      runDate: TWO_DAYS_AGO,
      targetUsableInventory: 15,
      intentId: 'historical-race-intent-1',
    });
    const runHR = await runExecutor([
      '--plan', path.join(dirHR, 'plan.json'),
      '--policy', path.join(dirHR, 'policy.json'),
      '--config', path.join(dirHR, 'config.json'),
      '--bi-data', path.join(dirHR, 'bi.json'),
      '--links-data', path.join(dirHR, 'links.json'),
      '--out', outHR,
      '--execute',
      '--execution-mode', 'automatic',
      '--confirm-hash', planHR.payloadHash,
      '--reconcile-pending-only',
    ], envH);
    assert.equal(runHR.code, 1, 'fresh reread of a newly closed historical intent must fail closed per row');
    assert.doesNotMatch(runHR.stderr, /INVENTORY_RECONCILE_PENDING_ONLY_PRECONDITION_FAILED/);
    const resultHR = JSON.parse(await fs.readFile(outHR, 'utf8'));
    assert.equal(resultHR.results[0].state, 'blocked');
    assert.match(resultHR.results[0].error, /INVENTORY_RECONCILE_PENDING_ONLY_LIFECYCLE_AMBIGUOUS/);
    assert.equal(mockHR.getChangeInventoryPosts(), 0, 'fresh reread race closure must never POST');
    const entriesHR = await readJournalEntries(closeHistoricalIntent.historicalJournal);
    assert.deepEqual(
      entriesHR.filter(entry => entry.kind === 'intent').map(entry => entry.intentId),
      [closeHistoricalIntent.intent.intentId],
      'fresh reread race closure must not create a new intent',
    );
    assert.equal(entriesHR.filter(entry => entry.kind === 'write_outcome').length, 1,
      'fresh reread must observe the one externally appended terminal outcome');
  } finally {
    mockHR.server.close();
    await cleanupLock();
  }

  // ---------------------------------------------------------------------
  // Scenario 3c: current-plan same-scope intent drift still fails closed at
  // the reconcile-pending-only precondition; historical tolerance cannot
  // bless a current exact intent mismatch.
  // ---------------------------------------------------------------------
  const dirM = path.join(temp, 'current-intent-mismatch-reconcile-only');
  await fs.mkdir(dirM);
  const {plan: planM} = await buildPlanFixture(dirM, {etProducts: [etRow]});
  const mockM = createMockOpenApiServer({});
  mockM.url = await new Promise(resolve => mockM.server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + mockM.server.address().port)));
  await fs.writeFile(path.join(dirM, 'config.json'), JSON.stringify({
    stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
    apiBaseUrls: {prodSemiManaged: mockM.url},
  }), 'utf8');
  const outM = path.join(dirM, 'result.json');
  const argsM = [
    '--plan', path.join(dirM, 'plan.json'),
    '--policy', path.join(dirM, 'policy.json'),
    '--config', path.join(dirM, 'config.json'),
    '--bi-data', path.join(dirM, 'bi.json'),
    '--links-data', path.join(dirM, 'links.json'),
    '--out', outM,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', planM.payloadHash,
    '--reconcile-pending-only',
  ];
  try {
    await fs.writeFile(outM + '.journal.ndjson', JSON.stringify(buildJournalIntent({
      plan: planM,
      runDate: TODAY,
      targetUsableInventory: 14,
      intentId: 'current-mismatch-intent-1',
    })) + '\n', 'utf8');
    const runM = await runExecutor(argsM, envH);
    assert.notEqual(runM.code, 0, 'current exact intent mismatch must fail closed');
    assert.match(runM.stderr, /INVENTORY_RECONCILE_PENDING_ONLY_PRECONDITION_FAILED/);
    assert.match(runM.stderr, /scope_count=1/);
    assert.equal(mockM.getChangeInventoryPosts(), 0, 'current mismatch precondition must never POST');
  } finally {
    mockM.server.close();
    await cleanupLock();
  }

  // ---------------------------------------------------------------------
  // Scenario 3d: a reconcile-only row with neither a current intent nor a
  // historical pending intent remains a batch precondition failure.
  // ---------------------------------------------------------------------
  const dirN = path.join(temp, 'no-intent-reconcile-only');
  await fs.mkdir(dirN);
  const {plan: planN} = await buildPlanFixture(dirN, {etProducts: [etRow]});
  const mockN = createMockOpenApiServer({});
  mockN.url = await new Promise(resolve => mockN.server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + mockN.server.address().port)));
  await fs.writeFile(path.join(dirN, 'config.json'), JSON.stringify({
    stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
    apiBaseUrls: {prodSemiManaged: mockN.url},
  }), 'utf8');
  const outN = path.join(dirN, 'result.json');
  try {
    const runN = await runExecutor([
      '--plan', path.join(dirN, 'plan.json'),
      '--policy', path.join(dirN, 'policy.json'),
      '--config', path.join(dirN, 'config.json'),
      '--bi-data', path.join(dirN, 'bi.json'),
      '--links-data', path.join(dirN, 'links.json'),
      '--out', outN,
      '--execute',
      '--execution-mode', 'automatic',
      '--confirm-hash', planN.payloadHash,
      '--reconcile-pending-only',
    ], envH);
    assert.notEqual(runN.code, 0, 'missing current and historical intent must fail closed');
    assert.match(runN.stderr, /INVENTORY_RECONCILE_PENDING_ONLY_PRECONDITION_FAILED/);
    assert.match(runN.stderr, /scope_matches=0:scope_count=0/);
    assert.equal(mockN.getChangeInventoryPosts(), 0, 'missing-intent precondition must never POST');
  } finally {
    mockN.server.close();
    await cleanupLock();
  }

  // ---------------------------------------------------------------------
  // Scenario 3e: multiple historical pending intents in the same scope stay
  // item-level needs_manual_resolve rather than aborting the whole batch.
  // ---------------------------------------------------------------------
  const dirMH = path.join(temp, 'multiple-historical-pending-reconcile-only');
  await fs.mkdir(dirMH);
  const {plan: planMH} = await buildPlanFixture(dirMH, {etProducts: [etRow]});
  const mockMH = createMockOpenApiServer({});
  mockMH.url = await new Promise(resolve => mockMH.server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + mockMH.server.address().port)));
  await fs.writeFile(path.join(dirMH, 'config.json'), JSON.stringify({
    stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
    apiBaseUrls: {prodSemiManaged: mockMH.url},
  }), 'utf8');
  const outMH = path.join(dirMH, 'result.json');
  try {
    await fs.writeFile(
      path.join(dirMH, `daily-inventory-replenishment-${TWO_DAYS_AGO}.json.journal.ndjson`),
      JSON.stringify(buildJournalIntent({plan: planMH, runDate: TWO_DAYS_AGO, intentId: 'historical-intent-a'})) + '\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(dirMH, `daily-inventory-replenishment-${YESTERDAY}.json.journal.ndjson`),
      JSON.stringify(buildJournalIntent({plan: planMH, runDate: YESTERDAY, intentId: 'historical-intent-b'})) + '\n',
      'utf8',
    );
    const runMH = await runExecutor([
      '--plan', path.join(dirMH, 'plan.json'),
      '--policy', path.join(dirMH, 'policy.json'),
      '--config', path.join(dirMH, 'config.json'),
      '--bi-data', path.join(dirMH, 'bi.json'),
      '--links-data', path.join(dirMH, 'links.json'),
      '--out', outMH,
      '--execute',
      '--execution-mode', 'automatic',
      '--confirm-hash', planMH.payloadHash,
      '--reconcile-pending-only',
    ], envH);
    assert.equal(runMH.code, 1, 'multiple historical pending intents must publish needs_manual_resolve, stderr=' + runMH.stderr);
    assert.doesNotMatch(runMH.stderr, /INVENTORY_RECONCILE_PENDING_ONLY_PRECONDITION_FAILED/,
      'multiple historical pending intents must not become a batch precondition failure');
    const resultMH = JSON.parse(await fs.readFile(outMH, 'utf8'));
    assert.equal(resultMH.results[0].state, 'needs_manual_resolve');
    assert.match(resultMH.results[0].error, /multiple durable inventory intents exist in recovery scope/);
    assert.equal(mockMH.getChangeInventoryPosts(), 0, 'multiple historical pending reconcile-only must never POST');
  } finally {
    mockMH.server.close();
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
  // Scenario 5: HTTP 2xx code=0 without info.success -> readback is attempted;
  // an unmatched target retains the intent, re-run is readback-only, and POST
  // stays exactly 1.
  // ---------------------------------------------------------------------
  const dirAm = path.join(temp, 'code-zero-missing-success');
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
    assert.equal(runAm.code, 1, `unmatched code=0 readback must exit blocked, stderr=${runAm.stderr}`);
    const resultAm = JSON.parse(await fs.readFile(outAm, 'utf8'));
    assert.equal(resultAm.results[0].state, 'submitted_but_readback_pending');
    assert.match(resultAm.results[0].error, /readback usable inventory .* does not match target .*; duplicate submission forbidden/);
    assert.equal(mockAm.getChangeInventoryPosts(), 1);
    const entriesAm = (await fs.readFile(`${outAm}.journal.ndjson`, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(entriesAm.filter(entry => entry.kind === 'intent').length, 1, 'unmatched code=0 readback must retain the intent');
    assert.equal(entriesAm.filter(entry => entry.kind === 'write_outcome').length, 0);

    const runAm2 = await runExecutor(argsAm, envAm);
    assert.equal(runAm2.code, 1, `unmatched code=0 readback recovery re-run stays pending, stderr=${runAm2.stderr}`);
    const resultAm2 = JSON.parse(await fs.readFile(outAm, 'utf8'));
    assert.equal(resultAm2.results[0].state, 'submitted_but_readback_pending');
    assert.match(resultAm2.results[0].error, /durable pre-submit intent exists and exact target is not visible/);
    assert.equal(mockAm.getChangeInventoryPosts(), 1, 'unmatched code=0 readback recovery must never POST again');
  } finally {
    mockAm.server.close();
    await cleanupLock();
  }

  // ---------------------------------------------------------------------
  // Scenario 5b: both processes may take their startup journal snapshot
  // before either reaches the SKU ticket. The second process must refresh
  // the journal while holding that ticket and recover the first intent;
  // together they may issue only one inventory POST.
  // ---------------------------------------------------------------------
  const dirCon = path.join(temp, 'concurrent-stale-snapshot');
  await fs.mkdir(dirCon);
  const {plan: planCon} = await buildPlanFixture(dirCon, {etProducts: [etRow]});
  let mockCon;
  mockCon = createMockOpenApiServer({
    onChangeInventory: ({json}) => {
      const startedAt = Date.now();
      const finishWhenBothExecutorsStarted = () => {
        if (mockCon.counts.queryStoreInfo >= 2 || Date.now() - startedAt > 5000) {
          // Code=0 without info.success enters authoritative readback; the
          // mock leaves the target unmatched so the durable intent remains pending.
          json({code: '0'});
          return;
        }
        setTimeout(finishWhenBothExecutorsStarted, 10);
      };
      finishWhenBothExecutorsStarted();
    },
  });
  mockCon.url = await new Promise(resolve => mockCon.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${mockCon.server.address().port}`)));
  await fs.writeFile(path.join(dirCon, 'config.json'), JSON.stringify({
    stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
    apiBaseUrls: {prodSemiManaged: mockCon.url},
  }), 'utf8');
  const concurrentArgs = out => [
    '--plan', path.join(dirCon, 'plan.json'),
    '--policy', path.join(dirCon, 'policy.json'),
    '--config', path.join(dirCon, 'config.json'),
    '--bi-data', path.join(dirCon, 'bi.json'),
    '--links-data', path.join(dirCon, 'links.json'),
    '--out', out,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', planCon.payloadHash,
  ];
  const envCon = {
    SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: AUTOMATION_CONTEXT,
    SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: AUTOMATION_AUTHORIZATION,
  };
  const outConA = path.join(dirCon, 'result-a.json');
  const outConB = path.join(dirCon, 'result-b.json');
  try {
    const [runConA, runConB] = await Promise.all([
      runExecutor(concurrentArgs(outConA), envCon),
      runExecutor(concurrentArgs(outConB), envCon),
    ]);
    assert.equal(runConA.code, 1, `first concurrent executor must fail closed, stderr=${runConA.stderr}`);
    assert.equal(runConB.code, 1, `second concurrent executor must fail closed, stderr=${runConB.stderr}`);
    assert.equal(mockCon.getChangeInventoryPosts(), 1, 'two stale startup snapshots must still produce one inventory POST total');
    const resultsCon = await Promise.all([outConA, outConB].map(async file => JSON.parse(await fs.readFile(file, 'utf8'))));
    assert.deepEqual(
      resultsCon.map(result => result.results[0].state).sort(),
      ['submitted_but_readback_pending', 'submitted_but_readback_pending'].sort(),
      'both executors retain the unmatched readback as pending without a second POST',
    );
    const journalNames = (await fs.readdir(dirCon)).filter(name => name.endsWith('.journal.ndjson'));
    const journalEntries = (await Promise.all(journalNames.map(async name => (
      (await fs.readFile(path.join(dirCon, name), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse)
    )))).flat();
    assert.equal(journalEntries.filter(entry => entry.kind === 'intent').length, 1, 'concurrent executors must create one durable intent total');
    assert.equal(journalEntries.filter(entry => entry.kind === 'write_outcome').length, 0, 'unmatched concurrent readback must retain the one intent');
  } finally {
    mockCon.server.close();
    await cleanupLock();
  }

  // ---------------------------------------------------------------------
  // Scenario 5b: invalid stock-query inventory fields fail closed before
  // building a write request. Blank string and NaN-like strings are not zero.
  // ---------------------------------------------------------------------
  for (const [label, stockPatch, expectedError] of [
    ['blank_usable_inventory', {totalUsableInventory: ''}, /invalid totalUsableInventory/],
    ['nan_usable_inventory', {totalUsableInventory: 'NaN'}, /invalid totalUsableInventory/],
  ]) {
    const dirInvalid = path.join(temp, 'invalid-stock-' + label);
    await fs.mkdir(dirInvalid);
    const {plan: planInvalid} = await buildPlanFixture(dirInvalid, {etProducts: [etRow]});
    const mockInvalid = createMockOpenApiServer({
      onStockQuery: ({json, currentUsable}) => json({
        code: '0',
        info: [{
          goodsInventory: [{
            skuList: [{
              skuCode: SKU_CODE,
              totalInventoryQuantity: currentUsable,
              totalUsableInventory: currentUsable,
              totalLockedQuantity: 0,
              warehouseInventoryList: [],
              ...stockPatch,
            }],
          }],
        }],
      }),
    });
    mockInvalid.url = await new Promise(resolve => mockInvalid.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${mockInvalid.server.address().port}`)));
    await fs.writeFile(path.join(dirInvalid, 'config.json'), JSON.stringify({
      stores: [{storeKey: STORE_KEY, enabled: true, openKeyId: 'test-open-key', secretKey: 'test-secret', shopName: 'TEST', profileKey: 'dl', port: 0}],
      apiBaseUrls: {prodSemiManaged: mockInvalid.url},
    }), 'utf8');
    const outInvalid = path.join(dirInvalid, 'result.json');
    const argsInvalid = [
      '--plan', path.join(dirInvalid, 'plan.json'),
      '--policy', path.join(dirInvalid, 'policy.json'),
      '--config', path.join(dirInvalid, 'config.json'),
      '--bi-data', path.join(dirInvalid, 'bi.json'),
      '--links-data', path.join(dirInvalid, 'links.json'),
      '--out', outInvalid,
      '--execute',
      '--execution-mode', 'automatic',
      '--confirm-hash', planInvalid.payloadHash,
    ];
    try {
      const runInvalid = await runExecutor(argsInvalid, envCon);
      assert.equal(runInvalid.code, 1, label + ' must exit blocked, stderr=' + runInvalid.stderr);
      const resultInvalid = JSON.parse(await fs.readFile(outInvalid, 'utf8'));
      assert.equal(resultInvalid.results[0].state, 'blocked');
      assert.equal(resultInvalid.results[0].before.ok, false);
      assert.match(resultInvalid.results[0].error, expectedError);
      assert.equal(mockInvalid.getChangeInventoryPosts(), 0, label + ' must not POST after invalid stock readback');
    } finally {
      mockInvalid.server.close();
      await cleanupLock();
    }
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
      overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION,
      authorizationId: AUTOMATION_AUTHORIZATION,
      idempotencyKey: journalRequest.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
      requestPayloadHash: stableInventoryHash(journalRequest),
      request: journalRequest,
      before: journalBefore,
      recordedAt: new Date().toISOString(),
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
      'reconcile_only_terminal_recovery_skips_external_source_drift_no_second_post',
      'reconcile_only_hard_linked_historical_pending_date_classified_no_post_no_new_intent',
      'reconcile_only_hard_linked_historical_match_closes_original_intent_no_post',
      'reconcile_only_historical_close_after_precondition_fresh_reread_no_post',
      'reconcile_only_current_exact_intent_mismatch_fails_closed_no_post',
      'reconcile_only_missing_current_and_historical_intent_fails_closed_no_post',
      'reconcile_only_multiple_historical_pending_item_level_manual_resolve_no_post',
      'definitive_rejection_journals_write_outcome_rejected_and_releases_intent',
      'code_zero_missing_success_unmatched_readback_retains_intent_rerun_readback_only',
      'concurrent_stale_snapshots_refresh_under_sku_lock_one_post_total',
      'ten_readbacks_pending_retains_intent_rerun_readback_only',
      'readback_throw_retains_intent_rerun_readback_only',
      'torn_and_corrupt_journal_fail_closed_before_any_request',
    ],
  }, null, 2));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
