#!/usr/bin/env node
import assert from 'node:assert/strict';
import {evaluateProfitMartCacheFreshness} from '../lib/bi_profit_mart_freshness.mjs';

const completeCostAssignment = {
  costRunCompletedAt: '2026-07-23T18:02:05+08:00',
  costRunSourceCutoffAt: '2026-07-23T18:02:05+08:00',
  costAssignmentCoverageRequired: true,
  costAssignmentPostCutoverRows: 10_303,
  costAssignmentPostCutoverAssignedRows: 10_303,
  costAssignmentPostCutoverMissingRows: 0,
};

const pipelineOrdered = evaluateProfitMartCacheFreshness({
  factOrderMax: '2026-07-23',
  factUpdatedAt: '2026-07-23T18:02:00+08:00',
  profitCacheMax: '2026-07-23',
  profitCacheRows: 10_303,
  metaRefreshedAt: '2026-07-23T18:02:10+08:00',
  ...completeCostAssignment,
}, {
  coreGeneratedAt: '2026-07-23T18:02:49+08:00',
});
assert.equal(pipelineOrdered.fresh, true, 'a mart built immediately before core publication is fresh');
assert.equal(pipelineOrdered.coversCore, true);

const oldMart = evaluateProfitMartCacheFreshness({
  factOrderMax: '2026-07-23',
  factUpdatedAt: '2026-07-23T17:29:00+08:00',
  profitCacheMax: '2026-07-23',
  profitCacheRows: 10_303,
  metaRefreshedAt: '2026-07-23T17:30:00+08:00',
  ...completeCostAssignment,
}, {
  coreGeneratedAt: '2026-07-23T18:02:49+08:00',
});
assert.equal(oldMart.fresh, false, 'an actually old mart must still rebuild');
assert.equal(oldMart.coversCore, false);

const missingOrders = evaluateProfitMartCacheFreshness({
  factOrderMax: '2026-07-23',
  factUpdatedAt: '2026-07-23T18:02:30+08:00',
  profitCacheMax: '2026-07-22',
  profitCacheRows: 10_000,
  metaRefreshedAt: '2026-07-23T18:03:00+08:00',
  ...completeCostAssignment,
}, {
  coreGeneratedAt: '2026-07-23T18:02:49+08:00',
});
assert.equal(missingOrders.fresh, false, 'matching timestamps cannot hide missing order dates');
assert.equal(missingOrders.coversOrders, false);

const sameDayWebhookWrite = evaluateProfitMartCacheFreshness({
  factOrderMax: '2026-07-23',
  factUpdatedAt: '2026-07-23T18:04:00+08:00',
  profitCacheMax: '2026-07-23',
  profitCacheRows: 10_303,
  metaRefreshedAt: '2026-07-23T18:03:00+08:00',
  ...completeCostAssignment,
}, {
  coreGeneratedAt: '2026-07-23T18:02:49+08:00',
});
assert.equal(sameDayWebhookWrite.fresh, false, 'a same-day webhook insert must invalidate the profit mart even when max dates match');
assert.equal(sameDayWebhookWrite.coversFactChanges, false);

const cancelledOrderMutation = evaluateProfitMartCacheFreshness({
  factOrderMax: '2026-07-27',
  orderFactUpdatedAt: '2026-07-28T12:50:02+08:00',
  accountingInputUpdatedAt: '2026-07-28T12:50:02+08:00',
  profitCacheMax: '2026-07-27',
  profitCacheRows: 10_303,
  metaRefreshedAt: '2026-07-28T12:49:00+08:00',
  costRunCompletedAt: '2026-07-28T12:49:00+08:00',
  costRunSourceCutoffAt: '2026-07-28T12:49:00+08:00',
  costAssignmentCoverageRequired: true,
  costAssignmentPostCutoverRows: 100,
  costAssignmentPostCutoverAssignedRows: 100,
  costAssignmentPostCutoverMissingRows: 0,
}, {coreGeneratedAt: '2026-07-28T12:49:01+08:00'});
assert.equal(cancelledOrderMutation.fresh, false, 'zeroing a cancelled order must invalidate revenue and profit caches');
assert.equal(cancelledOrderMutation.coversFactChanges, false);
assert.equal(cancelledOrderMutation.coversCostCutoff, false, 'a cancellation must rebuild the ledger so its old sale assignment is removed');

