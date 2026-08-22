#!/usr/bin/env node

// Real-behavior regression for the durable inventory write executor:
// scripts/inventory/execute_daily_inventory_replenishment_plan.mjs.
//
// The production incident: on plan hash 345219... the executor wrote two
// distinct durable intents, then the row-level catch crashed with
// `ReferenceError: activeIntent is not defined` at the catch block.  The
// cause was a block-scoping bug: `let activeIntent` was declared inside the
// outer per-row try (before the inner lock try), so the outer catch could not
// see it, and every write-error path (transport failure, ambiguous response
// handling that throws) was replaced by an uncaught crash instead of the
// required `suspicious_write_attempted` / `needs_manual_resolve` record.
//
// This test drives the REAL executor as a child process against a local HTTP
// server that impersonates the SHEIN OpenAPI surface, with a real plan whose
// payloadHash matches the executor's exact stable hash, real policy and real
// durable journal semantics:
//
//   A. first run: change-inventory responses missing explicit code=0 /
//      info.success=true -> two needs_manual_resolve rows, both durable
//      intents retained, no ReferenceError crash;
//   B. rerun of A: readback-only recovery, target matched -> write_outcome +
//      updated_readback_matched, target not matched ->
//      submitted_but_readback_pending, zero second POST;
//   C. fresh run: transport error while POSTing -> suspicious_write_attempted
//      (durable intent retained), the catch must NOT crash with
//      ReferenceError;
//   D. rerun of C: readback-only recovery with matched target -> write_outcome
//      + updated_readback_matched, zero second POST.

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'execute-inventory-durable-'));
const policyFile = path.join(ROOT, 'config', 'inventory_replenishment_policy.json');
const policy = JSON.parse(await fs.readFile(policyFile, 'utf8'));

const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const biCachedAt = new Date().toISOString();
const linksCachedAt = new Date().toISOString();

