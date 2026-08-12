#!/usr/bin/env node

import assert from 'node:assert/strict';
import {overlayCurrentProductReconciliationAudit} from '../lib/bi_live_core_health.mjs';
import {usableHomepageAccountingFallback} from './serve_bi_portal.mjs';

const generatedAt = '2026-08-12T08:25:44.1563+08:00';

assert.equal(usableHomepageAccountingFallback('homeRankings', {
  generatedAt,
  data: {rankings: {sales: []}},
}, generatedAt), true);
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  generatedAt,
  data: {homeProfitSummary: {sourceGeneratedAt: generatedAt, staleSource: false, dailyScopes: []}},
}, generatedAt), true);
assert.equal(usableHomepageAccountingFallback('homeProfit', {
  generatedAt,
  data: {homeProfitSummary: {sourceGeneratedAt: 'old', staleSource: false, dailyScopes: []}},
}, generatedAt), false);

const core = {
  audit: {
    ok: true,
    warnings: 4,
    warningMessages: [
      'DL 店商品对账需处理：OpenAPI 库存缺失 50 条',
      'TS 店商品对账需处理：OpenAPI 库存缺失 50 条',
      '其他提醒必须保留',
      'YJ 店商品对账需处理：OpenAPI 库存缺失 30 条',
    ],
  },
};
const completeEvidence = {
  fresh: true,
  summary: {
    ok: true,
    generatedAt: '2026-08-12T05:12:32.000Z',
    reportScope: {complete: true},
    counts: {total: 3, succeeded: 3, failed: 0},
    results: ['DL', 'TS', 'YJ'].map(storeKey => ({
      storeKey,
      ok: true,
      status: 'matched',
      semanticReconciliation: {status: 'matched', counts: {stockMissing: 0}, warnings: []},
    })),
  },
};
completeEvidence.summary.reportScope.expectedStores = ['DL', 'TS', 'YJ'];
const nowMs = Date.parse('2026-08-12T06:00:00.000Z');
const overlaid = overlayCurrentProductReconciliationAudit(core, completeEvidence, {nowMs});
assert.deepEqual(overlaid.audit.warningMessages, ['其他提醒必须保留']);
assert.equal(overlaid.audit.warnings, 1);
assert.equal(overlaid.audit.liveProductReconciliationApplied, true);
assert.equal(core.audit.warnings, 4, 'overlay must not mutate the generated core');

const counted = overlayCurrentProductReconciliationAudit({
  audit: {...core.audit, warnings: 5},
}, completeEvidence, {nowMs});
assert.equal(counted.audit.warnings, 2, 'anonymous audit warning counts must survive the live overlay');

const incomplete = overlayCurrentProductReconciliationAudit(core, {
  ...completeEvidence,
  summary: {...completeEvidence.summary, reportScope: {complete: false}},
}, {nowMs});
assert.equal(incomplete, core, 'incomplete evidence must leave old warnings fail-closed');

const currentWarning = structuredClone(completeEvidence);
currentWarning.summary.results[1] = {
  storeKey: 'TS',
  ok: true,
  status: 'warning',
  semanticReconciliation: {status: 'warning', counts: {stockMissing: 2}, warnings: ['OpenAPI 库存缺失 2 条']},
};
const warned = overlayCurrentProductReconciliationAudit(core, currentWarning, {nowMs});
assert.deepEqual(warned.audit.warningMessages, ['TS 店商品对账需处理：OpenAPI 库存缺失 2 条', '其他提醒必须保留']);

const stale = overlayCurrentProductReconciliationAudit(core, completeEvidence, {
  nowMs: Date.parse('2026-08-13T06:00:00.000Z'),
});
assert.equal(stale, core, 'old reconciliation evidence must never clear newer portal warnings');

const duplicateStore = structuredClone(completeEvidence);
duplicateStore.summary.results[2] = structuredClone(duplicateStore.summary.results[0]);
const duplicateResult = overlayCurrentProductReconciliationAudit(core, duplicateStore, {nowMs});
assert.equal(duplicateResult, core, 'duplicate stores must not satisfy complete report coverage');

console.log(JSON.stringify({ok: true, tests: 11}));
