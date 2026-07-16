#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  applyManualLimitedDiscountOverride,
  buildManualLimitedDiscountIndex,
  classifyManualLimitedDiscountLiveState,
  findActiveManualLimitedDiscount,
  loadManualLimitedDiscountRegistry,
  partitionRowsByManualLimitedDiscount,
  resolveManualLimitedDiscountInventoryAction,
} from '../../lib/marketing_manual_limited_discount_overrides.mjs';
import {buildLimitedDiscountDriftRescuePlan} from './build_limited_discount_drift_rescue_plan.mjs';
import {buildManualLimitedDiscountRestorePlan} from './build_manual_limited_discount_restore_plan.mjs';

const activeAt = new Date('2026-07-13T12:00:00+08:00');
const expiredAt = new Date('2026-07-21T12:00:00+08:00');
const registry = await loadManualLimitedDiscountRegistry();
const protectedRows = [
  {storeKey: 'DX', skc: 'sv260128171583714957215', limitedDiscountPrice: 283, finalTargetPrice: 293.34, limitedDiscountName: 'wrong ordinary repair'},
  {storeKey: 'HL', skc: 'sv260204035473792493137', limitedDiscountPrice: 127.29, finalTargetPrice: 135.62, limitedDiscountName: '80123125 wrong ordinary repair'},
  {storeKey: 'YJ', skc: 'sv260202233956355340972', limitedDiscountPrice: 163.75, finalTargetPrice: 176.2, limitedDiscountName: 'stale deleted row'},
];
const ordinaryDrift = {storeKey: 'FY', skc: 'sv-real-drift', limitedDiscountPrice: 90, finalTargetPrice: 100, limitedDiscountName: 'ordinary real drift'};
const staleGuard = {
  reportDate: '2026-07-13',
  limitedDiscountTargetPriceDrift: {belowRows: [...protectedRows, ordinaryDrift]},
};

// Explicit legacy mode proves the regression: without the registry, all three
// user-approved prices would be queued together with the real drift.
const legacy = buildLimitedDiscountDriftRescuePlan(staleGuard, {manualRegistry: {entries: []}, now: activeAt});
assert.equal(legacy.totals.selected, 4);
for (const row of protectedRows) {
  assert(legacy.groups.some(group => group.rows.some(item => item.storeKey === row.storeKey && item.skc === row.skc)));
}

const protectedPlan = buildLimitedDiscountDriftRescuePlan(staleGuard, {manualRegistry: registry, now: activeAt});
assert.equal(protectedPlan.totals.protectedManualSpecial, 3);
assert.equal(protectedPlan.totals.selected, 1);
assert.equal(protectedPlan.groups[0].rows[0].skc, ordinaryDrift.skc);

// Expiry is automatic: the exact same stale guard becomes ordinary drift again.
const expiredPlan = buildLimitedDiscountDriftRescuePlan(staleGuard, {manualRegistry: registry, now: expiredAt});
assert.equal(expiredPlan.totals.protectedManualSpecial, 0);
assert.equal(expiredPlan.totals.selected, 4);

// A stale rescue file is filtered independently of guard generation.
const staleRescue = {rows: protectedRows.map(row => ({...row, targetPrice: row.finalTargetPrice}))};
const stalePartition = partitionRowsByManualLimitedDiscount(staleRescue.rows, buildManualLimitedDiscountIndex(registry, activeAt), activeAt);
assert.equal(stalePartition.protectedRows.length, 3);
assert.equal(stalePartition.ordinaryRows.length, 0);

// Missing and mismatched live activities restore the registered exact prices.
const restoreGuard = {
  manualSpecialLimitedDiscount: {
    rows: [
      {storeKey: 'DX', skc: protectedRows[0].skc, status: 'price_mismatch', livePrices: [293.34], activityIds: [80100001]},
      {storeKey: 'HL', skc: protectedRows[1].skc, status: 'price_mismatch', livePrices: [135.62], activityIds: [80123125]},
      {storeKey: 'YJ', skc: protectedRows[2].skc, status: 'missing', livePrices: [], activityIds: []},
    ],
  },
};
const restorePlan = buildManualLimitedDiscountRestorePlan(restoreGuard, registry, activeAt);
assert.equal(restorePlan.restoreCount, 3);
assert.deepEqual(restorePlan.rows.map(row => row.specialPrice).sort((a, b) => a - b), [127.29, 163.75, 283]);
for (const row of restorePlan.rows) {
  const entry = findActiveManualLimitedDiscount(registry, row.storeKey, row.skc, activeAt);
  const applied = applyManualLimitedDiscountOverride({storeKey: row.storeKey, skc: row.skc, finalTargetPrice: 999, limitedDiscountPrice: 999}, entry);
  assert.equal(applied.limitedDiscountPrice, row.specialPrice);
  assert.equal(applied.finalTargetPrice, row.specialPrice);
  assert.equal(applied.endTime, row.validTo);
}

