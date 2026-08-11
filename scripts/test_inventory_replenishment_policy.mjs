#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  allocateLowEtInventory,
  assertDailyInventoryExecutionAuthorization,
  canonicalInventoryKey,
  classifyEtInventoryAlert,
  computeInventoryOverwriteQuantity,
  compareAllStoreSoldOutBootstrapCandidates,
  decideDailyInventoryReplenishment,
  normalizeOpenApiProductCatalog,
  resolveInventoryShelfStatus,
  selectAllStoreSoldOutBootstrapSeed,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';
import {selectVirtualInventoryWarehouseCode} from '../lib/shein_inventory_warehouse.mjs';

const policy = {
  triggerUsableInventoryAtOrBelow: 20,
  targetUsableInventory: 100,
  minimumEtSellableForVirtualTopUp: 11,
  lowEtAllocationAtOrBelow: 10,
  recentSaleScarcity: {minimumSaleCount: 1, targetUsableInventory: 10, refillWhenBelow: 5, capWhenAbove: 10},
  lowEtAllocation: {topExposureLinkCount: 5},
  eligibleShelfStatusCodes: ['1', '3'],
  soldOutShelfStatusCode: '3',
  ignoreSoldOutWhenSameStoreHasOnShelfCanonical: true,
  soldOutRequiresOtherStoreOnShelfWithStock: true,
  allStoreSoldOutBootstrap: {
    enabled: true,
    targetUsableInventory: 10,
    maxSeedsPerCanonical: 1,
    excludeSeedFromCrossStoreSellingEvidence: true,
  },
  requireExactlyOneSku: true,
  requireCurrentDayEtSnapshot: true,
  etAlerts: {criticalDaysOfSupply: 7, warningDaysOfSupply: 14, lowQuantity: 10, replenishmentDaysOfSupply: 120},
  execution: {
    mode: 'manual_review',
    perRunUserConfirmationRequired: true,
    perRunPayloadHashRequired: true,
    storeScope: 'all_enabled_stores',
    automaticExecution: {enabled: false},
  },
};