const returnOnlyMutation = evaluateProfitMartCacheFreshness({
  factOrderMax: '2026-07-27',
  orderFactUpdatedAt: '2026-07-28T12:48:00+08:00',
  accountingInputUpdatedAt: '2026-07-28T12:50:02+08:00',
  profitCacheMax: '2026-07-27',
  profitCacheRows: 10_303,
  metaRefreshedAt: '2026-07-28T12:49:00+08:00',
  costRunCompletedAt: '2026-07-28T12:48:30+08:00',
  costRunSourceCutoffAt: '2026-07-28T12:48:30+08:00',
  costAssignmentCoverageRequired: true,
  costAssignmentPostCutoverRows: 100,
  costAssignmentPostCutoverAssignedRows: 100,
  costAssignmentPostCutoverMissingRows: 0,
}, {coreGeneratedAt: '2026-07-28T12:49:01+08:00'});
assert.equal(returnOnlyMutation.fresh, false, 'a return mutation must invalidate profit even when order facts did not change');
assert.equal(returnOnlyMutation.coversFactChanges, false);
assert.equal(returnOnlyMutation.coversCostCutoff, true, 'return-only changes do not require an unnecessary cost-ledger rebuild');

const staleCostLedger = evaluateProfitMartCacheFreshness({
  factOrderMax: '2026-07-25',
  factUpdatedAt: '2026-07-25T18:04:00+08:00',
  profitCacheMax: '2026-07-25',
  profitCacheRows: 10_303,
  metaRefreshedAt: '2026-07-25T18:05:00+08:00',
  costRunCompletedAt: '2026-07-25T17:30:00+08:00',
  costRunSourceCutoffAt: '2026-07-25T17:30:00+08:00',
  costAssignmentCoverageRequired: true,
  costAssignmentPostCutoverRows: 100,
  costAssignmentPostCutoverAssignedRows: 100,
  costAssignmentPostCutoverMissingRows: 0,
}, {coreGeneratedAt: '2026-07-25T18:05:01+08:00'});
assert.equal(staleCostLedger.fresh, false, 'a profit mart cannot hide order facts newer than the completed cost ledger cutoff');
assert.equal(staleCostLedger.coversCostCutoff, false);

const missingCostAssignments = evaluateProfitMartCacheFreshness({
  factOrderMax: '2026-07-25',
  factUpdatedAt: '2026-07-25T18:04:00+08:00',
  profitCacheMax: '2026-07-25',
  profitCacheRows: 10_303,
  metaRefreshedAt: '2026-07-25T18:05:00+08:00',
  costRunCompletedAt: '2026-07-25T18:04:30+08:00',
  costRunSourceCutoffAt: '2026-07-25T18:04:30+08:00',
  costAssignmentCoverageRequired: true,
  costAssignmentPostCutoverRows: 100,
  costAssignmentPostCutoverAssignedRows: 97,
  costAssignmentPostCutoverMissingRows: 3,
}, {coreGeneratedAt: '2026-07-25T18:05:01+08:00'});
assert.equal(missingCostAssignments.fresh, false, 'post-cutover sales without an assignment must block a profit-only rebuild');
assert.equal(missingCostAssignments.coversCostAssignments, false);
assert.equal(missingCostAssignments.costAssignmentCoverageRate, 0.97);

