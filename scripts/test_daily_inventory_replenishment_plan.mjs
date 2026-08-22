#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildDailyInventoryPlanHashPayload, stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-inventory-plan-'));
const date = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const now = new Date().toISOString();
const productsDir = path.join(tmp, 'products');
await fs.mkdir(path.join(productsDir, 'A'), {recursive: true});
await fs.mkdir(path.join(productsDir, 'B'), {recursive: true});

const productRows = [
  ...[1, 2, 3, 4, 5, 6].map(index => ({
    storeKey: 'A',
    spu: `spu-low-${index}`,
    skc: `skc-low-${index}`,
    skuCodes: [`sku-low-${index}`],
    supplierCode: 'LOW-1产品',
    shelfStatusCode: '1',
    sheinUsableInventory: 5,
    sheinInventoryQuantity: 5,
    sheinLockedQuantity: 0,
  })),
  {
    storeKey: 'A', spu: 'spu-scarce', skc: 'skc-scarce', skuCodes: ['sku-scarce'],
    supplierCode: 'SALE-1产品', shelfStatusCode: '1',
    sheinUsableInventory: 30, sheinInventoryQuantity: 30, sheinLockedQuantity: 0,
  },
  {
    storeKey: 'A', spu: 'spu-stable', skc: 'skc-stable', skuCodes: ['sku-stable'],
    supplierCode: 'SALE-2产品', shelfStatusCode: '1',
    sheinUsableInventory: 7, sheinInventoryQuantity: 7, sheinLockedQuantity: 0,
  },
  {
    storeKey: 'A', spu: 'spu-legacy', skc: 'skc-legacy', skuCodes: ['sku-legacy'],
    supplierCode: 'OLD-1产品', shelfStatusCode: '1',
    sheinUsableInventory: 5, sheinInventoryQuantity: 5, sheinLockedQuantity: 0,
  },
  {
    storeKey: 'A', spu: 'spu-cross-sold', skc: 'skc-cross-sold', skuCodes: ['sku-cross-sold'],
    supplierCode: 'CROSS-1产品', shelfStatusCode: '3',
    sheinUsableInventory: 0, sheinInventoryQuantity: 0, sheinLockedQuantity: 0,
  },
  {
    storeKey: 'A', spu: 'spu-all-sold-a', skc: 'skc-all-sold-a', skuCodes: ['sku-all-sold-a'],
    supplierCode: 'ALLSOLD-1产品', shelfStatusCode: '3',
    sheinUsableInventory: 0, sheinInventoryQuantity: 0, sheinLockedQuantity: 0,
  },
  {
    storeKey: 'A', spu: 'spu-dup-sold', skc: 'skc-dup-sold', skuCodes: ['sku-dup-sold'],
    supplierCode: 'DUP-1产品', shelfStatusCode: '3',
    sheinUsableInventory: 0, sheinInventoryQuantity: 0, sheinLockedQuantity: 0,
  },
  {
    storeKey: 'A', spu: 'spu-dup-active', skc: 'skc-dup-active', skuCodes: ['sku-dup-active'],
    supplierCode: 'DUP-1产品', shelfStatusCode: '1',
    sheinUsableInventory: 100, sheinInventoryQuantity: 100, sheinLockedQuantity: 0,
  },
  {
    storeKey: 'A', spu: 'spu-off', skc: 'skc-off', skuCodes: ['sku-off'],
    supplierCode: 'OFF-1产品', shelfStatusCode: '3',
    sheinUsableInventory: 0, sheinInventoryQuantity: 0, sheinLockedQuantity: 0,
  },
  {
    storeKey: 'A', spu: 'spu-wait', skc: 'skc-wait', skuCodes: ['sku-wait'],
    supplierCode: 'WAIT-1产品', shelfStatusCode: '3',
    sheinUsableInventory: 0, sheinInventoryQuantity: 0, sheinLockedQuantity: 0,
  },
].map(row => ({...row, sourceCompleteness: {hasCurrentDetail: true}}));
await fs.writeFile(path.join(productsDir, 'A', 'latest.json'), JSON.stringify({
  fetchedAt: now,
  summary: {stockFailedChunkCount: 0, detailMissingAfterFallbackCount: 0},
  normalizedRows: productRows,
}));
await fs.writeFile(path.join(productsDir, 'B', 'latest.json'), JSON.stringify({
  fetchedAt: now,
  summary: {stockFailedChunkCount: 0, detailMissingAfterFallbackCount: 0},
  normalizedRows: [{
    storeKey: 'B', spu: 'spu-cross-active', skc: 'skc-cross-active', skuCodes: ['sku-cross-active'],
    supplierCode: 'CROSS-1产品', shelfStatusCode: '1',
    sheinUsableInventory: 100, sheinInventoryQuantity: 100, sheinLockedQuantity: 0,
  }, {
    storeKey: 'B', spu: 'spu-all-sold-b', skc: 'skc-all-sold-b', skuCodes: ['sku-all-sold-b'],
    supplierCode: 'ALLSOLD-1产品', shelfStatusCode: '3',
    sheinUsableInventory: 0, sheinInventoryQuantity: 0, sheinLockedQuantity: 0,
  }].map(row => ({...row, sourceCompleteness: {hasCurrentDetail: true}})),
}));
await fs.writeFile(path.join(tmp, 'stores.json'), JSON.stringify({stores: [{storeKey: 'A', enabled: true}, {storeKey: 'B', enabled: true}]}));
await fs.writeFile(path.join(tmp, 'inventoryTrend.json'), JSON.stringify({
  cachedAt: now,
  data: {
    inventoryDepletion: {
      products: [
        {match_key: 'LOW1', standard_goods_sn: 'LOW-1产品', current_sellable_quantity: 8, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 4},
        {match_key: 'SALE1', standard_goods_sn: 'SALE-1产品', current_sellable_quantity: 50, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 150},
        {match_key: 'SALE2', standard_goods_sn: 'SALE-2产品', current_sellable_quantity: 50, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 150},
        {match_key: 'OLD1', standard_goods_sn: 'OLD-1产品', current_sellable_quantity: 50, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 119},
        {match_key: 'CROSS1', standard_goods_sn: 'CROSS-1产品', current_sellable_quantity: 50, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 150},
        {match_key: 'ALLSOLD1', standard_goods_sn: 'ALLSOLD-1产品', current_sellable_quantity: 200, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 150},
        {match_key: 'DUP1', standard_goods_sn: 'DUP-1产品', current_sellable_quantity: 50, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 150},
        {match_key: 'OFF1', standard_goods_sn: 'OFF-1产品', current_sellable_quantity: 50, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 1},
        {match_key: 'WAIT1', standard_goods_sn: 'WAIT-1产品', current_sellable_quantity: 50, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 1},
      ],
    },
  },
}));
await fs.writeFile(path.join(tmp, 'linksData.json'), JSON.stringify({
  cachedAt: now,
  data: {
    storeLinks: [
      ...[1, 2, 3, 4, 5, 6].map(index => ({
        store_key: 'A',
        skc: `skc-low-${index}`,
        standard_goods_sn: 'LOW-1产品',
        c7_eps_uv: 700 - index * 100,
        c7_goods_uv: 70 - index,
        c7_sale_cnt: 0,
        c30_sale_cnt: 0,
      })),
      {store_key: 'A', skc: 'skc-scarce', standard_goods_sn: 'SALE-1产品', c7_eps_uv: 1000, c7_goods_uv: 100, c7_sale_cnt: 2, c30_sale_cnt: 10},
      {store_key: 'A', skc: 'skc-stable', standard_goods_sn: 'SALE-2产品', c7_eps_uv: 900, c7_goods_uv: 90, c7_sale_cnt: 1, c30_sale_cnt: 8},
      {store_key: 'A', skc: 'skc-legacy', standard_goods_sn: 'OLD-1产品', c7_eps_uv: 500, c7_goods_uv: 50, c7_sale_cnt: 0, c30_sale_cnt: 0},
      {store_key: 'A', skc: 'skc-cross-sold', standard_goods_sn: 'CROSS-1产品', shelf_status_name: '已售罄', is_sold_out: true, c7_eps_uv: 100, c7_goods_uv: 10, c7_sale_cnt: 0, c30_sale_cnt: 0},
      {store_key: 'B', skc: 'skc-cross-active', standard_goods_sn: 'CROSS-1产品', shelf_status_name: '已上架', is_on_shelf: true, c7_eps_uv: 200, c7_goods_uv: 20, c7_sale_cnt: 0, c30_sale_cnt: 0},
      {store_key: 'A', skc: 'skc-all-sold-a', standard_goods_sn: 'ALLSOLD-1产品', shelf_status_name: '已售罄', is_sold_out: true, c7_eps_uv: 300, c7_goods_uv: 30, c7_sale_cnt: 0, c30_sale_cnt: 0},
      {store_key: 'B', skc: 'skc-all-sold-b', standard_goods_sn: 'ALLSOLD-1产品', shelf_status_name: '已售罄', is_sold_out: true, c7_eps_uv: 250, c7_goods_uv: 25, c7_sale_cnt: 2, c30_sale_cnt: 2},
      {store_key: 'A', skc: 'skc-dup-sold', standard_goods_sn: 'DUP-1产品', shelf_status_name: '已售罄', is_sold_out: true, c7_eps_uv: 100, c7_goods_uv: 10, c7_sale_cnt: 0, c30_sale_cnt: 0},
      {store_key: 'A', skc: 'skc-dup-active', standard_goods_sn: 'DUP-1产品', shelf_status_name: '已上架', is_on_shelf: true, c7_eps_uv: 200, c7_goods_uv: 20, c7_sale_cnt: 0, c30_sale_cnt: 0},
      {store_key: 'A', skc: 'skc-off', standard_goods_sn: 'OFF-1产品', shelf_status_name: '已下架', is_out_shelf: true, c7_eps_uv: 0, c7_goods_uv: 0, c7_sale_cnt: 0, c30_sale_cnt: 0},
      {store_key: 'A', skc: 'skc-wait', standard_goods_sn: 'WAIT-1产品', shelf_status_name: '待上架', is_wait_shelf: true, c7_eps_uv: 0, c7_goods_uv: 0, c7_sale_cnt: 0, c30_sale_cnt: 0},
    ],
  },
}));

