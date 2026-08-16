#!/usr/bin/env node

// Regression for the 2026-08-16 inventory plan defect: the planner bound ET
// rows and grouping through canonicalInventoryKey, so two products that the
// alias catalog explicitly keeps separate (KJ-102S三明治机和早餐机 vs
// KJ-102三明治机和早餐机, both collapsing to "KJ102") shared the same ET row,
// produced the wrong canonical / etSellableInventory, and the executor then
// correctly blocked the action as canonical identity drift.
//
// The fix unifies the planner AND the executor readback guard on the
// alias-resolved identity (resolveInventoryIdentityKey) for:
//   - ET lookup (etLookupKey): an ET candidate's standard_goods_sn must match
//     the product's resolved identity, otherwise it is "no match" -- a
//     canonical-form hit is NEVER borrowed from another product;
//   - sameStoreOnShelf / otherSellingStores grouping (identityGroupingKey);
//   - ET alerts.
//
// Real-behavior scenarios against the real builder + real executor child:
//   1. KJ-102S (Z1/Z2) and KJ-102 (Z3) never share ET/action grouping;
//   2. fail closed: without a KJ-102S ET row, KJ-102S links are blocked
//      (et_canonical_identity_ambiguous) and generate no action, while the
//      KJ-102 link keeps its own action;
//   3. executor end-to-end on scenario 1's plan: no canonical identity drift,
//      all actions complete (the production incident shape).

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-kj102-separation-'));
const date = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const now = new Date().toISOString();
const policyFile = path.join(ROOT, 'config', 'inventory_replenishment_policy.json');

const productsDir = path.join(tmp, 'products');
const storesFile = path.join(tmp, 'stores.json');
const biFile = path.join(tmp, 'inventoryTrend.json');
await fs.writeFile(storesFile, JSON.stringify({stores: [
  {storeKey: 'Z1', enabled: true},
  {storeKey: 'Z2', enabled: true},
  {storeKey: 'Z3', enabled: true},
]}));

// Z1/Z2 carry the KJ-102S product (production incident: DX/FY links with
// supplierCode KJ-102S三明治机和早餐机); Z3 carries the explicitly separate
// KJ-102 product.
const PRODUCT_ROWS = [
  {
    storeKey: 'Z1',
    spu: 'sv260103161884632314900',
    skc: 'skc-z1-102s',
    skuCodes: ['sku-z1-102s'],
    supplierCode: 'KJ-102S三明治机和早餐机',
    shelfStatusCode: '1',
    sheinUsableInventory: 2,
    sheinInventoryQuantity: 2,
    sheinLockedQuantity: 0,
    sourceCompleteness: {hasCurrentDetail: true},
  },
  {
    storeKey: 'Z2',
    spu: 'sv25100433356398937',
    skc: 'skc-z2-102s',
    skuCodes: ['sku-z2-102s'],
    supplierCode: 'KJ-102S三明治机和早餐机',
    shelfStatusCode: '1',
    sheinUsableInventory: 2,
    sheinInventoryQuantity: 2,
    sheinLockedQuantity: 0,
    sourceCompleteness: {hasCurrentDetail: true},
  },
  {
    storeKey: 'Z3',
    spu: 'spu-z3-102',
    skc: 'skc-z3-102',
    skuCodes: ['sku-z3-102'],
    supplierCode: 'KJ-102三明治机和早餐机',
    shelfStatusCode: '1',
    sheinUsableInventory: 2,
    sheinInventoryQuantity: 2,
    sheinLockedQuantity: 0,
    sourceCompleteness: {hasCurrentDetail: true},
  },
  {
    // Z1 also hosts the explicitly separate KJ-102 product on a second SKC:
    // same-store grouping must never merge it with the KJ-102S SKC.
    storeKey: 'Z1',
    spu: 'spu-z1-102',
    skc: 'skc-z1-102',
    skuCodes: ['sku-z1-102'],
    supplierCode: 'KJ-102三明治机和早餐机',
    shelfStatusCode: '1',
    sheinUsableInventory: 2,
    sheinInventoryQuantity: 2,
    sheinLockedQuantity: 0,
    sourceCompleteness: {hasCurrentDetail: true},
  },
];
const productsByStore = new Map();
for (const row of PRODUCT_ROWS) {
  if (!productsByStore.has(row.storeKey)) productsByStore.set(row.storeKey, []);
  productsByStore.get(row.storeKey).push(row);
}
for (const [storeKey, rows] of productsByStore) {
  await fs.mkdir(path.join(productsDir, storeKey), {recursive: true});
  await fs.writeFile(path.join(productsDir, storeKey, 'latest.json'), JSON.stringify({
    fetchedAt: now,
    summary: {stockFailedChunkCount: 0, detailMissingAfterFallbackCount: 0},
    normalizedRows: rows,
  }));
}

