#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {activateInventoryBootstrapLock, readInventoryBootstrapLockRegistry, upsertInventoryBootstrapLock} from '../lib/inventory_bootstrap_lock_registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-inventory-plan-'));
const date = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const now = new Date().toISOString();
const productListFor = rows => rows.map(row => ({
  spuName: row.spu,
  skcName: row.skc,
  skuCodeList: row.skuCodes,
}));
const withCurrentDetail = rows => rows.map(row => ({
  ...row,
  sourceCompleteness: {...row.sourceCompleteness, hasCurrentDetail: true},
}));
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
];
await fs.writeFile(path.join(productsDir, 'A', 'latest.json'), JSON.stringify({
  fetchedAt: now,
  summary: {stockFailedChunkCount: 0},
  productList: productListFor(productRows),
  normalizedRows: withCurrentDetail(productRows),
}));
const productRowsB = [{
  storeKey: 'B', spu: 'spu-cross-active', skc: 'skc-cross-active', skuCodes: ['sku-cross-active'],
  supplierCode: 'CROSS-1产品', shelfStatusCode: '1',
  sheinUsableInventory: 100, sheinInventoryQuantity: 100, sheinLockedQuantity: 0,
}];
await fs.writeFile(path.join(productsDir, 'B', 'latest.json'), JSON.stringify({
  fetchedAt: now,
  summary: {stockFailedChunkCount: 0},
  productList: productListFor(productRowsB),
  normalizedRows: withCurrentDetail(productRowsB),
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
assert.equal(plan.counts.scannedLinks, 15);
assert.equal(plan.counts.inventoryRelevantLinks, 12);
assert.equal(plan.counts.lowEtAllocationRows, 6);
assert.equal(plan.counts.lowEtAllocationActions, 6);
assert.equal(plan.counts.lowEtNonTopZeroTargets, 1);
assert.equal(plan.counts.lowEtCandidateCanonicalCount, 1);
assert.equal(plan.counts.lowEtAllocatedCanonicalCount, 1);
assert.equal(plan.counts.lowEtBlockedCanonicalCount, 0);
assert.equal(plan.counts.recentSaleScarcityActions, 1);
assert.equal(plan.counts.legacyVirtualTopUps, 2);
assert.equal(plan.counts.actionable, 9);
assert.equal(plan.counts.inventoryIncreases, 2);
assert.equal(plan.counts.inventoryDecreases, 7);
assert.equal(plan.counts.etBelow120Days, 1);
assert.equal(plan.counts.etAlertsExcludedNoRelevantLinks, 2);
assert.equal(plan.counts.crossStoreSoldOutFindings, 1);
assert.equal(plan.counts.crossStoreSoldOutActionable, 1);
assert.equal(plan.counts.outShelfLinksExcluded, 1);
assert.equal(plan.counts.waitShelfLinksExcluded, 1);
assert.equal(plan.counts.soldOutLinksIgnoredSameStoreOnShelf, 1);
assert.deepEqual(plan.lowEtAllocations.map(row => row.targetUsableInventory), [2, 2, 2, 1, 1, 0]);
assert.equal(plan.actionable.find(row => row.skc === 'skc-scarce')?.targetUsableInventory, 10);
assert.equal(plan.ignored.find(row => row.skc === 'skc-stable')?.decision, 'recent_sale_scarcity_inventory_within_band');
assert.equal(plan.ignored.find(row => row.skc === 'skc-off')?.shelfStatusName, '已下架');
assert.equal(plan.ignored.find(row => row.skc === 'skc-wait')?.shelfStatusName, '待上架');
assert.equal(plan.ignored.find(row => row.skc === 'skc-dup-sold')?.decision, 'sold_out_has_same_store_on_shelf_link');
assert.deepEqual(plan.ignored.find(row => row.skc === 'skc-dup-sold')?.sameStoreOnShelfSkcs, ['skc-dup-active']);
assert.deepEqual(plan.crossStoreSoldOutFindings.map(row => row.skc), ['skc-cross-sold']);
assert.match(plan.payloadHash, /^[a-f0-9]{64}$/);

const bootstrapTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-inventory-bootstrap-plan-'));
const bootstrapProducts = path.join(bootstrapTmp, 'products');
const bootstrapLockFile = path.join(bootstrapTmp, 'bootstrap-locks.json');
await fs.mkdir(path.join(bootstrapProducts, 'A'), {recursive: true});
await fs.mkdir(path.join(bootstrapProducts, 'B'), {recursive: true});
const bootstrapRowsA = [
  {storeKey: 'A', spu: 'spu-seed', skc: 'skc-seed', skuCodes: ['sku-seed'], supplierCode: 'SK-6863产品', shelfStatusCode: '3', sheinUsableInventory: 0, sheinInventoryQuantity: 0, sheinLockedQuantity: 0},
  {storeKey: 'A', spu: 'spu-dup', skc: 'skc-dup', skuCodes: ['sku-dup'], supplierCode: 'SK-6863产品', shelfStatusCode: '3', sheinUsableInventory: 0, sheinInventoryQuantity: 0, sheinLockedQuantity: 0},
  {storeKey: 'A', spu: 'spu-stable-noop', skc: 'skc-stable-noop', skuCodes: ['sku-stable-noop'], supplierCode: 'STABLE-1产品', shelfStatusCode: '1', sheinUsableInventory: 12, sheinInventoryQuantity: 12, sheinLockedQuantity: 0},
];
const bootstrapRowsB = [
  {storeKey: 'B', spu: 'spu-other', skc: 'skc-other', skuCodes: ['sku-other'], supplierCode: 'SK-6863产品', shelfStatusCode: '3', sheinUsableInventory: 0, sheinInventoryQuantity: 0, sheinLockedQuantity: 0},
];
const writeBootstrapProducts = async (rowsA, rowsB = bootstrapRowsB, {detailMissingAfterFallbackCount = 0} = {}) => {
  await fs.writeFile(path.join(bootstrapProducts, 'A', 'latest.json'), JSON.stringify({fetchedAt: now, summary: {stockFailedChunkCount: 0, detailMissingAfterFallbackCount}, productList: productListFor(rowsA), normalizedRows: withCurrentDetail(rowsA)}));
  await fs.writeFile(path.join(bootstrapProducts, 'B', 'latest.json'), JSON.stringify({fetchedAt: now, summary: {stockFailedChunkCount: 0}, productList: productListFor(rowsB), normalizedRows: withCurrentDetail(rowsB)}));
};
await writeBootstrapProducts(bootstrapRowsA);
await fs.writeFile(path.join(bootstrapTmp, 'stores.json'), JSON.stringify({stores: [{storeKey: 'A', enabled: true}, {storeKey: 'B', enabled: true}]}));
await fs.writeFile(path.join(bootstrapTmp, 'inventoryTrend.json'), JSON.stringify({cachedAt: now, data: {inventoryDepletion: {products: [
  {match_key: 'SK6863', standard_goods_sn: 'SK-6863产品', current_sellable_quantity: 120, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 30},
  {match_key: 'STABLE1', standard_goods_sn: 'STABLE-1产品', current_sellable_quantity: 12, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 30},
]}}}));
const bootstrapLinks = (status, otherSelling = false) => ({cachedAt: now, data: {storeLinks: [
  {store_key: 'A', skc: 'skc-seed', standard_goods_sn: 'SK-6863产品', shelf_status_name: status === 'locked' ? '已上架' : '已售罄', is_on_shelf: status === 'locked', is_sold_out: status !== 'locked', c7_eps_uv: 100, c7_goods_uv: 20, c7_sale_cnt: 0, c30_sale_cnt: 0},
  {store_key: 'A', skc: 'skc-dup', standard_goods_sn: 'SK-6863产品', shelf_status_name: '已售罄', is_sold_out: true, c7_eps_uv: 50, c7_goods_uv: 10, c7_sale_cnt: 0, c30_sale_cnt: 0},
  {store_key: 'B', skc: 'skc-other', standard_goods_sn: 'SK-6863产品', shelf_status_name: otherSelling ? '已上架' : '已售罄', is_on_shelf: otherSelling, is_sold_out: !otherSelling, c7_eps_uv: 90, c7_goods_uv: 18, c7_sale_cnt: 0, c30_sale_cnt: 0},
  {store_key: 'A', skc: 'skc-stable-noop', standard_goods_sn: 'STABLE-1产品', shelf_status_name: '已上架', is_on_shelf: true, c7_eps_uv: 1, c7_goods_uv: 1, c7_sale_cnt: 0, c30_sale_cnt: 0},
]}});
const bootstrapLinksFile = path.join(bootstrapTmp, 'linksData.json');
await fs.writeFile(bootstrapLinksFile, JSON.stringify(bootstrapLinks('new')));

async function buildBootstrapPlan(name) {
  const target = path.join(bootstrapTmp, `${name}.json`);
  const savedArgv = process.argv;
  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  process.argv = [process.execPath, path.join(ROOT, 'scripts', 'inventory', 'build_daily_inventory_replenishment_plan.mjs'),
    '--date', date, '--policy', path.join(ROOT, 'config', 'inventory_replenishment_policy.json'),
    '--stores', path.join(bootstrapTmp, 'stores.json'), '--products-dir', bootstrapProducts,
    '--bi-data', path.join(bootstrapTmp, 'inventoryTrend.json'), '--links-data', bootstrapLinksFile,
    '--bootstrap-lock-file', bootstrapLockFile, '--out', target];
  try { await import(`./inventory/build_daily_inventory_replenishment_plan.mjs?bootstrap=${name}-${Date.now()}`); }
  finally {
    process.argv = savedArgv;
    process.exitCode = savedExitCode;
  }
  return JSON.parse(await fs.readFile(target, 'utf8'));
}

const bootstrapPlan = await buildBootstrapPlan('bootstrap-new');
assert.equal(bootstrapPlan.counts.bootstrapSeedActions, 1);
assert.equal(bootstrapPlan.bootstrapGroups[0].state, 'new_seed');
assert.equal(bootstrapPlan.bootstrapGroups[0].groupLinks.length, 3);
assert.deepEqual(Object.keys(bootstrapPlan.bootstrapGroups[0].storeCatalogs), ['A', 'B']);
assert.match(bootstrapPlan.bootstrapGroups[0].storeCatalogs.A.hash, /^[a-f0-9]{64}$/);
assert.equal(bootstrapPlan.actionable.find(row => row.ruleClass === 'all_store_sold_out_bootstrap_seed')?.skc, 'skc-seed');
assert.equal(bootstrapPlan.actionable.find(row => row.skc === 'skc-seed')?.targetUsableInventory, 10);
assert.equal(bootstrapPlan.ignored.find(row => row.skc === 'skc-dup')?.decision, 'sold_out_duplicate_not_selected');
assert.equal(bootstrapPlan.ignored.find(row => row.skc === 'skc-other')?.decision, 'sold_out_bootstrap_not_selected');
assert.equal(bootstrapPlan.ignored.find(row => row.skc === 'skc-stable-noop')?.decision, 'target_inventory_already_satisfied');
assert.equal(bootstrapPlan.ignored.find(row => row.skc === 'skc-stable-noop')?.originalDecision, 'platform_low_top_up_to_et_sellable');
assert.match(bootstrapPlan.bootstrapLockRegistry.hash, /^[a-f0-9]{64}$/);
assert.match(bootstrapPlan.payloadHash, /^[a-f0-9]{64}$/);

const executorOut = path.join(bootstrapTmp, 'bootstrap-dry-result.json');
const fakeConfig = path.join(bootstrapTmp, 'openapi-config.json');
await fs.writeFile(fakeConfig, JSON.stringify({stores: []}));
const bootstrapPlanFile = path.join(bootstrapTmp, 'bootstrap-new.json');
const executorArgv = process.argv;
process.argv = [process.execPath, path.join(ROOT, 'scripts', 'inventory', 'execute_daily_inventory_replenishment_plan.mjs'),
  '--plan', bootstrapPlanFile, '--policy', path.join(ROOT, 'config', 'inventory_replenishment_policy.json'),
  '--config', fakeConfig, '--bi-data', path.join(bootstrapTmp, 'inventoryTrend.json'), '--links-data', bootstrapLinksFile,
  '--bootstrap-lock-file', bootstrapLockFile, '--dry-run', '--out', executorOut];
try { await import(`./inventory/execute_daily_inventory_replenishment_plan.mjs?bootstrap-dry=${Date.now()}`); }
finally { process.argv = executorArgv; }
const dryResult = JSON.parse(await fs.readFile(executorOut, 'utf8'));
assert.equal(dryResult.execute, false);
assert.deepEqual(dryResult.results.map(row => row.state), ['dry_run_ready']);
assert.equal((await readInventoryBootstrapLockRegistry(bootstrapLockFile)).exists, false);

await upsertInventoryBootstrapLock(bootstrapLockFile, {
  matchKey: 'SK6863', canonical: 'SK-6863产品', storeKey: 'A', skc: 'skc-seed', skuCode: 'sku-seed',
  targetUsableInventory: 10, policyVersion: '2026-08-12.1', status: 'pending', planHash: bootstrapPlan.payloadHash,
}, {now});
await writeBootstrapProducts(bootstrapRowsA.map(row => row.skc === 'skc-seed'
  ? {...row, shelfStatusCode: '1', sheinUsableInventory: 10, sheinInventoryQuantity: 10}
  : row));
await fs.writeFile(bootstrapLinksFile, JSON.stringify(bootstrapLinks('locked')));
const pendingRecoveryPlan = await buildBootstrapPlan('bootstrap-pending-recovery');
const pendingRecoveryRow = pendingRecoveryPlan.actionable.find(row => row.matchKey === 'SK6863');
assert.equal(pendingRecoveryPlan.bootstrapGroups[0].state, 'locked_seed');
assert.equal(pendingRecoveryRow?.bootstrapActivationOnly, true);
assert.equal(pendingRecoveryRow?.inventoryAction, 'stable');
await activateInventoryBootstrapLock(bootstrapLockFile, {
  matchKey: 'SK6863', canonical: 'SK-6863产品', storeKey: 'A', skc: 'skc-seed', skuCode: 'sku-seed',
  targetUsableInventory: 10, policyVersion: '2026-08-12.1', planHash: pendingRecoveryPlan.payloadHash,
}, {now});
const lockedPlan = await buildBootstrapPlan('bootstrap-locked');
assert.equal(lockedPlan.bootstrapGroups[0].state, 'locked_seed');
assert.equal(lockedPlan.counts.bootstrapSeedActions, 0);
assert.equal(lockedPlan.actionable.some(row => row.matchKey === 'SK6863'), false);
assert.equal(lockedPlan.ignored.find(row => row.skc === 'skc-seed')?.decision, 'target_inventory_already_satisfied');
assert.equal(lockedPlan.ignored.find(row => row.skc === 'skc-other')?.decision, 'sold_out_without_other_store_selling');

const restoredOtherRows = bootstrapRowsB.map(row => ({...row, shelfStatusCode: '1', sheinUsableInventory: 5, sheinInventoryQuantity: 5}));
await writeBootstrapProducts(bootstrapRowsA.map(row => row.skc === 'skc-seed'
  ? {...row, shelfStatusCode: '1', sheinUsableInventory: 10, sheinInventoryQuantity: 10}
  : row), restoredOtherRows);
await fs.writeFile(bootstrapLinksFile, JSON.stringify(bootstrapLinks('locked', true)));
const lockedOrganicPlan = await buildBootstrapPlan('bootstrap-locked-organic');
assert.equal(lockedOrganicPlan.bootstrapGroups.find(row => row.matchKey === 'SK6863')?.state, 'blocked');
assert.equal(lockedOrganicPlan.bootstrapGroups.find(row => row.matchKey === 'SK6863')?.reason, 'all_store_sold_out_bootstrap_locked_seed_has_other_natural_selling');
assert.equal(lockedOrganicPlan.actionable.some(row => row.matchKey === 'SK6863'), false);

await writeBootstrapProducts(bootstrapRowsA.map(row => row.skc === 'skc-seed'
  ? {...row, shelfStatusCode: '1', sheinUsableInventory: 10, sheinInventoryQuantity: 10}
  : row));
await fs.writeFile(bootstrapLinksFile, JSON.stringify(bootstrapLinks('locked')));

await fs.writeFile(path.join(bootstrapTmp, 'inventoryTrend.json'), JSON.stringify({cachedAt: now, data: {inventoryDepletion: {products: [
  {match_key: 'SK6863', standard_goods_sn: 'SK-6863产品', current_sellable_quantity: 5, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 1},
  {match_key: 'STABLE1', standard_goods_sn: 'STABLE-1产品', current_sellable_quantity: 12, et_store_snapshot_date: date, inventory_match_status: 'matched', days_of_supply_on_hand: 30},
]}}}));
const lockedLowEtPlan = await buildBootstrapPlan('bootstrap-locked-low-et');
assert.equal(lockedLowEtPlan.bootstrapGroups.find(row => row.matchKey === 'SK6863')?.state, 'suspended_low_et_allocation');
assert.equal(lockedLowEtPlan.blockers.length, 0);
assert.ok(lockedLowEtPlan.actionable.some(row => row.matchKey === 'SK6863' && row.ruleClass === 'low_et_top_exposure_allocation'));
assert.ok(lockedLowEtPlan.actionable.filter(row => row.matchKey === 'SK6863').every(row => row.targetUsableInventory <= 5));

await writeBootstrapProducts(bootstrapRowsA, bootstrapRowsB, {detailMissingAfterFallbackCount: 1});
const missingDetailPlan = await buildBootstrapPlan('bootstrap-missing-detail');
assert.equal(missingDetailPlan.executable, false);
assert.ok(missingDetailPlan.blockers.includes('A OpenAPI product detail evidence is incomplete'));

await writeBootstrapProducts(bootstrapRowsA, bootstrapRowsB);
const cachedDetailFile = path.join(bootstrapProducts, 'A', 'latest.json');
const cachedDetailDocument = JSON.parse(await fs.readFile(cachedDetailFile, 'utf8'));
cachedDetailDocument.normalizedRows[0].sourceCompleteness.hasCurrentDetail = false;
await fs.writeFile(cachedDetailFile, JSON.stringify(cachedDetailDocument));
const cachedDetailPlan = await buildBootstrapPlan('bootstrap-cached-detail');
assert.equal(cachedDetailPlan.executable, false);
assert.ok(cachedDetailPlan.blockers.includes('A OpenAPI product canonical evidence is not from current detail'));

console.log(JSON.stringify({ok: true, checks: 64}, null, 2));