const out = path.join(tmp, 'plan.json');
const originalArgv = process.argv;
process.argv = [
  process.execPath,
  path.join(ROOT, 'scripts', 'inventory', 'build_daily_inventory_replenishment_plan.mjs'),
  '--date', date,
  '--policy', path.join(ROOT, 'config', 'inventory_replenishment_policy.json'),
  '--stores', path.join(tmp, 'stores.json'),
  '--products-dir', productsDir,
  '--bi-data', path.join(tmp, 'inventoryTrend.json'),
  '--links-data', path.join(tmp, 'linksData.json'),
  '--out', out,
];
try {
  await import(`./inventory/build_daily_inventory_replenishment_plan.mjs?test=${Date.now()}`);
} finally {
  process.argv = originalArgv;
}
const plan = JSON.parse(await fs.readFile(out, 'utf8'));
assert.equal(plan.executable, true);
assert.equal(plan.counts.enabledStores, 2);
assert.equal(plan.counts.scannedLinks, 17);
assert.equal(plan.counts.inventoryRelevantLinks, 14);
assert.equal(plan.counts.lowEtAllocationRows, 6);
assert.equal(plan.counts.lowEtAllocationActions, 6);
assert.equal(plan.counts.lowEtNonTopZeroTargets, 1);
assert.equal(plan.counts.lowEtCandidateCanonicalCount, 1);
assert.equal(plan.counts.lowEtAllocatedCanonicalCount, 1);
assert.equal(plan.counts.lowEtBlockedCanonicalCount, 0);
assert.equal(plan.counts.recentSaleScarcityActions, 2);
assert.equal(plan.counts.legacyVirtualTopUps, 3);
assert.equal(plan.counts.actionable, 11);
assert.equal(plan.counts.inventoryIncreases, 4);
assert.equal(plan.counts.inventoryDecreases, 7);
assert.equal(plan.counts.etBelow120Days, 1);
assert.equal(plan.counts.etAlertsExcludedNoRelevantLinks, 2);
assert.equal(plan.counts.crossStoreSoldOutFindings, 1);
assert.equal(plan.counts.crossStoreSoldOutActionable, 1);
assert.equal(plan.counts.outShelfLinksExcluded, 1);
assert.equal(plan.counts.waitShelfLinksExcluded, 1);
assert.equal(plan.counts.soldOutLinksIgnoredSameStoreOnShelf, 1);
assert.equal(plan.counts.etTotalRows, 9);
assert.equal(plan.counts.etMatchedCurrentDayRows, 9);
assert.equal(plan.sourceEvidence.find(row => row.store === 'ET')?.matchedCurrentDayEtRows, 9);
assert.deepEqual(plan.lowEtAllocations.map(row => row.targetUsableInventory), [2, 2, 2, 1, 1, 0]);
assert.equal(plan.actionable.find(row => row.skc === 'skc-scarce')?.targetUsableInventory, 10);
assert.equal(plan.ignored.find(row => row.skc === 'skc-stable')?.decision, 'recent_sale_scarcity_inventory_within_band');
assert.equal(plan.ignored.find(row => row.skc === 'skc-off')?.shelfStatusName, '已下架');
assert.equal(plan.ignored.find(row => row.skc === 'skc-wait')?.shelfStatusName, '待上架');
assert.equal(plan.ignored.find(row => row.skc === 'skc-dup-sold')?.decision, 'sold_out_has_same_store_on_shelf_link');
assert.deepEqual(plan.ignored.find(row => row.skc === 'skc-dup-sold')?.sameStoreOnShelfSkcs, ['skc-dup-active']);
assert.deepEqual(plan.crossStoreSoldOutFindings.map(row => row.skc), ['skc-cross-sold']);
assert.deepEqual(plan.actionable.filter(row => row.matchKey === 'ALLSOLD-1产品').map(row => [row.storeKey, row.targetUsableInventory]), [['A', 100], ['B', 10]]);
assert.equal(plan.ignored.some(row => row.matchKey === 'ALLSOLD-1产品'), false);
assert.match(plan.payloadHash, /^[a-f0-9]{64}$/);
assert.equal(plan.payloadHash, stableInventoryHash(buildDailyInventoryPlanHashPayload(plan)));
const builderVolatileAgePlan = {
  ...plan,
  sourceEvidence: plan.sourceEvidence.map(evidence => ({
    ...evidence,
    ageHours: 99,
    manifestAgeSeconds: 999,
    endpointAgeSeconds: {store_stock: 888, box_stock: 777},
  })),
};
assert.equal(
  stableInventoryHash(buildDailyInventoryPlanHashPayload(builderVolatileAgePlan)),
  plan.payloadHash,
  'builder hash must exclude all three volatile sourceEvidence age fields',
);
assert.notEqual(
  stableInventoryHash(buildDailyInventoryPlanHashPayload({...plan, etFactSource: {kind: 'builder-hash-drift'}})),
  plan.payloadHash,
  'builder hash must bind etFactSource',
);

