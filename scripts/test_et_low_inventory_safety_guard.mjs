#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildEtLowInventorySafetyPlan} from './inventory/build_et_low_inventory_safety_plan.mjs';
import {assertDailyInventoryExecutionAuthorization} from '../lib/inventory_replenishment_policy.mjs';

const sourcePlan = {
  schemaVersion: 'daily-inventory-replenishment-plan/v1',
  date: '2026-08-06',
  policyVersion: '2026-08-06.1',
  payloadHash: 'a'.repeat(64),
  sourceEvidence: [{store: 'ET', fetchedAt: '2026-08-06T05:20:00.000Z', ageHours: 0.1}],
  blockers: [],
  actionable: [
    {storeKey: 'A', skc: 'down', matchKey: 'LOW1', ruleClass: 'low_et_top_exposure_allocation', platformUsableInventory: 10, targetUsableInventory: 2, inventoryAction: 'decrease', replenishmentQuantity: 0},
    {storeKey: 'B', skc: 'up', matchKey: 'LOW1', ruleClass: 'low_et_top_exposure_allocation', platformUsableInventory: 0, targetUsableInventory: 2, inventoryAction: 'increase', replenishmentQuantity: 2},
    {storeKey: 'C', skc: 'ordinary', matchKey: 'HIGH1', ruleClass: 'legacy_virtual_inventory_top_up', platformUsableInventory: 0, targetUsableInventory: 100, inventoryAction: 'increase', replenishmentQuantity: 100},
  ],
  lowEtAllocations: [
    {storeKey: 'A', skc: 'down', matchKey: 'LOW1', etSellableInventory: 4, platformUsableInventory: 10, targetUsableInventory: 2},
    {storeKey: 'B', skc: 'up', matchKey: 'LOW1', etSellableInventory: 4, platformUsableInventory: 0, targetUsableInventory: 2},
  ],
  counts: {enabledStores: 2, scannedLinks: 3, inventoryRelevantLinks: 3, lowEtBlockedCanonicalCount: 0},
};

const plan = buildEtLowInventorySafetyPlan(sourcePlan, {batchId: 'et-daily-2026-08-06-test'});
assert.equal(plan.schemaVersion, 'et-low-inventory-safety-plan/v1');
assert.equal(plan.executionConstraints.decreaseOnly, true);
assert.equal(plan.actionable.length, 1);
assert.equal(plan.actionable[0].skc, 'down');
assert.equal(plan.counts.inventoryIncreases, 0);
assert.equal(plan.counts.filteredOutIncreaseActions, 1);
assert.equal(plan.watch.active, true);
assert.match(plan.payloadHash, /^[a-f0-9]{64}$/);

const policy = JSON.parse(fs.readFileSync(new URL('../config/inventory_replenishment_policy.json', import.meta.url), 'utf8'));
const auth = assertDailyInventoryExecutionAuthorization({
  policy,
  mode: 'automatic',
  context: 'cloud_et_low_inventory_guard',
  authorizationId: 'owner-automatic-et-low-inventory-20260806-v1',
  payloadHash: plan.payloadHash,
  confirmHash: plan.payloadHash,
});
assert.equal(auth.context, 'cloud_et_low_inventory_guard');
assert.throws(() => assertDailyInventoryExecutionAuthorization({
  policy,
  mode: 'automatic',
  context: 'cloud_et_low_inventory_guard',
  authorizationId: 'owner-automatic-inventory-20260803-v1',
  payloadHash: plan.payloadHash,
  confirmHash: plan.payloadHash,
}), /authorization id mismatch/);

const executor = fs.readFileSync(new URL('./inventory/execute_daily_inventory_replenishment_plan.mjs', import.meta.url), 'utf8');
const forwarder = fs.readFileSync(new URL('./cloud_et_forwarder_sync.sh', import.meta.url), 'utf8');
const guard = fs.readFileSync(new URL('./cloud_et_low_inventory_guard.sh', import.meta.url), 'utf8');
const recheck = fs.readFileSync(new URL('./cloud_et_low_inventory_recheck.sh', import.meta.url), 'utf8');
const forwarderService = fs.readFileSync(new URL('../infra/systemd/shein-bi-cloud-et-forwarder.service', import.meta.url), 'utf8');
const guardService = fs.readFileSync(new URL('../infra/systemd/shein-bi-et-low-inventory-guard.service', import.meta.url), 'utf8');
const recheckTimer = fs.readFileSync(new URL('../infra/systemd/shein-bi-et-low-inventory-recheck.timer', import.meta.url), 'utf8');
const recheckService = fs.readFileSync(new URL('../infra/systemd/shein-bi-et-low-inventory-recheck.service', import.meta.url), 'utf8');
assert.match(executor, /skipped_safety_no_increase/);
assert.match(executor, /Decrease-only safety plan contains a non-decrease action/);
assert.match(forwarder, /orders,waybills,afterSales,inventoryTrend/);
assert.match(forwarderService, /^OnSuccess=shein-bi-et-low-inventory-guard\.service$/m);
assert.match(guardService, /SHEIN_BI_INVENTORY_AUTOMATION_CONTEXT=cloud_et_low_inventory_guard/);
assert.match(guard, /--operation-mode et_low_inventory_safety/);
assert.match(guard, /\{ok:\(\$blocked==0\),businessState:/);
assert.match(guard, /pendingCanonical:\$blockedCanonical/);
assert.match(guard, /if \(\( BLOCKED > 0 \)\); then exit 1; fi/);
assert.doesNotMatch(guard, /BLOCKED > 0 \|\| BLOCKED_CANONICAL > 0/);
assert.match(recheck, /SHEIN_ET_ENDPOINTS="store_stock,box_stock"/);
assert.match(recheck, /SHEIN_ET_TRANSPORT="\$\{SHEIN_ET_TRANSPORT:-http\}"/);
assert.match(recheckService, /^Environment=SHEIN_ET_TRANSPORT=http$/m);
assert.doesNotMatch(recheckService, /run_host_browser_read_job\.sh|--class browser/);
assert.match(recheckTimer, /^OnCalendar=\*-\*-\* 00,02,05,06,08,09,11,12,15,16,18,19,22:20:00$/m);
assert.match(recheckTimer, /^Persistent=false$/m);

console.log(JSON.stringify({ok: true, checks: 26}, null, 2));
