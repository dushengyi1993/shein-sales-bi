#!/usr/bin/env node

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  computeInventoryOverwriteQuantity,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';
import {
  inventoryRecoveryScopeKey,
} from '../lib/durable_inventory_write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policyFile = path.join(ROOT, 'config', 'inventory_replenishment_policy.json');
const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'));
const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const priorDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(Date.now() - 86_400_000));
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

function makePlan(date, rows, sourceEvidence = []) {
  const body = {
    schemaVersion: 'daily-inventory-replenishment-plan/v1',
    date,
    policyVersion: policy.policyVersion,
    executable: true,
    blockers: [],
    actionable: rows,
    lowEtAllocations: [],
    sourceEvidence,
  };
  return {
    ...body,
    payloadHash: stableInventoryHash({
      schemaVersion: body.schemaVersion,
      date: body.date,
      policyVersion: body.policyVersion,
      actionable: body.actionable,
      lowEtAllocations: body.lowEtAllocations,
      sourceEvidence: body.sourceEvidence,
    }),
  };
}

function makeIntent({runDate, row, planHash, intentId, target = row.targetUsableInventory, beforeUsable = 2}) {
  const logicalActionKey = actionKey(runDate, row, target);
  const before = {
    skuCode: row.skuCode,
    totalInventoryQuantity: beforeUsable,
    totalUsableInventory: beforeUsable,
    totalLockedQuantity: 0,
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
      changeQuantity: computeInventoryOverwriteQuantity(target, before),
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
    policyVersion: policy.policyVersion,
    authorizationId,
    idempotencyKey: request.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
    requestPayloadHash: stableInventoryHash(request),
    request,
    before,
    recordedAt: new Date().toISOString(),
  };
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
  // 1) D-day pending intent freezes only ZX; independent ZY completes on D+1.
  const firstRoot = path.join(temp, 'historical-pending');
  const historicalIntent = makeIntent({runDate: priorDate, row: ROWS[0], planHash: 'd'.repeat(64), intentId: 'historical-pending-1'});
  const first = await writeFixture(firstRoot, {oldIntent: historicalIntent});
  state.mode = 'historical_pending';
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  state.stock = new Map([[ROWS[0].skuCode, 2], [ROWS[1].skuCode, 2]]);
  const firstRun = await runExecutor(first);
  assert.equal(firstRun.code, 1, `historical mismatch must remain blocked\nstdout=${firstRun.stdout}\nstderr=${firstRun.stderr}`);
  assert.equal(state.postCount, 1, 'independent current scope must issue exactly one POST');
  assert.deepEqual(state.postSkus, [ROWS[1].skuCode], 'historical ZX scope must receive zero POSTs');
  const firstResult = await readJson(first.resultFile);
  const historicalResult = firstResult.results.find(row => row.storeKey === ROWS[0].storeKey);
  const independentResult = firstResult.results.find(row => row.storeKey === ROWS[1].storeKey);
  assert.equal(historicalResult.state, 'submitted_but_readback_pending');
  assert.equal(historicalResult.historicalPending, true);
  assert.equal(historicalResult.disposition, 'skipped');
  assert.equal(independentResult.state, 'updated_readback_matched');
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
  const twoDaysAgo = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(Date.now() - 2 * 86_400_000));
  const conflict = await writeFixture(conflictRoot, {
    oldIntent: {...historicalIntent, intentId: 'conflict-1'},
    extraOldIntent: makeIntent({runDate: twoDaysAgo, row: ROWS[0], planHash: 'f'.repeat(64), intentId: 'conflict-2'}),
  });
  state.postCount = 0;
  state.postSkus = [];
  state.requestCount = 0;
  const conflictRun = await runExecutor(conflict);
  assert.notEqual(conflictRun.code, 0);
  assert.match(conflictRun.stderr, /INVENTORY_JOURNAL_PENDING_SCOPE_CONFLICT/);
  assert.equal(state.postCount, 0);
  assert.equal(state.requestCount, 0);

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
  const reconcilePlan = makePlan(priorDate, [ROWS[0]]);
  const reconcile = await writeFixture(reconcileRoot, {date: priorDate, rows: [ROWS[0]]});
  reconcile.plan = reconcilePlan;
  await fs.writeFile(reconcile.planFile, `${JSON.stringify(reconcilePlan, null, 2)}\n`);
  const reconcileIntent = makeIntent({runDate: priorDate, row: ROWS[0], planHash: reconcilePlan.payloadHash, intentId: 'reconcile-prior-date-1'});
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
    'historical_pending_freezes_one_scope_independent_current_posts',
    'non_daily_prefix_historical_pending_intercepts_scope',
    'absent_historical_scope_is_audit_only_without_duplicate_rows',
    'historical_readback_match_closes_original_journal_and_defers_current_scope',
    'immutable_request_hash_corruption_fails_before_api',
    'malformed_and_conflicting_historical_journals_fail_before_api',
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
