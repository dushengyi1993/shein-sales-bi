#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  driftRepairBatchExitCode,
  isSettledDriftRepairResult,
  isTerminalDriftBusinessBlock,
  summarizeDriftRepairOutcomes,
} from '../../lib/marketing_drift_repair_outcome.mjs';
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

const driftResults = [
  {ok: true, status: 'replaced_all', readback: {ok: true, safe: true}},
  {ok: false, status: 'initial_platform_blocked_preserved', readback: {ok: false, safe: true}},
  {ok: false, status: 'create_preflight_blocked_without_deletion', readback: {ok: false, safe: true}},
];
assert.equal(isTerminalDriftBusinessBlock(driftResults[1]), true);
assert.equal(isSettledDriftRepairResult(driftResults[1]), true, 'safe business blockers must not replay within the same immutable daily manifest');
assert.equal(isTerminalDriftBusinessBlock(driftResults[2]), false, 'transport/preflight failures remain retryable system failures');
assert.deepEqual(summarizeDriftRepairOutcomes(driftResults), {
  completedGroups: 1,
  businessBlockedGroups: 1,
  failedGroups: 1,
  unsafeGroups: 0,
});
assert.equal(driftRepairBatchExitCode({failedGroups: 1, businessBlockedGroups: 2}), 2);
assert.equal(driftRepairBatchExitCode({businessBlockedGroups: 2, deferredGroups: 1}), 3);
assert.equal(driftRepairBatchExitCode({businessBlockedGroups: 2}), 4);
assert.equal(driftRepairBatchExitCode({}), 0);

const batchSource = await import('node:fs/promises').then(fs => (
  fs.readFile(new URL('./batch_fix_limited_discount_drift.mjs', import.meta.url), 'utf8')
));
assert.match(batchSource, /storesBlocked: blockedStoreKeys\.size/);
assert.match(batchSource, /storesFailed: failedStoreKeys\.size/);

console.log(JSON.stringify({
  ok: true,
  test: 'daily_guard_and_drift_worker_classify_completed_blocked_and_failed_repairs',
}));