const LINKS = {
  cachedAt: now,
  data: {
    storeLinks: [
      {store_key: 'Z1', skc: 'skc-z1-102s', standard_goods_sn: 'KJ-102S三明治机和早餐机', is_on_shelf: true, c7_eps_uv: 100, c7_goods_uv: 10, c7_sale_cnt: 2, c30_sale_cnt: 10},
      {store_key: 'Z2', skc: 'skc-z2-102s', standard_goods_sn: 'KJ-102S三明治机和早餐机', is_on_shelf: true, c7_eps_uv: 90, c7_goods_uv: 9, c7_sale_cnt: 2, c30_sale_cnt: 9},
      {store_key: 'Z3', skc: 'skc-z3-102', standard_goods_sn: 'KJ-102三明治机和早餐机', is_on_shelf: true, c7_eps_uv: 80, c7_goods_uv: 8, c7_sale_cnt: 2, c30_sale_cnt: 8},
      {store_key: 'Z1', skc: 'skc-z1-102', standard_goods_sn: 'KJ-102三明治机和早餐机', is_on_shelf: true, c7_eps_uv: 70, c7_goods_uv: 7, c7_sale_cnt: 2, c30_sale_cnt: 7},
    ],
  },
};

const ET_ROWS = [
  {
    match_key: 'KJ-102S三明治机和早餐机',
    standard_goods_sn: 'KJ-102S三明治机和早餐机',
    current_sellable_quantity: 126,
    et_store_snapshot_date: date,
    inventory_match_status: 'matched',
    days_of_supply_on_hand: 100,
  },
  {
    match_key: 'KJ-102三明治机和早餐机',
    standard_goods_sn: 'KJ-102三明治机和早餐机',
    current_sellable_quantity: 200,
    et_store_snapshot_date: date,
    inventory_match_status: 'matched',
    days_of_supply_on_hand: 100,
  },
];

async function buildPlan(etRows, name) {
  await fs.writeFile(biFile, JSON.stringify({
    cachedAt: now,
    data: {inventoryDepletion: {products: etRows}},
  }));
  const linksFile = path.join(tmp, `${name}-links.json`);
  await fs.writeFile(linksFile, JSON.stringify(LINKS));
  const out = path.join(tmp, `${name}-plan.json`);
  const savedArgv = process.argv;
  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  process.argv = [
    process.execPath,
    path.join(ROOT, 'scripts', 'inventory', 'build_daily_inventory_replenishment_plan.mjs'),
    '--date', date,
    '--policy', policyFile,
    '--stores', storesFile,
    '--products-dir', productsDir,
    '--bi-data', biFile,
    '--links-data', linksFile,
    '--operation-mode', 'daily',
    '--out', out,
  ];
  try {
    await import(`./inventory/build_daily_inventory_replenishment_plan.mjs?kj102-separation=${name}-${Date.now()}`);
  } finally {
    process.argv = savedArgv;
    process.exitCode = savedExitCode;
  }
  return JSON.parse(await fs.readFile(out, 'utf8'));
}

// ---------------------------------------------------------------------------
// Scenario 1: KJ-102S and KJ-102 never share ET / grouping / actions
// ---------------------------------------------------------------------------
const plan = await buildPlan(ET_ROWS, 'separated');
assert.equal(plan.executable, true, plan.blockers.join('; '));
assert.equal(plan.blockers.length, 0, plan.blockers.join('; '));

const kj102sActions = plan.actionable.filter(row => row.matchKey === 'KJ-102S三明治机和早餐机');
const kj102Actions = plan.actionable.filter(row => row.matchKey === 'KJ-102三明治机和早餐机');
assert.equal(kj102sActions.length, 2, 'both KJ-102S links must generate their own actions');
assert.equal(kj102Actions.length, 2, 'both KJ-102 links must generate their own actions');
for (const row of kj102sActions) {
  assert.equal(row.canonical, 'KJ-102S三明治机和早餐机', 'KJ-102S action must carry its own canonical');
  assert.equal(row.etSellableInventory, 126, 'KJ-102S action must use its own ET row, never the KJ-102 value');
  assert.equal(row.targetUsableInventory, 10);
}
for (const row of kj102Actions) {
  assert.equal(row.canonical, 'KJ-102三明治机和早餐机', 'KJ-102 action must carry its own canonical');
  assert.equal(row.etSellableInventory, 200, 'KJ-102 action must use its own ET row, never the KJ-102S value');
  assert.equal(row.targetUsableInventory, 10);
}
assert.equal(plan.actionable.some(row => row.matchKey === 'KJ-102S三明治机和早餐机' && row.canonical !== 'KJ-102S三明治机和早餐机'), false);
assert.equal(plan.actionable.some(row => row.matchKey === 'KJ-102三明治机和早餐机' && row.canonical !== 'KJ-102三明治机和早餐机'), false);