assert.equal(canonicalInventoryKey('SK-04031胶囊咖啡机'), 'SK04031');
assert.deepEqual(resolveInventoryShelfStatus({shelf_status_name: '已下架', is_out_shelf: true}, '3').code, '4');
assert.deepEqual(resolveInventoryShelfStatus({shelf_status_name: '已售罄', is_sold_out: true}, '1').code, '3');
assert.deepEqual(resolveInventoryShelfStatus({shelf_status_name: '已上架', is_on_shelf: true}, '4').code, '1');
assert.equal(selectVirtualInventoryWarehouseCode({list: [{warehouseCode: 'PS-SA', saleCountryList: ['SA']}]}), 'PS-SA');
assert.equal(selectVirtualInventoryWarehouseCode({list: [
  {warehouseCode: 'PS-EU', saleCountryList: ['DE']},
  {warehouseCode: 'PS-SA', saleCountryList: ['SA']},
]}, {site: 'shein-sa'}), 'PS-SA');
assert.throws(() => selectVirtualInventoryWarehouseCode({list: [
  {warehouseCode: 'PS-SA-1', saleCountryList: ['SA']},
  {warehouseCode: 'PS-SA-2', saleCountryList: ['SA']},
]}, {site: 'shein-sa'}), /Multiple merchant warehouses match SA/);
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '1', skuCount: 1, platformUsableInventory: 20, etSellableInventory: 100, etSnapshotCurrentDay: true, c7SaleCount: 0, policy}).action, 'set_exact');
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '1', skuCount: 1, platformUsableInventory: 20, etSellableInventory: 99, etSnapshotCurrentDay: true, c7SaleCount: 0, policy}), {
  action: 'set_exact',
  reason: 'platform_low_top_up_to_et_sellable',
  targetUsableInventory: 99,
  etSellableInventory: 99,
});
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '1', skuCount: 1, platformUsableInventory: 20, etSellableInventory: 10, etSnapshotCurrentDay: true, c7SaleCount: 3, policy}).action, 'allocate');
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '1', skuCount: 1, platformUsableInventory: 50, etSellableInventory: 11, etSnapshotCurrentDay: true, c7SaleCount: 2, policy}), {
  action: 'set_exact',
  reason: 'recent_sale_scarcity_cap_to_ten',
  targetUsableInventory: 10,
  etSellableInventory: 11,
});
assert.equal(decideDailyInventoryReplenishment({shelfStatusCode: '1', skuCount: 1, platformUsableInventory: 7, etSellableInventory: 11, etSnapshotCurrentDay: true, c7SaleCount: 2, policy}).reason, 'recent_sale_scarcity_inventory_within_band');
assert.equal(decideDailyInventoryReplenishment({shelfStatusCode: '1', skuCount: 1, platformUsableInventory: 4, etSellableInventory: 11, etSnapshotCurrentDay: true, c7SaleCount: 2, policy}).reason, 'recent_sale_scarcity_refill_to_ten');
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '1', skuCount: 2, platformUsableInventory: 1, etSellableInventory: 500, etSnapshotCurrentDay: true, c7SaleCount: 0, policy}).reason, 'sku_count_not_one');
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '4', skuCount: 1, platformUsableInventory: 1, etSellableInventory: 500, etSnapshotCurrentDay: true, c7SaleCount: 0, policy}).reason, 'shelf_status_not_eligible');
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '3', otherStoreOnShelfWithStock: true, skuCount: 1, platformUsableInventory: 0, etSellableInventory: 40, etSnapshotCurrentDay: true, c7SaleCount: 0, policy}).targetUsableInventory, 40);
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '3', otherStoreOnShelfWithStock: false, skuCount: 1, platformUsableInventory: 0, etSellableInventory: 40, etSnapshotCurrentDay: true, c7SaleCount: 0, policy}).reason, 'sold_out_without_other_store_selling');
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '3', sameStoreOnShelfLinkExists: true, otherStoreOnShelfWithStock: true, skuCount: 1, platformUsableInventory: 0, etSellableInventory: 40, etSnapshotCurrentDay: true, c7SaleCount: 0, policy}).reason, 'sold_out_has_same_store_on_shelf_link');
assert.equal(decideDailyInventoryReplenishment({shelfStatusCode: '3', otherStoreOnShelfWithStock: false, skuCount: 1, platformUsableInventory: 0, etSellableInventory: 40, etSnapshotCurrentDay: true, c7SaleCount: 1, policy}).targetUsableInventory, 10);
assert.deepEqual(decideDailyInventoryReplenishment({
  shelfStatusCode: '3', otherStoreOnShelfWithStock: false, skuCount: 1,
  platformUsableInventory: 0, etSellableInventory: 120, etSnapshotCurrentDay: true,
  c7SaleCount: 0, allStoreSoldOutBootstrapSeed: true, policy,
}), {
  action: 'set_exact',
  reason: 'all_store_sold_out_bootstrap_seed',
  targetUsableInventory: 10,
  etSellableInventory: 120,
});
const bootstrapSelection = selectAllStoreSoldOutBootstrapSeed([
  {storeKey: 'B', skc: 'b-low', c7Exposure: 20, c7GoodsVisitors: 5, c7SaleCount: 0},
  {storeKey: 'A', skc: 'a-best', c7Exposure: 100, c7GoodsVisitors: 10, c7SaleCount: 0},
  {storeKey: 'A', skc: 'a-duplicate', c7Exposure: 50, c7GoodsVisitors: 9, c7SaleCount: 0},
], policy);
assert.equal(bootstrapSelection.seed.skc, 'a-best');
assert.deepEqual(bootstrapSelection.storeCandidates.map(row => row.skc), ['a-best', 'b-low']);
assert.deepEqual(bootstrapSelection.duplicates.map(row => row.skc), ['a-duplicate']);
assert.throws(() => selectAllStoreSoldOutBootstrapSeed([
  {storeKey: 'A', skc: 'missing-exposure', c7Exposure: null, c7GoodsVisitors: 1, c7SaleCount: 0},
], policy), /missing bootstrap ranking evidence/);
assert.ok(compareAllStoreSoldOutBootstrapCandidates(
  {storeKey: 'A', skc: '1', c7Exposure: 2, c7GoodsVisitors: 0, c7SaleCount: 0},
  {storeKey: 'B', skc: '2', c7Exposure: 1, c7GoodsVisitors: 100, c7SaleCount: 100},
) < 0);
assert.deepEqual(normalizeOpenApiProductCatalog([
  {spuName: 'b', skcName: '2', supplierCode: 'B-2', skuCodeList: ['z', 'a', 'a']},
  {spuName: 'a', skcList: [{skcName: '1', supplierCode: 'A-1', skuList: [{skuCode: 'x'}]}]},
]), [
  {spuName: 'a', skcName: '1', supplierCode: 'A-1', skuCodeList: ['x']},
  {spuName: 'b', skcName: '2', supplierCode: 'B-2', skuCodeList: ['a', 'z']},
]);
assert.equal(computeInventoryOverwriteQuantity(100, {totalInventoryQuantity: 10, totalUsableInventory: 8, totalLockedQuantity: 1}), 102);
assert.equal(computeInventoryOverwriteQuantity(10, {totalInventoryQuantity: 100, totalUsableInventory: 100, totalLockedQuantity: 0}), 10);
assert.equal(computeInventoryOverwriteQuantity(0, {totalInventoryQuantity: 12, totalUsableInventory: 10, totalLockedQuantity: 2}), 2);
const allocations = allocateLowEtInventory([
  {storeKey: 'A', skc: '1', c7Exposure: 500, c7GoodsVisitors: 10, c7SaleCount: 0},
  {storeKey: 'B', skc: '2', c7Exposure: 400, c7GoodsVisitors: 10, c7SaleCount: 0},
  {storeKey: 'C', skc: '3', c7Exposure: 300, c7GoodsVisitors: 10, c7SaleCount: 0},
  {storeKey: 'D', skc: '4', c7Exposure: 200, c7GoodsVisitors: 10, c7SaleCount: 0},
  {storeKey: 'E', skc: '5', c7Exposure: 100, c7GoodsVisitors: 10, c7SaleCount: 0},
  {storeKey: 'F', skc: '6', c7Exposure: 50, c7GoodsVisitors: 10, c7SaleCount: 0},
], 8, policy);
assert.deepEqual(allocations.map(row => row.targetUsableInventory), [2, 2, 2, 1, 1, 0]);
assert.deepEqual(allocations.map(row => row.exposureRank), [1, 2, 3, 4, 5, 6]);
assert.deepEqual(classifyEtInventoryAlert({current_sellable_quantity: 0}, policy).severity, 'critical');
assert.deepEqual(classifyEtInventoryAlert({current_sellable_quantity: null}, policy).severity, 'unknown');
assert.deepEqual(classifyEtInventoryAlert({current_sellable_quantity: 80, days_of_supply_on_hand: 119}, policy).reason, 'et_days_of_supply_below_replenishment_threshold');
assert.deepEqual(classifyEtInventoryAlert({current_sellable_quantity: 10, days_of_supply_on_hand: 120}, policy).reason, 'et_quantity_needs_manual_allocation');
assert.deepEqual(classifyEtInventoryAlert({current_sellable_quantity: 11, days_of_supply_on_hand: 120}, policy).reason, 'sufficient');
assert.equal(stableInventoryHash({b: 1, a: 2}), stableInventoryHash({a: 2, b: 1}));
const hash = 'a'.repeat(64);
assert.deepEqual(assertDailyInventoryExecutionAuthorization({policy, payloadHash: hash, confirmHash: hash}).mode, 'manual_review');
assert.throws(() => assertDailyInventoryExecutionAuthorization({policy, payloadHash: hash, confirmHash: 'b'.repeat(64)}), /confirm-hash/);
assert.throws(() => assertDailyInventoryExecutionAuthorization({policy, mode: 'automatic', payloadHash: hash, confirmHash: hash}), /Automatic inventory execution is not enabled/);
const automaticPolicy = structuredClone(policy);
automaticPolicy.execution = {
  mode: 'automatic',
  perRunUserConfirmationRequired: false,
  perRunPayloadHashRequired: true,
  storeScope: 'all_enabled_stores',
  automaticExecution: {
    enabled: true,
    authorizationId: 'owner-automatic-inventory-20260803-v1',
    allowedContext: 'cloud_daily_inventory_replenishment_guard',
  },
};
assert.deepEqual(assertDailyInventoryExecutionAuthorization({
  policy: automaticPolicy,
  mode: 'automatic',
  context: 'cloud_daily_inventory_replenishment_guard',
  authorizationId: 'owner-automatic-inventory-20260803-v1',
  payloadHash: hash,
  confirmHash: hash,
}), {
  mode: 'automatic',
  authorizationId: 'owner-automatic-inventory-20260803-v1',
  context: 'cloud_daily_inventory_replenishment_guard',
  payloadHash: hash,
  storeScope: 'all_enabled_stores',
});
assert.throws(() => assertDailyInventoryExecutionAuthorization({
  policy: automaticPolicy,
  mode: 'automatic',
  context: 'wrong_context',
  authorizationId: 'owner-automatic-inventory-20260803-v1',
  payloadHash: hash,
  confirmHash: hash,
}), /context is not authorized/);
assert.throws(() => assertDailyInventoryExecutionAuthorization({
  policy: automaticPolicy,
  mode: 'automatic',
  context: 'cloud_daily_inventory_replenishment_guard',
  authorizationId: 'wrong_authorization',
  payloadHash: hash,
  confirmHash: hash,
}), /authorization id mismatch/);
const livePolicy = JSON.parse(fs.readFileSync(new URL('../config/inventory_replenishment_policy.json', import.meta.url), 'utf8'));
const guardScript = fs.readFileSync(new URL('./cloud_daily_inventory_replenishment_guard.sh', import.meta.url), 'utf8');
const guardService = fs.readFileSync(new URL('../infra/systemd/shein-bi-daily-inventory-replenishment-guard.service', import.meta.url), 'utf8');
const dailyCoordinator = fs.readFileSync(new URL('./cloud_morning_chain.sh', import.meta.url), 'utf8');
const etSafetyGuard = fs.readFileSync(new URL('./cloud_et_low_inventory_guard.sh', import.meta.url), 'utf8');
const etSafetyService = fs.readFileSync(new URL('../infra/systemd/shein-bi-et-low-inventory-guard.service', import.meta.url), 'utf8');
const executorScript = fs.readFileSync(new URL('./inventory/execute_daily_inventory_replenishment_plan.mjs', import.meta.url), 'utf8');
const inventoryRules = fs.readFileSync(new URL('../docs/inventory-replenishment-patrol-rules.md', import.meta.url), 'utf8');
assert.equal(livePolicy.execution.mode, 'automatic');
assert.equal(livePolicy.execution.perRunUserConfirmationRequired, false);
assert.equal(livePolicy.execution.automaticExecution.enabled, true);
assert.equal(livePolicy.lowEtFastGuard.enabled, true);
assert.equal(livePolicy.lowEtFastGuard.decreaseOnly, true);
assert.equal(livePolicy.execution.automaticExecution.authorizationByContext.cloud_et_low_inventory_guard, 'owner-automatic-et-low-inventory-20260806-v1');
assert.match(guardScript, /flock -n 9/);
assert.match(guardScript, /ensure_links_data_fresh/);
assert.match(guardScript, /api\/bi\/section\/linksData\?refresh=1/);
assert.match(guardScript, /refresh 19-store read-only OpenAPI product\/stock snapshots/);
assert.match(guardScript, /build_plan \|\| PLAN_STATUS=\$\?/);
assert.match(guardScript, /--execution-mode automatic/);
assert.match(guardScript, /--confirm-hash "\$HASH"/);
assert.match(guardScript, /--bootstrap-lock-file "\$BOOTSTRAP_LOCK_FILE"/);
assert.match(guardScript, /state:"already_completed"/);
assert.match(guardScript, /automatic inventory executor did not produce a complete result[\s\S]*exit 1/);
assert.match(guardService, new RegExp(`SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT=${livePolicy.execution.automaticExecution.allowedContext}`));
assert.match(guardService, new RegExp(`SHEIN_BI_INVENTORY_AUTOMATION_AUTHORIZATION=${livePolicy.execution.automaticExecution.authorizationId}`));
assert.match(guardService, /^Wants=.*shein-bi-cloud-morning-chain\.service$/m);
assert.match(guardService, /^After=.*shein-bi-cloud-morning-chain\.service.*shein-bi-cloud-et-forwarder\.service$/m);
assert.match(guardService, /^Environment=SHEIN_BI_INVENTORY_LINKS_MAX_AGE_SECONDS=1800$/m);
assert.match(guardService, /--deadline-at 15:27/);
assert.match(guardScript, /STOCK_NOT_BEFORE="\$\{SHEIN_BI_INVENTORY_STOCK_NOT_BEFORE:-\$\{DATE\}T15:11:00\+08:00\}"/);
assert.match(dailyCoordinator, /run_inventory_stage/);
assert.match(dailyCoordinator, /SHEIN_BI_INVENTORY_STOCK_NOT_BEFORE="\$\{RUN_DATE\}T00:00:00\+08:00"/);
assert.match(dailyCoordinator, /cloud_daily_inventory_replenishment_guard\.sh/);
assert.match(executorScript, /Always publish the complete terminal envelope\.\s*await writeResultFile\(results\);/);
assert.match(executorScript, /requestWithRateLimitRetry\(client, '\/open-api\/stock\/change-inventory\/v2'/);
const bootstrapPendingIndex = executorScript.indexOf('reserveInventoryBootstrapLock(args.bootstrapLockFile');
const inventoryWriteIndex = executorScript.indexOf("'/open-api/stock/change-inventory/v2'");
assert.ok(bootstrapPendingIndex >= 0 && bootstrapPendingIndex < inventoryWriteIndex, 'bootstrap pending lock must precede inventory write');
assert.match(executorScript, /Bootstrap group gained usable inventory/);
assert.match(executorScript, /Bootstrap store product catalog changed after plan/);
assert.match(executorScript, /Bootstrap group canonical changed or is unavailable/);
assert.match(executorScript, /canonicalInventoryKey\(liveListing\.liveSupplierCode\) !== bootstrapMatchKey/);
assert.match(executorScript, /daily-inventory-bootstrap-/);
assert.match(executorScript, /activateInventoryBootstrapLock/);
assert.match(executorScript, /executionBootstrapRegistryHash = reservation\.hash/);
assert.match(executorScript, /executionBootstrapRegistryHash = activation\.hash/);
assert.match(inventoryRules, /回滚前必须先停止并禁用每日库存守卫和 ET 低库存守卫/);
assert.match(etSafetyGuard, /--execution-mode automatic/);
assert.match(etSafetyGuard, /--confirm-hash "\$HASH"/);
assert.match(etSafetyGuard, /--bootstrap-lock-file "\$BOOTSTRAP_LOCK_FILE"/);
assert.match(etSafetyService, /SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT=cloud_et_low_inventory_guard/);
console.log(JSON.stringify({ok: true, checks: 79}, null, 2));