const conflictingLinksFile = path.join(tmp, 'linksData-conflict.json');
const conflictingLinks = JSON.parse(await fs.readFile(path.join(tmp, 'linksData.json'), 'utf8'));
conflictingLinks.data.storeLinks.find(row => row.skc === 'skc-all-sold-a').standard_goods_sn = 'WRONG-999产品';
await fs.writeFile(conflictingLinksFile, JSON.stringify(conflictingLinks));
const conflictOut = path.join(tmp, 'plan-conflict.json');
process.argv = [
  process.execPath,
  path.join(ROOT, 'scripts', 'inventory', 'build_daily_inventory_replenishment_plan.mjs'),
  '--date', date,
  '--policy', path.join(ROOT, 'config', 'inventory_replenishment_policy.json'),
  '--stores', path.join(tmp, 'stores.json'),
  '--products-dir', productsDir,
  '--bi-data', path.join(tmp, 'inventoryTrend.json'),
  '--links-data', conflictingLinksFile,
  '--out', conflictOut,
];
try {
  await import(`./inventory/build_daily_inventory_replenishment_plan.mjs?conflict=${Date.now()}`);
} catch (error) {
  assert.equal(error?.code, 2);
} finally {
  process.exitCode = 0;
  process.argv = originalArgv;
}
const conflictPlan = JSON.parse(await fs.readFile(conflictOut, 'utf8'));
assert.equal(conflictPlan.executable, true);
assert.equal(conflictPlan.blockers.length, 0);
assert.equal(conflictPlan.actionable.some(row => row.skc === 'skc-all-sold-a'), false);
assert.equal(conflictPlan.linkAlerts.find(row => row.skc === 'skc-all-sold-a')?.decision, 'openapi_linksdata_canonical_evidence_conflict');
assert.equal(conflictPlan.actionable.some(row => row.skc === 'skc-all-sold-b'), true);