// sameStoreOnShelf separation: Z1 hosts both products on two SKCs; neither
// may see the other as the same canonical (previously both collapsed to KJ102
// and were treated as the same store link).
const z1Kj102s = kj102sActions.find(row => row.storeKey === 'Z1');
const z1Kj102 = kj102Actions.find(row => row.storeKey === 'Z1');
assert.deepEqual(z1Kj102s.sameStoreOnShelfSkcs, [], 'KJ-102S must not group with the same-store KJ-102 SKC');
assert.deepEqual(z1Kj102.sameStoreOnShelfSkcs, [], 'KJ-102 must not group with the same-store KJ-102S SKC');

// otherSellingStores separation: KJ-102S links only see each other.
assert.deepEqual(z1Kj102s.otherSellingStores, ['Z2'], 'KJ-102S cross-store group must exclude the KJ-102 store');
assert.deepEqual(z1Kj102.otherSellingStores, ['Z3'], 'KJ-102 cross-store group must exclude the KJ-102S stores');

// ET alerts separation: the KJ-102S ET row must stay bound to KJ-102S.
const kj102sEtAlerts = plan.etAlerts.filter(row => row.canonical === 'KJ-102S三明治机和早餐机');
assert.ok(kj102sEtAlerts.length >= 1, 'the KJ-102S ET row must be linked to the KJ-102S links');
assert.equal(kj102sEtAlerts[0].etSellableInventory, 126);
assert.equal(plan.etAlerts.some(row => row.canonical === 'KJ-102S三明治机和早餐机' && row.etSellableInventory !== 126), false);
assert.equal(plan.counts.etTotalRows, 2);
assert.equal(plan.counts.etMatchedCurrentDayRows, 2);
assert.equal(plan.counts.etAlertsExcludedNoRelevantLinks, 0);
assert.equal(plan.counts.lowEtAllocatedCanonicalCount, 0);

// ---------------------------------------------------------------------------
// Scenario 2: no KJ-102S ET row -> fail closed, no borrowed ET evidence
// ---------------------------------------------------------------------------
const blockedPlan = await buildPlan(ET_ROWS.slice(1), 'fail-closed');
assert.equal(
  blockedPlan.actionable.some(row => row.matchKey === 'KJ-102S三明治机和早餐机'),
  false,
  'without its own ET row the KJ-102S links must never generate an action from the KJ-102 row',
);
assert.ok(
  blockedPlan.linkAlerts.some(row => row.matchKey === 'KJ-102S三明治机和早餐机' && row.decision === 'et_canonical_identity_ambiguous'),
  'the alias miss with a canonical hit must be recorded as et_canonical_identity_ambiguous',
);
assert.equal(
  blockedPlan.actionable.some(row => row.matchKey === 'KJ-102三明治机和早餐机'),
  true,
  'the KJ-102 link must keep its own action',
);
assert.equal(blockedPlan.actionable.some(row => row.matchKey === 'KJ-102三明治机和早餐机' && row.etSellableInventory !== 200), false);

