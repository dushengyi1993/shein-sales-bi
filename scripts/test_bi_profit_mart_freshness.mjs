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

console.log('bi_profit_mart_freshness: pipeline ordering, cost cutoff, and assignment coverage guards passed');