const costComplete = evaluateProfitMartCacheFreshness({
  factOrderMax: '2026-07-25',
  factUpdatedAt: '2026-07-25T18:04:00+08:00',
  profitCacheMax: '2026-07-25',
  profitCacheRows: 10_303,
  metaRefreshedAt: '2026-07-25T18:05:00+08:00',
  costRunCompletedAt: '2026-07-25T18:04:30+08:00',
  costRunSourceCutoffAt: '2026-07-25T18:04:30+08:00',
  costAssignmentCoverageRequired: true,
  costAssignmentPostCutoverRows: 100,
  costAssignmentPostCutoverAssignedRows: 100,
  costAssignmentPostCutoverMissingRows: 0,
}, {coreGeneratedAt: '2026-07-25T18:05:01+08:00'});
assert.equal(costComplete.fresh, true, 'a completed ledger cutoff plus complete post-cutover assignment permits profit refresh');
assert.equal(costComplete.usableSnapshot, true);
assert.equal(costComplete.followUpPending, false);

// New contract tests: Cutoff-scoped assignment coverage with pending follow-up orders
const cutoffCoveredWithFollowUpPending = evaluateProfitMartCacheFreshness({
  factOrderMax: '2026-08-31',
  orderFactUpdatedAt: '2026-08-31T18:35:00+08:00', // Newer order arrived after ledger snapshot
  accountingInputUpdatedAt: '2026-08-31T18:35:00+08:00',
  profitCacheMax: '2026-08-31',
  profitCacheRows: 10_303,
  metaRefreshedAt: '2026-08-31T18:36:00+08:00',
  costRunCompletedAt: '2026-08-31T18:34:30+08:00',
  costRunSourceCutoffAt: '2026-08-31T18:34:00+08:00',
  costAssignmentCoverageRequired: true,
  costAssignmentPostCutoverRows: 105,
  costAssignmentPostCutoverAssignedRows: 100,
  costAssignmentPostCutoverMissingRows: 5, // 5 total missing in entire table
  costAssignmentCutoffRows: 100, // 100 rows existed before snapshot cutoff
  costAssignmentCutoffAssignedRows: 100, // all 100 assigned
  costAssignmentCutoffMissingRows: 0, // 0 missing before cutoff!
  costAssignmentPendingFollowUpRows: 5, // 5 rows arrived after cutoff
}, {coreGeneratedAt: '2026-08-31T18:36:01+08:00'});
assert.equal(cutoffCoveredWithFollowUpPending.coversCostAssignments, true, 'pre-cutoff population must be 100% covered');
assert.equal(cutoffCoveredWithFollowUpPending.usableSnapshot, true, 'consistent snapshot is usable for profit section build without livelock');
assert.equal(cutoffCoveredWithFollowUpPending.followUpPending, true, 'post-cutoff rows must be recognized as pending follow-up');
assert.equal(cutoffCoveredWithFollowUpPending.pendingFollowUpRows, 5);
assert.equal(cutoffCoveredWithFollowUpPending.coversCostCutoff, false, 'freshness accurately reflects that newer orders exist for next cycle catchup');
assert.equal(cutoffCoveredWithFollowUpPending.fresh, false, 'not completely fresh while follow-up orders are pending');

const preCutoffMissingAssignmentsMustFail = evaluateProfitMartCacheFreshness({
  factOrderMax: '2026-08-31',
  orderFactUpdatedAt: '2026-08-31T18:35:00+08:00',
  accountingInputUpdatedAt: '2026-08-31T18:35:00+08:00',
  profitCacheMax: '2026-08-31',
  profitCacheRows: 10_303,
  metaRefreshedAt: '2026-08-31T18:36:00+08:00',
  costRunCompletedAt: '2026-08-31T18:34:30+08:00',
  costRunSourceCutoffAt: '2026-08-31T18:34:00+08:00',
  costAssignmentCoverageRequired: true,
  costAssignmentPostCutoverRows: 105,
  costAssignmentPostCutoverAssignedRows: 98,
  costAssignmentPostCutoverMissingRows: 7,
  costAssignmentCutoffRows: 100,
  costAssignmentCutoffAssignedRows: 98,
  costAssignmentCutoffMissingRows: 2, // 2 missing before cutoff!
  costAssignmentPendingFollowUpRows: 5,
}, {coreGeneratedAt: '2026-08-31T18:36:01+08:00'});
assert.equal(preCutoffMissingAssignmentsMustFail.coversCostAssignments, false, 'missing assignments in pre-cutoff population must fail coverage');
assert.equal(preCutoffMissingAssignmentsMustFail.usableSnapshot, false);
assert.equal(preCutoffMissingAssignmentsMustFail.fresh, false);

