#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

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
assert.deepEqual(plan.lowEtAllocations.map(row => row.targetUsableInventory), [2, 2, 2, 1, 1, 0]);
assert.equal(plan.actionable.find(row => row.skc === 'skc-scarce')?.targetUsableInventory, 10);
assert.equal(plan.ignored.find(row => row.skc === 'skc-stable')?.decision, 'recent_sale_scarcity_inventory_within_band');
assert.equal(plan.ignored.find(row => row.skc === 'skc-off')?.shelfStatusName, '已下架');
assert.equal(plan.ignored.find(row => row.skc === 'skc-wait')?.shelfStatusName, '待上架');
assert.equal(plan.ignored.find(row => row.skc === 'skc-dup-sold')?.decision, 'sold_out_has_same_store_on_shelf_link');
assert.deepEqual(plan.ignored.find(row => row.skc === 'skc-dup-sold')?.sameStoreOnShelfSkcs, ['skc-dup-active']);
assert.deepEqual(plan.crossStoreSoldOutFindings.map(row => row.skc), ['skc-cross-sold']);
assert.deepEqual(plan.actionable.filter(row => row.matchKey === 'ALLSOLD1').map(row => [row.storeKey, row.targetUsableInventory]), [['A', 100], ['B', 10]]);
assert.equal(plan.ignored.some(row => row.matchKey === 'ALLSOLD1'), false);
assert.match(plan.payloadHash, /^[a-f0-9]{64}$/);

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
  process.argv = originalArgv;
}
const conflictPlan = JSON.parse(await fs.readFile(conflictOut, 'utf8'));
assert.equal(conflictPlan.executable, false);
assert.match(conflictPlan.blockers.join('\n'), /OpenAPI\/linksData canonical evidence conflicts: store=A skc=skc-all-sold-a/);
console.log(JSON.stringify({ok: true, checks: 36}, null, 2));