const yesterday = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(Date.now() - 86400000));
const builderPath = path.join(ROOT, 'scripts', 'inventory', 'build_daily_inventory_replenishment_plan.mjs');
const policyPath = path.join(ROOT, 'config', 'inventory_replenishment_policy.json');
const storesPath = path.join(tmp, 'stores.json');
const linksPath = path.join(tmp, 'linksData.json');

// Global current-day ET gate: a fresh cachedAt with an all-old ET business
// day must block the whole plan (executable=false) instead of publishing an
// empty executable plan.
const oldBiFile = path.join(tmp, 'inventoryTrend-old.json');
const oldBi = JSON.parse(await fs.readFile(path.join(tmp, 'inventoryTrend.json'), 'utf8'));
oldBi.data.inventoryDepletion.products = oldBi.data.inventoryDepletion.products
  .map(row => ({...row, et_store_snapshot_date: yesterday}));
await fs.writeFile(oldBiFile, JSON.stringify(oldBi));
const oldOut = path.join(tmp, 'plan-old.json');
process.argv = [
  process.execPath, builderPath,
  '--date', date, '--policy', policyPath, '--stores', storesPath,
  '--products-dir', productsDir, '--bi-data', oldBiFile, '--links-data', linksPath,
  '--out', oldOut,
];
try {
  await import(`./inventory/build_daily_inventory_replenishment_plan.mjs?old=${Date.now()}`);
} finally {
  process.exitCode = 0;
  process.argv = originalArgv;
}
const oldPlan = JSON.parse(await fs.readFile(oldOut, 'utf8'));
assert.equal(oldPlan.executable, false);
assert.ok(oldPlan.blockers.some(row => row.startsWith('BI/ET projection has no matched current-day operational rows')));
assert.equal(oldPlan.counts.etMatchedCurrentDayRows, 0);
assert.equal(oldPlan.counts.etTotalRows, 9);
assert.equal(oldPlan.actionable.length, 0);
assert.ok(oldPlan.linkAlerts.some(row => row.decision === 'et_snapshot_not_current_day'));
assert.equal(oldPlan.sourceEvidence.find(row => row.store === 'ET')?.matchedCurrentDayEtRows, 0);

