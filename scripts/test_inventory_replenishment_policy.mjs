#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  allocateLowEtInventory,
  assertDailyInventoryExecutionAuthorization,
  canonicalInventoryKey,
  classifyEtInventoryAlert,
  computeInventoryOverwriteQuantity,
  decideDailyInventoryReplenishment,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';

const policy = {
  triggerUsableInventoryAtOrBelow: 20,
  targetUsableInventory: 100,
  minimumEtSellableForVirtualTopUp: 11,
  lowEtAllocationAtOrBelow: 10,
  recentSaleScarcity: {minimumSaleCount: 1, targetUsableInventory: 10, refillWhenBelow: 5, capWhenAbove: 10},
  lowEtAllocation: {topExposureLinkCount: 5},
  eligibleShelfStatusCodes: ['1', '3'],
  soldOutRequiresOtherStoreOnShelfWithStock: true,
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
assert.equal(decideDailyInventoryReplenishment({shelfStatusCode: '3', otherStoreOnShelfWithStock: false, skuCount: 1, platformUsableInventory: 0, etSellableInventory: 40, etSnapshotCurrentDay: true, c7SaleCount: 1, policy}).targetUsableInventory, 10);
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
assert.throws(() => assertDailyInventoryExecutionAuthorization({policy, mode: 'automatic', payloadHash: hash, confirmHash: hash}), /automation is disabled/);
console.log(JSON.stringify({ok: true, checks: 27}, null, 2));