// Two distinct actions on two distinct stores (keys absent from
// store_account_truth.json so the identity gate takes the lenient branch).
const ROWS = [
  {
    storeKey: 'ZZ',
    skc: 'ZZ-01-SKC',
    skuCode: 'ZZ-01-SKU',
    spu: 'ZZ-01-SPU',
    canonical: 'SK-ZZ-001',
    matchKey: 'SK-ZZ-001',
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
    skc: 'ZY-01-SKC',
    skuCode: 'ZY-01-SKU',
    spu: 'ZY-01-SPU',
    canonical: 'SK-ZY-001',
    matchKey: 'SK-ZY-001',
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

const sourceEvidence = [
  {store: 'ET', fetchedAt: biCachedAt, file: path.join(temp, 'inventoryTrend.json')},
  {store: 'BI_LINKS', fetchedAt: linksCachedAt, file: path.join(temp, 'linksData.json')},
];
const planBody = {
  schemaVersion: 'daily-inventory-replenishment-plan/v1',
  date: today,
  policyVersion: policy.policyVersion,
  executable: true,
  blockers: [],
  actionable: ROWS,
  lowEtAllocations: [],
  sourceEvidence,
};
const payloadHash = stableInventoryHash({
  schemaVersion: planBody.schemaVersion,
  date: planBody.date,
  policyVersion: planBody.policyVersion,
  actionable: planBody.actionable,
  lowEtAllocations: planBody.lowEtAllocations,
  sourceEvidence: sourceEvidence.map(({ageHours: _ageHours, ...evidence}) => evidence),
});
const plan = {...planBody, payloadHash};

const planFile = path.join(temp, 'plan.json');
const biFile = path.join(temp, 'inventoryTrend.json');
const linksFile = path.join(temp, 'linksData.json');
const configFile = path.join(temp, 'openapi.local.json');
await Promise.all([
  fs.writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`),
  fs.writeFile(biFile, `${JSON.stringify({
    cachedAt: biCachedAt,
    data: {
      inventoryDepletion: {
        products: ROWS.map(row => ({
          match_key: row.matchKey,
          current_sellable_quantity: row.etSellableInventory,
          et_store_snapshot_date: today,
          inventory_match_status: 'matched',
          et_operational_stock_policy: '',
        })),
      },
    },
  }, null, 2)}\n`),
  fs.writeFile(linksFile, `${JSON.stringify({
    cachedAt: linksCachedAt,
    storeLinks: ROWS.map(row => ({
      store_key: row.storeKey,
      skc: row.skc,
      standard_goods_sn: row.canonical,
      is_on_shelf: true,
      c7_sale_cnt: row.c7SaleCount,
      c7_eps_uv: row.c7Exposure,
    })),
  }, null, 2)}\n`),
]);

let server;
let serverState = {mode: 'ambiguous', postCount: 0, requestCount: 0};

function sendJson(response, payload, status = 200) {
  response.writeHead(status, {'content-type': 'application/json'});
  response.end(`${JSON.stringify(payload)}\n`);
}

function stockUsableFor(skuCode) {
  const row = ROWS.find(candidate => candidate.skuCode === skuCode);
  if (!row) return 0;
  if (serverState.mode === 'recovery-mixed') {
    return row.storeKey === 'ZZ' ? row.targetUsableInventory : 3;
  }
  if (serverState.mode === 'recovery-matched') {
    return row.targetUsableInventory;
  }
  // ambiguous / transport-error first runs: before = 2 (below refill band 5)
  return 2;
}

const serverReady = new Promise((resolve, reject) => {
  server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      serverState.requestCount += 1;
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      if (request.method === 'POST' && pathname === '/open-api/openapi-business-backend/query-store-info') {
        return sendJson(response, {code: '0', info: {}});
      }
      if (request.method === 'POST' && pathname === '/open-api/goods/spu-info') {
        const row = ROWS.find(candidate => candidate.spu === body?.spuName);
        if (!row) return sendJson(response, {code: '404', msg: 'unknown spu'});
        return sendJson(response, {
          code: '0',
          info: {
            supplierCode: row.canonical,
            skcInfoList: [{
              skcName: row.skc,
              shelfStatusInfoList: [{siteAbbr: 'shein-sa', shelfStatus: '1'}],
              skuInfoList: [{skuCode: row.skuCode}],
            }],
          },
        });
      }
      if (request.method === 'POST' && pathname === '/open-api/stock/stock-query') {
        const skuCode = body?.skuCodeList?.[0] || '';
        const usable = stockUsableFor(skuCode);
        return sendJson(response, {
          code: '0',
          info: [{
            goodsInventory: [{
              skuList: [{
                skuCode,
                totalInventoryQuantity: usable,
                totalUsableInventory: usable,
                totalLockedQuantity: 0,
                warehouseInventoryList: [],
              }],
            }],
          }],
        });
      }
      if (request.method === 'POST' && pathname === '/open-api/stock/change-inventory/v2') {
        serverState.postCount += 1;
        if (serverState.mode === 'transport-error') {
          request.socket.destroy();
          return;
        }
        if (serverState.mode === 'ambiguous') {
          const skuCode = body?.updateSkuInventoryQuantityRequests?.[0]?.skuCode;
          if (skuCode === ROWS[0].skuCode) {
            // explicit code=0 present but info.success missing -> ambiguous
            return sendJson(response, {code: '0', info: {}});
          }
          // explicit code missing entirely -> ambiguous
          return sendJson(response, {msg: 'ok'});
        }
        return sendJson(response, {code: '0', info: {success: true}});
      }
      if (request.method === 'GET' && pathname === '/open-api/msc/warehouse/list') {
        return sendJson(response, {code: '0', info: []});
      }
      return sendJson(response, {code: '404', msg: `unexpected ${request.method} ${pathname}`});
    });
  });
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const port = await serverReady;

await fs.writeFile(configFile, `${JSON.stringify({
  apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${port}`},
  stores: ROWS.map(row => ({storeKey: row.storeKey, enabled: true, openKeyId: `${row.storeKey}-key`, secretKey: `${row.storeKey}-secret`})),
}, null, 2)}\n`);

async function runExecutor(outFile, {reconcilePendingOnly = false} = {}) {
  const child = spawn(process.execPath, [
    'scripts/inventory/execute_daily_inventory_replenishment_plan.mjs',
    '--plan', planFile,
    '--policy', policyFile,
    '--config', configFile,
    '--bi-data', biFile,
    '--links-data', linksFile,
    '--out', outFile,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', payloadHash,
    '--max-rows', '10',
    ...(reconcilePendingOnly ? ['--reconcile-pending-only'] : []),
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT: 'cloud_daily_inventory_replenishment_guard',
      SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION: 'owner-automatic-inventory-20260803-v1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 60_000);
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(signal ? null : code));
  });
  clearTimeout(timer);
  return {status, stdout, stderr};
}

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const journalEntries = async file => {
  try {
    return (await fs.readFile(file, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
};
const finalStdoutJson = output => {
  const lines = String(output || '').trim().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines.slice(index).join('\n')); } catch {}
  }
  return null;
};
const pendingIntentCount = entries => {
  const intents = entries.filter(entry => entry.kind === 'intent');
  const closed = new Set(entries
    .filter(entry => entry.kind === 'write_outcome' && ['rejected', 'readback_matched'].includes(entry.disposition))
    .map(entry => entry.intentId));
  return intents.filter(entry => !closed.has(entry.intentId)).length;
};

try {
  // -------------------------------------------------------------------------
  // A) first run: responses missing explicit code=0 / info.success=true
  // -------------------------------------------------------------------------
  serverState = {mode: 'ambiguous', postCount: 0, requestCount: 0};
  const outA = path.join(temp, 'a-result.json');
  const runA = await runExecutor(outA);
  assert.equal(runA.status, 1, `run A must exit 1 (blocked), got ${runA.status}\nstdout:\n${runA.stdout}\nstderr:\n${runA.stderr}`);
  assert.doesNotMatch(runA.stderr, /ReferenceError/, 'run A must not crash with ReferenceError');
  assert.equal(serverState.postCount, 2, 'run A must POST exactly two write requests');
  const resultA = await readJson(outA);
  assert.equal(resultA.results.length, 2);
  assert.deepEqual(
    resultA.results.map(row => row.state).sort(),
    ['needs_manual_resolve', 'needs_manual_resolve'],
    'missing explicit code/success must record needs_manual_resolve for every action',
  );
  const journalA = await journalEntries(`${outA}.journal.ndjson`);
  assert.equal(journalA.filter(entry => entry.kind === 'intent').length, 2, 'both durable intents must be retained');
  assert.equal(journalA.filter(entry => entry.kind === 'write_outcome').length, 0, 'ambiguous responses must not write any write_outcome');
  assert.equal(finalStdoutJson(runA.stdout)?.counts?.blocked, 2);

  const originalBiDocument = await readJson(biFile);
  const originalLinksDocument = await readJson(linksFile);
  await fs.writeFile(biFile, `${JSON.stringify({...originalBiDocument, cachedAt: new Date(Date.now() + 1000).toISOString()}, null, 2)}\n`);
  await fs.writeFile(linksFile, `${JSON.stringify({...originalLinksDocument, cachedAt: new Date(Date.now() + 1000).toISOString()}, null, 2)}\n`);

  // -------------------------------------------------------------------------
  // B) rerun of A: readback-only recovery, no second POST
  // -------------------------------------------------------------------------
  serverState = {mode: 'recovery-mixed', postCount: 0, requestCount: 0};
  const runB = await runExecutor(outA, {reconcilePendingOnly: true});
  assert.equal(runB.status, 1, `run B must exit 1 (one pending readback), got ${runB.status}\nstdout:\n${runB.stdout}\nstderr:\n${runB.stderr}`);
  assert.doesNotMatch(runB.stderr, /ReferenceError/, 'run B must not crash with ReferenceError');
  assert.equal(serverState.postCount, 0, 'rerun must never POST a second write');
  const resultB = await readJson(outA);
  assert.deepEqual(
    resultB.results.map(row => row.state).sort(),
    ['submitted_but_readback_pending', 'updated_readback_matched'],
    'matched target completes, unmatched target stays readback-pending',
  );
  const journalB = await journalEntries(`${outA}.journal.ndjson`);
  const outcomesB = journalB.filter(entry => entry.kind === 'write_outcome');
  assert.equal(outcomesB.length, 1, 'exactly one write_outcome must be recorded');
  assert.equal(outcomesB[0].disposition, 'readback_matched');
  const zzIntent = journalB.find(entry => entry.kind === 'intent' && entry.storeKey === 'ZZ');
  assert.equal(outcomesB[0].intentId, zzIntent?.intentId, 'the readback_matched outcome must close the matched ZZ intent');
  assert.equal(pendingIntentCount(journalB), 1, 'only the unmatched intent stays durably pending');
  assert.equal(finalStdoutJson(runB.stdout)?.counts?.updated, 1);

  // -------------------------------------------------------------------------
  // B2) recovery-only must reject a plan that is a strict superset of the
  //     pending scopes before any OpenAPI request, not merely before a write.
  // -------------------------------------------------------------------------
  const outB2 = path.join(temp, 'b2-result.json');
  const firstIntent = journalA.find(entry => entry.kind === 'intent');
  await fs.writeFile(`${outB2}.journal.ndjson`, `${JSON.stringify(firstIntent)}\n`);
  serverState = {mode: 'recovery-matched', postCount: 0, requestCount: 0};
  const runB2 = await runExecutor(outB2, {reconcilePendingOnly: true});
  assert.equal(runB2.status, 1, `run B2 must fail closed, got ${runB2.status}\nstdout:\n${runB2.stdout}\nstderr:\n${runB2.stderr}`);
  assert.match(runB2.stderr, /INVENTORY_RECONCILE_PENDING_ONLY_PRECONDITION_FAILED/);
  assert.equal(serverState.requestCount, 0, 'scope-set mismatch must fail before every OpenAPI request');
  assert.equal(serverState.postCount, 0, 'scope-set mismatch must never create a new inventory write');

  // A later recovery pass must accept the full immutable lifecycle: one scope
  // is already closed by readback_matched and one remains pending. It freshly
  // reads both, never submits, and closes only the remaining intent.
  serverState = {mode: 'recovery-matched', postCount: 0, requestCount: 0};
  const runB3 = await runExecutor(outA, {reconcilePendingOnly: true});
  assert.equal(runB3.status, 0, `run B3 must complete mixed lifecycle recovery, got ${runB3.status}\nstdout:\n${runB3.stdout}\nstderr:\n${runB3.stderr}`);
  assert.equal(serverState.postCount, 0, 'mixed closed/pending lifecycle recovery must never POST');
  const resultB3 = await readJson(outA);
  assert.deepEqual(
    resultB3.results.map(row => row.state).sort(),
    ['skipped_target_already_matched', 'updated_readback_matched'],
  );
  assert.equal(pendingIntentCount(await journalEntries(`${outA}.journal.ndjson`)), 0);
  await fs.writeFile(biFile, `${JSON.stringify(originalBiDocument, null, 2)}\n`);
  await fs.writeFile(linksFile, `${JSON.stringify(originalLinksDocument, null, 2)}\n`);

  // -------------------------------------------------------------------------
  // C) fresh run: transport error while POSTing must not be masked by
  //    ReferenceError; durable intent is retained as suspicious
  // -------------------------------------------------------------------------
  serverState = {mode: 'transport-error', postCount: 0, requestCount: 0};
  const outC = path.join(temp, 'c-result.json');
  const runC = await runExecutor(outC);
  assert.equal(runC.status, 1, `run C must exit 1 (suspicious write), got ${runC.status}\nstdout:\n${runC.stdout}\nstderr:\n${runC.stderr}`);
  assert.doesNotMatch(runC.stderr, /ReferenceError/, 'the row catch must see activeIntent and record suspicious_write_attempted instead of crashing');
  assert.equal(serverState.postCount, 2, 'run C must attempt exactly one write per action');
  const resultC = await readJson(outC);
  assert.equal(resultC.results.length, 2);
  assert.deepEqual(
    resultC.results.map(row => row.state).sort(),
    ['suspicious_write_attempted', 'suspicious_write_attempted'],
  );
  const journalC = await journalEntries(`${outC}.journal.ndjson`);
  assert.equal(journalC.filter(entry => entry.kind === 'intent').length, 2, 'both durable intents must stay in the journal');
  assert.equal(journalC.filter(entry => entry.kind === 'write_outcome').length, 0);
  assert.equal(finalStdoutJson(runC.stdout)?.counts?.blocked, 2);

  // -------------------------------------------------------------------------
  // D) rerun of C: readback-only recovery with matched target
  // -------------------------------------------------------------------------
  serverState = {mode: 'recovery-matched', postCount: 0, requestCount: 0};
  const runD = await runExecutor(outC, {reconcilePendingOnly: true});
  assert.equal(runD.status, 0, `run D must exit 0 (recovered matched), got ${runD.status}\nstdout:\n${runD.stdout}\nstderr:\n${runD.stderr}`);
  assert.doesNotMatch(runD.stderr, /ReferenceError/);
  assert.equal(serverState.postCount, 0, 'rerun must never POST a second write');
  const resultD = await readJson(outC);
  assert.equal(resultD.results.length, 2);
  assert.deepEqual(
    resultD.results.map(row => row.state).sort(),
    ['updated_readback_matched', 'updated_readback_matched'],
  );
  const journalD = await journalEntries(`${outC}.journal.ndjson`);
  const outcomesD = journalD.filter(entry => entry.kind === 'write_outcome');
  assert.equal(outcomesD.length, 2);
  assert.ok(outcomesD.every(entry => entry.disposition === 'readback_matched'));
  assert.equal(pendingIntentCount(journalD), 0, 'the recovered intent must be cleared by its readback_matched outcome');
  assert.equal(finalStdoutJson(runD.stdout)?.counts?.updated, 2);

  console.log('execute_inventory_durable_recovery: ambiguous responses -> needs_manual_resolve, transport error -> suspicious_write_attempted, rerun is readback-only with zero second POST');
  console.log(JSON.stringify({ok: true}));
} finally {
  server.close();
  for (const row of ROWS) {
    const lockName = `daily-inventory-${row.storeKey}-${row.skc}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    await fs.rm(path.join(ROOT, 'state', 'locks', lockName), {force: true});
    await fs.rm(path.join(ROOT, 'state', 'locks', `${lockName}.tickets`), {recursive: true, force: true});
  }
  await fs.rm(temp, {recursive: true, force: true});
}
