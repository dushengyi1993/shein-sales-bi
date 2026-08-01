#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
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
  minimumEtSellableForVirtualTopUp: 21,
  eligibleShelfStatusCodes: ['1', '3'],
  soldOutRequiresOtherStoreOnShelfWithStock: true,
  requireExactlyOneSku: true,
  requireCurrentDayEtSnapshot: true,
  etAlerts: {criticalDaysOfSupply: 7, warningDaysOfSupply: 14, lowQuantity: 20, replenishmentDaysOfSupply: 90},
  execution: {
    mode: 'manual_review',
    perRunUserConfirmationRequired: true,
    perRunPayloadHashRequired: true,
    storeScope: 'all_enabled_stores',
    automaticExecution: {enabled: false},
  },
};

assert.equal(canonicalInventoryKey('SK-04031胶囊咖啡机'), 'SK04031');
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '1', skuCount: 1, platformUsableInventory: 20, etSellableInventory: 100, etSnapshotCurrentDay: true, policy}).action, 'top_up');
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '1', skuCount: 1, platformUsableInventory: 20, etSellableInventory: 99, etSnapshotCurrentDay: true, policy}), {
  action: 'top_up',
  reason: 'platform_low_top_up_to_et_sellable',
  targetUsableInventory: 99,
  etSellableInventory: 99,
});
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '1', skuCount: 1, platformUsableInventory: 20, etSellableInventory: 20, etSnapshotCurrentDay: true, policy}).action, 'alert');
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '1', skuCount: 2, platformUsableInventory: 1, etSellableInventory: 500, etSnapshotCurrentDay: true, policy}).reason, 'sku_count_not_one');
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '4', skuCount: 1, platformUsableInventory: 1, etSellableInventory: 500, etSnapshotCurrentDay: true, policy}).reason, 'shelf_status_not_eligible');
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '3', otherStoreOnShelfWithStock: true, skuCount: 1, platformUsableInventory: 0, etSellableInventory: 40, etSnapshotCurrentDay: true, policy}).targetUsableInventory, 40);
assert.deepEqual(decideDailyInventoryReplenishment({shelfStatusCode: '3', otherStoreOnShelfWithStock: false, skuCount: 1, platformUsableInventory: 0, etSellableInventory: 40, etSnapshotCurrentDay: true, policy}).reason, 'sold_out_without_other_store_selling');
assert.equal(computeInventoryOverwriteQuantity(100, {totalInventoryQuantity: 10, totalUsableInventory: 8, totalLockedQuantity: 1}), 102);
assert.deepEqual(classifyEtInventoryAlert({current_sellable_quantity: 0}, policy).severity, 'critical');
assert.deepEqual(classifyEtInventoryAlert({current_sellable_quantity: null}, policy).severity, 'unknown');
assert.deepEqual(classifyEtInventoryAlert({current_sellable_quantity: 80, days_of_supply_on_hand: 30}, policy).reason, 'et_days_of_supply_below_three_months');
assert.deepEqual(classifyEtInventoryAlert({current_sellable_quantity: 20, days_of_supply_on_hand: 120}, policy).reason, 'et_quantity_needs_manual_allocation');
assert.equal(stableInventoryHash({b: 1, a: 2}), stableInventoryHash({a: 2, b: 1}));
const hash = 'a'.repeat(64);
assert.deepEqual(assertDailyInventoryExecutionAuthorization({policy, payloadHash: hash, confirmHash: hash}).mode, 'manual_review');
assert.throws(() => assertDailyInventoryExecutionAuthorization({policy, payloadHash: hash, confirmHash: 'b'.repeat(64)}), /confirm-hash/);
assert.throws(() => assertDailyInventoryExecutionAuthorization({policy, mode: 'automatic', payloadHash: hash, confirmHash: hash}), /automation is disabled/);
console.log(JSON.stringify({ok: true, checks: 17}, null, 2));