// Mixed old/new stays per-row: one current-day matched row suppresses the
// global blocker, current-day rows still produce safe actions, and old rows
// keep their per-row blocks.
const mixedBiFile = path.join(tmp, 'inventoryTrend-mixed.json');
const mixedBi = JSON.parse(await fs.readFile(path.join(tmp, 'inventoryTrend.json'), 'utf8'));
mixedBi.data.inventoryDepletion.products = mixedBi.data.inventoryDepletion.products
  .map(row => row.match_key === 'LOW1' ? row : {...row, et_store_snapshot_date: yesterday});
await fs.writeFile(mixedBiFile, JSON.stringify(mixedBi));
const mixedOut = path.join(tmp, 'plan-mixed.json');
process.argv = [
  process.execPath, builderPath,
  '--date', date, '--policy', policyPath, '--stores', storesPath,
  '--products-dir', productsDir, '--bi-data', mixedBiFile, '--links-data', linksPath,
  '--out', mixedOut,
];
try {
  await import(`./inventory/build_daily_inventory_replenishment_plan.mjs?mixed=${Date.now()}`);
} finally {
  process.exitCode = 0;
  process.argv = originalArgv;
}
const mixedPlan = JSON.parse(await fs.readFile(mixedOut, 'utf8'));
assert.equal(mixedPlan.executable, true);
assert.equal(mixedPlan.counts.etMatchedCurrentDayRows, 1);
assert.ok(!mixedPlan.blockers.some(row => row.startsWith('BI/ET projection has no matched current-day operational rows')));
assert.ok(mixedPlan.actionable.length > 0);
assert.ok(mixedPlan.linkAlerts.some(row => row.decision === 'et_snapshot_not_current_day'));
assert.equal(mixedPlan.counts.lowEtAllocationRows, 6);

