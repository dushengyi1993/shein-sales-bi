#!/usr/bin/env node

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  buildDailyInventoryPlanHashPayload,
  computeInventoryOverwriteQuantity,
  INVENTORY_OVERWRITE_COMPUTATION_VERSION,
  INVENTORY_LEGACY_UNVERSIONED_CUTOFF_DATE,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';
import {
  discoverInventoryJournalFiles,
  inventoryIntentScopeKey,
  inventoryRecoveryScopeKey,
  readInventoryIntentJournals,
} from '../lib/durable_inventory_write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policyFile = path.join(ROOT, 'config', 'inventory_replenishment_policy.json');
const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'));
const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const priorDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(Date.now() - 86_400_000));
const twoDaysAgo = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(Date.now() - 2 * 86_400_000));
const futureDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(Date.now() + 86_400_000));
const authContext = 'cloud_daily_inventory_replenishment_guard';
const authorizationId = 'owner-automatic-inventory-20260803-v1';

const ROWS = [
  {
    storeKey: 'ZX',
    skc: 'ZX-HIST-SKC',
    skuCode: 'ZX-HIST-SKU',
    spu: 'ZX-HIST-SPU',
    canonical: 'SK-ZX-HIST',
    matchKey: 'SK-ZX-HIST',
    targetUsableInventory: 10,
    ruleClass: 'recent_sale_scarcity',
    etSellableInventory: 11,
    shelfStatusCode: '1',
    shelfStatusName: '已上架',
    openApiShelfStatusCode: '1',
    sameStoreOnShelfSkcs: [],
    c7SaleCount: 2,
    c7Exposure: 100,
  },
  {
    storeKey: 'ZY',
    skc: 'ZY-CURRENT-SKC',
    skuCode: 'ZY-CURRENT-SKU',
    spu: 'ZY-CURRENT-SPU',
    canonical: 'SK-ZY-CURRENT',
    matchKey: 'SK-ZY-CURRENT',
    targetUsableInventory: 10,
    ruleClass: 'recent_sale_scarcity',
    etSellableInventory: 11,
    shelfStatusCode: '1',
    shelfStatusName: '已上架',
    openApiShelfStatusCode: '1',
    sameStoreOnShelfSkcs: [],
    c7SaleCount: 2,
    c7Exposure: 100,
  },
];

function sendJson(response, payload, status = 200) {
  response.writeHead(status, {'content-type': 'application/json'});
  response.end(`${JSON.stringify(payload)}\n`);
}

function actionKey(runDate, row, target = row.targetUsableInventory, policyVersion = policy.policyVersion, auth = authorizationId) {
  return stableInventoryHash({
    runDate,
    store: row.storeKey,
    skc: row.skc,
    sku: row.skuCode,
    target,
    actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
    policyVersion,
    authorizationId: auth,
  });
}

function makePlan(date, rows, sourceEvidence = [], policyVersion = policy.policyVersion) {
  const body = {
    schemaVersion: 'daily-inventory-replenishment-plan/v1',
    date,
    policyVersion,
    executable: true,
    blockers: [],
    actionable: rows,
    lowEtAllocations: [],
    sourceEvidence,
  };
  return {
    ...body,
    payloadHash: stableInventoryHash(buildDailyInventoryPlanHashPayload(body)),
  };
}

function makeIntent({
  runDate,
  row,
  planHash,
  intentId,
  target = row.targetUsableInventory,
  beforeUsable = 2,
  beforeTotal = beforeUsable,
  beforeLocked = 0,
  changeQuantity,
  policyVersion = policy.policyVersion,
  recordedAt = new Date().toISOString(),
  overwriteComputationVersion = String(runDate || '') > INVENTORY_LEGACY_UNVERSIONED_CUTOFF_DATE
    ? INVENTORY_OVERWRITE_COMPUTATION_VERSION
    : undefined,
}) {
  const logicalActionKey = actionKey(runDate, row, target, policyVersion);
  const before = {
    skuCode: row.skuCode,
    totalInventoryQuantity: beforeTotal,
    totalUsableInventory: beforeUsable,
    totalLockedQuantity: beforeLocked,
    stockRowMissing: false,
    warehouseCodes: [],
  };
  const request = {
    pathname: '/open-api/stock/change-inventory/v2',
    method: 'POST',
    body: {updateSkuInventoryQuantityRequests: [{
      idempotencyKey: `bi-inv-${logicalActionKey.slice(0, 42)}`,
      skuCode: row.skuCode,
      invType: 'VI',
      changeType: 'OVERWRITE',
      changeQuantity: changeQuantity ?? computeInventoryOverwriteQuantity(target, before),
      changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
    }]},
    headers: {language: 'en'},
  };
  return {
    kind: 'intent',
    intentId,
    logicalActionKey,
    recoveryScopeKey: inventoryRecoveryScopeKey({runDate, storeKey: row.storeKey, skc: row.skc, skuCode: row.skuCode}),
    planHash,
    runDate,
    storeKey: row.storeKey,
    skc: row.skc,
    skuCode: row.skuCode,
    targetUsableInventory: target,
    policyVersion,
    ...(overwriteComputationVersion === undefined ? {} : {overwriteComputationVersion}),
    authorizationId,
    idempotencyKey: request.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
    requestPayloadHash: stableInventoryHash(request),
    request,
    before,
    recordedAt,
  };
}

function makeWriteOutcome(intent, {
  disposition = 'readback_matched',
  recordedAt = new Date().toISOString(),
  code,
} = {}) {
  return {
    kind: 'write_outcome',
    intentId: intent.intentId,
    logicalActionKey: intent.logicalActionKey,
    disposition,
    recordedAt,
    ...(disposition === 'rejected' ? {code: code ?? 'rejected', httpOk: true, httpStatus: 200, success: false} : {}),
  };
}

function makeSupersedeOutcome(olderIntent, laterIntent, laterOutcome, overrides = {}) {
  return {
    kind: 'write_outcome',
    intentId: olderIntent.intentId,
    logicalActionKey: olderIntent.logicalActionKey,
    disposition: 'superseded_by_later_readback',
    recordedAt: new Date().toISOString(),
    supersededByIntentId: laterIntent.intentId,
    supersededByRunDate: laterIntent.runDate,
    supersededByRecordedAt: laterOutcome.recordedAt,
    ...overrides,
  };
}

function makeLegacyAuditRows({planHash = 'b'.repeat(64), sequenceGap = false, conflictingPlanHash = false, invalidRecordedAt = false} = {}) {
  return [
    {
      planHash,
      recordedAt: invalidRecordedAt ? '2026-02-30T10:00:00.000Z' : `${twoDaysAgo}T10:00:00.000Z`,
      row: {
        after: {totalUsableInventory: 10},
        before: {totalUsableInventory: 2},
        canonical: 'SK-LEGACY-UPDATED',
        skc: 'LEGACY-UPDATED-SKC',
        skuCode: 'LEGACY-UPDATED-SKU',
        state: 'updated_readback_matched',
        storeKey: 'LU',
        writes: [{code: '0'}],
      },
      sequence: 1,
    },
    {
      planHash: conflictingPlanHash ? 'a'.repeat(64) : planHash,
      recordedAt: `${twoDaysAgo}T10:01:00.000Z`,
      row: {
        canonical: 'SK-LEGACY-BLOCKED',
        error: 'legacy blocked audit row',
        skc: 'LEGACY-BLOCKED-SKC',
        skuCode: 'LEGACY-BLOCKED-SKU',
        state: 'blocked',
        storeKey: 'LB',
      },
      sequence: sequenceGap ? 3 : 2,
    },
  ];
}