// ---------------------------------------------------------------------------
// Scenario 3: executor end-to-end on the separated plan (production shape)
// ---------------------------------------------------------------------------
const products = PRODUCT_ROWS.map(row => ({
  storeKey: row.storeKey,
  spu: row.spu,
  skc: row.skc,
  skuCode: row.skuCodes[0],
  supplierCode: row.supplierCode,
}));
let server;
let postCount = 0;
const postedSkus = new Set();
const serverReady = new Promise((resolve, reject) => {
  server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      const send = payload => {
        response.writeHead(200, {'content-type': 'application/json'});
        response.end(`${JSON.stringify(payload)}\n`);
      };
      if (request.method === 'POST' && pathname === '/open-api/openapi-business-backend/query-store-info') {
        return send({code: '0', info: {}});
      }
      if (request.method === 'POST' && pathname === '/open-api/goods/spu-info') {
        const product = products.find(row => row.spu === body?.spuName);
        if (!product) return send({code: '404', msg: 'unknown spu'});
        return send({code: '0', info: {
          supplierCode: product.supplierCode,
          skcInfoList: [{
            skcName: product.skc,
            shelfStatusInfoList: [{siteAbbr: 'shein-sa', shelfStatus: '1'}],
            skuInfoList: [{skuCode: product.skuCode}],
          }],
        }});
      }
      if (request.method === 'POST' && pathname === '/open-api/stock/stock-query') {
        const skuCode = body?.skuCodeList?.[0] || '';
        // Pre-write reads return below the refill band; post-write readbacks
        // return the exact approved target so the executor completes.
        const usable = postedSkus.has(skuCode) ? 10 : 2;
        return send({code: '0', info: [{goodsInventory: [{skuList: [{
          skuCode,
          totalInventoryQuantity: usable,
          totalUsableInventory: usable,
          totalLockedQuantity: 0,
          warehouseInventoryList: [],
        }]}]}]});
      }
      if (request.method === 'POST' && pathname === '/open-api/stock/change-inventory/v2') {
        postCount += 1;
        postedSkus.add(body?.updateSkuInventoryQuantityRequests?.[0]?.skuCode || '');
        return send({code: '0', info: {success: true}});
      }
      if (request.method === 'GET' && pathname === '/open-api/msc/warehouse/list') {
        return send({code: '0', info: []});
      }
      return send({code: '404', msg: `unexpected ${request.method} ${pathname}`});
    });
  });
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const port = await serverReady;

try {
  // Scenario 2 overwrote the shared ET file with only the KJ-102 row; restore
  // the full separated ET rows for the executor end-to-end run.
  await fs.writeFile(biFile, JSON.stringify({
    cachedAt: now,
    data: {inventoryDepletion: {products: ET_ROWS}},
  }));
  const configFile = path.join(tmp, 'openapi.local.json');
  await fs.writeFile(configFile, JSON.stringify({
    apiBaseUrls: {prodSemiManaged: `http://127.0.0.1:${port}`},
    stores: products.map(row => ({storeKey: row.storeKey, enabled: true, openKeyId: `${row.storeKey}-key`, secretKey: `${row.storeKey}-secret`})),
  }));
  const planFile = path.join(tmp, 'separated-plan.json');
  const outFile = path.join(tmp, 'executor-result.json');
  const child = spawn(process.execPath, [
    'scripts/inventory/execute_daily_inventory_replenishment_plan.mjs',
    '--plan', planFile,
    '--policy', policyFile,
    '--config', configFile,
    '--bi-data', biFile,
    '--links-data', path.join(tmp, 'separated-links.json'),
    '--out', outFile,
    '--execute',
    '--execution-mode', 'automatic',
    '--confirm-hash', plan.payloadHash,
    '--max-rows', '10',
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
  assert.equal(status, 0, `executor must complete the separated plan, got status=${status}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.doesNotMatch(stderr, /canonical identity|ReferenceError/, 'no canonical identity drift and no crash');
  assert.equal(postCount, 4, 'exactly one write per separated action');
  const result = JSON.parse(await fs.readFile(outFile, 'utf8'));
  assert.equal(result.results.length, 4);
  assert.ok(result.results.every(row => row.state === 'updated_readback_matched'));
  const stdoutLines = stdout.trim().split('\n');
  let executorCounts = null;
  for (let index = stdoutLines.length - 1; index >= 0; index -= 1) {
    try { executorCounts = JSON.parse(stdoutLines.slice(index).join('\n'))?.counts; break; } catch {}
  }
  assert.equal(executorCounts?.updated, 4, `executor stdout counts:\n${stdout}`);
} finally {
  server.close();
  for (const product of products) {
    const lockName = `daily-inventory-${product.storeKey}-${product.skc}`.replace(/[^A-Za-z0-9_.-]/g, '_');
    await fs.rm(path.join(ROOT, 'state', 'locks', lockName), {force: true});
    await fs.rm(path.join(ROOT, 'state', 'locks', `${lockName}.tickets`), {recursive: true, force: true});
  }
  await fs.rm(tmp, {recursive: true, force: true});
}

console.log('inventory_planner_kj102_separation: KJ-102S/KJ-102 keep separate ET rows, groupings, ET alerts and actions; alias-miss fails closed; executor completes without identity drift');
console.log(JSON.stringify({ok: true, tests: ['separated-et-grouping-actions', 'fail-closed-no-borrowed-et', 'executor-end-to-end-no-drift']}, null, 2));
