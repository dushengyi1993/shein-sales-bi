#!/usr/bin/env node
import assert from 'node:assert/strict';
import {normalizeLimitedRepairResult} from '../../lib/marketing_limited_repair_status.mjs';

const modern = normalizeLimitedRepairResult({
  complete: true,
  deferredGroups: 0,
  totals: {
    planActionable: 10,
    executedTargetCount: 5,
    blockedTargetCount: 5,
  },
  results: [
    {storeKey: 'FY', status: 'executed', targetCount: 1, targetSkcs: ['fy-1']},
    {
      storeKey: 'DL',
      status: 'executed_subset_with_platform_or_inventory_blockers',
      targetCount: 3,
      targetSkcs: ['dl-1', 'dl-2', 'dl-3'],
      execute: {result: {targetCountForCreate: 2}},
      inventoryBlockedSkcs: ['dl-3'],
      blocked: {reason: 'et_stock_below_activity_stock'},
      inventoryTopUps: [{
        dryRun: {decision: {reason: 'et_stock_below_activity_stock'}},
      }],
    },
  ],
});

assert.equal(modern.initialGap, 10);
assert.equal(modern.executedCount, 5);
assert.equal(modern.blockedCount, 5);
assert.equal(modern.remainingGapByAfterScan, 5);
assert.deepEqual(modern.byStoreExec, {FY: 1, DL: 2});
assert.deepEqual(modern.byStoreBlocked, {DL: 1});
assert.deepEqual(modern.reasonSummary, {et_stock_below_activity_stock: 1});

const legacy = normalizeLimitedRepairResult({
  initialGap: 3,
  executedCount: 2,
  blockedCount: 1,
  remaining: [{storeKey: 'TS'}],
  byStoreExec: {FY: 2},
  byStoreBlocked: {TS: 1},
  reasonSummary: {platform_rejected: 1},
});
assert.equal(legacy.initialGap, 3);
assert.equal(legacy.executedCount, 2);
assert.equal(legacy.blockedCount, 1);
assert.equal(legacy.remainingGapByAfterScan, 1);

console.log(JSON.stringify({
  ok: true,
  test: 'daily_guard_normalizes_modern_and_legacy_limited_repair_results',
}));