async function writeJournalRows(file, rows) {
  await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

async function writeFixture(root, {date = today, rows = ROWS, oldIntent = null, oldIntentDate = priorDate, extraOldIntent = null, futureJournal = false} = {}) {
  const resultsDir = path.join(root, 'runtime', 'results');
  const plansDir = path.join(root, 'runtime', 'plans');
  await fs.mkdir(resultsDir, {recursive: true});
  await fs.mkdir(plansDir, {recursive: true});
  const fetchedAt = new Date().toISOString();
  const plan = makePlan(date, rows, date === today ? [
    {store: 'ET', fetchedAt, file: path.join(root, 'inventoryTrend.json')},
    {store: 'BI_LINKS', fetchedAt, file: path.join(root, 'linksData.json')},
  ] : []);
  const planFile = path.join(plansDir, `daily-inventory-replenishment-${date}.json`);
  const resultFile = path.join(resultsDir, `daily-inventory-replenishment-${date}.json`);
  const bi = {
    cachedAt: fetchedAt,
    data: {inventoryDepletion: {products: rows.map(row => ({
      match_key: row.matchKey,
      current_sellable_quantity: row.etSellableInventory,
      et_store_snapshot_date: today,
      inventory_match_status: 'matched',
      et_operational_stock_policy: '',
    }))}},
  };
  const links = {
    cachedAt: fetchedAt,
    storeLinks: rows.map(row => ({
      store_key: row.storeKey,
      skc: row.skc,
      standard_goods_sn: row.canonical,
      is_on_shelf: true,
      c7_sale_cnt: row.c7SaleCount,
      c7_eps_uv: row.c7Exposure,
    })),
  };
  const config = {
    apiBaseUrls: {prodSemiManaged: process.env.CROSS_DAY_INVENTORY_TEST_BASE_URL},
    stores: rows.map(row => ({storeKey: row.storeKey, enabled: true, openKeyId: `${row.storeKey}-key`, secretKey: `${row.storeKey}-secret`})),
  };
  await Promise.all([
    fs.writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`),
    fs.writeFile(path.join(root, 'inventoryTrend.json'), `${JSON.stringify(bi, null, 2)}\n`),
    fs.writeFile(path.join(root, 'linksData.json'), `${JSON.stringify(links, null, 2)}\n`),
    fs.writeFile(path.join(root, 'openapi.json'), `${JSON.stringify(config, null, 2)}\n`),
  ]);
  const currentIntentFile = `${resultFile}.journal.ndjson`;
  if (oldIntent) {
    const oldFile = path.join(resultsDir, `daily-inventory-replenishment-${oldIntentDate}.json.journal.ndjson`);
    await fs.writeFile(oldFile, `${JSON.stringify(oldIntent)}\n`);
  }
  if (extraOldIntent) {
    const oldFile = path.join(resultsDir, `daily-inventory-replenishment-${new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(Date.now() - 2 * 86_400_000))}.json.journal.ndjson`);
    await fs.writeFile(oldFile, `${JSON.stringify(extraOldIntent)}\n`);
  }
  if (futureJournal) {
    const futureFile = path.join(resultsDir, `daily-inventory-replenishment-${futureDate}.json.journal.ndjson`);
    await fs.writeFile(futureFile, `${JSON.stringify(oldIntent)}\n`);
  }
  return {plan, planFile, resultFile, currentIntentFile, biFile: path.join(root, 'inventoryTrend.json'), linksFile: path.join(root, 'linksData.json'), configFile: path.join(root, 'openapi.json')};
}

function runExecutor(fixture, {reconcilePendingOnly = false} = {}) {
  const args = [
    'scripts/inventory/execute_daily_inventory_replenishment_plan.mjs',
    '--plan', fixture.planFile,
    '--policy', policyFile,
    '--config', fixture.configFile,
    '--bi-data', fixture.biFile,
    '--links-data', fixture.linksFile,
    '--out', fixture.resultFile,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', fixture.plan.payloadHash,
    '--max-rows', '10',
    ...(reconcilePendingOnly ? ['--reconcile-pending-only'] : []),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        CROSS_DAY_INVENTORY_TEST_BASE_URL: process.env.CROSS_DAY_INVENTORY_TEST_BASE_URL,
        SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: authContext,
        SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: authorizationId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({code, stdout, stderr});
    });
  });
}

const state = {mode: 'historical_pending', postCount: 0, postSkus: [], requestCount: 0, stock: new Map()};
const server = http.createServer((request, response) => {
  let raw = '';
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    state.requestCount += 1;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch {}
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (!state.requestPaths) state.requestPaths = [];
    state.requestPaths.push(`${request.method} ${pathname}`);
    if (request.method === 'POST' && pathname === '/open-api/openapi-business-backend/query-store-info') {
      return sendJson(response, {code: '0', info: {}});
    }
    if (request.method === 'POST' && pathname === '/open-api/goods/spu-info') {
      const row = ROWS.find(candidate => candidate.spu === body?.spuName);
      if (!row) return sendJson(response, {code: '404', msg: 'unknown spu'});
      return sendJson(response, {code: '0', info: {
        supplierCode: row.canonical,
        skcInfoList: [{
          skcName: row.skc,
          supplierCode: row.canonical,
          shelfStatusInfoList: [{siteAbbr: 'shein-sa', shelfStatus: '1'}],
          skuInfoList: [{skuCode: row.skuCode}],
        }],
      }});
    }
    if (request.method === 'POST' && pathname === '/open-api/stock/stock-query') {
      const skuCode = body?.skuCodeList?.[0] || '';
      const usable = Number(state.stock.get(skuCode) ?? 2);
      return sendJson(response, {code: '0', info: [{goodsInventory: [{skuList: [{
        skuCode,
        totalInventoryQuantity: usable,
        totalUsableInventory: usable,
        totalLockedQuantity: 0,
        warehouseInventoryList: [],
      }]}]}]});
    }
    if (request.method === 'POST' && pathname === '/open-api/stock/change-inventory/v2') {
      state.postCount += 1;
      const requestRow = body?.updateSkuInventoryQuantityRequests?.[0];
      state.postSkus.push(requestRow?.skuCode || null);
      state.stock.set(requestRow?.skuCode, Number(requestRow?.changeQuantity));
      return sendJson(response, {code: '0', info: {success: true}});
    }
    return sendJson(response, {code: '404', msg: pathname}, 404);
  });
});
const portReady = new Promise((resolve, reject) => {
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const port = await portReady;
process.env.CROSS_DAY_INVENTORY_TEST_BASE_URL = `http://127.0.0.1:${port}`;

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-cross-day-'));
process.env.SHEIN_BI_INVENTORY_GLOBAL_LOCK_FILE = path.join(temp, 'inventory-v2-cutover.lock');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const journalEntries = async file => {
  try {
    return (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
};

try {
  // 0) Daily and ET result directories are one recovery domain. Discovery
  // must accept explicit additional directories while de-duplicating both
  // repeated paths and ET's stable/attempt hard links by inode.
  const discoveryRoot = path.join(temp, 'daily-and-et-journal-discovery');
  const discoveryDailyDir = path.join(discoveryRoot, 'daily-results');
  const discoveryEtDir = path.join(discoveryRoot, 'et-results');
  await fs.mkdir(discoveryDailyDir, {recursive: true});
  await fs.mkdir(discoveryEtDir, {recursive: true});
  const discoveryCurrentFile = path.join(
    discoveryDailyDir,
    `daily-inventory-replenishment-${today}.json.journal.ndjson`,
  );
  const discoveryDailySibling = path.join(
    discoveryDailyDir,
    `daily-inventory-replenishment-${priorDate}.json.journal.ndjson`,
  );
  const discoveryEtStable = path.join(
    discoveryEtDir,
    `et-low-inventory-batch-${today}.json.journal.ndjson`,
  );
  const discoveryEtAttempt = path.join(
    discoveryEtDir,
    `et-low-inventory-batch-${today}.json.attempt-1.journal.ndjson`,
  );
  await Promise.all([
    fs.writeFile(discoveryCurrentFile, '{}\n'),
    fs.writeFile(discoveryDailySibling, '{}\n'),
    fs.writeFile(discoveryEtStable, '{}\n'),
  ]);
  await fs.link(discoveryEtStable, discoveryEtAttempt);
  const discoveredJournalFiles = await discoverInventoryJournalFiles(discoveryCurrentFile, {
    includeAll: true,
    additionalDirectories: [discoveryEtDir, discoveryEtDir, discoveryDailyDir],
  });
  assert.equal(discoveredJournalFiles.length, 3, 'daily plus ET discovery must retain three physical journals');
  assert.equal(new Set(discoveredJournalFiles).size, 3, 'discovery must de-duplicate repeated paths');
  const journalIdentity = async file => {
    const stat = await fs.stat(file, {bigint: true});
    return `${stat.dev}:${stat.ino}`;
  };
  const discoveredIdentities = await Promise.all(discoveredJournalFiles.map(journalIdentity));
  assert.equal(new Set(discoveredIdentities).size, 3, 'discovery must de-duplicate journals by inode');
  const etStableIdentity = await journalIdentity(discoveryEtStable);
  assert.equal(
    discoveredIdentities.filter(identity => identity === etStableIdentity).length,
    1,
    'ET stable and attempt hard links must be returned once across additional directories',
  );

  // Intent aggregation keeps the old fail-closed default, while the explicit
  // recovery path may inspect multiple pending records in deterministic
  // chronology order. Input files are deliberately reversed, and two intents
  // share a timestamp so intentId is exercised as the final tie-breaker.
  const orderingRoot = path.join(temp, 'intent-chronology-ordering');
  await fs.mkdir(orderingRoot, {recursive: true});
  const orderingFileA = path.join(orderingRoot, `daily-inventory-replenishment-${today}.json.journal.ndjson`);
  const orderingFileB = path.join(orderingRoot, `et-low-inventory-batch-${today}.json.journal.ndjson`);
  const orderingFileC = path.join(orderingRoot, `et-low-inventory-batch-${today}.json.attempt-2.journal.ndjson`);
  const orderingBaseMs = Date.now() - 10_000;
  const orderingEarlier = makeIntent({
    runDate: today,
    row: ROWS[0],
    planHash: 'a'.repeat(64),
    intentId: 'chronology-early',
    recordedAt: new Date(orderingBaseMs).toISOString(),
  });
  const orderingTieB = makeIntent({
    runDate: today,
    row: ROWS[0],
    planHash: 'b'.repeat(64),
    intentId: 'chronology-tie-b',
    recordedAt: new Date(orderingBaseMs + 1_000).toISOString(),
  });
  const orderingTieA = makeIntent({
    runDate: today,
    row: ROWS[0],
    planHash: 'c'.repeat(64),
    intentId: 'chronology-tie-a',
    recordedAt: orderingTieB.recordedAt,
  });
  await Promise.all([
    writeJournalRows(orderingFileA, [orderingTieB]),
    writeJournalRows(orderingFileB, [orderingEarlier]),
    writeJournalRows(orderingFileC, [orderingTieA]),
  ]);
  await assert.rejects(
    () => readInventoryIntentJournals([orderingFileA, orderingFileB, orderingFileC], {maxRunDate: today}),
    /INVENTORY_JOURNAL_PENDING_SCOPE_CONFLICT/,
    'same-scope multiple pending intents must fail closed by default',
  );
  const orderedJournalBundle = await readInventoryIntentJournals(
    [orderingFileA, orderingFileB, orderingFileC],
    {maxRunDate: today, allowMultiplePendingByScope: true},
  );
  const orderingScope = inventoryIntentScopeKey(orderingEarlier);
  assert.deepEqual(
    orderedJournalBundle.pendingByScope.get(orderingScope)?.map(intent => intent.intentId),
    ['chronology-early', 'chronology-tie-a', 'chronology-tie-b'],
    'explicit multi-pending recovery must sort by runDate, recordedAt, then intentId',
  );

  // 1) D-day pending intent freezes only ZX; independent ZY completes on D+1.
  const firstRoot = path.join(temp, 'historical-pending');
  const historicalIntent = makeIntent({runDate: priorDate, row: ROWS[0], planHash: 'd'.repeat(64), intentId: 'historical-pending-1'});
  const first = await writeFixture(firstRoot, {oldIntent: historicalIntent});
  const legacyAuditFile = path.join(firstRoot, 'runtime', 'results', `daily-inventory-replenishment-${twoDaysAgo}.json.journal.ndjson`);
  await writeJournalRows(legacyAuditFile, makeLegacyAuditRows());
  state.mode = 'historical_pending';
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  state.stock = new Map([[ROWS[0].skuCode, 2], [ROWS[1].skuCode, 2]]);
  const firstRun = await runExecutor(first);
  assert.equal(firstRun.code, 1, `historical mismatch must remain blocked\nstdout=${firstRun.stdout}\nstderr=${firstRun.stderr}`);
  const firstResult = await readJson(first.resultFile);
  assert.equal(state.postCount, 1,
    `independent current scope must issue exactly one POST\nresult=${JSON.stringify(firstResult)}\nstdout=${firstRun.stdout}\nstderr=${firstRun.stderr}`);
  assert.deepEqual(state.postSkus, [ROWS[1].skuCode], 'historical ZX scope must receive zero POSTs');
  const historicalResult = firstResult.results.find(row => row.storeKey === ROWS[0].storeKey);
  const independentResult = firstResult.results.find(row => row.storeKey === ROWS[1].storeKey);
  assert.equal(historicalResult.state, 'submitted_but_readback_pending');
  assert.equal(historicalResult.historicalPending, true);
  assert.equal(historicalResult.disposition, 'skipped');
  assert.equal(independentResult.state, 'updated_readback_matched');
  assert.equal(firstResult.deferredHistorical.length, 0, 'legacy audit rows must not create lifecycle intents or warnings');
  assert.equal((await journalEntries(first.currentIntentFile)).filter(row => row.kind === 'intent' && row.storeKey === ROWS[0].storeKey).length, 0, 'historical reappearance must not create a current intent');
  assert.equal((await journalEntries(path.join(firstRoot, 'runtime', 'results', `daily-inventory-replenishment-${priorDate}.json.journal.ndjson`))).filter(row => row.kind === 'write_outcome').length, 0);

  // 1b) The shared executor must also discover ET/non-daily journal prefixes
  // in its result directory and intercept the same historical item scope.
  const nonDailyRoot = path.join(temp, 'historical-non-daily-prefix');
  const nonDaily = await writeFixture(nonDailyRoot);
  const nonDailyIntent = makeIntent({
    runDate: priorDate,
    row: ROWS[0],
    planHash: 'c'.repeat(64),
    intentId: 'historical-et-prefix-1',
  });
  const nonDailyStableJournal = path.join(
    nonDailyRoot,
    'runtime',
    'results',
    `et-low-inventory-batch-${priorDate}.json.journal.ndjson`,
  );
  const nonDailyAttemptResult = path.join(
    nonDailyRoot,
    'runtime',
    'results',
    `et-low-inventory-batch-${priorDate}.json.attempt-test`,
  );
  const nonDailyAttemptJournal = `${nonDailyAttemptResult}.journal.ndjson`;
  await fs.writeFile(nonDailyStableJournal, `${JSON.stringify(nonDailyIntent)}\n`);
  await fs.link(nonDailyStableJournal, nonDailyAttemptJournal);
  nonDaily.resultFile = nonDailyAttemptResult;
  nonDaily.currentIntentFile = nonDailyAttemptJournal;
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  state.stock = new Map([[ROWS[0].skuCode, 2], [ROWS[1].skuCode, 2]]);
  const nonDailyRun = await runExecutor(nonDaily);
  assert.equal(nonDailyRun.code, 1, `non-daily historical pending scope must remain intercepted\nstdout=${nonDailyRun.stdout}\nstderr=${nonDailyRun.stderr}`);
  assert.deepEqual(state.postSkus, [ROWS[1].skuCode], 'non-daily historical ZX scope must receive zero duplicate POSTs');
  const nonDailyResult = await readJson(nonDaily.resultFile);
  const nonDailyHistorical = nonDailyResult.results.find(row => row.storeKey === ROWS[0].storeKey);
  assert.equal(nonDailyHistorical.historicalPending, true);
  assert.equal(nonDailyHistorical.disposition, 'skipped');
  assert.equal((await journalEntries(nonDaily.currentIntentFile)).filter(row => row.kind === 'intent' && row.storeKey === ROWS[0].storeKey).length, 1, 'hard-linked ET attempt must retain exactly one original intent without duplicate discovery');

  // 2) A historical pending scope absent from today's plan is audit-only:
  // it must not duplicate or block the independent current result row.
  const absentRoot = path.join(temp, 'historical-absent-from-plan');
  const absent = await writeFixture(absentRoot, {
    rows: [ROWS[1]],
    oldIntent: {...historicalIntent, intentId: 'historical-absent-1'},
  });
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  state.stock = new Map([[ROWS[1].skuCode, 2]]);
  const absentRun = await runExecutor(absent);
  assert.equal(absentRun.code, 0, `absent historical scope must be warning-only\nstdout=${absentRun.stdout}\nstderr=${absentRun.stderr}`);
  const absentResult = await readJson(absent.resultFile);
  assert.equal(absentResult.results.length, 1, 'absent historical scope must not add a synthetic row');
  assert.equal(absentResult.results[0].storeKey, ROWS[1].storeKey);
  assert.equal(absentResult.results[0].state, 'updated_readback_matched');
  assert.equal(absentResult.unresolvedIntents.length, 0, 'deferred historical warnings must not populate the morning-chain blocker field');
  assert.equal(absentResult.deferredHistorical.length, 1);
  assert.equal(absentResult.deferredHistorical[0].storeKey, ROWS[0].storeKey);
  assert.equal(absentResult.deferredHistorical[0].state, 'deferred_historical');
  assert.match(absentResult.deferredHistorical[0].warning, /retained for audit/);
  assert.equal(state.postCount, 1, 'the independent current scope still posts once');
  assert.deepEqual(state.postSkus, [ROWS[1].skuCode], 'absent historical ZX scope must receive zero POSTs');

  // 3) Exact old target visible: close the original journal and defer current ZX.
  const secondRoot = path.join(temp, 'historical-matched');
  const secondIntent = makeIntent({runDate: priorDate, row: ROWS[0], planHash: 'e'.repeat(64), intentId: 'historical-matched-1'});
  const second = await writeFixture(secondRoot, {oldIntent: secondIntent});
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  state.stock = new Map([[ROWS[0].skuCode, 10], [ROWS[1].skuCode, 2]]);
  const secondRun = await runExecutor(second);
  assert.equal(secondRun.code, 0, `historical matched close should be terminal\nstdout=${secondRun.stdout}\nstderr=${secondRun.stderr}`);
  assert.equal(state.postCount, 1, 'only independent ZY may POST after historical ZX closes');
  assert.deepEqual(state.postSkus, [ROWS[1].skuCode], 'historical close must not issue a corrective ZX POST in this run');
  const secondResult = await readJson(second.resultFile);
  const closedResult = secondResult.results.find(row => row.storeKey === ROWS[0].storeKey);
  assert.equal(closedResult.state, 'skipped_target_already_matched');
  assert.equal(closedResult.historicalIntentClosed, true);
  assert.equal(closedResult.deferred, true);
  const secondJournal = await journalEntries(path.join(secondRoot, 'runtime', 'results', `daily-inventory-replenishment-${priorDate}.json.journal.ndjson`));
  assert.deepEqual(secondJournal.filter(row => row.kind === 'write_outcome').map(row => row.disposition), ['readback_matched']);
  assert.equal((await journalEntries(second.currentIntentFile)).filter(row => row.kind === 'intent' && row.storeKey === ROWS[0].storeKey).length, 0, 'historical close must not create a current corrective intent');

  // 3b) The generic executor must not synthesize a supersede outcome from a
  // startup snapshot. A later terminal intent is an audited one-time
  // reconciliation concern; this SKU remains item-scoped pending here.
  const supersedeRoot = path.join(temp, 'historical-superseded-by-later-readback');
  const supersededIntent = makeIntent({runDate: priorDate, row: ROWS[0], planHash: '8'.repeat(64), intentId: 'superseded-old-1'});
  const supersede = await writeFixture(supersedeRoot, {rows: [ROWS[0]], oldIntent: supersededIntent});
  const laterMatchedIntent = makeIntent({
    runDate: today,
    row: ROWS[0],
    planHash: supersede.plan.payloadHash,
    intentId: 'superseding-current-1',
  });
  const laterMatchedOutcome = makeWriteOutcome(laterMatchedIntent);
  await writeJournalRows(supersede.currentIntentFile, [laterMatchedIntent, laterMatchedOutcome]);
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  state.stock = new Map([[ROWS[0].skuCode, 9]]);
  const supersedeRun = await runExecutor(supersede, {reconcilePendingOnly: true});
  assert.equal(supersedeRun.code, 1, `generic executor must retain the unresolved older intent\nstdout=${supersedeRun.stdout}\nstderr=${supersedeRun.stderr}`);
  assert.equal(state.postCount, 0, 'generic executor must not POST while the historical SKU remains unresolved');
  const supersedeResult = await readJson(supersede.resultFile);
  assert.equal(supersedeResult.results.length, 1);
  assert.equal(supersedeResult.results[0].state, 'submitted_but_readback_pending');
  assert.equal(supersedeResult.results[0].historicalIntentId, supersededIntent.intentId);
  assert.equal(supersedeResult.results[0].disposition, 'skipped');
  const supersededJournalFile = path.join(supersedeRoot, 'runtime', 'results', `daily-inventory-replenishment-${priorDate}.json.journal.ndjson`);
  const supersededJournal = await journalEntries(supersededJournalFile);
  const supersedeOutcomes = supersededJournal.filter(row => row.disposition === 'superseded_by_later_readback');
  assert.equal(supersedeOutcomes.length, 0, 'generic executor must not append a startup supersede outcome');
  assert.equal((await journalEntries(supersede.currentIntentFile)).filter(row => row.disposition === 'superseded_by_later_readback').length, 0);

  // A rerun remains readback-only and must not manufacture the supersede
  // closure either.
  state.postCount = 0;
  state.requestCount = 0;
  const supersedeRerun = await runExecutor(supersede, {reconcilePendingOnly: true});
  assert.equal(supersedeRerun.code, 1, `generic executor must remain blocked on the unresolved supersede candidate\nstderr=${supersedeRerun.stderr}`);
  assert.equal(state.postCount, 0);
  assert.equal((await journalEntries(supersededJournalFile)).filter(row => row.disposition === 'superseded_by_later_readback').length, 0);

  // A rejected later intent is not readback evidence and must not supersede.
  const rejectedLaterRoot = path.join(temp, 'historical-not-superseded-by-rejection');
  const rejectedOlderIntent = makeIntent({runDate: priorDate, row: ROWS[0], planHash: '7'.repeat(64), intentId: 'rejected-older-1'});
  const rejectedLater = await writeFixture(rejectedLaterRoot, {rows: [ROWS[0]], oldIntent: rejectedOlderIntent});
  const rejectedLaterIntent = makeIntent({runDate: today, row: ROWS[0], planHash: rejectedLater.plan.payloadHash, intentId: 'rejected-later-1'});
  await writeJournalRows(rejectedLater.currentIntentFile, [
    rejectedLaterIntent,
    makeWriteOutcome(rejectedLaterIntent, {disposition: 'rejected', code: '400'}),
  ]);
  state.postCount = 0;
  state.requestCount = 0;
  const rejectedLaterRun = await runExecutor(rejectedLater, {reconcilePendingOnly: true});
  assert.notEqual(rejectedLaterRun.code, 0);
  assert.match(rejectedLaterRun.stderr, /INVENTORY_RECONCILE_PENDING_ONLY_PRECONDITION_FAILED/);
  assert.equal(state.requestCount, 0, 'a rejected later lifecycle must fail before API');
  assert.equal((await journalEntries(path.join(rejectedLaterRoot, 'runtime', 'results', `daily-inventory-replenishment-${priorDate}.json.journal.ndjson`))).filter(row => row.disposition === 'superseded_by_later_readback').length, 0);

  // A same-date later terminal sibling still does not let the generic executor
  // append a supersede outcome; the one-time audited reconciler owns that write.
  const sameDateRoot = path.join(temp, 'same-date-later-terminal-supersedes');
  const sameDate = await writeFixture(sameDateRoot, {rows: [ROWS[0]]});
  const sameDateBaseMs = Date.now() - 5_000;
  const sameDatePending = makeIntent({
    runDate: today,
    row: ROWS[0],
    planHash: sameDate.plan.payloadHash,
    intentId: 'same-date-pending-1',
    recordedAt: new Date(sameDateBaseMs).toISOString(),
  });
  const sameDateMatched = makeIntent({
    runDate: today,
    row: ROWS[0],
    planHash: sameDate.plan.payloadHash,
    intentId: 'same-date-matched-1',
    recordedAt: new Date(sameDateBaseMs + 1_000).toISOString(),
  });
  const sameDateMatchedOutcome = makeWriteOutcome(sameDateMatched, {
    recordedAt: new Date(sameDateBaseMs + 2_000).toISOString(),
  });
  await writeJournalRows(sameDate.currentIntentFile, [sameDatePending, sameDateMatched, sameDateMatchedOutcome]);
  state.postCount = 0;
  state.requestCount = 0;
  state.stock = new Map([[ROWS[0].skuCode, 2]]);
  const sameDateRun = await runExecutor(sameDate, {reconcilePendingOnly: true});
  assert.equal(sameDateRun.code, 1, `same-date generic recovery must remain item-scoped pending\nstdout=${sameDateRun.stdout}\nstderr=${sameDateRun.stderr}`);
  assert.ok(state.requestPaths.includes('POST /open-api/goods/spu-info'), 'same-date recovery must re-check live listing identity');
  assert.ok(state.requestPaths.includes('POST /open-api/stock/stock-query'), 'same-date recovery must re-check live stock');
  assert.equal(state.postCount, 0);
  const sameDateResult = await readJson(sameDate.resultFile);
  assert.equal(sameDateResult.results[0].state, 'submitted_but_readback_pending');
  const sameDateJournal = await journalEntries(sameDate.currentIntentFile);
  const sameDateSupersede = sameDateJournal.find(row => row.disposition === 'superseded_by_later_readback');
  assert.equal(sameDateSupersede, undefined, 'generic executor must not append a same-date supersede outcome');

  // The validator must select the unique latest intent that existed by the
  // closure timestamp. I3 was already pending at closure, so I1 -> I2 is
  // invalid even though I2 has an exact terminal readback.
  const closureRoot = path.join(temp, 'supersede-validator-later-pending-at-closure');
  await fs.mkdir(closureRoot, {recursive: true});
  const closureFile = path.join(closureRoot, `daily-inventory-replenishment-${today}.json.journal.ndjson`);
  const closureBaseMs = Date.now() - 20_000;
  const closureI1 = makeIntent({runDate: today, row: ROWS[0], planHash: 'c1'.repeat(32), intentId: 'closure-i1', recordedAt: new Date(closureBaseMs).toISOString()});
  const closureI2 = makeIntent({runDate: today, row: ROWS[0], planHash: 'c2'.repeat(32), intentId: 'closure-i2', recordedAt: new Date(closureBaseMs + 1_000).toISOString()});
  const closureI2Outcome = makeWriteOutcome(closureI2, {recordedAt: new Date(closureBaseMs + 2_000).toISOString()});
  const closureI3 = makeIntent({runDate: today, row: ROWS[0], planHash: 'c3'.repeat(32), intentId: 'closure-i3-pending', recordedAt: new Date(closureBaseMs + 2_500).toISOString()});
  const invalidClosure = makeSupersedeOutcome(closureI1, closureI2, closureI2Outcome, {recordedAt: new Date(closureBaseMs + 3_000).toISOString()});
  await writeJournalRows(closureFile, [closureI1, closureI2, closureI2Outcome, closureI3, invalidClosure]);
  await assert.rejects(
    () => readInventoryIntentJournals([closureFile], {maxRunDate: today}),
    /INVENTORY_JOURNAL_SUPERSEDE_INVALID:.*:referencedIntentNotLatestAtClosure/,
    'I1 -> I2 must fail when a later I3 was pending at closure',
  );

  // An I3 created after the I1 -> I2 closure is outside the closure snapshot:
  // the old valid closure remains valid, while I3 is the only new pending row.
  const afterClosureRoot = path.join(temp, 'supersede-validator-intent-after-closure');
  await fs.mkdir(afterClosureRoot, {recursive: true});
  const afterClosureFile = path.join(afterClosureRoot, `daily-inventory-replenishment-${today}.json.journal.ndjson`);
  const afterClosureI1 = makeIntent({runDate: today, row: ROWS[0], planHash: 'd1'.repeat(32), intentId: 'after-closure-i1', recordedAt: new Date(closureBaseMs).toISOString()});
  const afterClosureI2 = makeIntent({runDate: today, row: ROWS[0], planHash: 'd2'.repeat(32), intentId: 'after-closure-i2', recordedAt: new Date(closureBaseMs + 1_000).toISOString()});
  const afterClosureI2Outcome = makeWriteOutcome(afterClosureI2, {recordedAt: new Date(closureBaseMs + 2_000).toISOString()});
  const afterClosureOutcome = makeSupersedeOutcome(afterClosureI1, afterClosureI2, afterClosureI2Outcome, {recordedAt: new Date(closureBaseMs + 3_000).toISOString()});
  const afterClosureI3 = makeIntent({runDate: today, row: ROWS[0], planHash: 'd3'.repeat(32), intentId: 'after-closure-i3-pending', recordedAt: new Date(closureBaseMs + 5_000).toISOString()});
  await writeJournalRows(afterClosureFile, [afterClosureI1, afterClosureI2, afterClosureI2Outcome, afterClosureOutcome, afterClosureI3]);
  const afterClosureBundle = await readInventoryIntentJournals([afterClosureFile], {maxRunDate: today});
  const afterClosureScope = inventoryIntentScopeKey(afterClosureI1);
  assert.deepEqual(
    afterClosureBundle.pendingByScope.get(afterClosureScope)?.map(intent => intent.intentId),
    [afterClosureI3.intentId],
    'an intent created after closure must not invalidate the old supersede closure',
  );
  assert.equal(
    [...afterClosureBundle.terminalOutcomes.values()].find(outcome => outcome.intentId === afterClosureI1.intentId)?.disposition,
    'superseded_by_later_readback',
  );

  // Two later intents tied at closure make the referenced successor
  // non-unique; the validator must fail closed rather than guess.
  const tieRoot = path.join(temp, 'supersede-validator-tie-at-closure');
  await fs.mkdir(tieRoot, {recursive: true});
  const tieFile = path.join(tieRoot, `daily-inventory-replenishment-${today}.json.journal.ndjson`);
  const tieI1 = makeIntent({runDate: today, row: ROWS[0], planHash: 'e1'.repeat(32), intentId: 'tie-i1', recordedAt: new Date(closureBaseMs).toISOString()});
  const tieI2 = makeIntent({runDate: today, row: ROWS[0], planHash: 'e2'.repeat(32), intentId: 'tie-i2', recordedAt: new Date(closureBaseMs + 1_000).toISOString()});
  const tieI3 = makeIntent({runDate: today, row: ROWS[0], planHash: 'e3'.repeat(32), intentId: 'tie-i3', recordedAt: tieI2.recordedAt});
  const tieI2Outcome = makeWriteOutcome(tieI2, {recordedAt: new Date(closureBaseMs + 2_000).toISOString()});
  const tieI3Outcome = makeWriteOutcome(tieI3, {recordedAt: new Date(closureBaseMs + 2_100).toISOString()});
  const tieClosure = makeSupersedeOutcome(tieI1, tieI2, tieI2Outcome, {recordedAt: new Date(closureBaseMs + 3_000).toISOString()});
  await writeJournalRows(tieFile, [tieI1, tieI2, tieI3, tieI2Outcome, tieI3Outcome, tieClosure]);
  await assert.rejects(
    () => readInventoryIntentJournals([tieFile], {maxRunDate: today}),
    /INVENTORY_JOURNAL_SUPERSEDE_INVALID:.*:laterIntentAmbiguousAtClosure/,
    'same-time later successors must fail closed when the latest intent is not unique',
  );

  // Equal recordedAt evidence is not a later readback, even when the
  // supersede outcome itself is appended afterward.
  const sameTimeRoot = path.join(temp, 'same-time-supersede-rejected');
  const sameTime = await writeFixture(sameTimeRoot, {rows: [ROWS[0]]});
  const sameTimeRecordedAt = new Date(Date.now() - 4_000).toISOString();
  const sameTimeOlder = makeIntent({
    runDate: today,
    row: ROWS[0],
    planHash: '4'.repeat(64),
    intentId: 'same-time-older-1',
    recordedAt: sameTimeRecordedAt,
  });
  const sameTimeLater = makeIntent({
    runDate: today,
    row: ROWS[0],
    planHash: '3'.repeat(64),
    intentId: 'same-time-later-1',
    recordedAt: sameTimeRecordedAt,
  });
  const sameTimeMatched = makeWriteOutcome(sameTimeLater, {recordedAt: sameTimeRecordedAt});
  await writeJournalRows(sameTime.currentIntentFile, [
    sameTimeOlder,
    sameTimeLater,
    sameTimeMatched,
    makeSupersedeOutcome(sameTimeOlder, sameTimeLater, sameTimeMatched, {
      recordedAt: new Date(Date.now() - 3_000).toISOString(),
    }),
  ]);
  await assert.rejects(
    () => readInventoryIntentJournals([sameTime.currentIntentFile], {maxRunDate: today}),
    /INVENTORY_JOURNAL_SUPERSEDE_INVALID/,
    'same-time readback evidence must not supersede a pending intent',
  );

  // A reference to an intent that is earlier by recordedAt is also invalid,
  // even if its terminal outcome was recorded after the older intent.
  const outOfOrderRoot = path.join(temp, 'out-of-order-supersede-rejected');
  const outOfOrder = await writeFixture(outOfOrderRoot, {rows: [ROWS[0]]});
  const outOfOrderBaseMs = Date.now() - 6_000;
  const outOfOrderOlder = makeIntent({
    runDate: today,
    row: ROWS[0],
    planHash: '2'.repeat(64),
    intentId: 'out-of-order-older-1',
    recordedAt: new Date(outOfOrderBaseMs + 2_000).toISOString(),
  });
  const outOfOrderLater = makeIntent({
    runDate: today,
    row: ROWS[0],
    planHash: '1'.repeat(64),
    intentId: 'out-of-order-later-1',
    recordedAt: new Date(outOfOrderBaseMs + 1_000).toISOString(),
  });
  const outOfOrderMatched = makeWriteOutcome(outOfOrderLater, {
    recordedAt: new Date(outOfOrderBaseMs + 3_000).toISOString(),
  });
  await writeJournalRows(outOfOrder.currentIntentFile, [
    outOfOrderOlder,
    outOfOrderLater,
    outOfOrderMatched,
    makeSupersedeOutcome(outOfOrderOlder, outOfOrderLater, outOfOrderMatched, {
      recordedAt: new Date(outOfOrderBaseMs + 4_000).toISOString(),
    }),
  ]);
  await assert.rejects(
    () => readInventoryIntentJournals([outOfOrder.currentIntentFile], {maxRunDate: today}),
    /INVENTORY_JOURNAL_SUPERSEDE_INVALID/,
    'an out-of-order supersede reference must fail closed',
  );

  // A current pending intent with no later terminal remains readback-only and
  // blocks only its own row with zero inventory POST.
  const currentPendingRoot = path.join(temp, 'current-pending-without-later-terminal');
  const currentPending = await writeFixture(currentPendingRoot, {rows: [ROWS[0]]});
  const currentPendingIntent = makeIntent({runDate: today, row: ROWS[0], planHash: currentPending.plan.payloadHash, intentId: 'current-pending-1'});
  await writeJournalRows(currentPending.currentIntentFile, [currentPendingIntent]);
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  state.stock = new Map([[ROWS[0].skuCode, 2]]);
  const currentPendingRun = await runExecutor(currentPending, {reconcilePendingOnly: true});
  assert.equal(currentPendingRun.code, 1);
  assert.equal(state.postCount, 0);
  assert.equal((await readJson(currentPending.resultFile)).results[0].state, 'submitted_but_readback_pending');

  // Exact supersede shape is mandatory and references are proven across the
  // complete journal set before any identity or stock request.
  const forgedRoot = path.join(temp, 'forged-supersede-reference');
  const forgedOlder = makeIntent({runDate: priorDate, row: ROWS[0], planHash: '6'.repeat(64), intentId: 'forged-older-1'});
  const forged = await writeFixture(forgedRoot, {rows: [ROWS[0]], oldIntent: forgedOlder});
  const forgedLater = makeIntent({runDate: today, row: ROWS[0], planHash: forged.plan.payloadHash, intentId: 'real-later-1'});
  const forgedLaterOutcome = makeWriteOutcome(forgedLater);
  await writeJournalRows(forged.currentIntentFile, [forgedLater, forgedLaterOutcome]);
  await writeJournalRows(
    path.join(forgedRoot, 'runtime', 'results', `daily-inventory-replenishment-${priorDate}.json.journal.ndjson`),
    [forgedOlder, makeSupersedeOutcome(forgedOlder, forgedLater, forgedLaterOutcome, {supersededByIntentId: 'missing-forged-intent'})],
  );
  state.postCount = 0;
  state.requestCount = 0;
  const forgedRun = await runExecutor(forged, {reconcilePendingOnly: true});
  assert.notEqual(forgedRun.code, 0);
  assert.match(forgedRun.stderr, /INVENTORY_JOURNAL_SUPERSEDE_INVALID:.*:referencedIntentMissing/);
  assert.equal(state.requestCount, 0);

  const supersedeShapeRoot = path.join(temp, 'supersede-extra-key');
  const shapeOlder = makeIntent({runDate: priorDate, row: ROWS[0], planHash: '5'.repeat(64), intentId: 'shape-older-1'});
  const supersedeShape = await writeFixture(supersedeShapeRoot, {rows: [ROWS[0]], oldIntent: shapeOlder});
  const shapeLater = makeIntent({runDate: today, row: ROWS[0], planHash: supersedeShape.plan.payloadHash, intentId: 'shape-later-1'});
  const shapeLaterOutcome = makeWriteOutcome(shapeLater);
  await writeJournalRows(supersedeShape.currentIntentFile, [shapeLater, shapeLaterOutcome]);
  await writeJournalRows(
    path.join(supersedeShapeRoot, 'runtime', 'results', `daily-inventory-replenishment-${priorDate}.json.journal.ndjson`),
    [shapeOlder, makeSupersedeOutcome(shapeOlder, shapeLater, shapeLaterOutcome, {unexpected: true})],
  );
  state.postCount = 0;
  state.requestCount = 0;
  const supersedeShapeRun = await runExecutor(supersedeShape, {reconcilePendingOnly: true});
  assert.notEqual(supersedeShapeRun.code, 0);
  assert.match(supersedeShapeRun.stderr, /INVENTORY_JOURNAL_SUPERSEDE_INVALID:.*:outcomeShape/);
  assert.equal(state.requestCount, 0);

  // 4) Malformed immutable request/hash data fails closed before any API call.
  const immutableRoot = path.join(temp, 'immutable-corruption');
  const immutable = await writeFixture(immutableRoot, {
    oldIntent: {
      ...historicalIntent,
      intentId: 'immutable-corruption-1',
      request: {...historicalIntent.request, method: 'GET'},
      requestPayloadHash: '0'.repeat(64),
    },
  });
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  const immutableRun = await runExecutor(immutable);
  assert.notEqual(immutableRun.code, 0);
  assert.match(immutableRun.stderr, /INVENTORY_JOURNAL_IMMUTABLE_INVALID/);
  assert.equal(state.postCount, 0);
  assert.equal(state.requestCount, 0, 'immutable request/hash corruption must abort before any API call');

  // 5) Malformed and conflicting historical journals fail before any API call.
  const malformedRoot = path.join(temp, 'malformed');
  const malformed = await writeFixture(malformedRoot, {oldIntent: {...historicalIntent, skuCode: ''}});
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  const malformedRun = await runExecutor(malformed);
  assert.notEqual(malformedRun.code, 0);
  assert.match(malformedRun.stderr, /INVENTORY_JOURNAL_SCOPE_INVALID/);
  assert.equal(state.postCount, 0);
  assert.equal(state.requestCount, 0);

  const conflictRoot = path.join(temp, 'conflicting');
  const conflict = await writeFixture(conflictRoot, {
    oldIntent: {...historicalIntent, intentId: 'conflict-1'},
    extraOldIntent: makeIntent({runDate: twoDaysAgo, row: ROWS[0], planHash: 'f'.repeat(64), intentId: 'conflict-2'}),
  });
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  const conflictRun = await runExecutor(conflict);
  assert.notEqual(conflictRun.code, 0);
  assert.equal(conflictRun.stderr, '', 'ordered pending history must be handled at item scope, not abort journal discovery');
  const conflictResult = await readJson(conflict.resultFile);
  assert.equal(conflictResult.results.find(row => row.storeKey === ROWS[0].storeKey).state, 'needs_manual_resolve');
  assert.equal(conflictResult.results.find(row => row.storeKey === ROWS[1].storeKey).state, 'updated_readback_matched');
  assert.equal(state.postCount, 1, 'one ambiguous SKU must not block the independent current-plan SKU');
  assert.deepEqual(state.postSkus, [ROWS[1].skuCode]);
  assert.ok(state.requestCount > 0, 'the blocked SKU must still receive fresh identity and stock reads under its lock');
  const conflictJournalFiles = (await fs.readdir(path.join(conflictRoot, 'runtime', 'results')))
    .filter(name => name.endsWith('.journal.ndjson'))
    .map(name => path.join(conflictRoot, 'runtime', 'results', name));
  const conflictJournalRows = (await Promise.all(conflictJournalFiles.map(journalEntries))).flat();
  const conflictIntentIds = new Set(['conflict-1', 'conflict-2']);
  assert.equal(
    conflictJournalRows.filter(row => row.kind === 'write_outcome' && conflictIntentIds.has(row.intentId)).length,
    0,
    'multiple pending intents must append no terminal or supersede outcome for the blocked SKU',
  );

  // 5a) Reconcile-only must retain the same item-scoped behavior: two tied
  // pending intents block only that SKU, while an independent exact readback
  // closes normally without a POST.
  const reconcileConflictRoot = path.join(temp, 'reconcile-conflicting');
  const reconcileConflict = await writeFixture(reconcileConflictRoot);
  const tiedRecordedAt = new Date(Date.now() - 5_000).toISOString();
  const reconcileConflictIntents = [
    makeIntent({runDate: today, row: ROWS[0], planHash: reconcileConflict.plan.payloadHash, intentId: 'reconcile-conflict-1', recordedAt: tiedRecordedAt}),
    makeIntent({runDate: today, row: ROWS[0], planHash: reconcileConflict.plan.payloadHash, intentId: 'reconcile-conflict-2', recordedAt: tiedRecordedAt}),
    makeIntent({runDate: today, row: ROWS[1], planHash: reconcileConflict.plan.payloadHash, intentId: 'reconcile-independent-1'}),
  ];
  await writeJournalRows(reconcileConflict.currentIntentFile, reconcileConflictIntents);
  state.stock.set(ROWS[0].skuCode, 2);
  state.stock.set(ROWS[1].skuCode, ROWS[1].targetUsableInventory);
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  const reconcileConflictRun = await runExecutor(reconcileConflict, {reconcilePendingOnly: true});
  assert.notEqual(reconcileConflictRun.code, 0);
  assert.equal(reconcileConflictRun.stderr, '', 'reconcile-only ambiguity must remain item-scoped');
  const reconcileConflictResult = await readJson(reconcileConflict.resultFile);
  assert.equal(reconcileConflictResult.results.find(row => row.storeKey === ROWS[0].storeKey).state, 'needs_manual_resolve');
  assert.equal(reconcileConflictResult.results.find(row => row.storeKey === ROWS[1].storeKey).state, 'updated_readback_matched');
  assert.equal(state.postCount, 0, 'reconcile-only may close exact readbacks but must never issue an inventory POST');
  const reconcileConflictRows = await journalEntries(reconcileConflict.currentIntentFile);
  assert.equal(
    reconcileConflictRows.filter(row => row.kind === 'write_outcome' && ['reconcile-conflict-1', 'reconcile-conflict-2'].includes(row.intentId)).length,
    0,
    'reconcile-only ambiguity must append no terminal outcome for the blocked SKU',
  );
  assert.equal(
    reconcileConflictRows.filter(row => row.kind === 'write_outcome' && row.intentId === 'reconcile-independent-1' && row.disposition === 'readback_matched').length,
    1,
    'reconcile-only must close the independent exact-readback intent once',
  );

  // 5b) Exact legacy audit rows are audit-only, while extra keys, sequence
  // gaps, and per-file planHash drift fail closed before identity/readback API.
  const legacyExtraRoot = path.join(temp, 'legacy-extra-key');
  const legacyExtra = await writeFixture(legacyExtraRoot);
  const legacyExtraRows = makeLegacyAuditRows();
  legacyExtraRows[0].unexpected = true;
  await writeJournalRows(
    path.join(legacyExtraRoot, 'runtime', 'results', `daily-inventory-replenishment-${priorDate}.json.journal.ndjson`),
    legacyExtraRows,
  );
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  const legacyExtraRun = await runExecutor(legacyExtra);
  assert.notEqual(legacyExtraRun.code, 0);
  assert.match(legacyExtraRun.stderr, /INVENTORY_JOURNAL_LEGACY_AUDIT_INVALID:.*:topLevelKeys/);
  assert.equal(state.postCount, 0);
  assert.equal(state.requestCount, 0, 'legacy extra-key corruption must abort before any API call');

  const legacySequenceRoot = path.join(temp, 'legacy-sequence-gap');
  const legacySequence = await writeFixture(legacySequenceRoot);
  await writeJournalRows(
    path.join(legacySequenceRoot, 'runtime', 'results', `daily-inventory-replenishment-${priorDate}.json.journal.ndjson`),
    makeLegacyAuditRows({sequenceGap: true}),
  );
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  const legacySequenceRun = await runExecutor(legacySequence);
  assert.notEqual(legacySequenceRun.code, 0);
  assert.match(legacySequenceRun.stderr, /INVENTORY_JOURNAL_LEGACY_AUDIT_INVALID:.*:sequence/);
  assert.equal(state.postCount, 0);
  assert.equal(state.requestCount, 0, 'legacy sequence corruption must abort before any API call');

  const legacyHashRoot = path.join(temp, 'legacy-plan-hash-conflict');
  const legacyHash = await writeFixture(legacyHashRoot);
  await writeJournalRows(
    path.join(legacyHashRoot, 'runtime', 'results', `daily-inventory-replenishment-${priorDate}.json.journal.ndjson`),
    makeLegacyAuditRows({conflictingPlanHash: true}),
  );
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  const legacyHashRun = await runExecutor(legacyHash);
  assert.notEqual(legacyHashRun.code, 0);
  assert.match(legacyHashRun.stderr, /INVENTORY_JOURNAL_LEGACY_AUDIT_INVALID:.*:planHashConflict/);
  assert.equal(state.postCount, 0);
  assert.equal(state.requestCount, 0, 'legacy planHash conflict must abort before any API call');

  const legacyTimestampRoot = path.join(temp, 'legacy-invalid-calendar-timestamp');
  const legacyTimestamp = await writeFixture(legacyTimestampRoot);
  await writeJournalRows(
    path.join(legacyTimestampRoot, 'runtime', 'results', `daily-inventory-replenishment-${priorDate}.json.journal.ndjson`),
    makeLegacyAuditRows({invalidRecordedAt: true}),
  );
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  const legacyTimestampRun = await runExecutor(legacyTimestamp);
  assert.notEqual(legacyTimestampRun.code, 0);
  assert.match(legacyTimestampRun.stderr, /INVENTORY_JOURNAL_LEGACY_AUDIT_INVALID:.*:recordedAt/);
  assert.equal(state.postCount, 0);
  assert.equal(state.requestCount, 0, 'invalid legacy audit calendar timestamp must abort before any API call');

  // 6) A future-dated journal is invalid before any API call, just like a
  // future plan. The journal filename itself is part of the date proof.
  const futureJournalRoot = path.join(temp, 'future-journal');
  const futureJournalFixture = await writeFixture(futureJournalRoot);
  const futureJournalFile = path.join(
    futureJournalRoot,
    'runtime',
    'results',
    `daily-inventory-replenishment-${futureDate}.json.journal.ndjson`,
  );
  await fs.writeFile(futureJournalFile, `${JSON.stringify(makeIntent({runDate: futureDate, row: ROWS[0], planHash: 'g'.repeat(64), intentId: 'future-journal-1'}))}\n`);
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  const futureJournalRun = await runExecutor(futureJournalFixture);
  assert.notEqual(futureJournalRun.code, 0);
  assert.match(futureJournalRun.stderr, /INVENTORY_JOURNAL_FUTURE_DATE/);
  assert.equal(state.postCount, 0);
  assert.equal(state.requestCount, 0);

  // 7) A prior-date reconcile-only plan is valid, but it can only read back.
  const reconcileRoot = path.join(temp, 'reconcile-prior-date');
  const historicalPolicyVersion = '2026-08-12.2';
  const reconcilePlan = makePlan(priorDate, [ROWS[0]], [], historicalPolicyVersion);
  const reconcile = await writeFixture(reconcileRoot, {date: priorDate, rows: [ROWS[0]]});
  reconcile.plan = reconcilePlan;
  await fs.writeFile(reconcile.planFile, `${JSON.stringify(reconcilePlan, null, 2)}\n`);
  const reconcileIntent = makeIntent({
    runDate: priorDate,
    row: ROWS[0],
    planHash: reconcilePlan.payloadHash,
    intentId: 'reconcile-prior-date-1',
    target: 10,
    beforeTotal: 9,
    beforeUsable: 8,
    beforeLocked: 0,
    policyVersion: historicalPolicyVersion,
  });
  await fs.writeFile(reconcile.currentIntentFile, `${JSON.stringify(reconcileIntent)}\n`);
  state.postCount = 0;
  state.requestCount = 0;
  state.stock = new Map([[ROWS[0].skuCode, 10]]);
  const reconcileRun = await runExecutor(reconcile, {reconcilePendingOnly: true});
  assert.equal(reconcileRun.code, 0, `prior-date reconcile-only must be allowed\nstdout=${reconcileRun.stdout}\nstderr=${reconcileRun.stderr}`);
  assert.equal(state.postCount, 0);
  assert.equal((await readJson(reconcile.resultFile)).results[0].state, 'updated_readback_matched');

  // A future plan is never accepted, even if it is marked reconcile-only.
  const futureRoot = path.join(temp, 'future-plan');
  const future = await writeFixture(futureRoot, {date: futureDate, rows: [ROWS[0]]});
  state.postCount = 0;
  state.requestCount = 0;
  const futureRun = await runExecutor(future, {reconcilePendingOnly: true});
  assert.notEqual(futureRun.code, 0);
  assert.match(futureRun.stderr, /Plan date is in the future/);
  assert.equal(state.postCount, 0);
  assert.equal(state.requestCount, 0);

  console.log(JSON.stringify({ok: true, checks: [
    'additional_daily_et_journal_discovery_deduplicates_paths_and_inodes',
    'default_pending_scope_conflict_and_explicit_chronology_order',
    'historical_pending_freezes_one_scope_independent_current_posts',
    'valid_legacy_audit_rows_are_ignored_alongside_durable_journals',
    'non_daily_prefix_historical_pending_intercepts_scope',
    'absent_historical_scope_is_audit_only_without_duplicate_rows',
    'historical_readback_match_closes_original_journal_and_defers_current_scope',
    'generic_executor_does_not_startup_supersede_historical_pending',
    'generic_executor_does_not_supersede_rejected_or_same_date_later_intents',
    'supersede_validator_rejects_later_pending_at_closure',
    'supersede_validator_ignores_intent_created_after_closure',
    'supersede_validator_rejects_tied_latest_successors',
    'rejected_lifecycle_does_not_supersede',
    'same_time_and_out_of_order_supersede_references_rejected',
    'current_pending_without_later_terminal_remains_zero_post',
    'strict_supersede_shape_and_reference_validation',
    'immutable_request_hash_corruption_fails_before_api',
    'multiple_pending_scope_is_item_scoped_no_outcome_independent_row_continues',
    'reconcile_only_multiple_pending_scope_is_item_scoped_independent_readback_closes',
    'legacy_audit_extra_key_sequence_and_plan_hash_corruption_fail_before_api',
    'future_journal_rejected',
    'prior_date_reconcile_only_has_zero_posts',
    'future_plan_rejected',
  ]}, null, 2));
} finally {
  server.close();
  await fs.rm(temp, {recursive: true, force: true});
  for (const row of ROWS) {
    const lockName = `daily-inventory-${row.storeKey}-${row.skc}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    await fs.rm(path.join(ROOT, 'state', 'locks', lockName), {force: true});
    await fs.rm(path.join(ROOT, 'state', 'locks', `${lockName}.tickets`), {recursive: true, force: true});
  }
}
