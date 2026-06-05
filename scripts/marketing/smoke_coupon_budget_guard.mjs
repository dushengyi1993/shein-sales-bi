#!/usr/bin/env node
import assert from 'node:assert/strict';
import {summarizeCouponBudgetStatus} from '../../lib/marketing_coupon_budget_guard.mjs';

const storesConfigDoc = {
  stores: [
    {storeKey: 'A', enabled: true},
    {storeKey: 'B', enabled: true},
    {storeKey: 'C', enabled: true},
    {storeKey: 'D', enabled: true},
  ],
};

const okSource = {exists: true, status: 'ok', path: 'fixture-execute.json'};
const staleSource = {exists: true, status: 'stale', path: 'fixture-execute-stale.json'};
const dryRunSource = {exists: true, status: 'ok', path: 'fixture-dry-run.json'};

const executeDoc = {
  createdAt: '2026-06-06T00:00:00.000Z',
  activityId: 34810,
  site: 'shein-sa',
  currency: 'SAR',
  budget: 1000,
  execute: true,
  stores: [
    {
      storeKey: 'A',
      requestedBudget: 1000,
      ok: false,
      write: {
        activityLimit: {code: '0', msg: 'OK'},
        siteBudget: {code: '1017', msg: '规则不存在或者已经失效无法更新'},
      },
      before: {usageSite: {coupon_usage_upper_limit: 1000, coupon_used_amount: 0}},
      after: {usageSite: {coupon_usage_upper_limit: 1000, coupon_used_amount: 0}},
      reason: 'verification failed: writeOk=false budgetInfoOk=true usageOk=true',
    },
    {
      storeKey: 'B',
      requestedBudget: 1000,
      ok: true,
      before: {usageSite: {coupon_usage_upper_limit: 1000}},
      after: {usageSite: {coupon_usage_upper_limit: 900}},
    },
    {
      storeKey: 'C',
      requestedBudget: 1000,
      ok: true,
      before: {budgetInfoSite: {coupon_usage_upper_limit: 1000}},
      after: {},
    },
    {
      storeKey: 'D',
      requestedBudget: 1000,
      ok: true,
      before: {},
      after: {},
    },
  ],
  failures: [{storeKey: 'A', reason: 'write failed but readback ok'}],
};

const dryRunDoc = {
  createdAt: '2026-06-06T00:01:00.000Z',
  activityId: 34810,
  site: 'shein-sa',
  currency: 'SAR',
  budget: 1000,
  execute: false,
  stores: [
    {storeKey: 'A', before: {usageSite: {coupon_usage_upper_limit: 1000}}},
    {storeKey: 'B', before: {usageSite: {coupon_usage_upper_limit: 1000}}},
    {storeKey: 'C', before: {usageSite: {coupon_usage_upper_limit: 1000}}},
    {storeKey: 'D', before: {usageSite: {coupon_usage_upper_limit: 1000}}},
  ],
};

const summary = summarizeCouponBudgetStatus({
  executeDoc,
  executeSource: okSource,
  dryRunDoc,
  dryRunSource,
  storesConfigDoc,
  targetBudget: 1000,
});

assert.equal(summary.status, 'blocked');
assert.equal(summary.writeFailureButAtTargetCount, 1);
assert.deepEqual(summary.writeFailureButAtTargetStores.map(s => s.storeKey), ['A']);
assert.equal(summary.belowTargetCount, 1);
assert.deepEqual(summary.belowTargetStores.map(s => s.storeKey), ['B']);
assert.equal(summary.rows.find(r => r.storeKey === 'B').evidenceSource, 'after.usageSite.coupon_usage_upper_limit');
assert.equal(summary.missingEvidenceCount, 1);
assert.deepEqual(summary.missingEvidenceStores.map(s => s.storeKey), ['D']);
assert.equal(summary.rows.find(r => r.storeKey === 'C').status, 'at_target');
assert.equal(summary.rows.find(r => r.storeKey === 'C').evidenceSource, 'before.budgetInfoSite.coupon_usage_upper_limit');

const staleExecuteSummary = summarizeCouponBudgetStatus({
  executeDoc,
  executeSource: staleSource,
  dryRunDoc,
  dryRunSource,
  storesConfigDoc,
  targetBudget: 1000,
});
assert.equal(staleExecuteSummary.selectedSource, 'execute_stale_not_accepted');
assert.equal(staleExecuteSummary.verifiedAtTargetCount, 0);
assert.equal(staleExecuteSummary.missingEvidenceCount, 4);
assert.equal(staleExecuteSummary.missingEvidenceStores.every(s => s.hasDryRunObservation), true);

const dryRunOnlySummary = summarizeCouponBudgetStatus({
  executeDoc: null,
  executeSource: {exists: false, status: 'missing', path: ''},
  dryRunDoc,
  dryRunSource,
  storesConfigDoc,
  targetBudget: 1000,
});
assert.equal(dryRunOnlySummary.selectedSource, 'dry_run_only_not_completion_evidence');
assert.equal(dryRunOnlySummary.verifiedAtTargetCount, 0);
assert.equal(dryRunOnlySummary.missingEvidenceCount, 4);

console.log(JSON.stringify({
  ok: true,
  cases: [
    'write_failed_but_at_target',
    'after_overrides_before',
    'before_fallback',
    'missing_evidence',
    'stale_execute_not_accepted',
    'dry_run_only_not_completion_evidence',
  ],
}, null, 2));