// Executor hard ceiling behavior: 1001 actionable rows with --max-rows 1000
// must fail before any write (no result file, no journal) instead of slicing.
const executorPolicyVersion = JSON.parse(await fs.readFile(policyPath, 'utf8')).policyVersion;
const executorActions = Array.from({length: 1001}, (_, index) => ({
  storeKey: 'A',
  spu: `spu-ceiling-${index}`,
  skc: `skc-ceiling-${index}`,
  skuCode: `sku-ceiling-${index}`,
  supplierCode: `SUP-${index}产品`,
  canonical: `SUP-${index}产品`,
  matchKey: `SUP${index}`,
  platformUsableInventory: 5,
  targetUsableInventory: 10,
  inventoryAction: 'increase',
  replenishmentQuantity: 5,
  reductionQuantity: 0,
  ruleClass: 'legacy_virtual_inventory_top_up',
}));
const executorPlanFile = path.join(tmp, 'executor-plan.json');
const executorPlan = {
  schemaVersion: 'daily-inventory-replenishment-plan/v1',
  date,
  policyVersion: executorPolicyVersion,
  generatedAt: now,
  etFactSource: {kind: 'portal_projection', fixture: 'daily-plan-hash-contract'},
  sourceEvidence: [{
    store: 'ET',
    file: 'outputs/bi-portal/sections/inventoryTrend.json',
    fetchedAt: now,
    ageHours: 0.125,
    manifestAgeSeconds: 12,
    endpointAgeSeconds: {store_stock: 11, box_stock: 12},
  }],
  executionConstraints: {mode: 'daily', decreaseOnly: false},
  blockers: [],
  executable: true,
  actionable: executorActions,
  linkAlerts: [],
  ignored: [],
  lowEtAllocations: [],
  detailRefreshTargets: [],
  crossStoreSoldOutFindings: [],
  etAlerts: [],
  counts: {actionable: executorActions.length},
};
executorPlan.payloadHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(executorPlan));
await fs.writeFile(executorPlanFile, JSON.stringify(executorPlan));
await fs.writeFile(path.join(tmp, 'executor-bi.json'), JSON.stringify({cachedAt: now, data: {}}));
await fs.writeFile(path.join(tmp, 'executor-links.json'), JSON.stringify({cachedAt: now, data: {}}));
await fs.writeFile(path.join(tmp, 'executor-config.json'), JSON.stringify({}));
const executorOut = path.join(tmp, 'executor-result.json');
process.argv = [
  process.execPath,
  path.join(ROOT, 'scripts', 'inventory', 'execute_daily_inventory_replenishment_plan.mjs'),
  '--plan', executorPlanFile,
  '--config', path.join(tmp, 'executor-config.json'),
  '--bi-data', path.join(tmp, 'executor-bi.json'),
  '--links-data', path.join(tmp, 'executor-links.json'),
  '--out', executorOut,
  '--dry-run',
  '--max-rows', '1000',
];
let executorError = null;
try {
  await import(`./inventory/execute_daily_inventory_replenishment_plan.mjs?ceiling=${Date.now()}`);
} catch (error) {
  executorError = error;
} finally {
  process.exitCode = 0;
  process.argv = originalArgv;
}
assert.ok(executorError, 'the executor must fail when actionable rows exceed --max-rows');
assert.doesNotMatch(String(executorError?.message || ''), /Plan payload hash mismatch/,
  'the executor must accept the builder-compatible hash before enforcing the row ceiling');