// Order GSH18Y59400NC9G is expected at 283 only inside the protected window.
const dxInside = findActiveManualLimitedDiscount(registry, 'DX', protectedRows[0].skc, '2026-07-13 10:00:00');
const dxOutside = findActiveManualLimitedDiscount(registry, 'DX', protectedRows[0].skc, '2026-07-21 10:00:00');
assert.equal(dxInside.specialPrice, 283);
assert.equal(283 - dxInside.specialPrice, 0);
assert.equal(dxOutside, null);
assert(283 < 293.34); // Outside the window, the ordinary target comparison applies again.

const exactLive = classifyManualLimitedDiscountLiveState(dxInside, [{
  activityId: 80100002,
  price: 283,
  activityStock: 10,
  end: dxInside.validTo,
}]);
assert.equal(exactLive.status, 'covered_exact');
const shortStockLive = classifyManualLimitedDiscountLiveState(dxInside, [{
  activityId: 80100002,
  price: 283,
  activityStock: 9,
  end: dxInside.validTo,
}]);
assert.equal(shortStockLive.status, 'coverage_mismatch');
const missingCoverageEvidence = classifyManualLimitedDiscountLiveState(dxInside, [{price: 283}]);
assert.equal(missingCoverageEvidence.status, 'coverage_mismatch');

// ET evidence is the only authority that permits a virtual-stock top-up.
assert.deepEqual(
  resolveManualLimitedDiscountInventoryAction({platformStock: 9, etStock: 18, activityStock: 10}).action,
  'top_up_platform_virtual_stock',
);
const etBlocked = resolveManualLimitedDiscountInventoryAction({platformStock: 9, etStock: 8, activityStock: 10});
assert.equal(etBlocked.ok, false);
assert.equal(etBlocked.reason, 'et_stock_below_activity_stock');

const [restoreBatchSource, applySource, guardSource, registryManagerSource] = await Promise.all([
  fs.readFile('scripts/marketing/batch_restore_manual_limited_discounts.mjs', 'utf8'),
  fs.readFile('scripts/marketing/apply_hl_limited_discount_rescue.mjs', 'utf8'),
  fs.readFile('scripts/cloud_marketing_live_guard.sh', 'utf8'),
  fs.readFile('scripts/marketing/manage_manual_limited_discount_override.mjs', 'utf8'),
]);
assert.match(restoreBatchSource, /assessRecoverableDryRun/);
assert.match(restoreBatchSource, /final dry-run did not reach ok=true/);
assert.match(applySource, /exactReadbackRows/);
assert.match(applySource, /expectedActivityStock/);
assert.match(guardSource, /WRITE_PHASE_FAILED/);
assert.match(guardSource, /SKIP new-listing fallback because an earlier write phase failed/);
assert.match(registryManagerSource, /acquireCrossProcessTicketLock/);

console.log(JSON.stringify({
  ok: true,
  legacyQueued: legacy.totals.selected,
  protectedExcluded: protectedPlan.totals.protectedManualSpecial,
  ordinaryDriftStillQueued: protectedPlan.totals.selected,
  expiredQueued: expiredPlan.totals.selected,
  staleRescueProtected: stalePartition.protectedRows.length,
  exactRestorePrices: restorePlan.rows.map(row => ({storeKey: row.storeKey, skc: row.skc, specialPrice: row.specialPrice})),
  orderInsideExpectedPrice: dxInside.specialPrice,
  orderOutsideFallsBackToOrdinaryTarget: 293.34,
  inventoryBranches: {enough: 'top_up_platform_virtual_stock', insufficient: etBlocked.reason},
  liveCoverageChecks: {exact: exactLive.status, shortStock: shortStockLive.status, missingEvidence: missingCoverageEvidence.status},
}, null, 2));