// Late-arrival order: created in the past but ingested after snapshot cutoff (updated_at > cutoff)
const lateArrivalFreshness = evaluateProfitMartCacheFreshness({
  factOrderMax: '2026-08-31',
  orderFactUpdatedAt: '2026-08-31T18:35:00+08:00', // Ingestion timestamp is after snapshot cutoff
  accountingInputUpdatedAt: '2026-08-31T18:35:00+08:00',
  profitCacheMax: '2026-08-31',
  profitCacheRows: 10_303,
  metaRefreshedAt: '2026-08-31T18:36:00+08:00',
  costRunCompletedAt: '2026-08-31T18:34:30+08:00',
  costRunSourceCutoffAt: '2026-08-31T18:34:00+08:00',
  costAssignmentCoverageRequired: true,
  costAssignmentPostCutoverRows: 101,
  costAssignmentPostCutoverAssignedRows: 100,
  costAssignmentPostCutoverMissingRows: 1,
  costAssignmentCutoffRows: 100,
  costAssignmentCutoffAssignedRows: 100,
  costAssignmentCutoffMissingRows: 0,
  costAssignmentPendingFollowUpRows: 1, // Late-arrival row conservatively classified as pending follow-up
}, {coreGeneratedAt: '2026-08-31T18:36:01+08:00'});
assert.equal(lateArrivalFreshness.coversCostAssignments, true, 'late arrival must be classified as pending follow-up instead of breaking pre-cutoff coverage');
assert.equal(lateArrivalFreshness.usableSnapshot, true);
assert.equal(lateArrivalFreshness.followUpPending, true);
assert.equal(lateArrivalFreshness.coversCostCutoff, false, 'late arrival invalidates strict freshness to queue follow-up catchup');

// Post-cutoff cancellation: historical order zeroed/modified after cutoff
const postCutoffCancellationFreshness = evaluateProfitMartCacheFreshness({
  factOrderMax: '2026-08-31',
  orderFactUpdatedAt: '2026-08-31T18:35:00+08:00', // Cancellation happened after cutoff
  accountingInputUpdatedAt: '2026-08-31T18:35:00+08:00',
  profitCacheMax: '2026-08-31',
  profitCacheRows: 10_303,
  metaRefreshedAt: '2026-08-31T18:36:00+08:00',
  costRunCompletedAt: '2026-08-31T18:34:30+08:00',
  costRunSourceCutoffAt: '2026-08-31T18:34:00+08:00',
  costAssignmentCoverageRequired: true,
  costAssignmentPostCutoverRows: 100,
  costAssignmentPostCutoverAssignedRows: 100,
  costAssignmentPostCutoverMissingRows: 0,
  costAssignmentCutoffRows: 100,
  costAssignmentCutoffAssignedRows: 100,
  costAssignmentCutoffMissingRows: 0,
  costAssignmentPendingFollowUpRows: 1, // Mutation classified as pending follow-up via updated_at
}, {coreGeneratedAt: '2026-08-31T18:36:01+08:00'});
assert.equal(postCutoffCancellationFreshness.coversCostAssignments, true);
assert.equal(postCutoffCancellationFreshness.usableSnapshot, true);
assert.equal(postCutoffCancellationFreshness.followUpPending, true);
assert.equal(postCutoffCancellationFreshness.coversCostCutoff, false, 'post-cutoff cancellation must not be falsely treated as covered');

console.log('bi_profit_mart_freshness: inserts, cancellations, returns, cost cutoff, and assignment coverage guards passed');