assert.match(String(executorError?.message || ''), /exceed the per-run row ceiling/);
await assert.rejects(fs.access(executorOut), 'no result file may be written for a ceiling failure');
await assert.rejects(fs.access(`${executorOut}.journal.ndjson`), 'no journal may be written for a ceiling failure');

const volatileAgeExecutorPlan = {
  ...executorPlan,
  sourceEvidence: executorPlan.sourceEvidence.map(evidence => ({
    ...evidence,
    ageHours: 99,
    manifestAgeSeconds: 999,
    endpointAgeSeconds: {store_stock: 888, box_stock: 777},
  })),
};
await fs.writeFile(executorPlanFile, JSON.stringify(volatileAgeExecutorPlan));
let volatileAgeExecutorError = null;
process.argv = [
  process.execPath,
  path.join(ROOT, 'scripts', 'inventory', 'execute_daily_inventory_replenishment_plan.mjs'),
  '--plan', executorPlanFile,
  '--config', path.join(tmp, 'executor-config.json'),
  '--bi-data', path.join(tmp, 'executor-bi.json'),
  '--links-data', path.join(tmp, 'executor-links.json'),
  '--out', executorOut,
  '--dry-run',
  '--max-rows', '1000',
];
try {
  await import(`./inventory/execute_daily_inventory_replenishment_plan.mjs?volatileAges=${Date.now()}`);
} catch (error) {
  volatileAgeExecutorError = error;
} finally {
  process.exitCode = 0;
  process.argv = originalArgv;
}
assert.ok(volatileAgeExecutorError);
assert.doesNotMatch(String(volatileAgeExecutorError?.message || ''), /Plan payload hash mismatch/,
  'executor must use the same canonical exclusions for all three volatile age fields');
assert.match(String(volatileAgeExecutorError?.message || ''), /exceed the per-run row ceiling/);

const etFactSourceDriftExecutorPlan = {
  ...executorPlan,
  etFactSource: {...executorPlan.etFactSource, fixture: 'executor-hash-drift'},
};
await fs.writeFile(executorPlanFile, JSON.stringify(etFactSourceDriftExecutorPlan));
let etFactSourceExecutorError = null;
process.argv = [
  process.execPath,
  path.join(ROOT, 'scripts', 'inventory', 'execute_daily_inventory_replenishment_plan.mjs'),
  '--plan', executorPlanFile,
  '--config', path.join(tmp, 'executor-config.json'),
  '--bi-data', path.join(tmp, 'executor-bi.json'),
  '--links-data', path.join(tmp, 'executor-links.json'),
  '--out', executorOut,
  '--dry-run',
  '--max-rows', '1000',
];
try {
  await import(`./inventory/execute_daily_inventory_replenishment_plan.mjs?etFactSourceDrift=${Date.now()}`);
} catch (error) {
  etFactSourceExecutorError = error;
} finally {
  process.exitCode = 0;
  process.argv = originalArgv;
}
assert.match(String(etFactSourceExecutorError?.message || ''), /Plan payload hash mismatch/,
  'executor must bind etFactSource through the shared daily hash helper');

console.log(JSON.stringify({ok: true, checks: 62}, null, 2));
