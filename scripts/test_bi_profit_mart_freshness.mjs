#!/usr/bin/env node
import assert from 'node:assert/strict';
import {evaluateProfitMartCacheFreshness} from '../lib/bi_profit_mart_freshness.mjs';

const pipelineOrdered = evaluateProfitMartCacheFreshness({
  factOrderMax: '2026-07-23',
  factUpdatedAt: '2026-07-23T18:02:00+08:00',
  profitCacheMax: '2026-07-23',
  profitCacheRows: 10_303,
  metaRefreshedAt: '2026-07-23T18:02:10+08:00',
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
}, {
  coreGeneratedAt: '2026-07-23T18:02:49+08:00',
});
assert.equal(sameDayWebhookWrite.fresh, false, 'a same-day webhook insert must invalidate the profit mart even when max dates match');
assert.equal(sameDayWebhookWrite.coversFactChanges, false);

console.log('bi_profit_mart_freshness: pipeline ordering tolerance and stale guards passed');
